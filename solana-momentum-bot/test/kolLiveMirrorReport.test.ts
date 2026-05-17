import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildKolLiveMirrorReport,
  parseKolLiveMirrorArgs,
  renderKolLiveMirrorReport,
} from '../scripts/kol-live-mirror-report';

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function liveRow(params: {
  positionId: string;
  closedAt: string;
  netSol: number;
  netPct: number;
  exitReason?: string;
}): unknown {
  return {
    positionId: params.positionId,
    tokenMint: `Mint${params.positionId}`,
    armName: 'smart_v3_fast_fail_live_v1',
    paperRole: null,
    closedAt: params.closedAt,
    netSol: params.netSol,
    netPct: params.netPct,
    mfePctPeakTokenOnly: 0.2,
    holdSec: 20,
    exitReason: params.exitReason ?? 'live_close',
    liveEquivalenceDecisionId: `decision-${params.positionId}`,
  };
}

function mirrorRow(params: {
  positionId: string;
  parentPositionId: string;
  closedAt: string;
  netSolTokenOnly: number;
  netPctTokenOnly: number;
  exitReason?: string;
}): unknown {
  return {
    positionId: params.positionId,
    parentPositionId: params.parentPositionId,
    tokenMint: `Mint${params.parentPositionId}`,
    armName: 'smart_v3_fast_fail_live_mirror_v1',
    paperRole: 'mirror',
    closedAt: params.closedAt,
    netSolTokenOnly: params.netSolTokenOnly,
    netPctTokenOnly: params.netPctTokenOnly,
    mfePctPeakTokenOnly: 0.25,
    holdSec: 22,
    exitReason: params.exitReason ?? 'mirror_close',
    liveEquivalenceDecisionId: `decision-${params.parentPositionId}`,
  };
}

describe('kol-live-mirror-report', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kol-live-mirror-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('classifies live losers with positive mirrors as execution drag', async () => {
    await writeFile(path.join(dir, 'kol-live-trades.jsonl'), jsonl([
      liveRow({ positionId: 'live-1', closedAt: '2026-05-01T00:00:00.000Z', netSol: -0.003, netPct: -0.15 }),
      liveRow({ positionId: 'live-2', closedAt: '2026-05-01T00:01:00.000Z', netSol: -0.002, netPct: -0.10 }),
    ]));
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([
      mirrorRow({ positionId: 'mirror-1', parentPositionId: 'live-1', closedAt: '2026-05-01T00:00:01.000Z', netSolTokenOnly: 0.001, netPctTokenOnly: 0.05 }),
      mirrorRow({ positionId: 'mirror-2', parentPositionId: 'live-2', closedAt: '2026-05-01T00:01:01.000Z', netSolTokenOnly: 0.002, netPctTokenOnly: 0.10 }),
    ]));

    const report = await buildKolLiveMirrorReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      minPairs: 2,
      executionDragRate: 0.2,
      strategyLossRate: 0.5,
    });

    expect(report.verdict).toBe('EXECUTION_DRAG_REVIEW');
    expect(report.pairedRows).toBe(2);
    expect(report.classifications.execution_drag).toBe(2);
    expect(report.live.netSol).toBeCloseTo(-0.005, 6);
    expect(report.mirror.netSol).toBeCloseTo(0.003, 6);
    expect(report.topExecutionDrags).toHaveLength(2);
    expect(renderKolLiveMirrorReport(report)).toContain('EXECUTION_DRAG_REVIEW');
  });

  it('classifies paired live/mirror losers as strategy loss', async () => {
    await writeFile(path.join(dir, 'kol-live-trades.jsonl'), jsonl([
      liveRow({ positionId: 'live-1', closedAt: '2026-05-01T00:00:00.000Z', netSol: -0.003, netPct: -0.15 }),
      liveRow({ positionId: 'live-2', closedAt: '2026-05-01T00:01:00.000Z', netSol: -0.002, netPct: -0.10 }),
    ]));
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([
      mirrorRow({ positionId: 'mirror-1', parentPositionId: 'live-1', closedAt: '2026-05-01T00:00:01.000Z', netSolTokenOnly: -0.001, netPctTokenOnly: -0.05 }),
      mirrorRow({ positionId: 'mirror-2', parentPositionId: 'live-2', closedAt: '2026-05-01T00:01:01.000Z', netSolTokenOnly: -0.002, netPctTokenOnly: -0.10 }),
    ]));

    const report = await buildKolLiveMirrorReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      minPairs: 2,
      executionDragRate: 0.2,
      strategyLossRate: 0.5,
    });

    expect(report.verdict).toBe('STRATEGY_LOSS_REVIEW');
    expect(report.classifications.strategy_loss).toBe(2);
    expect(report.topStrategyLosses).toHaveLength(2);
  });

  it('parses args and renders collection guardrails', () => {
    const args = parseKolLiveMirrorArgs(['--realtime-dir', dir, '--since', '12h', '--min-pairs', '5']);
    expect(args.realtimeDir).toBe(path.resolve(dir));
    expect(args.minPairs).toBe(5);

    const markdown = renderKolLiveMirrorReport({
      generatedAt: '2026-05-01T00:00:00.000Z',
      realtimeDir: dir,
      since: '2026-05-01T00:00:00.000Z',
      liveArm: 'smart_v3_fast_fail_live_v1',
      mirrorArm: 'smart_v3_fast_fail_live_mirror_v1',
      minPairs: 30,
      paperRows: 0,
      liveRows: 0,
      mirrorRows: 0,
      pairedRows: 0,
      unpairedMirrorRows: 0,
      liveWithoutMirrorRows: 0,
      live: { rows: 0, netSol: 0, medianNetSol: null, medianNetPct: null, positiveRate: null, medianMfePct: null, medianHoldSec: null },
      mirror: { rows: 0, netSol: 0, medianNetSol: null, medianNetPct: null, positiveRate: null, medianMfePct: null, medianHoldSec: null },
      deltas: { medianNetPct: null, medianNetSol: null, positiveRate: null },
      classifications: {
        strategy_loss: 0,
        execution_drag: 0,
        strategy_win_execution_ok: 0,
        paper_false_negative: 0,
      },
      classificationRates: {
        strategy_loss: null,
        execution_drag: null,
        strategy_win_execution_ok: null,
        paper_false_negative: null,
      },
      topExecutionDrags: [],
      topStrategyLosses: [],
      verdict: 'COLLECT',
      reasons: ['Report-only. Live promotion is blocked until separate wallet-truth review.'],
      promotionGate: {
        livePromotionAllowed: false,
        requiresSeparateWalletTruthReview: true,
      },
    });
    expect(markdown).toContain('live promotion allowed: false');
    expect(markdown).toContain('This report explains cause');
  });
});
