import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildProbePolicyShadowReport,
  parseProbePolicyShadowArgs,
  renderProbePolicyShadowReport,
} from '../scripts/probe-policy-shadow-report';

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function paperTrade(params: {
  positionId: string;
  armName: string;
  closedAt: string;
  netPctTokenOnly: number;
  mfePctPeakTokenOnly: number;
  netSolTokenOnly?: number;
  parentPositionId?: string;
  paperRole?: string;
  exitReason?: string;
  independentKolCount?: number;
  survivalFlags?: string[];
}): unknown {
  return {
    schemaVersion: 'kol-paper-trade/v1',
    positionId: params.positionId,
    armName: params.armName,
    closedAt: params.closedAt,
    netPctTokenOnly: params.netPctTokenOnly,
    netSolTokenOnly: params.netSolTokenOnly ?? params.netPctTokenOnly * 0.01,
    mfePctPeakTokenOnly: params.mfePctPeakTokenOnly,
    parentPositionId: params.parentPositionId,
    paperRole: params.paperRole,
    exitReason: params.exitReason ?? 'test_close',
    independentKolCount: params.independentKolCount,
    survivalFlags: params.survivalFlags,
  };
}

describe('probe-policy-shadow-report', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-policy-shadow-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('compares probe shadow closes against paired parent smart-v3 closes', async () => {
    const rows = [];
    for (let i = 0; i < 60; i += 1) {
      const closedAt = `2026-05-01T00:${String(i).padStart(2, '0')}:00.000Z`;
      const parentId = `parent-${i}`;
      rows.push(paperTrade({
        positionId: parentId,
        armName: 'kol_hunter_smart_v3',
        closedAt,
        netPctTokenOnly: i < 30 ? -0.3 : -0.1,
        mfePctPeakTokenOnly: 0.6,
      }));
      rows.push(paperTrade({
        positionId: `probe-${i}`,
        armName: 'smart_v3_probe_confirm_shadow_v1',
        closedAt,
        netPctTokenOnly: i < 30 ? -0.08 : 0.04,
        mfePctPeakTokenOnly: 0.6,
        parentPositionId: parentId,
        paperRole: 'probe_policy_shadow',
        exitReason: i < 30 ? 'probe_shadow_cut' : 'probe_shadow_hold',
        independentKolCount: 3,
      }));
    }
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl(rows));

    const report = await buildProbePolicyShadowReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      minCloses: 50,
      maxTailKillRate: 0.01,
    });

    expect(report.verdict).toBe('READY_FOR_REVIEW');
    expect(report.pairedRows).toBe(60);
    expect(report.comparison.medianImprovement).toBeGreaterThan(0);
    expect(report.comparison.bigLossReduction).toBeGreaterThan(0);
    expect(report.comparison.tailKillDelta).toBe(0);
    expect(report.promotionGate.livePromotionAllowed).toBe(false);
    expect(report.cohorts.find((row) => row.cohort === 'parent:kol_hunter_smart_v3')?.pairedRows).toBe(60);
    expect(report.cohorts.find((row) => row.cohort === 'kol:KOL_3plus')?.pairedRows).toBe(60);
  });

  it('counts fast-fail live mirror as a valid probe parent arm', async () => {
    const rows = [
      paperTrade({
        positionId: 'live-mirror-1',
        armName: 'smart_v3_fast_fail_live_mirror_v1',
        closedAt: '2026-05-01T00:00:00.000Z',
        netPctTokenOnly: -0.2,
        mfePctPeakTokenOnly: 0.3,
        paperRole: 'mirror',
      }),
      paperTrade({
        positionId: 'probe-live-mirror-1',
        armName: 'smart_v3_probe_confirm_shadow_v1',
        closedAt: '2026-05-01T00:00:01.000Z',
        netPctTokenOnly: -0.05,
        mfePctPeakTokenOnly: 0.3,
        parentPositionId: 'live-mirror-1',
        paperRole: 'probe_policy_shadow',
        exitReason: 'probe_shadow_cut',
        independentKolCount: 2,
        survivalFlags: ['SMART_V3_PROBE_BELOW_MIN_KOL_2'],
      }),
    ];
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl(rows));

    const report = await buildProbePolicyShadowReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      minCloses: 1,
      maxTailKillRate: 0.01,
    });

    expect(report.parentArms).toContain('smart_v3_fast_fail_live_mirror_v1');
    expect(report.parentRows).toBe(1);
    expect(report.pairedRows).toBe(1);
    expect(report.cohorts.find((row) => row.cohort === 'parent:smart_v3_fast_fail_live_mirror_v1')?.pairedRows).toBe(1);
    expect(report.cohorts.find((row) => row.cohort === 'kol:below_min')?.pairedRows).toBe(1);
    expect(report.comparison.medianImprovement).toBeGreaterThan(0);
    expect(renderProbePolicyShadowReport(report)).toContain('smart_v3_fast_fail_live_mirror_v1');
    expect(renderProbePolicyShadowReport(report)).toContain('kol:below_min');
  });

  it('renders explicit live-promotion guardrails while collecting data', () => {
    const args = parseProbePolicyShadowArgs(['--realtime-dir', dir, '--since', '12h', '--min-closes', '10']);
    expect(args.realtimeDir).toBe(path.resolve(dir));
    expect(args.minCloses).toBe(10);

    const markdown = renderProbePolicyShadowReport({
      generatedAt: '2026-05-01T00:00:00.000Z',
      realtimeDir: dir,
      since: '2026-05-01T00:00:00.000Z',
      minCloses: 50,
      maxTailKillRate: 0.01,
      probeArm: 'smart_v3_probe_confirm_shadow_v1',
      parentArm: 'kol_hunter_smart_v3',
      parentArms: ['kol_hunter_smart_v3', 'smart_v3_fast_fail_live_mirror_v1'],
      paperRows: 0,
      probeRows: 0,
      parentRows: 0,
      pairedRows: 0,
      comparison: {
        pairedRows: 0,
        parent: { rows: 0, medianNetPct: null, medianNetSol: null, positiveRate: null, bigLossRate: null, tail50Rate: null, fiveXRate: null },
        probe: { rows: 0, medianNetPct: null, medianNetSol: null, positiveRate: null, bigLossRate: null, tail50Rate: null, fiveXRate: null },
        medianImprovement: null,
        bigLossReduction: null,
        tailKillDelta: null,
      },
      cohorts: [],
      exitReasons: [],
      verdict: 'COLLECT',
      reasons: ['Report-only. Live promotion is explicitly blocked until separate wallet-truth review.'],
      promotionGate: {
        forwardPaperMinCloses: 50,
        livePromotionAllowed: false,
        requiresSeparateReview: true,
      },
    });
    expect(markdown).toContain('live promotion allowed: false');
    expect(markdown).toContain('requires separate wallet-truth review: true');
    expect(markdown).toContain('This report can only move the arm to review');
  });
});
