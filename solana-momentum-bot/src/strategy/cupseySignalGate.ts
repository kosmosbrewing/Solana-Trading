/**
 * Cupsey Signal Quality Gate — multi-bar momentum 사전 검증
 *
 * Why: bootstrap trigger 가 volume spike peak 에서 발화 → 단일-bar flush signal 이 대부분.
 * 좋은 signal = 수 바 동안 지속된 volume + 상승 가격. 나쁜 signal = 단일 바 flush.
 * 4개 factor (volume accel, price momentum, buy ratio, trade count) 으로 사전 검증.
 *
 * 순수 함수. DB/API 의존 없음. 백테스트/production 동일 로직.
 */

import { Candle } from '../utils/types';

// ─── Config ───

export interface CupseySignalGateConfig {
  enabled: boolean;
  minVolumeAccelRatio: number;   // recent avg vol / baseline avg vol
  minPriceChangePct: number;     // price change over recent bars
  minAvgBuyRatio: number;        // recent avg buy ratio
  minTradeCountRatio: number;    // recent avg trades / baseline avg trades
  lookbackBars: number;          // baseline window size
  recentBars: number;            // recent momentum window size
}

// ─── Result ───

export interface CupseySignalGateResult {
  pass: boolean;
  rejectReason?: string;
  score: number;                 // 0-100 weighted score
  factors: {
    volumeAccelRatio: number;
    priceChangePct: number;
    avgBuyRatio: number;
    tradeCountRatio: number;
  };
}

// ─── Factor Weights ───

const WEIGHT_VOLUME = 30;
const WEIGHT_PRICE = 25;
const WEIGHT_BUY_RATIO = 25;
const WEIGHT_TRADES = 20;

// ─── Main Evaluator ───

export function evaluateCupseySignalGate(
  recentCandles: Candle[],
  config: CupseySignalGateConfig
): CupseySignalGateResult {
  const { lookbackBars, recentBars } = config;
  const minRequired = recentBars + 3; // baseline 최소 3 bars

  // Why: 캔들 부족 시 gate 통과 (데이터 부족으로 reject 하면 signal 유실)
  if (recentCandles.length < minRequired) {
    return {
      pass: true,
      score: 50,
      factors: { volumeAccelRatio: 1, priceChangePct: 0, avgBuyRatio: 0.5, tradeCountRatio: 1 },
    };
  }

  // Split: recent (마지막 N bars) vs baseline (그 앞 bars)
  const tail = recentCandles.slice(-lookbackBars);
  const recent = tail.slice(-recentBars);
  const baseline = tail.slice(0, -recentBars);

  if (baseline.length === 0) {
    return {
      pass: true,
      score: 50,
      factors: { volumeAccelRatio: 1, priceChangePct: 0, avgBuyRatio: 0.5, tradeCountRatio: 1 },
    };
  }

  // ─── Factor 1: Volume Acceleration ───
  const recentAvgVol = avg(recent.map(c => c.volume));
  const baselineAvgVol = avg(baseline.map(c => c.volume));
  const volumeAccelRatio = baselineAvgVol > 0 ? recentAvgVol / baselineAvgVol : 0;

  // ─── Factor 2: Price Momentum ───
  const oldestRecentOpen = recent[0].open;
  const latestClose = recent[recent.length - 1].close;
  const priceChangePct = oldestRecentOpen > 0
    ? (latestClose - oldestRecentOpen) / oldestRecentOpen
    : 0;

  // ─── Factor 3: Buy Ratio Consistency ───
  const avgBuyRatio = avg(recent.map(c => {
    const total = c.buyVolume + c.sellVolume;
    return total > 0 ? c.buyVolume / total : 0.5;
  }));

  // ─── Factor 4: Trade Count Density ───
  const recentAvgTrades = avg(recent.map(c => c.tradeCount));
  const baselineAvgTrades = avg(baseline.map(c => c.tradeCount));
  const tradeCountRatio = baselineAvgTrades > 0 ? recentAvgTrades / baselineAvgTrades : 0;

  const factors = { volumeAccelRatio, priceChangePct, avgBuyRatio, tradeCountRatio };

  // ─── Threshold Check (any factor below = hard reject) ───
  if (volumeAccelRatio < config.minVolumeAccelRatio) {
    return { pass: false, rejectReason: `vol_accel=${volumeAccelRatio.toFixed(2)}<${config.minVolumeAccelRatio}`, score: 0, factors };
  }
  if (priceChangePct < config.minPriceChangePct) {
    return { pass: false, rejectReason: `price_chg=${(priceChangePct * 100).toFixed(3)}%<${(config.minPriceChangePct * 100).toFixed(3)}%`, score: 0, factors };
  }
  if (avgBuyRatio < config.minAvgBuyRatio) {
    return { pass: false, rejectReason: `buy_ratio=${avgBuyRatio.toFixed(3)}<${config.minAvgBuyRatio}`, score: 0, factors };
  }
  if (tradeCountRatio < config.minTradeCountRatio) {
    return { pass: false, rejectReason: `trade_count=${tradeCountRatio.toFixed(2)}<${config.minTradeCountRatio}`, score: 0, factors };
  }

  // ─── Score (weighted sum, capped at 100) ───
  const volScore = Math.min(volumeAccelRatio / config.minVolumeAccelRatio, 2) * WEIGHT_VOLUME;
  const priceScore = Math.min(priceChangePct / config.minPriceChangePct, 2) * WEIGHT_PRICE;
  const buyScore = Math.min(avgBuyRatio / config.minAvgBuyRatio, 2) * WEIGHT_BUY_RATIO;
  const tradeScore = Math.min(tradeCountRatio / config.minTradeCountRatio, 2) * WEIGHT_TRADES;
  const score = Math.min(Math.round(volScore + priceScore + buyScore + tradeScore), 100);

  return { pass: true, score, factors };
}

// ─── Helper ───

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
