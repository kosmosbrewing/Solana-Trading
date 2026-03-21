import { checkTokenSafety, SafetyGateThresholds, AgeBucketTier, LiquidityTier } from '../src/gate/safetyGate';
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

describe('SafetyGate — Age Bucket Graduated Sizing (v4 configurable)', () => {
  it('rejects tokens below hard floor (default 15min)', () => {
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 10 / 60 }), // 10 min
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('hard floor');
  });

  it('applies 0.25x for tokens in tier 1 (15min ~ 1h, default)', () => {
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 0.5 }), // 30 min
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(0.25, 6);
    expect(result.appliedAdjustments).toContain('AGE_BUCKET_LT1H_25PCT');
  });

  it('applies 0.5x for tokens in tier 2 (1h ~ 4h, default)', () => {
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 2 }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(0.5, 6);
    expect(result.appliedAdjustments).toContain('AGE_BUCKET_LT4H_50PCT');
  });

  it('applies 0.75x for tokens in tier 3 (4h ~ 24h, default)', () => {
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 12 }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(0.75, 6);
    expect(result.appliedAdjustments).toContain('AGE_BUCKET_LT24H_75PCT');
  });

  it('applies 1.0x for tokens >= last tier (default >= 24h)', () => {
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 48 }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(1.0, 6);
    expect(result.appliedAdjustments).toHaveLength(0);
  });

  it('stacks age bucket with LP/ownership penalties', () => {
    // age 30min → tier1 0.25x + LP not burned (0.5x) + ownership not renounced (0.5x) = 0.0625x
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 0.5, lpBurned: false, ownershipRenounced: false }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(0.0625, 6);
    expect(result.appliedAdjustments).toContain('AGE_BUCKET_LT1H_25PCT');
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

  // v4: 커스텀 구간 테스트
  it('uses custom hard floor and tiers when provided', () => {
    const customThresholds: SafetyGateThresholds = {
      ...BASE_THRESHOLDS,
      ageBucketHardFloorMin: 30,
      ageBucketTiers: [
        { upperHours: 2, multiplier: 0.3 },
        { upperHours: 12, multiplier: 0.6 },
      ],
    };

    // 25min → reject (custom floor = 30min)
    const tooNew = checkTokenSafety(makeSafety({ tokenAgeHours: 25 / 60 }), customThresholds);
    expect(tooNew.approved).toBe(false);

    // 1h → tier1 0.3x
    const tier1 = checkTokenSafety(makeSafety({ tokenAgeHours: 1 }), customThresholds);
    expect(tier1.approved).toBe(true);
    expect(tier1.sizeMultiplier).toBeCloseTo(0.3, 6);

    // 6h → tier2 0.6x
    const tier2 = checkTokenSafety(makeSafety({ tokenAgeHours: 6 }), customThresholds);
    expect(tier2.approved).toBe(true);
    expect(tier2.sizeMultiplier).toBeCloseTo(0.6, 6);

    // 13h → beyond last tier → 1.0x
    const full = checkTokenSafety(makeSafety({ tokenAgeHours: 13 }), customThresholds);
    expect(full.approved).toBe(true);
    expect(full.sizeMultiplier).toBeCloseTo(1.0, 6);
  });

  // v4 Step 5A: 동적 TVL 최소 기준
  it('raises minPoolLiquidity based on equity tiers', () => {
    const liquidityTiers: LiquidityTier[] = [
      { minEquitySol: 5, minPoolLiquidity: 100_000 },
      { minEquitySol: 20, minPoolLiquidity: 200_000 },
    ];

    // equitySol=3 → base 50K 적용
    const small = checkTokenSafety(
      makeSafety({ poolLiquidity: 60_000 }),
      { ...BASE_THRESHOLDS, equitySol: 3, liquidityTiers }
    );
    expect(small.approved).toBe(true);

    // equitySol=10 → tier1 100K 적용 → 60K 거부
    const mid = checkTokenSafety(
      makeSafety({ poolLiquidity: 60_000 }),
      { ...BASE_THRESHOLDS, equitySol: 10, liquidityTiers }
    );
    expect(mid.approved).toBe(false);
    expect(mid.reason).toContain('Pool liquidity too low');

    // equitySol=10, 110K → 통과
    const midOk = checkTokenSafety(
      makeSafety({ poolLiquidity: 110_000 }),
      { ...BASE_THRESHOLDS, equitySol: 10, liquidityTiers }
    );
    expect(midOk.approved).toBe(true);

    // equitySol=25 → tier2 200K 적용 → 150K 거부
    const large = checkTokenSafety(
      makeSafety({ poolLiquidity: 150_000 }),
      { ...BASE_THRESHOLDS, equitySol: 25, liquidityTiers }
    );
    expect(large.approved).toBe(false);
  });

  // null 케이스: GeckoTerminal/DexScreener 데이터 미제공 시 패널티 없음
  it('applies no penalty when lpBurned is null (data unavailable)', () => {
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 48, lpBurned: null, ownershipRenounced: null }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(1.0, 6);
    expect(result.appliedAdjustments).not.toContain('LP_NOT_BURNED_HALF');
    expect(result.appliedAdjustments).not.toContain('OWNERSHIP_NOT_RENOUNCED_HALF');
  });

  it('stacks penalty correctly when one field is null and other is false', () => {
    // lpBurned: null (no penalty) + ownershipRenounced: false (0.5x) = 0.5x
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 48, lpBurned: null, ownershipRenounced: false }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(0.5, 6);
    expect(result.appliedAdjustments).not.toContain('LP_NOT_BURNED_HALF');
    expect(result.appliedAdjustments).toContain('OWNERSHIP_NOT_RENOUNCED_HALF');
  });

  it('applies full penalty when both fields are explicitly false', () => {
    const result = checkTokenSafety(
      makeSafety({ tokenAgeHours: 48, lpBurned: false, ownershipRenounced: false }),
      BASE_THRESHOLDS
    );
    expect(result.approved).toBe(true);
    expect(result.sizeMultiplier).toBeCloseTo(0.25, 6);
    expect(result.appliedAdjustments).toContain('LP_NOT_BURNED_HALF');
    expect(result.appliedAdjustments).toContain('OWNERSHIP_NOT_RENOUNCED_HALF');
  });
});
