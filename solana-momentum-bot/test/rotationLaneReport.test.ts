import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildRotationLaneReport,
  renderRotationLaneReportMarkdown,
} from '../scripts/rotation-lane-report';

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

describe('rotation-lane-report', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'rotation-lane-report-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports postCostDelta by subtracting the configured round-trip cost', async () => {
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        positionId: 'rot-pos-1',
        tokenMint: 'MintRotation111111111111111111111111111',
        signalSource: 'kol_hunter_rotation_v1',
        horizonSec: 60,
        quoteStatus: 'ok',
        deltaPct: 0.004,
        recordedAt: '2026-05-02T00:01:00.000Z',
        extras: { rotationAnchorKols: ['dv'] },
      },
      {
        anchorType: 'buy',
        positionId: 'rot-pos-2',
        tokenMint: 'MintRotation222222222222222222222222222',
        signalSource: 'kol_hunter_rotation_v1',
        horizonSec: 60,
        quoteStatus: 'ok',
        deltaPct: 0.02,
        recordedAt: '2026-05-02T00:02:00.000Z',
        extras: { rotationAnchorKols: ['dv'] },
      },
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        tokenMint: 'MintNoTrade11111111111111111111111111',
        lane: 'kol_hunter',
        rejectReason: 'rotation_v1_insufficient_price_response',
        signalSource: 'kol_hunter_rotation_v1',
        rejectedAt: '2026-05-02T00:03:00.000Z',
        extras: { eventType: 'rotation_no_trade', noTradeReason: 'insufficient_price_response' },
        probe: {
          offsetSec: 60,
          firedAt: '2026-05-02T00:04:00.000Z',
          deltaPct: 0.004,
          quoteStatus: 'ok',
        },
      },
    ]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [60],
      roundTripCostPct: 0.005,
    });

    const afterBuy60 = report.tradeMarkouts.afterBuy[0];
    expect(afterBuy60.positiveRows).toBe(2);
    expect(afterBuy60.positivePostCostRows).toBe(1);
    expect(afterBuy60.avgPostCostDeltaPct).toBeCloseTo(0.007);

    const noTrade60 = report.noTrade.byHorizon[0];
    expect(noTrade60.positiveRows).toBe(1);
    expect(noTrade60.positivePostCostRows).toBe(0);
    expect(noTrade60.medianPostCostDeltaPct).toBeCloseTo(-0.001);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('Round-trip cost assumption: 0.50%');
    expect(markdown).toContain('postCostDelta');
  });

  it('adds a diagnostic KOL transfer posterior section for rotation fit', async () => {
    const transferFile = path.join(dir, 'kol-transfers.jsonl');
    const kolDbPath = path.join(dir, 'wallets.json');
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(kolDbPath, JSON.stringify({
      kols: [
        { id: 'dv', addresses: ['DV111'], tier: 'A', is_active: true, trading_style: 'rotator' },
        { id: 'decu', addresses: ['DECU111'], tier: 'A', is_active: true, trading_style: 'scalper' },
      ],
    }), 'utf8');
    await writeFile(transferFile, jsonl([
      {
        kolId: 'dv',
        kolAddress: 'DV111',
        kolTier: 'S',
        laneRole: 'rotation_anchor',
        tradingStyle: 'rotator',
        walletDirection: 'out',
        transfer: {
          signature: 'buy1',
          blockTime: 1_778_870_400,
          slot: 1,
          type: 'TRANSFER',
          mint: 'So11111111111111111111111111111111111111112',
          uiAmount: '0.5',
          amount: '500000000',
        },
      },
      {
        kolId: 'dv',
        kolAddress: 'DV111',
        kolTier: 'S',
        laneRole: 'rotation_anchor',
        tradingStyle: 'rotator',
        walletDirection: 'in',
        transfer: {
          signature: 'buy1',
          blockTime: 1_778_870_400,
          slot: 1,
          type: 'TRANSFER',
          mint: 'MintRotationPosterior11111111111111111',
          uiAmount: '1000',
          amount: '1000',
        },
      },
    ]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15],
      roundTripCostPct: 0.005,
      kolTransferInput: transferFile,
      kolDbPath,
    });

    expect(report.kolTransferPosterior.rows).toBe(2);
    expect(report.kolTransferPosterior.topRotationFit[0].kolId).toBe('dv');
    expect(report.kolTransferPosterior.coverageSummary).toMatchObject({
      targets: 2,
      ok: 1,
      stale: 0,
      missing: 1,
      rotationTargets: 2,
    });
    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('KOL Transfer Posterior — Rotation Fit');
    expect(markdown).toContain('Diagnostic only');
    expect(markdown).toContain('### Coverage');
    expect(markdown).toContain('| decu | A | - | scalper | yes | missing |');
  });

  it('counts skipped rotation paper arms as no-trade markouts', async () => {
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        tokenMint: 'MintSkip111111111111111111111111111111',
        lane: 'kol_hunter',
        rejectReason: 'rotation_arm_skip_cost_response_too_low',
        signalSource: 'rotation_cost_guard_v1',
        rejectedAt: '2026-05-02T00:03:00.000Z',
        extras: {
          eventType: 'rotation_arm_skip',
          noTradeReason: 'rotation_cost_guard_v1_cost_response_too_low',
          armName: 'rotation_cost_guard_v1',
        },
        probe: {
          offsetSec: 15,
          firedAt: '2026-05-02T00:03:15.000Z',
          deltaPct: 0.02,
          quoteStatus: 'ok',
        },
      },
    ]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15],
      roundTripCostPct: 0.005,
    });

    expect(report.noTrade.totalRows).toBe(1);
    expect(report.noTrade.byHorizon[0].positivePostCostRows).toBe(1);
    expect(report.noTrade.byReason[0]).toMatchObject({
      reason: 'rotation_cost_guard_v1_cost_response_too_low',
      count: 1,
      okRows: 1,
      positivePostCostRows: 1,
    });
  });

  it('joins rotation T+60 markouts with token-quality dev candidate buckets', async () => {
    const candidateFile = path.join(dir, 'dev-candidates.json');
    await writeFile(candidateFile, JSON.stringify({
      version: 'candidate-v1',
      paper_only: true,
      generated_at: '2026-05-02',
      candidates: [
        {
          id: 'core_dev',
          addresses: ['DEV1'],
          lane: 'core',
          risk_class: 'low',
          status: 'candidate',
          source_tier: 'A',
        },
      ],
    }), 'utf8');
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        positionId: 'rot-pos-dev',
        tokenMint: 'MintRotationDev1111111111111111111111111',
        signalSource: 'kol_hunter_rotation_v1',
        horizonSec: 60,
        quoteStatus: 'ok',
        deltaPct: 0.03,
        recordedAt: '2026-05-02T00:01:00.000Z',
        extras: { rotationAnchorKols: ['decu'] },
      },
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([
      {
        schemaVersion: 'token-quality/v1',
        tokenMint: 'MintRotationDev1111111111111111111111111',
        observedAt: '2026-05-02T00:00:30.000Z',
        creatorAddress: 'DEV1',
        operatorDevStatus: 'watchlist',
        observationContext: { positionId: 'rot-pos-dev', armName: 'kol_hunter_rotation_v1' },
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [60],
      roundTripCostPct: 0.005,
      candidateFile,
    });

    const risk = report.byDevQuality.find((row) => row.bucket === 'DEV_CANDIDATE_RISK_LOW');
    const status = report.byDevQuality.find((row) => row.bucket === 'DEV_STATUS_WATCHLIST');
    expect(risk?.okRows).toBe(1);
    expect(risk?.medianPostCostDeltaPct60s).toBeCloseTo(0.025);
    expect(status?.positivePostCost60s).toBe(1);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Dev Quality T+60');
    expect(markdown).toContain('DEV_CANDIDATE_RISK_LOW');
    expect(markdown).toContain('DEV_STATUS_WATCHLIST');
  });

  it('summarizes rotation paper arms with refund-adjusted and wallet-drag stress PnL', async () => {
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_fast15_v1',
        parameterVersion: 'rotation-fast15-v1.0.0',
        kolEntryReason: 'rotation_v1',
        positionId: 'rot-fast-1',
        closedAt: '2026-05-02T00:01:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 18,
        netSol: 0.002,
        netSolTokenOnly: 0.003,
        rotationMonetizableEdge: {
          pass: true,
          ticketSol: 0.02,
          bleedTotalSol: 0.0008,
          requiredGrossMovePct: 0.14,
        },
        rotationFlowMetrics: {
          topupStrength: 0.25,
          sellPressure30: 0,
          anchorBuySolBeforeFirstSell: 1.2,
          freshTopup: true,
        },
        survivalFlags: ['TOKEN_QUALITY_UNKNOWN'],
      },
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_cost_guard_v1',
        parameterVersion: 'rotation-cost-guard-v1.0.0',
        kolEntryReason: 'rotation_v1',
        positionId: 'rot-cost-1',
        closedAt: '2026-05-02T00:02:00.000Z',
        exitReason: 'probe_hard_cut',
        holdSec: 24,
        netSol: -0.001,
        netSolTokenOnly: 0.001,
        rotationMonetizableEdge: {
          pass: false,
          costRatio: 0.12,
          requiredGrossMovePct: 0.12,
        },
        rotationFlowMetrics: {
          topupStrength: 0,
          sellPressure30: 0.9,
          anchorBuySolBeforeFirstSell: 0.4,
          freshTopup: false,
        },
        survivalFlags: ['UNCLEAN_TOKEN:top10_80pct', 'EXIT_LIQUIDITY_UNKNOWN'],
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        positionId: 'rot-fast-1',
        tokenMint: 'MintRotationFast111111111111111111111111',
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: 0.03,
        recordedAt: '2026-05-02T00:01:15.000Z',
        extras: { armName: 'rotation_fast15_v1', entryReason: 'rotation_v1' },
      },
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.001,
      assumedNetworkFeeSol: 0.0001,
    });

    const fast = report.paperTrades.byArm.find((row) => row.armName === 'rotation_fast15_v1');
    const cost = report.paperTrades.byArm.find((row) => row.armName === 'rotation_cost_guard_v1');
    expect(fast?.rows).toBe(1);
    expect(fast?.wins).toBe(1);
    expect(fast?.refundAdjustedNetSol).toBeCloseTo(0.0029);
    expect(fast?.rentAdjustedNetSol).toBeCloseTo(0.0019);
    expect(fast?.edgePassRows).toBe(1);
    expect(fast?.medianEdgeCostRatio).toBeCloseTo(0.04);
    expect(fast?.medianRequiredGrossMovePct).toBeCloseTo(0.04);
    expect(report.paperTrades.winnerEntryPairings.find((row) =>
      row.armName === 'rotation_fast15_v1' && row.exitBucket === 'winner_trailing_t1'
    )?.refundAdjustedNetSol).toBeCloseTo(0.0029);
    expect(report.paperTrades.winnerEntryDiagnostics.find((row) =>
      row.armName === 'rotation_fast15_v1' && row.exitBucket === 'winner_trailing_t1'
    )).toMatchObject({
      medianTopupStrength: 0.25,
      medianSellPressure30: 0,
      medianAnchorBuySol: 1.2,
      freshTopupRate: 1,
      unknownQualityRate: 1,
    });
    expect(report.paperTrades.winnerEntryDiagnostics.find((row) =>
      row.armName === 'rotation_cost_guard_v1' && row.exitBucket === 'other_exits'
    )?.highRiskFlagRate).toBe(1);
    expect(cost?.refundAdjustedNetSol).toBeCloseTo(0.0009);
    expect(cost?.rentAdjustedNetSol).toBeCloseTo(-0.0001);
    expect(cost?.edgeFailRows).toBe(1);
    expect(cost?.medianRequiredGrossMovePct).toBeCloseTo(0.12);
    expect(report.tradeMarkouts.byArm[0].armName).toBe('rotation_fast15_v1');
    expect(report.tradeMarkouts.byArm[0].afterBuy[0].positivePostCostRows).toBe(1);
    expect(report.evidenceVerdicts.find((row) => row.armName === 'rotation_fast15_v1')?.verdict).toBe('COLLECT');

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Paper Trades By Arm');
    expect(markdown).toContain('## Winner Entry Pairing');
    expect(markdown).toContain('## Winner Entry Diagnostics');
    expect(markdown).toContain('med sellPressure30');
    expect(markdown).toContain('## Evidence Verdict By Arm');
    expect(markdown).toContain('rotation_fast15_v1');
    expect(markdown).toContain('edge pass/fail');
    expect(markdown).toContain('refund-adjusted');
    expect(markdown).toContain('wallet-drag stress');
    expect(markdown).toContain('required gross move');
    expect(markdown).toContain('## Markouts By Arm');
  });

  it('classifies sufficiently sampled arms with poor monetizable-edge evidence as cost rejects', async () => {
    const armName = 'rotation_cost_guard_v1';
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl(
      Array.from({ length: 50 }, (_, index) => ({
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName,
        parameterVersion: 'rotation-cost-guard-v1.0.0',
        kolEntryReason: 'rotation_v1',
        positionId: `rot-cost-${index}`,
        closedAt: `2026-05-02T00:${String(index).padStart(2, '0')}:00.000Z`,
        exitReason: 'probe_hard_cut',
        holdSec: 20,
        netSol: -0.001,
        netSolTokenOnly: 0.001,
        rotationMonetizableEdge: {
          pass: false,
          costRatio: 0.12,
          requiredGrossMovePct: 0.12,
        },
      }))
    ));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(
      Array.from({ length: 50 }, (_, index) => [15, 30, 60].map((horizonSec) => ({
        anchorType: 'buy',
        positionId: `rot-cost-${index}`,
        tokenMint: `MintRotationCost${index}`,
        horizonSec,
        quoteStatus: 'ok',
        deltaPct: 0.02,
        recordedAt: `2026-05-02T00:${String(index).padStart(2, '0')}:30.000Z`,
        extras: { armName, entryReason: 'rotation_v1' },
      }))).flat()
    ));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30, 60],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.001,
      assumedNetworkFeeSol: 0.0001,
    });

    const verdict = report.evidenceVerdicts.find((row) => row.armName === armName);
    expect(verdict?.verdict).toBe('COST_REJECT');
    expect(verdict?.closes).toBe(50);
    expect(verdict?.minOkCoverage).toBe(1);
    expect(verdict?.edgeCoverage).toBe(1);
    expect(verdict?.edgePassRate).toBe(0);
    expect(verdict?.refundAdjustedNetSol).toBeGreaterThan(0);
    expect(verdict?.rentAdjustedNetSol).toBeLessThan(0);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('COST_REJECT');
    expect(markdown).toContain('edge pass 0.00% < 50.00%');
  });

  it('requires T+15 and T+30 coverage before judging sampled arms', async () => {
    const armName = 'rotation_fast15_v1';
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl(
      Array.from({ length: 50 }, (_, index) => ({
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName,
        parameterVersion: 'rotation-fast15-v1.0.0',
        kolEntryReason: 'rotation_v1',
        positionId: `rot-fast-${index}`,
        closedAt: `2026-05-02T00:${String(index).padStart(2, '0')}:00.000Z`,
        exitReason: 'winner_trailing_t1',
        holdSec: 18,
        netSol: 0.002,
        netSolTokenOnly: 0.004,
        rotationMonetizableEdge: {
          pass: true,
          costRatio: 0.04,
          requiredGrossMovePct: 0.04,
        },
      }))
    ));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(
      Array.from({ length: 50 }, (_, index) => ({
        anchorType: 'buy',
        positionId: `rot-fast-${index}`,
        tokenMint: `MintRotationFastMissing${index}`,
        horizonSec: 60,
        quoteStatus: 'ok',
        deltaPct: 0.03,
        recordedAt: `2026-05-02T00:${String(index).padStart(2, '0')}:30.000Z`,
        extras: { armName, entryReason: 'rotation_v1' },
      }))
    ));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30, 60],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.001,
      assumedNetworkFeeSol: 0.0001,
    });

    const verdict = report.evidenceVerdicts.find((row) => row.armName === armName);
    expect(verdict?.verdict).toBe('DATA_GAP');
    expect(verdict?.minOkCoverage).toBe(0);
    expect(verdict?.requiredHorizonCoverage).toEqual([
      { horizonSec: 15, okCoverage: 0 },
      { horizonSec: 30, okCoverage: 0 },
    ]);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('T+15s ok coverage 0.00% < 80.00%');
    expect(markdown).toContain('T+30s ok coverage 0.00% < 80.00%');
  });

  it('uses T+15/T+30 as primary edge and treats T+60 weakness as decay warning', async () => {
    const armName = 'kol_hunter_rotation_v1';
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl(
      Array.from({ length: 100 }, (_, index) => ({
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName,
        parameterVersion: 'rotation-v1.0.0',
        kolEntryReason: 'rotation_v1',
        positionId: `rot-control-${index}`,
        closedAt: `2026-05-02T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        exitReason: 'winner_trailing_t1',
        holdSec: 18,
        netSol: 0.002,
        netSolTokenOnly: 0.003,
        rotationMonetizableEdge: {
          pass: true,
          costRatio: 0.04,
          requiredGrossMovePct: 0.04,
        },
      }))
    ));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(
      Array.from({ length: 100 }, (_, index) => [15, 30, 60].map((horizonSec) => ({
        anchorType: 'buy',
        positionId: `rot-control-${index}`,
        tokenMint: `MintRotationControl${index}`,
        horizonSec,
        quoteStatus: 'ok',
        deltaPct: horizonSec === 15 ? 0.03 : horizonSec === 30 ? 0.02 : -0.02,
        recordedAt: `2026-05-02T00:${String(index % 60).padStart(2, '0')}:30.000Z`,
        extras: { armName, entryReason: 'rotation_v1' },
      }))).flat()
    ));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30, 60],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.001,
      assumedNetworkFeeSol: 0.0001,
    });

    const verdict = report.evidenceVerdicts.find((row) => row.armName === armName);
    expect(verdict?.verdict).toBe('PROMOTION_CANDIDATE');
    expect(verdict?.primaryHorizonSec).toBe(15);
    expect(verdict?.primaryMedianPostCostDeltaPct).toBeCloseTo(0.025);
    expect(verdict?.decayMedianPostCostDeltaPct).toBeCloseTo(-0.025);
    expect(verdict?.reasons).toContain('T+60s decay warning -2.50% <= 0');
    expect(verdict?.reasons).toContain('promotion evidence threshold met');

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('primary postCost');
    expect(markdown).toContain('T+15s 2.50%, T+30s 1.50%');
    expect(markdown).toContain('T+60 decay');
  });

  it('rejects promotion when T+15 is positive but T+30 has already decayed below cost', async () => {
    const armName = 'kol_hunter_rotation_v1';
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl(
      Array.from({ length: 100 }, (_, index) => ({
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName,
        parameterVersion: 'rotation-v1.0.0',
        kolEntryReason: 'rotation_v1',
        positionId: `rot-decay-${index}`,
        closedAt: `2026-05-02T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        exitReason: 'winner_trailing_t1',
        holdSec: 18,
        netSol: 0.002,
        netSolTokenOnly: 0.003,
        rotationMonetizableEdge: {
          pass: true,
          costRatio: 0.04,
          requiredGrossMovePct: 0.04,
        },
      }))
    ));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(
      Array.from({ length: 100 }, (_, index) => [15, 30].map((horizonSec) => ({
        anchorType: 'buy',
        positionId: `rot-decay-${index}`,
        tokenMint: `MintRotationDecay${index}`,
        horizonSec,
        quoteStatus: 'ok',
        deltaPct: horizonSec === 15 ? 0.03 : -0.01,
        recordedAt: `2026-05-02T00:${String(index % 60).padStart(2, '0')}:30.000Z`,
        extras: { armName, entryReason: 'rotation_v1' },
      }))).flat()
    ));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.001,
      assumedNetworkFeeSol: 0.0001,
    });

    const verdict = report.evidenceVerdicts.find((row) => row.armName === armName);
    expect(verdict?.verdict).toBe('POST_COST_REJECT');
    expect(verdict?.primaryHorizonSec).toBe(15);
    expect(verdict?.primaryHorizonPostCost).toEqual([
      { horizonSec: 15, medianPostCostDeltaPct: 0.024999999999999998 },
      { horizonSec: 30, medianPostCostDeltaPct: -0.015 },
    ]);
    expect(verdict?.reasons).toContain('T+30s median postCost -1.50% <= 0');
  });

  it('splits after-sell markouts into final close, partial reduce, and hard-cut cohorts', async () => {
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'sell',
        positionId: 'rot-final-1',
        tokenMint: 'MintFinal1111111111111111111111111111',
        signalSource: 'rotation_exit_kol_flow_v1',
        horizonSec: 30,
        quoteStatus: 'ok',
        deltaPct: 0.02,
        recordedAt: '2026-05-02T00:01:30.000Z',
        extras: { eventType: 'paper_close', exitReason: 'winner_trailing_t1', armName: 'rotation_exit_kol_flow_v1' },
      },
      {
        anchorType: 'sell',
        positionId: 'rot-partial-1',
        tokenMint: 'MintPartial111111111111111111111111111',
        signalSource: 'rotation_exit_kol_flow_v1',
        horizonSec: 30,
        quoteStatus: 'ok',
        deltaPct: -0.01,
        recordedAt: '2026-05-02T00:02:30.000Z',
        extras: { eventType: 'rotation_flow_reduce', exitReason: 'medium_sell_pressure', armName: 'rotation_exit_kol_flow_v1' },
      },
      {
        anchorType: 'sell',
        positionId: 'rot-hardcut-1',
        tokenMint: 'MintHardcut111111111111111111111111111',
        signalSource: 'rotation_exit_kol_flow_v1',
        horizonSec: 30,
        quoteStatus: 'ok',
        deltaPct: 0.10,
        recordedAt: '2026-05-02T00:03:30.000Z',
        extras: { eventType: 'paper_close', exitReason: 'probe_hard_cut', armName: 'rotation_exit_kol_flow_v1' },
      },
      {
        anchorType: 'sell',
        positionId: 'rot-mae-fast-fail-1',
        tokenMint: 'MintMaeFastFail111111111111111111111',
        signalSource: 'rotation_exit_kol_flow_v1',
        horizonSec: 30,
        quoteStatus: 'ok',
        deltaPct: -0.02,
        recordedAt: '2026-05-02T00:04:30.000Z',
        extras: { eventType: 'paper_close', exitReason: 'rotation_mae_fast_fail', armName: 'rotation_exit_kol_flow_v1' },
      },
    ]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [30],
      roundTripCostPct: 0.005,
    });

    expect(report.tradeMarkouts.afterSell[0].rows).toBe(4);
    expect(report.tradeMarkouts.afterSellFinal[0].rows).toBe(3);
    expect(report.tradeMarkouts.afterSellPartial[0].rows).toBe(1);
    expect(report.tradeMarkouts.afterSellHardCut[0].rows).toBe(2);
    expect(report.tradeMarkouts.afterSellMaeFastFail[0].rows).toBe(1);
    expect(report.tradeMarkouts.afterSellPartial[0].medianPostCostDeltaPct).toBeCloseTo(-0.015);
    expect(report.tradeMarkouts.afterSellHardCut[0].positivePostCostRows).toBe(1);
    expect(report.tradeMarkouts.afterSellMaeFastFail[0].positivePostCostRows).toBe(0);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('After Sell — Final Close Only');
    expect(markdown).toContain('After Sell — Partial/Reduce Only');
    expect(markdown).toContain('After Sell — Hard Cut Cohort');
    expect(markdown).toContain('After Sell — MAE Fast-Fail Cohort');
  });
});
