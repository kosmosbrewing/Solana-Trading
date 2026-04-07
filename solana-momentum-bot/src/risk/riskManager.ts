import { createModuleLogger } from '../utils/logger';
import { config } from '../utils/config';
import {
  RiskCheckResult, TokenSafety, PortfolioState, SizeConstraint, BreakoutGrade, DrawdownGuardState, StrategyName,
  Trade,
} from '../utils/types';
import { TradeStore } from '../candle/tradeStore';
import { EdgeTracker, EdgeTrackerTrade, sanitizeEdgeLikeTrades } from '../reporting';
import type { RuntimeDiagnosticsTracker } from '../reporting/runtimeDiagnosticsTracker';
import { checkTokenSafety as evaluateTokenSafety, SafetyGateResult } from '../gate/safetyGate';
import { getGradeSizeMultiplier } from '../gate/sizingGate';
import { calculateLiquiditySize, LiquidityParams, DEFAULT_LIQUIDITY_PARAMS } from './liquiditySizer';
import { updateDrawdownGuardState } from './drawdownGuard';
import {
  replayPortfolioDrawdownGuard,
  resolvePortfolioRiskTier,
  resolveRiskTierWithDemotion,
  resolveStrategyRiskTier,
  RiskTierProfile,
} from './riskTier';

const log = createModuleLogger('RiskManager');

export interface RiskConfig {
  maxRiskPerTrade: number;
  maxDailyLoss: number;
  maxDrawdownPct: number;
  recoveryPct: number;
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
  samePairOpenPositionBlock?: boolean;
  perTokenLossCooldownLosses?: number;
  perTokenLossCooldownMinutes?: number;
  perTokenDailyTradeCap?: number;
  maxSlippage: number;
  minPoolLiquidity: number;
  minTokenAgeHours: number;
  maxHolderConcentration: number;
  liquidityParams?: Partial<LiquidityParams>;
  /** v3: Runner 중 +1 concurrent 허용 */
  runnerConcurrentEnabled?: boolean;
  /** v3: 최대 동시 포지션 수 */
  maxConcurrentPositions?: number;
  /** v4: 포트폴리오 대비 최대 포지션 비율 (기본 0.20 = 20%) */
  maxPositionPct?: number;
  /** v4: Concurrent 절대 상한 (runner bypass 포함, 기본 3) */
  maxConcurrentAbsolute?: number;
  /** v4: Equity tier — 이 equity 이상이면 2 concurrent (기본 5 SOL) */
  concurrentTier1Sol?: number;
  /** v4: Equity tier — 이 equity 이상이면 3 concurrent (기본 20 SOL) */
  concurrentTier2Sol?: number;
  /** v4: Impact tier — equity 기반 maxPoolImpact 동적 축소 */
  impactTier1Sol?: number;
  impactTier1MaxImpact?: number;
  impactTier2Sol?: number;
  impactTier2MaxImpact?: number;
}

export interface RiskHalt {
  kind: 'dailyLoss' | 'drawdown';
  reason: string;
}

export interface OpenTradeMarkToMarket {
  quantity: number;
  currentPrice: number;
}

/** checkOrder에 필요한 최소 주문 정보 */
export interface RiskOrderInput {
  pairAddress: string;
  strategy: StrategyName;
  side: string;
  price: number;
  stopLoss: number;
  breakoutGrade?: BreakoutGrade;
  poolTvl?: number;
}

export class RiskManager {
  private riskConfig: RiskConfig;
  private tradeStore: TradeStore;
  private liquidityParams: LiquidityParams;
  private diagnosticsTracker?: RuntimeDiagnosticsTracker;

  // Why: cooldown/cap reject 후에도 trigger eval이 계속 소모되는 문제 해소
  // suppress된 pair를 등록하면 index.ts에서 trigger.onCandle() 전에 skip
  private suppressedPairs = new Map<string, number>(); // pairAddress → suppressUntilMs

  constructor(riskConfig: RiskConfig, tradeStore: TradeStore) {
    this.riskConfig = riskConfig;
    this.tradeStore = tradeStore;
    this.liquidityParams = { ...DEFAULT_LIQUIDITY_PARAMS, ...riskConfig.liquidityParams };
  }

  setDiagnosticsTracker(tracker: RuntimeDiagnosticsTracker): void {
    this.diagnosticsTracker = tracker;
  }

  /** cooldown/cap-suppressed pair인지 확인 (trigger eval 전에 호출) */
  isCapSuppressed(pairAddress: string): boolean {
    const suppressUntilMs = this.suppressedPairs.get(pairAddress);
    if (suppressUntilMs == null) return false;
    if (Date.now() >= suppressUntilMs) {
      this.suppressedPairs.delete(pairAddress);
      return false;
    }
    return true;
  }

  /** 모든 suppress 상태 초기화 (일괄 해제용) */
  clearSuppressedPairs(): void {
    this.suppressedPairs.clear();
  }

  /**
   * 주문 승인 여부 결정
   */
  async checkOrder(
    order: RiskOrderInput,
    portfolio: PortfolioState,
    tokenSafety?: TokenSafety
  ): Promise<RiskCheckResult> {
    let safetyMultiplier = 1.0;
    const [closedTrades, todayTrades] = await Promise.all([
      this.tradeStore.getClosedTradesChronological(),
      this.needsTodayTrades()
        ? this.tradeStore.getTodayTrades()
        : Promise.resolve([] as Trade[]),
    ]);
    const sanitizerResult = sanitizeEdgeLikeTrades(closedTrades.map(toEdgeTrackerTrade));
    const closedEdgeTrades = sanitizerResult.trades;
    if (sanitizerResult.droppedCount > 0) {
      const reasons = Object.entries(sanitizerResult.dropReasonCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      log.warn(
        `EdgeTracker input sanitized: dropped ${sanitizerResult.droppedCount}/${closedTrades.length} ` +
        `(${reasons})`
      );
    }
    const strategyRisk = resolveStrategyRiskTier(
      closedEdgeTrades,
      order.strategy,
      this.riskConfig.recoveryPct
    );
    const edgeTracker = new EdgeTracker(closedEdgeTrades);

    // H-04: Demotion 체크 활성화 — 최근 성과 하락 시 자동 강등
    const { profile: demotionProfile, demoted, demotionReason } =
      resolveRiskTierWithDemotion(edgeTracker, this.riskConfig.recoveryPct);

    const portfolioRisk = portfolio.riskTier ?? (demoted ? demotionProfile : resolvePortfolioRiskTier(
      closedEdgeTrades,
      this.riskConfig.recoveryPct
    ));
    const appliedAdjustments: string[] = [`RISK_TIER_${strategyRisk.edgeState.toUpperCase()}`];

    if (demoted) {
      appliedAdjustments.push(`DEMOTED_${demotionProfile.edgeState.toUpperCase()}`);
      log.warn(`Risk tier demoted: ${demotionReason}`);
    }

    if (strategyRisk.kellyApplied) {
      appliedAdjustments.push(`KELLY_${strategyRisk.kellyMode.toUpperCase()}`);
    }

    const activeHalt = this.getActiveHalt({
      ...portfolio,
      drawdownGuard: replayPortfolioDrawdownGuard(
        portfolio.equitySol,
        closedEdgeTrades,
        this.riskConfig.recoveryPct
      ),
      riskTier: portfolioRisk,
    });
    if (activeHalt) {
      this.diagnosticsTracker?.recordRiskRejection('active_halt', order.pairAddress);
      return {
        approved: false,
        reason: activeHalt.reason,
      };
    }

    if (this.isInCooldown(portfolio)) {
      this.diagnosticsTracker?.recordRiskRejection('portfolio_cooldown', order.pairAddress);
      return {
        approved: false,
        reason: `Cooldown active: ${portfolio.consecutiveLosses} consecutive losses`,
      };
    }

    if (this.hasOpenTradeForPair(order.pairAddress, portfolio)) {
      this.diagnosticsTracker?.recordRiskRejection('same_pair_block', order.pairAddress);
      return {
        approved: false,
        reason: `Same-pair position already open: ${order.pairAddress}`,
      };
    }

    const pairLossCooldown = this.getPerTokenLossCooldown(order.pairAddress, closedTrades);
    if (pairLossCooldown.active) {
      const cooldownUntil = pairLossCooldown.until?.toISOString() ?? 'unknown';
      if (pairLossCooldown.until) {
        this.suppressedPairs.set(order.pairAddress, pairLossCooldown.until.getTime());
        log.info(
          `Cooldown-suppress activated: ${order.pairAddress} ` +
          `until ${pairLossCooldown.until.toISOString()}`
        );
      }
      this.diagnosticsTracker?.recordRiskRejection('per_token_cooldown', order.pairAddress);
      return {
        approved: false,
        reason:
          `Per-token cooldown active: ${pairLossCooldown.losses} recent losses ` +
          `until ${cooldownUntil}`,
      };
    }

    const perTokenDailyTradeCap = this.riskConfig.perTokenDailyTradeCap ?? 0;
    if (perTokenDailyTradeCap > 0) {
      const pairTradesToday = todayTrades.filter(
        (trade) => trade.pairAddress === order.pairAddress && trade.status !== 'FAILED'
      ).length;
      if (pairTradesToday >= perTokenDailyTradeCap) {
        this.suppressedPairs.set(order.pairAddress, getNextUtcDayStartMs());
        log.info(`Cap-suppress activated: ${order.pairAddress} (${pairTradesToday}/${perTokenDailyTradeCap})`);
        this.diagnosticsTracker?.recordRiskRejection('daily_trade_cap', order.pairAddress);
        return {
          approved: false,
          reason:
            `Per-token daily trade cap reached: ${pairTradesToday}/${perTokenDailyTradeCap} ` +
            `for ${order.pairAddress}`,
        };
      }
    }

    const ABSOLUTE_MAX = this.riskConfig.maxConcurrentAbsolute ?? 3;
    const maxConcurrent = this.resolveMaxConcurrent(portfolio.equitySol);
    if (portfolio.openTrades.length >= maxConcurrent) {
      // v3: Runner 중이면 +1 허용 (ABSOLUTE_MAX 이내)
      const canBypassForRunner =
        (this.riskConfig.runnerConcurrentEnabled ?? false) &&
        portfolio.openTrades.length < ABSOLUTE_MAX &&
        portfolio.runnerTradeIds &&
        portfolio.runnerTradeIds.size > 0 &&
        // 모든 기존 포지션 중 최소 하나가 runner일 때 bypass
        portfolio.openTrades.some(t => portfolio.runnerTradeIds!.has(t.id));

      if (!canBypassForRunner) {
        this.diagnosticsTracker?.recordRiskRejection('max_concurrent', order.pairAddress);
        return {
          approved: false,
          reason: `Max concurrent position limit reached (${maxConcurrent})`,
        };
      }
      appliedAdjustments.push('RUNNER_CONCURRENT_BYPASS');
      log.info('Runner concurrent bypass: existing position is runner, allowing +1');
    }

    const pairStats = edgeTracker.getPairStats(order.pairAddress);
    if (edgeTracker.isPairBlacklisted(order.pairAddress)) {
      // Phase B2: BOT_BYPASS_EDGE_BLACKLIST=true면 blacklist를 무시하고 진입 허용.
      // 단 모든 bypass 사건을 audit log로 남겨 canary 종료 후 역추적 가능하게 한다.
      if (config.bypassEdgeBlacklist) {
        log.warn(
          `[BYPASSED_EDGE_BLACKLIST] ${order.pairAddress} ` +
          `WR ${(pairStats.winRate * 100).toFixed(1)}% ` +
          `RR ${formatMetric(pairStats.rewardRisk)} ` +
          `Sharpe ${formatMetric(pairStats.sharpeRatio)} ` +
          `MaxL ${pairStats.maxConsecutiveLosses}`
        );
        appliedAdjustments.push('BYPASSED_EDGE_BLACKLIST');
      } else {
        this.diagnosticsTracker?.recordRiskRejection('edge_blacklist', order.pairAddress);
        return {
          approved: false,
          reason:
            `Pair blacklisted by edge tracker: WR ${(pairStats.winRate * 100).toFixed(1)}% ` +
            `RR ${formatMetric(pairStats.rewardRisk)} Sharpe ${formatMetric(pairStats.sharpeRatio)} ` +
            `MaxL ${pairStats.maxConsecutiveLosses}`,
        };
      }
    }

    if (tokenSafety) {
      const safetyResult = this.checkTokenSafety(tokenSafety, portfolio.equitySol);
      if (!safetyResult.approved) {
        this.diagnosticsTracker?.recordRiskRejection('token_safety', order.pairAddress);
        return safetyResult;
      }
      safetyMultiplier = safetyResult.sizeMultiplier ?? 1.0;
      appliedAdjustments.push(...(safetyResult.appliedAdjustments ?? []));
    }

    const { adjustedQuantity, sizeConstraint } = this.calculatePositionSize(
      order,
      portfolio,
      strategyRisk
    );
    if (adjustedQuantity <= 0) {
      this.diagnosticsTracker?.recordRiskRejection('zero_position_size', order.pairAddress);
      return {
        approved: false,
        reason: 'Calculated position size is zero or negative',
      };
    }

    const gradeMultiplier = getGradeSizeMultiplier(order.breakoutGrade);
    const finalQuantity = adjustedQuantity * gradeMultiplier * safetyMultiplier;

    if (finalQuantity <= 0) {
      this.diagnosticsTracker?.recordRiskRejection('zero_position_size_after_adjustments', order.pairAddress);
      return {
        approved: false,
        reason: 'Calculated position size is zero or negative after safety adjustments',
      };
    }

    log.info(
      `Order approved: ${order.strategy} ${order.side} ${order.pairAddress} ` +
      `qty=${finalQuantity.toFixed(6)} constraint=${sizeConstraint} grade=${order.breakoutGrade || 'N/A'} ` +
      `tier=${strategyRisk.edgeState} risk=${(strategyRisk.maxRiskPerTrade * 100).toFixed(2)}%` +
      (appliedAdjustments.length > 0 ? ` adjustments=${appliedAdjustments.join(',')}` : '')
    );

    return {
      approved: true,
      adjustedQuantity: finalQuantity,
      sizeConstraint,
      appliedAdjustments,
    };
  }

  /**
   * 포지션 크기 계산 — 3-Constraint Model (LiquiditySizer)
   */
  calculatePositionSize(
    order: RiskOrderInput,
    portfolio: PortfolioState,
    strategyRisk: RiskTierProfile
  ): { adjustedQuantity: number; sizeConstraint: SizeConstraint } {
    const stopLossPct = Math.abs(order.price - order.stopLoss) / order.price;

    // 풀 TVL 정보가 있으면 LiquiditySizer 사용
    if (order.poolTvl && order.poolTvl > 0) {
      // v4: equity 기반 동적 maxPoolImpact
      const dynamicImpact = this.resolveMaxPoolImpact(portfolio.equitySol);
      const liquidityOverrides = dynamicImpact !== undefined
        ? { ...this.liquidityParams, maxPoolImpactPct: dynamicImpact }
        : this.liquidityParams;

      const sizing = calculateLiquiditySize(
        portfolio.balanceSol,
        strategyRisk.maxRiskPerTrade,
        stopLossPct,
        order.poolTvl,
        0.003,
        liquidityOverrides
      );

      const positionCap = this.riskConfig.maxPositionPct ?? 0.20;
      const maxPositionValue = portfolio.balanceSol * positionCap;
      const maxPositionUnits = maxPositionValue / order.price;

      return {
        adjustedQuantity: Math.min(sizing.maxSize / order.price, maxPositionUnits),
        sizeConstraint: sizing.constraint,
      };
    }

    // Fallback: 기존 방식 (리스크 기반)
    const maxRisk = portfolio.balanceSol * strategyRisk.maxRiskPerTrade;
    const riskPerUnit = Math.abs(order.price - order.stopLoss);
    if (riskPerUnit <= 0) return { adjustedQuantity: 0, sizeConstraint: 'RISK' };

    const positionSize = maxRisk / riskPerUnit;
    const positionCap = this.riskConfig.maxPositionPct ?? 0.20;
    const maxPositionValue = portfolio.balanceSol * positionCap;
    const maxPositionUnits = maxPositionValue / order.price;

    return {
      adjustedQuantity: Math.min(positionSize, maxPositionUnits),
      sizeConstraint: 'RISK',
    };
  }

  getActiveHalt(portfolio: PortfolioState): RiskHalt | undefined {
    if (portfolio.drawdownGuard.halted) {
      return {
        kind: 'drawdown',
        reason: this.formatDrawdownHaltReason(portfolio.drawdownGuard),
      };
    }

    const maxDailyLoss = portfolio.riskTier?.maxDailyLoss ?? this.riskConfig.maxDailyLoss;
    if (this.isDailyLossExceeded(portfolio, maxDailyLoss)) {
      return {
        kind: 'dailyLoss',
        reason: `Daily loss limit reached: ${portfolio.dailyPnl.toFixed(4)} SOL`,
      };
    }

    return undefined;
  }

  private isDailyLossExceeded(portfolio: PortfolioState, maxDailyLoss: number): boolean {
    const maxLoss = portfolio.equitySol * maxDailyLoss;
    return portfolio.dailyPnl < -maxLoss;
  }

  applyUnrealizedDrawdown(
    portfolio: PortfolioState,
    positions: OpenTradeMarkToMarket[]
  ): PortfolioState {
    if (positions.length === 0) return portfolio;

    const markedToMarketValue = positions.reduce(
      (sum, position) => sum + Math.max(0, position.currentPrice) * Math.max(0, position.quantity),
      0
    );
    const equitySol = portfolio.balanceSol + markedToMarketValue;
    const riskTier = portfolio.riskTier ?? {
      edgeState: 'Bootstrap',
      maxRiskPerTrade: this.riskConfig.maxRiskPerTrade,
      maxDailyLoss: this.riskConfig.maxDailyLoss,
      maxDrawdownPct: this.riskConfig.maxDrawdownPct,
      recoveryPct: this.riskConfig.recoveryPct,
      kellyFraction: 0,
      kellyApplied: false,
      kellyMode: 'fixed' as const,
    };

    return {
      ...portfolio,
      equitySol,
      drawdownGuard: updateDrawdownGuardState(
        portfolio.drawdownGuard,
        equitySol,
        riskTier
      ),
      riskTier,
    };
  }

  /**
   * v4: Equity 기반 동적 maxConcurrent 계산
   * 포트폴리오 성장에 따라 동시 포지션 수 자동 확대
   */
  private resolveMaxConcurrent(equitySol: number): number {
    const base = this.riskConfig.maxConcurrentPositions ?? 1;
    const absoluteMax = this.riskConfig.maxConcurrentAbsolute ?? 3;
    const tier1 = this.riskConfig.concurrentTier1Sol ?? 5;
    const tier2 = this.riskConfig.concurrentTier2Sol ?? 20;

    let equityMax = 1;
    if (equitySol >= tier2) equityMax = 3;
    else if (equitySol >= tier1) equityMax = 2;

    return Math.min(Math.max(base, equityMax), absoluteMax);
  }

  /**
   * v4: Equity 기반 동적 maxPoolImpact 결정
   * 포트폴리오 성장 시 시장 영향력 자동 제한
   */
  private resolveMaxPoolImpact(equitySol: number): number | undefined {
    const t1Sol = this.riskConfig.impactTier1Sol;
    const t2Sol = this.riskConfig.impactTier2Sol;
    if (t1Sol == null && t2Sol == null) return undefined;

    if (t2Sol && equitySol >= t2Sol && this.riskConfig.impactTier2MaxImpact !== undefined) {
      return this.riskConfig.impactTier2MaxImpact;
    }
    if (t1Sol && equitySol >= t1Sol && this.riskConfig.impactTier1MaxImpact !== undefined) {
      return this.riskConfig.impactTier1MaxImpact;
    }
    return undefined;
  }

  private isInCooldown(portfolio: PortfolioState): boolean {
    if (portfolio.consecutiveLosses < this.riskConfig.maxConsecutiveLosses) {
      return false;
    }
    if (!portfolio.lastLossTime) return false;

    const cooldownEnd = new Date(
      portfolio.lastLossTime.getTime() + this.riskConfig.cooldownMinutes * 60 * 1000
    );
    return new Date() < cooldownEnd;
  }

  private hasOpenTradeForPair(pairAddress: string, portfolio: PortfolioState): boolean {
    if (!(this.riskConfig.samePairOpenPositionBlock ?? true)) {
      return false;
    }

    return portfolio.openTrades.some((trade) => trade.pairAddress === pairAddress);
  }

  private getPerTokenLossCooldown(
    pairAddress: string,
    closedTrades: Trade[]
  ): { active: boolean; losses: number; until?: Date } {
    const requiredLosses = this.riskConfig.perTokenLossCooldownLosses ?? 0;
    const cooldownMinutes = this.riskConfig.perTokenLossCooldownMinutes ?? 0;
    if (requiredLosses <= 0 || cooldownMinutes <= 0) {
      return { active: false, losses: 0 };
    }

    let consecutiveLosses = 0;
    let latestLossTime: Date | undefined;

    for (let index = closedTrades.length - 1; index >= 0; index--) {
      const trade = closedTrades[index];
      if (trade.pairAddress !== pairAddress) continue;
      if ((trade.pnl ?? 0) >= 0) break;

      consecutiveLosses += 1;
      latestLossTime = latestLossTime ?? trade.closedAt;
      if (consecutiveLosses >= requiredLosses) {
        break;
      }
    }

    if (consecutiveLosses < requiredLosses || !latestLossTime) {
      return { active: false, losses: consecutiveLosses };
    }

    const cooldownEnd = new Date(latestLossTime.getTime() + cooldownMinutes * 60 * 1000);
    return {
      active: new Date() < cooldownEnd,
      losses: consecutiveLosses,
      until: cooldownEnd,
    };
  }

  private needsTodayTrades(): boolean {
    return (this.riskConfig.perTokenDailyTradeCap ?? 0) > 0;
  }

  checkTokenSafety(safety: TokenSafety, equitySol?: number): SafetyGateResult {
    const result = evaluateTokenSafety(safety, {
      minPoolLiquidity: this.riskConfig.minPoolLiquidity,
      minTokenAgeHours: this.riskConfig.minTokenAgeHours,
      maxHolderConcentration: this.riskConfig.maxHolderConcentration,
      equitySol,
    });

    if (result.appliedAdjustments.includes('LP_NOT_BURNED_HALF')) {
      log.warn('LP tokens not burned — reducing position by 50%');
    }
    if (result.appliedAdjustments.includes('OWNERSHIP_NOT_RENOUNCED_HALF')) {
      log.warn('Ownership not renounced — reducing position by 50%');
    }

    return result;
  }

  /**
   * 현재 포트폴리오 상태 구성 — 병렬 DB 쿼리
   */
  async getPortfolioState(balanceSol: number): Promise<PortfolioState> {
    const [openTrades, dailyPnl, recentClosed, closedTrades] = await Promise.all([
      this.tradeStore.getOpenTrades(),
      this.tradeStore.getTodayPnl(),
      this.tradeStore.getRecentClosedTrades(10),
      this.tradeStore.getClosedTradesChronological(),
    ]);

    // Open-position mark-to-market requires live candle prices and is applied later via applyUnrealizedDrawdown().
    // 여기서 raw trade.quantity를 더하면 token units를 SOL equity로 오인해 HWM/drawdown이 왜곡된다.
    const equitySol = balanceSol;
    const closedEdgeTrades = closedTrades.map(toEdgeTrackerTrade);
    const riskTier = resolvePortfolioRiskTier(closedEdgeTrades, this.riskConfig.recoveryPct);
    const drawdownGuard = replayPortfolioDrawdownGuard(
      equitySol,
      closedEdgeTrades,
      this.riskConfig.recoveryPct
    );

    let consecutiveLosses = 0;
    let lastLossTime: Date | undefined;
    for (const trade of recentClosed) {
      if (trade.pnl !== undefined && trade.pnl < 0) {
        consecutiveLosses++;
        if (!lastLossTime) lastLossTime = trade.closedAt;
      } else {
        break;
      }
    }

    return {
      balanceSol,
      equitySol,
      openTrades,
      dailyPnl,
      consecutiveLosses,
      lastLossTime,
      drawdownGuard,
      riskTier,
    };
  }

  private formatDrawdownHaltReason(drawdownGuard: DrawdownGuardState): string {
    return (
      `Drawdown guard active: ${(drawdownGuard.drawdownPct * 100).toFixed(2)}% below HWM ` +
      `${drawdownGuard.peakBalanceSol.toFixed(4)} SOL; resume at ${drawdownGuard.recoveryBalanceSol.toFixed(4)} SOL`
    );
  }
}

function toEdgeTrackerTrade(
  trade: Awaited<ReturnType<TradeStore['getClosedTradesChronological']>>[number]
): EdgeTrackerTrade {
  return {
    pairAddress: trade.pairAddress,
    strategy: trade.strategy,
    entryPrice: trade.entryPrice,
    stopLoss: trade.stopLoss,
    quantity: trade.quantity,
    pnl: trade.pnl ?? 0,
    // Phase B1: sanitizer가 오염된 ledger row를 drop할 수 있도록 정합성 컨텍스트 전달.
    plannedEntryPrice: trade.plannedEntryPrice ?? null,
    exitReason: trade.exitReason ?? null,
  };
}

function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return 'inf';
  return value.toFixed(2);
}

function getNextUtcDayStartMs(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}
