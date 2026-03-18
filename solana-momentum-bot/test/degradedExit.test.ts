import {
  checkDegradedCondition,
  isDegraded,
  degradedStateMap,
  quoteFailCountMap,
} from '../src/orchestration/tradeExecution';

// Why: config.ts가 required env vars를 체크하므로 mock
jest.mock('../src/utils/config', () => ({
  config: {
    degradedExitEnabled: true,
    degradedSellImpactThreshold: 0.05,
    degradedQuoteFailLimit: 3,
    degradedPartialPct: 0.25,
    degradedDelayMs: 300_000,
  },
}));

describe('Degraded Exit', () => {
  beforeEach(() => {
    degradedStateMap.clear();
    quoteFailCountMap.clear();
  });

  it('triggers on high sell impact (> 5%)', () => {
    const result = checkDegradedCondition('trade-1', 0.06, true);
    expect(result).toBe(true);
  });

  it('does not trigger on normal sell impact', () => {
    const result = checkDegradedCondition('trade-2', 0.03, true);
    expect(result).toBe(false);
  });

  it('triggers on 3 consecutive quote failures', () => {
    expect(checkDegradedCondition('trade-3', null, false)).toBe(false); // 1
    expect(checkDegradedCondition('trade-3', null, false)).toBe(false); // 2
    expect(checkDegradedCondition('trade-3', null, false)).toBe(true);  // 3 → trigger
  });

  it('resets quote fail count on success', () => {
    checkDegradedCondition('trade-4', null, false); // 1
    checkDegradedCondition('trade-4', null, false); // 2
    checkDegradedCondition('trade-4', null, true);  // reset
    expect(checkDegradedCondition('trade-4', null, false)).toBe(false); // 1 again
  });

  it('isDegraded returns false for non-triggered trades', () => {
    expect(isDegraded('unknown')).toBe(false);
    // 1회 실패로는 degraded가 아님 (quoteFailLimit=3)
    checkDegradedCondition('trade-5', null, false);
    expect(isDegraded('trade-5')).toBe(false);
  });

  it('isDegraded returns true only after actual trigger', () => {
    // degradedStateMap에 직접 추가해야 isDegraded=true (phase 1 완료 상태)
    degradedStateMap.set('trade-x', { partialSoldAt: new Date(), pairAddress: 'pair-x' });
    expect(isDegraded('trade-x')).toBe(true);
    expect(isDegraded('trade-y')).toBe(false);
  });

  it('does not trigger when sell impact is null and quotes succeed', () => {
    const result = checkDegradedCondition('trade-6', null, true);
    expect(result).toBe(false);
  });

  it('returns true for already-degraded trades without re-evaluation', () => {
    degradedStateMap.set('trade-7', { partialSoldAt: new Date(), pairAddress: 'pair-7' });
    // 이미 degraded → impact 낮아도 true 반환
    const result = checkDegradedCondition('trade-7', 0.01, true);
    expect(result).toBe(true);
  });
});
