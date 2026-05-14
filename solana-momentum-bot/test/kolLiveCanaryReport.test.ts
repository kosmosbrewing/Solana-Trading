import {
  buildKolLiveCanaryReport,
  formatKolLiveCanaryMarkdown,
  pairKolLiveTrades,
  resolveSinceArg,
  type KolLiveBuyLedger,
  type MissedAlphaLedgerRecord,
  type KolPaperTradeLedger,
  type KolLiveSellLedger,
} from '../scripts/kol-live-canary-report';

function buy(overrides: Partial<KolLiveBuyLedger> = {}): KolLiveBuyLedger {
  return {
    positionId: 'kolh-live-MINT0001-1000',
    txSignature: 'buy-1',
    strategy: 'kol_hunter',
    wallet: 'main',
    pairAddress: 'MINT0001',
    plannedEntryPrice: 0.001,
    actualEntryPrice: 0.001,
    actualQuantity: 10,
    slippageBps: 12,
    signalTimeSec: 1_000,
    recordedAt: new Date(1_000_000).toISOString(),
    kolScore: 7,
    independentKolCount: 2,
    ...overrides,
  };
}

function sell(overrides: Partial<KolLiveSellLedger> = {}): KolLiveSellLedger {
  return {
    positionId: 'kolh-live-MINT0001-1000',
    txSignature: 'sell-1',
    entryTxSignature: 'buy-1',
    strategy: 'kol_hunter',
    wallet: 'main',
    pairAddress: 'MINT0001',
    exitReason: 'winner_trailing_t1',
    receivedSol: 0.012,
    actualExitPrice: 0.0012,
    slippageBps: 25,
    entryPrice: 0.001,
    holdSec: 120,
    recordedAt: new Date(1_120_000).toISOString(),
    mfePctPeak: 0.8,
    peakPrice: 0.0018,
    troughPrice: 0.0009,
    marketReferencePrice: 0.001,
    t1VisitAtSec: 90,
    t2VisitAtSec: null,
    t3VisitAtSec: null,
    dbPnlSol: 0.002,
    walletDeltaSol: 0.002,
    solSpentNominal: 0.01,
    kolScore: 7,
    independentKolCount: 2,
    armName: 'smart-v3',
    parameterVersion: 'smart-v3.0.0',
    ...overrides,
  };
}

function paperTrade(overrides: Partial<KolPaperTradeLedger> = {}): KolPaperTradeLedger {
  return {
    positionId: 'kolh-paper-MINT0001-1000',
    strategy: 'kol_hunter',
    tokenMint: 'MINT0001',
    netSol: -0.001,
    netPct: -0.1,
    mfePctPeak: 0.2,
    maePct: -0.1,
    holdSec: 180,
    exitReason: 'probe_hard_cut',
    survivalFlags: ['LIVE_EXEC_QUALITY_COOLDOWN'],
    closedAt: new Date(1_200_000).toISOString(),
    armName: 'smart-v3',
    parameterVersion: 'smart-v3.0.0',
    independentKolCount: 2,
    kolScore: 7,
    ...overrides,
  };
}

function missedAlphaRecord(overrides: Partial<MissedAlphaLedgerRecord> = {}): MissedAlphaLedgerRecord {
  return {
    eventId: 'ma-1120000-MINT0001',
    tokenMint: 'MINT0001',
    lane: 'kol_hunter',
    rejectCategory: 'kol_close',
    rejectReason: 'winner_trailing_t1',
    rejectedAt: new Date(1_120_000).toISOString(),
    extras: {
      isLive: true,
      elapsedSecAtClose: 120,
    },
    probe: {
      offsetSec: 60,
      firedAt: new Date(1_180_000).toISOString(),
      observedPrice: 0.0015,
      deltaPct: 0.5,
      quoteStatus: 'ok',
      quoteReason: null,
    },
    ...overrides,
  };
}

function liveRoundTrip(
  index: number,
  buyOverrides: Partial<KolLiveBuyLedger> = {},
  sellOverrides: Partial<KolLiveSellLedger> = {}
): { buy: KolLiveBuyLedger; sell: KolLiveSellLedger } {
  const mint = `MINT${String(index).padStart(4, '0')}`;
  const positionId = `kolh-live-${mint}-1000`;
  const entryTx = `buy-${index}`;
  return {
    buy: buy({
      positionId,
      txSignature: entryTx,
      pairAddress: mint,
      recordedAt: new Date(1_000_000 + index * 10_000).toISOString(),
      ...buyOverrides,
    }),
    sell: sell({
      positionId,
      txSignature: `sell-${index}`,
      entryTxSignature: entryTx,
      pairAddress: mint,
      recordedAt: new Date(1_120_000 + index * 10_000).toISOString(),
      ...sellOverrides,
    }),
  };
}

describe('kol-live-canary-report', () => {
  it('parses --since-hours for recent operating windows', () => {
    const nowMs = Date.parse('2026-04-30T12:00:00.000Z');

    expect(resolveSinceArg(['--since-hours', '24'], nowMs)?.toISOString())
      .toBe('2026-04-29T12:00:00.000Z');
    expect(resolveSinceArg(['--since', '2026-04-30T00:00:00.000Z', '--since-hours', '24'], nowMs)?.toISOString())
      .toBe('2026-04-30T00:00:00.000Z');
    expect(resolveSinceArg(['--since-hours', '0'], nowMs)).toBeUndefined();
  });

  it('pairs KOL live buys and sells, excluding paper/other lanes', () => {
    const buys = [
      buy(),
      buy({ positionId: 'paper-1', txSignature: 'paper-buy', wallet: 'paper' }),
      buy({ positionId: 'pure-1', txSignature: 'pure-buy', strategy: 'pure_ws_breakout' }),
    ];
    const sells = [
      sell(),
      sell({ positionId: 'paper-1', entryTxSignature: 'paper-buy', wallet: 'paper' }),
      sell({ positionId: 'pure-1', entryTxSignature: 'pure-buy', strategy: 'pure_ws_breakout' }),
    ];

    const paired = pairKolLiveTrades(buys, sells);

    expect(paired.trades).toHaveLength(1);
    expect(paired.trades[0].netSol).toBeCloseTo(0.002, 6);
    expect(paired.trades[0].walletTruthSource).toBe('walletDeltaSol');
    expect(paired.trades[0].actualMfePctPeak).toBeCloseTo(0.8, 6);
    expect(paired.trades[0].actualMaePct).toBeCloseTo(-0.1, 6);
    expect(paired.trades[0].entryAdvantagePct).toBeCloseTo(0, 6);
    expect(paired.trades[0].buyLagSec).toBeCloseTo(0, 6);
    expect(paired.trades[0].partialFillDataMissing).toBe(false);
    expect(paired.openBuys).toBe(0);
    expect(paired.orphanSells).toBe(0);
  });

  it('preserves promoted profile arms for live canary attribution', () => {
    const buys = [
      buy({
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_exit_flow_v1',
        entryArm: 'rotation_underfill_v1',
        exitArm: 'rotation_exit_kol_flow_v1',
      }),
    ];
    const sells = [
      sell({
        armName: 'rotation_underfill_v1',
        profileArm: 'rotation_underfill_exit_flow_v1',
        entryArm: 'rotation_underfill_v1',
        exitArm: 'rotation_exit_kol_flow_v1',
      }),
    ];
    const paired = pairKolLiveTrades(buys, sells);

    expect(paired.trades[0].armName).toBe('rotation_underfill_v1');
    expect(paired.trades[0].profileArm).toBe('rotation_underfill_exit_flow_v1');
    expect(paired.trades[0].entryArm).toBe('rotation_underfill_v1');
    expect(paired.trades[0].exitArm).toBe('rotation_exit_kol_flow_v1');

    const report = buildKolLiveCanaryReport(buys, sells);

    expect(report.byArm.some((row) => row.bucket.startsWith('rotation_underfill_exit_flow_v1/'))).toBe(true);
    expect(report.byArm.some((row) => row.bucket.startsWith('rotation_underfill_v1/'))).toBe(false);
  });

  it('falls back through wallet-truth sources and counts orphan/open rows', () => {
    const buys = [
      buy(),
      buy({ positionId: 'kolh-live-MINT0002-1000', txSignature: 'buy-open', pairAddress: 'MINT0002' }),
    ];
    const sells = [
      sell({ walletDeltaSol: undefined, dbPnlSol: 0.003 }),
      sell({
        positionId: 'kolh-live-MINT9999-1000',
        txSignature: 'sell-orphan',
        entryTxSignature: 'missing-buy',
        pairAddress: 'MINT9999',
        walletDeltaSol: undefined,
        dbPnlSol: undefined,
        solSpentNominal: 0.01,
        receivedSol: 0.009,
        exitReason: 'probe_hard_cut',
      }),
    ];

    const paired = pairKolLiveTrades(buys, sells);

    expect(paired.trades).toHaveLength(2);
    expect(paired.trades[0].walletTruthSource).toBe('dbPnlSol');
    expect(paired.trades[1].walletTruthSource).toBe('solSpentNominal');
    expect(paired.trades[1].orphanSell).toBe(true);
    expect(paired.orphanSells).toBe(1);
    expect(paired.openBuys).toBe(1);
  });

  it('matches windowed sells to pre-window buys without marking them orphan', () => {
    const since = new Date(1_100_000);
    const buys = [
      buy({
        positionId: 'kolh-live-MINT0001-0900',
        txSignature: 'buy-before-window',
        recordedAt: new Date(900_000).toISOString(),
        partialFillDataMissing: true,
      }),
      buy({
        positionId: 'kolh-live-MINT0002-1130',
        txSignature: 'buy-open-in-window',
        pairAddress: 'MINT0002',
        recordedAt: new Date(1_130_000).toISOString(),
      }),
    ];
    const sells = [
      sell({
        positionId: 'kolh-live-MINT0001-0900',
        txSignature: 'sell-in-window',
        entryTxSignature: 'buy-before-window',
        recordedAt: new Date(1_120_000).toISOString(),
      }),
    ];

    const paired = pairKolLiveTrades(buys, sells, since);

    expect(paired.trades).toHaveLength(1);
    expect(paired.trades[0].orphanSell).toBe(false);
    expect(paired.trades[0].entryTxSignature).toBe('buy-before-window');
    expect(paired.trades[0].partialFillDataMissing).toBe(true);
    expect(paired.orphanSells).toBe(0);
    expect(paired.openBuys).toBe(1);
  });

  it('separates legacy buy lag, explicit buy execution, and fresh quote reference drift', () => {
    const buys = [
      buy({
        plannedEntryPrice: 0.001,
        actualEntryPrice: 0.0022,
        actualQuantity: 4.545454,
        expectedInAmount: '10000000',   // 0.01 SOL
        inputDecimals: 9,
        expectedOutAmount: '5000000',   // 5 tokens
        outputDecimals: 6,
        recordedAt: new Date(1_012_000).toISOString(),
        referenceAgeMs: 250,
        signalToReferenceMs: 65_000,
        buyExecutionMs: 1_500,
      }),
    ];
    const sells = [
      sell({
        entryPrice: 0.0022,
        marketReferencePrice: 0.001,
        peakPrice: 0.0024,
      }),
    ];

    const paired = pairKolLiveTrades(buys, sells);
    const trade = paired.trades[0];

    expect(trade.buyLagSec).toBeCloseTo(12, 6);
    expect(trade.buyExecutionSec).toBeCloseTo(1.5, 6);
    expect(trade.referenceAgeSec).toBeCloseTo(0.25, 6);
    expect(trade.signalToReferenceSec).toBeCloseTo(65, 6);
    expect(trade.swapQuoteEntryPrice).toBeCloseTo(0.002, 9);
    expect(trade.swapQuoteEntryAdvantagePct).toBeCloseTo(0.1, 6);
    expect(trade.referenceToSwapQuotePct).toBeCloseTo(1, 6);

    const report = buildKolLiveCanaryReport(buys, sells);
    expect(report.avgBuyLagSec).toBeCloseTo(12, 6);
    expect(report.avgBuyExecutionSec).toBeCloseTo(1.5, 6);
    expect(report.avgReferenceAgeSec).toBeCloseTo(0.25, 6);
    expect(report.avgSignalToReferenceSec).toBeCloseTo(65, 6);
    expect(report.avgSwapQuoteEntryAdvantagePct).toBeCloseTo(0.1, 6);
    expect(report.avgReferenceToSwapQuotePct).toBeCloseTo(1, 6);
    expect(report.byBuyExecutionBucket[0].bucket).toBe('0-5s');
    expect(report.byReferenceToSwapQuoteBucket[0].bucket).toBe('20..100% fresh_worse');
  });

  it('summarizes exit reason, independent-KOL, slippage, and arm buckets', () => {
    const buys = [
      buy({ txSignature: 'buy-1', positionId: 'kolh-live-MINT0001-1000', independentKolCount: 1, slippageBps: 1200 }),
      buy({ txSignature: 'buy-2', positionId: 'kolh-live-MINT0002-1000', pairAddress: 'MINT0002', independentKolCount: 2, slippageBps: 15 }),
      buy({ txSignature: 'buy-3', positionId: 'kolh-live-MINT0003-1000', pairAddress: 'MINT0003', independentKolCount: 3, slippageBps: 30 }),
    ];
    const sells = [
      sell({
        positionId: 'kolh-live-MINT0001-1000',
        txSignature: 'sell-1',
        entryTxSignature: 'buy-1',
        exitReason: 'probe_hard_cut',
        walletDeltaSol: -0.006,
        mfePctPeak: 0.01,
        independentKolCount: 1,
        slippageBps: 1300,
      }),
      sell({
        positionId: 'kolh-live-MINT0002-1000',
        txSignature: 'sell-2',
        entryTxSignature: 'buy-2',
        pairAddress: 'MINT0002',
        exitReason: 'winner_trailing_t1',
        walletDeltaSol: 0.03,
        mfePctPeak: 0.8,
        independentKolCount: 2,
        slippageBps: 20,
      }),
      sell({
        positionId: 'kolh-live-MINT0003-1000',
        txSignature: 'sell-3',
        entryTxSignature: 'buy-3',
        pairAddress: 'MINT0003',
        exitReason: 'winner_trailing_t2',
        walletDeltaSol: 0.09,
        mfePctPeak: 4.5,
        peakPrice: 0.0055,
        t2VisitAtSec: 300,
        independentKolCount: 3,
        slippageBps: -40,
        armName: 'smart-v3',
        parameterVersion: 'smart-v3.0.1',
      }),
    ];

    const report = buildKolLiveCanaryReport(buys, sells);

    expect(report.closedTrades).toBe(3);
    expect(report.netSol).toBeCloseTo(0.114, 6);
    expect(report.fiveXVisits).toBe(1);
    expect(report.actualFiveXVisits).toBe(1);
    expect(report.hardcuts).toBe(1);
    expect(report.byExitReason.find((row) => row.bucket === 'probe_hard_cut')?.netSol).toBeCloseTo(-0.006, 6);
    expect(report.byIndependentKolCount.find((row) => row.bucket === '3+')?.trades).toBe(1);
    expect(report.bySlippageBucket.find((row) => row.bucket === '>=1000bps')?.hardcuts).toBe(1);
    expect(report.byBuyLagBucket.find((row) => row.bucket === '0-30s')?.trades).toBe(3);
    expect(report.byFillDataQualityBucket.find((row) => row.bucket === 'measured_fill_metrics')?.trades).toBe(3);
    expect(report.byEntryAdvantageBucket.find((row) => row.bucket === '-5..5% neutral')?.trades).toBe(3);
    expect(report.byActualMfeBucket.find((row) => row.bucket === '>=5x')?.trades).toBe(1);
    expect(report.byArm.some((row) => row.bucket === 'smart-v3/smart-v3.0.1')).toBe(true);
    expect(report.walletTruthSources.walletDeltaSol).toBe(3);
    expect(report.runnerlessQuarantineCandidates).toHaveLength(0);
  });

  it('surfaces runnerless cohort quarantine candidates from pre-entry and execution buckets', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      liveRoundTrip(i + 1, {}, {
        walletDeltaSol: -0.001,
        exitReason: 'probe_hard_cut',
        mfePctPeak: 0.1,
        peakPrice: 0.0011,
      })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell)
    );

    const armCandidate = report.runnerlessQuarantineCandidates.find((candidate) =>
      candidate.dimension === 'arm' &&
      candidate.bucket === 'smart-v3/smart-v3.0.0'
    );
    expect(armCandidate?.trades).toBe(10);
    expect(armCandidate?.actualMfeKnownTrades).toBe(10);
    expect(armCandidate?.netSol).toBeCloseTo(-0.01, 6);
    expect(armCandidate?.actualT2Visits).toBe(0);
    expect(armCandidate?.actualFiveXVisits).toBe(0);
    expect(armCandidate?.hardcuts).toBe(10);
    expect(armCandidate?.reason).toBe('net_negative_no_actual_runner_min10');
    expect(report.runnerlessQuarantineCandidates.some((candidate) =>
      candidate.dimension === 'fill_data_quality' &&
      candidate.bucket === 'measured_fill_metrics'
    )).toBe(true);
    expect(report.runnerlessQuarantineCandidates.some((candidate) =>
      candidate.dimension === 'buy_execution' &&
      candidate.bucket === 'unknown'
    )).toBe(false);
  });

  it('requires enough known actual MFE samples before surfacing runnerless quarantine candidates', () => {
    const nineRows = Array.from({ length: 9 }, (_, i) =>
      liveRoundTrip(i + 1, {}, {
        walletDeltaSol: -0.001,
        exitReason: 'probe_hard_cut',
        mfePctPeak: 0.1,
        peakPrice: 0.0011,
      })
    );
    const unknownActualRows = Array.from({ length: 10 }, (_, i) =>
      liveRoundTrip(i + 1, {}, {
        walletDeltaSol: -0.001,
        exitReason: 'probe_hard_cut',
        mfePctPeak: undefined,
        peakPrice: undefined,
        troughPrice: undefined,
        entryPrice: undefined,
        marketReferencePrice: undefined,
      })
    );

    const nineReport = buildKolLiveCanaryReport(
      nineRows.map((row) => row.buy),
      nineRows.map((row) => row.sell)
    );
    const unknownReport = buildKolLiveCanaryReport(
      unknownActualRows.map((row) => row.buy),
      unknownActualRows.map((row) => row.sell)
    );

    expect(nineReport.runnerlessQuarantineCandidates).toHaveLength(0);
    expect(unknownReport.runnerlessQuarantineCandidates).toHaveLength(0);
  });

  it('does not surface positive net cohorts as runnerless quarantine candidates', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      liveRoundTrip(i + 1, {}, {
        walletDeltaSol: 0.001,
        exitReason: 'probe_reject_timeout',
        mfePctPeak: 0.1,
        peakPrice: 0.0011,
      })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell)
    );

    expect(report.runnerlessQuarantineCandidates).toHaveLength(0);
  });

  it('does not surface runnerless quarantine candidates after actual runner evidence appears', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      liveRoundTrip(i + 1, {}, i === 0
        ? {
            walletDeltaSol: -0.001,
            exitReason: 'winner_trailing_t2',
            mfePctPeak: 4,
            peakPrice: 0.005,
            t2VisitAtSec: 240,
          }
        : {
            walletDeltaSol: -0.001,
            exitReason: 'probe_hard_cut',
            mfePctPeak: 0.1,
            peakPrice: 0.0011,
          })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell)
    );

    expect(report.runnerlessQuarantineCandidates.some((candidate) =>
      candidate.dimension === 'arm' &&
      candidate.bucket === 'smart-v3/smart-v3.0.0'
    )).toBe(false);
  });

  it('separates reference-vs-actual MFE when live fill differs from planned price', () => {
    const report = buildKolLiveCanaryReport(
      [
        buy({
          plannedEntryPrice: 0.002,
          actualEntryPrice: 0.001,
          actualQuantity: 20,
          recordedAt: new Date(1_130_000).toISOString(),
        }),
      ],
      [
        sell({
          entryPrice: 0.001,
          marketReferencePrice: 0.002,
          peakPrice: 0.002,
          troughPrice: 0.0012,
          mfePctPeak: 0,
          walletDeltaSol: 0.01,
          exitReason: 'probe_hard_cut',
        }),
      ]
    );

    expect(report.avgMfePct).toBeCloseTo(0, 6);
    expect(report.avgActualMfePct).toBeCloseTo(1, 6);
    expect(report.avgEntryAdvantagePct).toBeCloseTo(-0.5, 6);
    expect(report.avgBuyLagSec).toBeCloseTo(130, 6);
    expect(report.byEntryAdvantageBucket[0].bucket).toBe('<=-50% favorable');
    expect(report.byBuyLagBucket[0].bucket).toBe('91-180s');
    expect(report.byActualMfeBucket[0].bucket).toBe('>=2x');
    expect(report.measurementMismatchTrades[0].positionId).toBe('kolh-live-MINT0001-1000');
  });

  it('surfaces runner diagnostics and top actual-MFE candidates', () => {
    const rows = [
      liveRoundTrip(1, {}, {
        exitReason: 'probe_hard_cut',
        walletDeltaSol: -0.001,
        mfePctPeak: 0.3,
        peakPrice: 0.0013,
        t1VisitAtSec: null,
      }),
      liveRoundTrip(2, {}, {
        exitReason: 'winner_trailing_t1',
        walletDeltaSol: 0.002,
        mfePctPeak: 0.6,
        peakPrice: 0.0016,
      }),
      liveRoundTrip(3, { actualEntryPrice: 0.002 }, {
        entryPrice: 0.002,
        marketReferencePrice: 0.001,
        exitReason: 'winner_trailing_t1',
        walletDeltaSol: 0.001,
        mfePctPeak: 0.6,
        peakPrice: 0.0016,
      }),
    ];

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell)
    );

    expect(report.runnerDiagnostics.maxActualMfePct).toBeCloseTo(0.6, 6);
    expect(report.runnerDiagnostics.maxRefMfePct).toBeCloseTo(0.6, 6);
    expect(report.runnerDiagnostics.actualT1Visits).toBe(1);
    expect(report.runnerDiagnostics.nearActualT1Trades).toBe(1);
    expect(report.runnerDiagnostics.referenceOnlyT1Trades).toBe(1);
    expect(report.runnerDiagnostics.preT1Hardcuts).toBe(1);
    expect(report.runnerDiagnostics.byActualMfeBucket.find((row) => row.bucket === '>=50%')?.trades).toBe(1);
    expect(report.runnerCandidateTrades[0].positionId).toBe('kolh-live-MINT0002-1000');
  });

  it('joins post-close missed-alpha probes to live canary trades', () => {
    const rows = [
      liveRoundTrip(1, {}, {
        exitReason: 'winner_trailing_t1',
        walletDeltaSol: 0.002,
        mfePctPeak: 0.6,
        peakPrice: 0.0016,
      }),
      liveRoundTrip(2, {}, {
        exitReason: 'probe_hard_cut',
        walletDeltaSol: -0.001,
        mfePctPeak: 0.1,
        peakPrice: 0.0011,
      }),
    ];
    const missedAlpha = [
      missedAlphaRecord({
        eventId: 'ma-1130000-MINT0001',
        tokenMint: 'MINT0001',
        rejectReason: 'winner_trailing_t1',
        rejectedAt: rows[0].sell.recordedAt,
        probe: {
          offsetSec: 0,
          firedAt: rows[0].sell.recordedAt,
          deltaPct: null,
          quoteStatus: 'scheduled',
          quoteReason: null,
        },
      }),
      missedAlphaRecord({
        eventId: 'ma-1130000-MINT0001',
        tokenMint: 'MINT0001',
        rejectReason: 'winner_trailing_t1',
        rejectedAt: rows[0].sell.recordedAt,
        probe: {
          offsetSec: 60,
          firedAt: new Date(1_180_000).toISOString(),
          deltaPct: 0.8,
          quoteStatus: 'ok',
          quoteReason: null,
        },
      }),
      missedAlphaRecord({
        eventId: 'ma-1130000-MINT0001',
        tokenMint: 'MINT0001',
        rejectReason: 'winner_trailing_t1',
        rejectedAt: rows[0].sell.recordedAt,
        probe: {
          offsetSec: 300,
          firedAt: new Date(1_420_000).toISOString(),
          deltaPct: 4.2,
          quoteStatus: 'ok',
          quoteReason: null,
        },
      }),
      missedAlphaRecord({
        eventId: 'ma-1140000-MINT0002',
        tokenMint: 'MINT0002',
        rejectReason: 'probe_hard_cut',
        rejectedAt: rows[1].sell.recordedAt,
        probe: {
          offsetSec: 60,
          firedAt: new Date(1_190_000).toISOString(),
          deltaPct: 0.2,
          quoteStatus: 'ok',
          quoteReason: null,
        },
      }),
      missedAlphaRecord({
        eventId: 'ma-preentry-MINT0001',
        tokenMint: 'MINT0001',
        rejectReason: 'winner_trailing_t1',
        rejectedAt: rows[0].sell.recordedAt,
        extras: { stalkDurationMs: 120_000 },
        probe: {
          offsetSec: 60,
          firedAt: new Date(1_180_000).toISOString(),
          deltaPct: 9,
          quoteStatus: 'ok',
          quoteReason: null,
        },
      }),
    ];

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell),
      undefined,
      [],
      missedAlpha
    );

    expect(report.postCloseAlphaDiagnostics.matchedClosedTrades).toBe(2);
    expect(report.postCloseAlphaDiagnostics.unmatchedClosedTrades).toBe(0);
    expect(report.postCloseAlphaDiagnostics.okProbeTrades).toBe(2);
    expect(report.postCloseAlphaDiagnostics.postCloseT1Trades).toBe(1);
    expect(report.postCloseAlphaDiagnostics.postCloseT2Trades).toBe(1);
    expect(report.postCloseAlphaDiagnostics.maxPostCloseDeltaPct).toBeCloseTo(4.2, 6);
    expect(report.postCloseAlphaDiagnostics.probeStatusCounts.ok).toBe(3);
    expect(report.postCloseAlphaDiagnostics.probeStatusCounts.scheduled).toBe(1);
    expect(report.postCloseAlphaCandidateTrades[0].positionId).toBe('kolh-live-MINT0001-1000');
    expect(report.postCloseAlphaCandidateTrades[0].maxDeltaOffsetSec).toBe(300);
    expect(report.postCloseAlphaCandidateTrades[0].totalProbes).toBe(2);
    expect(report.postCloseAlphaDiagnostics.byExitReason.find((row) =>
      row.bucket === 'winner_trailing_t1'
    )?.postCloseT2Trades).toBe(1);
  });

  it('prefers exact post-close positionId matching for repeated same-mint closes', () => {
    const first = liveRoundTrip(1, {}, {
      exitReason: 'probe_hard_cut',
      walletDeltaSol: -0.001,
      mfePctPeak: 0,
      peakPrice: 0.001,
    });
    const second = liveRoundTrip(2, {}, {
      positionId: 'kolh-live-MINT0001-2000',
      pairAddress: 'MINT0001',
      exitReason: 'probe_hard_cut',
      walletDeltaSol: 0.002,
      mfePctPeak: 0.3,
      peakPrice: 0.0013,
      recordedAt: new Date(1_121_000).toISOString(),
    });
    const missedAlpha = [
      missedAlphaRecord({
        eventId: 'ma-first-MINT0001',
        tokenMint: 'MINT0001',
        rejectReason: 'probe_hard_cut',
        rejectedAt: first.sell.recordedAt,
        extras: {
          isLive: true,
          elapsedSecAtClose: 120,
          positionId: first.sell.positionId,
        },
        probe: {
          offsetSec: 60,
          firedAt: new Date(1_180_000).toISOString(),
          deltaPct: -0.2,
          quoteStatus: 'ok',
          quoteReason: null,
        },
      }),
      missedAlphaRecord({
        eventId: 'ma-second-MINT0001',
        tokenMint: 'MINT0001',
        rejectReason: 'probe_hard_cut',
        rejectedAt: second.sell.recordedAt,
        extras: {
          isLive: true,
          elapsedSecAtClose: 121,
          positionId: second.sell.positionId,
        },
        probe: {
          offsetSec: 60,
          firedAt: new Date(1_181_000).toISOString(),
          deltaPct: 0.9,
          quoteStatus: 'ok',
          quoteReason: null,
        },
      }),
    ];

    const report = buildKolLiveCanaryReport(
      [first.buy, second.buy],
      [first.sell, second.sell],
      undefined,
      [],
      missedAlpha
    );

    expect(report.postCloseAlphaDiagnostics.matchedClosedTrades).toBe(2);
    expect(report.postCloseAlphaDiagnostics.postCloseT1Trades).toBe(1);
    expect(report.postCloseAlphaCandidateTrades[0].positionId).toBe('kolh-live-MINT0001-2000');
    expect(report.postCloseAlphaCandidateTrades[0].maxDeltaPct).toBeCloseTo(0.9, 6);
  });

  it('does not join paper close missed-alpha rows to live canary trades', () => {
    const rows = [
      liveRoundTrip(1, {}, {
        exitReason: 'probe_hard_cut',
        walletDeltaSol: -0.001,
        mfePctPeak: 0.1,
        peakPrice: 0.0011,
      }),
    ];
    const missedAlpha = [
      missedAlphaRecord({
        eventId: 'ma-paper-MINT0001',
        tokenMint: 'MINT0001',
        rejectCategory: 'kol_close',
        rejectReason: 'probe_hard_cut',
        rejectedAt: rows[0].sell.recordedAt,
        extras: {
          isLive: false,
          elapsedSecAtClose: 120,
          positionId: 'kolh-paper-MINT0001-1000',
        },
        probe: {
          offsetSec: 60,
          firedAt: new Date(1_180_000).toISOString(),
          deltaPct: 4.2,
          quoteStatus: 'ok',
          quoteReason: null,
        },
      }),
    ];

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell),
      undefined,
      [],
      missedAlpha
    );

    expect(report.postCloseAlphaDiagnostics.matchedClosedTrades).toBe(0);
    expect(report.postCloseAlphaDiagnostics.unmatchedClosedTrades).toBe(1);
    expect(report.postCloseAlphaDiagnostics.postCloseT2Trades).toBe(0);
  });

  it('surfaces forced-planned fill metric rows as a separate data-quality bucket', () => {
    const report = buildKolLiveCanaryReport(
      [buy({ partialFillDataMissing: true, partialFillDataReason: 'missing_actual_input' })],
      [sell()]
    );

    expect(report.partialFillDataMissingTrades).toBe(1);
    expect(report.knownPartialFillDataMissingTrades).toBe(1);
    expect(report.legacyPartialFillDataMissingTrades).toBe(0);
    expect(report.byFillDataQualityBucket[0].bucket).toBe('forced_planned_fill_metrics');
    expect(report.byFillDataQualityBucket[0].partialFillDataMissingTrades).toBe(1);
    expect(report.byFillFallbackReasonBucket[0].bucket).toBe('missing_actual_input');
    expect(report.byFillFallbackReasonBucket[0].trades).toBe(1);
    expect(report.forcedPlannedFillTrades[0].partialFillDataReason).toBe('missing_actual_input');
    expect(report.phase4Gate.knownPartialFillDataMissingTrades).toBe(1);
    expect(report.phase4Gate.legacyPartialFillDataMissingTrades).toBe(0);
  });

  it('separates legacy unknown forced-planned rows from reason-tagged rows', () => {
    const report = buildKolLiveCanaryReport(
      [
        buy({ txSignature: 'buy-1', partialFillDataMissing: true }),
        buy({
          positionId: 'kolh-live-MINT0002-1000',
          txSignature: 'buy-2',
          pairAddress: 'MINT0002',
          partialFillDataMissing: true,
          partialFillDataReason: 'output_sanity_low',
          recordedAt: new Date(1_020_000).toISOString(),
        }),
      ],
      [
        sell({ entryTxSignature: 'buy-1' }),
        sell({
          positionId: 'kolh-live-MINT0002-1000',
          txSignature: 'sell-2',
          entryTxSignature: 'buy-2',
          pairAddress: 'MINT0002',
          recordedAt: new Date(1_140_000).toISOString(),
        }),
      ]
    );

    expect(report.partialFillDataMissingTrades).toBe(2);
    expect(report.knownPartialFillDataMissingTrades).toBe(1);
    expect(report.legacyPartialFillDataMissingTrades).toBe(1);
    expect(report.phase4Gate.reasons.some((reason) =>
      reason.includes('known_reason=1, legacy_unknown=1')
    )).toBe(true);
  });

  it('summarizes live execution-quality cooldown paper fallbacks separately', () => {
    const report = buildKolLiveCanaryReport(
      [buy()],
      [sell()],
      undefined,
      [
        paperTrade(),
        paperTrade({
          positionId: 'kolh-paper-MINT0002-1000',
          tokenMint: 'MINT0002',
          netSol: 0.004,
          mfePctPeak: 4.2,
          exitReason: 'winner_trailing_t2',
          t2VisitAtSec: 240,
        }),
        paperTrade({
          positionId: 'kolh-paper-MINT0003-1000',
          tokenMint: 'MINT0003',
          survivalFlags: ['LIVE_MIN_KOL'],
        }),
        paperTrade({
          positionId: 'kolh-paper-shadow-1000',
          tokenMint: 'MINTSHADOW',
          isShadowKol: true,
        }),
      ]
    );

    expect(report.closedTrades).toBe(1);
    expect(report.executionQualityCooldown.closedPaperFallbacks).toBe(2);
    expect(report.executionQualityCooldown.netSol).toBeCloseTo(0.003, 6);
    expect(report.executionQualityCooldown.hardcuts).toBe(1);
    expect(report.executionQualityCooldown.fiveXVisits).toBe(1);
    expect(report.executionQualityCooldown.byExitReason.find((row) => row.bucket === 'winner_trailing_t2')?.trades).toBe(1);
  });

  it('summarizes live fresh-reference reject paper fallbacks separately', () => {
    const report = buildKolLiveCanaryReport(
      [buy()],
      [sell()],
      undefined,
      [
        paperTrade({
          survivalFlags: [
            'LIVE_FRESH_REFERENCE_REJECT',
            'LIVE_FRESH_REFERENCE_DRIFT_PCT=0.31',
          ],
        }),
        paperTrade({
          positionId: 'kolh-paper-MINT0002-1000',
          tokenMint: 'MINT0002',
          netSol: 0.004,
          mfePctPeak: 4.2,
          exitReason: 'winner_trailing_t2',
          t2VisitAtSec: 240,
          survivalFlags: ['LIVE_FRESH_REFERENCE_REJECT'],
        }),
        paperTrade({
          positionId: 'kolh-paper-MINT0003-1000',
          tokenMint: 'MINT0003',
          survivalFlags: ['LIVE_EXEC_QUALITY_COOLDOWN'],
        }),
        paperTrade({
          positionId: 'kolh-paper-shadow-1000',
          tokenMint: 'MINTSHADOW',
          isShadowKol: true,
          survivalFlags: ['LIVE_FRESH_REFERENCE_REJECT'],
        }),
      ]
    );

    expect(report.closedTrades).toBe(1);
    expect(report.freshReferenceReject.closedPaperFallbacks).toBe(2);
    expect(report.freshReferenceReject.netSol).toBeCloseTo(0.003, 6);
    expect(report.freshReferenceReject.hardcuts).toBe(1);
    expect(report.freshReferenceReject.fiveXVisits).toBe(1);
    expect(report.freshReferenceReject.byExitReason.find((row) => row.bucket === 'winner_trailing_t2')?.trades).toBe(1);
    expect(report.executionQualityCooldown.closedPaperFallbacks).toBe(1);
  });

  it('keeps Phase 4 gate in sample collection before 50 closed live trades', () => {
    const rows = Array.from({ length: 49 }, (_, i) =>
      liveRoundTrip(i + 1, {}, {
        walletDeltaSol: -0.001,
        exitReason: 'probe_hard_cut',
        mfePctPeak: 0.1,
        peakPrice: 0.0011,
      })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell)
    );

    expect(report.closedTrades).toBe(49);
    expect(report.phase4Gate.verdict).toBe('CONTINUE_SAMPLE');
    expect(report.phase4Gate.hasActualRunner).toBe(false);
    expect(report.phase4Gate.reasons).toContain('49/50 closed live trades sampled');
    expect(report.phase4Gate.decisionCheckpoints.find((row) => row.closeCount === 50)?.status).toBe('pending');
  });

  it('pauses Phase 4 review after 50 losing live trades without an actual runner', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      liveRoundTrip(i + 1, {}, {
        walletDeltaSol: -0.001,
        exitReason: 'probe_hard_cut',
        mfePctPeak: 0.1,
        peakPrice: 0.0011,
      })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell)
    );

    expect(report.closedTrades).toBe(50);
    expect(report.netSol).toBeCloseTo(-0.05, 6);
    expect(report.actualT2Visits).toBe(0);
    expect(report.actualFiveXVisits).toBe(0);
    expect(report.phase4Gate.verdict).toBe('PAUSE_REVIEW');
    expect(report.phase4Gate.reasons).toContain('no actual live T2/5x runner observed');
    expect(report.phase4Gate.decisionCheckpoints.find((row) => row.closeCount === 50)?.allowedDecision)
      .toContain('no promotion');
  });

  it('holds Phase 4 review at 50 live trades even with runner evidence and positive net', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      liveRoundTrip(i + 1, {}, i === 0
        ? {
            walletDeltaSol: 0.02,
            exitReason: 'winner_trailing_t2',
            mfePctPeak: 4,
            peakPrice: 0.005,
            t2VisitAtSec: 240,
          }
        : {
            walletDeltaSol: 0,
            mfePctPeak: 0.1,
            peakPrice: 0.0011,
          })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell)
    );

    expect(report.closedTrades).toBe(50);
    expect(report.netSol).toBeCloseTo(0.02, 6);
    expect(report.actualT2Visits).toBe(1);
    expect(report.actualFiveXVisits).toBe(1);
    expect(report.phase4Gate.verdict).toBe('HOLD_REVIEW');
    expect(report.phase4Gate.reasons).toContain('promotion review requires 100+ closes; 50 closes is safety-only');
    expect(report.phase4Gate.decisionCheckpoints.find((row) => row.closeCount === 100)?.status).toBe('pending');
  });

  it('marks Phase 5 ready only when 100 live trades include actual runner evidence and positive net', () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      liveRoundTrip(i + 1, {}, i === 0
        ? {
            walletDeltaSol: 0.02,
            exitReason: 'winner_trailing_t2',
            mfePctPeak: 4,
            peakPrice: 0.005,
            t2VisitAtSec: 240,
          }
        : {
            walletDeltaSol: 0,
            mfePctPeak: 0.1,
            peakPrice: 0.0011,
          })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell)
    );

    expect(report.closedTrades).toBe(100);
    expect(report.netSol).toBeCloseTo(0.02, 6);
    expect(report.actualT2Visits).toBe(1);
    expect(report.actualFiveXVisits).toBe(1);
    expect(report.phase4Gate.verdict).toBe('PHASE5_READY');
    expect(report.phase4Gate.dataQualityClear).toBe(true);
    expect(report.phase4Gate.guardCalibrationClear).toBe(true);
    expect(report.phase4Gate.executionQualityCooldownPaperFallbacks).toBe(0);
    expect(report.phase4Gate.executionQualityCooldownT2Visits).toBe(0);
    expect(report.phase4Gate.executionQualityCooldownFiveXVisits).toBe(0);
    expect(report.phase4Gate.decisionCheckpoints.find((row) => row.closeCount === 100)?.status).toBe('reached');
  });

  it('holds Phase 4 review when execution-quality cooldown blocked a runner candidate', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      liveRoundTrip(i + 1, {}, i === 0
        ? {
            walletDeltaSol: 0.02,
            exitReason: 'winner_trailing_t2',
            mfePctPeak: 4,
            peakPrice: 0.005,
            t2VisitAtSec: 240,
          }
        : {
            walletDeltaSol: 0,
            mfePctPeak: 0.1,
            peakPrice: 0.0011,
          })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell),
      undefined,
      [
        paperTrade({
          positionId: 'kolh-paper-COOLDOWN-1000',
          tokenMint: 'COOLDOWN',
          netSol: 0.004,
          mfePctPeak: 4.2,
          exitReason: 'winner_trailing_t2',
          t2VisitAtSec: 240,
          survivalFlags: ['LIVE_EXEC_QUALITY_COOLDOWN'],
        }),
      ]
    );

    expect(report.closedTrades).toBe(50);
    expect(report.actualT2Visits).toBe(1);
    expect(report.phase4Gate.verdict).toBe('HOLD_REVIEW');
    expect(report.phase4Gate.guardCalibrationClear).toBe(false);
    expect(report.phase4Gate.executionQualityCooldownPaperFallbacks).toBe(1);
    expect(report.phase4Gate.executionQualityCooldownT2Visits).toBe(1);
    expect(report.phase4Gate.executionQualityCooldownFiveXVisits).toBe(1);
    expect(report.phase4Gate.reasons.some((reason) =>
      reason.includes('execution quality cooldown guard calibration review required')
    )).toBe(true);
  });

  it('holds Phase 4 review when fresh-reference guard blocked a runner candidate', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      liveRoundTrip(i + 1, {}, i === 0
        ? {
            walletDeltaSol: 0.02,
            exitReason: 'winner_trailing_t2',
            mfePctPeak: 4,
            peakPrice: 0.005,
            t2VisitAtSec: 240,
          }
        : {
            walletDeltaSol: 0,
            mfePctPeak: 0.1,
            peakPrice: 0.0011,
          })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell),
      undefined,
      [
        paperTrade({
          positionId: 'kolh-paper-FRESHREF-1000',
          tokenMint: 'FRESHREF',
          netSol: 0.004,
          mfePctPeak: 4.2,
          exitReason: 'winner_trailing_t2',
          t2VisitAtSec: 240,
          survivalFlags: ['LIVE_FRESH_REFERENCE_REJECT'],
        }),
      ]
    );

    expect(report.closedTrades).toBe(50);
    expect(report.actualT2Visits).toBe(1);
    expect(report.phase4Gate.verdict).toBe('HOLD_REVIEW');
    expect(report.phase4Gate.guardCalibrationClear).toBe(false);
    expect(report.phase4Gate.freshReferenceRejectPaperFallbacks).toBe(1);
    expect(report.phase4Gate.freshReferenceRejectT2Visits).toBe(1);
    expect(report.phase4Gate.freshReferenceRejectFiveXVisits).toBe(1);
    expect(report.phase4Gate.reasons.some((reason) =>
      reason.includes('fresh reference guard calibration review required')
    )).toBe(true);
  });

  it('holds instead of pausing when losing live sample has fresh-reference blocked runner evidence', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      liveRoundTrip(i + 1, {}, {
        walletDeltaSol: -0.001,
        exitReason: 'probe_hard_cut',
        mfePctPeak: 0.1,
        peakPrice: 0.0011,
      })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell),
      undefined,
      [
        paperTrade({
          positionId: 'kolh-paper-FRESHREF-1000',
          tokenMint: 'FRESHREF',
          netSol: 0.004,
          mfePctPeak: 4.2,
          exitReason: 'winner_trailing_t2',
          t2VisitAtSec: 240,
          survivalFlags: ['LIVE_FRESH_REFERENCE_REJECT'],
        }),
      ]
    );

    expect(report.closedTrades).toBe(50);
    expect(report.netSol).toBeCloseTo(-0.05, 6);
    expect(report.actualT2Visits).toBe(0);
    expect(report.phase4Gate.verdict).toBe('HOLD_REVIEW');
    expect(report.phase4Gate.guardCalibrationClear).toBe(false);
    expect(report.phase4Gate.reasons).toContain('no actual live T2/5x runner observed');
  });

  it('holds instead of pausing when losing live sample has execution-quality blocked runner evidence', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      liveRoundTrip(i + 1, {}, {
        walletDeltaSol: -0.001,
        exitReason: 'probe_hard_cut',
        mfePctPeak: 0.1,
        peakPrice: 0.0011,
      })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell),
      undefined,
      [
        paperTrade({
          positionId: 'kolh-paper-COOLDOWN-1000',
          tokenMint: 'COOLDOWN',
          netSol: 0.004,
          mfePctPeak: 4.2,
          exitReason: 'winner_trailing_t2',
          t2VisitAtSec: 240,
          survivalFlags: ['LIVE_EXEC_QUALITY_COOLDOWN'],
        }),
      ]
    );

    expect(report.closedTrades).toBe(50);
    expect(report.netSol).toBeCloseTo(-0.05, 6);
    expect(report.actualT2Visits).toBe(0);
    expect(report.phase4Gate.verdict).toBe('HOLD_REVIEW');
    expect(report.phase4Gate.guardCalibrationClear).toBe(false);
    expect(report.phase4Gate.executionQualityCooldownPaperFallbacks).toBe(1);
    expect(report.phase4Gate.executionQualityCooldownT2Visits).toBe(1);
    expect(report.phase4Gate.executionQualityCooldownFiveXVisits).toBe(1);
    expect(report.phase4Gate.reasons.some((reason) =>
      reason.includes('execution quality cooldown guard calibration review required')
    )).toBe(true);
  });

  it('holds Phase 4 review when measured fill has severe entry advantage anomaly', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      liveRoundTrip(i + 1, i === 0
        ? {
            plannedEntryPrice: 0.001,
            actualEntryPrice: 0.002,
            actualQuantity: 10,
          }
        : {}, i === 0
        ? {
            walletDeltaSol: 0.02,
            exitReason: 'winner_trailing_t2',
            entryPrice: 0.002,
            mfePctPeak: 4,
            peakPrice: 0.01,
            t2VisitAtSec: 240,
          }
        : {
            walletDeltaSol: 0,
            mfePctPeak: 0.1,
            peakPrice: 0.0011,
          })
    );

    const report = buildKolLiveCanaryReport(
      rows.map((row) => row.buy),
      rows.map((row) => row.sell)
    );

    expect(report.closedTrades).toBe(50);
    expect(report.netSol).toBeCloseTo(0.02, 6);
    expect(report.actualT2Visits).toBe(1);
    expect(report.entryAdvantageAnomalyTrades).toBe(1);
    expect(report.entryAdvantageArtifactTrades).toBe(0);
    expect(report.entryAdvantageAdverseTrades).toBe(1);
    expect(report.entryAdvantageFavorableTrades).toBe(0);
    expect(report.entryAdvantageAnomalies[0].positionId).toBe('kolh-live-MINT0001-1000');
    expect(report.phase4Gate.verdict).toBe('HOLD_REVIEW');
    expect(report.phase4Gate.dataQualityClear).toBe(false);
    expect(report.phase4Gate.reasons.some((reason) => reason.includes('entry advantage anomalies=1'))).toBe(true);
  });

  it('quarantines extreme entry advantage as decimal/reference artifact instead of real anomaly', () => {
    const report = buildKolLiveCanaryReport(
      [
        buy({
          plannedEntryPrice: 1e-10,
          actualEntryPrice: 1.1e-7,
          actualQuantity: 100_000,
          actualOutUiAmount: 100_000,
          entryFillOutputRatio: 0.001,
        }),
      ],
      [
        sell({
          entryPrice: 1.1e-7,
          marketReferencePrice: 1e-10,
          peakPrice: 1.2e-7,
          walletDeltaSol: -0.001,
        }),
      ]
    );

    expect(report.entryAdvantageAnomalyTrades).toBe(0);
    expect(report.entryAdvantageArtifactTrades).toBe(1);
    expect(report.entryAdvantageArtifacts[0].positionId).toBe('kolh-live-MINT0001-1000');
    expect(report.byEntryAdvantageBucket[0].bucket).toBe('artifact_abs>=1000%');
    expect(report.phase4Gate.dataQualityClear).toBe(false);
    expect(report.phase4Gate.reasons.some((reason) => reason.includes('entry advantage artifacts=1'))).toBe(true);
  });

  it('projects KOL canary budget from all live ledger rows regardless of the report window', () => {
    const row = liveRoundTrip(1, {}, {
      recordedAt: new Date(1_120_000).toISOString(),
      walletDeltaSol: -0.267166268,
      exitReason: 'probe_hard_cut',
    });
    const report = buildKolLiveCanaryReport(
      [row.buy],
      [row.sell],
      new Date(2_000_000),
      [],
      [],
      {
        canaryBudgetProjection: {
          walletSol: 0.846,
          walletFloorSol: 0.7,
          kolCanaryCapSol: 0.35,
          kolTicketSol: 0.02,
        },
      }
    );

    expect(report.closedTrades).toBe(0);
    expect(report.canaryBudgetProjection?.cumulativeKolPnlSol).toBeCloseTo(-0.267166, 6);
    expect(report.canaryBudgetProjection?.remainingKolBudgetSol).toBeCloseTo(0.082834, 6);
    expect(report.canaryBudgetProjection?.projectedWalletAtBudgetExhaustionSol).toBeCloseTo(0.763166, 6);
    expect(report.canaryBudgetProjection?.projectedFloorBufferSol).toBeCloseTo(0.063166, 6);
    expect(report.canaryBudgetProjection?.approxFullTicketLosers).toBe(4);
    expect(report.canaryBudgetProjection?.capExhausted).toBe(false);
    expect(report.canaryBudgetProjection?.verdict).toBe('RESUME_POSSIBLE');

    const md = formatKolLiveCanaryMarkdown(report);
    expect(md).toContain('## Canary Budget Projection');
    expect(md).toContain('Verdict: RESUME_POSSIBLE');
    expect(md).toContain('KOL canary cap: 0.350000 SOL');
    expect(md).toContain('Remaining KOL budget: 0.082834 SOL');
  });

  it('uses buy fill price for actual MFE when sell entry price is missing', () => {
    const paired = pairKolLiveTrades(
      [buy({ actualEntryPrice: 0.001 })],
      [sell({ entryPrice: undefined, peakPrice: 0.0015, troughPrice: 0.0009 })]
    );

    expect(paired.trades[0].actualMfePctPeak).toBeCloseTo(0.5, 6);
    expect(paired.trades[0].actualMaePct).toBeCloseTo(-0.1, 6);
  });

  it('formats markdown with key operating sections', () => {
    const report = buildKolLiveCanaryReport([buy()], [sell()]);
    const md = formatKolLiveCanaryMarkdown(report);

    expect(md).toContain('# KOL Live Canary Report');
    expect(md).toContain('## Phase 4 Gate');
    expect(md).toContain('Phase 4 gate: CONTINUE_SAMPLE');
    expect(md).toContain('Guard calibration clear: yes');
    expect(md).toContain('Execution-quality cooldown T2/5x: 0/0');
    expect(md).toContain('## Runner Diagnostics');
    expect(md).toContain('### Top Runner Candidate Trades');
    expect(md).toContain('Max actual MFE');
    expect(md).toContain('Runnerless quarantine candidates: 0');
    expect(md).toContain('## Runnerless Cohort Quarantine Candidates');
    expect(md).toContain('## Post-Close Alpha Diagnostics');
    expect(md).toContain('### Top Post-Close Alpha Trades');
    expect(md).toContain('## By Exit Reason');
    expect(md).toContain('## By Buy Lag Bucket');
    expect(md).toContain('## By Buy Execution Bucket');
    expect(md).toContain('## By Reference To Fresh Quote Bucket');
    expect(md).toContain('## By Fill Data Quality');
    expect(md).toContain('## By Fill Fallback Reason');
    expect(md).toContain('## Execution Quality Cooldown Fallbacks');
    expect(md).toContain('Execution-quality cooldown paper fallbacks: 0');
    expect(md).toContain('## Fresh Reference Reject Fallbacks');
    expect(md).toContain('Fresh-reference reject paper fallbacks: 0');
    expect(md).toContain('## By Entry Advantage Bucket');
    expect(md).toContain('Forced planned fill metrics: 0');
    expect(md).toContain('## Measurement Mismatch Trades');
    expect(md).toContain('## Entry Advantage Anomaly Trades');
    expect(md).toContain('## Entry Advantage Artifact Trades');
    expect(md).toContain('winner_trailing_t1');
    expect(md).toContain('Wallet-truth sources: walletDeltaSol=1');
  });
});
