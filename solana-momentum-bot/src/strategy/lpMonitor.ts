export type LpStability = 'stable' | 'unstable' | 'dropping';

/**
 * LP 안정성 판정
 */
export function assessLpStability(
  currentTvl: number,
  previousTvl: number
): LpStability {
  if (previousTvl <= 0) return 'stable';

  const changePct = (currentTvl - previousTvl) / previousTvl;

  if (changePct <= -0.20) return 'dropping';
  if (changePct <= -0.10 || changePct >= 0.30) return 'unstable';
  return 'stable';
}
