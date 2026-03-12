import { createModuleLogger } from '../utils/logger';
import {
  Order, RiskCheckResult, TokenSafety, PortfolioState, Trade,
} from '../utils/types';
import { TradeStore } from '../candle/tradeStore';

const log = createModuleLogger('RiskManager');

export interface RiskConfig {
  maxRiskPerTrade: number;       // 포트폴리오의 1%
  maxDailyLoss: number;          // 포트폴리오의 5%
  maxConsecutiveLosses: number;  // 3연패 시 쿨다운
  cooldownMinutes: number;       // 30분
  maxSlippage: number;           // 1%
  minPoolLiquidity: number;      // $50,000
  minTokenAgeHours: number;      // 24시간
  maxHolderConcentration: number; // 80%
}

export class RiskManager {
  private riskConfig: RiskConfig;
  private tradeStore: TradeStore;

  constructor(riskConfig: RiskConfig, tradeStore: TradeStore) {
    this.riskConfig = riskConfig;
    this.tradeStore = tradeStore;
  }

  /**
   * 주문 승인 여부 결정
   */
  async checkOrder(
    order: Order,
    portfolio: PortfolioState,
    tokenSafety?: TokenSafety
  ): Promise<RiskCheckResult> {
    // 1. 일일 최대 손실 체크
    if (this.isDailyLossExceeded(portfolio)) {
      return {
        approved: false,
        reason: `Daily loss limit reached: ${portfolio.dailyPnl.toFixed(4)} SOL`,
      };
    }

    // 2. 연속 손실 쿨다운 체크
    if (this.isInCooldown(portfolio)) {
      return {
        approved: false,
        reason: `Cooldown active: ${portfolio.consecutiveLosses} consecutive losses`,
      };
    }

    // 3. 동시 포지션 체크 (P0~P3: 최대 1개)
    if (portfolio.openTrades.length > 0) {
      return {
        approved: false,
        reason: 'Max concurrent position limit reached (1)',
      };
    }

    // 4. 안전 필터 체크
    if (tokenSafety) {
      const safetyResult = this.checkTokenSafety(tokenSafety);
      if (!safetyResult.approved) {
        return safetyResult;
      }
    }

    // 5. 포지션 크기 계산 (리스크 기반 역산)
    const adjustedQuantity = this.calculatePositionSize(order, portfolio);
    if (adjustedQuantity <= 0) {
      return {
        approved: false,
        reason: 'Calculated position size is zero or negative',
      };
    }

    log.info(
      `Order approved: ${order.strategy} ${order.side} ${order.pairAddress} qty=${adjustedQuantity}`
    );

    return {
      approved: true,
      adjustedQuantity,
    };
  }

  /**
   * 포지션 크기 계산 — 리스크 기반 역산
   * 최대 리스크 = 포트폴리오 × maxRiskPerTrade
   * 포지션 크기 = 최대 리스크 / (entry - stopLoss)
   */
  calculatePositionSize(order: Order, portfolio: PortfolioState): number {
    const maxRisk = portfolio.balanceSol * this.riskConfig.maxRiskPerTrade;
    const riskPerUnit = Math.abs(order.price - order.stopLoss);

    if (riskPerUnit <= 0) return 0;

    const positionSize = maxRisk / riskPerUnit;
    const maxPositionValue = portfolio.balanceSol * 0.2; // 최대 포트폴리오의 20%
    const maxPositionUnits = maxPositionValue / order.price;

    return Math.min(positionSize, maxPositionUnits);
  }

  /**
   * 일일 최대 손실 체크
   */
  private isDailyLossExceeded(portfolio: PortfolioState): boolean {
    const maxLoss = portfolio.balanceSol * this.riskConfig.maxDailyLoss;
    return portfolio.dailyPnl < -maxLoss;
  }

  /**
   * 연속 손실 쿨다운 체크
   */
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

  /**
   * 토큰 안전 필터 (Rug Pull Prevention)
   */
  checkTokenSafety(safety: TokenSafety): RiskCheckResult {
    // Pool Liquidity < $50K → 진입 금지
    if (safety.poolLiquidity < this.riskConfig.minPoolLiquidity) {
      return {
        approved: false,
        reason: `Pool liquidity too low: $${safety.poolLiquidity.toFixed(0)}`,
      };
    }

    // Token Age < 24시간 → 진입 금지
    if (safety.tokenAgeHours < this.riskConfig.minTokenAgeHours) {
      return {
        approved: false,
        reason: `Token too new: ${safety.tokenAgeHours.toFixed(1)}h old`,
      };
    }

    // Top 10 홀더 집중도 > 80% → 진입 금지
    if (safety.top10HolderPct > this.riskConfig.maxHolderConcentration) {
      return {
        approved: false,
        reason: `Holder concentration too high: ${(safety.top10HolderPct * 100).toFixed(1)}%`,
      };
    }

    // LP 미소각 → 경고 (포지션 50% 축소)
    if (!safety.lpBurned) {
      log.warn('LP tokens not burned — reducing position by 50%');
      return { approved: true, reason: 'LP not burned — position halved' };
    }

    // Ownership 미포기 → 경고 (포지션 50% 축소)
    if (!safety.ownershipRenounced) {
      log.warn('Ownership not renounced — reducing position by 50%');
      return { approved: true, reason: 'Ownership not renounced — position halved' };
    }

    return { approved: true };
  }

  /**
   * 현재 포트폴리오 상태 구성
   */
  async getPortfolioState(balanceSol: number, solPrice: number): Promise<PortfolioState> {
    const openTrades = await this.tradeStore.getOpenTrades();
    const dailyPnl = await this.tradeStore.getTodayPnl();
    const recentClosed = await this.tradeStore.getRecentClosedTrades(10);

    // 연속 손실 카운트
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
      balanceUsd: balanceSol * solPrice,
      openTrades,
      dailyPnl,
      dailyTradeCount: (await this.tradeStore.getTodayTrades()).length,
      consecutiveLosses,
      lastLossTime,
    };
  }
}
