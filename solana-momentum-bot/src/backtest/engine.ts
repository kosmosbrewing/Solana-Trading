import { AttentionScore } from '../event/types';
import { BreakoutGrade, Candle, Order, PoolInfo, Signal, StrategyName } from '../utils/types';
import { evaluateGates, evaluateExecutionViabilityForOrder } from '../gate';
import { checkTokenSafety } from '../gate/safetyGate';
import { getGradeSizeMultiplier } from '../gate/sizingGate';
import { createDrawdownGuardState, updateDrawdownGuardState } from '../risk/drawdownGuard';
import { resolveRiskTierProfile, RiskTierProfile } from '../risk';
import { EdgeTracker } from '../reporting';
import {
  evaluateVolumeSpikeBreakout,
  buildVolumeSpikeOrder,
  evaluateFibPullback,
  buildFibPullbackOrder,
  evaluateMomentumCascadeEntry,
  buildMomentumCascadeOrder,
  detectRecompression,
  detectReacceleration,
  calculateAddOnQuantity,
  calculateCombinedStopLoss,
  initCascadeState,
  addCascadeLeg,
  updateCascadeState,
  calcATR,
  calcAdaptiveTrailingStop,
  checkExhaustion,
} from '../strategy';
import type { CascadeState, CascadeLeg } from '../strategy';
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
  edgeTracker: EdgeTracker;
  riskTier: RiskTierProfile;
      rejections: {
        dailyLimit: number;
        drawdownHalt: number;
        cooldown: number;
        positionOpen: number;
        zeroSize: number;
        executionViability: number;
        gradeFiltered: number;
        safetyFiltered: number;
      };
  gradeDistribution: Record<BreakoutGrade, number>;
}

interface CandidateTrade {
  signal: Signal;
  candles: Candle[];
  timeStopMinutes: number;
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

    // buy/sell volume 데이터 없으면 buyRatio 게이트 자동 비활성화
    if (this.config.minBuyRatio > 0 && !this.hasBuySellVolumeData(filtered)) {
      this.config = { ...this.config, minBuyRatio: 0 };
    }

    const lookback = strategy === 'fib_pullback' ? 28 : 21;
    const timeStopMinutes = strategy === 'fib_pullback'
      ? (this.config.fibPullbackParams.timeStopMinutes ?? 60)
      : strategy === 'momentum_cascade'
        ? 120
        : (this.config.volumeSpikeParams.timeStopMinutes ?? 30);

    const riskState = this.createInitialRiskState(filtered[0].timestamp);

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
        : strategy === 'momentum_cascade'
          ? evaluateMomentumCascadeEntry(window, this.config.momentumCascadeParams)
          : evaluateVolumeSpikeBreakout(window, this.config.volumeSpikeParams);

      if (signal.action !== 'BUY') continue;

      let safetyMultiplier = 1.0;
      const gateResult = this.evaluateSignalGates(signal, window, pairAddress);
      signal.breakoutScore = gateResult.breakoutScore;
      riskState.gradeDistribution[gateResult.breakoutScore.grade]++;

      if (gateResult.rejected) {
        if (gateResult.filterReason?.startsWith('poor_execution_viability')) {
          riskState.rejections.executionViability++;
        } else {
          riskState.rejections.gradeFiltered++;
        }
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
        : strategy === 'momentum_cascade'
          ? buildMomentumCascadeOrder(signal, window, 0, this.config.momentumCascadeParams)
          : buildVolumeSpikeOrder(signal, window, 0, this.config.volumeSpikeParams);
      if (signal.breakoutScore) {
        order.breakoutScore = signal.breakoutScore.totalScore;
        order.breakoutGrade = signal.breakoutScore.grade;
      }

      const quantity = this.calculatePositionSize(
        riskState,
        order,
        safetyMultiplier * gateResult.gradeSizeMultiplier
      );
      if (quantity <= 0) {
        riskState.positionOpen = false;
        riskState.rejections.zeroSize++;
        continue;
      }
      order.quantity = quantity;
      const gatePoolInfo = this.buildGatePoolInfo(pairAddress);
      const actualExecution = evaluateExecutionViabilityForOrder(order, gatePoolInfo.tvl, {
        ammFeePct: gatePoolInfo.ammFeePct,
        mevMarginPct: gatePoolInfo.mevMarginPct,
      });
      if (actualExecution.rejected) {
        riskState.positionOpen = false;
        riskState.rejections.executionViability++;
        continue;
      }
      if (actualExecution.sizeMultiplier < 1) {
        order.quantity *= actualExecution.sizeMultiplier;
      }

      // Simulate trade — cascade는 add-on 포함 시뮬레이션
      const trade = strategy === 'momentum_cascade'
        ? this.simulateCascadeTrade(order, filtered, i, timeStopMinutes, ++tradeId, pairAddress, riskState.balance)
        : this.simulateTrade(order, filtered, i, timeStopMinutes, ++tradeId, strategy, pairAddress);
      if (!trade) {
        riskState.positionOpen = false;
        continue;
      }

      this.applyCompletedTrade(riskState, trade, 'strategy');

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
    const filtered = this.filterByDateRange(candles5m);
    if (filtered.length === 0) {
      return {
        strategyA,
        strategyC,
        combined: this.emptyResult('combined', pairAddress),
      };
    }

    const riskState = this.createInitialRiskState(filtered[0].timestamp);
    const trades: BacktestTrade[] = [];
    const equityCurve: EquityPoint[] = [{
      timestamp: filtered[0].timestamp,
      equity: this.config.initialBalance,
      drawdown: 0,
    }];
    let tradeId = 0;

    for (let i = 21; i < filtered.length; i++) {
      resetDailyState(riskState, dateKey(filtered[i].timestamp));
      const candidates = this.buildCombinedCandidates(filtered, i);
      if (candidates.length === 0) continue;

      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        const candidate = candidates[candidateIndex];
        const trade = this.attemptCandidateTrade(
          riskState,
          candidate,
          filtered,
          i,
          pairAddress,
          ++tradeId,
          'portfolio'
        );
        if (!trade) {
          tradeId--;
          continue;
        }

        trades.push(trade);
        equityCurve.push({
          timestamp: trade.exitTime,
          equity: riskState.balance,
          drawdown: 0,
          tradeId: trade.id,
        });
        if (candidateIndex < candidates.length - 1) {
          riskState.rejections.positionOpen += candidates.length - candidateIndex - 1;
        }
        if (trade.exitIdx > i) i = trade.exitIdx;
        break;
      }
    }
    this.calcEquityDrawdowns(equityCurve);

    const combined = this.buildResult(
      'combined', pairAddress, filtered, trades, equityCurve, riskState
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

    const maxLoss = state.balance * state.riskTier.maxDailyLoss;
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
    const maxRisk = state.balance * state.riskTier.maxRiskPerTrade;
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
      const monitorCandles = candles.slice(Math.max(0, i - 9), i + 1);
      const currentPrice = c.close;

      // Update peak for trailing stop
      if (c.high > peakPrice) peakPrice = c.high;

      // Time Stop — live loop와 동일하게 최우선 체크
      if (c.timestamp >= timeStopAt) {
        return this.makeTrade(
          id, strategy, pairAddress, order, entryIdx, i,
          currentPrice, 'TIME_STOP', entryCandle, c, peakPrice, realizedPnlSol, realizedExitValue, remainingQuantity
        );
      }

      // Stop Loss — 같은 봉에서 SL과 TP 동시 도달 가능 시 SL 우선 (보수적)
      if (c.low <= order.stopLoss) {
        return this.makeTrade(
          id, strategy, pairAddress, order, entryIdx, i,
          order.stopLoss, 'STOP_LOSS', entryCandle, c, peakPrice, realizedPnlSol, realizedExitValue, remainingQuantity
        );
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

      // Exhaustion Exit — 최소 2봉 보유 후 수익 구간에서만 청산
      // Why: 진입 봉(volume spike)→직후 1봉은 자연스럽게 volume/body 감소. 1봉 exhaustion 오탐만 스킵
      const barsHeld = i - entryIdx;
      if (barsHeld >= 2 && monitorCandles.length >= 2) {
        const { exhausted } = checkExhaustion(monitorCandles, 2);
        if (exhausted && currentPrice > entryPrice) {
          return this.makeTrade(
            id, strategy, pairAddress, order, entryIdx, i,
            currentPrice, 'EXHAUSTION', entryCandle, c, peakPrice, realizedPnlSol, realizedExitValue, remainingQuantity
          );
        }
      }

      // Adaptive trailing — 최소 2봉 보유 후 활성화
      // Why: 진입 직후 adaptiveStop=entryPrice(본전 스탑)이 되어 1봉 만에 exit하는 오탐 방지
      if (barsHeld >= 2 && trailingStop && monitorCandles.length >= 8) {
        const atr = calcATR(monitorCandles, 7);
        const adaptiveStop = calcAdaptiveTrailingStop(monitorCandles, atr, entryPrice, peakPrice);
        if (currentPrice <= adaptiveStop && currentPrice > order.stopLoss) {
          return this.makeTrade(
            id, strategy, pairAddress, order, entryIdx, i,
            currentPrice, 'TRAILING_STOP', entryCandle, c, peakPrice, realizedPnlSol, realizedExitValue, remainingQuantity
          );
        }
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
      stopLoss: order.stopLoss,
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

  // ─── Private: Cascade Trade Simulation (H-06) ───

  /**
   * Momentum Cascade trade simulation:
   * 1. 기존 simulateTrade와 동일한 exit 로직
   * 2. TP1 후 재압축 → 재가속 감지 → add-on 진입
   * 3. Add-on 시 combined SL 재산정, 총 리스크 1R 유지
   */
  private simulateCascadeTrade(
    order: Order,
    candles: Candle[],
    entryIdx: number,
    timeStopMinutes: number,
    id: number,
    pairAddress: string,
    currentBalance: number
  ): BacktestTrade | null {
    const entryCandle = candles[entryIdx];
    const entryPrice = order.price;
    const timeStopAt = new Date(
      entryCandle.timestamp.getTime() + timeStopMinutes * 60 * 1000
    );
    const cascadeParams = this.config.momentumCascadeParams ?? {};

    // 캐스케이드 상태 초기화
    const firstLeg: CascadeLeg = {
      entryPrice,
      quantity: order.quantity,
      stopLoss: order.stopLoss,
      entryIdx,
      entryTime: entryCandle.timestamp,
    };
    let cascadeState = initCascadeState(firstLeg, order.takeProfit2);
    let recompressionDetected = false;

    let peakPrice = entryPrice;
    const trailingStop = order.trailingStop;
    let remainingQuantity = order.quantity;
    let realizedPnlSol = 0;
    let realizedExitValue = 0;
    let activeSL = order.stopLoss;

    for (let i = entryIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      const monitorCandles = candles.slice(Math.max(0, i - 9), i + 1);
      const currentPrice = c.close;
      const tp1WasHit = cascadeState.tp1Hit;

      if (c.high > peakPrice) peakPrice = c.high;

      // 캐스케이드 상태 업데이트 (TP1 감지 + peak 갱신)
      cascadeState = updateCascadeState(cascadeState, c.high, order.takeProfit1);

      // Time Stop
      if (c.timestamp >= timeStopAt) {
        return this.makeTrade(
          id, 'momentum_cascade', pairAddress, order, entryIdx, i,
          currentPrice, 'TIME_STOP', entryCandle, c, peakPrice,
          realizedPnlSol, realizedExitValue, remainingQuantity
        );
      }

      // Stop Loss (combined SL)
      if (c.low <= activeSL) {
        return this.makeTrade(
          id, 'momentum_cascade', pairAddress, order, entryIdx, i,
          activeSL, 'STOP_LOSS', entryCandle, c, peakPrice,
          realizedPnlSol, realizedExitValue, remainingQuantity
        );
      }

      // Take Profit 2 (전체 포지션)
      if (c.high >= cascadeState.takeProfit2) {
        return this.makeTrade(
          id, 'momentum_cascade', pairAddress, order, entryIdx, i,
          cascadeState.takeProfit2, 'TAKE_PROFIT_2', entryCandle, c, peakPrice,
          realizedPnlSol, realizedExitValue, remainingQuantity
        );
      }

      // TP1 — 첫 TP1 히트 시 50% 익절 + breakeven SL
      if (!tp1WasHit && cascadeState.tp1Hit) {
        const partialQuantity = remainingQuantity * 0.5;
        realizedPnlSol += this.calcNetPnlSol(entryPrice, order.takeProfit1, partialQuantity);
        realizedExitValue += order.takeProfit1 * partialQuantity;
        remainingQuantity -= partialQuantity;
        activeSL = entryPrice; // breakeven
        cascadeState = this.updateCascadeStateAfterTp1(cascadeState, remainingQuantity, activeSL);
      }

      // ── Cascade add-on 로직 (TP1 이후만) ──
      if (cascadeState.tp1Hit && cascadeState.addOnCount < (cascadeParams.maxAddOns ?? 1)) {
        const lookbackWindow = candles.slice(
          Math.max(0, i - (cascadeParams.recompressionLookback ?? 10)),
          i + 1
        );

        // Step 1: 재압축 감지
        if (!recompressionDetected) {
          recompressionDetected = detectRecompression(
            lookbackWindow, peakPrice, cascadeParams
          );
        }

        // Step 2: 재압축 후 재가속 감지 → add-on 진입
        if (recompressionDetected) {
          const reaccWindow = candles.slice(Math.max(0, i - 21), i + 1);
          const reaccSignal = detectReacceleration(reaccWindow, {}, cascadeParams);

          if (reaccSignal.action === 'BUY') {
            const addOnQty = calculateAddOnQuantity(
              cascadeState.legs, currentPrice,
              cascadeState.originalRiskSol, 0.2, currentBalance
            );

            if (addOnQty > 0) {
              const addOnLeg: CascadeLeg = {
                entryPrice: currentPrice,
                quantity: addOnQty,
                stopLoss: entryPrice, // breakeven of leg 1
                entryIdx: i,
                entryTime: c.timestamp,
              };
              cascadeState = addCascadeLeg(cascadeState, addOnLeg);
              remainingQuantity += addOnQty;
              order.quantity += addOnQty;
              activeSL = cascadeState.combinedStopLoss;
              recompressionDetected = false;
            }
          }
        }
      }

      // Exhaustion Exit — 최소 2봉 보유 후
      const cascadeBarsHeld = i - entryIdx;
      if (cascadeBarsHeld >= 2 && monitorCandles.length >= 2) {
        const { exhausted } = checkExhaustion(monitorCandles, 2);
        if (exhausted && currentPrice > entryPrice) {
          return this.makeTrade(
            id, 'momentum_cascade', pairAddress, order, entryIdx, i,
            currentPrice, 'EXHAUSTION', entryCandle, c, peakPrice,
            realizedPnlSol, realizedExitValue, remainingQuantity
          );
        }
      }

      // Adaptive trailing — 최소 2봉 보유 후 활성화
      if (cascadeBarsHeld >= 2 && trailingStop && monitorCandles.length >= 8) {
        const atr = calcATR(monitorCandles, 7);
        const adaptiveStop = calcAdaptiveTrailingStop(monitorCandles, atr, entryPrice, peakPrice);
        if (currentPrice <= adaptiveStop && currentPrice > activeSL) {
          return this.makeTrade(
            id, 'momentum_cascade', pairAddress, order, entryIdx, i,
            currentPrice, 'TRAILING_STOP', entryCandle, c, peakPrice,
            realizedPnlSol, realizedExitValue, remainingQuantity
          );
        }
      }
    }

    // End of data
    const lastCandle = candles[candles.length - 1];
    return this.makeTrade(
      id, 'momentum_cascade', pairAddress, order, entryIdx, candles.length - 1,
      lastCandle.close, 'TIME_STOP', entryCandle, lastCandle, peakPrice,
      realizedPnlSol, realizedExitValue, remainingQuantity
    );
  }

  private updateCascadeStateAfterTp1(
    state: CascadeState,
    remainingQuantity: number,
    breakevenStop: number
  ): CascadeState {
    if (state.legs.length === 0) return state;

    const [firstLeg, ...restLegs] = state.legs;
    const updatedLegs = [
      {
        ...firstLeg,
        quantity: remainingQuantity,
        stopLoss: breakevenStop,
      },
      ...restLegs,
    ];
    const totalQuantity = updatedLegs.reduce((sum, leg) => sum + leg.quantity, 0);
    const costBasis = totalQuantity > 0
      ? updatedLegs.reduce((sum, leg) => sum + leg.entryPrice * leg.quantity, 0) / totalQuantity
      : state.costBasis;

    return {
      ...state,
      legs: updatedLegs,
      totalQuantity,
      costBasis,
      combinedStopLoss: breakevenStop,
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

  private emptyResult(strategy: StrategyName | 'combined', pairAddress: string): BacktestResult {
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
      rejections: { dailyLimit: 0, drawdownHalt: 0, cooldown: 0, positionOpen: 0, zeroSize: 0, executionViability: 0, gradeFiltered: 0, safetyFiltered: 0 },
      gradeDistribution: { A: 0, B: 0, C: 0 },
      trades: [],
      equityCurve: [],
      finalEquity: this.config.initialBalance,
    };
  }

  private evaluateSignalGates(signal: Signal, candles: Candle[], pairAddress: string) {
    const poolInfo = this.buildGatePoolInfo(pairAddress);
    signal.meta.currentVolume24hUsd = poolInfo.dailyVolume;
    const timelineScore = this.resolveTimelineAttentionScore(
      pairAddress,
      poolInfo.tokenMint,
      candles[candles.length - 1]?.timestamp
    );
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
      attentionScore: timelineScore ?? this.config.gateAttentionScore ?? this.config.gateEventScore,
      requireAttentionScore: this.config.requireAttentionScore ?? this.config.requireEventScore,
    });
  }

  private buildGatePoolInfo(pairAddress: string): PoolInfo {
    const gatePoolInfo = this.config.gatePoolInfo ?? {};
    return {
      pairAddress,
      tokenMint: gatePoolInfo.tokenMint ?? pairAddress,
      tvl: gatePoolInfo.tvl ?? this.config.minPoolLiquidity,
      marketCap: gatePoolInfo.marketCap,
      dailyVolume: gatePoolInfo.dailyVolume ?? 0,
      tradeCount24h: gatePoolInfo.tradeCount24h ?? 0,
      spreadPct: gatePoolInfo.spreadPct ?? 0,
      ammFeePct: gatePoolInfo.ammFeePct,
      mevMarginPct: gatePoolInfo.mevMarginPct,
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
    return rawPnlPct * quantity * entryPrice;
  }

  private resolveTimelineAttentionScore(
    pairAddress: string,
    tokenMint: string,
    timestamp?: Date
  ): AttentionScore | undefined {
    const timeline = this.config.attentionScoreTimeline ?? this.config.eventScoreTimeline;
    if (!timestamp || !timeline || timeline.length === 0) {
      return undefined;
    }

    const targetTime = timestamp.getTime();
    let matched: AttentionScore | undefined;
    let matchedDetectedAt = Number.NEGATIVE_INFINITY;

    for (const entry of timeline) {
      const matchesPair = !entry.pairAddress || entry.pairAddress === pairAddress;
      const matchesMint = !entry.tokenMint || entry.tokenMint === tokenMint || entry.tokenMint === pairAddress;
      if (!matchesPair || !matchesMint) continue;

      const detectedAt = Date.parse(entry.detectedAt);
      const expiresAt = Date.parse(entry.expiresAt);
      if (Number.isNaN(detectedAt) || Number.isNaN(expiresAt)) continue;
      if (targetTime < detectedAt || targetTime > expiresAt) continue;
      if (detectedAt >= matchedDetectedAt) {
        matched = entry;
        matchedDetectedAt = detectedAt;
      }
    }

    return matched;
  }

  /** 캔들 데이터에 buy/sell volume이 존재하는지 샘플 검사 */
  private hasBuySellVolumeData(candles: Candle[]): boolean {
    const sampleSize = Math.min(candles.length, 50);
    for (let i = 0; i < sampleSize; i++) {
      const c = candles[Math.floor(i * candles.length / sampleSize)];
      if ((c.buyVolume ?? 0) > 0 || (c.sellVolume ?? 0) > 0) return true;
    }
    return false;
  }

  private createInitialRiskState(firstTimestamp: Date): RiskState {
    return {
      balance: this.config.initialBalance,
      dailyPnl: 0,
      consecutiveLosses: 0,
      currentDay: dateKey(firstTimestamp),
      positionOpen: false,
      drawdownGuard: createDrawdownGuardState(this.config.initialBalance),
      edgeTracker: new EdgeTracker(),
      riskTier: resolveRiskTierProfile({
        edgeState: 'Bootstrap',
        kellyFraction: 0,
        kellyEligible: false,
        totalTrades: 0,
      }, this.config.recoveryPct),
      rejections: {
        dailyLimit: 0,
        drawdownHalt: 0,
        cooldown: 0,
        positionOpen: 0,
        zeroSize: 0,
        executionViability: 0,
        gradeFiltered: 0,
        safetyFiltered: 0,
      },
      gradeDistribution: { A: 0, B: 0, C: 0 },
    };
  }

  private buildCombinedCandidates(candles: Candle[], index: number): CandidateTrade[] {
    const candidates: CandidateTrade[] = [];
    const volumeWindow = candles.slice(Math.max(0, index - 21), index + 1);
    if (volumeWindow.length >= 22) {
      const signal = evaluateVolumeSpikeBreakout(volumeWindow, this.config.volumeSpikeParams);
      if (signal.action === 'BUY') {
        candidates.push({
          signal,
          candles: volumeWindow,
          timeStopMinutes: this.config.volumeSpikeParams.timeStopMinutes ?? 30,
        });
      }
    }

    const fibWindow = candles.slice(Math.max(0, index - 28), index + 1);
    if (fibWindow.length >= 29) {
      const signal = evaluateFibPullback(fibWindow, this.config.fibPullbackParams);
      if (signal.action === 'BUY') {
        candidates.push({
          signal,
          candles: fibWindow,
          timeStopMinutes: this.config.fibPullbackParams.timeStopMinutes ?? 60,
        });
      }
    }

    return candidates;
  }

  private attemptCandidateTrade(
    riskState: RiskState,
    candidate: CandidateTrade,
    allCandles: Candle[],
    currentIndex: number,
    pairAddress: string,
    tradeId: number,
    riskMode: 'strategy' | 'portfolio'
  ): BacktestTrade | null {
    let safetyMultiplier = 1.0;
    const gateResult = this.evaluateSignalGates(candidate.signal, candidate.candles, pairAddress);
    candidate.signal.breakoutScore = gateResult.breakoutScore;
    riskState.gradeDistribution[gateResult.breakoutScore.grade]++;

    if (gateResult.rejected) {
      if (gateResult.filterReason?.startsWith('poor_execution_viability')) {
        riskState.rejections.executionViability++;
      } else {
        riskState.rejections.gradeFiltered++;
      }
      return null;
    }

    if (gateResult.tokenSafety) {
      const safetyResult = checkTokenSafety(gateResult.tokenSafety, {
        minPoolLiquidity: this.config.minPoolLiquidity,
        minTokenAgeHours: this.config.minTokenAgeHours,
        maxHolderConcentration: this.config.maxHolderConcentration,
      });
      if (!safetyResult.approved) {
        riskState.rejections.safetyFiltered++;
        return null;
      }
      safetyMultiplier = safetyResult.sizeMultiplier;
    }

    const rejection = this.checkRisk(riskState, candidate.signal, allCandles[currentIndex]);
    if (rejection) {
      riskState.rejections[rejection]++;
      return null;
    }

    const order = candidate.signal.strategy === 'fib_pullback'
      ? buildFibPullbackOrder(candidate.signal, candidate.candles, 0, this.config.fibPullbackParams)
      : candidate.signal.strategy === 'momentum_cascade'
        ? buildMomentumCascadeOrder(candidate.signal, candidate.candles, 0, this.config.momentumCascadeParams)
        : buildVolumeSpikeOrder(candidate.signal, candidate.candles, 0, this.config.volumeSpikeParams);
    if (candidate.signal.breakoutScore) {
      order.breakoutScore = candidate.signal.breakoutScore.totalScore;
      order.breakoutGrade = candidate.signal.breakoutScore.grade;
    }

    const quantity = this.calculatePositionSize(
      riskState,
      order,
      safetyMultiplier * gateResult.gradeSizeMultiplier
    );
    if (quantity <= 0) {
      riskState.positionOpen = false;
      riskState.rejections.zeroSize++;
      return null;
    }
    order.quantity = quantity;

    const gatePoolInfo = this.buildGatePoolInfo(pairAddress);
    const actualExecution = evaluateExecutionViabilityForOrder(order, gatePoolInfo.tvl, {
      ammFeePct: gatePoolInfo.ammFeePct,
      mevMarginPct: gatePoolInfo.mevMarginPct,
    });
    if (actualExecution.rejected) {
      riskState.positionOpen = false;
      riskState.rejections.executionViability++;
      return null;
    }
    if (actualExecution.sizeMultiplier < 1) {
      order.quantity *= actualExecution.sizeMultiplier;
    }

    const trade = this.simulateTrade(
      order,
      allCandles,
      currentIndex,
      candidate.timeStopMinutes,
      tradeId,
      candidate.signal.strategy,
      pairAddress
    );
    if (!trade) {
      riskState.positionOpen = false;
      return null;
    }

    this.applyCompletedTrade(riskState, trade, riskMode);
    return trade;
  }

  private applyCompletedTrade(
    riskState: RiskState,
    trade: BacktestTrade,
    riskMode: 'strategy' | 'portfolio'
  ): void {
    riskState.positionOpen = false;
    riskState.balance += trade.pnlSol;
    riskState.dailyPnl += trade.pnlSol;
    riskState.edgeTracker.recordTrade({
      pairAddress: trade.pairAddress,
      strategy: trade.strategy,
      entryPrice: trade.entryPrice,
      stopLoss: trade.stopLoss,
      quantity: trade.quantity,
      pnl: trade.pnlSol,
    });
    riskState.riskTier = resolveRiskTierProfile(
      riskMode === 'portfolio'
        ? riskState.edgeTracker.getPortfolioStats()
        : riskState.edgeTracker.getStrategyStats(trade.strategy),
      this.config.recoveryPct
    );
    riskState.drawdownGuard = updateDrawdownGuardState(
      riskState.drawdownGuard,
      riskState.balance,
      riskState.riskTier
    );

    if (trade.pnlSol < 0) {
      riskState.consecutiveLosses++;
      riskState.lastLossTime = trade.exitTime;
    } else {
      riskState.consecutiveLosses = 0;
    }
  }
}
