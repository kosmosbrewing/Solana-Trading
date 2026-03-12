/**
 * 백테스트 러너
 * 실행: npx ts-node scripts/backtest.ts <pair_address>
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import {
  evaluateVolumeSpikeBreakout,
  buildVolumeSpikeOrder,
  evaluatePumpDetection,
  buildPumpOrder,
} from '../src/strategy';
import { CandleStore } from '../src/candle/candleStore';
import { Candle, Order } from '../src/utils/types';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface BacktestResult {
  strategy: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number;
  maxDrawdown: number;
  avgWin: number;
  avgLoss: number;
}

interface BacktestTrade {
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  reason: string;
  entryIdx: number;
  exitIdx: number;
}

const SLIPPAGE_DEDUCTION = 0.30;

type EvalFn = (candles: Candle[]) => { action: string };
type BuildFn = (signal: any, candles: Candle[], qty: number) => Order;

async function runBacktest() {
  const pairAddress = process.argv[2];
  if (!pairAddress) {
    console.error('Usage: npx ts-node scripts/backtest.ts <pair_address>');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const candleStore = new CandleStore(pool);

  console.log(`\n=== Backtest: ${pairAddress} ===\n`);

  // Strategy A: 5분봉
  const candles5m = await candleStore.getAllCandles(pairAddress, 300);
  if (candles5m.length > 0) {
    const resultA = runStrategy(
      candles5m, 21,
      (window) => evaluateVolumeSpikeBreakout(window),
      (signal, window, qty) => buildVolumeSpikeOrder(signal, window, qty),
      30
    );
    printResult('Strategy A: Volume Spike Breakout (5m)', resultA);
  } else {
    console.log('No 5m candles found — skipping Strategy A');
  }

  // Strategy B: 1분봉
  const candles1m = await candleStore.getAllCandles(pairAddress, 60);
  if (candles1m.length > 0) {
    const resultB = runStrategy(
      candles1m, 6,
      (window) => evaluatePumpDetection(window),
      (signal, window, qty) => buildPumpOrder(signal, window, qty),
      15
    );
    printResult('Strategy B: Pump Detection (1m)', resultB);
  } else {
    console.log('No 1m candles found — skipping Strategy B');
  }

  await pool.end();
}

function runStrategy(
  candles: Candle[],
  lookback: number,
  evaluate: EvalFn,
  buildOrder: BuildFn,
  timeStopMinutes: number
): BacktestResult {
  const trades: BacktestTrade[] = [];

  for (let i = lookback; i < candles.length; i++) {
    const window = candles.slice(i - lookback, i + 1);
    const signal = evaluate(window);

    if (signal.action === 'BUY') {
      const order = buildOrder(signal, window, 1);
      const trade = simulateTrade(order, candles, i, timeStopMinutes);
      if (trade) {
        trades.push(trade);
        if (trade.exitIdx > i) i = trade.exitIdx;
      }
    }
  }

  return calculateResult(candles[0]?.pairAddress || '', trades);
}

function simulateTrade(
  order: Order,
  candles: Candle[],
  entryIdx: number,
  timeStopMinutes: number
): BacktestTrade | null {
  const entryCandle = candles[entryIdx];
  const entryPrice = order.price;
  const timeStopAt = new Date(entryCandle.timestamp.getTime() + timeStopMinutes * 60 * 1000);

  for (let i = entryIdx + 1; i < candles.length; i++) {
    const c = candles[i];

    if (c.low <= order.stopLoss) {
      return {
        entryPrice,
        exitPrice: order.stopLoss,
        pnl: (order.stopLoss - entryPrice) / entryPrice,
        reason: 'STOP_LOSS',
        entryIdx,
        exitIdx: i,
      };
    }

    if (c.high >= order.takeProfit1) {
      return {
        entryPrice,
        exitPrice: order.takeProfit1,
        pnl: (order.takeProfit1 - entryPrice) / entryPrice,
        reason: 'TAKE_PROFIT_1',
        entryIdx,
        exitIdx: i,
      };
    }

    if (c.timestamp >= timeStopAt) {
      return {
        entryPrice,
        exitPrice: c.close,
        pnl: (c.close - entryPrice) / entryPrice,
        reason: 'TIME_STOP',
        entryIdx,
        exitIdx: i,
      };
    }
  }

  return null;
}

function calculateResult(strategy: string, trades: BacktestTrade[]): BacktestResult {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  const totalPnlRaw = trades.reduce((sum, t) => sum + t.pnl, 0);
  const totalPnl = totalPnlRaw * (1 - SLIPPAGE_DEDUCTION);

  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit * (1 - SLIPPAGE_DEDUCTION)) / grossLoss : 0;

  let maxDD = 0;
  let peak = 0;
  let equity = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    strategy,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    totalPnl,
    profitFactor,
    maxDrawdown: maxDD,
    avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
  };
}

function printResult(title: string, r: BacktestResult) {
  console.log(`\n--- ${title} ---`);
  console.log(`Total Trades:   ${r.totalTrades}`);
  console.log(`Wins / Losses:  ${r.wins} / ${r.losses}`);
  console.log(`Win Rate:       ${(r.winRate * 100).toFixed(1)}%`);
  console.log(`Total PnL:      ${(r.totalPnl * 100).toFixed(2)}% (after 30% slippage deduction)`);
  console.log(`Profit Factor:  ${r.profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown:   ${(r.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`Avg Win:        ${(r.avgWin * 100).toFixed(2)}%`);
  console.log(`Avg Loss:       ${(r.avgLoss * 100).toFixed(2)}%`);
}

runBacktest().catch((error) => {
  console.error('Backtest failed:', error);
  process.exit(1);
});
