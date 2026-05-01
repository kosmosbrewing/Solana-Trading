/**
 * Exitability Evidence (2026-05-01, Helius Stream B).
 *
 * ADR: docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md §6 Stream B
 *
 * 목적: `OnchainSecurityClient.getExitLiquidity()` 가 null 반환하는 gap 을 observe-only evidence
 *       layer 로 대체. USD 유동성을 만들어내지 않고, **이미 알려진 신호 3개를 join 해서 sell 가능성 추정**:
 *         1. Jupiter sell quote (이미 sellQuoteProbe 가 호출 중)
 *         2. Helius pool registry metadata (HeliusPoolRegistry)
 *         3. recent raw-swap coverage (heliusWSIngester / kol-tx ledger)
 *
 * 정책 (Stream B step 3):
 *   - `OnchainSecurityClient` 는 mint / holder / on-chain security 만 책임 — 본 모듈은 그 외 evidence 합산.
 *   - v1 출력 필드: `exitLiquidityUsd=null` 허용. 그 대신 `sellRouteKnown` / `poolKnown` / `recentSwapCoverage` /
 *     `reason` 4 필드는 항상 기록.
 *   - USD 유동성을 invent 안 함 (price/liquidity source 미존재 시 null 유지).
 *
 * 의존: 없음 (pure data join). I/O 없음. caller 가 입력 evidence 수집 후 호출.
 */

export interface ExitabilityEvidenceInput {
  /** Jupiter sell-quote 결과 (sellQuoteProbe). null = 호출 안 됨 / 실패. */
  sellQuote?: {
    /** quote 수신 여부. true = quote 가능 → sell route 존재 */
    received: boolean;
    /** SOL out estimate (sell 1 token 기준). null 허용 */
    estimatedSolOut?: number | null;
    /** quote impact (slippage proxy, 0-1) */
    priceImpactPct?: number | null;
    /** quote 실패 reason (e.g. 'no_route', '429', 'timeout') */
    failureReason?: string;
  };
  /** Helius pool registry — token mint 의 알려진 pool 갯수. */
  poolRegistry?: {
    /** 등록된 pool 수 (>= 0). 0 = pool 미발견 */
    knownPoolCount: number;
    /** primary pool address (있으면) */
    primaryPool?: string;
  };
  /** Recent raw-swap coverage — heliusWSIngester / kol-tx 의 최근 N분 거래 활동. */
  recentSwapCoverage?: {
    /** lookback window seconds (default 300s = 5분) */
    windowSec: number;
    /** window 안 swap 수 (>= 0) */
    swapCount: number;
    /** window 안 distinct trader 수 (>= 0). null = 미측정 */
    distinctTraders?: number | null;
  };
}

export interface ExitabilityEvidenceOutput {
  /** sell route 알려진 여부 — Jupiter quote 성공 OR pool 발견 */
  sellRouteKnown: boolean;
  /** pool 발견 여부 (registry knownPoolCount > 0) */
  poolKnown: boolean;
  /**
   * 최근 swap 활동 단계 — 'none' (0건) / 'sparse' (1-4건) / 'active' (5+건). null = 미측정.
   * S/M/L 식으로 운영자가 직관 판단.
   */
  recentSwapCoverage: 'none' | 'sparse' | 'active' | 'unknown';
  /**
   * Stream B step 3 정책: USD 유동성 미invent.
   * Jupiter quote + recent swap 가 모두 충분히 명확할 때만 추정 — 그 외 null.
   */
  exitLiquidityUsd: number | null;
  /**
   * sellRouteKnown / poolKnown / coverage 가 negative 일 때 분류 reason.
   * 'no_quote_no_pool' / 'pool_only_no_quote' / 'quote_only_no_pool' / 'sparse_activity' /
   * 'no_recent_activity' / 'evidence_complete'.
   */
  reason:
    | 'evidence_complete'
    | 'pool_only_no_quote'
    | 'quote_only_no_pool'
    | 'no_quote_no_pool'
    | 'sparse_activity'
    | 'no_recent_activity'
    | 'insufficient_evidence';
  /**
   * Stream B 의 7 risk flags 중 본 모듈이 emit 하는 2개:
   *   - `EXIT_LIQUIDITY_UNKNOWN` (sellRouteKnown=false 또는 evidence 부족)
   *   - `POOL_NOT_PREWARMED` (poolKnown=false)
   */
  riskFlags: ReadonlyArray<'EXIT_LIQUIDITY_UNKNOWN' | 'POOL_NOT_PREWARMED'>;
}

/**
 * 3 evidence join — observe-only.
 * 모든 입력은 optional; 모자라면 reason='insufficient_evidence' / coverage='unknown' 으로 기록.
 */
export function joinExitabilityEvidence(input: ExitabilityEvidenceInput): ExitabilityEvidenceOutput {
  const sellQuoteReceived = input.sellQuote?.received === true;
  const sellQuotePresent = input.sellQuote != null;
  const poolKnown = (input.poolRegistry?.knownPoolCount ?? 0) > 0;

  // sell route 알려짐 = quote 성공 OR pool 알려짐 (둘 중 하나만 있어도 어느 정도 신뢰)
  const sellRouteKnown = sellQuoteReceived || poolKnown;

  // recent swap coverage 분류
  let recentSwapCoverage: ExitabilityEvidenceOutput['recentSwapCoverage'];
  const swapCount = input.recentSwapCoverage?.swapCount;
  if (typeof swapCount !== 'number' || !Number.isFinite(swapCount)) {
    recentSwapCoverage = 'unknown';
  } else if (swapCount === 0) {
    recentSwapCoverage = 'none';
  } else if (swapCount <= 4) {
    recentSwapCoverage = 'sparse';
  } else {
    recentSwapCoverage = 'active';
  }

  // exitLiquidityUsd: USD source 가 없으므로 null. v2+ 에서 Jupiter quote × spot price + active swap 시 추정 가능.
  const exitLiquidityUsd: number | null = null;

  // reason 분기
  let reason: ExitabilityEvidenceOutput['reason'];
  if (!sellQuotePresent && !input.poolRegistry && !input.recentSwapCoverage) {
    reason = 'insufficient_evidence';
  } else if (sellQuoteReceived && poolKnown && recentSwapCoverage !== 'none') {
    reason = 'evidence_complete';
  } else if (poolKnown && !sellQuoteReceived) {
    reason = 'pool_only_no_quote';
  } else if (sellQuoteReceived && !poolKnown) {
    reason = 'quote_only_no_pool';
  } else if (recentSwapCoverage === 'sparse') {
    reason = 'sparse_activity';
  } else if (recentSwapCoverage === 'none') {
    reason = 'no_recent_activity';
  } else {
    reason = 'no_quote_no_pool';
  }

  // risk flags
  const riskFlags: Array<'EXIT_LIQUIDITY_UNKNOWN' | 'POOL_NOT_PREWARMED'> = [];
  if (!sellRouteKnown || reason === 'insufficient_evidence') {
    riskFlags.push('EXIT_LIQUIDITY_UNKNOWN');
  }
  if (!poolKnown) {
    riskFlags.push('POOL_NOT_PREWARMED');
  }

  return {
    sellRouteKnown,
    poolKnown,
    recentSwapCoverage,
    exitLiquidityUsd,
    reason,
    riskFlags,
  };
}

/**
 * Stream B 의 7 risk flags 중 holder + dev + helius provenance 5개 (exitability 외 5개)
 * 산출 helper. tokenQualityInspector wiring 에서 import 해서 합산.
 *
 *   - HOLDER_TOP1_HIGH       (holderDistribution.computeHolderRiskFlags 가 발사)
 *   - HOLDER_TOP5_HIGH       (동일)
 *   - HOLDER_TOP10_HIGH      (동일)
 *   - HOLDER_HHI_HIGH        (동일)
 *   - NO_HELIUS_PROVENANCE   (KolTx 의 parseSource 가 'heuristic' 일 때)
 *
 * 본 모듈은 EXIT_LIQUIDITY_UNKNOWN / POOL_NOT_PREWARMED 만 책임.
 */
export type StreamBRiskFlag =
  | 'HOLDER_TOP1_HIGH'
  | 'HOLDER_TOP5_HIGH'
  | 'HOLDER_TOP10_HIGH'
  | 'HOLDER_HHI_HIGH'
  | 'EXIT_LIQUIDITY_UNKNOWN'
  | 'POOL_NOT_PREWARMED'
  | 'NO_HELIUS_PROVENANCE';
