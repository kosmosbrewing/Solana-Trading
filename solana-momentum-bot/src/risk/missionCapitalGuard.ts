export const MISSION_SOFT_KILL_BUFFER_SOL = 0.08;

export type MissionFundedLivePolicy =
  | 'FUNDED_LIVE_OK'
  | 'SHADOW_ONLY_RECOMMENDED'
  | 'BALANCE_UNKNOWN';

export interface MissionCapitalGuardResult {
  balanceKnown: boolean;
  walletSol: number | null;
  walletFloorSol: number;
  softKillBufferSol: number;
  softKillLineSol: number;
  softKillActive: boolean;
  fundedLivePolicy: MissionFundedLivePolicy;
  reason: string;
}

export function missionSoftKillLineSol(
  walletFloorSol: number,
  softKillBufferSol = MISSION_SOFT_KILL_BUFFER_SOL
): number {
  const floor = Number.isFinite(walletFloorSol) ? walletFloorSol : 0;
  const buffer = Number.isFinite(softKillBufferSol) ? softKillBufferSol : MISSION_SOFT_KILL_BUFFER_SOL;
  return floor + Math.max(0, buffer);
}

export function evaluateMissionCapitalGuard(
  walletSol: number | null | undefined,
  walletFloorSol: number,
  softKillBufferSol = MISSION_SOFT_KILL_BUFFER_SOL
): MissionCapitalGuardResult {
  const balanceKnown = typeof walletSol === 'number' && Number.isFinite(walletSol);
  const softKillLineSol = missionSoftKillLineSol(walletFloorSol, softKillBufferSol);
  if (!balanceKnown) {
    return {
      balanceKnown: false,
      walletSol: null,
      walletFloorSol,
      softKillBufferSol,
      softKillLineSol,
      softKillActive: false,
      fundedLivePolicy: 'BALANCE_UNKNOWN',
      reason: 'wallet balance is unknown; keep existing hard guards in charge',
    };
  }

  const softKillActive = walletSol <= softKillLineSol + 1e-9;
  return {
    balanceKnown: true,
    walletSol,
    walletFloorSol,
    softKillBufferSol,
    softKillLineSol,
    softKillActive,
    fundedLivePolicy: softKillActive ? 'SHADOW_ONLY_RECOMMENDED' : 'FUNDED_LIVE_OK',
    reason: softKillActive
      ? `wallet ${walletSol.toFixed(4)} <= soft-kill line ${softKillLineSol.toFixed(4)}`
      : `wallet ${walletSol.toFixed(4)} > soft-kill line ${softKillLineSol.toFixed(4)}`,
  };
}
