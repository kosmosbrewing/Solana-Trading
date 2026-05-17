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
  participatingKols?: unknown[];
  kolEntryReason?: string;
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
    participatingKols: params.participatingKols,
    kolEntryReason: params.kolEntryReason,
  };
}

function missedAlphaRow(params: {
  positionId: string;
  rejectedAt: string;
  tokenMint?: string;
  signalPrice?: number;
  exitPrice?: number;
  deltaPct?: number;
  offsetSec?: number;
}): unknown {
  return {
    eventId: `evt-${params.positionId}-${params.offsetSec ?? 1800}`,
    tokenMint: params.tokenMint ?? 'Mint111111111111111111111111111111111111111',
    lane: 'kol_hunter',
    rejectCategory: 'kol_close',
    rejectReason: 'probe_policy_confirm_fail_cut',
    signalPrice: params.signalPrice ?? 1,
    rejectedAt: params.rejectedAt,
    extras: {
      positionId: params.positionId,
      elapsedSecAtClose: 31,
      exitPrice: params.exitPrice ?? 1,
      isShadowArm: true,
      paperRole: 'probe_policy_shadow',
      armName: 'smart_v3_probe_confirm_shadow_v1',
    },
    probe: {
      offsetSec: params.offsetSec ?? 1800,
      firedAt: params.rejectedAt,
      observedPrice: null,
      deltaPct: params.deltaPct ?? 0,
      quoteStatus: 'ok',
    },
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
        independentKolCount: 3,
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
        participatingKols: [{ id: 'k1', tier: 'S' }, { id: 'k2', tier: 'A' }, { id: 'k3', tier: 'A' }],
        kolEntryReason: 'velocity',
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
    expect(report.funnel.eligibleParentRows).toBe(60);
    expect(report.funnel.eligiblePairedRows).toBe(60);
    expect(report.funnel.eligiblePairCoverage).toBe(1);
    expect(report.comparison.medianImprovement).toBeGreaterThan(0);
    expect(report.comparison.bigLossReduction).toBeGreaterThan(0);
    expect(report.comparison.tailKillDelta).toBe(0);
    expect(report.promotionGate.livePromotionAllowed).toBe(false);
    expect(report.cohorts.find((row) => row.cohort === 'parent:kol_hunter_smart_v3')?.pairedRows).toBe(60);
    expect(report.cohorts.find((row) => row.cohort === 'kol:KOL_3plus')?.pairedRows).toBe(60);
    expect(report.qualitySplits.find((row) => row.cohort === 'quality:clean_or_unknown')?.stats.rows).toBe(60);
    expect(report.qualitySplits.find((row) => row.cohort === 'entry:velocity')?.stats.rows).toBe(60);
    expect(report.qualitySplits.find((row) => row.cohort === 'tier:has_S')?.stats.rows).toBe(60);
    expect(report.promotionGate.targetCohort).toBe('kol:KOL_3plus');
    expect(report.promotionGate.targetPairedCloses).toBe(60);
    expect(report.promotionGate.nextAction).toBe('BUILD_WALLET_TRUTH_REVIEW_PACKET');
    expect(report.promotionGate.checks.every((check) => check.status === 'PASS')).toBe(true);
  });

  it('audits confirm-fail cuts against post-close missed-alpha winner-kill rows', async () => {
    const rows = [
      paperTrade({
        positionId: 'parent-1',
        armName: 'kol_hunter_smart_v3',
        closedAt: '2026-05-01T00:00:00.000Z',
        netPctTokenOnly: -0.2,
        mfePctPeakTokenOnly: 0.1,
        independentKolCount: 3,
      }),
      paperTrade({
        positionId: 'probe-1',
        armName: 'smart_v3_probe_confirm_shadow_v1',
        closedAt: '2026-05-01T00:00:31.000Z',
        netPctTokenOnly: -0.02,
        mfePctPeakTokenOnly: 0.05,
        parentPositionId: 'parent-1',
        paperRole: 'probe_policy_shadow',
        exitReason: 'probe_policy_confirm_fail_cut',
        independentKolCount: 3,
      }),
    ];
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl(rows));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      missedAlphaRow({
        positionId: 'probe-1',
        rejectedAt: '2026-05-01T00:00:31.000Z',
        signalPrice: 1,
        exitPrice: 1,
        deltaPct: 4,
      }),
    ]));

    const report = await buildProbePolicyShadowReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      minCloses: 1,
      maxTailKillRate: 0.01,
    });

    expect(report.winnerKillAudit.cutRows).toBe(1);
    expect(report.winnerKillAudit.observedTargetRows).toBe(1);
    expect(report.winnerKillAudit.winnerKillRows).toBe(1);
    expect(report.winnerKillAudit.winnerKillRate).toBe(1);
    expect(report.promotionGate.nextAction).toBe('BLOCK_PROMOTION_REVIEW_ROOT_CAUSE');
    expect(report.promotionGate.checks.find((check) => check.name === 'confirm_fail_winner_kill')?.status).toBe('FAIL');
    expect(report.reasons.join('\n')).toContain('post-close 5x winner-kill examples');
    expect(renderProbePolicyShadowReport(report)).toContain('Confirm-Fail Winner-Kill Audit');
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
        independentKolCount: 2,
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
    expect(report.funnel.belowMinParentRows).toBe(1);
    expect(report.funnel.belowMinProbeRows).toBe(1);
    expect(report.funnel.eligiblePairCoverage).toBe(null);
    expect(report.cohorts.find((row) => row.cohort === 'parent:smart_v3_fast_fail_live_mirror_v1')?.pairedRows).toBe(1);
    expect(report.cohorts.find((row) => row.cohort === 'kol:below_min')?.pairedRows).toBe(1);
    expect(report.comparison.medianImprovement).toBeGreaterThan(0);
    expect(renderProbePolicyShadowReport(report)).toContain('smart_v3_fast_fail_live_mirror_v1');
    expect(renderProbePolicyShadowReport(report)).toContain('kol:below_min');
  });

  it('surfaces KOL_3plus parent closes that are missing paired probe shadows', async () => {
    const rows = [
      paperTrade({
        positionId: 'eligible-parent-without-probe',
        armName: 'kol_hunter_smart_v3',
        closedAt: '2026-05-01T00:00:00.000Z',
        netPctTokenOnly: -0.12,
        mfePctPeakTokenOnly: 0.2,
        independentKolCount: 3,
      }),
      paperTrade({
        positionId: 'below-min-parent',
        armName: 'kol_hunter_smart_v3',
        closedAt: '2026-05-01T00:00:01.000Z',
        netPctTokenOnly: -0.1,
        mfePctPeakTokenOnly: 0.2,
        independentKolCount: 2,
      }),
      paperTrade({
        positionId: 'orphan-probe',
        armName: 'smart_v3_probe_confirm_shadow_v1',
        closedAt: '2026-05-01T00:00:02.000Z',
        netPctTokenOnly: -0.03,
        mfePctPeakTokenOnly: 0.1,
        parentPositionId: 'missing-parent',
        paperRole: 'probe_policy_shadow',
        independentKolCount: 3,
      }),
    ];
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl(rows));

    const report = await buildProbePolicyShadowReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      minCloses: 1,
      maxTailKillRate: 0.01,
    });

    expect(report.funnel.eligibleParentRows).toBe(1);
    expect(report.funnel.eligiblePairedRows).toBe(0);
    expect(report.funnel.eligibleParentWithoutProbeRows).toBe(1);
    expect(report.funnel.belowMinParentRows).toBe(1);
    expect(report.funnel.unpairedProbeRows).toBe(1);
    expect(report.funnel.eligiblePairCoverage).toBe(0);
    expect(report.funnel.reasons.join('\n')).toContain('KOL_3plus parent closes had no paired probe shadow close');
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
      funnel: {
        parentRows: 0,
        eligibleParentRows: 0,
        belowMinParentRows: 0,
        unknownParentRows: 0,
        probeRows: 0,
        eligibleProbeRows: 0,
        belowMinProbeRows: 0,
        unknownProbeRows: 0,
        pairedRows: 0,
        eligiblePairedRows: 0,
        eligibleParentWithoutProbeRows: 0,
        unpairedProbeRows: 0,
        allPairCoverage: null,
        eligiblePairCoverage: null,
        reasons: ['no KOL_3plus parent closes were available for probe-policy promotion evidence'],
      },
      winnerKillAudit: {
        closeReason: 'probe_policy_confirm_fail_cut',
        targetOffsetSec: 1800,
        thresholdMfe: 4,
        cutRows: 0,
        observedTargetRows: 0,
        winnerKillRows: 0,
        winnerKillRate: null,
        observationCoverage: null,
        examples: [],
      },
      comparison: {
        pairedRows: 0,
        parent: { rows: 0, medianNetPct: null, medianNetSol: null, positiveRate: null, bigLossRate: null, tail50Rate: null, fiveXRate: null },
        probe: { rows: 0, medianNetPct: null, medianNetSol: null, positiveRate: null, bigLossRate: null, tail50Rate: null, fiveXRate: null },
        medianImprovement: null,
        bigLossReduction: null,
        tailKillDelta: null,
      },
      cohorts: [],
      qualitySplits: [],
      exitReasons: [],
      verdict: 'COLLECT',
      reasons: ['Report-only. Live promotion is explicitly blocked until separate wallet-truth review.'],
      promotionGate: {
        forwardPaperMinCloses: 50,
        livePromotionAllowed: false,
        requiresSeparateReview: true,
        targetCohort: 'kol:KOL_3plus',
        targetPairedCloses: 0,
        nextAction: 'COLLECT_FORWARD_PAPER',
        checks: [
          {
            name: 'forward_paper_min_closes',
            status: 'COLLECT',
            current: '0',
            required: '>=50 paired kol:KOL_3plus closes',
          },
        ],
      },
    });
    expect(markdown).toContain('live promotion allowed: false');
    expect(markdown).toContain('requires separate wallet-truth review: true');
    expect(markdown).toContain('next action: COLLECT_FORWARD_PAPER');
    expect(markdown).toContain('This report can only move the arm to review');
  });
});
