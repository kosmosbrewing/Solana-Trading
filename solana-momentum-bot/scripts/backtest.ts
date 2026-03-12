/**
 * 백테스트 러너
 * 실행: npx ts-node scripts/backtest.ts
 *
 * TimescaleDB에 저장된 과거 캔들 데이터로 전략 A/B 백테스트
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
import { Candle, Signal, Order } from '../src/utils/types';

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
  entryTime: Date;
  exitTime: Date;
}

const SLIPPAGE_DEDUCTION = 0.30; // 30% 차감

async function runBacktest() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const pairAddress = process.argv[2];
  if (!pairAddress) {
    console.error('Usage: npx ts-node scripts/backtest.ts <pair_address>');
    process.exit(1);
  }

  console.log(`\n=== Backtest: ${pairAddress} ===\n`);

  // 5분봉 데이터로 Strategy A 백테스트
  const candles5m = await loadCandles(pool, pairAddress, 300);
  if (candles5m.length > 0) {
    const resultA = backtestStrategyA(candles5m);
    printResult('Strategy A: Volume Spike Breakout (5m)', resultA);
  } else {
    console.log('No 5m candles found — skipping Strategy A');
  }

  // 1분봉 데이터로 Strategy B 백테스트
  const candles1m = await loadCandles(pool, pairAddress, 60);
  if (candles1m.length > 0) {
    const resultB = backtestStrategyB(candles1m);
    printResult('Strategy B: Pump Detection (1m)', resultB);
  } else {
    console.log('No 1m candles found — skipping Strategy B');
  }

  await pool.end();
}

async function loadCandles(pool: Pool, pairAddress: string, intervalSec: number): Promise<Candle[]> {
  const result = await pool.query(
    `SELECT * FROM candles
     WHERE pair_address = $1 AND interval_sec = $2
     ORDER BY timestamp ASC`,
    [pairAddress, intervalSec]
  );

  return result.rows.map((row: Record<string, unknown>) => ({
    pairAddress: row.pair_address as string,
    timestamp: new Date(row.timestamp as string),
    intervalSec: Number(row.interval_sec),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    tradeCount: Number(row.trade_count),
  }));
}

function backtestStrategyA(candles: Candle[]): BacktestResult {
  const trades: BacktestTrade[] = [];
  const lookback = 21; // 20 + 현재 봉

  for (let i = lookback; i < candles.length; i++) {
    const window = candles.slice(i - lookback, i + 1);
    const signal = evaluateVolumeSpikeBreakout(window);

    if (signal.action === 'BUY') {
      const order = buildVolumeSpikeOrder(signal, window, 1);
      const trade = simulateTrade(order, candles, i, 30);
      if (trade) {
        trades.push(trade);
        // 포지션 중 다음 시그널 스킵
        const exitIdx = candles.findIndex(
          (c) => c.timestamp >= trade.exitTime
        );
        if (exitIdx > i) i = exitIdx;
      }
    }
  }

  return calculateResult('volume_spike', trades);
}

function backtestStrategyB(candles: Candle[]): BacktestResult {
  const trades: BacktestTrade[] = [];

  for (let i = 5; i < candles.length; i++) {
    const window = candles.slice(Math.max(0, i - 5), i + 1);
    const signal = evaluatePumpDetection(window);

    if (signal.action === 'BUY') {
      const order = buildPumpOrder(signal, window, 1);
      const trade = simulateTrade(order, candles, i, 15);
      if (trade) {
        trades.push(trade);
        const exitIdx = candles.findIndex(
          (c) => c.timestamp >= trade.exitTime
        );
        if (exitIdx > i) i = exitIdx;
      }
    }
  }

  return calculateResult('pump_detect', trades);
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

    // Stop Loss
    if (c.low <= order.stopLoss) {
      return {
        entryPrice,
        exitPrice: order.stopLoss,
        pnl: (order.stopLoss - entryPrice) / entryPrice,
        reason: 'STOP_LOSS',
        entryTime: entryCandle.timestamp,
        exitTime: c.timestamp,
      };
    }

    // Take Profit 1
    if (c.high >= order.takeProfit1) {
      return {
        entryPrice,
        exitPrice: order.takeProfit1,
        pnl: (order.takeProfit1 - entryPrice) / entryPrice,
        reason: 'TAKE_PROFIT_1',
        entryTime: entryCandle.timestamp,
        exitTime: c.timestamp,
      };
    }

    // Time Stop
    if (c.timestamp >= timeStopAt) {
      return {
        entryPrice,
        exitPrice: c.close,
        pnl: (c.close - entryPrice) / entryPrice,
        reason: 'TIME_STOP',
        entryTime: entryCandle.timestamp,
        exitTime: c.timestamp,
      };
    }
  }

  return null; // 데이터 부족
}

function calculateResult(strategy: string, trades: BacktestTrade[]): BacktestResult {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  const totalPnlRaw = trades.reduce((sum, t) => sum + t.pnl, 0);
  const totalPnl = totalPnlRaw * (1 - SLIPPAGE_DEDUCTION); // 30% 차감

  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit * (1 - SLIPPAGE_DEDUCTION)) / grossLoss : 0;

  // Max drawdown
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
