/**
 * Lane Edge Statistics — Kelly Controller P1 (2026-04-26)
 *
 * ADR: docs/design-docs/lane-edge-controller-kelly-2026-04-25.md §7
 *
 * Pure functions — no I/O, deterministic given seed.
 *
 * 핵심 contracts:
 *  - Wilson score lower confidence bound for win_rate (95% CI default)
 *  - Bootstrap p10 for reward/risk (deterministic via seeded PRNG)
 *  - Conservative Kelly = max(0, p_lcb - (1 - p_lcb) / rr_p10)
 *
 * Why pure: 단위 테스트 정확도. mathematical correctness 검증 가능.
 */

// ─── Wilson Score Lower Confidence Bound ───

/**
 * Wilson score interval lower bound for binomial proportion.
 *
 * @param wins   성공 횟수
 * @param n      전체 시행
 * @param zScore default 1.96 (95% CI). 보수적으로 가려면 2.33 (98%) 또는 2.58 (99%).
 *
 * Why Wilson over Normal approximation:
 *  - 작은 표본 (n < 50) 에서도 안정적
 *  - 0/n, n/n 경계 안전 (Normal approx 는 변동성 0 → 0 LCB 오류)
 *
 * Reference: Wilson EB. Probable Inference, the Law of Succession, and
 *   Statistical Inference. JASA 1927.
 */
export function wilsonLowerBound(wins: number, n: number, zScore: number = 1.96): number {
  if (n <= 0) return 0;
  if (wins < 0) return 0;
  if (wins > n) return 0;
  const p = wins / n;
  const z2 = zScore * zScore;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = zScore * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)));
  return Math.max(0, (center - margin) / denom);
}

// ─── Bootstrap percentile ───

/**
 * Mulberry32 PRNG — deterministic with given seed (테스트 재현성).
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap p10 of reward/risk ratio.
 *
 * Reward/risk = avg(wins) / |avg(losses)| 의 lower bound.
 * Bootstrap 으로 신뢰구간 p10 (보수적) 추정.
 *
 * @param wins  positive returns (per-trade SOL pnl, > 0)
 * @param losses negative returns (per-trade SOL pnl, < 0)
 * @param iterations 기본 1000
 * @param seed deterministic 재현 — 기본 42
 * @param zeroLossRrCap avgLoss=0 일 때 RR 무한대 방어 cap. 기본 100 (Kelly 가 1 으로 clamp 되므로
 *   실질 영향 없음). QA F2/F7: magic number 제거를 위해 config 노출.
 * @returns RR 의 p10. 입력 부족 시 0 반환 (보수적).
 */
export function bootstrapRewardRiskP10(
  wins: number[],
  losses: number[],
  iterations: number = 1000,
  seed: number = 42,
  zeroLossRrCap: number = 100
): number {
  if (wins.length === 0 || losses.length === 0) return 0;
  const rng = mulberry32(seed);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let winSum = 0;
    for (let j = 0; j < wins.length; j += 1) {
      const idx = Math.floor(rng() * wins.length);
      winSum += wins[idx];
    }
    let lossSum = 0;
    for (let j = 0; j < losses.length; j += 1) {
      const idx = Math.floor(rng() * losses.length);
      lossSum += losses[idx];
    }
    const avgWin = winSum / wins.length;
    const avgLoss = Math.abs(lossSum / losses.length);
    if (avgLoss === 0) {
      // 모든 loss 가 0 → RR 무한대 — config cap 으로 sample 화.
      // 보수적으로 100 default (Kelly clamp 1 으로 어차피 saturate).
      samples.push(zeroLossRrCap);
    } else {
      samples.push(avgWin / avgLoss);
    }
  }
  samples.sort((a, b) => a - b);
  const idx = Math.floor(samples.length * 0.10);
  return Math.max(0, samples[idx]);
}

// ─── Conservative Kelly ───

/**
 * Conservative Kelly fraction.
 *
 *   raw_kelly = p - (1 - p) / rr
 *   conservative_kelly = max(0, p_lcb - (1 - p_lcb) / rr_p10)
 *
 * @param pLcb Wilson lower bound of win_rate
 * @param rrP10 bootstrap p10 of reward/risk
 * @returns Kelly fraction in [0, 1]. Negative 은 0 으로 clamp (사명: never increase attempts).
 */
export function conservativeKelly(pLcb: number, rrP10: number): number {
  if (rrP10 <= 0) return 0;
  if (pLcb <= 0) return 0;
  if (pLcb >= 1) return 1; // 100% win → cap at 1 (실제로 발생 불가)
  const k = pLcb - (1 - pLcb) / rrP10;
  return Math.max(0, Math.min(1, k));
}

/**
 * Raw Kelly (information only — production 사용 금지).
 * ADR §11 acceptance: "Reports show raw Kelly and conservative Kelly separately."
 */
export function rawKelly(winRate: number, rewardRisk: number): number {
  if (rewardRisk <= 0) return 0;
  if (winRate <= 0) return 0;
  if (winRate >= 1) return 1;
  return winRate - (1 - winRate) / rewardRisk;
}

// ─── Aggregation helpers ───

export function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return sum(xs) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Max consecutive true streak. */
export function maxStreak<T>(items: T[], predicate: (t: T) => boolean): number {
  let best = 0;
  let cur = 0;
  for (const t of items) {
    if (predicate(t)) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/** Log growth — natural log of wallet ratio. */
export function logGrowth(walletStart: number, walletEnd: number): number {
  if (walletStart <= 0) return 0;
  if (walletEnd <= 0) return -Infinity;
  return Math.log(walletEnd / walletStart);
}
