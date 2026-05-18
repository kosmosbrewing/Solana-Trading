import {
  evaluateMissionCapitalGuard,
  missionSoftKillLineSol,
} from '../src/risk/missionCapitalGuard';

describe('missionCapitalGuard', () => {
  it('derives the mission soft-kill line from the operator hard floor', () => {
    expect(missionSoftKillLineSol(0.6)).toBeCloseTo(0.68, 6);
    expect(missionSoftKillLineSol(0.7)).toBeCloseTo(0.78, 6);
  });

  it('recommends shadow-only funded policy inside the soft-kill buffer', () => {
    const result = evaluateMissionCapitalGuard(0.68, 0.6);

    expect(result.softKillActive).toBe(true);
    expect(result.fundedLivePolicy).toBe('SHADOW_ONLY_RECOMMENDED');
    expect(result.reason).toContain('soft-kill line');
  });

  it('keeps funded live eligible above the soft-kill line', () => {
    const result = evaluateMissionCapitalGuard(0.681, 0.6);

    expect(result.softKillActive).toBe(false);
    expect(result.fundedLivePolicy).toBe('FUNDED_LIVE_OK');
  });
});
