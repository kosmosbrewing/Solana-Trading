/**
 * Hold-Phase Exitability Sentinel (DEX_TRADE Phase 3, 2026-04-18)
 *
 * Why: winner hold 중 entry 전 가드만으로 부족. DEX_TRADE.md Section 9.3.
 * RUNNER tier 에서 exit 환경이 악화되면 (sell impact drift / buy pressure collapse / tx decay)
 * **degraded exit** 로 전환하여 가능한 한 손실 방어.
 *
 * 입력 지표 (candle-based, 추가 RPC 없음 — 실 reverse quote 는 Phase 4 후보):
 *   - buy_pressure_collapse (최근 buy ratio 의 sustained drop)
 *   - tx_density_drop (최근 trade count 의 sustained drop)
 *   - peak_drift (HWM 대비 현재가의 큰 pullback)
 *
 * 반환: status = 'ok' | 'warn' | 'degraded' + reasons
 * degraded → handler 에서 degraded_exit trigger
 */
import type { Candle } from '../utils/types';

export interface HoldPhaseSentinelInputs {
  /** entry 시점 buy ratio (hold 시작점) */
  buyRatioAtEntry: number;
  /** entry 시점 tradeCount (hold 시작점) */
  txCountAtEntry: number;
  /** peak price (HWM) */
  peakPrice: number;
  /** current price */
  currentPrice: number;
  /** 최근 관측 candles (hold 중) */
  recentCandles: Candle[];
}

export interface HoldPhaseSentinelConfig {
  enabled: boolean;
  /** buy ratio 가 entry 대비 이 이상 떨어지면 warn. default 0.2 */
  buyRatioCollapseThreshold: number;
  /** tx count 가 entry 대비 이 비율 이하 (drop %) 이면 warn. default 0.6 (60% drop) */
  txDensityDropThreshold: number;
  /** peak 대비 현재가 pullback % 이 이상이면 warn. default 0.35 (35% off peak) */
  peakDriftThreshold: number;
  /** degraded 판정 threshold — warn factor count 몇 개부터 degraded 로 볼지. default 2 */
  degradedFactorCount: number;
}

export const DEFAULT_HOLD_PHASE_SENTINEL_CONFIG: HoldPhaseSentinelConfig = {
  enabled: true,
  buyRatioCollapseThreshold: 0.2,
  txDensityDropThreshold: 0.6,
  peakDriftThreshold: 0.35,
  degradedFactorCount: 2,
};

export type HoldPhaseStatus = 'ok' | 'warn' | 'degraded';

export interface HoldPhaseSentinelResult {
  status: HoldPhaseStatus;
  warnFactors: string[];
  peakDriftPct: number;
  recentBuyRatio: number;
  recentTxCount: number;
}

function meanBuyRatio(candles: Candle[]): number {
  if (candles.length === 0) return 0.5;
  let sum = 0;
  let n = 0;
  for (const c of candles) {
    const total = c.buyVolume + c.sellVolume;
    if (total > 0) {
      sum += c.buyVolume / total;
      n++;
    }
  }
  return n > 0 ? sum / n : 0.5;
}

function meanTxCount(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  return candles.reduce((a, c) => a + c.tradeCount, 0) / candles.length;
}

export function evaluateHoldPhaseSentinel(
  inputs: HoldPhaseSentinelInputs,
  config: HoldPhaseSentinelConfig = DEFAULT_HOLD_PHASE_SENTINEL_CONFIG
): HoldPhaseSentinelResult {
  const recentBuyRatio = meanBuyRatio(inputs.recentCandles);
  const recentTxCount = meanTxCount(inputs.recentCandles);
  const peakDriftPct = inputs.peakPrice > 0
    ? (inputs.peakPrice - inputs.currentPrice) / inputs.peakPrice
    : 0;

  if (!config.enabled) {
    return {
      status: 'ok',
      warnFactors: [],
      peakDriftPct,
      recentBuyRatio,
      recentTxCount,
    };
  }

  const warnFactors: string[] = [];

  // 1. buy pressure collapse
  const buyRatioDrop = inputs.buyRatioAtEntry - recentBuyRatio;
  if (buyRatioDrop >= config.buyRatioCollapseThreshold) {
    warnFactors.push('buy_pressure_collapse');
  }

  // 2. tx density drop (% drop from entry)
  const txDrop = inputs.txCountAtEntry > 0
    ? 1 - recentTxCount / inputs.txCountAtEntry
    : 0;
  if (txDrop >= config.txDensityDropThreshold) {
    warnFactors.push('tx_density_drop');
  }

  // 3. peak drift
  if (peakDriftPct >= config.peakDriftThreshold) {
    warnFactors.push('peak_drift');
  }

  let status: HoldPhaseStatus = 'ok';
  if (warnFactors.length >= config.degradedFactorCount) {
    status = 'degraded';
  } else if (warnFactors.length > 0) {
    status = 'warn';
  }

  return {
    status,
    warnFactors,
    peakDriftPct,
    recentBuyRatio,
    recentTxCount,
  };
}
