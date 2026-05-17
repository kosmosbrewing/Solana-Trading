import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildProbePolicySweepReport,
  parseProbePolicySweepArgs,
  renderProbePolicySweepReport,
} from '../scripts/probe-policy-sweep-report';

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

describe('probe-policy-sweep-report', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'probe-policy-sweep-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds probe hold/cut policies without treating delayed entry as proof', async () => {
    const anchors = [];
    const markoutRows = [];
    for (let i = 0; i < 60; i += 1) {
      const positionId = `pass-${i}`;
      const anchorAt = `2026-05-01T00:${String(i).padStart(2, '0')}:00.000Z`;
      anchors.push(anchor(positionId, 'kol_hunter_rotation_v1', anchorAt, 1));
      markoutRows.push(...markouts(positionId, anchorAt, {
        60: 0.12,
        300: 0.2,
      }));
    }
    for (let i = 0; i < 60; i += 1) {
      const positionId = `fail-${i}`;
      const anchorAt = `2026-05-01T01:${String(i).padStart(2, '0')}:00.000Z`;
      anchors.push(anchor(positionId, 'kol_hunter_rotation_v1', anchorAt, 1));
      markoutRows.push(...markouts(positionId, anchorAt, {
        60: -0.03,
        300: -0.5,
      }));
    }
    await writeFile(path.join(dir, 'trade-markout-anchors.jsonl'), jsonl(anchors));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(markoutRows));

    const report = await buildProbePolicySweepReport({
      realtimeDir: dir,
      confirmHorizonsSec: [60],
      confirmThresholdsPct: [0.08],
      targetHorizonsSec: [300],
      roundTripCostPct: 0.005,
      minRows: 50,
      maxTailKillRate: 0.01,
      minMedianLossReduction: 0.3,
    });

    const top = report.topPolicies[0];
    expect(report.verdict).toBe('PROBE_POLICY_CANDIDATE');
    expect(report.promotionGate.status).toBe('FORWARD_PAPER_SHADOW_READY');
    expect(report.forwardShadowCandidates.length).toBeGreaterThan(0);
    expect(top.verdict).toBe('PROBE_POLICY_CANDIDATE');
    expect(top.medianLossReduction).toBeGreaterThan(0.3);
    expect(top.delayedEntryPassToTarget.median).toBeLessThan(0.1);
    expect(top.reasons.join(' ')).toContain('median loss reduction');
  });

  it('renders report-only guardrails and parses list args', () => {
    const args = parseProbePolicySweepArgs([
      '--realtime-dir', dir,
      '--confirm-horizons-sec', '30,60',
      '--confirm-thresholds-pct', '0.05,0.12',
      '--target-horizons-sec', '180,300',
    ]);
    expect(args.realtimeDir).toBe(path.resolve(dir));
    expect(args.confirmHorizonsSec).toEqual([30, 60]);
    expect(args.confirmThresholdsPct).toEqual([0.05, 0.12]);

    const markdown = renderProbePolicySweepReport({
      generatedAt: '2026-05-01T00:00:00.000Z',
      realtimeDir: dir,
      confirmHorizonsSec: [60],
      confirmThresholdsPct: [0.12],
      targetHorizonsSec: [300],
      roundTripCostPct: 0.005,
      minRows: 50,
      maxTailKillRate: 0.01,
      minMedianLossReduction: 0.3,
      anchorRows: 0,
      buyAnchors: 0,
      markoutRows: 0,
      okBuyMarkoutRows: 0,
      candidates: 0,
      verdict: 'DATA_GAP',
      topPolicies: [],
      bestByCohort: [],
      forwardShadowCandidates: [],
      promotionGate: {
        status: 'NO_FORWARD_SHADOW_CANDIDATE',
        forwardPaperMinCloses: 50,
        livePromotionMinCloses: 50,
        requiresNoTailKillIncrease: true,
        requiresWalletTruthReview: true,
      },
      results: [],
      reasons: ['Report-only'],
    });
    expect(markdown).toContain('Report-only');
    expect(markdown).toContain('forward paper-shadow verification');
    expect(markdown).toContain('Promotion Gate');
  });
});
