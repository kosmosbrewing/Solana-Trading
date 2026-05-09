import {
  evaluateCapitulationReboundPolicy,
  isCapitulationHardVetoFlag,
  type CapitulationReboundPolicyConfig,
} from '../src/orchestration/capitulationRebound/policy';

const baseConfig: CapitulationReboundPolicyConfig = {
  enabled: true,
  paperEnabled: true,
  minKolScore: 4.5,
  minDrawdownPct: 0.35,
  maxDrawdownPct: 0.65,
  minBouncePct: 0.06,
  requiredRecoveryConfirmations: 2,
  maxRecentSellSol: 0,
  maxRecentSellKols: 0,
};

describe('capitulation rebound policy', () => {
  it('hard-vetoes structural and quality risk flags before rebound scoring', () => {
    expect(isCapitulationHardVetoFlag('EXIT_LIQUIDITY_UNKNOWN')).toBe(true);
    expect(isCapitulationHardVetoFlag('HOLDER_HHI_HIGH')).toBe(true);
    expect(isCapitulationHardVetoFlag('SMART_V3_FRESH_KOLS_2')).toBe(false);

    const decision = evaluateCapitulationReboundPolicy({
      alreadyEntered: false,
      currentPrice: 0.65,
      peakPrice: 1,
      lowPrice: 0.55,
      kolScore: 6,
      preEntrySellSol: 0,
      preEntrySellKols: 0,
      recoveryConfirmations: 2,
      survivalFlags: ['EXIT_LIQUIDITY_UNKNOWN'],
      config: baseConfig,
    });

    expect(decision.triggered).toBe(false);
    expect(decision.reason).toBe('hard_veto');
    expect(decision.flags).toContain('CAPITULATION_HARD_VETO');
  });

  it('requires drawdown, bounce, and repeated recovery confirmations', () => {
    const unconfirmed = evaluateCapitulationReboundPolicy({
      alreadyEntered: false,
      currentPrice: 0.58,
      peakPrice: 1,
      lowPrice: 0.55,
      kolScore: 6,
      preEntrySellSol: 0,
      preEntrySellKols: 0,
      recoveryConfirmations: 1,
      survivalFlags: [],
      config: baseConfig,
    });

    expect(unconfirmed.triggered).toBe(false);
    expect(unconfirmed.reason).toBe('bounce_not_confirmed');

    const confirmed = evaluateCapitulationReboundPolicy({
      alreadyEntered: false,
      currentPrice: 0.60,
      peakPrice: 1,
      lowPrice: 0.55,
      kolScore: 6,
      preEntrySellSol: 0,
      preEntrySellKols: 0,
      recoveryConfirmations: 2,
      survivalFlags: [],
      config: baseConfig,
    });

    expect(confirmed.triggered).toBe(true);
    expect(confirmed.reason).toBe('triggered');
    expect(confirmed.telemetry.drawdownFromPeakPct).toBeCloseTo(0.45);
    expect(confirmed.telemetry.bounceFromLowPct).toBeCloseTo(0.0909, 3);
  });

  it('rejects sell-wave rebounds as distribution rather than liquidity shock', () => {
    const decision = evaluateCapitulationReboundPolicy({
      alreadyEntered: false,
      currentPrice: 0.60,
      peakPrice: 1,
      lowPrice: 0.55,
      kolScore: 6,
      preEntrySellSol: 0.5,
      preEntrySellKols: 1,
      recoveryConfirmations: 2,
      survivalFlags: [],
      config: baseConfig,
    });

    expect(decision.triggered).toBe(false);
    expect(decision.reason).toBe('sell_wave');
    expect(decision.flags).toContain('CAPITULATION_SELL_WAVE');
  });
});
