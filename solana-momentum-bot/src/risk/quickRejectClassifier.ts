/**
 * Quick Reject Classifier (DEX_TRADE Phase 3, 2026-04-18)
 *
 * Why: 현재 PROBE state 의 quick reject 는 `MAE ≤ -hardCutPct` 또는 `flat 30s timeout`.
 * DEX_TRADE.md Section 9.2: **price-only cut 금지**, time-box + microstructure classifier 로 교체.
 *
 * 정책:
 *   t <= probeWindowSec 구간 내에서,
 *   아래 microstructure 지표가 **degrade** 하면 (가격 flat 이어도) early exit 또는 reduce
 *
 * 입력 지표 (candle-based, 추가 RPC 없음):
 *   - net_MFE_first_window (entry 이후 MFE 최대값)
 *   - buy_ratio_decay (entry 시점 vs recent buy ratio 변화)
 *   - tx_density_drop (entry 시점 vs recent tradeCount 변화)
 *
 * 반환: action = 'hold' | 'reduce' | 'exit' + reason
 */
import type { Candle } from '../utils/types';

export interface QuickRejectInputs {
  /** entry 이후 시점 (seconds). 창 밖이면 classifier 는 no-op */
  elapsedSec: number;
  /** entry 기준 peak MFE (percentage, 0.01 = 1%) */
  mfePct: number;
  /** entry 시점 candle 의 buy ratio (0-1) */
  buyRatioAtEntry: number;
  /** entry 시점 candle 의 tradeCount */
  txCountAtEntry: number;
  /** entry 이후 관측된 최근 candles (1-N) */
  recentCandles: Candle[];
}

export interface QuickRejectConfig {
  /** 활성화 여부. false 면 항상 hold */
  enabled: boolean;
  /** classifier 가 작동하는 max elapsed (default 45s). 그 이후는 외부 trail/hard cut 에 위임 */
  windowSec: number;
  /** min MFE (%) — 이 값 미만이면 weak probe. default 0.5 (=0.005) */
  minMfePct: number;
  /** buy ratio decay 임계 — entry 기준 이 값 이상 떨어지면 degrade. default 0.15 */
  buyRatioDecayThreshold: number;
  /** tx density drop 임계 — 1 - recent/entry 이 값 이상이면 degrade. default 0.5 (50%) */
  txDensityDropThreshold: number;
  /** 이 값 이상의 degrade factor count 쌓이면 exit (2개 이상 권장). default 2 */
  degradeCountForExit: number;
}

export const DEFAULT_QUICK_REJECT_CONFIG: QuickRejectConfig = {
  enabled: true,
  windowSec: 45,
  minMfePct: 0.005,
  buyRatioDecayThreshold: 0.15,
  txDensityDropThreshold: 0.5,
  degradeCountForExit: 2,
};

export type QuickRejectAction = 'hold' | 'reduce' | 'exit';

export interface QuickRejectResult {
  action: QuickRejectAction;
  degradeFactors: string[];
  mfeOk: boolean;
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

export function evaluateQuickReject(
  inputs: QuickRejectInputs,
  config: QuickRejectConfig = DEFAULT_QUICK_REJECT_CONFIG
): QuickRejectResult {
  if (!config.enabled || inputs.elapsedSec > config.windowSec) {
    return { action: 'hold', degradeFactors: [], mfeOk: inputs.mfePct >= config.minMfePct };
  }

  const degradeFactors: string[] = [];

  // 1. MFE weakness — 최소 MFE 도 못 찍음
  const mfeOk = inputs.mfePct >= config.minMfePct;
  if (!mfeOk) {
    degradeFactors.push('weak_mfe');
  }

  // 2. buy ratio decay
  const recentBuyRatio = meanBuyRatio(inputs.recentCandles);
  const buyRatioDecay = inputs.buyRatioAtEntry - recentBuyRatio;
  if (buyRatioDecay >= config.buyRatioDecayThreshold) {
    degradeFactors.push('buy_ratio_decay');
  }

  // 3. tx density drop
  const recentTx = meanTxCount(inputs.recentCandles);
  const txDrop = inputs.txCountAtEntry > 0
    ? 1 - recentTx / inputs.txCountAtEntry
    : 0;
  if (txDrop >= config.txDensityDropThreshold) {
    degradeFactors.push('tx_density_drop');
  }

  // Action decision
  // QA fix (F10, 2026-04-18): weak_mfe 는 degrade factor 로 카운트하지 않음.
  // 이유: 초반 30초 내 MFE < 0.5% 는 healthy pair 에서도 흔함 (가격 움직임 충분한 시간 없음).
  // weak_mfe 를 카운트하면 "weak_mfe + 1 microstructure" → 2 factors → exit 이 되어 과도 rejection.
  // 수정: exit 는 **순수 microstructure factors** (buy_ratio_decay + tx_density_drop) 기준으로만 판정.
  // weak_mfe 는 'reduce' signal 로만 사용 (microstructure 1 개 + weak MFE → reduce).
  const microFactors = degradeFactors.filter((f) => f !== 'weak_mfe');
  let action: QuickRejectAction = 'hold';
  if (microFactors.length >= config.degradeCountForExit) {
    action = 'exit';
  } else if (!mfeOk && microFactors.length >= 1) {
    action = 'reduce';
  }

  return { action, degradeFactors, mfeOk };
}
