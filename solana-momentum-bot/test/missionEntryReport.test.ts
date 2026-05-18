import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildMissionEntryReport,
  parseMissionEntryArgs,
  renderMissionEntryReport,
} from '../scripts/mission-entry-report';

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function anchor(positionId: string, source: string, anchorAt: string, mode = 'paper'): unknown {
  return {
    schemaVersion: 'trade-markout-anchor/v1',
    positionId,
    anchorType: 'buy',
    anchorAt,
    tokenMint: `${positionId}Mint`,
    anchorPrice: 1,
    signalSource: source,
    extras: {
      mode,
      independentKolCount: 1,
    },
  };
}

function markouts(positionId: string, anchorAt: string, deltas: Record<number, number>): unknown[] {
  return Object.entries(deltas).map(([horizonSec, deltaPct]) => ({
    schemaVersion: 'trade-markout/v1',
    positionId,
    anchorType: 'buy',
    anchorAt,
    horizonSec: Number(horizonSec),
    quoteStatus: 'ok',
    observedPrice: 1 + deltaPct,
    deltaPct,
  }));
}

describe('mission-entry-report', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mission-entry-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('detects admission quality as root cause when markouts decay and live losses are bleed buckets', async () => {
    const anchors = [];
    const markoutRows = [];
    for (let i = 0; i < 60; i += 1) {
      const positionId = `rot-${i}`;
      const anchorAt = `2026-05-01T00:${String(i).padStart(2, '0')}:00.000Z`;
      anchors.push(anchor(positionId, 'kol_hunter_rotation_v1', anchorAt, i % 2 === 0 ? 'paper' : 'live'));
      markoutRows.push(...markouts(positionId, anchorAt, {
        30: 0.02,
        60: 0.005,
        300: -0.12,
        1800: -0.5,
      }));
    }

    const liveRows = Array.from({ length: 30 }, (_, i) => ({
      positionId: `live-${i}`,
      status: 'closed',
      armName: 'rotation_underfill_v1',
      exitReason: i % 2 === 0 ? 'probe_hard_cut' : 'rotation_dead_on_arrival',
      netSol: -0.01,
      actualMfePct: 0.03,
      holdSec: 25,
    }));

    const paperRows = [
      {
        positionId: 'shadow-1',
        status: 'closed',
        armName: 'rotation_doa_veto_shadow_v1',
        parentPositionId: 'live-0',
        netSol: 0.02,
        netPct: 0.1,
        mfePct: 0.2,
        holdSec: 40,
      },
      {
        positionId: 'shadow-2',
        status: 'closed',
        paperRole: 'probe_policy_shadow',
        netSol: -0.01,
        netPct: -0.4,
        mfePct: 0,
        holdSec: 30,
      },
    ];

    await writeFile(path.join(dir, 'trade-markout-anchors.jsonl'), jsonl(anchors));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(markoutRows));
    await writeFile(path.join(dir, 'rotation-v1-live-trades.jsonl'), jsonl(liveRows));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl(paperRows));

    const report = await buildMissionEntryReport({
      realtimeDir: dir,
      horizonsSec: [30, 60, 300, 1800],
      roundTripCostPct: 0.005,
      minRows: 20,
      bleedShareThreshold: 0.5,
    });

    expect(report.verdict).toBe('ADMISSION_QUALITY_ROOT_CAUSE');
    expect(report.cohorts.find((cohort) => cohort.cohort === 'all')?.verdict).toBe('ADMISSION_DECAY_CONFIRMED');
    expect(report.liveBleed.bleedNetShare).toBeGreaterThanOrEqual(1);
    expect(report.paperShadows.find((shadow) => shadow.armName === 'rotation_doa_veto_shadow_v1')?.rows).toBe(1);
    expect(report.paperShadows.find((shadow) => shadow.armName === 'smart_v3_probe_confirm_shadow_v1')?.rows).toBe(1);
    expect(report.rotationDoaVetoCoverage.parentRows).toBe(30);
    expect(report.rotationDoaVetoCoverage.pairedRows).toBe(1);
    expect(report.rotationDoaVetoCoverage.verdict).toBe('COVERAGE_GAP');
  });

  it('parses args and renders guardrails', () => {
    const args = parseMissionEntryArgs([
      '--realtime-dir', dir,
      '--horizons-sec', '30,300,1800',
      '--round-trip-cost-pct', '0.01',
      '--min-rows', '10',
    ]);
    expect(args.realtimeDir).toBe(path.resolve(dir));
    expect(args.horizonsSec).toEqual([30, 300, 1800]);
    expect(args.roundTripCostPct).toBe(0.01);
    expect(args.minRows).toBe(10);

    const markdown = renderMissionEntryReport({
      generatedAt: '2026-05-01T00:00:00.000Z',
      realtimeDir: dir,
      horizonsSec: [30, 300, 1800],
      roundTripCostPct: 0.005,
      minRows: 10,
      bleedShareThreshold: 0.5,
      anchorRows: 0,
      buyAnchors: 0,
      markoutRows: 0,
      okBuyMarkoutRows: 0,
      candidates: 0,
      verdict: 'DATA_GAP',
      reasons: ['no data'],
      cohorts: [],
      liveBleed: {
        liveRows: 0,
        liveNetSol: 0,
        bleedRows: 0,
        bleedNetSol: 0,
        bleedNetShare: null,
        buckets: [],
      },
      paperShadows: [],
      rotationDoaVetoCoverage: {
        verdict: 'DATA_GAP',
        parentRows: 0,
        shadowRows: 0,
        pairedRows: 0,
        rawSkipRows: 0,
        uniqueSkipRows: 0,
        attributedCoverage: null,
        unattributedParentRows: 0,
        parentNetSol: 0,
        shadowNetSol: 0,
        pairedParentNetSol: 0,
        pairedShadowNetSol: 0,
        pairedNetDeltaSol: null,
        skipReasons: [],
        reasons: ['no rotation_underfill_v1 parent rows'],
      },
      nextActions: ['Collect forward paper shadow rows.'],
    });
    expect(markdown).toContain('Report-only');
    expect(markdown).toContain('Live promotion is blocked');
  });
});
