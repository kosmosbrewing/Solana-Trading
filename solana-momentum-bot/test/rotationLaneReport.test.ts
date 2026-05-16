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

function readyUnderfillPaperRows(armName: string): unknown[] {
  return Array.from({ length: 50 }, (_, index) => ({
    strategy: 'kol_hunter',
    lane: 'kol_hunter',
    armName: 'rotation_underfill_v1',
    profileArm: armName,
    entryArm: 'rotation_underfill_v1',
    kolEntryReason: 'rotation_v1',
    positionId: `underfill-ready-${index}`,
    liveEquivalenceCandidateId: `underfill-ready-candidate-${index}`,
    closedAt: `2026-05-02T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    exitReason: 'winner_trailing_t1',
    holdSec: 30,
    netSol: 0.001,
    netSolTokenOnly: 0.001,
    mfePctPeak: 0.18,
    routeFound: true,
    rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
    kols: [
      { id: 'kol-a', timestamp: `2026-05-02T00:${String(index % 60).padStart(2, '0')}:00.000Z` },
      { id: 'kol-b', timestamp: `2026-05-02T00:${String(index % 60).padStart(2, '0')}:04.000Z` },
    ],
    survivalFlags: ['ROTATION_UNDERFILL_KOLS_2'],
  }));
}

function readyUnderfillMarkoutRows(armName: string): unknown[] {
  return Array.from({ length: 50 }, (_, index) => [15, 30, 60].map((horizonSec) => ({
    anchorType: 'buy',
    positionId: `underfill-ready-${index}`,
    tokenMint: `MintUnderfillReady${index}`,
    horizonSec,
    quoteStatus: 'ok',
    deltaPct: horizonSec === 15 ? 0.03 : 0.02,
    recordedAt: `2026-05-02T00:${String(index % 60).padStart(2, '0')}:30.000Z`,
    extras: { armName, entryReason: 'rotation_v1' },
  }))).flat();
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
        netSolTokenOnly: 0.00005,
        mfePctPeak: 0.12,
        maeAt15s: -0.06,
        maeWorstPct: -0.11,
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
    expect(fast?.t1Rows).toBe(1);
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
    expect(cost?.refundAdjustedNetSol).toBeCloseTo(-0.00005);
    expect(cost?.rentAdjustedNetSol).toBeCloseTo(-0.00105);
    expect(cost?.tokenOnlyWinnerRefundLoserRows).toBe(1);
    expect(cost?.mfe5RefundLoserRows).toBe(1);
    expect(cost?.mfe12RefundLoserRows).toBe(1);
    expect(cost?.mae5Within15Rows).toBe(1);
    expect(cost?.mae10BeforeT1Rows).toBe(1);
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
    expect(markdown).toContain('MFE>=12 refundLose');
    expect(markdown).toContain('T1 hit');
    expect(markdown).toContain('## Markouts By Arm');
  });

  it('splits underfill paper trades into route-known and cost-aware cohorts', async () => {
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_exit_flow_v1',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'underfill-route-known-unknown-kol',
        closedAt: '2026-05-02T00:02:30.000Z',
        exitReason: 'probe_reject_timeout',
        holdSec: 24,
        netSol: -0.0005,
        netSolTokenOnly: -0.0003,
        mfePctPeak: 0.03,
        routeFound: true,
      },
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_exit_flow_v1',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'underfill-route-unknown',
        closedAt: '2026-05-02T00:01:00.000Z',
        exitReason: 'probe_reject_timeout',
        holdSec: 22,
        netSol: -0.001,
        netSolTokenOnly: 0.00005,
        mfePctPeak: 0.05,
        survivalFlags: [
          'EXIT_LIQUIDITY_UNKNOWN',
          'NO_SELL_ROUTE',
          'DECIMALS_SECURITY_CLIENT',
          'TOKEN_QUALITY_UNKNOWN',
          'NO_SECURITY_DATA',
          'JUPITER_429_RATE_LIMIT',
          'ROTATION_UNDERFILL_KOLS_1',
        ],
      },
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_exit_flow_v1',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'underfill-route-known-single',
        closedAt: '2026-05-02T00:02:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 26,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        mfePctPeak: 0.14,
        routeFound: true,
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_1'],
      },
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'underfill-route-known-cost-aware',
        closedAt: '2026-05-02T00:03:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.002,
        netSolTokenOnly: 0.0024,
        mfePctPeak: 0.18,
        routeFound: true,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_2'],
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.underfillRouteCohorts.find((row) => row.cohort === 'underfill_all')).toMatchObject({
      rows: 4,
      routeKnownRows: 3,
      routeUnknownRows: 1,
      independentKol2Rows: 1,
      unknownKolRows: 1,
      costAwareRows: 1,
    });
    const readyCohort = report.underfillRouteCohorts.find((row) =>
      row.cohort === 'route_known_2kol_cost_aware'
    );
    expect(readyCohort).toMatchObject({ rows: 1, edgePassRows: 1, t1Rows: 1 });
    expect(readyCohort?.refundAdjustedNetSol).toBeCloseTo(0.0023);
    expect(report.underfillKolCohorts.find((row) => row.cohort === 'underfill_1kol')).toMatchObject({
      rows: 2,
      routeKnownRows: 1,
      routeUnknownRows: 1,
    });
    expect(report.underfillKolCohorts.find((row) => row.cohort === 'underfill_2plus_kol')).toMatchObject({
      rows: 1,
      routeKnownRows: 1,
      routeUnknownRows: 0,
      costAwareRows: 1,
    });
    expect(report.underfillKolCohorts.find((row) => row.cohort === 'underfill_unknown_kol')).toMatchObject({
      rows: 1,
      routeKnownRows: 1,
      routeUnknownRows: 0,
      unknownKolRows: 1,
    });
    expect(report.routeUnknownReasons.find((row) => row.reason === 'EXIT_LIQUIDITY_UNKNOWN')).toMatchObject({
      rows: 1,
      losses: 1,
      t1Rows: 0,
    });
    expect(report.routeTruthAudit.find((row) => row.bucket === 'route_unknown:infra_retry')).toMatchObject({
      rows: 1,
      routeKnownRows: 0,
      routeUnknownRows: 1,
      recoverability: 'infra_retry',
    });
    expect(report.routeTruthAudit.find((row) => row.bucket === 'route_known:routeFound')).toMatchObject({
      rows: 3,
      routeKnownRows: 3,
      routeUnknownRows: 0,
      recoverability: 'ready',
    });
    expect(report.underfillKolTiming.find((row) => row.bucket === '1kol')).toMatchObject({
      rows: 2,
      routeKnownRows: 1,
      medianSecondKolDelaySec: null,
    });
    expect(report.underfillKolTiming.find((row) => row.bucket === '2plus_unknown_timing')).toMatchObject({
      rows: 1,
      routeKnownRows: 1,
      costAwareRows: 1,
    });
    expect(report.underfillKolTiming.find((row) => row.bucket === 'unknown_kol_count')).toMatchObject({
      rows: 1,
      routeKnownRows: 1,
    });
    expect(report.paperCohortValidity.find((row) =>
      row.cohort === '2kol_route_known_cost_aware'
    )).toMatchObject({
      rows: 1,
      candidateIdRows: 0,
      independentKolRows: 1,
      routeProofRows: 1,
      costAwareRows: 1,
      unknownTimingRows: 1,
    });
    expect(report.reviewCohortEvidence).toMatchObject({
      cohort: 'route_known_2kol_cost_aware',
      closes: 1,
      candidateIdRows: 0,
      routeProofRows: 1,
      timestampedSecondKolRows: 0,
    });
    expect(report.reviewCohortGenerationAudit).toMatchObject({
      cohort: 'route_known_2kol_cost_aware',
      underfillRows: 4,
      routeKnownRows: 3,
      routeKnownTwoPlusRows: 1,
      routeKnownCostAwareRows: 1,
      reviewRows: 1,
      missingRouteProofRows: 1,
      missingCandidateIdRows: 4,
    });
    for (const reason of [
      'NO_SELL_ROUTE',
      'DECIMALS_SECURITY_CLIENT',
      'TOKEN_QUALITY_UNKNOWN',
      'NO_SECURITY_DATA',
      'JUPITER_429',
    ]) {
      expect(report.routeUnknownReasons.find((row) => row.reason === reason)).toMatchObject({
        rows: 1,
        losses: 1,
      });
    }
    expect(report.compoundProfiles.find((row) => row.cohort === 'route_known_2kol_cost_aware')).toMatchObject({
      rows: 1,
      postCostPositiveRate: 1,
      t1Rate: 1,
      maxLosingStreak: 0,
      winnerRows: 1,
      nonWinnerRows: 0,
    });
    expect(report.rotationLiveReadiness).toMatchObject({
      verdict: 'COLLECT',
      cohort: 'route_known_2kol_cost_aware',
      closes: 1,
    });
    expect(report.rotationPaperCompoundReadiness).toMatchObject({
      verdict: 'COLLECT',
      cohort: 'route_known_2kol_cost_aware',
      closes: 1,
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Underfill Route Cohorts');
    expect(markdown).toContain('## Underfill KOL Cohorts');
    expect(markdown).toContain('## Route Unknown Reasons');
    expect(markdown).toContain('Reasons are non-exclusive');
    expect(markdown).toContain('## Route Truth Audit');
    expect(markdown).toContain('## Underfill KOL Timing');
    expect(markdown).toContain('## Paper Cohort Validity');
    expect(markdown).toContain('## Review Cohort Generation Audit');
    expect(markdown).toContain('## Review Cohort Evidence');
    expect(markdown).toContain('## Rotation Compound Profile');
    expect(markdown).toContain('## Rotation Paper Compound Readiness');
    expect(markdown).toContain('sample >=50');
    expect(markdown).toContain('postCost>0 >=55%');
    expect(markdown).toContain('## Rotation Live Readiness');
    expect(markdown).toContain('## Rotation Live Sync Checklist');
    expect(markdown).toContain('WAIT_PAPER_EVIDENCE');
    expect(markdown).toContain('route_known_2kol_cost_aware');
    expect(markdown).toContain('Report-only');
  });

  it('marks cost-aware underfill as micro-live ready only after route-known post-cost evidence', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl(readyUnderfillPaperRows(armName)));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(readyUnderfillMarkoutRows(armName)));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30, 60],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationLiveReadiness).toMatchObject({
      armName,
      verdict: 'READY_FOR_MICRO_LIVE',
      closes: 50,
      evidenceVerdict: 'WATCH',
    });
    expect(report.rotationLiveReadiness.postCostPositiveRate).toBe(1);
    expect(report.rotationLiveReadiness.edgePassRate).toBe(1);
    expect(report.rotationLiveReadiness.minOkCoverage).toBe(1);
    expect(report.rotationLiveReadiness.primaryHorizonPostCost).toEqual([
      { horizonSec: 15, medianPostCostDeltaPct: 0.024999999999999998 },
      { horizonSec: 30, medianPostCostDeltaPct: 0.015 },
    ]);
    expect(report.rotationPaperCompoundReadiness).toMatchObject({
      armName,
      verdict: 'PAPER_READY',
      closes: 50,
      postCostPositiveRate: 1,
      edgePassRate: 1,
      minOkCoverage: 1,
    });
    expect(report.rotationCompoundFitness).toMatchObject({
      cohort: 'route_known_2kol_cost_aware',
      verdict: 'PASS',
      closes: 50,
      maxLosingStreak: 0,
      winnerCoversBleed: true,
    });
    expect(report.reviewCohortDecision).toMatchObject({
      cohort: 'route_known_2kol_cost_aware',
      verdict: 'PASS',
      closes: 50,
      maxLosingStreak: 0,
    });
    expect(report.reviewCohortEvidence).toMatchObject({
      closes: 50,
      candidateIdRows: 50,
      routeProofRows: 50,
      timestampedSecondKolRows: 50,
      liveEquivalenceRows: 0,
    });
    expect(report.paperCohortValidity.find((row) =>
      row.cohort === '2kol_route_known_cost_aware_secondKOL<=30s'
    )).toMatchObject({
      rows: 50,
      participantTimestampRows: 50,
      unknownTimingRows: 0,
    });
    expect(report.paperExitProxies.find((row) =>
      row.cohort === '2kol_route_known_cost_aware' &&
      row.exitProfile === 'current_close'
    )).toMatchObject({
      rows: 50,
      observedRows: 50,
      positiveRows: 50,
      maxLosingStreak: 0,
    });
    expect(report.paperExitProxies.find((row) =>
      row.cohort === '2kol_route_known_cost_aware' &&
      row.exitProfile === 'cost_aware_t1_primary_proxy'
    )).toMatchObject({
      rows: 50,
      observedRows: 50,
      targetHitRows: 0,
      positiveRows: 50,
      medianPostCostDeltaPct: 0.024999999999999998,
    });
    expect(report.paperExitProxies.find((row) =>
      row.cohort === '2kol_route_known_cost_aware' &&
      row.exitProfile === 'cap_45s_nearest_proxy'
    )).toMatchObject({
      rows: 50,
      observedRows: 50,
      proxyHorizonSec: 30,
      medianPostCostDeltaPct: 0.015,
    });
    expect(report.paperExitProxies.find((row) =>
      row.cohort === '2kol_route_known_cost_aware_secondKOL<=30s' &&
      row.exitProfile === 'current_close'
    )).toMatchObject({
      rows: 50,
      observedRows: 50,
      positiveRows: 50,
    });
    expect(report.microLiveReviewPacket).toMatchObject({
      verdict: 'WAIT_LIVE_EQUIVALENCE_DATA',
      paperVerdict: 'PAPER_READY',
      liveVerdict: 'READY_FOR_MICRO_LIVE',
      compoundVerdict: 'PASS',
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('PAPER_READY');
    expect(markdown).toContain('live-equivalent paper compound gate passed');
    expect(markdown).toContain('READY_FOR_MICRO_LIVE');
    expect(markdown).toContain('WAIT_LIVE_EQUIVALENCE_DATA');
    expect(markdown).toContain('## Rotation Compound Fitness Gate');
    expect(markdown).toContain('## Review Cohort Decision');
    expect(markdown).toContain('## Micro Live Review Packet');
    expect(markdown).toContain('## Paper Exit Proxy Comparison');
    expect(markdown).toContain('cost_aware_t1_primary_proxy');
    expect(markdown).toContain('2kol_route_known_cost_aware_secondKOL<=30s');
    expect(markdown).toContain('micro-live plan: ticket=0.020 SOL');
    expect(markdown).toContain('route-known 2+KOL cost-aware sample meets report-only micro-live gate');
  });

  it('early-rejects weak review cohorts before 50 closes without changing live routing', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl(
      Array.from({ length: 12 }, (_, index) => ({
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: armName,
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: `underfill-weak-${index}`,
        liveEquivalenceCandidateId: `underfill-weak-candidate-${index}`,
        closedAt: `2026-05-02T00:${String(index).padStart(2, '0')}:00.000Z`,
        exitReason: 'probe_hard_cut',
        holdSec: 20,
        netSol: -0.001,
        netSolTokenOnly: -0.001,
        mfePctPeak: 0.01,
        routeFound: true,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        kols: [
          { id: 'kol-a', timestamp: `2026-05-02T00:${String(index).padStart(2, '0')}:00.000Z` },
          { id: 'kol-b', timestamp: `2026-05-02T00:${String(index).padStart(2, '0')}:04.000Z` },
        ],
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_2', 'SELL_ROUTE_OK'],
      }))
    ));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(
      Array.from({ length: 12 }, (_, index) => [15, 30].map((horizonSec) => ({
        anchorType: 'buy',
        positionId: `underfill-weak-${index}`,
        tokenMint: `MintUnderfillWeak${index}`,
        horizonSec,
        quoteStatus: 'ok',
        deltaPct: 0,
        recordedAt: `2026-05-02T00:${String(index).padStart(2, '0')}:30.000Z`,
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
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.reviewCohortDecision).toMatchObject({
      cohort: 'route_known_2kol_cost_aware',
      verdict: 'EARLY_REJECT',
      closes: 12,
      postCostPositiveRate: 0,
      maxLosingStreak: 12,
    });
    expect(report.reviewCohortDecision.earlyRejectSignals).toEqual(expect.arrayContaining([
      expect.stringContaining('refund-adjusted net'),
      expect.stringContaining('post-cost positive'),
      expect.stringContaining('max losing streak'),
      'T+15/T+30 primary post-cost medians are both non-positive',
    ]));

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Review Cohort Decision');
    expect(markdown).toContain('EARLY_REJECT');
    expect(markdown).toContain('live routing remains unchanged');
  });

  it('keeps ready paper blocked when live-equivalence blockers remain', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl(readyUnderfillPaperRows(armName)));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(readyUnderfillMarkoutRows(armName)));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-live-equivalence.jsonl'), jsonl([
      {
        armName,
        entrySignalLabel: 'rotation-underfill',
        decisionStage: 'yellow_zone',
        liveWouldEnter: false,
        liveAttempted: false,
        independentKolCount: 1,
        liveBlockReason: 'wallet 0.6162 yellow zone requires fresh independentKolCount >= 2',
        generatedAt: '2026-05-02T00:01:00.000Z',
      },
    ]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30, 60],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationPaperCompoundReadiness.verdict).toBe('PAPER_READY');
    expect(report.rotationLiveReadiness.verdict).toBe('READY_FOR_MICRO_LIVE');
    expect(report.liveEquivalence.yellowZoneSingleKolRows).toBe(1);
    expect(report.microLiveReviewPacket.verdict).toBe('WAIT_LIVE_EQUIVALENCE_CLEAR');

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('WAIT_LIVE_EQUIVALENCE_CLEAR');
    expect(markdown).not.toContain('WAIT_PAPER_EVIDENCE');
  });

  it('does not clear micro-live review from unrelated live-equivalence rows', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl(readyUnderfillPaperRows(armName)));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(readyUnderfillMarkoutRows(armName)));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-live-equivalence.jsonl'), jsonl([
      {
        armName: 'rotation_underfill_exit_flow_v1',
        entrySignalLabel: 'rotation-underfill',
        decisionStage: 'pre_execution_live_allowed',
        liveWouldEnter: true,
        liveAttempted: true,
        independentKolCount: 2,
        liveBlockReason: '',
        generatedAt: '2026-05-02T00:01:00.000Z',
      },
    ]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30, 60],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.liveEquivalence.rotationRows).toBe(1);
    expect(report.microLiveReviewPacket).toMatchObject({
      verdict: 'WAIT_LIVE_EQUIVALENCE_DATA',
      liveEquivalenceRows: 0,
      liveEquivalenceBlockers: 0,
    });
  });

  it('marks strict micro-live review ready only with linked live-equivalence and complete metadata', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl(readyUnderfillPaperRows(armName)));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(readyUnderfillMarkoutRows(armName)));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-live-equivalence.jsonl'), jsonl([
      {
        armName,
        entrySignalLabel: 'rotation-underfill',
        candidateId: 'underfill-ready-candidate-0',
        decisionStage: 'pre_execution_live_allowed',
        liveWouldEnter: true,
        liveAttempted: true,
        independentKolCount: 2,
        liveBlockReason: '',
        generatedAt: '2026-05-02T00:01:00.000Z',
      },
    ]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30, 60],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.microLiveReviewPacket).toMatchObject({
      verdict: 'READY_FOR_MICRO_LIVE_REVIEW',
      linkedLiveEquivalenceRows: 1,
      liveEquivalenceRows: 1,
      liveEquivalenceBlockers: 0,
      candidateIdRows: 50,
      routeProofRows: 50,
      timestampedSecondKolRows: 50,
      plan: {
        ticketSol: 0.02,
        maxDailyAttempts: 3,
        dailyLossCapSol: 0.03,
      },
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('READY_FOR_MICRO_LIVE_REVIEW');
    expect(markdown).toContain('linked=1/1, blockers=0');
  });

  it('adds live-equivalence gate review for yellow-zone and route-unknown blockers', async () => {
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_exit_flow_v1',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'blocked-paper-winner',
        liveEquivalenceCandidateId: 'blocked-candidate-1',
        closedAt: '2026-05-02T00:05:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 24,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        mfePctPeak: 0.2,
        routeFound: true,
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_1'],
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-live-equivalence.jsonl'), jsonl([
      {
        armName: 'rotation_underfill_exit_flow_v1',
        entrySignalLabel: 'rotation-underfill',
        candidateId: 'blocked-candidate-1',
        decisionStage: 'yellow_zone',
        liveWouldEnter: false,
        liveAttempted: false,
        independentKolCount: 1,
        liveBlockReason: 'wallet 0.6162 yellow zone requires fresh independentKolCount >= 2',
        generatedAt: '2026-05-02T00:01:00.000Z',
      },
      {
        armName: 'rotation_underfill_exit_flow_v1',
        entrySignalLabel: 'rotation-underfill',
        candidateId: 'blocked-candidate-1',
        decisionStage: 'yellow_zone',
        liveWouldEnter: false,
        liveAttempted: false,
        independentKolCount: 1,
        liveBlockReason: 'wallet 0.6162 yellow zone requires fresh independentKolCount >= 2',
        generatedAt: '2026-05-02T00:01:01.000Z',
      },
      {
        armName: 'rotation_underfill_cost_aware_exit_v2',
        entrySignalLabel: 'rotation-underfill',
        decisionStage: 'pre_execution_live_allowed',
        liveWouldEnter: true,
        liveAttempted: true,
        independentKolCount: 2,
        liveBlockReason: '',
        generatedAt: '2026-05-02T00:02:00.000Z',
      },
      {
        armName: 'rotation_underfill_exit_flow_v1',
        entrySignalLabel: 'rotation-underfill',
        decisionStage: 'rotation_underfill_live_fallback',
        liveWouldEnter: false,
        liveAttempted: false,
        independentKolCount: 2,
        liveBlockReason: 'rotation_underfill_live_exit_route_unknown',
        survivalFlags: ['ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN'],
        generatedAt: '2026-05-02T00:03:00.000Z',
      },
      {
        armName: 'rotation_underfill_exit_flow_v1',
        entrySignalLabel: 'rotation-underfill',
        decisionStage: 'yellow_zone',
        liveWouldEnter: false,
        liveAttempted: false,
        liveBlockReason: 'wallet 0.6162 yellow zone requires fresh independentKolCount >= 2',
        generatedAt: '2026-05-02T00:04:00.000Z',
      },
    ]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.liveEquivalence).toMatchObject({
      totalRows: 5,
      rotationRows: 5,
      liveWouldEnterRows: 1,
      liveAttemptedRows: 1,
      blockedRows: 4,
      yellowZoneRows: 3,
      yellowZoneSingleKolRows: 2,
      yellowZoneTwoPlusKolRows: 0,
      yellowZoneUnknownKolRows: 1,
      routeUnknownFallbackRows: 1,
    });
    expect(report.liveEquivalence.byStage.find((row) => row.bucket === 'yellow_zone')).toMatchObject({
      rows: 3,
      blockedRows: 3,
      singleKolRows: 2,
      unknownKolRows: 1,
    });
    expect(report.liveEquivalence.byBlockReason.find((row) =>
      row.bucket === 'rotation_underfill_live_exit_route_unknown'
    )).toMatchObject({
      rows: 1,
      blockedRows: 1,
      twoPlusKolRows: 1,
    });
    expect(report.liveEquivalenceDrilldown.find((row) =>
      row.bucket.startsWith('yellow_zone:wallet 0.6162 yellow zone')
    )).toMatchObject({
      rows: 3,
      candidateIdRows: 2,
      missingCandidateIdRows: 1,
      unlinkedRows: 0,
      reviewCohortLinkedRows: 0,
      blockedRows: 3,
      paperCloses: 1,
      paperWins: 1,
      blockedPaperWinnerRows: 1,
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Live-Equivalence Gate Review');
    expect(markdown).toContain('## Live-Equivalence Candidate Drilldown');
    expect(markdown).toContain('yellow-zone rows: 3');
    expect(markdown).toContain('unknownKOL=1');
    expect(markdown).toContain('route-unknown fallback rows: 1');
    expect(markdown).toContain('review live-equivalence');
    expect(markdown).toContain('linked=0/0, blockers=0');
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
