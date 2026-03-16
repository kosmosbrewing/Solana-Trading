import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('RegimeFilter');

export type MarketRegime = 'risk_on' | 'neutral' | 'risk_off';

export interface RegimeState {
  regime: MarketRegime;
  sizeMultiplier: number;
  /** SOL 4H trend: EMA20 > EMA50 = bullish */
  solTrendBullish: boolean;
  /** Watchlist breadth: % of candidates with successful follow-through */
  breadthPct: number;
  /** Recent breakout follow-through hit rate */
  followThroughPct: number;
  updatedAt: Date;
}

export interface RegimeFilterConfig {
  /** Breadth threshold for risk-off */
  breadthRiskOffThreshold: number;
  /** Follow-through threshold for risk-off */
  followThroughRiskOffThreshold: number;
  /** Breadth threshold for risk-on */
  breadthRiskOnThreshold: number;
  /** Follow-through threshold for risk-on */
  followThroughRiskOnThreshold: number;
}

const DEFAULT_CONFIG: RegimeFilterConfig = {
  breadthRiskOffThreshold: 0.30,
  followThroughRiskOffThreshold: 0.25,
  breadthRiskOnThreshold: 0.50,
  followThroughRiskOnThreshold: 0.40,
};

/**
 * Market Regime Filter — 3-Factor Classification
 *
 * Factor 1: SOL 4H Trend (macro)
 *   - EMA20 > EMA50 = bullish
 *
 * Factor 2: Watchlist Breadth (internal micro)
 *   - 후보군 중 고점돌파 후 2봉 연장 성공 비율
 *
 * Factor 3: Recent Follow-through (internal micro)
 *   - 최근 1~2일 breakout → TP1 도달률
 */
export class RegimeFilter {
  private config: RegimeFilterConfig;
  private state: RegimeState;

  constructor(config: Partial<RegimeFilterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      regime: 'neutral',
      sizeMultiplier: 0.7,
      solTrendBullish: true,
      breadthPct: 0.5,
      followThroughPct: 0.5,
      updatedAt: new Date(),
    };
  }

  getState(): RegimeState {
    return { ...this.state };
  }

  getRegime(): MarketRegime {
    return this.state.regime;
  }

  getSizeMultiplier(): number {
    return this.state.sizeMultiplier;
  }

  /**
   * SOL 4H 트렌드 업데이트 (Birdeye SOL/USD 4H OHLCV에서 계산)
   */
  updateSolTrend(candles4h: { close: number }[]): void {
    if (candles4h.length < 50) {
      log.debug('Not enough 4H candles for regime trend');
      return;
    }
    const closes = candles4h.map(c => c.close);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    this.state.solTrendBullish = ema20 > ema50;
    this.classify();
  }

  /**
   * Watchlist breadth 업데이트
   * @param successCount 고점돌파 후 2봉 연장 성공한 후보 수
   * @param totalCount 전체 후보 수
   */
  updateBreadth(successCount: number, totalCount: number): void {
    this.state.breadthPct = totalCount > 0 ? successCount / totalCount : 0;
    this.classify();
  }

  /**
   * Follow-through hit rate 업데이트
   * @param tp1Hits TP1 도달한 트레이드 수
   * @param totalBreakouts 전체 브레이크아웃 트레이드 수
   */
  updateFollowThrough(tp1Hits: number, totalBreakouts: number): void {
    this.state.followThroughPct = totalBreakouts > 0 ? tp1Hits / totalBreakouts : 0;
    this.classify();
  }

  private classify(): void {
    const { solTrendBullish, breadthPct, followThroughPct } = this.state;

    // Count bullish factors
    let bullishFactors = 0;
    if (solTrendBullish) bullishFactors++;
    if (breadthPct >= this.config.breadthRiskOnThreshold) bullishFactors++;
    if (followThroughPct >= this.config.followThroughRiskOnThreshold) bullishFactors++;

    // Count bearish factors
    let bearishFactors = 0;
    if (!solTrendBullish) bearishFactors++;
    if (breadthPct < this.config.breadthRiskOffThreshold) bearishFactors++;
    if (followThroughPct < this.config.followThroughRiskOffThreshold) bearishFactors++;

    let regime: MarketRegime;
    let sizeMultiplier: number;

    if (bearishFactors >= 2) {
      regime = 'risk_off';
      sizeMultiplier = 0;
    } else if (bullishFactors >= 2) {
      regime = 'risk_on';
      sizeMultiplier = 1.0;
    } else {
      regime = 'neutral';
      sizeMultiplier = 0.7;
    }

    if (regime !== this.state.regime) {
      log.info(
        `Regime change: ${this.state.regime} → ${regime} ` +
        `(SOL=${solTrendBullish ? 'bull' : 'bear'} breadth=${(breadthPct * 100).toFixed(0)}% ` +
        `follow=${(followThroughPct * 100).toFixed(0)}%)`
      );
    }

    this.state.regime = regime;
    this.state.sizeMultiplier = sizeMultiplier;
    this.state.updatedAt = new Date();
  }
}

/** Calculate EMA for a series of values */
function calcEMA(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}
