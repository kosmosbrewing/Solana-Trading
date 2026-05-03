/**
 * WS Burst Detector (Phase 1.1 of DEX_TRADE.md roadmap, 2026-04-18)
 *
 * Why: pure_ws_breakout v1 은 bootstrap_10s signal 재사용. v2 는 **independent detector** 로
 * burst_score = weighted sum of normalized factors (volume accel / buy pressure / tx density /
 * price acceleration / reverse quote stability).
 *
 * 설계 근거: `docs/design-docs/pure-ws-breakout-v2-detector-2026-04-18.md`
 *
 * 순수 함수. DB / API / 부작용 없음. backtest / production 동일 로직.
 * Phase 1.1 scope: detector 만 구현. handler 와의 integration (flag 분기) 은 Phase 1.3.
 */
import { Candle } from '../utils/types';

// ─── Config ───

export interface WsBurstDetectorConfig {
  /** detector 전체 on/off. false 면 evaluate 호출해도 pass=false 로 early-return */
  enabled: boolean;

  /** 최근 window 크기 (candle 개수). 10s candle 기본 3 → 30초 */
  nRecent: number;
  /** baseline window 크기 (candle 개수). 10s candle 기본 12 → 120초 */
  nBaseline: number;

  /** weighted score 통과 기준 (0-100). default 60 */
  minPassScore: number;

  /** weight (합계 100 권장) */
  wVolume: number;
  wBuy: number;
  wDensity: number;
  wPrice: number;
  wReverse: number;

  /** 각 factor [0,1] 정규화 후 floor */
  floorVol: number;      // volume accel z 최소
  floorBuy: number;      // buy pressure z 최소
  floorTx: number;       // tx density z 최소
  floorPrice: number;    // price accel 최소

  /** buy_pressure 의 dual floor — 절대 buy ratio 최소 */
  buyRatioAbsoluteFloor: number;
  /** tx density 의 절대 tx count 최소 (recent window 평균) */
  txCountAbsoluteFloor: number;

  /** z-score saturation 상한 */
  zVolSaturate: number;
  zBuySaturate: number;
  zTxSaturate: number;
  bpsPriceSaturate: number;
}

export const DEFAULT_WS_BURST_CONFIG: WsBurstDetectorConfig = {
  enabled: true,
  nRecent: 3,
  nBaseline: 12,
  minPassScore: 60,
  wVolume: 30,
  wBuy: 25,
  wDensity: 20,
  wPrice: 20,
  wReverse: 5,
  floorVol: 0.33,
  floorBuy: 0.25,
  floorTx: 0.33,
  floorPrice: 0.1,
  buyRatioAbsoluteFloor: 0.55,
  txCountAbsoluteFloor: 3,
  zVolSaturate: 3.0,
  zBuySaturate: 2.0,
  zTxSaturate: 3.0,
  bpsPriceSaturate: 300,
};

// ─── Result ───

export interface WsBurstFactors {
  volumeAccelZ: number;      // normalized [0, 1]
  buyPressureZ: number;      // normalized [0, 1]
  txDensityZ: number;        // normalized [0, 1]
  priceAccel: number;        // normalized [0, 1]
  reverseQuoteStability: number; // [0, 1] — Phase 1 placeholder = 1.0

  // raw values for 분석 / 로깅
  rawVolumeZ: number;
  rawBuyZ: number;
  rawBuyRatioRecent: number;
  rawTxRobustZ: number;
  rawTxCountRecent: number;
  rawPriceChangeBps: number;
}

export type WsBurstRejectReason =
  | 'disabled'
  | 'insufficient_samples'
  | 'vol_floor'
  | 'buy_floor_ratio'
  | 'buy_floor_z'
  | 'tx_floor_count'
  | 'tx_floor_z'
  | 'price_floor'
  | 'score_below_threshold';

export interface WsBurstResult {
  pass: boolean;
  score: number;                  // 0-100
  factors: WsBurstFactors;
  rejectReason?: WsBurstRejectReason;
}

// ─── Helpers ───

const EPS = 1e-9;

function clip(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const sq = xs.reduce((acc, x) => acc + (x - m) * (x - m), 0);
  return Math.sqrt(sq / xs.length);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mad(xs: number[], centerValue: number): number {
  if (xs.length === 0) return 0;
  const deviations = xs.map((x) => Math.abs(x - centerValue));
  return median(deviations);
}

function buyRatio(c: Candle): number {
  const total = c.buyVolume + c.sellVolume;
  return total > 0 ? c.buyVolume / total : 0.5;
}

// ─── Factor Computations ───

function computeVolumeAccelZ(
  recent: Candle[],
  baseline: Candle[],
  cfg: WsBurstDetectorConfig
): { raw: number; normalized: number } {
  const recentAvg = mean(recent.map((c) => c.volume));
  const baselineVols = baseline.map((c) => c.volume);
  const baselineAvg = mean(baselineVols);
  const baselineStd = stddev(baselineVols);

  if (baselineAvg === 0) {
    const recentTxCount = mean(recent.map((c) => c.tradeCount));
    if (recentAvg > 0 && recentTxCount >= cfg.txCountAbsoluteFloor) {
      // 신규 pair cold-start: baseline 이 0인 것은 "신호 없음"이 아니라 "이전 거래 없음"이다.
      // 절대 recent tx floor 를 만족할 때만 volume factor 를 포화시켜 new-pair 관측 누락을 줄인다.
      return { raw: cfg.zVolSaturate, normalized: 1 };
    }
    return { raw: 0, normalized: 0 };
  }
  const z = (recentAvg - baselineAvg) / Math.max(baselineStd, EPS);
  return { raw: z, normalized: clip(z / cfg.zVolSaturate, 0, 1) };
}

function computeBuyPressureZ(
  recent: Candle[],
  baseline: Candle[],
  cfg: WsBurstDetectorConfig
): { raw: number; normalized: number; recentRatio: number } {
  const recentRatios = recent.map(buyRatio);
  const baselineRatios = baseline.map(buyRatio);
  const recentAvg = mean(recentRatios);
  const baselineAvg = mean(baselineRatios);
  // min std 0.05 — 극도로 flat 한 pair 방어
  const baselineStd = Math.max(stddev(baselineRatios), 0.05);
  const z = (recentAvg - baselineAvg) / baselineStd;
  return {
    raw: z,
    normalized: clip(z / cfg.zBuySaturate, 0, 1),
    recentRatio: recentAvg,
  };
}

function computeTxDensityZ(
  recent: Candle[],
  baseline: Candle[],
  cfg: WsBurstDetectorConfig
): { raw: number; normalized: number; recentCount: number } {
  const recentCount = mean(recent.map((c) => c.tradeCount));
  const baselineCounts = baseline.map((c) => c.tradeCount);
  const baselineMedian = median(baselineCounts);
  const baselineMad = mad(baselineCounts, baselineMedian);
  // MAD → std 변환 상수 1.4826, 하한 1 (0 tradeCount baseline 방어)
  const robustStd = Math.max(1.4826 * baselineMad, 1);
  const z = (recentCount - baselineMedian) / robustStd;
  return {
    raw: z,
    normalized: clip(z / cfg.zTxSaturate, 0, 1),
    recentCount,
  };
}

function computePriceAccel(
  recent: Candle[],
  cfg: WsBurstDetectorConfig
): { raw: number; normalized: number } {
  if (recent.length === 0) return { raw: 0, normalized: 0 };
  const oldestOpen = recent[0].open;
  const latestClose = recent[recent.length - 1].close;
  if (oldestOpen <= 0) return { raw: 0, normalized: 0 };
  const bps = ((latestClose - oldestOpen) / oldestOpen) * 10_000;
  return { raw: bps, normalized: clip(bps / cfg.bpsPriceSaturate, 0, 1) };
}

// Phase 1 placeholder — Phase 2 viability floor 에서 실 구현으로 교체.
function computeReverseQuoteStability(): number {
  return 1.0;
}

// ─── Main Evaluator ───

export function evaluateWsBurst(
  candles: Candle[],
  config: WsBurstDetectorConfig = DEFAULT_WS_BURST_CONFIG
): WsBurstResult {
  // 0. disabled → early
  if (!config.enabled) {
    return { pass: false, score: 0, factors: emptyFactors(), rejectReason: 'disabled' };
  }

  // 1. 샘플 충분성
  const required = config.nRecent + config.nBaseline;
  if (candles.length < required) {
    return {
      pass: false,
      score: 0,
      factors: emptyFactors(),
      rejectReason: 'insufficient_samples',
    };
  }

  // 2. Split recent / baseline (가장 최근이 recent, 그 앞이 baseline)
  const tail = candles.slice(-required);
  const baseline = tail.slice(0, config.nBaseline);
  const recent = tail.slice(config.nBaseline);

  // 3. Factor 계산
  const volumeR = computeVolumeAccelZ(recent, baseline, config);
  const buyR = computeBuyPressureZ(recent, baseline, config);
  const txR = computeTxDensityZ(recent, baseline, config);
  const priceR = computePriceAccel(recent, config);
  const reverseStability = computeReverseQuoteStability();

  const factors: WsBurstFactors = {
    volumeAccelZ: volumeR.normalized,
    buyPressureZ: buyR.normalized,
    txDensityZ: txR.normalized,
    priceAccel: priceR.normalized,
    reverseQuoteStability: reverseStability,
    rawVolumeZ: volumeR.raw,
    rawBuyZ: buyR.raw,
    rawBuyRatioRecent: buyR.recentRatio,
    rawTxRobustZ: txR.raw,
    rawTxCountRecent: txR.recentCount,
    rawPriceChangeBps: priceR.raw,
  };

  // 4. Weighted score (floor check 전에 계산해서 reject 시에도 score 가 참고치로 남도록)
  const score = Math.min(
    Math.round(
      config.wVolume * factors.volumeAccelZ +
      config.wBuy * factors.buyPressureZ +
      config.wDensity * factors.txDensityZ +
      config.wPrice * factors.priceAccel +
      config.wReverse * factors.reverseQuoteStability
    ),
    100
  );

  // 5. Hard floor checks (reject reason 우선순위: vol → buy → tx → price)
  if (factors.volumeAccelZ < config.floorVol) {
    return { pass: false, score, factors, rejectReason: 'vol_floor' };
  }
  if (factors.rawBuyRatioRecent < config.buyRatioAbsoluteFloor) {
    return { pass: false, score, factors, rejectReason: 'buy_floor_ratio' };
  }
  if (factors.buyPressureZ < config.floorBuy) {
    return { pass: false, score, factors, rejectReason: 'buy_floor_z' };
  }
  if (factors.rawTxCountRecent < config.txCountAbsoluteFloor) {
    return { pass: false, score, factors, rejectReason: 'tx_floor_count' };
  }
  if (factors.txDensityZ < config.floorTx) {
    return { pass: false, score, factors, rejectReason: 'tx_floor_z' };
  }
  if (factors.priceAccel < config.floorPrice) {
    return { pass: false, score, factors, rejectReason: 'price_floor' };
  }

  // 6. Threshold
  if (score < config.minPassScore) {
    return { pass: false, score, factors, rejectReason: 'score_below_threshold' };
  }

  return { pass: true, score, factors };
}

// ─── Utility ───

function emptyFactors(): WsBurstFactors {
  return {
    volumeAccelZ: 0,
    buyPressureZ: 0,
    txDensityZ: 0,
    priceAccel: 0,
    reverseQuoteStability: 0,
    rawVolumeZ: 0,
    rawBuyZ: 0,
    rawBuyRatioRecent: 0,
    rawTxRobustZ: 0,
    rawTxCountRecent: 0,
    rawPriceChangeBps: 0,
  };
}
