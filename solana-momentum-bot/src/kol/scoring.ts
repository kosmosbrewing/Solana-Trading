/**
 * KOL Discovery Score (Option 5, 2026-04-23)
 *
 * ⚠ 중요: 본 score 는 **Discovery trigger 의 confidence metric** 이다.
 * Gate 가산이 아니다 (ADR §5.4). Gate 통과는 기존 pipeline 만 결정한다.
 *
 * 사용처:
 *  - kol_hunter handler 가 candidate 의 priority 부여
 *  - Phase 2 shadow eval 의 "single-KOL vs multi-KOL" 비교 baseline
 *  - Logging / telemetry
 *
 * Anti-correlation (ADR §5.4): 60s 내 연속 KOL tx = chain forward 의심, 단일 signal 처리.
 */
import type { KolTx, KolTier, KolDiscoveryScore } from './types';

export interface KolScoringConfig {
  /** 조회 창 (ms). 기본 24h. 더 오래된 tx 는 score 에 포함 안 함 */
  windowMs: number;
  /** Anti-correlation 창 (ms). 기본 60s (REFACTORING §2.5) */
  antiCorrelationMs: number;
  /** Tier 가중치 */
  tierWeights: Record<KolTier, number>;
  /** 시간 감쇠 반감기 (hours). 기본 6h */
  timeDecayHalfLifeHours: number;
  /** 합의 보너스 계산 */
  consensusBonus: {
    single: number;   // 1명
    small: number;    // 2-4명
    large: number;    // 5명+
  };
}

export const DEFAULT_KOL_SCORING_CONFIG: KolScoringConfig = {
  windowMs: 24 * 60 * 60 * 1000,
  antiCorrelationMs: 60_000,
  tierWeights: { S: 3.0, A: 1.0, B: 0.5 },
  timeDecayHalfLifeHours: 6,
  consensusBonus: { single: 1.0, small: 3.0, large: 10.0 },
};

/**
 * 특정 tokenMint 에 대한 KOL Discovery score 계산.
 *
 * @param tokenMint 대상 token
 * @param recentKolTxs 최근 KOL tx feed (모든 토큰/KOL 섞여서 넘어와도 됨 — 내부에서 필터)
 * @param nowMs 현재 시점 (테스트 주입용, 기본 Date.now())
 * @param config scoring config override
 */
export function computeKolDiscoveryScore(
  tokenMint: string,
  recentKolTxs: KolTx[],
  nowMs: number = Date.now(),
  config: Partial<KolScoringConfig> = {}
): KolDiscoveryScore {
  const cfg = { ...DEFAULT_KOL_SCORING_CONFIG, ...config };

  // 1. 대상 token 의 buy 만 필터 (sell 은 exit signal 로 취급 — 본 score 에 미포함)
  const windowStart = nowMs - cfg.windowMs;
  const filtered = recentKolTxs.filter(
    (tx) =>
      tx.tokenMint === tokenMint &&
      tx.action === 'buy' &&
      tx.timestamp >= windowStart &&
      tx.timestamp <= nowMs
  );

  if (filtered.length === 0) {
    return emptyScore(tokenMint, nowMs);
  }

  // 2. kolId 중복 제거 (동일 인물의 multi-wallet 은 1명으로 간주)
  const perKolEarliest = new Map<string, KolTx>();
  for (const tx of filtered) {
    const existing = perKolEarliest.get(tx.kolId);
    if (!existing || tx.timestamp < existing.timestamp) {
      perKolEarliest.set(tx.kolId, tx);
    }
  }
  const perKolSorted = [...perKolEarliest.values()].sort((a, b) => a.timestamp - b.timestamp);

  // 3. Anti-correlation: 60s 내 연속 진입 = chain forward 의심 → 이전 KOL 만 유지
  const independent: KolTx[] = [];
  for (const tx of perKolSorted) {
    const last = independent[independent.length - 1];
    if (!last || tx.timestamp - last.timestamp >= cfg.antiCorrelationMs) {
      independent.push(tx);
    }
    // 60s 내면 skip (chain forward 로 가정)
  }

  if (independent.length === 0) {
    return emptyScore(tokenMint, nowMs);
  }

  // 4. Tier 가중치 합
  const weightedScore = independent.reduce(
    (sum, tx) => sum + (cfg.tierWeights[tx.tier] ?? 0),
    0
  );

  // 5. 합의 보너스
  const count = independent.length;
  const consensusBonus =
    count === 1 ? cfg.consensusBonus.single
    : count <= 4 ? cfg.consensusBonus.small
    : cfg.consensusBonus.large;

  // 6. 시간 감쇠 (첫 KOL 진입 이후 경과 시간 기준)
  const firstEntryMs = independent[0].timestamp;
  const hoursElapsed = Math.max(0, (nowMs - firstEntryMs) / (60 * 60 * 1000));
  const timeDecay = Math.pow(0.5, hoursElapsed / cfg.timeDecayHalfLifeHours);

  const finalScore = (weightedScore + consensusBonus) * timeDecay;

  return {
    tokenMint,
    independentKolCount: independent.length,
    participatingKols: independent.map((tx) => ({
      id: tx.kolId,
      tier: tx.tier,
      timestamp: tx.timestamp,
    })),
    weightedScore,
    consensusBonus,
    timeDecay,
    finalScore,
    firstEntryMs,
  };
}

function emptyScore(tokenMint: string, nowMs: number): KolDiscoveryScore {
  return {
    tokenMint,
    independentKolCount: 0,
    participatingKols: [],
    weightedScore: 0,
    consensusBonus: 0,
    timeDecay: 0,
    finalScore: 0,
    firstEntryMs: nowMs,
  };
}
