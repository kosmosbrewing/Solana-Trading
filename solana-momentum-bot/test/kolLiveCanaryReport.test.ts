import {
  buildKolLiveCanaryReport,
  formatKolLiveCanaryMarkdown,
  pairKolLiveTrades,
  type KolLiveBuyLedger,
  type KolLiveSellLedger,
} from '../scripts/kol-live-canary-report';

function buy(overrides: Partial<KolLiveBuyLedger> = {}): KolLiveBuyLedger {
  return {
    positionId: 'kolh-live-MINT0001-1000',
    txSignature: 'buy-1',
    strategy: 'kol_hunter',
    wallet: 'main',
    pairAddress: 'MINT0001',
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

describe('kol-live-canary-report', () => {
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
    expect(paired.openBuys).toBe(0);
    expect(paired.orphanSells).toBe(0);
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
    expect(report.hardcuts).toBe(1);
    expect(report.byExitReason.find((row) => row.bucket === 'probe_hard_cut')?.netSol).toBeCloseTo(-0.006, 6);
    expect(report.byIndependentKolCount.find((row) => row.bucket === '3+')?.trades).toBe(1);
    expect(report.bySlippageBucket.find((row) => row.bucket === '>=1000bps')?.hardcuts).toBe(1);
    expect(report.byArm.some((row) => row.bucket === 'smart-v3/smart-v3.0.1')).toBe(true);
    expect(report.walletTruthSources.walletDeltaSol).toBe(3);
  });

  it('formats markdown with key operating sections', () => {
    const report = buildKolLiveCanaryReport([buy()], [sell()]);
    const md = formatKolLiveCanaryMarkdown(report);

    expect(md).toContain('# KOL Live Canary Report');
    expect(md).toContain('## By Exit Reason');
    expect(md).toContain('winner_trailing_t1');
    expect(md).toContain('Wallet-truth sources: walletDeltaSol=1');
  });
});
