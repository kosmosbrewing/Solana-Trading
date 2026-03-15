import { BreakoutGrade, Candle, Order, PoolInfo, Signal, StrategyName } from '../utils/types';
import { evaluateGates } from '../gate';
import { checkTokenSafety } from '../gate/safetyGate';
import { getGradeSizeMultiplier } from '../gate/sizingGate';
import { createDrawdownGuardState, updateDrawdownGuardState } from '../risk/drawdownGuard';
import {
  evaluateVolumeSpikeBreakout,
  buildVolumeSpikeOrder,
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
  drawdownGuard: ReturnType<typeof createDrawdownGuardState>;
  rejections: {
    dailyLimit: number;
    drawdownHalt: number;
    cooldown: number;
    positionOpen: number;
    zeroSize: number;
    gradeFiltered: number;
    safetyFiltered: number;
  };
  gradeDistribution: Record<BreakoutGrade, number>;
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

    const lookback = strategy === 'fib_pullback' ? 28 : 21;
    const timeStopMinutes = strategy === 'fib_pullback'
      ? (this.config.fibPullbackParams.timeStopMinutes ?? 60)
      : (this.config.volumeSpikeParams.timeStopMinutes ?? 30);

    const riskState: RiskState = {
      balance: this.config.initialBalance,
      dailyPnl: 0,
      consecutiveLosses: 0,
      currentDay: dateKey(filtered[0].timestamp),
      positionOpen: false,
      drawdownGuard: createDrawdownGuardState(this.config.initialBalance),
      rejections: { dailyLimit: 0, drawdownHalt: 0, cooldown: 0, positionOpen: 0, zeroSize: 0, gradeFiltered: 0, safetyFiltered: 0 },
      gradeDistribution: { A: 0, B: 0, C: 0 },
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
        : evaluateVolumeSpikeBreakout(window, this.config.volumeSpikeParams);

      if (signal.action !== 'BUY') continue;

      let safetyMultiplier = 1.0;
      const gateResult = this.evaluateSignalGates(signal, window, pairAddress);
      signal.breakoutScore = gateResult.breakoutScore;
      riskState.gradeDistribution[gateResult.breakoutScore.grade]++;

      if (gateResult.rejected) {
        riskState.rejections.gradeFiltered++;
        continue;
      }

      if (gateResult.tokenSafety) {
        const safetyResult = checkTokenSafety(gateResult.tokenSafety, {
          minPoolLiquidity: this.config.minPoolLiquidity,
          minTokenAgeHours: this.config.minTokenAgeHours,
          maxHolderConcentration: this.config.maxHolderConcentration,
        });
        if (!safetyResult.approved) {
          riskState.rejections.safetyFiltered++;
          continue;
        }
        safetyMultiplier = safetyResult.sizeMultiplier;
      }

      // Risk checks
      const rejection = this.checkRisk(riskState, signal, filtered[i]);
      if (rejection) {
        riskState.rejections[rejection]++;
        continue;
      }

      // Position sizing
      const order = strategy === 'fib_pullback'
        ? buildFibPullbackOrder(signal, window, 0, this.config.fibPullbackParams)
        : buildVolumeSpikeOrder(signal, window, 0, this.config.volumeSpikeParams);
      if (signal.breakoutScore) {
        order.breakoutScore = signal.breakoutScore.totalScore;
        order.breakoutGrade = signal.breakoutScore.grade;
      }

      const quantity = this.calculatePositionSize(riskState, order, safetyMultiplier);
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
      riskState.drawdownGuard = updateDrawdownGuardState(
        riskState.drawdownGuard,
        riskState.balance,
        {
          maxDrawdownPct: this.config.maxDrawdownPct,
          recoveryPct: this.config.recoveryPct,
        }
      );

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
   * Run active 5m strategies and combine
   */
  runCombined(
    candles5m: Candle[],
    pairAddress: string
  ): { strategyA: BacktestResult; strategyC: BacktestResult; combined: BacktestResult } {
    const strategyA = this.run(candles5m, 'volume_spike', pairAddress);
    const strategyC = this.run(candles5m, 'fib_pullback', pairAddress);

    // Merge trades chronologically for combined stats
    const allTrades = [...strategyA.trades, ...strategyC.trades]
      .sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());

    // Rebuild equity curve from merged trades
    const riskState: RiskState = {
      balance: this.config.initialBalance,
      dailyPnl: 0,
      consecutiveLosses: 0,
      currentDay: '',
      positionOpen: false,
      drawdownGuard: createDrawdownGuardState(this.config.initialBalance),
      rejections: {
        dailyLimit: strategyA.rejections.dailyLimit + strategyC.rejections.dailyLimit,
        drawdownHalt: strategyA.rejections.drawdownHalt + strategyC.rejections.drawdownHalt,
        cooldown: strategyA.rejections.cooldown + strategyC.rejections.cooldown,
        positionOpen: strategyA.rejections.positionOpen + strategyC.rejections.positionOpen,
        zeroSize: strategyA.rejections.zeroSize + strategyC.rejections.zeroSize,
        gradeFiltered: strategyA.rejections.gradeFiltered + strategyC.rejections.gradeFiltered,
        safetyFiltered: strategyA.rejections.safetyFiltered + strategyC.rejections.safetyFiltered,
      },
      gradeDistribution: {
        A: strategyA.gradeDistribution.A + strategyC.gradeDistribution.A,
        B: strategyA.gradeDistribution.B + strategyC.gradeDistribution.B,
        C: strategyA.gradeDistribution.C + strategyC.gradeDistribution.C,
      },
    };

    const equityCurve: EquityPoint[] = [{
      timestamp: allTrades[0]?.entryTime ?? new Date(),
      equity: this.config.initialBalance,
      drawdown: 0,
    }];

    for (const t of allTrades) {
      riskState.balance += t.pnlSol;
      riskState.drawdownGuard = updateDrawdownGuardState(
        riskState.drawdownGuard,
        riskState.balance,
        {
          maxDrawdownPct: this.config.maxDrawdownPct,
          recoveryPct: this.config.recoveryPct,
        }
      );
      equityCurve.push({
        timestamp: t.exitTime,
        equity: riskState.balance,
        drawdown: 0,
        tradeId: t.id,
      });
    }
    this.calcEquityDrawdowns(equityCurve);

    const combined = this.buildResult(
      'combined', pairAddress, candles5m, allTrades, equityCurve, riskState
    );

    return { strategyA, strategyC, combined };
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

    if (state.drawdownGuard.halted) return 'drawdownHalt';

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

  private calculatePositionSize(state: RiskState, order: Order, safetyMultiplier: number): number {
    const maxRisk = state.balance * this.config.maxRiskPerTrade;
    const riskPerUnit = Math.abs(order.price - order.stopLoss);
    if (riskPerUnit <= 0) return 0;

    const positionSize = maxRisk / riskPerUnit;
    const maxPositionValue = state.balance * 0.2;
    const maxPositionUnits = maxPositionValue / order.price;

    const baseQuantity = Math.min(positionSize, maxPositionUnits);
    return baseQuantity * getGradeSizeMultiplier(order.breakoutGrade) * safetyMultiplier;
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
    let remainingQuantity = order.quantity;
    let realizedPnlSol = 0;
    let realizedExitValue = 0;

    for (let i = entryIdx + 1; i < candles.length; i++) {
      const c = candles[i];

      // Update peak for trailing stop
      if (c.high > peakPrice) peakPrice = c.high;

      // Stop Loss — 같은 봉에서 SL과 TP 동시 도달 가능 시 SL 우선 (보수적)
      if (c.low <= order.stopLoss) {
        return this.makeTrade(
          id, strategy, pairAddress, order, entryIdx, i,
          order.stopLoss, 'STOP_LOSS', entryCandle, c, peakPrice, realizedPnlSol, realizedExitValue, remainingQuantity
        );
      }

      // Trailing Stop (only after TP1) — TP2보다 먼저 체크하여 보수적 평가
      if (tp1Hit && trailingStop && trailingStop > 0) {
        const trailingStopPrice = peakPrice - trailingStop;
        if (c.low <= trailingStopPrice) {
          const exitPrice = Math.max(trailingStopPrice, order.stopLoss);
          return this.makeTrade(
            id, strategy, pairAddress, order, entryIdx, i,
            exitPrice, 'TRAILING_STOP', entryCandle, c, peakPrice, realizedPnlSol, realizedExitValue, remainingQuantity
          );
        }
      }

      // Take Profit 2
      if (c.high >= order.takeProfit2) {
        return this.makeTrade(
          id, strategy, pairAddress, order, entryIdx, i,
          order.takeProfit2, 'TAKE_PROFIT_2', entryCandle, c, peakPrice, realizedPnlSol, realizedExitValue, remainingQuantity
        );
      }

      // Take Profit 1 — 절반 익절 후 나머지는 breakeven 스탑으로 전환
      if (!tp1Hit && c.high >= order.takeProfit1) {
        tp1Hit = true;
        const partialQuantity = remainingQuantity * 0.5;
        realizedPnlSol += this.calcNetPnlSol(entryPrice, order.takeProfit1, partialQuantity);
        realizedExitValue += order.takeProfit1 * partialQuantity;
        remainingQuantity -= partialQuantity;
        order.stopLoss = entryPrice;
      }

      // Time Stop
      if (c.timestamp >= timeStopAt) {
        return this.makeTrade(
          id, strategy, pairAddress, order, entryIdx, i,
          c.close, 'TIME_STOP', entryCandle, c, peakPrice, realizedPnlSol, realizedExitValue, remainingQuantity
        );
      }
    }

    // End of data — close at last candle
    const lastCandle = candles[candles.length - 1];
    return this.makeTrade(
      id, strategy, pairAddress, order, entryIdx, candles.length - 1,
      lastCandle.close, 'TIME_STOP', entryCandle, lastCandle, peakPrice, realizedPnlSol, realizedExitValue, remainingQuantity
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
    peakPrice: number,
    realizedPnlSol: number,
    realizedExitValue: number,
    remainingQuantity: number
  ): BacktestTrade {
    const exitQuantity = Math.max(remainingQuantity, 0);
    const totalPnlSol = realizedPnlSol + this.calcNetPnlSol(order.price, exitPrice, exitQuantity);
    const totalExitValue = realizedExitValue + exitPrice * exitQuantity;
    const avgExitPrice = order.quantity > 0 ? totalExitValue / order.quantity : exitPrice;
    const pnlPct = order.quantity > 0 && order.price > 0
      ? totalPnlSol / (order.quantity * order.price)
      : 0;

    return {
      id,
      strategy,
      pairAddress,
      breakoutScore: order.breakoutScore,
      breakoutGrade: order.breakoutGrade,
      entryPrice: order.price,
      exitPrice: avgExitPrice,
      quantity: order.quantity,
      pnlSol: totalPnlSol,
      pnlPct,
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
      gradeDistribution: riskState.gradeDistribution,
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
      rejections: { dailyLimit: 0, drawdownHalt: 0, cooldown: 0, positionOpen: 0, zeroSize: 0, gradeFiltered: 0, safetyFiltered: 0 },
      gradeDistribution: { A: 0, B: 0, C: 0 },
      trades: [],
      equityCurve: [],
      finalEquity: this.config.initialBalance,
    };
  }

  private evaluateSignalGates(signal: Signal, candles: Candle[], pairAddress: string) {
    const poolInfo = this.buildGatePoolInfo(pairAddress);
    return evaluateGates({
      signal,
      candles,
      poolInfo,
      previousTvl: poolInfo.tvl,
      fibConfig: {
        impulseMinPct: this.config.fibPullbackParams.impulseMinPct ?? 0.15,
        volumeClimaxMultiplier: this.config.fibPullbackParams.volumeClimaxMultiplier ?? 2.5,
        minWickRatio: this.config.fibPullbackParams.minWickRatio ?? 0.4,
      },
      thresholds: {
        minBuyRatio: this.config.minBuyRatio,
        minBreakoutScore: this.config.minBreakoutScore,
      },
    });
  }

  private buildGatePoolInfo(pairAddress: string): PoolInfo {
    const gatePoolInfo = this.config.gatePoolInfo ?? {};
    return {
      pairAddress,
      tokenMint: gatePoolInfo.tokenMint ?? pairAddress,
      tvl: gatePoolInfo.tvl ?? this.config.minPoolLiquidity,
      dailyVolume: gatePoolInfo.dailyVolume ?? 0,
      tradeCount24h: gatePoolInfo.tradeCount24h ?? 0,
      spreadPct: gatePoolInfo.spreadPct ?? 0,
      tokenAgeHours: gatePoolInfo.tokenAgeHours ?? this.config.minTokenAgeHours,
      top10HolderPct: gatePoolInfo.top10HolderPct ?? this.config.maxHolderConcentration,
      lpBurned: gatePoolInfo.lpBurned ?? false,
      ownershipRenounced: gatePoolInfo.ownershipRenounced ?? false,
      rankScore: gatePoolInfo.rankScore ?? 0,
    };
  }

  private calcNetPnlSol(entryPrice: number, exitPrice: number, quantity: number): number {
    if (quantity <= 0 || entryPrice <= 0) return 0;
    const rawPnlPct = (exitPrice - entryPrice) / entryPrice;
    const netPnlPct = rawPnlPct * (1 - this.config.slippageDeduction);
    return netPnlPct * quantity * entryPrice;
  }
}
