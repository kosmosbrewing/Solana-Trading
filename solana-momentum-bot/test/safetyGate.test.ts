import { checkTokenSafety, SafetyGateThresholds } from '../src/gate/safetyGate';
import { TokenSafety } from '../src/utils/types';

const BASE_THRESHOLDS: SafetyGateThresholds = {
  minPoolLiquidity: 50_000,
  minTokenAgeHours: 24,
  maxHolderConcentration: 0.80,
  enableAgeBuckets: true,
};

function makeSafety(overrides: Partial<TokenSafety> = {}): TokenSafety {
  return {
    poolLiquidity: 100_000,
    tokenAgeHours: 48,
    lpBurned: true,
    ownershipRenounced: true,
    top10HolderPct: 0.30,
    ...overrides,
  };
}

describe('SafetyGate — Age Bucket Graduated Sizing', () => {
  it('rejects tokens < 20 minutes old', () => {
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 10 / 60 }), // 10 min
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('< 20min');
  });

  it('applies 0.25x for tokens 20min ~ 2h old', () => {
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 1 }), // 60 min
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(0.25, 6);
    expect(result.appliedAdjustments).toContain('AGE_BUCKET_20MIN_2H_25PCT');
  });

  it('applies 0.5x for tokens 2h ~ 24h old', () => {
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 12 }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(0.5, 6);
    expect(result.appliedAdjustments).toContain('AGE_BUCKET_2H_24H_50PCT');
  });

  it('applies 1.0x for tokens >= 24h old', () => {
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 48 }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(1.0, 6);
    expect(result.appliedAdjustments).toHaveLength(0);
  });

  it('stacks age bucket with LP/ownership penalties', () => {
    // age 1h (0.25x) + LP not burned (0.5x) + ownership not renounced (0.5x) = 0.0625x
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 1, lpBurned: false, ownershipRenounced: false }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(0.0625, 6);
    expect(result.appliedAdjustments).toContain('AGE_BUCKET_20MIN_2H_25PCT');
    expect(result.appliedAdjustments).toContain('LP_NOT_BURNED_HALF');
    expect(result.appliedAdjustments).toContain('OWNERSHIP_NOT_RENOUNCED_HALF');
  });

  it('falls back to binary reject when enableAgeBuckets=false', () => {
    const thresholds = { ...BASE_THRESHOLDS, enableAgeBuckets: false };

    const tooNew = checkTokenSafety(makeSafety({ tokenAgeHours: 12 }), thresholds);
    expect(tooNew.approved).toBe(false);
    expect(tooNew.reason).toContain('Token too new');

    const oldEnough = checkTokenSafety(makeSafety({ tokenAgeHours: 25 }), thresholds);
    expect(oldEnough.approved).toBe(true);
  });

  it('rejects low liquidity regardless of age', () => {
    const result = checkTokenSafety(
      makeSafety({ poolLiquidity: 10_000 }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Pool liquidity too low');
  });

  it('rejects high holder concentration', () => {
    const result = checkTokenSafety(
      makeSafety({ top10HolderPct: 0.90 }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Holder concentration too high');
  });
});
