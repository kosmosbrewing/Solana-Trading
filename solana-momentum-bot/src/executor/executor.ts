import axios, { AxiosError, AxiosInstance } from 'axios';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  type LoadedAddresses,
  type MessageAccountKeys,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createModuleLogger } from '../utils/logger';
import { Order } from '../utils/types';
import { SOL_MINT } from '../utils/constants';
import { JitoClient } from './jitoClient';
import { normalizeJupiterSwapApiUrl } from '../utils/jupiterApi';
import { BPS_DENOMINATOR_BIGINT, decimalToBps } from '../utils/units';
import { recordJupiter429 } from '../observability/jupiterRateLimitMetric';

/**
 * 2026-04-28 (Sprint B1): Jupiter 429 retry 강화.
 * 운영 incident — kolh-live-GwR3ruFz 가 9 attempts × 3 retries = 27회 fail 후 17분 close 지연,
 * mae −63% → −66.8% 손실 확대. 일반 backoff (1/2/4s) 가 Jupiter rate-limit reset window 보다 짧음.
 *
 * 2026-04-28 (P0-D fix, ralph-loop): backoff 단축 — 17분 close 지연 incident 의 추가 완화.
 *   - 이전: [5s, 15s, 45s, 60s, 60s] = 185s worst case
 *   - 현재: [2s, 5s, 15s, 30s, 60s] = **112s worst case (39% 감소)**
 *   - 첫 2회 (2s+5s=7s) 는 transient 429 빠른 회복, 60s tail 은 여전히 rate-limit reset 준수.
 *   - close path latency 단축 → MAE 확대 방어 (sentinel/hardcut 의 보수성 fix 와 정합).
 *
 * 정책:
 *   - 429 명시 detect (axios response.status === 429)
 *   - 별도 429-specific backoff (사이즈 위 참조)
 *   - 별도 maxRetries (default 5, env override JUPITER_429_MAX_RETRIES)
 *   - recordJupiter429('executor_swap_v6') 호출 — 운영 모니터링 hook
 */
/** Sprint B1 회귀 검증용 export. */
export function is429Error(error: unknown): boolean {
  if (error instanceof AxiosError) {
    return error.response?.status === 429;
  }
  // Jupiter rate-limit message 도 fallback detect (axios 가 wrap 안 한 경우)
  const msg = (error as Error)?.message ?? '';
  return /\b429\b/.test(msg) || /rate.?limit/i.test(msg);
}
const JUPITER_429_BACKOFFS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
const JUPITER_429_MAX_RETRIES = Number(process.env.JUPITER_429_MAX_RETRIES ?? '5');

const log = createModuleLogger('Executor');

export interface ExecutorConfig {
  solanaRpcUrl: string;
  walletPrivateKey: string;  // Base58 encoded — 이 모듈에서만 접근
  jupiterApiUrl: string;
  maxSlippage: number;       // 0.01 = 1%
  maxRetries: number;
  txTimeoutMs: number;
  /** Phase 3: Use Jito bundles for MEV protection */
  useJitoBundles?: boolean;
  /** Phase 3: Jito block engine URL */
  jitoRpcUrl?: string;
  /** Phase 3: Jito tip amount in SOL */
  jitoTipSol?: number;
  /** v3: Jupiter Ultra V3 활성화 */
  useJupiterUltra?: boolean;
  /** v3: Jupiter Ultra API base URL */
  jupiterUltraApiUrl?: string;
  /** v3: Jupiter API key (Ultra 필수) */
  jupiterApiKey?: string;
}

export interface SwapResult {
  expectedInAmount?: bigint;   // Jupiter quote 예상 입력량
  actualInputAmount?: bigint;  // 온체인 실제 입력량 (확인 가능 시)
  actualInputUiAmount?: number;// 실제 입력량 (UI amount)
  inputDecimals?: number;      // input mint decimals
  txSignature: string;
  expectedOutAmount: bigint;   // Jupiter quote 예상 수신량
  actualOutAmount?: bigint;    // 온체인 실제 수신량 (확인 가능 시)
  actualOutUiAmount?: number;  // 실제 수신량 (UI amount)
  outputDecimals?: number;     // output mint decimals
  /**
   * 실제 슬리피지 (bps). 부호 convention:
   * - **positive** (`actualOut < expectedOut`): 불리한 fill — 유저가 quote 대비 적게 받음
   * - **zero**: actualOut == expectedOut
   * - **negative** (`actualOut > expectedOut`): 유리한 fill — 유저가 quote 대비 많이 받음
   *   Jupiter quote safety margin 으로 인해 드물게 발생. bug 아님.
   *
   * 2026-04-08 P0-M4 확인: VPS trade-report 의 `-55bps / -68bps` 케이스는
   * 정상 favorable fill 이다. slippage 계산이 Jupiter 의 "quote → actual fill" gap 만
   * 측정하기 때문에 monitor trigger 시점과 quote submit 시점 사이의 price movement 는
   * 별도 telemetry (Phase E1 `monitor_trigger_price` vs `pre_submit_tick_price`) 로 측정한다.
   */
  slippageBps: number;
  /**
   * 2026-04-30 (Sprint 1.A3): tx submit → confirm 까지 latency (ms).
   * Why: KOL Hunter 의 D-bucket 분석 (mae<-30%) 에서 sell tx confirm 지연 (~60s) 이
   *      mae 부풀림의 24% 를 차지. landing latency 측정으로 root cause 정량 평가.
   * 측정: sendTransaction 의 sendTransaction → confirmTransaction (또는 Jito bundle
   *      submit → waitForConfirmation) 구간. 비측정 (예: 실패 전 throw) 시 undefined.
   */
  landingLatencyMs?: number;

  // ─── 2026-05-01 (Sprint X measurement-only): Cost decomposition ───
  // Why: actualInputUiAmount = wallet SOL delta = swap input + ATA rent + network fee + Jito tip.
  //   ATA rent (~0.002 SOL/신규 토큰) 가 entry price 에 inflated 되어 5x peak 측정에서
  //   "진짜 5x" 를 5x 로 못 잡는 문제 (ticket 0.02 SOL 기준 ~10-20% inflation).
  // 분해: swap-only input (Jupiter quote 의 raw inAmount) 별도 측정 → token-only entry price 산출.
  //   ATA rent / network fee / Jito tip 도 cost decomposition log 로 분리.
  // 거래 행동 변경 0 — measurement-only. ATA close on full sell 은 별도 sprint.
  /** Jupiter swap quote 의 raw input (ATA rent / network fee / Jito tip 제외). UI amount. */
  swapInputUiAmount?: number;
  /** wallet pre/post SOL delta (= swap + rent + fee + tip 모두 합산). 기존 actualInputUiAmount 와 동일 의미. */
  walletInputUiAmount?: number;
  /** 신규 토큰 ATA 생성 시 funded SOL (보통 0.00203928). 재진입은 0. */
  ataRentSol?: number;
  /** Solana network fee (보통 0.000005 ~ 0.000105 SOL). */
  networkFeeSol?: number;
  /** Jito tip (path=jito 일 때만, dynamic). */
  jitoTipSol?: number;
}

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: unknown[];
}

/** v3: Ultra V3 order 응답 */
interface UltraOrderResponse {
  transaction: string; // base64 serialized transaction
  requestId: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  slippageBps?: number;
}

/** v3: Ultra V3 execute 응답 */
interface UltraExecuteResponse {
  signature: string;
  status: string;
  slot?: number;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

// ─── 2026-05-01 (Sprint X measurement-only): ATA rent decomposition ───
// SOL input swap 의 wallet delta = swap input + ATA rent (신규 토큰) + network fee + Jito tip.
// inner instructions 의 SystemProgram.transfer 또는 createAccount 로 funded 신규 계정 합계 추출.
// signer 가 SOL 을 보낸 신규 token account = ATA rent.
interface SwapCostDecomp {
  swapInputSol: number;     // 실 token swap 에 들어간 SOL (UI amount)
  ataRentSol: number;       // 신규 ATA 생성 funding (보통 0.00203928, 재진입 0)
  networkFeeSol: number;    // Solana 네트워크 fee
  jitoTipSol: number;       // Jito tip (path=jito 일 때만, 추정값)
  walletInputSol: number;   // wallet pre-post delta total
}

type MessageWithAccountKeys = {
  getAccountKeys: (args?: { accountKeysFromLookups?: LoadedAddresses | null }) => MessageAccountKeys;
};

export function resolveAccountKeysForCostDecomp(
  message: MessageWithAccountKeys,
  loadedAddresses?: LoadedAddresses,
): MessageAccountKeys {
  if (loadedAddresses) {
    return message.getAccountKeys({ accountKeysFromLookups: loadedAddresses });
  }
  return message.getAccountKeys();
}

/**
 * 2026-05-01 (Codex H2 fix): hot-path RPC await 차단.
 *   기존: `await connection.getTransaction(signature, ...)` 가 timeout 없어 RPC 지연 시
 *         buy 체결 후 position persist 전에 hot path 가 무한 대기.
 *   현재: 1500ms timeout race + RPC 실패/timeout 시 fallback (walletInputSol 그대로 사용).
 *         decomposition 은 측정용이라 missing 해도 wallet truth 영향 0.
 */
const DECOMPOSE_RPC_TIMEOUT_MS = 1500;

export async function decomposeSwapCost(
  connection: Connection,
  signature: string,
  walletInputSol: number,
  declaredJitoTipSol: number = 0
): Promise<SwapCostDecomp> {
  // 안전 default — RPC 실패 / timeout 시 기존 wallet delta 그대로 (분해 정보 없음)
  const fallback: SwapCostDecomp = {
    swapInputSol: walletInputSol,
    ataRentSol: 0,
    networkFeeSol: 0,
    jitoTipSol: declaredJitoTipSol,
    walletInputSol,
  };
  try {
    // Codex H2 fix: timeout race — hot path 영향 보호.
    const txPromise = connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    const tx = await Promise.race([
      txPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DECOMPOSE_RPC_TIMEOUT_MS)),
    ]);
    if (!tx?.meta) return fallback;

    const fee = tx.meta.fee / 1e9;
    const accountKeys = resolveAccountKeysForCostDecomp(
      tx.transaction.message as MessageWithAccountKeys,
      tx.meta.loadedAddresses,
    );
    const signerKey = accountKeys.get(0);
    if (!signerKey) return fallback;
    const signerStr = signerKey.toBase58();

    // 신규 funded account: pre=0, post>0, signer 가 아닌 account
    // 2026-05-01 (F2 sanity): ATA rent 표준 0.00203928 SOL. 한 tx 의 newly-funded 합계가
    //   0.05 SOL 초과면 ATA 외 다른 funded account (escrow, treasury 등) 포함 의심.
    //   conservative — sanity 초과 시 분해 신뢰도 낮음, fallback 사용 (분해 0).
    const preBal = tx.meta.preBalances;
    const postBal = tx.meta.postBalances;
    let newlyFundedSol = 0;
    for (let i = 0; i < accountKeys.length; i++) {
      const key = accountKeys.get(i);
      if (!key) continue;
      if (key.toBase58() === signerStr) continue;
      if (preBal[i] === 0 && postBal[i] > 0) {
        newlyFundedSol += postBal[i] / 1e9;
      }
    }
    // F2 sanity: ATA rent 표준 0.00203928 SOL (per ATA), multi-token entry 도 0.05 SOL 미만이 정상.
    // 0.05 초과 = escrow / treasury 포함 의심 → fallback (분해 신뢰도 낮음, 0 처리).
    const ATA_RENT_SANITY_CAP_SOL = 0.05;
    const ataSane = newlyFundedSol <= ATA_RENT_SANITY_CAP_SOL ? newlyFundedSol : 0;
    const swapInput = walletInputSol - fee - ataSane - declaredJitoTipSol;
    return {
      swapInputSol: swapInput > 0 ? swapInput : walletInputSol,
      ataRentSol: ataSane,
      networkFeeSol: fee,
      jitoTipSol: declaredJitoTipSol,
      walletInputSol,
    };
  } catch {
    return fallback;
  }
}

export class Executor {
  private connection: Connection;
  private wallet: Keypair;
  private jupiterClient: AxiosInstance;
  private ultraClient?: AxiosInstance;
  private mintDecimals = new Map<string, number>();
  private maxSlippageBps: number;
  private maxRetries: number;
  private jitoClient?: JitoClient;
  private useJito: boolean;
  private useUltra: boolean;

  constructor(executorConfig: ExecutorConfig) {
    this.connection = new Connection(executorConfig.solanaRpcUrl, 'confirmed');
    this.wallet = Keypair.fromSecretKey(bs58.decode(executorConfig.walletPrivateKey));
    const normalizedJupiterApiUrl = normalizeJupiterSwapApiUrl(
      executorConfig.jupiterApiUrl,
      executorConfig.jupiterApiKey
    );
    const jupiterHeaders = executorConfig.jupiterApiKey
      ? { 'x-api-key': executorConfig.jupiterApiKey }
      : undefined;
    this.jupiterClient = axios.create({
      baseURL: normalizedJupiterApiUrl,
      timeout: 15000,
      headers: jupiterHeaders,
    });
    this.maxSlippageBps = decimalToBps(executorConfig.maxSlippage);
    this.maxRetries = executorConfig.maxRetries;
    this.useJito = executorConfig.useJitoBundles ?? false;

    // v3: Ultra V3 — API key 필수, 없으면 graceful disable
    this.useUltra = (executorConfig.useJupiterUltra ?? false) && !!executorConfig.jupiterApiKey;
    if (executorConfig.useJupiterUltra && !executorConfig.jupiterApiKey) {
      log.warn('Jupiter Ultra enabled but no API key — falling back to v6');
    }
    if (this.useUltra) {
      this.ultraClient = axios.create({
        baseURL: executorConfig.jupiterUltraApiUrl || 'https://api.jup.ag',
        timeout: 15000,
        headers: {
          'x-api-key': executorConfig.jupiterApiKey!,
        },
      });
      log.info('Jupiter Ultra V3 integration enabled');
    }

    if (this.useJito && executorConfig.jitoRpcUrl) {
      this.jitoClient = new JitoClient({
        jitoRpcUrl: executorConfig.jitoRpcUrl,
        tipSol: executorConfig.jitoTipSol ?? 0.001,
        solanaRpcUrl: executorConfig.solanaRpcUrl,
        enableDontFront: true,
      });
      log.info('Jito bundle integration enabled');
    }

    log.info(`Executor initialized. Wallet: ${this.wallet.publicKey.toBase58().slice(0, 6)}...`);
  }

  /**
   * Jupiter Swap 실행 — 실제 수신량 포함 결과 반환
   */
  async executeSwap(
    inputMint: string,
    outputMint: string,
    amountLamports: bigint
  ): Promise<SwapResult> {
    return this.executeSwapWithRetry(inputMint, outputMint, amountLamports);
  }

  /**
   * retry 시마다 quote를 재발급받아 stale quote 문제 방지
   * v3: Ultra 활성화 시 Ultra 우선 시도 → 실패 시 v6 fallback
   */
  private async executeSwapWithRetry(
    inputMint: string,
    outputMint: string,
    amountLamports: bigint
  ): Promise<SwapResult> {
    // v3: Ultra V3 경로 우선 시도
    if (this.useUltra && this.ultraClient) {
      try {
        return await this.executeSwapUltra(inputMint, outputMint, amountLamports);
      } catch (ultraError) {
        // 2026-04-28 (Sprint B1 QA Q4): Ultra path 의 429 도 recordJupiter429 호출 (관측 누락 보정).
        // v6 fallback 자체가 retry mitigation 역할 — 단 source 별 카운터에는 ultra 도 잡혀야 함.
        if (is429Error(ultraError)) {
          recordJupiter429('executor_swap_ultra');
        }
        log.warn(`Ultra V3 swap failed: ${ultraError}. Falling back to v6.`);
      }
    }

    return this.executeSwapV6(inputMint, outputMint, amountLamports);
  }

  /**
   * v3: Jupiter Ultra V3 swap — GET /ultra/v1/order → sign → POST /ultra/v1/execute
   */
  private async executeSwapUltra(
    inputMint: string,
    outputMint: string,
    amountLamports: bigint
  ): Promise<SwapResult> {
    if (!this.ultraClient) throw new Error('Ultra client not initialized');

    const inputBalanceBefore = await this.getAssetBalanceRaw(inputMint);
    const outputBalanceBefore = await this.getAssetBalanceRaw(outputMint);

    // Step 1: GET /ultra/v1/order
    const orderResponse = await this.ultraClient.get<UltraOrderResponse>('/ultra/v1/order', {
      params: {
        inputMint,
        outputMint,
        amount: amountLamports.toString(),
        taker: this.wallet.publicKey.toBase58(),
      },
    });

    const order = orderResponse.data;
    const expectedIn = BigInt(order.inAmount);
    const expectedOut = BigInt(order.outAmount);

    log.info(
      `Ultra order: ${order.inAmount} → ${order.outAmount} ` +
      `(slippage: ${order.slippageBps ?? 'auto'}bps, requestId: ${order.requestId})`
    );

    // Step 2: Sign the transaction
    const txBuffer = Buffer.from(order.transaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuffer);
    tx.sign([this.wallet]);
    const signedTxBase64 = Buffer.from(tx.serialize()).toString('base64');

    // Step 3: POST /ultra/v1/execute
    // 2026-04-30 (Sprint 1.A3): Ultra path 도 submit→confirm latency 측정.
    const ultraStartMs = Date.now();
    const executeResponse = await this.ultraClient.post<UltraExecuteResponse>('/ultra/v1/execute', {
      signedTransaction: signedTxBase64,
      requestId: order.requestId,
    });

    const result = executeResponse.data;

    if (result.status !== 'Success') {
      throw new Error(`Ultra execute failed: status=${result.status}`);
    }

    const confirmation = await this.connection.confirmTransaction(result.signature, 'confirmed');
    const ultraLandingLatencyMs = Date.now() - ultraStartMs;
    if (confirmation.value.err) {
      throw new Error(`Ultra tx failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }

    // Why: Ultra outputAmountResult/inputAmountResult는 route/path별로 wallet delta와 어긋날 수 있다.
    // entry alignment는 ledger 안전성이 더 중요하므로, live buy/sell 실측은 wallet balance delta를
    // 우선 사용하고 Ultra API 값은 balance 측정 실패/0일 때만 fallback한다.
    const inputBalanceAfter = await this.getAssetBalanceRaw(inputMint);
    const outputBalanceAfter = await this.getAssetBalanceRaw(outputMint);
    const balanceInputAmount = inputBalanceBefore > inputBalanceAfter
      ? inputBalanceBefore - inputBalanceAfter
      : 0n;
    const balanceOutputAmount = outputBalanceAfter > outputBalanceBefore
      ? outputBalanceAfter - outputBalanceBefore
      : 0n;

    const apiInputAmount = result.inputAmountResult ? BigInt(result.inputAmountResult) : undefined;
    const apiOutputAmount = result.outputAmountResult ? BigInt(result.outputAmountResult) : undefined;
    const actualInputAmount = balanceInputAmount > 0n ? balanceInputAmount : apiInputAmount;
    const actualOutAmount = balanceOutputAmount > 0n ? balanceOutputAmount : apiOutputAmount;
    const actualSlippageBps = actualOutAmount != null && expectedOut > 0n
      ? Number((expectedOut - actualOutAmount) * BPS_DENOMINATOR_BIGINT / expectedOut)
      : 0;

    if (apiOutputAmount != null && balanceOutputAmount > 0n && apiOutputAmount !== balanceOutputAmount) {
      log.warn(
        `[ULTRA_OUTPUT_MISMATCH] ${outputMint}: api=${apiOutputAmount.toString()} ` +
        `walletDelta=${balanceOutputAmount.toString()} sig=${result.signature}`
      );
    }
    if (apiInputAmount != null && balanceInputAmount > 0n && apiInputAmount !== balanceInputAmount) {
      log.warn(
        `[ULTRA_INPUT_MISMATCH] ${inputMint}: api=${apiInputAmount.toString()} ` +
        `walletDelta=${balanceInputAmount.toString()} sig=${result.signature}`
      );
    }

    const inputMetrics = await this.resolveInputMetrics(inputMint, actualInputAmount);
    const outputMetrics = await this.resolveOutputMetrics(outputMint, actualOutAmount);

    log.info(
      `Ultra swap complete: sig=${result.signature}, expected=${expectedOut}, ` +
      `actual=${actualOutAmount ?? 'unknown'}, slippage=${actualSlippageBps}bps`
    );

    // 2026-05-01 (Sprint X): SOL input 시점만 ATA rent decomposition.
    let ultraCostDecomp: SwapCostDecomp | undefined;
    if (inputMint === SOL_MINT && inputMetrics.actualInputUiAmount != null) {
      ultraCostDecomp = await decomposeSwapCost(
        this.connection,
        result.signature,
        inputMetrics.actualInputUiAmount,
        0  // Ultra 의 priority/jito tip 은 inner instruction 의 newly-funded 가 아닌 fee 로 흡수됨
      );
      log.info(
        `[SWAP_COST_DECOMP_ULTRA] sig=${result.signature.slice(0, 12)} ` +
        `wallet=${ultraCostDecomp.walletInputSol.toFixed(6)} swap=${ultraCostDecomp.swapInputSol.toFixed(6)} ` +
        `rent=${ultraCostDecomp.ataRentSol.toFixed(6)} fee=${ultraCostDecomp.networkFeeSol.toFixed(6)}`
      );
    }

    return {
      expectedInAmount: expectedIn,
      actualInputAmount,
      txSignature: result.signature,
      expectedOutAmount: expectedOut,
      actualOutAmount,
      ...inputMetrics,
      ...outputMetrics,
      slippageBps: actualSlippageBps,
      // 2026-04-30 (Sprint 1.A3): Ultra path landing latency.
      landingLatencyMs: ultraLandingLatencyMs,
      // 2026-05-01 (Sprint X): cost decomposition.
      swapInputUiAmount: ultraCostDecomp?.swapInputSol,
      walletInputUiAmount: ultraCostDecomp?.walletInputSol,
      ataRentSol: ultraCostDecomp?.ataRentSol,
      networkFeeSol: ultraCostDecomp?.networkFeeSol,
      jitoTipSol: ultraCostDecomp?.jitoTipSol,
    };
  }

  /**
   * v6 swap 경로 — 기존 로직 그대로
   */
  private async executeSwapV6(
    inputMint: string,
    outputMint: string,
    amountLamports: bigint
  ): Promise<SwapResult> {
    let lastError: Error | undefined;
    // 2026-04-28 (Sprint B1): 429 retry 는 일반 maxRetries 와 별도 카운터.
    // 일반 retry maxRetries=3 (default). 429 는 longer backoff + 추가 retry 5회 (default).
    let retry429Count = 0;
    const max429Retries = JUPITER_429_MAX_RETRIES;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const quote = await this.getQuote(inputMint, outputMint, amountLamports);
        log.info(
          `Quote (attempt ${attempt}): ${quote.inAmount} → ${quote.outAmount} (slippage: ${quote.slippageBps}bps)`
        );

        const expectedIn = BigInt(quote.inAmount);
        const expectedOut = BigInt(quote.outAmount);

        const inputBalanceBefore = inputMint === SOL_MINT
          ? BigInt(Math.round(await this.getBalance() * 1e9))
          : await this.getTokenBalance(inputMint);
        const balanceBefore = outputMint === SOL_MINT
          ? BigInt(Math.round(await this.getBalance() * 1e9))
          : await this.getTokenBalance(outputMint);

        const swapTx = await this.getSwapTransaction(quote);
        const sendResult = await this.sendTransaction(swapTx);
        const txSignature = sendResult.signature;
        const landingLatencyMs = sendResult.landingLatencyMs;
        // 2026-05-01 (Codex H2 fix): Jito 실제 성공 시에만 tip 차감.
        //   fallback (Jito → standard RPC) 시 tipPaidSol = 0 → token-only entry price 정확.
        const jitoTipPaidSol = sendResult.viaJito ? sendResult.jitoTipPaidSol : 0;

        const inputBalanceAfter = inputMint === SOL_MINT
          ? BigInt(Math.round(await this.getBalance() * 1e9))
          : await this.getTokenBalance(inputMint);
        const balanceAfter = outputMint === SOL_MINT
          ? BigInt(Math.round(await this.getBalance() * 1e9))
          : await this.getTokenBalance(outputMint);

        const actualInputAmount = inputBalanceBefore > inputBalanceAfter
          ? inputBalanceBefore - inputBalanceAfter
          : 0n;
        const actualOutAmount = balanceAfter - balanceBefore;
        const actualSlippageBps = expectedOut > 0n
          ? Number((expectedOut - actualOutAmount) * BPS_DENOMINATOR_BIGINT / expectedOut)
          : 0;
        const inputMetrics = await this.resolveInputMetrics(
          inputMint,
          actualInputAmount > 0n ? actualInputAmount : undefined
        );
        const outputMetrics = await this.resolveOutputMetrics(
          outputMint,
          actualOutAmount > 0n ? actualOutAmount : undefined
        );

        log.info(
          `Swap complete: expected=${expectedOut}, actual=${actualOutAmount}, slippage=${actualSlippageBps}bps`
        );

        // 2026-05-01 (Sprint X): SOL input 시점만 ATA rent decomposition. token→SOL (sell) 은 분해 무관.
        // 2026-05-01 (H2 fix — Codex 권고 + 추가 fix): V6 path 도 Jito 활성 가능 (line 754 useJito 분기).
        //   Jito tip 은 별도 tx 로 wallet delta 에 들어가지만 swap signature 의 inner instruction 에 안 잡힘.
        //   → sendResult.jitoTipPaidSol (실 Jito 성공 시에만 > 0) 을 declaredJitoTipSol 로 전달
        //     → swapInputSol 에서 차감되어 token-only entry price 정확.
        let costDecomp: SwapCostDecomp | undefined;
        if (inputMint === SOL_MINT && inputMetrics.actualInputUiAmount != null) {
          // Codex H2 fix: jitoTipPaidSol 은 sendTransaction 결과 — 실 Jito 성공 시에만 > 0.
          //   fallback (standard RPC) 시 0 → swapInputSol 에서 tip 안 빠짐 → token-only 정확.
          costDecomp = await decomposeSwapCost(
            this.connection,
            txSignature,
            inputMetrics.actualInputUiAmount,
            jitoTipPaidSol
          );
          log.info(
            `[SWAP_COST_DECOMP_V6] sig=${txSignature.slice(0, 12)} ` +
            `wallet=${costDecomp.walletInputSol.toFixed(6)} swap=${costDecomp.swapInputSol.toFixed(6)} ` +
            `rent=${costDecomp.ataRentSol.toFixed(6)} fee=${costDecomp.networkFeeSol.toFixed(6)} ` +
            `jitoTip=${costDecomp.jitoTipSol.toFixed(6)}`
          );
        }

        return {
          expectedInAmount: expectedIn,
          actualInputAmount: actualInputAmount > 0n ? actualInputAmount : undefined,
          txSignature,
          expectedOutAmount: expectedOut,
          actualOutAmount: actualOutAmount > 0n ? actualOutAmount : undefined,
          ...inputMetrics,
          ...outputMetrics,
          slippageBps: actualSlippageBps,
          // 2026-04-30 (Sprint 1.A3): tx submit→confirm latency 전파.
          landingLatencyMs,
          // 2026-05-01 (Sprint X): cost decomposition.
          swapInputUiAmount: costDecomp?.swapInputSol,
          walletInputUiAmount: costDecomp?.walletInputSol,
          ataRentSol: costDecomp?.ataRentSol,
          networkFeeSol: costDecomp?.networkFeeSol,
          jitoTipSol: costDecomp?.jitoTipSol,
        };
      } catch (error) {
        lastError = error as Error;
        // 2026-04-28 (Sprint B1): 429 분기 — longer backoff + 별도 retry counter.
        // 일반 attempt counter 는 증가 안 시킴 (429 는 quote endpoint rate-limit 이라
        // attempt 다 소진하면 진짜 swap 시도 기회를 잃음 → 429 는 별도 counter).
        if (is429Error(error)) {
          recordJupiter429('executor_swap_v6');
          if (retry429Count < max429Retries) {
            const backoffMs = JUPITER_429_BACKOFFS_MS[retry429Count]
              ?? JUPITER_429_BACKOFFS_MS[JUPITER_429_BACKOFFS_MS.length - 1];
            log.warn(
              `[JUPITER_429] swap attempt ${attempt} hit rate-limit, ` +
              `429-retry ${retry429Count + 1}/${max429Retries} in ${backoffMs}ms`
            );
            retry429Count++;
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            attempt--;  // 일반 attempt counter 회복 (429 는 별도)
            continue;
          }
          log.error(
            `[JUPITER_429] exhausted ${max429Retries} 429-retries — propagating swap failure. ` +
            `Last error: ${lastError.message}`
          );
        }
        log.warn(`Swap attempt ${attempt}/${this.maxRetries} failed: ${lastError.message}`);

        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Swap failed after ${this.maxRetries} attempts: ${lastError?.message}`);
  }

  /**
   * 주문 기반 매수 실행
   */
  async executeBuy(order: Order): Promise<SwapResult> {
    const entryNotionalSol = order.quantity * order.price;
    const amountLamports = BigInt(Math.floor(entryNotionalSol * 1e9));
    if (amountLamports <= 0n) {
      throw new Error(
        `Invalid BUY notional: quantity=${order.quantity} price=${order.price}`
      );
    }

    log.info(
      `Executing BUY: ${entryNotionalSol} SOL ` +
      `(~${order.quantity} tokens) → ${order.pairAddress} (strategy: ${order.strategy})`
    );

    return this.executeSwap(SOL_MINT, order.pairAddress, amountLamports);
  }

  /**
   * 포지션 매도 (토큰 → SOL)
   */
  async executeSell(
    tokenMint: string,
    amountRaw: bigint
  ): Promise<SwapResult> {
    log.info(`Executing SELL: ${tokenMint} → SOL`);
    return this.executeSwap(tokenMint, SOL_MINT, amountRaw);
  }

  /**
   * SOL 잔고 조회
   */
  async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return balance / 1e9;
  }

  /**
   * SPL 토큰 잔고 조회 (raw amount)
   */
  async getTokenBalance(tokenMint: string): Promise<bigint> {
    const accounts = await this.connection.getTokenAccountsByOwner(
      this.wallet.publicKey,
      { mint: new PublicKey(tokenMint) }
    );
    if (accounts.value.length === 0) return 0n;

    const balances = await Promise.all(
      accounts.value.map(async ({ pubkey }) => {
        const info = await this.connection.getTokenAccountBalance(pubkey);
        return BigInt(info.value.amount);
      })
    );
    return balances.reduce((sum, amount) => sum + amount, 0n);
  }

  private async getAssetBalanceRaw(mint: string): Promise<bigint> {
    if (mint === SOL_MINT) {
      return BigInt(await this.connection.getBalance(this.wallet.publicKey));
    }
    return this.getTokenBalance(mint);
  }

  private async resolveInputMetrics(
    inputMint: string,
    actualInputAmount?: bigint
  ): Promise<Partial<Pick<SwapResult, 'actualInputUiAmount' | 'inputDecimals'>>> {
    if (actualInputAmount == null) return {};
    const inputDecimals = inputMint === SOL_MINT ? 9 : await this.getMintDecimals(inputMint);
    if (inputDecimals == null) {
      // Why: silent fallback은 partial-fill ratio 왜곡으로 이어진다 (CRITICAL_LIVE P0-B).
      // caller에서 inspect 가능하도록 loud error를 남긴다.
      log.error(
        `[DECIMALS_MISSING] Cannot compute actualInputUiAmount for ${inputMint}: ` +
        `rawAmount=${actualInputAmount.toString()} — input metrics will be undefined`
      );
      return {};
    }
    return {
      actualInputUiAmount: toUiAmount(actualInputAmount, inputDecimals),
      inputDecimals,
    };
  }

  private async resolveOutputMetrics(
    outputMint: string,
    actualOutAmount?: bigint
  ): Promise<Partial<Pick<SwapResult, 'actualOutUiAmount' | 'outputDecimals'>>> {
    if (actualOutAmount == null) return {};
    const outputDecimals = outputMint === SOL_MINT ? 9 : await this.getMintDecimals(outputMint);
    if (outputDecimals == null) {
      // Why: decimals 미해결 상태에서 ui amount를 만들면 1e6~1e9 배 scale 오차가
      // signalProcessor → DB → EdgeTracker까지 오염시킨다 (CRITICAL_LIVE P0-B).
      // loud fail하고 caller가 partial-fill guard에서 fallback 처리한다.
      log.error(
        `[DECIMALS_MISSING] Cannot compute actualOutUiAmount for ${outputMint}: ` +
        `rawAmount=${actualOutAmount.toString()} — output metrics will be undefined`
      );
      return {};
    }
    return {
      actualOutUiAmount: toUiAmount(actualOutAmount, outputDecimals),
      outputDecimals,
    };
  }

  /**
   * Mint decimals 조회 (cached). SOL 은 9 고정, SPL/Token-2022 는 RPC `getParsedAccountInfo`.
   * 2026-04-19 (QA Q1): entryDriftGuard 가 Jupiter quote response 에 없는 decimals 를
   * 외부에서 hint 받아야 실질 동작하므로 public 으로 노출.
   */
  async getMintDecimals(mint: string): Promise<number | undefined> {
    if (mint === SOL_MINT) return 9;
    const cached = this.mintDecimals.get(mint);
    if (cached != null) return cached;
    try {
      const accountInfo = await this.connection.getParsedAccountInfo(new PublicKey(mint));
      const parsed = accountInfo.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined;
      const decimals = parsed?.parsed?.info?.decimals;
      if (typeof decimals === 'number') {
        this.mintDecimals.set(mint, decimals);
        return decimals;
      }
    } catch (error) {
      log.warn(`Failed to resolve mint decimals for ${mint}: ${error}`);
    }
    return undefined;
  }

  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: bigint
  ): Promise<JupiterQuote> {
    const response = await this.jupiterClient.get('/quote', {
      params: {
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: this.maxSlippageBps,
        onlyDirectRoutes: false,
      },
    });
    return response.data;
  }

  private async getSwapTransaction(quote: JupiterQuote): Promise<Buffer> {
    const response = await this.jupiterClient.post('/swap', {
      quoteResponse: quote,
      userPublicKey: this.wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    });

    return Buffer.from(response.data.swapTransaction, 'base64');
  }

  /**
   * 단일 트랜잭션 전송 + 확인 (retry는 executeSwapWithRetry에서 quote 포함 처리)
   * Phase 3: Jito bundle 경로 추가 — MEV 보호.
   */
  private async sendTransaction(txBuffer: Buffer): Promise<{ signature: string; landingLatencyMs: number; viaJito: boolean; jitoTipPaidSol: number }> {
    let tx = VersionedTransaction.deserialize(txBuffer);
    tx.sign([this.wallet]);

    // Phase 3: Jito bundle path (C-21: 장애 시 standard RPC fallback)
    // 2026-05-01 (Codex H2 fix): Jito 실패 → standard RPC fallback 시 jitoTipPaidSol = 0.
    //   이전: 호출자가 항상 getCurrentTipSol() 차감 → fallback 시 tip 미지불인데 차감 → entry price underestimate.
    //   현재: viaJito + jitoTipPaidSol 명시 반환 → 호출자가 fallback 인지 차감 결정.
    if (this.useJito && this.jitoClient) {
      try {
        log.info('Submitting via Jito bundle...');
        // 2026-04-30 (Sprint 1.A3): Jito bundle 의 submit→confirmation 구간 측정.
        const jitoStartMs = Date.now();
        const tipPaidSol = this.jitoClient.getCurrentTipSol();
        const result = await this.jitoClient.submitSingleTx(tx, this.wallet);
        await this.jitoClient.waitForConfirmation(result.bundleId);
        const landingLatencyMs = Date.now() - jitoStartMs;
        const signature = result.txSignatures[0];
        log.info(`TX confirmed via Jito: ${signature} landing=${landingLatencyMs}ms tip=${tipPaidSol.toFixed(6)}`);
        return { signature, landingLatencyMs, viaJito: true, jitoTipPaidSol: tipPaidSol };
      } catch (jitoErr) {
        log.warn(`Jito bundle failed: ${jitoErr}. Falling back to standard RPC.`);
        // TX를 재서명하여 standard RPC로 전송
        const freshTx = VersionedTransaction.deserialize(txBuffer);
        freshTx.sign([this.wallet]);
        tx = freshTx;
      }
    }

    // 2026-04-30 (Sprint 1.A3): Standard RPC submit→confirm 구간 측정.
    const sendStartMs = Date.now();
    const signature = await this.connection.sendTransaction(tx, {
      maxRetries: 2,
      skipPreflight: false,
    });

    const confirmation = await this.connection.confirmTransaction(
      signature,
      'confirmed'
    );
    const landingLatencyMs = Date.now() - sendStartMs;

    if (confirmation.value.err) {
      throw new Error(`TX failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }

    log.info(`TX confirmed: ${signature} landing=${landingLatencyMs}ms`);
    // 2026-05-01 (Codex H2): standard RPC path → jitoTipPaidSol=0 (Jito 미지불).
    return { signature, landingLatencyMs, viaJito: false, jitoTipPaidSol: 0 };
  }
}

function toUiAmount(amount: bigint, decimals: number): number {
  const negative = amount < 0n;
  const raw = (negative ? -amount : amount).toString().padStart(decimals + 1, '0');
  const splitAt = raw.length - decimals;
  const integer = raw.slice(0, splitAt);
  const fraction = decimals > 0 ? raw.slice(splitAt).replace(/0+$/, '') : '';
  const value = fraction ? `${integer}.${fraction}` : integer;
  return Number(negative ? `-${value}` : value);
}
