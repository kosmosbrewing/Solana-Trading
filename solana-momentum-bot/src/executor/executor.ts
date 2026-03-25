import axios, { AxiosInstance } from 'axios';
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { createModuleLogger } from '../utils/logger';
import { Order } from '../utils/types';
import { SOL_MINT } from '../utils/constants';
import { JitoClient } from './jitoClient';
import { normalizeJupiterSwapApiUrl } from '../utils/jupiterApi';

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
  txSignature: string;
  expectedOutAmount: bigint;   // Jupiter quote 예상 수신량
  actualOutAmount?: bigint;    // 온체인 실제 수신량 (확인 가능 시)
  slippageBps: number;         // 실제 슬리피지 (bps)
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

export class Executor {
  private connection: Connection;
  private wallet: Keypair;
  private jupiterClient: AxiosInstance;
  private ultraClient?: AxiosInstance;
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
    this.maxSlippageBps = Math.round(executorConfig.maxSlippage * 10000);
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
    const executeResponse = await this.ultraClient.post<UltraExecuteResponse>('/ultra/v1/execute', {
      signedTransaction: signedTxBase64,
      requestId: order.requestId,
    });

    const result = executeResponse.data;

    if (result.status !== 'Success') {
      throw new Error(`Ultra execute failed: status=${result.status}`);
    }

    // 실제 수신량 계산 — Ultra 응답에 결과가 있으면 사용, 없으면 잔액 비교
    let actualOutAmount: bigint | undefined;
    let actualSlippageBps = 0;

    if (result.outputAmountResult) {
      actualOutAmount = BigInt(result.outputAmountResult);
      actualSlippageBps = expectedOut > 0n
        ? Number((expectedOut - actualOutAmount) * 10000n / expectedOut)
        : 0;
    }
    // outputAmountResult 없으면 actualOutAmount=undefined 유지 (before 없이 비교 불가)

    log.info(
      `Ultra swap complete: sig=${result.signature}, expected=${expectedOut}, ` +
      `actual=${actualOutAmount ?? 'unknown'}, slippage=${actualSlippageBps}bps`
    );

    return {
      txSignature: result.signature,
      expectedOutAmount: expectedOut,
      actualOutAmount,
      slippageBps: actualSlippageBps,
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

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const quote = await this.getQuote(inputMint, outputMint, amountLamports);
        log.info(
          `Quote (attempt ${attempt}): ${quote.inAmount} → ${quote.outAmount} (slippage: ${quote.slippageBps}bps)`
        );

        const expectedOut = BigInt(quote.outAmount);

        const balanceBefore = outputMint === SOL_MINT
          ? BigInt(Math.round(await this.getBalance() * 1e9))
          : await this.getTokenBalance(outputMint);

        const swapTx = await this.getSwapTransaction(quote);
        const txSignature = await this.sendTransaction(swapTx);

        const balanceAfter = outputMint === SOL_MINT
          ? BigInt(Math.round(await this.getBalance() * 1e9))
          : await this.getTokenBalance(outputMint);

        const actualOutAmount = balanceAfter - balanceBefore;
        const actualSlippageBps = expectedOut > 0n
          ? Number((expectedOut - actualOutAmount) * 10000n / expectedOut)
          : 0;

        log.info(
          `Swap complete: expected=${expectedOut}, actual=${actualOutAmount}, slippage=${actualSlippageBps}bps`
        );

        return {
          txSignature,
          expectedOutAmount: expectedOut,
          actualOutAmount: actualOutAmount > 0n ? actualOutAmount : undefined,
          slippageBps: actualSlippageBps,
        };
      } catch (error) {
        lastError = error as Error;
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
    const amountLamports = BigInt(Math.floor(order.quantity * 1e9));

    log.info(
      `Executing BUY: ${order.quantity} SOL → ${order.pairAddress} (strategy: ${order.strategy})`
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
      { mint: await import('@solana/web3.js').then(m => new m.PublicKey(tokenMint)) }
    );
    if (accounts.value.length === 0) return 0n;

    const info = await this.connection.getTokenAccountBalance(accounts.value[0].pubkey);
    return BigInt(info.value.amount);
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
  private async sendTransaction(txBuffer: Buffer): Promise<string> {
    let tx = VersionedTransaction.deserialize(txBuffer);
    tx.sign([this.wallet]);

    // Phase 3: Jito bundle path (C-21: 장애 시 standard RPC fallback)
    if (this.useJito && this.jitoClient) {
      try {
        log.info('Submitting via Jito bundle...');
        const result = await this.jitoClient.submitSingleTx(tx, this.wallet);
        await this.jitoClient.waitForConfirmation(result.bundleId);
        const signature = result.txSignatures[0];
        log.info(`TX confirmed via Jito: ${signature}`);
        return signature;
      } catch (jitoErr) {
        log.warn(`Jito bundle failed: ${jitoErr}. Falling back to standard RPC.`);
        // TX를 재서명하여 standard RPC로 전송
        const freshTx = VersionedTransaction.deserialize(txBuffer);
        freshTx.sign([this.wallet]);
        tx = freshTx;
      }
    }

    // Standard RPC path
    const signature = await this.connection.sendTransaction(tx, {
      maxRetries: 2,
      skipPreflight: false,
    });

    const confirmation = await this.connection.confirmTransaction(
      signature,
      'confirmed'
    );

    if (confirmation.value.err) {
      throw new Error(`TX failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }

    log.info(`TX confirmed: ${signature}`);
    return signature;
  }
}
