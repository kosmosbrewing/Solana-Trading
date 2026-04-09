import { bpsToDecimal, decimalToBps, BPS_DENOMINATOR, BPS_DENOMINATOR_BIGINT } from '../src/utils/units';

describe('bps ↔ decimal conversions', () => {
  it('decimalToBps rounds to nearest integer', () => {
    expect(decimalToBps(0.005)).toBe(50);
    expect(decimalToBps(0.0055)).toBe(55);
    expect(decimalToBps(0.01)).toBe(100);
    expect(decimalToBps(0)).toBe(0);
  });

  it('bpsToDecimal returns fraction', () => {
    expect(bpsToDecimal(50)).toBeCloseTo(0.005, 10);
    expect(bpsToDecimal(100)).toBeCloseTo(0.01, 10);
    expect(bpsToDecimal(0)).toBe(0);
  });

  it('preserves sign through conversions', () => {
    // 2026-04-08 P0-M4: negative slippage = favorable fill convention.
    // Jupiter quote safety margin 으로 actualOut > expectedOut 인 경우 -bps 로 기록됨.
    expect(decimalToBps(-0.0055)).toBe(-55);
    expect(bpsToDecimal(-55)).toBeCloseTo(-0.0055, 10);
    expect(decimalToBps(bpsToDecimal(-68))).toBe(-68);
    expect(decimalToBps(bpsToDecimal(100))).toBe(100);
  });

  it('exposes BPS_DENOMINATOR constants', () => {
    expect(BPS_DENOMINATOR).toBe(10_000);
    expect(BPS_DENOMINATOR_BIGINT).toBe(10_000n);
  });
});

describe('executor slippage sign convention (static documentation)', () => {
  // Why: executor.ts 의 actualSlippageBps 공식 재현 테스트.
  // 공식: slippage = (expectedOut - actualOut) / expectedOut
  // - positive: actualOut < expectedOut → 불리한 fill (유저가 적게 받음)
  // - negative: actualOut > expectedOut → 유리한 fill (Jupiter quote 이상으로 받음)
  function computeSlippageBps(expectedOut: bigint, actualOut: bigint): number {
    if (expectedOut <= 0n) return 0;
    return Number((expectedOut - actualOut) * BPS_DENOMINATOR_BIGINT / expectedOut);
  }

  it('returns positive bps when actualOut < expectedOut (unfavorable)', () => {
    expect(computeSlippageBps(10_000n, 9_950n)).toBe(50);  // 0.5% under
    expect(computeSlippageBps(10_000n, 9_000n)).toBe(1000); // 10% under
  });

  it('returns zero when actualOut == expectedOut', () => {
    expect(computeSlippageBps(10_000n, 10_000n)).toBe(0);
  });

  it('returns negative bps when actualOut > expectedOut (favorable, matches live -55bps case)', () => {
    // Trade report 의 RISE row 2 케이스: exit_slip=-55bps → Jupiter expected 9945, actual 10000
    // 또는 유사 favorable fill. Jupiter quote safety buffer 로 빈번히 발생.
    expect(computeSlippageBps(10_000n, 10_055n)).toBe(-55);
    expect(computeSlippageBps(10_000n, 10_068n)).toBe(-68);
    expect(computeSlippageBps(10_000n, 11_000n)).toBe(-1000);
  });
});
