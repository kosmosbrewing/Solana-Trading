/**
 * Canary evaluation script tests (Block 4, 2026-04-18).
 * FIFO pair matching + winner distribution + promotion verdict.
 */
import {
  pairTrades,
  buildReport,
  formatPromotionVerdict,
  type LedgerBuy,
  type LedgerSell,
} from '../scripts/canary-eval';

function buy(strategy: string, tx: string, entry: number, qty: number, timeOffsetSec = 0): LedgerBuy {
  return {
    strategy,
    txSignature: tx,
    actualEntryPrice: entry,
    actualQuantity: qty,
    signalTimeSec: 1_000_000 + timeOffsetSec,
    recordedAt: new Date((1_000_000 + timeOffsetSec) * 1000).toISOString(),
    pairAddress: 'PAIR_' + tx,
    tokenSymbol: 'SYM_' + tx.slice(0, 4),
  };
}

function sell(strategy: string, tx: string, entryTx: string, receivedSol: number, entryPrice: number, exitPrice: number, timeOffsetSec = 10): LedgerSell {
  return {
    strategy,
    txSignature: tx,
    entryTxSignature: entryTx,
    receivedSol,
    entryPrice,
    actualExitPrice: exitPrice,
    recordedAt: new Date((1_000_000 + timeOffsetSec) * 1000).toISOString(),
    pairAddress: 'PAIR_' + entryTx,
    tokenSymbol: 'SYM_' + entryTx.slice(0, 4),
    exitReason: 'WINNER_TRAILING',
    holdSec: timeOffsetSec - 0,
  };
}

describe('canary-eval pairTrades', () => {
  it('matches buy→sell via entryTxSignature', () => {
    const buys = [buy('cupsey_flip_10s', 'tx-a', 1.0, 100)];
    const sells = [sell('cupsey_flip_10s', 'tx-a-exit', 'tx-a', 0.09, 1.0, 0.9)];
    const { byStrategy } = pairTrades(buys, sells, undefined);
    const cupsey = byStrategy.get('cupsey_flip_10s')!;
    expect(cupsey.paired).toHaveLength(1);
    expect(cupsey.paired[0].netSol).toBeCloseTo(0.09 - 100 * 1.0, 6); // received − spent
    expect(cupsey.openBuys).toBe(0);
  });

  it('separates per-strategy (cupsey vs pure_ws)', () => {
    const buys = [
      buy('cupsey_flip_10s', 'c1', 1.0, 10),
      buy('pure_ws_breakout', 'p1', 1.0, 5),
    ];
    const sells = [
      sell('cupsey_flip_10s', 'c1e', 'c1', 11.0, 1.0, 1.1),
      sell('pure_ws_breakout', 'p1e', 'p1', 6.0, 1.0, 1.2),
    ];
    const { byStrategy } = pairTrades(buys, sells, undefined);
    expect(byStrategy.get('cupsey_flip_10s')!.paired).toHaveLength(1);
    expect(byStrategy.get('pure_ws_breakout')!.paired).toHaveLength(1);
    expect(byStrategy.get('cupsey_flip_10s')!.paired[0].netSol).toBeCloseTo(1.0, 5);
    expect(byStrategy.get('pure_ws_breakout')!.paired[0].netSol).toBeCloseTo(1.0, 5);
  });

  it('counts open buys (unmatched) and orphan sells', () => {
    const buys = [buy('cupsey_flip_10s', 'c1', 1.0, 10)];
    const sells = [sell('cupsey_flip_10s', 'c1e', 'c_unknown_entry', 11.0, 1.0, 1.1)];
    const { byStrategy, orphanSells } = pairTrades(buys, sells, undefined);
    expect(byStrategy.get('cupsey_flip_10s')!.openBuys).toBe(1);
    expect(orphanSells).toBe(1);
  });

  it('filters by --since cutoff', () => {
    const buys = [
      buy('cupsey_flip_10s', 'old', 1.0, 10, -100_000),
      buy('cupsey_flip_10s', 'new', 1.0, 10, +100_000),
    ];
    const sells = [
      sell('cupsey_flip_10s', 'old-e', 'old', 11.0, 1.0, 1.1, -99_000),
      sell('cupsey_flip_10s', 'new-e', 'new', 11.0, 1.0, 1.1, +101_000),
    ];
    const cutoff = new Date(1_000_000 * 1000);
    const { byStrategy } = pairTrades(buys, sells, cutoff);
    // only "new" buy + new sell pass cutoff
    expect(byStrategy.get('cupsey_flip_10s')!.paired).toHaveLength(1);
  });
});

describe('canary-eval buildReport', () => {
  it('computes winner distribution and loser streak', () => {
    const buys = [
      buy('pure_ws_breakout', 'w1', 1.0, 10),
      buy('pure_ws_breakout', 'w2', 1.0, 10, 100),
      buy('pure_ws_breakout', 'w3', 1.0, 10, 200),
      buy('pure_ws_breakout', 'l1', 1.0, 10, 300),
      buy('pure_ws_breakout', 'l2', 1.0, 10, 400),
    ];
    const sells = [
      // +150% (2x+)
      sell('pure_ws_breakout', 'w1-e', 'w1', 25.0, 1.0, 2.5, 50),
      // +500% (5x+)
      sell('pure_ws_breakout', 'w2-e', 'w2', 60.0, 1.0, 6.0, 150),
      // +1100% (10x+)
      sell('pure_ws_breakout', 'w3-e', 'w3', 120.0, 1.0, 12.0, 250),
      sell('pure_ws_breakout', 'l1-e', 'l1', 8.0, 1.0, 0.8, 350),
      sell('pure_ws_breakout', 'l2-e', 'l2', 7.5, 1.0, 0.75, 450),
    ];
    const { byStrategy } = pairTrades(buys, sells, undefined);
    const entry = byStrategy.get('pure_ws_breakout')!;
    const report = buildReport('pure_ws_breakout', entry.paired, entry.openBuys, entry.orphanSells);

    expect(report.closedTrades).toBe(5);
    expect(report.winners2x).toBe(3);
    expect(report.winners5x).toBe(2);
    expect(report.winners10x).toBe(1);
    expect(report.losers).toBe(2);
    expect(report.maxConsecutiveLosers).toBe(2);
  });
});

describe('canary-eval promotion verdict', () => {
  function mockReport(strategy: string, overrides: any = {}): any {
    return {
      strategy,
      closedTrades: 50,
      openBuys: 0,
      orphanSells: 0,
      totalNetSol: 0.5,
      medianNetPct: 0,
      meanNetPct: 0,
      winners2x: 0,
      winners5x: 0,
      winners10x: 0,
      losers: 25,
      maxConsecutiveLosers: 3,
      medianHoldSec: 30,
      topWinnersByNetSol: [],
      topLosersByNetSol: [],
      ...overrides,
    };
  }

  it('CONTINUE if candidate < 50 trades', () => {
    const verdict = formatPromotionVerdict(
      mockReport('cupsey_flip_10s'),
      mockReport('pure_ws_breakout', { closedTrades: 20 })
    );
    expect(verdict.verdict).toBe('CONTINUE');
  });

  it('DEMOTE if candidate wallet delta ≤ 0', () => {
    const verdict = formatPromotionVerdict(
      mockReport('cupsey_flip_10s', { totalNetSol: 0.2 }),
      mockReport('pure_ws_breakout', { totalNetSol: -0.1 })
    );
    expect(verdict.verdict).toBe('DEMOTE');
  });

  it('DEMOTE if loser streak explodes', () => {
    const verdict = formatPromotionVerdict(
      mockReport('cupsey_flip_10s'),
      mockReport('pure_ws_breakout', { totalNetSol: 0.1, maxConsecutiveLosers: 12 })
    );
    expect(verdict.verdict).toBe('DEMOTE');
  });

  it('PROMOTE when candidate beats benchmark + has 5x+ winner', () => {
    const verdict = formatPromotionVerdict(
      mockReport('cupsey_flip_10s', { totalNetSol: 0.2 }),
      mockReport('pure_ws_breakout', { totalNetSol: 1.0, winners5x: 2 })
    );
    expect(verdict.verdict).toBe('PROMOTE');
  });

  it('CONTINUE when positive but no 5x winner', () => {
    const verdict = formatPromotionVerdict(
      mockReport('cupsey_flip_10s', { totalNetSol: 0.2 }),
      mockReport('pure_ws_breakout', { totalNetSol: 1.0, winners5x: 0 })
    );
    expect(verdict.verdict).toBe('CONTINUE');
  });
});
