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
 *
 * 2026-04-19 (P0-2 Jupiter 429 방어):
 *   8h 관측 `3,998` quote 429 에러 — 동일 pair (GEr3mp) 가 sub-millisecond 로
 *   signal 폭주 → 동시 quote 수백 건 → Jupiter rate limit 진입 → 지속 hammering.
 *   3단계 방어선 추가:
 *     (1) In-flight promise 중복 제거: 동일 key 요청은 단일 Promise 공유
 *     (2) 결과 캐시 (TTL 3s): 같은 pair 연속 signal 은 1회만 호출
 *     (3) 429 회로 차단기: 직전 429 이후 cooldown 기간 동안 axios 호출 skip
 */
import axios from 'axios';
import { createModuleLogger } from '../utils/logger';
import { SOL_MINT, LAMPORTS_PER_SOL } from '../utils/constants';
import {
  JUPITER_KEYLESS_SWAP_API_URL,
  normalizeJupiterSwapApiUrl,
} from '../utils/jupiterApi';
import { recordJupiter429 } from '../observability/jupiterRateLimitMetric';

const log = createModuleLogger('EntryDriftGuard');

export interface EntryDriftGuardConfig {
  jupiterApiUrl: string;
  jupiterApiKey?: string;
  /** max allowed positive drift (decimal, 0.02 = 2%) — bad fill 방어 */
  maxDriftPct: number;
  /**
   * 2026-04-22 추가: negative drift (favorable fill) 의 최대 허용치.
   * 소규모 favorable fill (< 5%) 은 normal market activity — 통과.
   * 대규모 negative drift (e.g. −90%) 는 signal price 자체 오류 / stale pool subscription 징후 —
   * "honeypot by liquidity" 못지 않게 위험. 실측 2026-04-21 pippin 48 trades 에서 drift=−91.67%
   * 고정 관측 (signal price 계산 버그) — wallet 손상 방지 위해 reject.
   * 기본 0.20 (−20% 이상 favorable drift 면 suspicious signal 로 reject).
   */
  maxFavorableDriftPct: number;
  /** slippage hint for Jupiter quote (bps) */
  slippageBps: number;
  timeoutMs: number;
  /** 결과 캐시 TTL (ms). 0 이면 캐싱 비활성. */
  resultCacheTtlMs: number;
  /** 429 감지 후 재요청 금지 기간 (ms). 0 이면 비활성. */
  rateLimitCooldownMs: number;
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
  /** cache hit / in-flight join / circuit open 여부 — 로깅 용 */
  cacheStatus?: 'miss' | 'result_hit' | 'in_flight_join' | 'rate_limited';
}

const DEFAULT_CONFIG: EntryDriftGuardConfig = {
  jupiterApiUrl: JUPITER_KEYLESS_SWAP_API_URL,
  maxDriftPct: 0.02,
  maxFavorableDriftPct: 0.20,
  slippageBps: 100,
  timeoutMs: 5_000,
  resultCacheTtlMs: 3_000,
  rateLimitCooldownMs: 2_000,
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

// ─── Module state (process-wide) ───────────────────────────────────────────
// Why: 같은 pair 에 sub-ms 로 수백 signal 이 들어오는 burst 관측됨 (2026-04-19).
//      process-wide 공유 캐시 + in-flight map 으로 Jupiter 부하 차단.

interface QuoteRaw {
  outAmount: bigint;
  outputDecimals: number | null;
  raw: Record<string, unknown>;
}

interface CachedQuote {
  quote: QuoteRaw | null; // null = 이 key 는 no_route / zero_out
  reason?: string;
  expiresAtMs: number;
}

const quoteResultCache = new Map<string, CachedQuote>();
const quoteInFlight = new Map<string, Promise<CachedQuote>>();
let rateLimitedUntilMs = 0;

/** 테스트/재기동 시 상태 초기화. */
export function resetEntryDriftGuardState(): void {
  quoteResultCache.clear();
  quoteInFlight.clear();
  rateLimitedUntilMs = 0;
}

function buildQuoteKey(input: EntryDriftGuardInput, cfg: EntryDriftGuardConfig): string {
  return `${input.tokenMint}|${Math.round(input.probeSolAmount * LAMPORTS_PER_SOL)}|${cfg.slippageBps}`;
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

  const now = Date.now();
  const quoteKey = buildQuoteKey(input, cfg);

  // (3) 429 회로 차단기 — 최근 Jupiter 에 429 맞았으면 cooldown 동안 호출 skip.
  if (cfg.rateLimitCooldownMs > 0 && now < rateLimitedUntilMs) {
    return { ...baseResult, quoteFailed: true, reason: 'rate_limited_cooldown', cacheStatus: 'rate_limited' };
  }

  // (2) 결과 캐시 — 같은 pair+probe 에 대한 최근 Jupiter 응답 재사용.
  if (cfg.resultCacheTtlMs > 0) {
    const cached = quoteResultCache.get(quoteKey);
    if (cached && cached.expiresAtMs > now) {
      return materializeResult(input, cfg, cached.quote, cached.reason, 'result_hit');
    }
  }

  // (1) In-flight 중복 제거 — 동일 key 진행 중이면 그 Promise 를 공유.
  const pending = quoteInFlight.get(quoteKey);
  if (pending) {
    const joined = await pending.catch(() => null);
    if (joined) {
      return materializeResult(input, cfg, joined.quote, joined.reason, 'in_flight_join');
    }
    // pending 실패 → fall-through 하여 신규 시도 (그 사이 cooldown 걸렸으면 위에서 차단됨)
  }

  const fetchPromise = fetchJupiterQuote(input, cfg).then((fetched) => {
    if (cfg.resultCacheTtlMs > 0) {
      quoteResultCache.set(quoteKey, {
        quote: fetched.quote,
        reason: fetched.reason,
        expiresAtMs: Date.now() + cfg.resultCacheTtlMs,
      });
    }
    return fetched;
  }).finally(() => {
    quoteInFlight.delete(quoteKey);
  });
  quoteInFlight.set(quoteKey, fetchPromise);

  let fetched: CachedQuote;
  try {
    fetched = await fetchPromise;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[ENTRY_DRIFT_GUARD] ${input.tokenMint.slice(0, 12)} quote failed: ${msg}`);
    return { ...baseResult, quoteFailed: true, reason: `quote_error: ${msg}`, cacheStatus: 'miss' };
  }

  return materializeResult(input, cfg, fetched.quote, fetched.reason, 'miss');
}

/**
 * Jupiter quote 실행 (no cache) — 429 감지 시 rateLimitedUntilMs 설정.
 * cache 는 성공/실패 공통으로 저장하여 burst 를 흡수한다 (실패도 TTL 동안 재호출 금지).
 */
async function fetchJupiterQuote(
  input: EntryDriftGuardInput,
  cfg: EntryDriftGuardConfig
): Promise<CachedQuote> {
  const amountLamports = BigInt(Math.round(input.probeSolAmount * LAMPORTS_PER_SOL));
  const headers: Record<string, string> = {};
  if (cfg.jupiterApiKey) {
    headers['X-API-Key'] = cfg.jupiterApiKey;
  }

  try {
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
      return { quote: null, reason: 'no_route', expiresAtMs: 0 };
    }
    const outAmountRaw = BigInt(quote.outAmount);
    if (outAmountRaw <= 0n) {
      return { quote: null, reason: 'zero_out', expiresAtMs: 0 };
    }
    const outputDecimals = inferOutputDecimals(quote, input.tokenDecimals);
    return {
      quote: { outAmount: outAmountRaw, outputDecimals, raw: quote },
      expiresAtMs: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 429 감지 시 회로 차단기 트립. 이후 호출은 rate_limited 분기로 즉시 fail-open.
    if (is429Error(err)) {
      recordJupiter429('entry_drift_guard');
      if (cfg.rateLimitCooldownMs > 0) {
        rateLimitedUntilMs = Date.now() + cfg.rateLimitCooldownMs;
      }
    }
    throw new Error(msg);
  }
}

function is429Error(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/status code 429|rate[_ ]?limit|too many requests/i.test(msg)) return true;
  // axios error with response.status
  const anyErr = err as { response?: { status?: number } };
  return anyErr?.response?.status === 429;
}

/**
 * 캐시/join 된 quote raw 로부터 drift 계산 + approve 판정.
 * signalPrice 는 caller 별로 다를 수 있으므로 결과 객체 자체는 캐시하지 않는다.
 */
function materializeResult(
  input: EntryDriftGuardInput,
  cfg: EntryDriftGuardConfig,
  quote: QuoteRaw | null,
  reason: string | undefined,
  cacheStatus: EntryDriftGuardResult['cacheStatus']
): EntryDriftGuardResult {
  const baseResult: EntryDriftGuardResult = {
    approved: true,
    routeFound: false,
    observedDriftPct: 0,
    signalPrice: input.signalPrice,
    probeSolAmount: input.probeSolAmount,
    quoteFailed: false,
    cacheStatus,
  };

  if (!quote) {
    return { ...baseResult, quoteFailed: true, reason: reason ?? 'no_route' };
  }

  if (quote.outputDecimals == null) {
    const signalImpliedOutRaw = BigInt(
      Math.round(input.probeSolAmount / input.signalPrice)
    );
    if (signalImpliedOutRaw <= 0n) {
      return { ...baseResult, quoteFailed: true, reason: 'implied_out_zero' };
    }
    log.warn(
      `[ENTRY_DRIFT_GUARD] ${input.tokenMint.slice(0, 12)} decimals unknown — ` +
      `skip strict drift check (route_raw=${quote.outAmount} signal_implied=${signalImpliedOutRaw})`
    );
    return { ...baseResult, routeFound: true, quoteFailed: true, reason: 'decimals_unknown' };
  }

  const expectedOutTokensUi =
    Number(quote.outAmount) / Math.pow(10, quote.outputDecimals);
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
    cacheStatus,
  };

  // 2026-04-19 (QA Q3): Asymmetric drift — positive drift (fill 가격이 signal 보다 높음,
  // bad fill) 만 reject. 소규모 Negative drift (유리 fill) 는 convexity mission 관점에서 기회.
  //
  // 2026-04-22 보강: large negative drift (기본 −20% 초과) 는 signal price 계산 버그 /
  // pool stale / multi-pool mismatch 징후. 실측 2026-04-21 pippin 48 trades 에서 drift=−91.67%
  // 고정 관측 — wallet 손해는 적지만 dual tracker market reference 오염 → MAE/MFE 무의미.
  if (observedDriftPct > cfg.maxDriftPct) {
    result.approved = false;
    result.reason =
      `entry_drift +${(observedDriftPct * 100).toFixed(2)}% ` +
      `> ${(cfg.maxDriftPct * 100).toFixed(2)}% ` +
      `(signal=${input.signalPrice.toFixed(8)} expected=${expectedFillPrice.toFixed(8)})`;
  } else if (observedDriftPct < -cfg.maxFavorableDriftPct) {
    // 대규모 favorable drift — signal bug / pool mismatch 의심. reject.
    result.approved = false;
    result.reason =
      `suspicious_favorable_drift ${(observedDriftPct * 100).toFixed(2)}% ` +
      `< −${(cfg.maxFavorableDriftPct * 100).toFixed(2)}% ` +
      `(signal=${input.signalPrice.toFixed(8)} expected=${expectedFillPrice.toFixed(8)}) — ` +
      `signal price bug / pool stale 의심`;
  } else if (observedDriftPct < -cfg.maxDriftPct) {
    // 소규모 negative drift — true favorable fill 가능 (entry 허용, 관측만)
    log.warn(
      `[ENTRY_DRIFT_FAVORABLE] ${input.tokenMint.slice(0, 12)} ` +
      `drift ${(observedDriftPct * 100).toFixed(2)}% — favorable fill, entry allowed ` +
      `(signal=${input.signalPrice.toFixed(8)} expected=${expectedFillPrice.toFixed(8)})`
    );
  }

  return result;
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
