/**
 * Migration Handoff Reclaim — Gate Evaluation (2026-04-17, Tier 1)
 *
 * Why: Pump.fun graduation / PumpSwap canonical pool / Raydium LaunchLab 졸업 직후
 * first overshoot가 빠진 뒤 reclaim pullback 진입을 평가한다.
 *
 * Design: docs/design-docs/migration-handoff-reclaim-2026-04-17.md
 * Parent plan: docs/exec-plans/active/1sol-to-100sol.md W1.7
 *
 * 이 모듈은 순수 평가 함수만 제공한다 (state는 migrationLaneHandler가 소유).
 */
import { Candle } from '../utils/types';
import { calcBuyRatio } from './breakoutScore';

export type MigrationEventKind = 'pumpfun_graduation' | 'launchlab_graduation' | 'pumpswap_canonical_init';

export interface MigrationEvent {
  kind: MigrationEventKind;
  pairAddress: string;
  tokenSymbol?: string;
  eventPrice: number;      // graduation 시점 기준가
  eventTimeSec: number;    // unix seconds
  signature: string;       // on-chain tx signature (idempotent key)
}

export interface MigrationGateConfig {
  cooldownSec: number;               // first overshoot 대기 (event 후 이 시간 이후에만 stalk 가능)
  maxAgeSec: number;                  // event 후 이 시간 초과 시 edge expired
  stalkMinPullbackPct: number;        // event price 대비 최소 pullback (ex 0.10 = -10%)
  stalkMaxPullbackPct: number;        // event price 대비 최대 pullback (ex 0.30 = crash)
  reclaimBuyRatioMin: number;         // reclaim candle buy ratio minimum
}

export type MigrationStage =
  | 'COOLDOWN'     // event 직후 first overshoot 대기 (< cooldownSec)
  | 'STALK'        // pullback 대기 (cooldownSec ~ cooldownSec + stalkWindowSec)
  | 'READY'        // pullback 조건 충족 + reclaim 확인 → entry trigger
  | 'REJECT_CRASH' // -stalkMaxPullbackPct 초과
  | 'REJECT_TIMEOUT' // maxAgeSec 초과
  | 'REJECT_NO_PULLBACK'; // STALK window 지나도 최소 pullback 미도달

export interface MigrationStageResult {
  stage: MigrationStage;
  reason: string;
  currentPrice: number;
  pullbackPct: number;           // (current - event) / event
  ageSec: number;
  buyRatio?: number;             // 최근 3 candle 평균 (READY 판정 시)
}

/**
 * migration event와 현재 가격/캔들을 받아 현재 stage를 판정한다.
 * 상태는 보관하지 않는다 — lane handler가 매 tick마다 호출.
 */
export function evaluateMigrationStage(
  event: MigrationEvent,
  nowSec: number,
  currentPrice: number,
  recentCandles: Candle[],
  config: MigrationGateConfig
): MigrationStageResult {
  const ageSec = nowSec - event.eventTimeSec;
  const pullbackPct = event.eventPrice > 0 ? (currentPrice - event.eventPrice) / event.eventPrice : 0;

  // REJECT: edge expired
  if (ageSec > config.maxAgeSec) {
    return {
      stage: 'REJECT_TIMEOUT',
      reason: `age ${ageSec}s > maxAge ${config.maxAgeSec}s`,
      currentPrice, pullbackPct, ageSec,
    };
  }

  // REJECT: crash past stalk max
  if (pullbackPct < -config.stalkMaxPullbackPct) {
    return {
      stage: 'REJECT_CRASH',
      reason: `pullback ${(pullbackPct * 100).toFixed(1)}% < -${(config.stalkMaxPullbackPct * 100).toFixed(1)}% (rug suspect)`,
      currentPrice, pullbackPct, ageSec,
    };
  }

  // COOLDOWN: first overshoot 대기
  if (ageSec < config.cooldownSec) {
    return {
      stage: 'COOLDOWN',
      reason: `cooldown ${ageSec}s < ${config.cooldownSec}s`,
      currentPrice, pullbackPct, ageSec,
    };
  }

  // STALK 또는 READY 판정: pullback 충족 여부 확인
  const pullbackEnoughForEntry = pullbackPct <= -config.stalkMinPullbackPct;
  if (!pullbackEnoughForEntry) {
    return {
      stage: 'STALK',
      reason: `pullback ${(pullbackPct * 100).toFixed(1)}% not yet <= -${(config.stalkMinPullbackPct * 100).toFixed(1)}%`,
      currentPrice, pullbackPct, ageSec,
    };
  }

  // Pullback 충족 — reclaim candle 확인
  // Why: 하락 중 진입이 아니라, pullback 바닥 이후 첫 상승 reclaim 에서 진입해야 함.
  const buyRatio = calcRecentBuyRatio(recentCandles, 3);
  if (buyRatio < config.reclaimBuyRatioMin) {
    return {
      stage: 'STALK',
      reason: `pullback ok (${(pullbackPct * 100).toFixed(1)}%) but buy_ratio ${buyRatio.toFixed(3)} < ${config.reclaimBuyRatioMin}`,
      currentPrice, pullbackPct, ageSec, buyRatio,
    };
  }

  return {
    stage: 'READY',
    reason: `reclaim confirmed: pullback ${(pullbackPct * 100).toFixed(1)}%, buy_ratio ${buyRatio.toFixed(3)}`,
    currentPrice, pullbackPct, ageSec, buyRatio,
  };
}

/**
 * 최근 n개 candle 의 buy volume 비율 평균 — zero-volume candle은 제외.
 * 거래 없는 캔들이 buy_ratio 0.5 (중립)로 평균을 희석시키면 reclaim 판정이 오염된다.
 */
function calcRecentBuyRatio(candles: Candle[], n: number): number {
  if (candles.length === 0) return 0;
  const recent = candles.slice(-n);
  let sum = 0;
  let count = 0;
  for (const c of recent) {
    if (c.buyVolume + c.sellVolume <= 0) continue;
    sum += calcBuyRatio(c);
    count++;
  }
  return count > 0 ? sum / count : 0;
}
