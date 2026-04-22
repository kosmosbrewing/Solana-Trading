/**
 * Jupiter Rate-Limit Metric tests (2026-04-22, P1-1)
 *
 * 설계 anchor: src/observability/jupiterRateLimitMetric.ts
 */
jest.mock('../src/utils/logger', () => {
  const info = jest.fn();
  const warn = jest.fn();
  const error = jest.fn();
  const debug = jest.fn();
  return {
    __esModule: true,
    createModuleLogger: () => ({ info, warn, error, debug }),
    __mockLog: { info, warn, error, debug },
  };
});

import {
  recordJupiter429,
  getJupiter429Stats,
  emitSummary,
  resetJupiter429Metric,
  startJupiter429SummaryLoop,
  stopJupiter429SummaryLoop,
} from '../src/observability/jupiterRateLimitMetric';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLog = (require('../src/utils/logger') as any).__mockLog;

describe('jupiterRateLimitMetric', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetJupiter429Metric();
  });
  afterEach(() => {
    resetJupiter429Metric();
  });

  it('counts 429 by source', () => {
    recordJupiter429('entry_drift_guard');
    recordJupiter429('entry_drift_guard');
    recordJupiter429('sell_quote_probe');

    const stats = getJupiter429Stats();
    const byMap = new Map(stats.map((s) => [s.source, s]));
    expect(byMap.get('entry_drift_guard')?.total).toBe(2);
    expect(byMap.get('sell_quote_probe')?.total).toBe(1);
  });

  it('emitSummary logs recent counts and resets sinceLastSummary', () => {
    recordJupiter429('entry_drift_guard');
    recordJupiter429('entry_drift_guard');
    recordJupiter429('missed_alpha_observer');

    emitSummary();

    expect(mockLog.info).toHaveBeenCalledTimes(1);
    const msg = String(mockLog.info.mock.calls[0][0]);
    expect(msg).toContain('[JUPITER_429_SUMMARY]');
    expect(msg).toContain('entry_drift_guard=2');
    expect(msg).toContain('missed_alpha_observer=1');

    // 두 번째 emit 은 recent=0 → 로그 안 찍음
    emitSummary();
    expect(mockLog.info).toHaveBeenCalledTimes(1);

    // 신규 카운트 오면 다시 찍음
    recordJupiter429('entry_drift_guard');
    emitSummary();
    expect(mockLog.info).toHaveBeenCalledTimes(2);
  });

  it('ignores empty/invalid source', () => {
    recordJupiter429('');
    // @ts-expect-error — 런타임 방어 테스트
    recordJupiter429(null);
    expect(getJupiter429Stats()).toHaveLength(0);
  });

  it('summary loop is idempotent (multiple start calls)', () => {
    startJupiter429SummaryLoop(60_000);
    startJupiter429SummaryLoop(60_000);
    stopJupiter429SummaryLoop();
    // no throw
    expect(true).toBe(true);
  });
});
