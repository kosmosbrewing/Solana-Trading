import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildSmartV3EvidenceReport,
  renderSmartV3EvidenceReportMarkdown,
} from '../scripts/smart-v3-evidence-report';

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function smartV3TradeRows(count: number, overrides: Record<string, unknown> = {}): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    strategy: 'kol_hunter',
    mode: overrides.mode ?? 'paper',
    armName: 'kol_hunter_smart_v3',
    parameterVersion: 'smart-v3.0.0',
    kolEntryReason: overrides.kolEntryReason ?? 'velocity',
    positionId: `${overrides.mode ?? 'paper'}-smart-v3-${index}`,
    closedAt: new Date(Date.parse('2026-05-02T00:00:00.000Z') + index * 60_000).toISOString(),
    exitReason: overrides.exitReason ?? 'winner_trailing_t1',
    holdSec: 80 + index,
    netSol: overrides.netSol ?? 0.001,
    netSolTokenOnly: overrides.netSolTokenOnly ?? 0.0015,
    mfePctPeak: overrides.mfePctPeak ?? 0.35,
    t1VisitAtSec: 1_778_870_460,
    ...overrides,
  }));
}

function smartV3MarkoutRows(count: number, horizons: number[], deltaPct: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    for (const horizonSec of horizons) {
      for (const anchorType of ['buy', 'sell'] as const) {
        rows.push({
          anchorType,
          positionId: `paper-smart-v3-${index}`,
          tokenMint: `MintSmartV3${index}`,
          signalSource: 'kol_hunter_smart_v3',
          horizonSec,
          quoteStatus: 'ok',
          deltaPct,
          recordedAt: new Date(Date.parse('2026-05-02T00:00:00.000Z') + index * 60_000 + horizonSec * 1000).toISOString(),
          extras: {
            mode: 'paper',
            armName: 'kol_hunter_smart_v3',
            entryReason: 'velocity',
          },
        });
      }
    }
  }
  return rows;
}

describe('smart-v3-evidence-report', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'smart-v3-evidence-report-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps a positive 50-close smart-v3 cohort in WATCH until promotion sample size', async () => {
    await writeFile(path.join(dir, 'smart-v3-paper-trades.jsonl'), jsonl(smartV3TradeRows(50)));
    await writeFile(path.join(dir, 'smart-v3-live-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(smartV3MarkoutRows(50, [30, 60, 300, 1800], 0.05)));

    const report = await buildSmartV3EvidenceReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [30, 60, 300, 1800],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.002,
      assumedNetworkFeeSol: 0.0001,
    });

    const verdict = report.evidenceVerdicts.find((entry) => entry.cohort === 'paper:velocity');
    expect(verdict?.verdict).toBe('WATCH');
    expect(verdict?.minOkCoverage).toBe(1);
    expect(verdict?.t300BuyMedianPostCostDeltaPct).toBeCloseTo(0.045);
    const cohort = report.tradeRows.byCohort.find((entry) => entry.cohort === 'paper:velocity');
    expect(cohort?.t1Rows).toBe(50);
    expect(renderSmartV3EvidenceReportMarkdown(report)).toContain('Smart-v3 Evidence Report');
  });

  it('adds a diagnostic KOL transfer posterior section for smart-v3 fit', async () => {
    const transferFile = path.join(dir, 'kol-transfers.jsonl');
    await writeFile(path.join(dir, 'smart-v3-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'smart-v3-live-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(transferFile, jsonl([
      {
        kolId: 'swinger',
        kolAddress: 'SWING111',
        kolTier: 'A',
        laneRole: 'smart_v3_support',
        tradingStyle: 'swing',
        walletDirection: 'out',
        transfer: {
          signature: 'buy1',
          blockTime: 1_778_870_400,
          slot: 1,
          type: 'TRANSFER',
          mint: 'So11111111111111111111111111111111111111112',
          uiAmount: '2.5',
          amount: '2500000000',
        },
      },
      {
        kolId: 'swinger',
        kolAddress: 'SWING111',
        kolTier: 'A',
        laneRole: 'smart_v3_support',
        tradingStyle: 'swing',
        walletDirection: 'in',
        transfer: {
          signature: 'buy1',
          blockTime: 1_778_870_400,
          slot: 1,
          type: 'TRANSFER',
          mint: 'MintSmartPosterior11111111111111111111',
          uiAmount: '1000',
          amount: '1000',
        },
      },
    ]));

    const report = await buildSmartV3EvidenceReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [30, 60, 300, 1800],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.002,
      assumedNetworkFeeSol: 0.0001,
      kolTransferInput: transferFile,
    });

    expect(report.kolTransferPosterior.rows).toBe(2);
    expect(report.kolTransferPosterior.topSmartV3Fit[0].kolId).toBe('swinger');
    const markdown = renderSmartV3EvidenceReportMarkdown(report);
    expect(markdown).toContain('KOL Transfer Posterior — Smart-v3 Fit');
    expect(markdown).toContain('Diagnostic only');
  });

  it('flags DATA_GAP when sell-side T+ coverage is missing', async () => {
    await writeFile(path.join(dir, 'smart-v3-paper-trades.jsonl'), jsonl(smartV3TradeRows(50)));
    await writeFile(path.join(dir, 'smart-v3-live-trades.jsonl'), jsonl([]));
    const buyOnlyRows = smartV3MarkoutRows(50, [30, 60, 300, 1800], 0.05)
      .filter((row) => row.anchorType === 'buy');
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(buyOnlyRows));

    const report = await buildSmartV3EvidenceReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [30, 60, 300, 1800],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.002,
      assumedNetworkFeeSol: 0.0001,
    });

    const verdict = report.evidenceVerdicts.find((entry) => entry.cohort === 'paper:velocity');
    expect(verdict?.verdict).toBe('DATA_GAP');
    expect(verdict?.requiredHorizonCoverage[0].sellOkCoverage).toBe(0);
  });

  it('does not assign unknown-mode markouts to paper/live cohorts', async () => {
    await writeFile(path.join(dir, 'smart-v3-paper-trades.jsonl'), jsonl(smartV3TradeRows(50)));
    await writeFile(path.join(dir, 'smart-v3-live-trades.jsonl'), jsonl([]));
    const unknownModeRows = smartV3MarkoutRows(50, [30, 60, 300, 1800], 0.05)
      .map((row) => ({
        ...row,
        extras: {
          armName: 'kol_hunter_smart_v3',
          entryReason: 'velocity',
        },
      }));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(unknownModeRows));

    const report = await buildSmartV3EvidenceReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [30, 60, 300, 1800],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.002,
      assumedNetworkFeeSol: 0.0001,
    });

    const verdict = report.evidenceVerdicts.find((entry) => entry.cohort === 'paper:velocity');
    expect(verdict?.verdict).toBe('DATA_GAP');
    expect(verdict?.requiredHorizonCoverage[0].buyOkCoverage).toBe(0);
  });

  it('computes verdict coverage against cohort close anchors, not only observed markout rows', async () => {
    await writeFile(path.join(dir, 'smart-v3-paper-trades.jsonl'), jsonl(smartV3TradeRows(50)));
    await writeFile(path.join(dir, 'smart-v3-live-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(smartV3MarkoutRows(1, [30, 60, 300, 1800], 0.05)));

    const report = await buildSmartV3EvidenceReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [30, 60, 300, 1800],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.002,
      assumedNetworkFeeSol: 0.0001,
    });

    const verdict = report.evidenceVerdicts.find((entry) => entry.cohort === 'paper:velocity');
    expect(verdict?.verdict).toBe('DATA_GAP');
    expect(verdict?.requiredHorizonCoverage[0].buyOkCoverage).toBeCloseTo(0.02);
    const cohortMarkouts = report.markouts.byCohort.find((entry) => entry.cohort === 'paper:velocity');
    expect(cohortMarkouts?.afterBuy[0].expectedAnchors).toBe(50);
    expect(cohortMarkouts?.afterBuy[0].okAnchors).toBe(1);
    expect(cohortMarkouts?.afterBuy[0].rowOkCoverage).toBe(1);
  });

  it('merges projection and legacy ledgers while deduping projection rows by positionId', async () => {
    const legacyOnly = smartV3TradeRows(1, {
      positionId: 'legacy-only',
      kolEntryReason: 'pullback',
      closedAt: '2026-05-02T00:01:00.000Z',
    });
    const duplicatedLegacy = smartV3TradeRows(1, {
      positionId: 'same-position',
      kolEntryReason: 'velocity',
      netSol: -0.01,
      closedAt: '2026-05-02T00:02:00.000Z',
    });
    const duplicatedProjection = smartV3TradeRows(1, {
      positionId: 'same-position',
      kolEntryReason: 'velocity',
      netSol: 0.02,
      closedAt: '2026-05-02T00:02:00.000Z',
    });
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([...legacyOnly, ...duplicatedLegacy]));
    await writeFile(path.join(dir, 'smart-v3-paper-trades.jsonl'), jsonl(duplicatedProjection));
    await writeFile(path.join(dir, 'smart-v3-live-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));

    const report = await buildSmartV3EvidenceReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [30, 60, 300, 1800],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.002,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.tradeRows.paperRows).toBe(2);
    const all = report.tradeRows.byCohort.find((entry) => entry.cohort === 'paper:all');
    expect(all?.netSol).toBeCloseTo(0.021);
    expect(report.tradeRows.byCohort.find((entry) => entry.cohort === 'paper:pullback')?.rows).toBe(1);
    expect(report.tradeRows.byCohort.find((entry) => entry.cohort === 'paper:velocity')?.rows).toBe(1);
  });

  it('uses per-close smart-v3 copyable-edge fields when present', async () => {
    await writeFile(path.join(dir, 'smart-v3-paper-trades.jsonl'), jsonl(smartV3TradeRows(50, {
      smartV3CopyableEdge: {
        schemaVersion: 'smart-v3-copyable-edge/v1',
        shadowOnly: true,
        pass: false,
        reason: 'copyable_net_non_positive',
        copyableNetSol: -0.001,
      },
    })));
    await writeFile(path.join(dir, 'smart-v3-live-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(smartV3MarkoutRows(50, [30, 60, 300, 1800], 0.05)));

    const report = await buildSmartV3EvidenceReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [30, 60, 300, 1800],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.002,
      assumedNetworkFeeSol: 0.0001,
    });

    const cohort = report.tradeRows.byCohort.find((entry) => entry.cohort === 'paper:velocity');
    expect(cohort?.copyableEdgeRows).toBe(50);
    expect(cohort?.copyablePassRows).toBe(0);
    expect(cohort?.wins).toBe(0);
    expect(cohort?.tokenOnlyWins).toBe(50);
    expect(cohort?.rentAdjustedNetSol).toBeCloseTo(-0.05);
  });

  it('rejects non-positive copyable smart-v3 cohorts without tail evidence', async () => {
    await writeFile(path.join(dir, 'smart-v3-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'smart-v3-live-trades.jsonl'), jsonl(smartV3TradeRows(50, {
      mode: 'live',
      netSol: -0.001,
      netSolTokenOnly: -0.0005,
      mfePctPeak: 0.08,
      exitReason: 'probe_hard_cut',
    })));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(
      smartV3MarkoutRows(50, [30, 60, 300, 1800], 0.02)
        .map((row) => ({ ...row, extras: { ...(row.extras as object), mode: 'live' }, positionId: String(row.positionId).replace('paper', 'live') })),
    ));

    const report = await buildSmartV3EvidenceReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [30, 60, 300, 1800],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.002,
      assumedNetworkFeeSol: 0.0001,
    });

    const verdict = report.evidenceVerdicts.find((entry) => entry.cohort === 'live:velocity');
    expect(verdict?.verdict).toBe('COST_REJECT');
    expect(verdict?.fiveXRows).toBe(0);
  });
});
