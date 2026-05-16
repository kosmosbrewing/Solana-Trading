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
    expect(report.posthocSecondKol.find((row) => row.cohort === 'posthoc_2nd_kol_all')).toMatchObject({
      rows: 0,
      routeKnownRows: 0,
      costAwareRows: 0,
    });
    expect(report.posthocSecondKolWaitProxies.find((row) =>
      row.cohort === 'posthoc_2nd_kol_all' &&
      row.exitProfile === 'wait_to_2nd_kol_then_next_horizon'
    )).toMatchObject({
      rows: 0,
      observedRows: 0,
    });
    expect(report.posthocSecondKolCandidateDecisions.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=15s'
    )).toMatchObject({
      verdict: 'COLLECT',
      observedRows: 0,
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
      diagnosis: 'BLOCKED_BY_CANDIDATE_ID',
      underfillRows: 4,
      routeKnownRows: 3,
      routeKnownTwoPlusRows: 1,
      routeKnownCostAwareRows: 1,
      singleKolRouteKnownCostAwareRows: 0,
      reviewRows: 1,
      missingRouteProofRows: 1,
      missingCandidateIdRows: 4,
      reviewMissingCandidateIdRows: 1,
      reviewMissingParticipantTimestampRows: 1,
    });
    for (const reason of [
      'NO_SELL_ROUTE',
      'TOKEN_QUALITY_UNKNOWN',
      'NO_SECURITY_DATA',
      'JUPITER_429',
    ]) {
      expect(report.routeUnknownReasons.find((row) => row.reason === reason)).toMatchObject({
        rows: 1,
        losses: 1,
      });
    }
    expect(report.routeUnknownReasons.find((row) => row.reason === 'DECIMALS_SECURITY_CLIENT')).toBeUndefined();
    expect(report.routeUnknownReasons.find((row) => row.reason === 'SECURITY_CLIENT')).toBeUndefined();
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
    expect(markdown).toContain('## Posthoc Second-KOL Audit');
    expect(markdown).toContain('## Posthoc Second-KOL Wait Proxy');
    expect(markdown).toContain('## Posthoc Second-KOL Candidate Decision');
    expect(markdown).toContain('## Paper Cohort Validity');
    expect(markdown).toContain('## Review Cohort Generation Audit');
    expect(markdown).toContain('diagnosis: BLOCKED_BY_CANDIDATE_ID');
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

  it('diagnoses single-KOL route-known cost-aware underfill as blocked before promotion review', async () => {
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl(
      Array.from({ length: 3 }, (_, index) => ({
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_cost_aware_exit_v2',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: `single-route-known-${index}`,
        liveEquivalenceCandidateId: `single-route-known-candidate-${index}`,
        closedAt: `2026-05-02T00:0${index}:00.000Z`,
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.001,
        mfePctPeak: 0.1,
        routeFound: true,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        kols: [
          { id: 'kol-a', timestamp: `2026-05-02T00:0${index}:00.000Z` },
        ],
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_1', 'ROTATION_COST_AWARE_EXIT_V2'],
      }))
    ));
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

    expect(report.reviewCohortGenerationAudit).toMatchObject({
      cohort: 'route_known_2kol_cost_aware',
      diagnosis: 'BLOCKED_BY_2KOL_ABSENCE',
      underfillRows: 3,
      routeKnownRows: 3,
      routeKnownTwoPlusRows: 0,
      routeKnownCostAwareRows: 3,
      singleKolRouteKnownCostAwareRows: 3,
      reviewRows: 0,
    });
    expect(report.rotationPaperCompoundReadiness).toMatchObject({
      verdict: 'BLOCKED',
      cohort: 'route_known_2kol_cost_aware',
      closes: 0,
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('diagnosis: BLOCKED_BY_2KOL_ABSENCE');
    expect(markdown).toContain('do not promote the 1-KOL route-known cost-aware edge');
  });

  it('joins single-KOL underfill closes to same-token KOL tx flow for second-KOL opportunity review', async () => {
    const tokenMint = 'SecondKolOpportunity11111111111111111111111';
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_cost_aware_exit_v2',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'single-route-known-cost-aware',
        liveEquivalenceCandidateId: 'single-route-known-cost-aware-candidate',
        tokenMint,
        closedAt: '2026-05-02T00:01:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.001,
        mfePctPeak: 0.12,
        routeFound: true,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        kols: [
          { id: 'kol-a', timestamp: '2026-05-02T00:00:00.000Z' },
        ],
        independentKolCount: 1,
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_1', 'ROTATION_COST_AWARE_EXIT_V2'],
      },
    ]));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([
      {
        kolId: 'kol-a',
        tier: 'A',
        tokenMint,
        action: 'buy',
        timestamp: '2026-05-02T00:00:00.000Z',
        solAmount: 0.1,
      },
      {
        kolId: 'kol-b',
        tier: 'A',
        tokenMint,
        action: 'buy',
        timestamp: '2026-05-02T00:00:12.000Z',
        solAmount: 0.12,
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationSecondKolOpportunityFunnel).toMatchObject({
      verdict: 'SECOND_KOL_LINKAGE_GAP',
      underfillRows: 1,
      singleKolRows: 1,
      rowsWithToken: 1,
      rowsWithEntryTime: 1,
      rowsWithTxCoverage: 1,
      routeKnownCostAwareSingleRows: 1,
      secondKolSeenRows: 1,
      secondKolWithin15Rows: 1,
      secondKolWithin30Rows: 1,
      secondKolWithin60Rows: 1,
      routeKnownCostAwareSecondWithin30Rows: 1,
      potentialReviewRows: 1,
      trueSingleRows: 0,
      freshCutoffSource: 'none',
      freshUnderfillRows: 1,
      freshSingleKolRows: 1,
      freshRowsWithTxCoverage: 1,
      freshSecondKolWithin30Rows: 1,
      freshRouteKnownCostAwareSecondWithin30Rows: 1,
      freshNextSprint: 'review_fresh_2nd_kol_candidates',
    });
    expect(report.rotationSecondKolOpportunityFunnel.topSecondKols).toEqual([
      { kol: 'kol-b', count: 1 },
    ]);
    expect(report.rotationSecondKolPromotionGap).toMatchObject({
      verdict: 'REVIEW_CANDIDATES_EXIST',
      rows: 1,
      routeProofRows: 1,
      routeUnknownRows: 0,
      costAwareRows: 1,
      routeKnownCostAwareRows: 1,
      routeKnownMissingCostAwareRows: 0,
      costAwareRouteUnknownRows: 0,
      candidateIdRows: 1,
      participantTimestampRows: 1,
      medianSecondKolDelaySec: 12,
      medianMfePct: 0.12,
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Rotation 2nd-KOL Opportunity Funnel');
    expect(markdown).toContain('SECOND_KOL_LINKAGE_GAP');
    expect(markdown).toContain('kol-b:1');
    expect(markdown).toContain('## Rotation 2nd-KOL Promotion Gap');
    expect(markdown).toContain('REVIEW_CANDIDATES_EXIST');
  });

  it('explains second-KOL <=30s rows blocked by missing cost-aware shadow closes', async () => {
    const tokenMint = 'SecondKolMissingCostAware111111111111111111';
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_exit_flow_v1',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'single-route-known-no-cost-aware',
        liveEquivalenceCandidateId: 'single-route-known-no-cost-aware-candidate',
        tokenMint,
        closedAt: '2026-05-02T00:01:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.001,
        mfePctPeak: 0.12,
        routeFound: true,
        kols: [
          { id: 'kol-a', timestamp: '2026-05-02T00:00:00.000Z' },
        ],
        independentKolCount: 1,
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_1'],
      },
    ]));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([
      {
        kolId: 'kol-b',
        tier: 'A',
        tokenMint,
        action: 'buy',
        timestamp: '2026-05-02T00:00:12.000Z',
        solAmount: 0.12,
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationSecondKolPromotionGap).toMatchObject({
      verdict: 'BLOCKED_BY_COST_AWARE',
      rows: 1,
      routeProofRows: 1,
      routeUnknownRows: 0,
      costAwareRows: 0,
      routeKnownCostAwareRows: 0,
      routeKnownMissingCostAwareRows: 1,
      costAwareRouteUnknownRows: 0,
    });
    expect(report.rotationSecondKolPromotionGap.topMissingCostAwareArms).toEqual([
      { arm: 'rotation_underfill_exit_flow_v1', count: 1 },
    ]);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('BLOCKED_BY_COST_AWARE');
    expect(markdown).toContain('rotation_underfill_exit_flow_v1:1');
  });

  it('classifies second-KOL <=30s route-proof gaps by recovery hint', async () => {
    const tokenMint = 'SecondKolRouteProofGap11111111111111111111';
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'single-route-unknown-cost-aware',
        liveEquivalenceCandidateId: 'single-route-unknown-cost-aware-candidate',
        tokenMint,
        closedAt: '2026-05-02T00:01:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.001,
        mfePctPeak: 0.12,
        kols: [
          { id: 'kol-a', timestamp: '2026-05-02T00:00:00.000Z' },
        ],
        independentKolCount: 1,
        survivalFlags: [
          'ROTATION_UNDERFILL_KOLS_1',
          'ROTATION_COST_AWARE_EXIT_V2',
          'EXIT_LIQUIDITY_UNKNOWN',
          'DECIMALS_SECURITY_CLIENT',
          'TOKEN_QUALITY_UNKNOWN',
          'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN',
        ],
      },
    ]));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([
      {
        kolId: 'kol-b',
        tier: 'A',
        tokenMint,
        action: 'buy',
        timestamp: '2026-05-02T00:00:10.000Z',
        solAmount: 0.12,
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationSecondKolPromotionGap).toMatchObject({
      verdict: 'BLOCKED_BY_ROUTE_PROOF',
      rows: 1,
      routeProofRows: 0,
      routeUnknownRows: 1,
      costAwareRows: 1,
      routeKnownCostAwareRows: 0,
      costAwareRouteUnknownRows: 1,
      structuralBlockRows: 1,
      dataGapRows: 0,
      infraRetryRows: 0,
      unknownRows: 0,
      explicitNoSellRouteRows: 1,
      exitLiquidityUnknownRows: 1,
      securityDataGapRows: 1,
      mixedExitLiquidityAndDataGapRows: 1,
      missingPositiveEvidenceRows: 0,
      recoveryHint: 'record_exit_quote_and_security_evidence',
      nextSprint: 'record_exit_quote_and_security_evidence',
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('record_exit_quote_and_security_evidence');
    expect(markdown).toContain('mixed=1');
  });

  it('separates stale 2nd-KOL promotion gaps from fresh route-proof work', async () => {
    const tokenMint = 'MintSecondKolStaleFreshSplit111111111111111';
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      startedAt: '2026-05-03T00:00:00.000Z',
    }));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'stale-second-kol-route-gap',
        liveEquivalenceCandidateId: 'stale-second-kol-route-gap-candidate',
        tokenMint,
        closedAt: '2026-05-02T00:01:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.001,
        mfePctPeak: 0.12,
        kols: [
          { id: 'kol-a', timestamp: '2026-05-02T00:00:00.000Z' },
        ],
        independentKolCount: 1,
        survivalFlags: [
          'ROTATION_UNDERFILL_KOLS_1',
          'ROTATION_COST_AWARE_EXIT_V2',
          'EXIT_LIQUIDITY_UNKNOWN',
        ],
      },
    ]));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([
      {
        kolId: 'kol-b',
        tier: 'A',
        tokenMint,
        action: 'buy',
        timestamp: '2026-05-02T00:00:10.000Z',
        solAmount: 0.12,
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationSecondKolPromotionGap).toMatchObject({
      verdict: 'BLOCKED_BY_ROUTE_PROOF',
      rows: 1,
      freshCutoffSource: 'current_session',
      freshSince: '2026-05-03T00:00:00.000Z',
      freshRows: 0,
      staleRows: 1,
      freshRouteProofRows: 0,
      freshRouteUnknownRows: 0,
      freshCostAwareRows: 0,
      freshRouteKnownCostAwareRows: 0,
      freshExitQuoteEvidenceRows: 0,
      nextSprint: 'record_exit_quote_evidence',
      freshNextSprint: 'collect_fresh_2nd_kol_30_rows',
    });
    expect(report.rotationSecondKolOpportunityFunnel).toMatchObject({
      verdict: 'COLLECT',
      underfillRows: 1,
      singleKolRows: 1,
      secondKolWithin30Rows: 1,
      freshCutoffSource: 'current_session',
      freshSince: '2026-05-03T00:00:00.000Z',
      freshUnderfillRows: 0,
      freshSingleKolRows: 0,
      freshRowsWithTxCoverage: 0,
      freshSecondKolWithin30Rows: 0,
      freshRouteKnownCostAwareSecondWithin30Rows: 0,
      freshNextSprint: 'collect_fresh_underfill_closes',
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('historical next');
    expect(markdown).toContain('fresh underfill');
    expect(markdown).toContain('collect_fresh_2nd_kol_30_rows');
    expect(markdown).toContain('collect_fresh_underfill_closes');
  });

  it('reports posthoc second-KOL underfill rows without treating them as live-equivalent 2+ KOL', async () => {
    const kols = [
      { id: 'kol-a', timestamp: '2026-05-02T00:00:00.000Z' },
      { id: 'kol-b', timestamp: '2026-05-02T00:00:20.000Z' },
    ];
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_exit_flow_v1',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'posthoc-base',
        liveEquivalenceCandidateId: 'posthoc-candidate',
        closedAt: '2026-05-02T00:01:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 24,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        mfePctPeak: 0.2,
        routeFound: true,
        kols,
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_1'],
        independentKolCount: 1,
      },
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'posthoc-cost-aware',
        parentPositionId: 'posthoc-base',
        liveEquivalenceCandidateId: 'posthoc-candidate',
        closedAt: '2026-05-02T00:01:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 24,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        mfePctPeak: 0.2,
        routeFound: true,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        kols,
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_1'],
        independentKolCount: 1,
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      ...['posthoc-base', 'posthoc-cost-aware'].flatMap((positionId) => [
        {
          anchorType: 'buy',
          positionId,
          tokenMint: 'MintPosthocSecondKol',
          horizonSec: 30,
          quoteStatus: 'ok',
          deltaPct: 0.05,
          recordedAt: '2026-05-02T00:00:30.000Z',
          extras: { armName: 'rotation_underfill_v1', entryReason: 'rotation_v1' },
        },
        {
          anchorType: 'buy',
          positionId,
          tokenMint: 'MintPosthocSecondKol',
          horizonSec: 60,
          quoteStatus: 'ok',
          deltaPct: 0.10,
          recordedAt: '2026-05-02T00:01:00.000Z',
          extras: { armName: 'rotation_underfill_v1', entryReason: 'rotation_v1' },
        },
      ]),
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30, 60],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.underfillKolCohorts.find((row) => row.cohort === 'underfill_2plus_kol')).toMatchObject({
      rows: 0,
    });
    expect(report.posthocSecondKol.find((row) => row.cohort === 'posthoc_2nd_kol_all')).toMatchObject({
      rows: 2,
      routeKnownRows: 2,
      costAwareRows: 1,
      wins: 2,
      medianSecondKolDelaySec: 20,
    });
    expect(report.posthocSecondKol.find((row) => row.cohort === 'posthoc_2nd_kol_secondKOL<=30s')).toMatchObject({
      rows: 2,
      costAwareRows: 1,
    });
    expect(report.posthocSecondKolWaitProxies.find((row) =>
      row.cohort === 'posthoc_2nd_kol_all' &&
      row.exitProfile === 'wait_to_2nd_kol_then_next_horizon'
    )).toMatchObject({
      rows: 2,
      observedRows: 2,
      positiveRows: 2,
      medianWaitEntryDeltaPct: 0.05,
      medianPostCostDeltaPct: (1.10 / 1.05 - 1) - 0.005,
    });
    expect(report.posthocSecondKolCandidateDecisions.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=30s'
    )).toMatchObject({
      verdict: 'COLLECT',
      observedRows: 2,
    });
    expect(report.posthocSecondKolSyntheticPaperArms.find((row) =>
      row.sourceCohort === 'posthoc_2nd_kol_secondKOL<=30s'
    )).toMatchObject({
      armName: 'posthoc_2nd_kol_wait_next_horizon_v1:secondKOL<=30s',
      verdict: 'COLLECT',
      observedRows: 2,
      proxyOnly: true,
      liveEquivalent: false,
    });
    expect(report.posthocSecondKolRouteProofGates.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=30s'
    )).toMatchObject({
      verdict: 'ROUTE_PROOF_READY',
      rows: 2,
      candidateIdRows: 2,
      routeKnownRows: 2,
      routeProofRows: 2,
      routeUnknownRows: 0,
      explicitNoSellRouteRows: 0,
      exitLiquidityUnknownRows: 0,
      securityDataGapRows: 0,
      missingPositiveEvidenceRows: 0,
      recoveryHint: 'route_proof_ready',
    });
    expect(report.posthocSecondKolRecoveryBacklog.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=30s'
    )).toMatchObject({
      priority: 'P1',
      status: 'READY_FOR_REVIEW',
      nextSprint: 'check_sample_gate_and_live_equivalence',
      liveStance: 'live blocked; report-only evidence only',
    });
    expect(report.rotationPaperCompoundReadiness.verdict).toBe('BLOCKED');

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('Posthoc Second-KOL Audit');
    expect(markdown).toContain('Posthoc Second-KOL Wait Proxy');
    expect(markdown).toContain('Posthoc Second-KOL Candidate Decision');
    expect(markdown).toContain('Posthoc Second-KOL Synthetic Paper Arm');
    expect(markdown).toContain('Posthoc Second-KOL Route Proof Gate');
    expect(markdown).toContain('Posthoc Second-KOL Recovery Backlog');
    expect(markdown).toContain('paper evidence only, not live-equivalent 2+ KOL proof');
    expect(markdown).toContain('wait_to_2nd_kol_then_next_horizon');
    expect(markdown).toContain('synthetic paper arm only; runtime/live unchanged');
    expect(markdown).toContain('posthoc_2nd_kol_secondKOL<=30s');
  });

  it('does not turn historical posthoc route gaps into a new code TODO while waiting for fresh closes', async () => {
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T01:00:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'historical-posthoc-route-gap',
        liveEquivalenceCandidateId: 'historical-posthoc-route-gap-candidate',
        closedAt: '2026-05-02T00:01:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 24,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        mfePctPeak: 0.2,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        kols: [
          { id: 'kol-a', timestamp: '2026-05-02T00:00:00.000Z' },
          { id: 'kol-b', timestamp: '2026-05-02T00:00:08.000Z' },
        ],
        survivalFlags: [
          'ROTATION_UNDERFILL_KOLS_1',
          'EXIT_LIQUIDITY_UNKNOWN',
          'TOKEN_QUALITY_UNKNOWN',
        ],
        independentKolCount: 1,
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeProofFreshness).toMatchObject({
      verdict: 'WAIT_FRESH_CLOSES',
      cutoffSource: 'current_session',
      freshRows: 0,
      minRequiredFreshRows: 30,
    });
    expect(report.posthocSecondKolRouteProofGates.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=15s'
    )).toMatchObject({
      verdict: 'ROUTE_PROOF_MISSING',
      rows: 1,
      recoveryHint: 'record_exit_quote_and_security_evidence',
    });
    expect(report.posthocSecondKolRecoveryBacklog.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=15s'
    )).toMatchObject({
      priority: 'P2',
      status: 'WAIT_SAMPLE',
      nextSprint: 'collect_fresh_underfill_closes',
      evidenceGap: 'freshUnderfill=0/30',
      requiredBeforeLive: 'collect fresh post-deploy underfill closes with exit quote/liquidity and security evidence',
      liveStance: 'live blocked; report-only evidence only',
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('collect_fresh_underfill_closes');
    expect(markdown).not.toContain('record_exit_quote_and_security_evidence | exitUnknown=1/1');
  });

  it('marks posthoc second-KOL as paper candidate only after sufficient wait-proxy evidence', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => {
      const timestampPrefix = `2026-05-02T00:${String(index).padStart(2, '0')}`;
      return {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: `posthoc-candidate-${index}`,
        parentPositionId: `posthoc-parent-${index}`,
        liveEquivalenceCandidateId: `posthoc-candidate-id-${index}`,
        closedAt: `${timestampPrefix}:40.000Z`,
        exitReason: 'winner_trailing_t1',
        holdSec: 40,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        mfePctPeak: 0.2,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        kols: [
          { id: 'kol-a', timestamp: `${timestampPrefix}:00.000Z` },
          { id: 'kol-b', timestamp: `${timestampPrefix}:10.000Z` },
        ],
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_1'],
        independentKolCount: 1,
      };
    });
    const markouts = Array.from({ length: 50 }, (_, index) => [
      {
        anchorType: 'buy',
        positionId: `posthoc-candidate-${index}`,
        tokenMint: `MintPosthocCandidate${index}`,
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: 0.02,
        recordedAt: `2026-05-02T00:${String(index).padStart(2, '0')}:15.000Z`,
        extras: { armName: 'rotation_underfill_cost_aware_exit_v2', entryReason: 'rotation_v1' },
      },
      {
        anchorType: 'buy',
        positionId: `posthoc-candidate-${index}`,
        tokenMint: `MintPosthocCandidate${index}`,
        horizonSec: 30,
        quoteStatus: 'ok',
        deltaPct: 0.10,
        recordedAt: `2026-05-02T00:${String(index).padStart(2, '0')}:30.000Z`,
        extras: { armName: 'rotation_underfill_cost_aware_exit_v2', entryReason: 'rotation_v1' },
      },
    ]).flat();
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl(rows));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(markouts));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.posthocSecondKolCandidateDecisions.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=15s'
    )).toMatchObject({
      verdict: 'PAPER_CANDIDATE',
      observedRows: 50,
      postCostPositiveRate: 1,
      medianPostCostDeltaPct: (1.10 / 1.02 - 1) - 0.005,
    });
    expect(report.posthocSecondKolSyntheticPaperArms.find((row) =>
      row.sourceCohort === 'posthoc_2nd_kol_secondKOL<=15s'
    )).toMatchObject({
      armName: 'posthoc_2nd_kol_wait_next_horizon_v1:secondKOL<=15s',
      verdict: 'PAPER_CANDIDATE',
      observedRows: 50,
      proxyOnly: true,
      liveEquivalent: false,
    });
    expect(report.posthocSecondKolRouteProofGates.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=15s'
    )).toMatchObject({
      verdict: 'ROUTE_PROOF_MISSING',
      rows: 50,
      candidateIdRows: 50,
      routeKnownRows: 0,
      routeProofRows: 0,
      routeUnknownRows: 50,
      unknownRows: 50,
      explicitNoSellRouteRows: 0,
      exitLiquidityUnknownRows: 0,
      securityDataGapRows: 0,
      missingPositiveEvidenceRows: 50,
      recoveryHint: 'record_positive_route_probe',
    });
    expect(report.posthocSecondKolRecoveryBacklog.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=15s'
    )).toMatchObject({
      priority: 'P1',
      status: 'TODO',
      nextSprint: 'record_positive_route_probe',
      evidenceGap: 'missingProof=50/50',
      liveStance: 'live blocked; report-only evidence only',
    });
    expect(report.rotationPaperCompoundReadiness.verdict).toBe('BLOCKED');

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('PAPER_CANDIDATE');
    expect(markdown).toContain('candidate verdict never enables live routing');
    expect(markdown).toContain('not a runtime ledger arm and never changes live routing');
    expect(markdown).toContain('Good proxy PnL without route proof is still blocked');
    expect(markdown).toContain('route-known proof missing; live remains blocked');
    expect(markdown).toContain('record_positive_route_probe');
    expect(markdown).toContain('live blocked; report-only evidence only');
  });

  it('treats structured sell-quote evidence as route proof despite legacy exit-liquidity flags', async () => {
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'posthoc-proofed',
        liveEquivalenceCandidateId: 'posthoc-proofed-candidate',
        closedAt: '2026-05-02T00:00:40.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 40,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        mfePctPeak: 0.2,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        entrySellQuoteEvidence: {
          schemaVersion: 'kol-entry-sell-quote/v1',
          probeEnabled: true,
          approved: true,
          routeFound: true,
          observedOutSol: 0.019,
          observedImpactPct: 0.01,
          roundTripPct: 0.95,
        },
        entrySecurityEvidence: {
          schemaVersion: 'kol-entry-security/v1',
          securityClientPresent: true,
          tokenSecurityKnown: true,
          exitLiquidityKnown: false,
          tokenSecurityData: { top10HolderPct: 0.1 },
          exitLiquidityData: null,
        },
        kols: [
          { id: 'kol-a', timestamp: '2026-05-02T00:00:00.000Z' },
          { id: 'kol-b', timestamp: '2026-05-02T00:00:10.000Z' },
        ],
        survivalFlags: [
          'ROTATION_UNDERFILL_KOLS_1',
          'EXIT_LIQUIDITY_UNKNOWN',
          'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN',
          'DECIMALS_SECURITY_CLIENT',
        ],
        independentKolCount: 1,
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        positionId: 'posthoc-proofed',
        tokenMint: 'MintPosthocProofed',
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: 0.02,
        recordedAt: '2026-05-02T00:00:15.000Z',
        extras: { armName: 'rotation_underfill_cost_aware_exit_v2', entryReason: 'rotation_v1' },
      },
      {
        anchorType: 'buy',
        positionId: 'posthoc-proofed',
        tokenMint: 'MintPosthocProofed',
        horizonSec: 30,
        quoteStatus: 'ok',
        deltaPct: 0.10,
        recordedAt: '2026-05-02T00:00:30.000Z',
        extras: { armName: 'rotation_underfill_cost_aware_exit_v2', entryReason: 'rotation_v1' },
      },
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.posthocSecondKolRouteProofGates.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=15s'
    )).toMatchObject({
      verdict: 'ROUTE_PROOF_READY',
      rows: 1,
      routeKnownRows: 1,
      routeProofRows: 1,
      routeUnknownRows: 0,
      exitLiquidityUnknownRows: 0,
      securityDataGapRows: 0,
      recoveryHint: 'route_proof_ready',
    });
  });

  it('treats structured exit sell-quote evidence as route proof for rotation paper closes', async () => {
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'exit-proofed',
        liveEquivalenceCandidateId: 'exit-proofed-candidate',
        closedAt: '2026-05-02T00:00:40.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 40,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        mfePctPeak: 0.2,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        exitSellQuoteEvidence: {
          schemaVersion: 'kol-exit-sell-quote/v1',
          probeEnabled: true,
          approved: true,
          routeFound: true,
          observedOutSol: 0.019,
          observedImpactPct: 0.01,
          roundTripPct: 0.95,
        },
        kols: [
          { id: 'kol-a', timestamp: '2026-05-02T00:00:00.000Z' },
          { id: 'kol-b', timestamp: '2026-05-02T00:00:10.000Z' },
        ],
        survivalFlags: [
          'ROTATION_UNDERFILL_KOLS_1',
          'EXIT_LIQUIDITY_UNKNOWN',
          'ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN',
        ],
        independentKolCount: 1,
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeTruthAudit.find((row) => row.bucket === 'route_known:exitSellQuote.routeFound')).toMatchObject({
      rows: 1,
      routeKnownRows: 1,
      routeUnknownRows: 0,
      recoverability: 'ready',
    });
    expect(report.posthocSecondKolRouteProofGates.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=15s'
    )).toMatchObject({
      routeKnownRows: 1,
      routeProofRows: 1,
      routeUnknownRows: 0,
      recoveryHint: 'route_proof_ready',
    });
  });

  it('lets explicit exit no-route evidence override earlier positive entry route proof', async () => {
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_cost_aware_exit_v2',
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'exit-no-route',
        liveEquivalenceCandidateId: 'exit-no-route-candidate',
        closedAt: '2026-05-02T00:00:40.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 40,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        mfePctPeak: 0.2,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        entrySellQuoteEvidence: {
          schemaVersion: 'kol-entry-sell-quote/v1',
          probeEnabled: true,
          approved: true,
          routeFound: true,
        },
        exitSellQuoteEvidence: {
          schemaVersion: 'kol-exit-sell-quote/v1',
          probeEnabled: true,
          approved: false,
          routeFound: false,
          reason: 'no_sell_route',
        },
        kols: [
          { id: 'kol-a', timestamp: '2026-05-02T00:00:00.000Z' },
          { id: 'kol-b', timestamp: '2026-05-02T00:00:10.000Z' },
        ],
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_1'],
        independentKolCount: 1,
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeTruthAudit.find((row) => row.bucket === 'route_unknown:structural_exit_route')).toMatchObject({
      rows: 1,
      routeKnownRows: 0,
      routeUnknownRows: 1,
      recoverability: 'structural_block',
    });
    expect(report.routeUnknownReasons.find((row) => row.reason === 'NO_SELL_ROUTE')).toMatchObject({
      rows: 1,
    });
    expect(report.posthocSecondKolRouteProofGates.find((row) =>
      row.cohort === 'posthoc_2nd_kol_secondKOL<=15s'
    )).toMatchObject({
      routeKnownRows: 0,
      routeProofRows: 0,
      routeUnknownRows: 1,
      explicitNoSellRouteRows: 1,
      recoveryHint: 'review_true_no_route_before_live',
    });
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
    expect(report.rotationNarrowCohorts.find((row) =>
      row.cohort === 'route_proofed_2plus_cost_aware'
    )).toMatchObject({
      verdict: 'PAPER_READY',
      rows: 50,
      routeProofRows: 50,
      candidateIdRows: 50,
      twoPlusKolRows: 50,
      costAwareRows: 50,
      timestampedSecondKolRows: 50,
      postCostPositiveRate: 1,
      edgePassRate: 1,
      minOkCoverage: 1,
    });
    expect(report.rotationNarrowCohorts.find((row) =>
      row.cohort === 'route_proofed_2plus_cost_aware_secondKOL<=15s'
    )).toMatchObject({
      verdict: 'PAPER_READY',
      rows: 50,
      primaryHorizonPostCost: [
        {
          horizonSec: 15,
          okCoverage: 1,
          postCostPositiveRate: 1,
          medianPostCostDeltaPct: 0.024999999999999998,
        },
        {
          horizonSec: 30,
          okCoverage: 1,
          postCostPositiveRate: 1,
          medianPostCostDeltaPct: 0.015,
        },
      ],
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
    expect(markdown).toContain('## Rotation Narrow Cohort Board');
    expect(markdown).toContain('route-proofed narrow paper cohort passed');
    expect(markdown).toContain('cost_aware_t1_primary_proxy');
    expect(markdown).toContain('2kol_route_known_cost_aware_secondKOL<=30s');
    expect(markdown).toContain('micro-live plan: ticket=0.020 SOL');
    expect(markdown).toContain('route-known 2+KOL cost-aware sample meets report-only micro-live gate');
  });

  it('separates old route proof from post-R1.41 fresh route-proof instrumentation', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: armName,
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'fresh-route-proof-0',
        liveEquivalenceCandidateId: 'fresh-route-proof-candidate-0',
        closedAt: '2026-05-02T00:00:30.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        routeFound: true,
        exitSellQuoteEvidence: {
          schemaVersion: 'kol-exit-sell-quote/v1',
          probeEnabled: true,
          approved: true,
          routeFound: true,
        },
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        kols: [
          { id: 'kol-a', timestamp: '2026-05-02T00:00:00.000Z' },
          { id: 'kol-b', timestamp: '2026-05-02T00:00:04.000Z' },
        ],
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_2'],
      },
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: armName,
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'fresh-route-proof-1',
        liveEquivalenceCandidateId: 'fresh-route-proof-candidate-1',
        closedAt: '2026-05-02T00:01:30.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        routeFound: true,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        kols: [
          { id: 'kol-a', timestamp: '2026-05-02T00:01:00.000Z' },
          { id: 'kol-b', timestamp: '2026-05-02T00:01:04.000Z' },
        ],
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_2'],
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeProofFreshness).toMatchObject({
      verdict: 'INSTRUMENTATION_GAP',
      cutoffSource: 'first_exit_route_marker',
      underfillRows: 2,
      freshRows: 2,
      exitQuoteEvidenceRows: 1,
      exitQuoteRouteFoundRows: 1,
      instrumentationMissingRows: 1,
      routeProofRows: 2,
    });
    expect(report.routeProofFreshness.freshByArm.find((row) =>
      row.armName === armName
    )).toMatchObject({
      rows: 2,
      exitQuoteEvidenceRows: 1,
      missingEvidenceRows: 1,
      routeFoundTrueRows: 1,
      routeFoundNullRows: 1,
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Route Proof Freshness');
    expect(markdown).toContain('### Route Proof Freshness By Arm');
    expect(markdown).toContain('fresh rows missing exit-route instrumentation 1/2');
  });

  it('marks route-proof freshness as waiting when explicit fresh window has no closes', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: armName,
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'old-close-before-fresh-window',
        closedAt: '2026-05-02T00:00:30.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        routeFound: true,
        exitSellQuoteEvidence: {
          schemaVersion: 'kol-exit-sell-quote/v1',
          probeEnabled: true,
          approved: true,
          routeFound: true,
        },
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
      routeProofFreshSinceMs: Date.parse('2026-05-03T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeProofFreshness).toMatchObject({
      verdict: 'WAIT_FRESH_CLOSES',
      cutoffSource: 'arg',
      freshSince: '2026-05-03T00:00:00.000Z',
      underfillRows: 1,
      freshRows: 0,
      latestUnderfillCloseAt: '2026-05-02T00:00:30.000Z',
      latestCostAwareCloseAt: '2026-05-02T00:00:30.000Z',
      latestExitQuoteEvidenceAt: '2026-05-02T00:00:30.000Z',
    });
    expect(report.routeProofFreshness.freshByArm).toEqual([]);
  });

  it('marks current-window underfill closes without any exit-route marker as instrumentation gap', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: armName,
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'fresh-unmarked-close',
        closedAt: '2026-05-02T00:00:30.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
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
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeProofFreshness).toMatchObject({
      verdict: 'INSTRUMENTATION_GAP',
      cutoffSource: 'none',
      freshSince: null,
      underfillRows: 1,
      freshRows: 1,
      paperCloseWriterSchemaRows: 0,
      rotationExitRouteProofSchemaRows: 0,
      exitRouteInstrumentedRows: 0,
      instrumentationMissingRows: 1,
      routeProofRows: 0,
    });
    expect(report.routeProofFreshness.reasons).toContain(
      'no exit-route markers or route-proof writer schema across current report-window underfill closes 1; deploy drift likely'
    );

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('deploy drift likely');
  });

  it('waits when unmarked closes are older than the current runtime session', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:10:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: armName,
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'pre-session-unmarked-close',
        closedAt: '2026-05-02T00:00:30.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
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
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeProofFreshness).toMatchObject({
      verdict: 'WAIT_FRESH_CLOSES',
      cutoffSource: 'current_session',
      freshSince: '2026-05-02T00:10:00.000Z',
      underfillRows: 1,
      freshRows: 0,
      freshNoTradeEvents: 0,
      freshNoTradeRows: 0,
      freshMissedAlphaEvents: 0,
      freshMissedAlphaRows: 0,
      freshPolicyDecisionRows: 0,
      freshRotationPolicyDecisionRows: 0,
      latestUnderfillCloseAt: '2026-05-02T00:00:30.000Z',
    });
    expect(report.routeProofFreshness.reasons).toContain(
      'no underfill paper closes since current runtime session start'
    );
    expect(report.routeProofFreshness.reasons).toContain(
      'no rotation no-trade candidates since current runtime session start'
    );
    expect(report.routeProofFreshness.reasons).toContain(
      'runtime activity sparse since current runtime session start'
    );
  });

  it('reports runtime rotation no-trade candidates while waiting for fresh closes', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:10:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: armName,
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'pre-session-underfill-close',
        closedAt: '2026-05-02T00:00:30.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_2'],
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        eventId: 'ma-rotation-underfill-after-session',
        tokenMint: 'TokenAfterSession111111111111111111111111111',
        lane: 'kol_hunter',
        rejectReason: 'rotation_underfill_underfill_stale_last_buy',
        signalSource: 'rotation_underfill_v1',
        rejectedAt: '2026-05-02T00:12:00.000Z',
        extras: {
          eventType: 'rotation_underfill_no_trade',
          armName: 'rotation_underfill_v1',
          entryReason: 'rotation_v1',
          noTradeReason: 'underfill_stale_last_buy',
        },
        probe: {
          offsetSec: 15,
          firedAt: '2026-05-02T00:12:15.000Z',
          quoteStatus: 'ok',
          deltaPct: 0.01,
        },
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeProofFreshness).toMatchObject({
      verdict: 'WAIT_FRESH_CLOSES',
      cutoffSource: 'current_session',
      freshRows: 0,
      freshNoTradeRows: 1,
      freshNoTradeEvents: 1,
      freshMissedAlphaRows: 1,
      freshMissedAlphaEvents: 1,
      freshPolicyDecisionRows: 0,
      freshRotationPolicyDecisionRows: 0,
      latestNoTradeAt: '2026-05-02T00:12:00.000Z',
      topNoTradeReasons: [{ reason: 'underfill_stale_last_buy', count: 1 }],
      topMissedAlphaEntryReasons: [{ reason: 'rotation_v1', count: 1 }],
      topMissedAlphaRejectReasons: [{ reason: 'rotation_underfill_underfill_stale_last_buy', count: 1 }],
    });
    expect(report.routeProofFreshness.reasons).toContain(
      'rotation no-trade candidates observed since current runtime session start 1'
    );

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('rotation no-trade candidates: 1 events / 1 rows');
    expect(markdown).toContain('top rotation no-trade reasons: underfill_stale_last_buy:1');
    expect(markdown).toContain('runtime missed-alpha: 1 events / 1 rows');
  });

  it('reports non-rotation runtime activity when rotation candidates are absent', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:10:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: armName,
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'pre-session-underfill-close',
        closedAt: '2026-05-02T00:00:30.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        rotationMonetizableEdge: { pass: true, costRatio: 0.04 },
        survivalFlags: ['ROTATION_UNDERFILL_KOLS_2'],
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        eventId: 'ma-smart-v3-after-session',
        tokenMint: 'TokenSmartV3AfterSession11111111111111111111',
        lane: 'kol_hunter',
        rejectReason: 'smart_v3_kol_sell_cancel',
        signalSource: 'kol_hunter_stalk:alice',
        rejectedAt: '2026-05-02T00:12:00.000Z',
        extras: {
          eventType: 'stalk_no_trade',
          armName: 'smart_v3_fast_fail_live_v1',
          entryReason: 'smart_v3',
        },
      },
    ]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([
      {
        schemaVersion: 'kol-policy-shadow/v1',
        generatedAt: '2026-05-02T00:12:01.000Z',
        eventKind: 'reject',
        tokenMint: 'TokenSmartV3AfterSession11111111111111111111',
        bucket: {
          eventKind: 'reject',
          entryReason: 'smart_v3',
        },
        context: {
          armName: 'smart_v3_fast_fail_live_v1',
          entryReason: 'smart_v3',
          rejectReason: 'smart_v3_kol_sell_cancel',
        },
        reasons: ['reject_policy_observed'],
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeProofFreshness).toMatchObject({
      verdict: 'WAIT_FRESH_CLOSES',
      cutoffSource: 'current_session',
      freshRows: 0,
      freshNoTradeEvents: 0,
      freshNoTradeRows: 0,
      freshMissedAlphaRows: 1,
      freshMissedAlphaEvents: 1,
      freshPolicyDecisionRows: 1,
      freshRotationPolicyDecisionRows: 0,
      topMissedAlphaEntryReasons: [{ reason: 'smart_v3', count: 1 }],
      topMissedAlphaRejectReasons: [{ reason: 'smart_v3_kol_sell_cancel', count: 1 }],
      topPolicyEntryReasons: [{ reason: 'smart_v3', count: 1 }],
      topPolicyRejectReasons: [{ reason: 'smart_v3_kol_sell_cancel', count: 1 }],
    });
    expect(report.routeProofFreshness.reasons).toContain(
      'runtime active but no rotation candidates since current runtime session start; missedAlphaEvents=1, policyDecisions=1'
    );

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('runtime policy decisions: 1 rows; rotation policy decisions: 0');
    expect(markdown).toContain('top missed-alpha entry reasons: smart_v3:1');
    expect(markdown).toContain('top policy reject reasons: smart_v3_kol_sell_cancel:1');
  });

  it('classifies active KOL tx input without rotation artifacts as no rotation pattern', async () => {
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:10:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([
      {
        kolId: 'alice',
        tokenMint: 'TokenSmartV3AfterSession11111111111111111111',
        action: 'buy',
        timestamp: Date.parse('2026-05-02T00:12:00.000Z'),
        solAmount: 0.2,
      },
      {
        kolId: 'alice',
        tokenMint: 'TokenSmartV3AfterSession11111111111111111111',
        action: 'sell',
        timestamp: Date.parse('2026-05-02T00:12:30.000Z'),
        solAmount: 0.4,
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        eventId: 'ma-smart-v3-after-session',
        tokenMint: 'TokenSmartV3AfterSession11111111111111111111',
        lane: 'kol_hunter',
        rejectReason: 'smart_v3_kol_sell_cancel',
        signalSource: 'kol_hunter_stalk:alice',
        rejectedAt: '2026-05-02T00:12:00.000Z',
        extras: { entryReason: 'smart_v3' },
      },
    ]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationCandidateFunnel).toMatchObject({
      verdict: 'KOL_FLOW_ACTIVE_NO_ROTATION_PATTERN',
      cutoffSource: 'current_session',
      kolTxRows: 2,
      kolBuyRows: 1,
      kolSellRows: 1,
      distinctKols: 1,
      distinctTokens: 1,
      callFunnelRows: 0,
      rotationCallFunnelRows: 0,
      rotationNoTradeEvents: 0,
      rotationPolicyDecisionRows: 0,
      rotationPaperCloseRows: 0,
      topKolTxActions: [
        { action: 'buy', count: 1 },
        { action: 'sell', count: 1 },
      ],
      topKolTxKols: [{ kol: 'alice', count: 2 }],
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Rotation Candidate Funnel Since Session');
    expect(markdown).toContain('KOL_FLOW_ACTIVE_NO_ROTATION_PATTERN');
    expect(markdown).toContain('top KOL tx KOLs: alice:2');
  });

  it('replays current-session rotation detector blockers from KOL tx flow', async () => {
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:10:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([
      {
        kolId: 'alice',
        tier: 'A',
        tokenMint: 'TokenRotationSellPressure111111111111111111',
        action: 'buy',
        timestamp: Date.parse('2026-05-02T00:12:00.000Z'),
        solAmount: 0.2,
      },
      {
        kolId: 'alice',
        tier: 'A',
        tokenMint: 'TokenRotationSellPressure111111111111111111',
        action: 'sell',
        timestamp: Date.parse('2026-05-02T00:12:20.000Z'),
        solAmount: 0.3,
      },
      {
        kolId: 'bob',
        tier: 'S',
        tokenMint: 'TokenRotationSellPressure222222222222222222',
        action: 'buy',
        timestamp: Date.parse('2026-05-02T00:12:40.000Z'),
        solAmount: 0.05,
      },
      {
        kolId: 'bob',
        tier: 'S',
        tokenMint: 'TokenRotationSellPressure222222222222222222',
        action: 'sell',
        timestamp: Date.parse('2026-05-02T00:12:44.000Z'),
        solAmount: 0.08,
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-call-funnel.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationDetectorReplay).toMatchObject({
      verdict: 'BLOCKED_BY_RECENT_SELL',
      cutoffSource: 'current_session',
      tokenRows: 2,
      kolTxRows: 4,
      kolBuyRows: 2,
      kolSellRows: 2,
    });
    expect(report.rotationDetectorReplay.topVanillaBlockers).toEqual(expect.arrayContaining([
      { blocker: 'recent_same_mint_sell', count: 2 },
      { blocker: 'insufficient_buy_count', count: 2 },
    ]));
    expect(report.rotationDetectorReplay.topUnderfillBlockers).toEqual(expect.arrayContaining([
      { blocker: 'underfill_recent_same_mint_sell', count: 2 },
    ]));
    expect(report.rotationDetectorReplay.tokens.every((row) => row.recentSellRows > 0)).toBe(true);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Rotation Detector Replay Since Session');
    expect(markdown).toContain('BLOCKED_BY_RECENT_SELL');
    expect(markdown).toContain('underfill_recent_same_mint_sell:2');
  });

  it('keeps report-window detector replay when current-session replay has no KOL flow', async () => {
    const mint = 'TokenRotationReportWindow111111111111111111';
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:20:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([
      {
        kolId: 'alice',
        tier: 'A',
        tokenMint: mint,
        action: 'buy',
        timestamp: Date.parse('2026-05-02T00:12:00.000Z'),
        solAmount: 0.3,
      },
      {
        kolId: 'alice',
        tier: 'A',
        tokenMint: mint,
        action: 'sell',
        timestamp: Date.parse('2026-05-02T00:12:30.000Z'),
        solAmount: 0.2,
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-call-funnel.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        tokenMint: mint,
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: -0.03,
        recordedAt: '2026-05-02T00:12:15.000Z',
      },
      {
        anchorType: 'buy',
        tokenMint: mint,
        horizonSec: 30,
        quoteStatus: 'ok',
        deltaPct: -0.02,
        recordedAt: '2026-05-02T00:12:30.000Z',
      },
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-02T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationDetectorReplay).toMatchObject({
      verdict: 'NO_KOL_TX',
      cutoffSource: 'current_session',
      kolTxRows: 0,
    });
    expect(report.rotationDetectorReplayWindow).toMatchObject({
      verdict: 'BLOCKED_BY_RECENT_SELL',
      cutoffSource: 'report_since',
      tokenRows: 1,
      kolTxRows: 2,
      kolBuyRows: 1,
      kolSellRows: 1,
      topUnderfillBlockers: [{ blocker: 'underfill_recent_same_mint_sell', count: 1 }],
    });
    const recentSellBucket = report.rotationDetectorBlockerMarkouts.topBuckets.find((row) =>
      row.scope === 'underfill' && row.blocker === 'underfill_recent_same_mint_sell'
    );
    expect(recentSellBucket).toMatchObject({
      verdict: 'BLOCKER_PROTECTS',
      tokenRows: 1,
      markoutTokenRows: 1,
      buyMarkoutRows: 2,
      primaryMedianPostCostDeltaPct: -0.025,
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Rotation Detector Replay Report Window');
    expect(markdown).toContain('## Rotation Detector Blocker Markouts');
    expect(markdown).toContain('report-window KOL flow includes same-mint sell pressure');
    expect(markdown).toContain('underfill_recent_same_mint_sell');
    expect(markdown).toContain('BLOCKER_PROTECTS');
  });

  it('narrows stale-last-buy blocker by age and KOL depth before paper review', async () => {
    const mints = Array.from({ length: 10 }, (_, index) =>
      `TokenRotationStaleReview${index.toString().padStart(2, '0')}111111111111`
    );
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:20:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl(mints.flatMap((tokenMint, index) => [
      {
        kolId: 'alice',
        tier: 'A',
        tokenMint,
        action: 'buy',
        timestamp: Date.parse(`2026-05-02T00:12:${String(index).padStart(2, '0')}.000Z`),
        solAmount: 0.6,
      },
      {
        kolId: 'bob',
        tier: 'A',
        tokenMint,
        action: 'buy',
        timestamp: Date.parse(`2026-05-02T00:12:${String(index + 5).padStart(2, '0')}.000Z`),
        solAmount: 0.6,
      },
      {
        kolId: 'alice',
        tier: 'A',
        tokenMint,
        action: 'sell',
        timestamp: Date.parse(`2026-05-02T00:13:${String(index + 45).padStart(2, '0')}.000Z`),
        solAmount: 0.2,
      },
    ])));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-call-funnel.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl(mints.map((tokenMint) => ({
      anchorType: 'buy',
      tokenMint,
      horizonSec: 30,
      quoteStatus: 'ok',
      deltaPct: 0.04,
      recordedAt: '2026-05-02T00:13:00.000Z',
    }))));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-02T00:00:00.000Z'),
      horizonsSec: [30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    const staleBucket = report.rotationStaleBuyReview.buckets.find((row) =>
      row.bucket === 'age_60_120s:2plus_kol_gross_ok'
    );
    expect(staleBucket).toMatchObject({
      verdict: 'PAPER_STALE_REVIEW_CANDIDATE',
      tokenRows: 10,
      markoutTokenRows: 10,
      buyMarkoutRows: 10,
      primaryMedianPostCostDeltaPct: 0.035,
      primaryPostCostPositiveRate: 1,
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Rotation Stale-Buy Review');
    expect(markdown).toContain('age_60_120s:2plus_kol_gross_ok');
    expect(markdown).toContain('PAPER_STALE_REVIEW_CANDIDATE');
  });

  it('reports stale-last-buy coverage gaps by missing token and KOL', async () => {
    const mints = Array.from({ length: 10 }, (_, index) =>
      `TokenRotationStaleCoverage${index.toString().padStart(2, '0')}11111111111`
    );
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:20:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl(mints.flatMap((tokenMint, index) => [
      {
        kolId: 'alice',
        tier: 'A',
        tokenMint,
        action: 'buy',
        timestamp: Date.parse(`2026-05-02T00:12:${String(index).padStart(2, '0')}.000Z`),
        solAmount: 0.7,
      },
      {
        kolId: 'bob',
        tier: 'A',
        tokenMint,
        action: 'buy',
        timestamp: Date.parse(`2026-05-02T00:12:${String(index + 5).padStart(2, '0')}.000Z`),
        solAmount: 0.7,
      },
      {
        kolId: 'alice',
        tier: 'A',
        tokenMint,
        action: 'sell',
        timestamp: Date.parse('2026-05-02T00:14:00.000Z'),
        solAmount: 0.2,
      },
    ])));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        tokenMint: mints[1],
        lane: 'kol_hunter',
        signalSource: 'rotation_underfill_v1',
        rejectReason: 'rotation_underfill_underfill_stale_last_buy',
        rejectedAt: '2026-05-02T00:12:20.000Z',
        extras: {
          eventType: 'rotation_underfill_no_trade',
          noTradeReason: 'underfill_stale_last_buy',
        },
        probe: {
          offsetSec: 30,
          firedAt: '2026-05-02T00:12:50.000Z',
          quoteStatus: 'ok',
          deltaPct: 0.06,
        },
      },
      {
        tokenMint: mints[2],
        lane: 'kol_hunter',
        signalSource: 'smart_v3',
        rejectReason: 'stalk_expired_no_consensus',
        rejectedAt: '2026-05-02T00:12:25.000Z',
        extras: {
          entryReason: 'smart_v3',
        },
        probe: {
          offsetSec: 30,
          firedAt: '2026-05-02T00:12:55.000Z',
          quoteStatus: 'ok',
          deltaPct: -0.02,
        },
      },
    ]));
    await writeFile(path.join(dir, 'kol-call-funnel.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        tokenMint: mints[0],
        horizonSec: 30,
        quoteStatus: 'ok',
        deltaPct: 0.04,
        recordedAt: '2026-05-02T00:13:00.000Z',
      },
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-02T00:00:00.000Z'),
      horizonsSec: [30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    const staleBucket = report.rotationStaleBuyReview.buckets.find((row) =>
      row.bucket === 'age_60_120s:2plus_kol_gross_ok'
    );
    expect(staleBucket).toMatchObject({
      verdict: 'COLLECT',
      tokenRows: 10,
      markoutTokenRows: 1,
      missingMarkoutTokenRows: 9,
      paperProbeTokenRows: 1,
      paperProbeRows: 1,
      paperProbeOkRows: 1,
      paperProbePrimaryMedianPostCostDeltaPct: 0.055,
      paperProbePrimaryPostCostPositiveRate: 1,
      unmeasuredTokenRows: 8,
      otherPaperProbeTokenRows: 1,
      otherPaperProbeRows: 1,
      darkTokenRows: 7,
      topMissingKols: expect.arrayContaining([
        { kol: 'alice', count: 9 },
        { kol: 'bob', count: 9 },
      ]),
      topUnmeasuredKols: expect.arrayContaining([
        { kol: 'alice', count: 8 },
        { kol: 'bob', count: 8 },
      ]),
      topDarkKols: expect.arrayContaining([
        { kol: 'alice', count: 7 },
        { kol: 'bob', count: 7 },
      ]),
      topOtherPaperProbeReasons: [{ reason: 'stalk_expired_no_consensus', count: 1 }],
    });
    expect(staleBucket?.topMissingTokens).toHaveLength(8);
    expect(staleBucket?.topUnmeasuredTokens).toHaveLength(8);
    expect(staleBucket?.topDarkTokens).toHaveLength(7);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('top missing KOLs');
    expect(markdown).toContain('paper probe tokens');
    expect(markdown).toContain('other probe tokens');
    expect(markdown).toContain('#### Missing Markout Tokens');
    expect(markdown).toContain('#### Unmeasured Tokens');
    expect(markdown).toContain('#### Dark Tokens');
    expect(markdown).toContain('alice:9');
    expect(markdown).toContain('alice:8');
    expect(markdown).toContain('alice:7');
    expect(markdown).toContain('stalk_expired_no_consensus:1');
  });

  it('summarizes KOL admission-skip paper markouts without enabling live routing', async () => {
    const mintA = 'AdmissionSkipTokenA111111111111111111111111';
    const mintB = 'AdmissionSkipTokenB111111111111111111111111';
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:00:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl(Array.from({ length: 10 }, (_, index) => ({
      tokenMint: index < 5 ? mintA : mintB,
      lane: 'kol_hunter',
      signalSource: 'kol_hunter_admission_skip',
      rejectReason: 'kol_hunter_max_concurrent_skip',
      rejectedAt: `2026-05-02T00:00:${String(index).padStart(2, '0')}.000Z`,
      extras: {
        eventType: 'kol_hunter_admission_skip',
        noTradeReason: 'max_concurrent',
        paperOnlyMeasurement: true,
        kolId: index < 5 ? 'alice' : 'bob',
      },
      probe: {
        offsetSec: 30,
        firedAt: `2026-05-02T00:00:${String(index + 30).padStart(2, '0')}.000Z`,
        quoteStatus: 'ok',
        deltaPct: 0.04,
      },
    }))));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-call-funnel.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-02T00:00:00.000Z'),
      horizonsSec: [30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.kolHunterAdmissionSkipMarkouts).toMatchObject({
      verdict: 'PAPER_REVIEW_CANDIDATE',
      rows: 10,
      probeRows: 10,
      okRows: 10,
      tokenRows: 2,
      maxConcurrentRows: 10,
      primaryHorizonSec: 30,
      primaryMedianPostCostDeltaPct: 0.035,
      primaryPostCostPositiveRate: 1,
      topReasons: [{ reason: 'kol_hunter_max_concurrent_skip', count: 10 }],
    });
    expect(report.kolHunterAdmissionSkipMarkouts.topKols).toEqual([
      { kol: 'alice', count: 5 },
      { kol: 'bob', count: 5 },
    ]);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## KOL Admission-Skip Markouts');
    expect(markdown).toContain('PAPER_REVIEW_CANDIDATE');
    expect(markdown).toContain('kol_hunter_max_concurrent_skip:10');
    expect(markdown).toContain('never changes live routing');
  });

  it('joins price-context replay candidates to report-window buy markouts without enabling live', async () => {
    const mint = 'TokenRotationPriceContext11111111111111111111';
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:10:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([
      {
        kolId: 'alice',
        tier: 'A',
        tokenMint: mint,
        action: 'buy',
        timestamp: Date.parse('2026-05-02T00:12:00.000Z'),
        solAmount: 0.2,
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-call-funnel.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        tokenMint: mint,
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: 0.01,
        recordedAt: '2026-05-02T00:12:15.000Z',
      },
      {
        anchorType: 'buy',
        tokenMint: mint,
        horizonSec: 30,
        quoteStatus: 'ok',
        deltaPct: 0.04,
        recordedAt: '2026-05-02T00:12:30.000Z',
      },
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-02T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationPriceContextMarkouts).toMatchObject({
      verdict: 'PAPER_OBSERVE_CANDIDATE',
      candidateTokenRows: 1,
      candidateKolTxRows: 1,
      markoutTokenRows: 1,
      markoutTokenCoverage: 1,
      buyMarkoutRows: 2,
      minOkCoverage: 1,
    });
    expect(report.rotationPriceContextMarkouts.horizons.find((row) =>
      row.horizonSec === 30
    )).toMatchObject({
      medianPostCostDeltaPct: 0.035,
      positivePostCostRows: 1,
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Rotation Price-Context Candidate Markouts');
    expect(markdown).toContain('PAPER_OBSERVE_CANDIDATE');
    expect(markdown).toContain('This is not a simulated fill and never enables live routing.');
  });

  it('reports why price-context replay candidates are missing buy markout coverage', async () => {
    const coveredMint = 'TokenRotationPriceContextCovered11111111111111';
    const noProbeMint = 'TokenRotationPriceContextNoProbe1111111111111';
    const runtimeMint = 'TokenRotationPriceContextRuntime1111111111111';
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:10:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([
      {
        kolId: 'alice',
        tier: 'A',
        tokenMint: coveredMint,
        action: 'buy',
        timestamp: Date.parse('2026-05-02T00:12:00.000Z'),
        solAmount: 0.2,
      },
      {
        kolId: 'bob',
        tier: 'A',
        tokenMint: noProbeMint,
        action: 'buy',
        timestamp: Date.parse('2026-05-02T00:12:10.000Z'),
        solAmount: 0.3,
      },
      {
        kolId: 'carol',
        tier: 'S',
        tokenMint: runtimeMint,
        action: 'buy',
        timestamp: Date.parse('2026-05-02T00:12:20.000Z'),
        solAmount: 0.4,
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        lane: 'kol_hunter',
        signalSource: 'kol_hunter_rotation_v1',
        rejectReason: 'rotation_v1_no_trade',
        tokenMint: runtimeMint,
        rejectedAt: '2026-05-02T00:12:21.000Z',
      },
    ]));
    await writeFile(path.join(dir, 'kol-call-funnel.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([
      {
        eventKind: 'reject',
        generatedAt: '2026-05-02T00:12:22.000Z',
        context: {
          tokenMint: runtimeMint,
          entryReason: 'rotation_v1',
          rejectReason: 'price_context_markout_not_scheduled',
        },
      },
    ]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        tokenMint: coveredMint,
        horizonSec: 30,
        quoteStatus: 'ok',
        deltaPct: 0.03,
        recordedAt: '2026-05-02T00:12:30.000Z',
      },
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-02T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationPriceContextMarkouts.coverageGap).toMatchObject({
      missingBuyMarkoutTokenRows: 2,
      missingBuyMarkoutKolTxRows: 2,
      rotationSpecificMissingTokenRows: 1,
      rotationSpecificMissingKolTxRows: 1,
      rotationPolicyAttributionDriftTokenRows: 0,
      rotationPolicyAttributionDriftRows: 0,
      topMissingReasons: expect.arrayContaining([
        { reason: 'kol_tx_only_no_probe', count: 1 },
        { reason: 'runtime_candidate_without_buy_markout', count: 1 },
      ]),
      topMissingNoTradeReasons: [
        { reason: 'rotation_v1_no_trade', count: 1 },
      ],
      topMissingPolicyEntryReasons: [
        { reason: 'rotation_v1', count: 1 },
      ],
      topMissingPolicyRejectReasons: [
        { reason: 'price_context_markout_not_scheduled', count: 1 },
      ],
      topMissingRotationPolicyEntryReasons: [
        { reason: 'rotation_v1', count: 1 },
      ],
      topMissingRotationPolicyRejectReasons: [
        { reason: 'price_context_markout_not_scheduled', count: 1 },
      ],
      topMissingRotationPolicyAttributionDriftReasons: [],
      topMissingRotationPolicyAttributionSources: [],
      topMissingRotationPolicyAttributionSurvivalReasons: [],
    });
    expect(report.rotationPriceContextMarkouts.coverageGap.topMissingTokens.map((row) =>
      row.gapReason
    )).toEqual(expect.arrayContaining([
      'kol_tx_only_no_probe',
      'runtime_candidate_without_buy_markout',
    ]));

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('### Price-Context Coverage Gap');
    expect(markdown).toContain('runtime_candidate_without_buy_markout');
    expect(markdown).toContain('kol_tx_only_no_probe');
    expect(markdown).toContain('top missing no-trade reasons: rotation_v1_no_trade:1');
    expect(markdown).toContain('top missing policy reject reasons: price_context_markout_not_scheduled:1');
    expect(markdown).toContain('rotation-specific missing tokens: 1/2');
    expect(markdown).toContain('top missing rotation policy reject reasons: price_context_markout_not_scheduled:1');
    expect(markdown).toContain('rotation policy attribution drift rows: 0');
    expect(markdown).toContain('top missing rotation policy attribution drift reasons: n/a');
    expect(markdown).toContain('top missing rotation policy attribution sources: n/a');
    expect(markdown).toContain('top missing rotation policy attribution survival reasons: n/a');
  });

  it('reports non-rotation rejects on rotation policy decisions as attribution drift', async () => {
    const driftMint = 'TokenRotationPolicyAttributionDrift1111111111';
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:10:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([
      {
        kolId: 'alice',
        tier: 'S',
        tokenMint: driftMint,
        action: 'buy',
        timestamp: Date.parse('2026-05-02T00:12:00.000Z'),
        solAmount: 0.2,
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        tokenMint: driftMint,
        lane: 'kol_hunter',
        rejectReason: 'rotation_underfill_kol_alpha_decay',
        signalSource: 'rotation_underfill_v1',
        rejectedAt: '2026-05-02T00:12:01.000Z',
        extras: {
          survivalFlags: ['KOL_ALPHA_DECAY'],
        },
        probe: {
          offsetSec: 15,
          firedAt: '2026-05-02T00:12:16.000Z',
          quoteStatus: 'ok',
          deltaPct: 0.04,
        },
      },
      {
        tokenMint: driftMint,
        lane: 'kol_hunter',
        rejectReason: 'rotation_underfill_kol_alpha_decay',
        signalSource: 'rotation_underfill_v1',
        rejectedAt: '2026-05-02T00:12:01.000Z',
        extras: {
          survivalFlags: ['KOL_ALPHA_DECAY'],
        },
        probe: {
          offsetSec: 30,
          firedAt: '2026-05-02T00:12:31.000Z',
          quoteStatus: 'ok',
          deltaPct: 0.03,
        },
      },
    ]));
    await writeFile(path.join(dir, 'kol-call-funnel.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([
      {
        eventKind: 'reject',
        currentAction: 'block',
        reasons: ['reject_policy_observed'],
        riskFlags: ['KOL_ALPHA_DECAY'],
        generatedAt: '2026-05-02T00:12:01.000Z',
        context: {
          tokenMint: driftMint,
          entryReason: 'rotation_v1',
          rejectReason: 'smart_v3_no_trigger',
        },
      },
    ]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-02T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationPriceContextMarkouts.coverageGap).toMatchObject({
      missingBuyMarkoutTokenRows: 1,
      rotationSpecificMissingTokenRows: 1,
      rotationPolicyAttributionDriftTokenRows: 1,
      rotationPolicyAttributionDriftRows: 1,
      topMissingRotationPolicyAttributionDriftReasons: [
        { reason: 'smart_v3_no_trigger', count: 1 },
      ],
      topMissingRotationPolicyAttributionSources: [
        { source: 'legacy_reject_observer', count: 1 },
      ],
      topMissingRotationPolicyAttributionSurvivalReasons: [
        { reason: 'KOL_ALPHA_DECAY', count: 1 },
      ],
    });
    expect(report.rotationPriceContextMarkouts.coverageGap.topMissingTokens[0]).toMatchObject({
      rotationPolicyAttributionDriftRows: 1,
      topRotationPolicyAttributionDriftReasons: [
        { reason: 'smart_v3_no_trigger', count: 1 },
      ],
      topRotationPolicyAttributionSources: [
        { source: 'legacy_reject_observer', count: 1 },
      ],
      topRotationPolicyAttributionSurvivalReasons: [
        { reason: 'KOL_ALPHA_DECAY', count: 1 },
      ],
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('rotation policy attribution drift tokens: 1/1');
    expect(markdown).toContain('rotation policy attribution drift rows: 1');
    expect(markdown).toContain('top missing rotation policy attribution drift reasons: smart_v3_no_trigger:1');
    expect(markdown).toContain('top missing rotation policy attribution sources: legacy_reject_observer:1');
    expect(markdown).toContain('top missing rotation policy attribution survival reasons: KOL_ALPHA_DECAY:1');
    expect(report.rotationDecayBlockMarkouts).toMatchObject({
      verdict: 'DECAY_KILLED_WINNERS',
      policyRows: 1,
      tokenRows: 1,
      immediateWinnerTokenRows: 1,
      delayedRecoveryTokenRows: 0,
      savedLossTokenRows: 0,
      insufficientCoverageTokenRows: 0,
      probeRows: 2,
      probeTokenRows: 1,
      topRejectReasons: [
        { reason: 'smart_v3_no_trigger', count: 1 },
      ],
      topSources: [
        { source: 'legacy_reject_observer', count: 1 },
      ],
      topSurvivalReasons: [
        { reason: 'KOL_ALPHA_DECAY', count: 1 },
      ],
    });
    expect(report.rotationDecayBlockMarkouts.horizons).toEqual(expect.arrayContaining([
      expect.objectContaining({ horizonSec: 15, positivePostCostRows: 1 }),
      expect.objectContaining({ horizonSec: 30, positivePostCostRows: 1 }),
    ]));
    expect(report.rotationDecayBlockMarkouts.topTokens[0]).toMatchObject({
      recoveryClass: 'immediate_winner',
      primaryHorizonSec: 30,
    });
    expect(markdown).toContain('## Rotation KOL-Decay Block Markouts');
    expect(markdown).toContain('DECAY_KILLED_WINNERS');
    expect(markdown).toContain('recovery classes: immediate_winner=1, delayed_recovery=0');
  });

  it('classifies rotation decay blocks that recover only by T+60', async () => {
    const recoveryMint = 'TokenRotationDecayDelayedRecovery111111111';
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:10:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        tokenMint: recoveryMint,
        lane: 'kol_hunter',
        rejectReason: 'rotation_underfill_kol_alpha_decay',
        signalSource: 'rotation_underfill_v1',
        rejectedAt: '2026-05-02T00:12:01.000Z',
        extras: {
          survivalFlags: ['KOL_ALPHA_DECAY'],
        },
        probe: {
          offsetSec: 30,
          firedAt: '2026-05-02T00:12:31.000Z',
          quoteStatus: 'ok',
          deltaPct: -0.02,
        },
      },
      {
        tokenMint: recoveryMint,
        lane: 'kol_hunter',
        rejectReason: 'rotation_underfill_kol_alpha_decay',
        signalSource: 'rotation_underfill_v1',
        rejectedAt: '2026-05-02T00:12:01.000Z',
        extras: {
          survivalFlags: ['KOL_ALPHA_DECAY'],
        },
        probe: {
          offsetSec: 60,
          firedAt: '2026-05-02T00:13:01.000Z',
          quoteStatus: 'ok',
          deltaPct: 0.05,
        },
      },
    ]));
    await writeFile(path.join(dir, 'kol-call-funnel.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([
      {
        eventKind: 'reject',
        currentAction: 'block',
        reasons: ['reject_policy_observed'],
        riskFlags: ['KOL_ALPHA_DECAY'],
        generatedAt: '2026-05-02T00:12:01.000Z',
        bucket: {
          style: 'scalper',
          independentKolBucket: 'multi_2_3',
          liquidityBucket: 'route_ok_or_unknown',
          securityBucket: 'clean_or_unknown',
        },
        metrics: {
          kolScore: 72,
        },
        context: {
          tokenMint: recoveryMint,
          entryReason: 'rotation_v1',
          rejectReason: 'smart_v3_no_trigger',
          source: 'reject_observer',
          parameterVersion: 'rotation-underfill-v1.0.0',
          signalSource: 'rotation_underfill_v1',
          survivalReason: 'KOL_ALPHA_DECAY',
          participatingKols: [
            {
              id: 'alice',
              tier: 'A',
              style: 'scalper',
              timestamp: Date.parse('2026-05-02T00:12:00.000Z'),
            },
          ],
        },
      },
    ]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-02T00:00:00.000Z'),
      horizonsSec: [30, 60],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationDecayBlockMarkouts).toMatchObject({
      verdict: 'DECAY_SAVED_LOSS',
      immediateWinnerTokenRows: 0,
      delayedRecoveryTokenRows: 1,
      savedLossTokenRows: 0,
      insufficientCoverageTokenRows: 0,
    });
    const delayed = report.rotationDecayBlockMarkouts.topDelayedRecoveryTokens[0];
    expect(delayed).toMatchObject({
      recoveryClass: 'delayed_recovery',
      primaryHorizonSec: 30,
      decayHorizonSec: 60,
      topParameterVersions: [
        { version: 'rotation-underfill-v1.0.0', count: 1 },
      ],
      topSignalSources: [
        { source: 'rotation_underfill_v1', count: 1 },
      ],
      topStyleBuckets: [
        { style: 'scalper', count: 1 },
      ],
      topIndependentBuckets: [
        { bucket: 'multi_2_3', count: 1 },
      ],
      topKolTiers: [
        { tier: 'A', count: 1 },
      ],
      topKols: [
        { kol: 'alice', count: 1 },
      ],
      medianPolicyKolScore: 72,
    });
    expect(delayed.primaryMedianPostCostDeltaPct).toBeCloseTo(-0.025);
    expect(delayed.decayMedianPostCostDeltaPct).toBeCloseTo(0.045);
    expect(delayed.recoveryDeltaPct).toBeCloseTo(0.07);
    expect(report.rotationDecayBlockMarkouts.recoveryProfiles.find((row) =>
      row.recoveryClass === 'delayed_recovery'
    )).toMatchObject({
      tokenRows: 1,
      policyRows: 1,
      medianPolicyKolScore: 72,
      topStyleBuckets: [
        { style: 'scalper', count: 1 },
      ],
      topIndependentBuckets: [
        { bucket: 'multi_2_3', count: 1 },
      ],
      topKolTiers: [
        { tier: 'A', count: 1 },
      ],
      topKols: [
        { kol: 'alice', count: 1 },
      ],
    });
    expect(report.rotationDecayBlockMarkouts.graceWatchlist).toMatchObject({
      profile: 'scalper_a_single_or_2_3kol_clean_route',
      verdict: 'COLLECT',
      tokenRows: 1,
      policyRows: 1,
      delayedRecoveryTokenRows: 1,
      savedLossTokenRows: 0,
    });
    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('### Rotation Decay Recovery Profiles');
    expect(markdown).toContain('### Rotation Decay Paper-Grace Watchlist');
    expect(markdown).toContain('watchlist tokens 1 < 10');
    expect(markdown).toContain('### Rotation Delayed-Recovery Tokens');
    expect(markdown).toContain('scalper:1');
    expect(markdown).toContain('alice:1');
  });

  it('flags rotation funnel rows without downstream ledgers as a ledger gap', async () => {
    await writeFile(path.join(dir, 'current-session.json'), JSON.stringify({
      version: 1,
      startedAt: '2026-05-02T00:10:00.000Z',
      tradingMode: 'live',
    }));
    await writeFile(path.join(dir, 'kol-tx.jsonl'), jsonl([
      {
        kolId: 'rotator',
        tokenMint: 'TokenRotationAfterSession1111111111111111111',
        action: 'buy',
        timestamp: Date.parse('2026-05-02T00:12:00.000Z'),
        solAmount: 0.2,
      },
    ]));
    await writeFile(path.join(dir, 'kol-call-funnel.jsonl'), jsonl([
      {
        schemaVersion: 'kol-call-funnel/v1',
        eventType: 'rotation_candidate',
        emitTsMs: Date.parse('2026-05-02T00:12:01.000Z'),
        tokenMint: 'TokenRotationAfterSession1111111111111111111',
        armName: 'rotation_underfill_v1',
        signalSource: 'rotation_underfill_v1',
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-policy-decisions.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.rotationCandidateFunnel).toMatchObject({
      verdict: 'ROTATION_LEDGER_GAP',
      kolTxRows: 1,
      callFunnelRows: 1,
      rotationCallFunnelRows: 1,
      rotationNoTradeEvents: 0,
      rotationPolicyDecisionRows: 0,
      rotationPaperCloseRows: 0,
      topRotationCallFunnelEventTypes: [{ eventType: 'rotation_candidate', count: 1 }],
    });
    expect(report.rotationCandidateFunnel.reasons).toContain(
      'rotation funnel rows exist without no-trade/policy/paper close artifacts; rotationFunnel=1'
    );
  });

  it('separates deployed writer schema from missing exit-route markers', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: armName,
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'fresh-schema-no-marker',
        closedAt: '2026-05-02T00:00:30.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 30,
        netSol: 0.001,
        netSolTokenOnly: 0.0012,
        paperCloseWriterSchemaVersion: 'kol-paper-close/v2',
        rotationExitRouteProofSchemaVersion: 'rotation-exit-route-proof/v1',
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
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeProofFreshness).toMatchObject({
      verdict: 'INSTRUMENTATION_GAP',
      cutoffSource: 'none',
      freshRows: 1,
      paperCloseWriterSchemaRows: 1,
      rotationExitRouteProofSchemaRows: 1,
      exitRouteInstrumentedRows: 0,
      instrumentationMissingRows: 1,
      topPaperCloseWriterSchemas: [{ schema: 'kol-paper-close/v2', count: 1 }],
    });
    expect(report.routeProofFreshness.reasons).toContain(
      'route-proof writer schema present but exit-route markers missing 1/1; write-path drift likely'
    );
    expect(report.routeProofFreshness.freshByArm.find((row) =>
      row.armName === armName
    )).toMatchObject({
      paperCloseWriterSchemaRows: 1,
      rotationExitRouteProofSchemaRows: 1,
      topPaperCloseWriterSchemas: [{ schema: 'kol-paper-close/v2', count: 1 }],
    });
  });

  it('marks route-proof freshness as instrumentation gap when routeFound is null', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: armName,
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'fresh-route-null',
        closedAt: '2026-05-02T00:00:30.000Z',
        exitReason: 'probe_reject_timeout',
        holdSec: 30,
        netSol: -0.0001,
        netSolTokenOnly: 0,
        exitSellQuoteEvidence: {
          schemaVersion: 'kol-exit-sell-quote/v1',
          probeEnabled: true,
          approved: true,
          routeFound: null,
        },
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
      routeProofFreshSinceMs: Date.parse('2026-05-02T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeProofFreshness).toMatchObject({
      verdict: 'INSTRUMENTATION_GAP',
      freshRows: 1,
      exitRouteInstrumentedRows: 1,
      exitQuoteEvidenceRows: 1,
      exitQuoteUnknownRows: 1,
      instrumentationMissingRows: 0,
      routeProofRows: 0,
    });
    expect(report.routeProofFreshness.freshByArm.find((row) =>
      row.armName === armName
    )).toMatchObject({
      rows: 1,
      exitQuoteEvidenceRows: 1,
      missingEvidenceRows: 0,
      routeFoundTrueRows: 0,
      routeFoundFalseRows: 0,
      routeFoundNullRows: 1,
      routeProofRows: 0,
    });
  });

  it('classifies explicit exit-route proof skip reasons as data gap instead of instrumentation gap', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_underfill_v1',
        profileArm: armName,
        entryArm: 'rotation_underfill_v1',
        kolEntryReason: 'rotation_v1',
        positionId: 'fresh-route-skip',
        closedAt: '2026-05-02T00:00:30.000Z',
        exitReason: 'probe_reject_timeout',
        holdSec: 30,
        netSol: -0.0001,
        netSolTokenOnly: 0,
        exitRouteProofSkipReason: 'sell_quote_error',
        exitSellQuoteEvidence: {
          schemaVersion: 'kol-exit-sell-quote/v1',
          probeEnabled: true,
          approved: true,
          routeFound: null,
          reason: 'sell_quote_error',
          quoteFailed: true,
        },
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
      routeProofFreshSinceMs: Date.parse('2026-05-02T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
      assumedNetworkFeeSol: 0.0001,
    });

    expect(report.routeProofFreshness).toMatchObject({
      verdict: 'DATA_GAP',
      freshRows: 1,
      exitRouteInstrumentedRows: 1,
      exitQuoteEvidenceRows: 1,
      exitQuoteUnknownRows: 0,
      exitRouteProofSkippedRows: 1,
      instrumentationMissingRows: 0,
      routeProofRows: 0,
      topExitRouteProofSkipReasons: [{ reason: 'sell_quote_error', count: 1 }],
      topRouteUnknownReasons: [{ reason: 'EXIT_ROUTE_PROOF_SELL_QUOTE_ERROR', count: 1 }],
    });
    expect(report.routeProofFreshness.freshByArm.find((row) =>
      row.armName === armName
    )).toMatchObject({
      rows: 1,
      exitQuoteEvidenceRows: 1,
      exitRouteProofSkippedRows: 1,
      missingEvidenceRows: 0,
      routeFoundNullRows: 1,
      routeProofRows: 0,
      topExitRouteProofSkipReasons: [{ reason: 'sell_quote_error', count: 1 }],
    });

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('fresh exit-route proof skipped or inconclusive 1/1');
    expect(markdown).toContain('top exit-route proof skip reasons: sell_quote_error:1');
  });

  it('marks fresh route-proofed narrow samples ready for the narrow cohort board', async () => {
    const armName = 'rotation_underfill_cost_aware_exit_v2';
    const rows = readyUnderfillPaperRows(armName).map((row) => ({
      ...(row as Record<string, unknown>),
      exitSellQuoteEvidence: {
        schemaVersion: 'kol-exit-sell-quote/v1',
        probeEnabled: true,
        approved: true,
        routeFound: true,
      },
      exitRouteFound: true,
      exitSellRouteKnown: true,
    }));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl(rows));
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

    expect(report.routeProofFreshness).toMatchObject({
      verdict: 'READY_FOR_NARROW_REVIEW',
      freshRows: 50,
      exitRouteInstrumentedRows: 50,
      exitQuoteEvidenceRows: 50,
      exitQuoteRouteFoundRows: 50,
      routeProofRows: 50,
      routeProofedTwoPlusCostAwareRows: 50,
      routeProofedTwoPlusCostAwareTimestampedRows: 50,
    });
    expect(report.rotationNarrowCohorts.find((row) =>
      row.cohort === 'route_proofed_2plus_cost_aware'
    )?.verdict).toBe('PAPER_READY');

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('fresh route-proofed narrow sample is ready for the narrow cohort board');
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
        routeFound: true,
        sellRouteKnown: true,
        exitLiquidityKnown: true,
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

  it('blocks promotion candidate verdict when sampled paper edge lacks route proof', async () => {
    const armName = 'kol_hunter_rotation_v1';
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl(
      Array.from({ length: 100 }, (_, index) => ({
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName,
        parameterVersion: 'rotation-underfill-v1.0.0',
        kolEntryReason: 'rotation_v1',
        positionId: `rot-route-gap-${index}`,
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
        positionId: `rot-route-gap-${index}`,
        tokenMint: `MintRotationRouteGap${index}`,
        horizonSec,
        quoteStatus: 'ok',
        deltaPct: 0.03,
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
    expect(verdict?.verdict).toBe('DATA_GAP');
    expect(verdict?.routeProofRows).toBe(0);
    expect(verdict?.routeProofCoverage).toBe(0);
    expect(verdict?.reasons.join('; ')).toContain('route proof 0/100');
  });

  it('does not count approved sell-quote evidence as route proof without routeFound', async () => {
    const armName = 'kol_hunter_rotation_v1';
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl(
      Array.from({ length: 100 }, (_, index) => ({
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName,
        parameterVersion: 'rotation-underfill-v1.0.0',
        kolEntryReason: 'rotation_v1',
        positionId: `rot-approved-only-${index}`,
        closedAt: `2026-05-02T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        exitReason: 'winner_trailing_t1',
        holdSec: 18,
        netSol: 0.002,
        netSolTokenOnly: 0.003,
        entrySellQuoteEvidence: {
          schemaVersion: 'kol-entry-sell-quote/v1',
          probeEnabled: false,
          approved: true,
          routeFound: null,
        },
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
        positionId: `rot-approved-only-${index}`,
        tokenMint: `MintRotationApprovedOnly${index}`,
        horizonSec,
        quoteStatus: 'ok',
        deltaPct: 0.03,
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
    expect(verdict?.verdict).toBe('DATA_GAP');
    expect(verdict?.routeProofRows).toBe(0);
    expect(verdict?.routeProofCoverage).toBe(0);
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
