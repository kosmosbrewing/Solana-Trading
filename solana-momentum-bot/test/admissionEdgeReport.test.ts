import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildAdmissionEdgeReport,
  parseArgs,
  renderAdmissionEdgeReport,
} from '../scripts/admission-edge-report';

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function anchor(positionId: string, source: string, anchorAt: string, independentKolCount = 2): unknown {
  return {
    schemaVersion: 'trade-markout-anchor/v1',
    positionId,
    anchorType: 'buy',
    anchorAt,
    tokenMint: `${positionId}Mint`,
    anchorPrice: 1,
    signalSource: source,
    extras: {
      mode: 'paper',
      independentKolCount,
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

describe('admission-edge-report', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'admission-edge-report-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps delayed confirmation separate from anchor-time edge', async () => {
    const anchors = [];
    const markoutRows = [];
    for (let i = 0; i < 60; i += 1) {
      const positionId = `smart-pass-${i}`;
      const anchorAt = `2026-05-01T00:${String(i).padStart(2, '0')}:00.000Z`;
      anchors.push(anchor(positionId, 'smart_v3_fast_fail', anchorAt, 3));
      markoutRows.push(...markouts(positionId, anchorAt, {
        60: 0.2,
        300: 0.1,
        1800: -0.2,
      }));
    }
    for (let i = 0; i < 60; i += 1) {
      const positionId = `smart-fail-${i}`;
      const anchorAt = `2026-05-01T01:${String(i).padStart(2, '0')}:00.000Z`;
      anchors.push(anchor(positionId, 'smart_v3_fast_fail', anchorAt, 2));
      markoutRows.push(...markouts(positionId, anchorAt, {
        60: -0.1,
        300: -0.4,
        1800: -0.6,
      }));
    }
    await writeFile(path.join(dir, 'trade-markout-anchors.jsonl'), jsonl(anchors));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(markoutRows));

    const report = await buildAdmissionEdgeReport({
      realtimeDir: dir,
      confirmHorizonSec: 60,
      targetHorizonSec: 300,
      carryHorizonSec: 1800,
      confirmThresholdPct: 0.12,
      roundTripCostPct: 0.005,
    });

    const all = report.cohorts.find((cohort) => cohort.cohort === 'ALL');
    const smart = report.cohorts.find((cohort) => cohort.cohort === 'family:smart_v3');
    expect(report.verdict).toBe('ADMISSION_EDGE_GAP');
    expect(all?.confirmPassAnchorToTarget.median).toBeGreaterThan(0);
    expect(all?.confirmFailAnchorToTarget.median).toBeLessThan(0);
    expect(all?.delayedEntryPassToTarget.median).toBeLessThan(0);
    expect(smart?.reasons.join(' ')).toContain('avoid lookahead promotion');
  });

  it('renders report-only interpretation and CLI defaults', async () => {
    const args = parseArgs(['--realtime-dir', dir, '--confirm-threshold-pct', '0.2']);
    expect(args.realtimeDir).toBe(path.resolve(dir));
    expect(args.confirmThresholdPct).toBe(0.2);

    const markdown = renderAdmissionEdgeReport({
      generatedAt: '2026-05-01T00:00:00.000Z',
      realtimeDir: dir,
      confirmHorizonSec: 60,
      targetHorizonSec: 300,
      carryHorizonSec: 1800,
      confirmThresholdPct: 0.12,
      roundTripCostPct: 0.005,
      anchorRows: 1,
      buyAnchors: 1,
      markoutRows: 1,
      okBuyMarkoutRows: 1,
      candidates: 1,
      verdict: 'DATA_GAP',
      reasons: ['sample below threshold'],
      cohorts: [],
    });
    expect(markdown).toContain('Report-only');
    expect(markdown).toContain('lookahead');
    expect(markdown).toContain('hold-if-confirm-else-cut');
  });
});
