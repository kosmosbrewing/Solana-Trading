/**
 * Block 4 QA fix (2026-04-18): canary-eval wallet-truth metrics.
 * wallet log growth / drawdown / recovery trade count 계산 검증.
 */
import {
  pairTrades,
  buildReport,
  type LedgerBuy,
  type LedgerSell,
} from '../scripts/canary-eval';

function buy(tx: string, entry: number, qty: number, timeOffset = 0, strategy = 'pure_ws_breakout'): LedgerBuy {
  return {
    strategy,
    txSignature: tx,
    actualEntryPrice: entry,
    actualQuantity: qty,
    signalTimeSec: 1_000_000 + timeOffset,
    recordedAt: new Date((1_000_000 + timeOffset) * 1000).toISOString(),
    pairAddress: 'PAIR_' + tx,
    tokenSymbol: 'SYM',
  };
}

function sell(tx: string, entryTx: string, receivedSol: number, entryPrice: number, exitPrice: number, timeOffset = 10, strategy = 'pure_ws_breakout'): LedgerSell {
  return {
    strategy,
    txSignature: tx,
    entryTxSignature: entryTx,
    receivedSol,
    entryPrice,
    actualExitPrice: exitPrice,
    recordedAt: new Date((1_000_000 + timeOffset) * 1000).toISOString(),
    pairAddress: 'PAIR_' + entryTx,
    tokenSymbol: 'SYM',
    exitReason: 'WINNER_TRAILING',
    holdSec: timeOffset - 0,
  };
}

describe('canary-eval wallet-truth metrics (Block 4 QA)', () => {
  it('wallet log growth positive for net-positive strategy', () => {
    const buys = [buy('b1', 1.0, 0.01, 0), buy('b2', 1.0, 0.01, 100)];
    const sells = [
      sell('s1', 'b1', 0.02, 1.0, 2.0, 50), // +0.01 SOL
      sell('s2', 'b2', 0.02, 1.0, 2.0, 150), // +0.01 SOL
    ];
    const { byStrategy } = pairTrades(buys, sells, undefined);
    const entry = byStrategy.get('pure_ws_breakout')!;
    const report = buildReport('pure_ws_breakout', entry.paired, 0, 0, 1.0);

    expect(report.totalNetSol).toBeCloseTo(0.02, 5);
    expect(report.walletLogGrowth).toBeGreaterThan(0);
    expect(report.walletLogGrowth).toBeCloseTo(Math.log(1.02 / 1.0), 5);
  });

  it('max drawdown tracked from peak-to-trough + recovery count', () => {
    // 6 trades: +0.05, +0.05, -0.08, -0.04, +0.06, +0.10
    // cum: 0.05, 0.10 (peak), 0.02, -0.02 (trough), 0.04, 0.14 (recover)
    // maxDD = 0.10 - (-0.02) = 0.12. recovery at index 5 (2 trades after trough).
    const buys = [
      buy('b1', 1.0, 0.1, 0), buy('b2', 1.0, 0.1, 100), buy('b3', 1.0, 0.1, 200),
      buy('b4', 1.0, 0.1, 300), buy('b5', 1.0, 0.1, 400), buy('b6', 1.0, 0.1, 500),
    ];
    const sells = [
      sell('s1', 'b1', 0.15, 1.0, 1.5, 50),
      sell('s2', 'b2', 0.15, 1.0, 1.5, 150),
      sell('s3', 'b3', 0.02, 1.0, 0.2, 250),
      sell('s4', 'b4', 0.06, 1.0, 0.6, 350),
      sell('s5', 'b5', 0.16, 1.0, 1.6, 450),
      sell('s6', 'b6', 0.20, 1.0, 2.0, 550),
    ];
    const { byStrategy } = pairTrades(buys, sells, undefined);
    const entry = byStrategy.get('pure_ws_breakout')!;
    const report = buildReport('pure_ws_breakout', entry.paired, 0, 0, 1.0);

    expect(report.equityCurveSol.length).toBe(6);
    expect(report.maxDrawdownSol).toBeGreaterThan(0.11); // peak-trough ≥ 0.12
    expect(report.maxDrawdownSol).toBeLessThan(0.13);
    expect(report.recoveryTradeCount).toBe(2);
  });

  it('recovery count null when peak never recovered', () => {
    // peak at trade 1, then falls and never reaches back
    const buys = [buy('b1', 1.0, 0.1, 0), buy('b2', 1.0, 0.1, 100), buy('b3', 1.0, 0.1, 200)];
    const sells = [
      sell('s1', 'b1', 0.20, 1.0, 2.0, 50),  // peak +0.10
      sell('s2', 'b2', 0.05, 1.0, 0.5, 150), // trough 0.05
      sell('s3', 'b3', 0.08, 1.0, 0.8, 250), // still below peak
    ];
    const { byStrategy } = pairTrades(buys, sells, undefined);
    const entry = byStrategy.get('pure_ws_breakout')!;
    const report = buildReport('pure_ws_breakout', entry.paired, 0, 0, 1.0);

    expect(report.recoveryTradeCount).toBeNull();
    expect(report.maxDrawdownSol).toBeGreaterThan(0);
  });

  it('equity curve is chronologically ordered (entryTimeSec asc)', () => {
    const buys = [
      buy('b1', 1.0, 0.01, 100), // later
      buy('b2', 1.0, 0.01, 0),   // earlier
    ];
    const sells = [
      sell('s1', 'b1', 0.02, 1.0, 2.0, 150),
      sell('s2', 'b2', 0.005, 1.0, 0.5, 50),
    ];
    const { byStrategy } = pairTrades(buys, sells, undefined);
    const entry = byStrategy.get('pure_ws_breakout')!;
    const report = buildReport('pure_ws_breakout', entry.paired, 0, 0, 1.0);

    // 시간순: b2 (-0.005) 먼저, 그 다음 b1 (+0.01)
    expect(report.equityCurveSol[0]).toBeCloseTo(-0.005, 6);
    expect(report.equityCurveSol[1]).toBeCloseTo(0.005, 6);
  });

  it('zero trades: wallet log growth = 0, maxDD = 0, no crash', () => {
    const report = buildReport('pure_ws_breakout', [], 0, 0, 1.0);
    expect(report.walletLogGrowth).toBe(0);
    expect(report.maxDrawdownSol).toBe(0);
    expect(report.maxDrawdownPct).toBe(0);
    expect(report.recoveryTradeCount).toBeNull();
    expect(report.equityCurveSol).toEqual([]);
  });
});
