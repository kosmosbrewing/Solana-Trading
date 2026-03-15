import { createModuleLogger } from '../utils/logger';
import {
  Order, RiskCheckResult, TokenSafety, PortfolioState, SizeConstraint, BreakoutGrade,
} from '../utils/types';
import { TradeStore } from '../candle/tradeStore';
import { checkTokenSafety as evaluateTokenSafety, SafetyGateResult } from '../gate/safetyGate';
import { getGradeSizeMultiplier } from '../gate/sizingGate';
import { calculateLiquiditySize, LiquidityParams, DEFAULT_LIQUIDITY_PARAMS } from './liquiditySizer';

const log = createModuleLogger('RiskManager');

export interface RiskConfig {
  maxRiskPerTrade: number;
  maxDailyLoss: number;
  maxConsecutiveLosses: number;
  cooldownMinutes: number;
  maxSlippage: number;
  minPoolLiquidity: number;
  minTokenAgeHours: number;
  maxHolderConcentration: number;
  liquidityParams?: Partial<LiquidityParams>;
}

/** checkOrder에 필요한 최소 주문 정보 */
export interface RiskOrderInput {
  pairAddress: string;
  strategy: string;
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

  constructor(riskConfig: RiskConfig, tradeStore: TradeStore) {
    this.riskConfig = riskConfig;
    this.tradeStore = tradeStore;
    this.liquidityParams = { ...DEFAULT_LIQUIDITY_PARAMS, ...riskConfig.liquidityParams };
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
    const appliedAdjustments: string[] = [];

    if (this.isDailyLossExceeded(portfolio)) {
      return {
        approved: false,
        reason: `Daily loss limit reached: ${portfolio.dailyPnl.toFixed(4)} SOL`,
      };
    }

    if (this.isInCooldown(portfolio)) {
      return {
        approved: false,
        reason: `Cooldown active: ${portfolio.consecutiveLosses} consecutive losses`,
      };
    }

    if (portfolio.openTrades.length > 0) {
      return {
        approved: false,
        reason: 'Max concurrent position limit reached (1)',
      };
    }

    if (tokenSafety) {
      const safetyResult = this.checkTokenSafety(tokenSafety);
      if (!safetyResult.approved) {
        return safetyResult;
      }
      safetyMultiplier = safetyResult.sizeMultiplier ?? 1.0;
      appliedAdjustments.push(...(safetyResult.appliedAdjustments ?? []));
    }

    // Grade C → 진입 금지
    if (order.breakoutGrade === 'C') {
      return {
        approved: false,
        reason: `Breakout grade C — entry rejected`,
      };
    }

    const { adjustedQuantity, sizeConstraint } = this.calculatePositionSize(order, portfolio);
    if (adjustedQuantity <= 0) {
      return {
        approved: false,
        reason: 'Calculated position size is zero or negative',
      };
    }

    // Grade B → Half Size
    const gradeMultiplier = getGradeSizeMultiplier(order.breakoutGrade);
    const finalQuantity = adjustedQuantity * gradeMultiplier * safetyMultiplier;

    if (finalQuantity <= 0) {
      return {
        approved: false,
        reason: 'Calculated position size is zero or negative after safety adjustments',
      };
    }

    log.info(
      `Order approved: ${order.strategy} ${order.side} ${order.pairAddress} ` +
      `qty=${finalQuantity.toFixed(6)} constraint=${sizeConstraint} grade=${order.breakoutGrade || 'N/A'}` +
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
    portfolio: PortfolioState
  ): { adjustedQuantity: number; sizeConstraint: SizeConstraint } {
    const stopLossPct = Math.abs(order.price - order.stopLoss) / order.price;

    // 풀 TVL 정보가 있으면 LiquiditySizer 사용
    if (order.poolTvl && order.poolTvl > 0) {
      const sizing = calculateLiquiditySize(
        portfolio.balanceSol,
        this.riskConfig.maxRiskPerTrade,
        stopLossPct,
        order.poolTvl,
        0.003,
        this.liquidityParams
      );

      const maxPositionValue = portfolio.balanceSol * 0.2;
      const maxPositionUnits = maxPositionValue / order.price;

      return {
        adjustedQuantity: Math.min(sizing.maxSize / order.price, maxPositionUnits),
        sizeConstraint: sizing.constraint,
      };
    }

    // Fallback: 기존 방식 (리스크 기반)
    const maxRisk = portfolio.balanceSol * this.riskConfig.maxRiskPerTrade;
    const riskPerUnit = Math.abs(order.price - order.stopLoss);
    if (riskPerUnit <= 0) return { adjustedQuantity: 0, sizeConstraint: 'RISK' };

    const positionSize = maxRisk / riskPerUnit;
    const maxPositionValue = portfolio.balanceSol * 0.2;
    const maxPositionUnits = maxPositionValue / order.price;

    return {
      adjustedQuantity: Math.min(positionSize, maxPositionUnits),
      sizeConstraint: 'RISK',
    };
  }

  private isDailyLossExceeded(portfolio: PortfolioState): boolean {
    const maxLoss = portfolio.balanceSol * this.riskConfig.maxDailyLoss;
    return portfolio.dailyPnl < -maxLoss;
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

  checkTokenSafety(safety: TokenSafety): SafetyGateResult {
    const result = evaluateTokenSafety(safety, {
      minPoolLiquidity: this.riskConfig.minPoolLiquidity,
      minTokenAgeHours: this.riskConfig.minTokenAgeHours,
      maxHolderConcentration: this.riskConfig.maxHolderConcentration,
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
    const [openTrades, dailyPnl, recentClosed] = await Promise.all([
      this.tradeStore.getOpenTrades(),
      this.tradeStore.getTodayPnl(),
      this.tradeStore.getRecentClosedTrades(10),
    ]);

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
      openTrades,
      dailyPnl,
      consecutiveLosses,
      lastLossTime,
    };
  }
}
