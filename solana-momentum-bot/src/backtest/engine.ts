import { Candle, Signal, Order, StrategyName } from '../utils/types';
import {
  evaluateVolumeSpikeBreakout,
  buildVolumeSpikeOrder,
  evaluatePumpDetection,
  buildPumpOrder,
  evaluateFibPullback,
  buildFibPullbackOrder,
} from '../strategy';
import {
  BacktestConfig,
  BacktestTrade,
  BacktestResult,
  EquityPoint,
  ExitReason,
  DEFAULT_BACKTEST_CONFIG,
} from './types';

// ─── Risk Simulation State ───

interface RiskState {
  balance: number;
  dailyPnl: number;
  consecutiveLosses: number;
  lastLossTime?: Date;
  currentDay: string;          // YYYY-MM-DD
  positionOpen: boolean;
  rejections: {
    dailyLimit: number;
    cooldown: number;
    positionOpen: number;
    zeroSize: number;
  };
}

function resetDailyState(state: RiskState, day: string): void {
  if (state.currentDay !== day) {
    state.dailyPnl = 0;
    state.currentDay = day;
  }
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Backtest Engine ───

export class BacktestEngine {
  private config: BacktestConfig;

  constructor(config: Partial<BacktestConfig> = {}) {
    this.config = { ...DEFAULT_BACKTEST_CONFIG, ...config };
  }

  /**
   * Run backtest on a single strategy
   */
  run(
    candles: Candle[],
    strategy: StrategyName,
    pairAddress: string
  ): BacktestResult {
    const filtered = this.filterByDateRange(candles);
    if (filtered.length === 0) {
      return this.emptyResult(strategy, pairAddress);
    }

    const lookback = strategy === 'fib_pullback' ? 28
      : strategy === 'volume_spike' ? 21 : 6;
    const timeStopMinutes = strategy === 'fib_pullback'
      ? (this.config.fibPullbackParams.timeStopMinutes ?? 60)
      : strategy === 'volume_spike'
        ? (this.config.volumeSpikeParams.timeStopMinutes ?? 30)
        : (this.config.pumpDetectParams.timeStopMinutes ?? 15);

    const riskState: RiskState = {
      balance: this.config.initialBalance,
      dailyPnl: 0,
      consecutiveLosses: 0,
      currentDay: dateKey(filtered[0].timestamp),
      positionOpen: false,
      rejections: { dailyLimit: 0, cooldown: 0, positionOpen: 0, zeroSize: 0 },
    };

    const trades: BacktestTrade[] = [];
    const equityCurve: EquityPoint[] = [
      { timestamp: filtered[0].timestamp, equity: riskState.balance, drawdown: 0 },
    ];

    let tradeId = 0;

    for (let i = lookback; i < filtered.length; i++) {
      const window = filtered.slice(i - lookback, i + 1);
      resetDailyState(riskState, dateKey(filtered[i].timestamp));

      const signal = strategy === 'fib_pullback'
        ? evaluateFibPullback(window, this.config.fibPullbackParams)
        : strategy === 'volume_spike'
          ? evaluateVolumeSpikeBreakout(window, this.config.volumeSpikeParams)
          : evaluatePumpDetection(window, this.config.pumpDetectParams);

      if (signal.action !== 'BUY') continue;

      // Risk checks
      const rejection = this.checkRisk(riskState, signal, filtered[i]);
      if (rejection) {
        riskState.rejections[rejection]++;
        continue;
      }

      // Position sizing
      const order = strategy === 'fib_pullback'
        ? buildFibPullbackOrder(signal, window, 0, this.config.fibPullbackParams)
        : strategy === 'volume_spike'
          ? buildVolumeSpikeOrder(signal, window, 0, this.config.volumeSpikeParams)
          : buildPumpOrder(signal, window, 0, this.config.pumpDetectParams);

      const quantity = this.calculatePositionSize(riskState, order);
      if (quantity <= 0) {
        riskState.rejections.zeroSize++;
        continue;
      }
      order.quantity = quantity;

      // Simulate trade
      const trade = this.simulateTrade(
        order, filtered, i, timeStopMinutes, ++tradeId, strategy, pairAddress
      );
      if (!trade) continue;

      // Apply trade result
      riskState.positionOpen = false;
      riskState.balance += trade.pnlSol;
      riskState.dailyPnl += trade.pnlSol;

      if (trade.pnlSol < 0) {
        riskState.consecutiveLosses++;
        riskState.lastLossTime = trade.exitTime;
      } else {
        riskState.consecutiveLosses = 0;
      }

      trades.push(trade);
      equityCurve.push({
        timestamp: trade.exitTime,
        equity: riskState.balance,
        drawdown: 0, // calculated below
        tradeId: trade.id,
      });

      // Skip past this trade's exit
      if (trade.exitIdx > i) i = trade.exitIdx;
    }

    // Calculate drawdowns on equity curve
    this.calcEquityDrawdowns(equityCurve);

    return this.buildResult(
      strategy, pairAddress, filtered, trades, equityCurve, riskState
    );
  }

  /**
   * Run both strategies on appropriate timeframe candles and combine
   */
  runCombined(
    candles5m: Candle[],
    candles1m: Candle[],
    pairAddress: string
  ): { strategyA: BacktestResult; strategyB: BacktestResult; strategyC: BacktestResult; combined: BacktestResult } {
    const strategyA = this.run(candles5m, 'volume_spike', pairAddress);
    const strategyB = this.run(candles1m, 'pump_detect', pairAddress);
    const strategyC = this.run(candles5m, 'fib_pullback', pairAddress);

    // Merge trades chronologically for combined stats
    const allTrades = [...strategyA.trades, ...strategyB.trades, ...strategyC.trades]
      .sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());

    // Rebuild equity curve from merged trades
    const riskState: RiskState = {
      balance: this.config.initialBalance,
      dailyPnl: 0,
      consecutiveLosses: 0,
      currentDay: '',
      positionOpen: false,
      rejections: {
        dailyLimit: strategyA.rejections.dailyLimit + strategyB.rejections.dailyLimit + strategyC.rejections.dailyLimit,
        cooldown: strategyA.rejections.cooldown + strategyB.rejections.cooldown + strategyC.rejections.cooldown,
        positionOpen: strategyA.rejections.positionOpen + strategyB.rejections.positionOpen + strategyC.rejections.positionOpen,
        zeroSize: strategyA.rejections.zeroSize + strategyB.rejections.zeroSize + strategyC.rejections.zeroSize,
      },
    };

    const equityCurve: EquityPoint[] = [{
      timestamp: allTrades[0]?.entryTime ?? new Date(),
      equity: this.config.initialBalance,
      drawdown: 0,
    }];

    for (const t of allTrades) {
      riskState.balance += t.pnlSol;
      equityCurve.push({
        timestamp: t.exitTime,
        equity: riskState.balance,
        drawdown: 0,
        tradeId: t.id,
      });
    }
    this.calcEquityDrawdowns(equityCurve);

    const allCandles = candles5m.length > candles1m.length ? candles5m : candles1m;
    const combined = this.buildResult(
      'combined' as any, pairAddress, allCandles, allTrades, equityCurve, riskState
    );

    return { strategyA, strategyB, strategyC, combined };
  }

  // ─── Private: Risk Check ───

  private checkRisk(
    state: RiskState,
    signal: Signal,
    currentCandle: Candle
  ): keyof RiskState['rejections'] | null {
    if (state.positionOpen) return 'positionOpen';

    const maxLoss = state.balance * this.config.maxDailyLoss;
    if (state.dailyPnl < -maxLoss) return 'dailyLimit';

    if (state.consecutiveLosses >= this.config.maxConsecutiveLosses && state.lastLossTime) {
      const cooldownEnd = new Date(
        state.lastLossTime.getTime() + this.config.cooldownMinutes * 60 * 1000
      );
      if (currentCandle.timestamp < cooldownEnd) return 'cooldown';
      // Cooldown expired — reset
      state.consecutiveLosses = 0;
    }

    state.positionOpen = true;
    return null;
  }

  // ─── Private: Position Sizing ───

  private calculatePositionSize(state: RiskState, order: Order): number {
    const maxRisk = state.balance * this.config.maxRiskPerTrade;
    const riskPerUnit = Math.abs(order.price - order.stopLoss);
    if (riskPerUnit <= 0) return 0;

    const positionSize = maxRisk / riskPerUnit;
    const maxPositionValue = state.balance * 0.2;
    const maxPositionUnits = maxPositionValue / order.price;

    return Math.min(positionSize, maxPositionUnits);
  }

  // ─── Private: Trade Simulation ───

  private simulateTrade(
    order: Order,
    candles: Candle[],
    entryIdx: number,
    timeStopMinutes: number,
    id: number,
    strategy: StrategyName,
    pairAddress: string
  ): BacktestTrade | null {
    const entryCandle = candles[entryIdx];
    const entryPrice = order.price;
    const timeStopAt = new Date(
      entryCandle.timestamp.getTime() + timeStopMinutes * 60 * 1000
    );

    let peakPrice = entryPrice;
    const trailingStop = order.trailingStop;
    let tp1Hit = false;

    for (let i = entryIdx + 1; i < candles.length; i++) {
      const c = candles[i];

      // Update peak for trailing stop
      if (c.high > peakPrice) peakPrice = c.high;

      // Stop Loss — 같은 봉에서 SL과 TP 동시 도달 가능 시 SL 우선 (보수적)
      if (c.low <= order.stopLoss) {
        return this.makeTrade(
          id, strategy, pairAddress, order, entryIdx, i,
          order.stopLoss, 'STOP_LOSS', entryCandle, c, peakPrice
        );
      }

      // Trailing Stop (only after TP1) — TP2보다 먼저 체크하여 보수적 평가
      if (tp1Hit && trailingStop && trailingStop > 0) {
        const trailingStopPrice = peakPrice - trailingStop;
        if (c.low <= trailingStopPrice) {
          const exitPrice = Math.max(trailingStopPrice, order.stopLoss);
          return this.makeTrade(
            id, strategy, pairAddress, order, entryIdx, i,
            exitPrice, 'TRAILING_STOP', entryCandle, c, peakPrice
          );
        }
      }

      // Take Profit 2
      if (c.high >= order.takeProfit2) {
        return this.makeTrade(
          id, strategy, pairAddress, order, entryIdx, i,
          order.takeProfit2, 'TAKE_PROFIT_2', entryCandle, c, peakPrice
        );
      }

      // Take Profit 1 — 이익실현 후 breakeven 스탑으로 전환
      if (!tp1Hit && c.high >= order.takeProfit1) {
        tp1Hit = true;
        order.stopLoss = entryPrice;
      }

      // Time Stop
      if (c.timestamp >= timeStopAt) {
        return this.makeTrade(
          id, strategy, pairAddress, order, entryIdx, i,
          c.close, 'TIME_STOP', entryCandle, c, peakPrice
        );
      }
    }

    // End of data — close at last candle
    const lastCandle = candles[candles.length - 1];
    return this.makeTrade(
      id, strategy, pairAddress, order, entryIdx, candles.length - 1,
      lastCandle.close, 'TIME_STOP', entryCandle, lastCandle, peakPrice
    );
  }

  private makeTrade(
    id: number,
    strategy: StrategyName,
    pairAddress: string,
    order: Order,
    entryIdx: number,
    exitIdx: number,
    exitPrice: number,
    exitReason: ExitReason,
    entryCandle: Candle,
    exitCandle: Candle,
    peakPrice: number
  ): BacktestTrade {
    const rawPnlPct = (exitPrice - order.price) / order.price;
    const netPnlPct = rawPnlPct * (1 - this.config.slippageDeduction);
    const pnlSol = netPnlPct * order.quantity * order.price;

    return {
      id,
      strategy,
      pairAddress,
      entryPrice: order.price,
      exitPrice,
      quantity: order.quantity,
      pnlSol,
      pnlPct: netPnlPct,
      exitReason,
      entryTime: entryCandle.timestamp,
      exitTime: exitCandle.timestamp,
      entryIdx,
      exitIdx,
      peakPrice,
      drawdownFromPeak: peakPrice > 0 ? (peakPrice - exitPrice) / peakPrice : 0,
    };
  }

  // ─── Private: Equity Curve ───

  private calcEquityDrawdowns(curve: EquityPoint[]): void {
    let peak = curve[0]?.equity ?? 0;
    for (const pt of curve) {
      if (pt.equity > peak) peak = pt.equity;
      pt.drawdown = peak > 0 ? (peak - pt.equity) / peak : 0;
    }
  }

  // ─── Private: Result Builder ───

  private buildResult(
    strategy: StrategyName | 'combined',
    pairAddress: string,
    candles: Candle[],
    trades: BacktestTrade[],
    equityCurve: EquityPoint[],
    riskState: RiskState
  ): BacktestResult {
    const wins = trades.filter(t => t.pnlSol > 0);
    const losses = trades.filter(t => t.pnlSol <= 0);

    const grossPnl = trades.reduce((s, t) => s + t.pnlPct * t.quantity * t.entryPrice, 0);
    const netPnl = trades.reduce((s, t) => s + t.pnlSol, 0);

    const grossProfit = wins.reduce((s, t) => s + t.pnlSol, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : wins.length > 0 ? Infinity : 0;

    const maxDrawdown = Math.max(...equityCurve.map(p => p.drawdown), 0);

    // Sharpe ratio (annualized, using trade returns)
    const returns = trades.map(t => t.pnlPct);
    const sharpeRatio = this.calcSharpe(returns);

    const avgHoldingBars = trades.length > 0
      ? trades.reduce((s, t) => s + (t.exitIdx - t.entryIdx), 0) / trades.length
      : 0;

    return {
      config: this.config,
      pairAddress,
      strategy,
      candleCount: candles.length,
      dateRange: {
        start: candles[0]?.timestamp ?? new Date(),
        end: candles[candles.length - 1]?.timestamp ?? new Date(),
      },
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? wins.length / trades.length : 0,
      grossPnl,
      netPnl,
      netPnlPct: this.config.initialBalance > 0 ? netPnl / this.config.initialBalance : 0,
      profitFactor,
      maxDrawdown: maxDrawdown * this.config.initialBalance,
      maxDrawdownPct: maxDrawdown,
      sharpeRatio,
      avgWinPct: wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0,
      avgLossPct: losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0,
      largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.pnlSol)) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnlSol)) : 0,
      avgHoldingBars,
      rejections: riskState.rejections,
      trades,
      equityCurve,
      finalEquity: riskState.balance,
    };
  }

  private calcSharpe(returns: number[]): number {
    if (returns.length < 2) return 0;
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    // Annualize assuming ~252 trading periods
    return (mean / std) * Math.sqrt(252);
  }

  private filterByDateRange(candles: Candle[]): Candle[] {
    const { startDate, endDate } = this.config;
    if (!startDate && !endDate) return candles;
    return candles.filter(c => {
      if (startDate && c.timestamp < startDate) return false;
      if (endDate && c.timestamp > endDate) return false;
      return true;
    });
  }

  private emptyResult(strategy: StrategyName, pairAddress: string): BacktestResult {
    return {
      config: this.config,
      pairAddress,
      strategy,
      candleCount: 0,
      dateRange: { start: new Date(), end: new Date() },
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      grossPnl: 0,
      netPnl: 0,
      netPnlPct: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      sharpeRatio: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      largestWin: 0,
      largestLoss: 0,
      avgHoldingBars: 0,
      rejections: { dailyLimit: 0, cooldown: 0, positionOpen: 0, zeroSize: 0 },
      trades: [],
      equityCurve: [],
      finalEquity: this.config.initialBalance,
    };
  }
}
