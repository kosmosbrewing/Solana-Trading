import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('WatchlistScore');

export interface WatchlistScoreInput {
  // Birdeye trending
  trendingRank?: number;          // 1~20 (lower = better)
  priceChange24hPct?: number;
  volume24hUsd?: number;
  liquidityUsd?: number;
  // DexScreener enrichment
  boostAmount?: number;           // total boost amount
  hasPaidOrders?: boolean;
  // Internal metrics
  volumeChangeRatio?: number;     // 24h vol / prev 24h vol
  uniqueBuyersTrend?: number;     // ratio of unique buyers growth
  // H-02: Social mention data
  socialScore?: number;           // 0~15 from SocialMentionTracker
  // Vol/MCap ratio 우선순위
  marketCap?: number;
}

export interface WatchlistScoreResult {
  totalScore: number;             // 0~100
  grade: 'A' | 'B' | 'C';
  components: {
    trendingScore: number;        // 0~30
    marketingScore: number;       // 0~15
    volumeScore: number;          // 0~25
    liquidityScore: number;       // 0~15
    momentumScore: number;        // 0~15
    volMcapScore: number;         // 0~15
  };
}

/**
 * WatchlistScore — watchlist 진입 우선순위 결정.
 * 매수 트리거가 아닌, 어떤 토큰을 감시할지 순위를 매기는 용도.
 */
export function calcWatchlistScore(input: WatchlistScoreInput): WatchlistScoreResult {
  const trendingScore = calcTrendingScore(input);
  const marketingScore = calcMarketingScore(input);
  const volumeScore = calcVolumeScore(input);
  const liquidityScore = calcLiquidityScore(input);
  // H-02: momentumScore에 socialScore 보너스 가산 (15점 캡 유지)
  const momentumScore = Math.min(15, calcMomentumScore(input) + (input.socialScore ?? 0));
  const volMcapScore = calcVolMcapScore(input);

  const totalScore = Math.min(100, Math.max(0,
    trendingScore + marketingScore + volumeScore + liquidityScore + momentumScore + volMcapScore
  ));

  const grade = totalScore >= 70 ? 'A' : totalScore >= 45 ? 'B' : 'C';

  return {
    totalScore,
    grade,
    components: { trendingScore, marketingScore, volumeScore, liquidityScore, momentumScore, volMcapScore },
  };
}

function calcTrendingScore(i: WatchlistScoreInput): number {
  if (i.trendingRank == null) return 0;
  // Top 3 → 30, Top 5 → 24, Top 10 → 18, Top 20 → 10
  if (i.trendingRank <= 3) return 30;
  if (i.trendingRank <= 5) return 24;
  if (i.trendingRank <= 10) return 18;
  if (i.trendingRank <= 20) return 10;
  return 5;
}

function calcMarketingScore(i: WatchlistScoreInput): number {
  let score = 0;
  if (i.hasPaidOrders) score += 8;
  if (i.boostAmount != null) {
    if (i.boostAmount >= 500) score += 7;
    else if (i.boostAmount >= 100) score += 5;
    else if (i.boostAmount > 0) score += 3;
  }
  return Math.min(15, score);
}

function calcVolumeScore(i: WatchlistScoreInput): number {
  const vol = i.volume24hUsd ?? 0;
  if (vol >= 1_000_000) return 25;
  if (vol >= 500_000) return 20;
  if (vol >= 100_000) return 15;
  if (vol >= 50_000) return 10;
  if (vol >= 10_000) return 5;
  return 0;
}

function calcLiquidityScore(i: WatchlistScoreInput): number {
  const liq = i.liquidityUsd ?? 0;
  if (liq >= 500_000) return 15;
  if (liq >= 200_000) return 12;
  if (liq >= 100_000) return 9;
  if (liq >= 50_000) return 6;
  return 0;
}

// 저시총 고거래량 토큰 우대 (0~15점, 밈코인 현실 반영 임계값)
function calcVolMcapScore(i: WatchlistScoreInput): number {
  if (!i.volume24hUsd || !i.marketCap || i.marketCap <= 0) return 0;
  const ratio = i.volume24hUsd / i.marketCap;
  if (ratio >= 1.5) return 15;   // 150%+ (ELUN, Dunald급)
  if (ratio >= 0.5) return 10;   // 50%+ (BURNIE급)
  if (ratio >= 0.2) return 6;    // 20%+
  if (ratio >= 0.1) return 3;    // 10%+
  return 0;
}

/**
 * mergeWatchlistScore — DexScreener enrichment 시 기존 components를 보존하면서
 * 부분 입력(boost, poolInfo 갱신)만 반영하는 재점수화.
 * Why: calcWatchlistScore 전체 재실행 시 trendingScore/momentumScore/socialScore 등
 * 복원 불가능한 입력이 0으로 리셋되는 문제 방지.
 */
export function mergeWatchlistScore(
  existing: WatchlistScoreResult,
  enrichment: WatchlistScoreInput,
): WatchlistScoreResult {
  // Marketing: boost 이력은 누적적 — 기존보다 높을 때만 갱신
  const marketingScore = Math.max(
    existing.components.marketingScore,
    calcMarketingScore(enrichment),
  );
  // Volume/Liquidity: poolInfo 업데이트 반영
  const volumeScore = enrichment.volume24hUsd != null
    ? calcVolumeScore(enrichment)
    : existing.components.volumeScore;
  const liquidityScore = enrichment.liquidityUsd != null
    ? calcLiquidityScore(enrichment)
    : existing.components.liquidityScore;
  // VolMcap: 최신 데이터가 있으면 재계산, 없으면 기존 유지
  const volMcapScore = enrichment.volume24hUsd != null && enrichment.marketCap != null
    ? calcVolMcapScore(enrichment)
    : existing.components.volMcapScore;

  const components = {
    ...existing.components,
    marketingScore,
    volumeScore,
    liquidityScore,
    volMcapScore,
  };
  const totalScore = Math.min(100, Math.max(0,
    components.trendingScore + components.marketingScore +
    components.volumeScore + components.liquidityScore +
    components.momentumScore + components.volMcapScore,
  ));
  const grade: 'A' | 'B' | 'C' = totalScore >= 70 ? 'A' : totalScore >= 45 ? 'B' : 'C';
  return { totalScore, grade, components };
}

function calcMomentumScore(i: WatchlistScoreInput): number {
  let score = 0;
  if (i.priceChange24hPct != null) {
    if (i.priceChange24hPct >= 100) score += 8;
    else if (i.priceChange24hPct >= 50) score += 6;
    else if (i.priceChange24hPct >= 20) score += 4;
    else if (i.priceChange24hPct >= 5) score += 2;
  }
  if (i.volumeChangeRatio != null) {
    if (i.volumeChangeRatio >= 3) score += 7;
    else if (i.volumeChangeRatio >= 2) score += 5;
    else if (i.volumeChangeRatio >= 1.5) score += 3;
  }
  return Math.min(15, score);
}
