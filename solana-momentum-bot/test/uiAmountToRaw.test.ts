/**
 * uiAmountToRaw helper (2026-04-21, QA L2).
 * Why: Math.floor(ui * 10^decimals) 는 decimals=18 + large ui 에서 2^53 초과 → 정밀 손실.
 * string toFixed + BigInt 로 우회.
 */
import { uiAmountToRaw } from '../src/orchestration/pureWsBreakoutHandler';

describe('uiAmountToRaw', () => {
  it('converts common UI amount (decimals=6) exactly', () => {
    // 100.5 × 10^6 = 100_500_000
    expect(uiAmountToRaw(100.5, 6)).toBe(100_500_000n);
  });

  it('handles decimals=9 (SOL-like) precisely', () => {
    // 0.01 × 10^9 = 10_000_000
    expect(uiAmountToRaw(0.01, 9)).toBe(10_000_000n);
  });

  it('[2026-04-21 QA L2] decimals=18 + large quantity preserves precision beyond 2^53', () => {
    // 1_000_000 × 10^18 = 1e24 — Math.pow(10,18) 곱하면 Number precision 깨짐.
    // BigInt 경로는 정확.
    const raw = uiAmountToRaw(1_000_000, 18);
    expect(raw).toBe(10n ** 24n); // = 1_000_000 × 10^18
  });

  it('[2026-04-21 QA L2] decimals=18 + fractional part (0.5) handled exactly', () => {
    // 1.5 × 10^18 = 1_500_000_000_000_000_000
    expect(uiAmountToRaw(1.5, 18)).toBe(1_500_000_000_000_000_000n);
  });

  it('returns 0n for invalid inputs', () => {
    expect(uiAmountToRaw(0, 6)).toBe(0n);
    expect(uiAmountToRaw(-1, 6)).toBe(0n);
    expect(uiAmountToRaw(NaN, 6)).toBe(0n);
    expect(uiAmountToRaw(Infinity, 6)).toBe(0n);
    expect(uiAmountToRaw(1, -1)).toBe(0n);
    expect(uiAmountToRaw(1, 19)).toBe(0n);
    // 과학 표기 범위 (1e21+) 는 invalid
    expect(uiAmountToRaw(1e21, 6)).toBe(0n);
  });

  it('decimals=0 returns integer raw', () => {
    expect(uiAmountToRaw(42, 0)).toBe(42n);
    expect(uiAmountToRaw(42.7, 0)).toBe(43n); // toFixed(0) rounds
  });
});
