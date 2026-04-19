/**
 * Entry Drift Guard (2026-04-19)
 *
 * Why: 2026-04-18 VPS 관측에서 pure_ws lane 4 trades 전부 Jupiter fill 가격이
 * signal price 보다 +20~51% 높게 체결됨 (Token-2022 pump.fun + low-liquidity route).
 * entry price 기준 hard-cut (-4%) 이 즉시 발동 → 실제 시장 움직임 없이도 loser 누적
 * → consecutive 4 losers → canary halt → 관측 중단.
 *
 * 이 gate 는 probe-sized Jupiter quote 를 미리 요청하여 expected fill price 를
 * 계산, signal price 와 비교한 뒤 drift 가 threshold 초과면 entry 차단.
 *
 * 설계:
 *   - signal.price 단위: SOL/token (UI, float)
 *   - Jupiter quote `outAmount`: token raw (lamport-equivalent)
 *   - expected_fill_price = amountSol / (outAmountRaw / 10^tokenDecimals)
 *   - 단, tokenDecimals 는 quote response 에는 없음 → Jupiter routePlan metadata
 *     에서 유추하거나, caller 가 알고 있는 decimals 주입.
 *
 * Caller 패턴 (pureWsBreakoutHandler):
 *   1. probeSolAmount = `signal.price * quantity` (probe notional)
 *   2. tokenDecimals = 미확정 → 기대 비율로 역산 (fallback): Jupiter 가 리턴한
 *      outAmount 를 signal.price 기준 expected outAmount 와 비교.
 *      → expected_out_raw = probeSol / signalPrice × 10^decimals
 *      → 실제 out / expected_out = 가격비 (역수) → drift = (1/ratio) - 1
 *   3. Quote response 실패 시 gate 통과 (observability only, trade 차단 금지)
 *
 * 반환:
 *   - `approved: true` — gate 통과 (drift 허용 범위 또는 quote 실패)
 *   - `approved: false` — drift 초과, entry 차단
 *   - `observedDriftPct` — 측정된 drift (signal 대비 % 증가, 양수 = fill 가격 높음)
 */
import axios from 'axios';
import { createModuleLogger } from '../utils/logger';
import { SOL_MINT, LAMPORTS_PER_SOL } from '../utils/constants';
import {
  JUPITER_KEYLESS_SWAP_API_URL,
  normalizeJupiterSwapApiUrl,
} from '../utils/jupiterApi';

const log = createModuleLogger('EntryDriftGuard');

export interface EntryDriftGuardConfig {
  jupiterApiUrl: string;
  jupiterApiKey?: string;
  /** max allowed drift (decimal, 0.02 = 2%) */
  maxDriftPct: number;
  /** slippage hint for Jupiter quote (bps) */
  slippageBps: number;
  timeoutMs: number;
}

export interface EntryDriftGuardResult {
  approved: boolean;
  reason?: string;
  routeFound: boolean;
  observedDriftPct: number;
  expectedFillPrice?: number;
  expectedOutTokensUi?: number;
  signalPrice: number;
  probeSolAmount: number;
  /** quote 실패 시 true — gate 는 통과시키지만 observability 로 표시 */
  quoteFailed: boolean;
}

const DEFAULT_CONFIG: EntryDriftGuardConfig = {
  jupiterApiUrl: JUPITER_KEYLESS_SWAP_API_URL,
  maxDriftPct: 0.02,
  slippageBps: 100,
  timeoutMs: 5_000,
};

export interface EntryDriftGuardInput {
  /** token mint (output of SOL→token swap) */
  tokenMint: string;
  /** signal price from WS feed (SOL/token, UI units) */
  signalPrice: number;
  /** probe notional SOL amount (e.g. pos.quantity * signal.price) */
  probeSolAmount: number;
  /** caller-known token decimals (optional — fallback for price calc) */
  tokenDecimals?: number;
}

/**
 * Jupiter 에 probe-sized quote 요청 후 signal price 와 gap 측정.
 *
 * signal price vs expected fill price drift 만 판정 — 가격 impact 자체는
 * QuoteGate 의 별도 책임.
 */
export async function evaluateEntryDriftGuard(
  input: EntryDriftGuardInput,
  config: Partial<EntryDriftGuardConfig> = {}
): Promise<EntryDriftGuardResult> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const cfg = {
    ...mergedConfig,
    jupiterApiUrl: normalizeJupiterSwapApiUrl(
      mergedConfig.jupiterApiUrl,
      mergedConfig.jupiterApiKey
    ),
  };

  const baseResult: EntryDriftGuardResult = {
    approved: true,
    routeFound: false,
    observedDriftPct: 0,
    signalPrice: input.signalPrice,
    probeSolAmount: input.probeSolAmount,
    quoteFailed: false,
  };

  if (input.signalPrice <= 0 || input.probeSolAmount <= 0) {
    return { ...baseResult, reason: 'invalid_input' };
  }

  const amountLamports = BigInt(Math.round(input.probeSolAmount * LAMPORTS_PER_SOL));

  try {
    const headers: Record<string, string> = {};
    if (cfg.jupiterApiKey) {
      headers['X-API-Key'] = cfg.jupiterApiKey;
    }

    const response = await axios.get(`${cfg.jupiterApiUrl}/quote`, {
      params: {
        inputMint: SOL_MINT,
        outputMint: input.tokenMint,
        amount: amountLamports.toString(),
        slippageBps: cfg.slippageBps,
      },
      headers,
      timeout: cfg.timeoutMs,
    });

    const quote = response.data;
    if (!quote || !quote.outAmount) {
      return { ...baseResult, quoteFailed: true, reason: 'no_route' };
    }

    const outAmountRaw = BigInt(quote.outAmount);
    if (outAmountRaw <= 0n) {
      return { ...baseResult, quoteFailed: true, reason: 'zero_out' };
    }

    // Jupiter quote 에 `outputDecimals` 가 있으면 사용, 없으면 caller 힌트 또는 fallback 사용.
    const outputDecimals = inferOutputDecimals(quote, input.tokenDecimals);
    if (outputDecimals == null) {
      // decimals 미확인 시 expected outAmount ratio 비교로 대체 (decimals-invariant).
      const signalImpliedOutRaw = BigInt(
        Math.round(input.probeSolAmount / input.signalPrice)
      );
      if (signalImpliedOutRaw <= 0n) {
        return { ...baseResult, quoteFailed: true, reason: 'implied_out_zero' };
      }
      // ratio = expectedOut / signalImpliedOut. 1 이면 drift 없음.
      const ratioNum = Number(outAmountRaw);
      const ratioDen = Number(signalImpliedOutRaw);
      if (!isFinite(ratioNum) || !isFinite(ratioDen) || ratioDen <= 0) {
        return { ...baseResult, quoteFailed: true, reason: 'ratio_invalid' };
      }
      // ratio 는 decimals 배수 포함 (10^decimals). 그러나 caller 가 decimals 를
      // 모르더라도 drift 의 **부호** 는 의미 있음: ratio < 1 → fill 가격 높음 (drift+).
      // 다만 크기는 decimals 가 같은 order 라는 전제 필요.
      // 이 경로는 정밀 판정 안 되므로 fallback 수준의 warn 만 하고 gate 통과.
      log.warn(
        `[ENTRY_DRIFT_GUARD] ${input.tokenMint.slice(0, 12)} decimals unknown — ` +
        `skip strict drift check (route_raw=${outAmountRaw} signal_implied=${signalImpliedOutRaw})`
      );
      return { ...baseResult, routeFound: true, quoteFailed: true, reason: 'decimals_unknown' };
    }

    const expectedOutTokensUi =
      Number(outAmountRaw) / Math.pow(10, outputDecimals);
    if (expectedOutTokensUi <= 0) {
      return { ...baseResult, quoteFailed: true, reason: 'expected_out_zero' };
    }

    const expectedFillPrice = input.probeSolAmount / expectedOutTokensUi;
    const observedDriftPct =
      (expectedFillPrice - input.signalPrice) / input.signalPrice;

    const result: EntryDriftGuardResult = {
      approved: true,
      routeFound: true,
      observedDriftPct,
      expectedFillPrice,
      expectedOutTokensUi,
      signalPrice: input.signalPrice,
      probeSolAmount: input.probeSolAmount,
      quoteFailed: false,
    };

    // 2026-04-19 (QA Q3): Asymmetric drift — positive drift (fill 가격이 signal 보다 높음,
    // bad fill) 만 reject. Negative drift (유리 fill) 는 convexity mission 관점에서 오히려
    // 기회 — reject 하면 convex payoff 를 놓침. 의심스러우면 loud warn 만 남기고 entry 허용.
    if (observedDriftPct > cfg.maxDriftPct) {
      result.approved = false;
      result.reason =
        `entry_drift +${(observedDriftPct * 100).toFixed(2)}% ` +
        `> ${(cfg.maxDriftPct * 100).toFixed(2)}% ` +
        `(signal=${input.signalPrice.toFixed(8)} expected=${expectedFillPrice.toFixed(8)})`;
    } else if (observedDriftPct < -cfg.maxDriftPct) {
      // Negative drift — suspicious favorable fill. Jupiter routing edge case 또는 honeypot
      // 가짜 유리 fill 가능. 단 convexity 관점에서 진입 허용하되 loud log 로 사후 분석 유도.
      log.warn(
        `[ENTRY_DRIFT_FAVORABLE] ${input.tokenMint.slice(0, 12)} ` +
        `drift ${(observedDriftPct * 100).toFixed(2)}% — suspicious favorable fill, entry allowed ` +
        `(signal=${input.signalPrice.toFixed(8)} expected=${expectedFillPrice.toFixed(8)})`
      );
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Quote 실패는 entry 차단 금지 — observability 만.
    log.warn(`[ENTRY_DRIFT_GUARD] ${input.tokenMint.slice(0, 12)} quote failed: ${msg}`);
    return { ...baseResult, quoteFailed: true, reason: `quote_error: ${msg}` };
  }
}

/**
 * Jupiter quote response 에서 outputDecimals 추출 시도.
 * Jupiter 는 quote level 에 decimals 를 포함 안 하지만, 최근 버전 일부에서
 * routePlan metadata 또는 swapInfo 에 정보 있을 수 있음. fallback 으로 caller
 * 힌트 사용.
 */
function inferOutputDecimals(
  quote: Record<string, unknown>,
  callerHint?: number
): number | null {
  // 1순위: quote.outputDecimals (일부 버전)
  const direct = quote.outputDecimals;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0 && direct <= 18) {
    return direct;
  }
  // 2순위: caller-supplied hint (e.g. previously resolved decimals).
  if (
    typeof callerHint === 'number' &&
    Number.isFinite(callerHint) &&
    callerHint >= 0 &&
    callerHint <= 18
  ) {
    return callerHint;
  }
  return null;
}
