/**
 * Active Sell Quote Probe (Survival Layer Tier B-1, 2026-04-21)
 *
 * Why: `securityGate` + `entryDriftGuard` 는 **버스틱(buy-side)** 검증이다.
 * Token-2022 transferHook 은 `securityGate` 로 사전 차단되지만, 실제 liquidity 고갈 /
 * AMM 라우팅 실패 / Jupiter aggregator 가 매도를 처리하지 못하는 pool 상태 등은
 * **실제로 매도 quote 를 요청해봐야만** 드러난다 ("honeypot by liquidity").
 *
 * 본 gate 는 진입 직전에 Jupiter 에 `tokenMint → SOL` 방향 quote 를 요청해서
 * "내가 지금 같은 양을 팔면 얼마를 받는가" 를 측정한다.
 *
 * 검증 대상:
 *  1. Route found — Jupiter 가 매도 경로를 찾을 수 있는가
 *  2. Price impact 허용 범위 — 매도 시 slippage 가 threshold 초과하지 않는가
 *  3. Round-trip 비율 허용 범위 (optional) — probeSol → received tokens → sellback SOL
 *     의 복구 비율이 minRoundTripPct 이상인가
 *
 * entryDriftGuard 와의 차이:
 *  - entryDriftGuard: buy fill vs signal price drift (fill price 정합성)
 *  - sellQuoteProbe:  actual exitability (`팔리는가?`)
 *
 * entryDriftGuard 의 in-flight dedup / result cache / 429 cooldown 설계는 동일 패턴.
 * 단 여기서는 `sellQuoteProbe` 자체 state (별도 key-space) 를 사용.
 */
import axios from 'axios';
import { createModuleLogger } from '../utils/logger';
import { SOL_MINT } from '../utils/constants';
import {
  JUPITER_KEYLESS_SWAP_API_URL,
  normalizeJupiterSwapApiUrl,
} from '../utils/jupiterApi';
import { recordJupiter429 } from '../observability/jupiterRateLimitMetric';

const log = createModuleLogger('SellQuoteProbe');

export interface SellQuoteProbeConfig {
  jupiterApiUrl: string;
  jupiterApiKey?: string;
  /** 매도 impact 허용 상한 (예: 0.10 = 10%) */
  maxImpactPct: number;
  /**
   * round-trip 최소 복구 비율 (예: 0.5 = probeSol 의 50% 는 돌아와야 함).
   * 0 이면 disabled (Jupiter 의 priceImpactPct 만 신뢰).
   */
  minRoundTripPct: number;
  /** 매도 요청 slippage bps (Jupiter quote) */
  slippageBps: number;
  timeoutMs: number;
  /** 결과 캐시 TTL (ms). 0 이면 disabled. */
  resultCacheTtlMs: number;
  /** 429 감지 후 cooldown (ms). 0 이면 disabled. */
  rateLimitCooldownMs: number;
}

export interface SellQuoteProbeInput {
  tokenMint: string;
  /** 팔 토큰 raw 양 (UI amount × 10^decimals) */
  probeTokenAmountRaw: bigint;
  /** entry 시 지출한 SOL (round-trip 비교 기준). 0 이면 roundTrip 계산 skip. */
  expectedSolReceive: number;
  /** token decimals — impact 해석 시 로그용 (optional) */
  tokenDecimals?: number;
}

export interface SellQuoteProbeResult {
  approved: boolean;
  reason?: string;
  routeFound: boolean;
  /** Jupiter 가 보고한 실제 매도 out SOL (UI) */
  observedOutSol: number;
  /** Jupiter 가 보고한 priceImpactPct (decimal, 0.05 = 5%) */
  observedImpactPct: number;
  /** round-trip 복구 비율 (0~1). expectedSolReceive 가 0 이면 NaN */
  roundTripPct: number;
  quoteFailed: boolean;
  cacheStatus?: 'miss' | 'result_hit' | 'in_flight_join' | 'rate_limited';
}

const DEFAULT_CONFIG: SellQuoteProbeConfig = {
  jupiterApiUrl: JUPITER_KEYLESS_SWAP_API_URL,
  maxImpactPct: 0.10,
  minRoundTripPct: 0.0,
  slippageBps: 500, // 매도는 buy 대비 관대 — 실제 체결 속도보다 존재 여부가 핵심
  timeoutMs: 3_000,
  resultCacheTtlMs: 3_000,
  rateLimitCooldownMs: 2_000,
};

// ─── Module state (process-wide) ───
interface CachedQuote {
  outAmountSolRaw: bigint;
  priceImpactPct: number;
  reason?: string;
  expiresAtMs: number;
}

const quoteResultCache = new Map<string, CachedQuote>();
// 2026-04-21 (QA M1): in-flight dedup — 같은 key 동시 요청을 하나의 Promise 로 공유.
// Why: V2 scanner 의 burst (동일 pair 에 sub-ms 연속 signal) 시 중복 Jupiter 호출 방지.
// entryDriftGuard 와 동일 패턴 (일관성).
const quoteInFlight = new Map<string, Promise<CachedQuote>>();
let rateLimitedUntilMs = 0;

export function resetSellQuoteProbeStateForTests(): void {
  quoteResultCache.clear();
  quoteInFlight.clear();
  rateLimitedUntilMs = 0;
}

function buildQuoteKey(input: SellQuoteProbeInput, cfg: SellQuoteProbeConfig): string {
  return `sell|${input.tokenMint}|${input.probeTokenAmountRaw.toString()}|${cfg.slippageBps}`;
}

function parsePriceImpact(quote: Record<string, unknown>): number {
  const raw = quote.priceImpactPct ?? quote.priceImpact ?? 0;
  const pct = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
  return Math.abs(pct) / 100;
}

const LAMPORTS_PER_SOL_N = 1_000_000_000;

/**
 * 진입 직전 Jupiter 에 sell quote 요청 → exitability 검증.
 * quote 실패 / 429 cooldown 시 gate 통과 (observability only — 진입 차단은 false positive 비용 ↑).
 */
export async function evaluateSellQuoteProbe(
  input: SellQuoteProbeInput,
  config: Partial<SellQuoteProbeConfig> = {}
): Promise<SellQuoteProbeResult> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const cfg = {
    ...mergedConfig,
    jupiterApiUrl: normalizeJupiterSwapApiUrl(
      mergedConfig.jupiterApiUrl,
      mergedConfig.jupiterApiKey
    ),
  };

  const baseResult: SellQuoteProbeResult = {
    approved: true,
    routeFound: false,
    observedOutSol: 0,
    observedImpactPct: 0,
    roundTripPct: NaN,
    quoteFailed: false,
  };

  if (input.probeTokenAmountRaw <= 0n) {
    return { ...baseResult, reason: 'invalid_input' };
  }

  const now = Date.now();
  const quoteKey = buildQuoteKey(input, cfg);

  // 429 회로 차단기
  if (cfg.rateLimitCooldownMs > 0 && now < rateLimitedUntilMs) {
    return {
      ...baseResult,
      quoteFailed: true,
      reason: 'rate_limited_cooldown',
      cacheStatus: 'rate_limited',
    };
  }

  // 결과 캐시
  if (cfg.resultCacheTtlMs > 0) {
    const cached = quoteResultCache.get(quoteKey);
    if (cached && cached.expiresAtMs > now) {
      return materialize(input, cfg, cached.outAmountSolRaw, cached.priceImpactPct, cached.reason, 'result_hit');
    }
  }

  // 2026-04-21 (QA M1): in-flight dedup — 동일 key 의 concurrent 호출을 Promise 공유.
  // V2 scanner burst 같은 상황에서 Jupiter 중복 호출 방지. entryDriftGuard 와 동일 패턴.
  const pending = quoteInFlight.get(quoteKey);
  if (pending) {
    const joined = await pending.catch(() => null);
    if (joined) {
      return materialize(input, cfg, joined.outAmountSolRaw, joined.priceImpactPct, joined.reason, 'in_flight_join');
    }
    // pending 실패 → fall-through 해서 신규 시도 (그 사이 cooldown 걸렸으면 위에서 이미 차단)
  }

  const fetchPromise = fetchSellQuote(input, cfg, now).then((fetched) => {
    if (cfg.resultCacheTtlMs > 0) {
      quoteResultCache.set(quoteKey, {
        outAmountSolRaw: fetched.outAmountSolRaw,
        priceImpactPct: fetched.priceImpactPct,
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
    const errWithResp = err as { response?: { status: number } };
    const is429 = errWithResp.response?.status === 429 || msg.includes('429');
    if (is429) {
      recordJupiter429('sell_quote_probe');
      if (cfg.rateLimitCooldownMs > 0) {
        rateLimitedUntilMs = now + cfg.rateLimitCooldownMs;
        log.warn(`[SELL_QUOTE_PROBE] 429 → cooldown ${cfg.rateLimitCooldownMs}ms`);
      }
    } else {
      log.warn(`[SELL_QUOTE_PROBE] ${input.tokenMint.slice(0, 12)} quote failed: ${msg}`);
    }
    // quote 실패는 진입 차단 금지 (observability only) — false positive 비용이 크다.
    return {
      ...baseResult,
      quoteFailed: true,
      reason: `quote_error: ${msg}`,
      cacheStatus: 'miss',
    };
  }

  return materialize(input, cfg, fetched.outAmountSolRaw, fetched.priceImpactPct, fetched.reason, 'miss');
}

/**
 * Jupiter sell quote 요청 (no cache). in-flight dedup 은 caller 가 관리.
 * no_sell_route 도 에러 아닌 정상 결과로 (reason 필드) 반환하여 cache 가능하게 함.
 */
async function fetchSellQuote(
  input: SellQuoteProbeInput,
  cfg: SellQuoteProbeConfig,
  _requestStartMs: number
): Promise<CachedQuote> {
  const headers: Record<string, string> = {};
  if (cfg.jupiterApiKey) {
    headers['X-API-Key'] = cfg.jupiterApiKey;
  }

  const response = await axios.get(`${cfg.jupiterApiUrl}/quote`, {
    params: {
      inputMint: input.tokenMint,
      outputMint: SOL_MINT,
      amount: input.probeTokenAmountRaw.toString(),
      slippageBps: cfg.slippageBps,
    },
    headers,
    timeout: cfg.timeoutMs,
  });

  const quote = response.data;
  if (!quote || !quote.outAmount) {
    return {
      outAmountSolRaw: 0n,
      priceImpactPct: 0,
      reason: 'no_sell_route',
      expiresAtMs: 0, // caller 가 cache 저장 시 갱신
    };
  }

  return {
    outAmountSolRaw: BigInt(quote.outAmount),
    priceImpactPct: parsePriceImpact(quote),
    expiresAtMs: 0, // caller 가 cache 저장 시 갱신
  };
}

function materialize(
  input: SellQuoteProbeInput,
  cfg: SellQuoteProbeConfig,
  outAmountSolRaw: bigint,
  priceImpactPct: number,
  reason: string | undefined,
  cacheStatus: 'miss' | 'result_hit' | 'in_flight_join'
): SellQuoteProbeResult {
  const base: SellQuoteProbeResult = {
    approved: true,
    routeFound: false,
    observedOutSol: 0,
    observedImpactPct: priceImpactPct,
    roundTripPct: NaN,
    quoteFailed: false,
    cacheStatus,
  };

  if (reason === 'no_sell_route' || outAmountSolRaw <= 0n) {
    return {
      ...base,
      approved: false,
      routeFound: false,
      reason: reason ?? 'no_sell_route',
    };
  }

  const outSol = Number(outAmountSolRaw) / LAMPORTS_PER_SOL_N;
  const roundTripPct =
    input.expectedSolReceive > 0 ? outSol / input.expectedSolReceive : NaN;

  const result: SellQuoteProbeResult = {
    ...base,
    routeFound: true,
    observedOutSol: outSol,
    observedImpactPct: priceImpactPct,
    roundTripPct,
  };

  if (priceImpactPct > cfg.maxImpactPct) {
    result.approved = false;
    result.reason =
      `sell_impact ${(priceImpactPct * 100).toFixed(2)}% > ${(cfg.maxImpactPct * 100).toFixed(2)}%`;
    return result;
  }

  if (
    cfg.minRoundTripPct > 0 &&
    input.expectedSolReceive > 0 &&
    isFinite(roundTripPct) &&
    roundTripPct < cfg.minRoundTripPct
  ) {
    result.approved = false;
    result.reason =
      `round_trip ${(roundTripPct * 100).toFixed(1)}% < ${(cfg.minRoundTripPct * 100).toFixed(1)}%`;
    return result;
  }

  return result;
}
