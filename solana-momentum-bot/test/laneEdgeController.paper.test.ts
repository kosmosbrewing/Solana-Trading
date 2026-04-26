/**
 * Lane Edge Controller tests — Kelly Controller P1 (2026-04-26)
 *
 * Acceptance criteria (ADR §11):
 *  - kellyEligible=false 는 자동 제외
 *  - paperOnly outcome 은 P0 에서 false → 자동 제외
 *  - n < 30: display_only
 *  - n < 50: preliminary, throttle 미반영
 *  - 50 ≤ n < 100 + expectancy ≤ 0: paper_only
 *  - n ≥ 100 + consK ≤ 0: throttle / quarantine
 *  - n ≥ 100 + consK > 0: keep
 *  - wallet_drift_halt: 모든 cohort halted, Kelly=0
 *  - ticket_cap_sol 항상 lane hard lock 으로 clip
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  buildCohortKeyFromRecord,
  cohortKeyToString,
  groupByCohort,
  computeCohortMetrics,
  deriveControlOutput,
  buildControllerReport,
  DEFAULT_CONTROLLER_CONFIG,
} from '../src/risk/paper/laneEdgeController';
import type { LaneOutcomeRecord, LaneName } from '../src/risk/laneOutcomeTypes';

function rec(opts: Partial<LaneOutcomeRecord> = {}): LaneOutcomeRecord {
  return {
    positionId: opts.positionId ?? `pos-${Math.random()}`,
    laneName: (opts.laneName ?? 'pure_ws_breakout') as LaneName,
    armName: opts.armName ?? 'default',
    discoverySource: opts.discoverySource,
    spentSol: 0.01,
    receivedSol: 0.012,
    realizedPnlSol: opts.realizedPnlSol ?? 0.002,
    kellyEligible: opts.kellyEligible ?? true,
    reconcileStatus: 'ok',
    matchedBuyId: 'b1',
    matchedSellId: 's1',
    walletTruthSource: 'executed_ledger',
    paperOnly: opts.paperOnly,
    t1VisitAtSec: opts.t1VisitAtSec,
    t2VisitAtSec: opts.t2VisitAtSec,
    t3VisitAtSec: opts.t3VisitAtSec,
    recordedAt: new Date().toISOString(),
  };
}

function many(count: number, opts: (i: number) => Partial<LaneOutcomeRecord>): LaneOutcomeRecord[] {
  const out: LaneOutcomeRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(rec({ positionId: `pos-${i}`, ...opts(i) }));
  }
  return out;
}

describe('cohort key', () => {
  it('laneName × armName × discoverySource', () => {
    const r = rec({ laneName: 'kol_hunter' as LaneName, armName: 'lexapro', discoverySource: 'tier_S' });
    expect(buildCohortKeyFromRecord(r)).toEqual({
      laneName: 'kol_hunter',
      armName: 'lexapro',
      cluster: 'tier_S',
    });
  });

  it('discoverySource 없으면 cluster=na', () => {
    const r = rec({ laneName: 'pure_ws_breakout' as LaneName, armName: 'v2_burst' });
    expect(buildCohortKeyFromRecord(r).cluster).toBe('na');
  });

  it('cohortKeyToString — 3 차원 pipe-delimited', () => {
    expect(cohortKeyToString({ laneName: 'kol_hunter' as LaneName, armName: 'a', cluster: 'b' }))
      .toBe('kol_hunter|a|b');
  });
});

describe('groupByCohort', () => {
  it('kellyEligible=false 자동 제외', () => {
    const records = [
      rec({ laneName: 'kol_hunter' as LaneName, armName: 'a', kellyEligible: true }),
      rec({ laneName: 'kol_hunter' as LaneName, armName: 'a', kellyEligible: false }),
    ];
    const groups = groupByCohort(records);
    const arr = groups.get('kol_hunter|a|na');
    expect(arr).toBeDefined();
    expect(arr).toHaveLength(1);
  });

  it('서로 다른 cohort 는 분리', () => {
    const records = [
      rec({ laneName: 'kol_hunter' as LaneName, armName: 'a' }),
      rec({ laneName: 'kol_hunter' as LaneName, armName: 'b' }),
      rec({ laneName: 'pure_ws_breakout' as LaneName, armName: 'a' }),
    ];
    const groups = groupByCohort(records);
    expect(groups.size).toBe(3);
  });
});

describe('computeCohortMetrics', () => {
  it('5 win + 5 loss 가 정확히 winRate=0.5', () => {
    const records: LaneOutcomeRecord[] = [];
    for (let i = 0; i < 5; i += 1) records.push(rec({ realizedPnlSol: 0.01 }));
    for (let i = 0; i < 5; i += 1) records.push(rec({ realizedPnlSol: -0.005 }));
    const m = computeCohortMetrics(records);
    expect(m.winRate).toBe(0.5);
    expect(m.avgWinSol).toBeCloseTo(0.01, 6);
    expect(m.avgLossSol).toBeCloseTo(0.005, 6);
    expect(m.rewardRisk).toBeCloseTo(2.0, 4);
  });

  it('expectancy = winRate * avgWin - lossRate * avgLoss', () => {
    const records: LaneOutcomeRecord[] = [];
    for (let i = 0; i < 6; i += 1) records.push(rec({ realizedPnlSol: 0.02 }));
    for (let i = 0; i < 4; i += 1) records.push(rec({ realizedPnlSol: -0.01 }));
    const m = computeCohortMetrics(records);
    // 0.6 * 0.02 - 0.4 * 0.01 = 0.012 - 0.004 = 0.008
    expect(m.expectancySol).toBeCloseTo(0.008, 6);
  });

  it('runner_contribution: t2VisitAtSec 있는 trade 의 pnl 합 / total', () => {
    const records = [
      rec({ realizedPnlSol: 0.05, t2VisitAtSec: 100 }),
      rec({ realizedPnlSol: 0.01 }),
      rec({ realizedPnlSol: 0.02 }),
    ];
    const m = computeCohortMetrics(records);
    expect(m.runnerContribution).toBeCloseTo(0.05 / 0.08, 4);
  });

  it('n < 30 → displayOnly=true', () => {
    const records = many(20, () => ({ realizedPnlSol: 0.005 }));
    const m = computeCohortMetrics(records);
    expect(m.displayOnly).toBe(true);
    expect(m.preliminary).toBe(true); // < 50 도 preliminary
  });

  it('30 ≤ n < 50 → preliminary=true, displayOnly=false', () => {
    const records = many(35, () => ({ realizedPnlSol: 0.005 }));
    const m = computeCohortMetrics(records);
    expect(m.preliminary).toBe(true);
    expect(m.displayOnly).toBe(false);
  });

  it('n ≥ 50 → 둘 다 false', () => {
    const records = many(50, () => ({ realizedPnlSol: 0.005 }));
    const m = computeCohortMetrics(records);
    expect(m.preliminary).toBe(false);
    expect(m.displayOnly).toBe(false);
  });
});

describe('deriveControlOutput — 정책 표 (ADR §8)', () => {
  it('walletDriftHaltActive=true → 모든 cohort halted, ticketCap=hardLock', () => {
    const records = many(150, () => ({ realizedPnlSol: 0.005 }));
    const m = computeCohortMetrics(records);
    const out = deriveControlOutput(m, { ...DEFAULT_CONTROLLER_CONFIG, walletDriftHaltActive: true });
    expect(out.entryMode).toBe('halted');
    expect(out.ticketCapSol).toBe(0.01);
    expect(out.maxConcurrent).toBe(0);
    expect(out.reason).toContain('wallet_drift_halt');
  });

  it('n < 30 → display_only', () => {
    const records = many(20, () => ({ realizedPnlSol: 0.005 }));
    const m = computeCohortMetrics(records);
    const out = deriveControlOutput(m);
    expect(out.entryMode).toBe('display_only');
    expect(out.reason).toContain('display only');
  });

  it('30 ≤ n < 50 → display_only (preliminary)', () => {
    const records = many(40, () => ({ realizedPnlSol: 0.005 }));
    const m = computeCohortMetrics(records);
    const out = deriveControlOutput(m);
    expect(out.entryMode).toBe('display_only');
    expect(out.reason).toContain('preliminary');
  });

  it('50 ≤ n < 100 + expectancy ≤ 0 → paper_only', () => {
    const records: LaneOutcomeRecord[] = [];
    for (let i = 0; i < 30; i += 1) records.push(rec({ realizedPnlSol: 0.01 }));
    for (let i = 0; i < 30; i += 1) records.push(rec({ realizedPnlSol: -0.02 })); // big losses
    const m = computeCohortMetrics(records);
    expect(m.expectancySol).toBeLessThanOrEqual(0);
    const out = deriveControlOutput(m);
    expect(out.entryMode).toBe('paper_only');
  });

  it('50 ≤ n < 100 + expectancy > 0 → keep', () => {
    const records: LaneOutcomeRecord[] = [];
    for (let i = 0; i < 50; i += 1) records.push(rec({ realizedPnlSol: 0.01 }));
    for (let i = 0; i < 20; i += 1) records.push(rec({ realizedPnlSol: -0.005 }));
    const m = computeCohortMetrics(records);
    expect(m.expectancySol).toBeGreaterThan(0);
    const out = deriveControlOutput(m);
    expect(out.entryMode).toBe('keep');
  });

  it('n ≥ 100 + consK ≤ 0 + cashflow severe → quarantine', () => {
    const records: LaneOutcomeRecord[] = [];
    // 30 small wins, 70 big losses → consK ≤ 0
    for (let i = 0; i < 30; i += 1) records.push(rec({ realizedPnlSol: 0.005 }));
    for (let i = 0; i < 70; i += 1) records.push(rec({ realizedPnlSol: -0.02 }));
    const m = computeCohortMetrics(records);
    expect(m.conservativeKelly).toBeLessThanOrEqual(0);
    expect(m.cashFlowSol).toBeLessThan(-0.3);
    const out = deriveControlOutput(m);
    expect(out.entryMode).toBe('quarantine');
    expect(out.maxConcurrent).toBe(0);
  });

  it('n ≥ 100 + consK ≤ 0 + 미세 손실 + 짧은 streak → throttle', () => {
    const records: LaneOutcomeRecord[] = [];
    // interleaved wins/losses — maxLossStreak < 8 으로 만들어 quarantine 회피
    for (let i = 0; i < 110; i += 1) {
      records.push(rec({ realizedPnlSol: i % 2 === 0 ? 0.001 : -0.0011 }));
    }
    const m = computeCohortMetrics(records);
    expect(m.cashFlowSol).toBeGreaterThan(-0.3);
    expect(m.maxLossStreak).toBeLessThan(8);
    expect(m.conservativeKelly).toBeLessThanOrEqual(0);
    const out = deriveControlOutput(m);
    expect(out.entryMode).toBe('throttle');
  });

  it('n ≥ 100 + consK > 0 → keep, ticket=hardLock', () => {
    const records: LaneOutcomeRecord[] = [];
    for (let i = 0; i < 80; i += 1) records.push(rec({ realizedPnlSol: 0.02 }));
    for (let i = 0; i < 20; i += 1) records.push(rec({ realizedPnlSol: -0.005 }));
    const m = computeCohortMetrics(records);
    expect(m.conservativeKelly).toBeGreaterThan(0);
    const out = deriveControlOutput(m);
    expect(out.entryMode).toBe('keep');
    expect(out.ticketCapSol).toBe(0.01); // hard lock 그대로
  });

  it('ticket_cap_sol 절대 lane hard lock 초과 안 함 (ADR §7.1)', () => {
    const records: LaneOutcomeRecord[] = [];
    for (let i = 0; i < 200; i += 1) records.push(rec({ laneName: 'kol_hunter' as LaneName, realizedPnlSol: 0.05 }));
    const m = computeCohortMetrics(records);
    const out = deriveControlOutput(m);
    expect(out.ticketCapSol).toBe(0.01); // 절대 증가 없음
  });
});

describe('buildControllerReport', () => {
  it('전체 report — paperOnly 자동 제외 + cohort 분리', () => {
    const records = [
      ...many(60, (i) => ({
        laneName: 'kol_hunter' as LaneName,
        armName: 'lexapro',
        realizedPnlSol: i % 2 === 0 ? 0.01 : -0.005,
      })),
      ...many(60, () => ({
        laneName: 'pure_ws_breakout' as LaneName,
        armName: 'v2_burst',
        realizedPnlSol: -0.005,
      })),
      // paperOnly outcome — kellyEligible=false 가정 (P0 에서 부여)
      rec({ laneName: 'kol_hunter' as LaneName, paperOnly: true, kellyEligible: false }),
    ];
    const r = buildControllerReport(records);
    expect(r.totalOutcomes).toBe(121);
    expect(r.eligibleOutcomes).toBe(120);
    expect(r.cohorts).toHaveLength(2);
  });

  it('cohorts sorted by conservative Kelly desc', () => {
    const goodRecords = many(150, (i) => ({
      laneName: 'kol_hunter' as LaneName,
      armName: 'good',
      realizedPnlSol: i < 90 ? 0.02 : -0.005,
    }));
    const badRecords = many(150, () => ({
      laneName: 'kol_hunter' as LaneName,
      armName: 'bad',
      realizedPnlSol: -0.005,
    }));
    const r = buildControllerReport([...goodRecords, ...badRecords]);
    expect(r.cohorts[0].cohort.armName).toBe('good');
    expect(r.cohorts[r.cohorts.length - 1].cohort.armName).toBe('bad');
  });

  it('highlights — quarantined / paper_only', () => {
    const records: LaneOutcomeRecord[] = [];
    for (let i = 0; i < 30; i += 1) records.push(rec({ laneName: 'pure_ws_breakout' as LaneName, armName: 'q', realizedPnlSol: 0.005 }));
    for (let i = 0; i < 70; i += 1) records.push(rec({ laneName: 'pure_ws_breakout' as LaneName, armName: 'q', realizedPnlSol: -0.02 }));
    const r = buildControllerReport(records);
    expect(r.highlights.quarantinedCohorts.length + r.highlights.paperOnlyCohorts.length).toBeGreaterThan(0);
  });
});
