export type LpStability = 'stable' | 'unstable' | 'dropping';

export interface LpAlert {
  type: 'LP_ADD_ALERT' | 'LP_REMOVE_ALERT';
  changePct: number;
  detail: string;
}

/**
 * LP 유동성 변동 감지
 *
 * @param currentTvl  현재 TVL
 * @param previousTvl 5분 전 TVL
 * @returns LP 알림 (null = 변동 없음)
 */
export function checkLpChange(
  currentTvl: number,
  previousTvl: number
): LpAlert | null {
  if (previousTvl <= 0) return null;

  const changePct = (currentTvl - previousTvl) / previousTvl;

  // LP 급증 (+15% 이상)
  if (changePct >= 0.15) {
    return {
      type: 'LP_ADD_ALERT',
      changePct,
      detail: `TVL increased ${(changePct * 100).toFixed(1)}% ($${previousTvl.toFixed(0)} → $${currentTvl.toFixed(0)})`,
    };
  }

  // LP 급감 (-20% 이상)
  if (changePct <= -0.20) {
    return {
      type: 'LP_REMOVE_ALERT',
      changePct,
      detail: `TVL decreased ${(changePct * 100).toFixed(1)}% ($${previousTvl.toFixed(0)} → $${currentTvl.toFixed(0)})`,
    };
  }

  return null;
}

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
