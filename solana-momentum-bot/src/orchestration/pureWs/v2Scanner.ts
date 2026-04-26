// 2026-04-18 DEX_TRADE Phase 1.3: V2 Independent Detector Scanner.
//
// Why: v1 은 bootstrap signal 을 그대로 소비해서 candle-close 이벤트에 의존했다. V2 는
// `evaluateWsBurst` 로 **독립적 burst 판정** → bootstrap 과 무관한 trigger 경로.
//
// 호출 지점: index.ts 의 candle close listener 또는 tick monitor 에서 watchlist pair 를 전달.
//
// 동작:
//   1) config.pureWsV2Enabled 확인 (disabled 면 no-op)
//   2) per-pair cooldown 체크 (default 5분)
//   3) evaluateWsBurst 호출
//   4) pass 면 synthetic Signal 생성 + handlePureWsSignal 로 일반 entry path 재사용
//      (sourceLabel='ws_burst_v2' 로 v1 gate bypass)

import { config } from '../../utils/config';
import type { MicroCandleBuilder } from '../../realtime';
import { Signal } from '../../utils/types';
import { evaluateWsBurst } from '../../strategy/wsBurstDetector';
import { isEntryHaltActive } from '../entryIntegrity';
import type { BotContext } from '../types';
import { LANE_STRATEGY, log } from './constants';
import { activePositions } from './positionState';
import { v2LastTriggerSecByPair } from './cooldowns';
import { v2Telemetry } from './v2Telemetry';
import { buildV2DetectorConfig } from './v2DetectorConfig';
import { handlePureWsSignal } from './entryFlow';

export async function scanPureWsV2Burst(
  ctx: BotContext,
  candleBuilder: MicroCandleBuilder,
  pairAddresses: Iterable<string>,
  tokenSymbolByPair?: Map<string, string | undefined>
): Promise<void> {
  if (!config.pureWsLaneEnabled) return;
  if (!config.pureWsV2Enabled) return;
  // 2026-04-20 P2 fix: lane halt 활성화 상태면 scan 자체를 skip.
  // Why: 기존 동작은 v2 evaluateWsBurst + PUREWS_V2_PASS 로그를 매번 찍은 뒤 handler 에서
  // `PUREWS_ENTRY_HALT` 로 return → position 안 만들어짐 → cooldown 설정 안 됨 →
  // 다음 scan 에서 다시 pass → 무한 loop (4/20 관측 GEr3mp 567 반복 pass).
  if (isEntryHaltActive(LANE_STRATEGY)) {
    v2Telemetry.haltSkipped++;
    return;
  }

  v2Telemetry.scansCalled++;
  const detectorCfg = buildV2DetectorConfig();
  const requiredCandles = detectorCfg.nRecent + detectorCfg.nBaseline;
  const nowSec = Math.floor(Date.now() / 1000);
  const cooldownSec = config.pureWsV2PerPairCooldownSec;

  for (const pair of pairAddresses) {
    // per-pair cooldown (Top pair 쏠림 방어 — paper replay 에서 pippin 58% 점유 관측)
    const lastTriggerSec = v2LastTriggerSecByPair.get(pair) ?? 0;
    if (nowSec - lastTriggerSec < cooldownSec) {
      v2Telemetry.cooldownSkipped++;
      continue;
    }

    v2Telemetry.pairsEvaluated++;

    const candles = candleBuilder.getRecentCandles(
      pair,
      config.realtimePrimaryIntervalSec,
      requiredCandles
    );
    if (candles.length < requiredCandles) {
      v2Telemetry.candlesInsufficient++;
      continue;
    }

    const result = evaluateWsBurst(candles, detectorCfg);
    if (!result.pass) {
      const reasonKey = result.rejectReason ?? 'unknown';
      v2Telemetry.detectorRejects[reasonKey] = (v2Telemetry.detectorRejects[reasonKey] ?? 0) + 1;
      log.debug(
        `[PUREWS_V2_REJECT] ${pair.slice(0, 12)} reason=${reasonKey} score=${result.score}`
      );
      continue;
    }

    const currentPrice = candleBuilder.getCurrentPrice(pair);
    if (currentPrice == null || currentPrice <= 0) {
      v2Telemetry.noCurrentPrice++;
      continue;
    }

    v2Telemetry.passed++;
    log.info(
      `[PUREWS_V2_PASS] ${pair.slice(0, 12)} score=${result.score} ` +
      `vol=${result.factors.volumeAccelZ.toFixed(2)} buy=${result.factors.buyPressureZ.toFixed(2)} ` +
      `tx=${result.factors.txDensityZ.toFixed(2)} price=${result.factors.priceAccel.toFixed(2)} ` +
      `bps=${result.factors.rawPriceChangeBps.toFixed(1)}`
    );

    // QA fix (F8, 2026-04-18): cooldown 을 handler 성공 이후에만 설정.
    // 이전 구현 bug: handler 가 viability / paper-first / acquire 에서 reject 해도 cooldown 활성 → 5min lockout.
    // 수정: activePositions 크기로 성공 판정. 실패한 scan 은 다음 candle 에서 재시도 가능.
    const activeCountBefore = activePositions.size;

    // Synthesize Signal + reuse existing handler (security / concurrency / persist / PROBE 전부 재사용)
    const syntheticSignal: Signal = {
      action: 'BUY',
      strategy: LANE_STRATEGY,
      pairAddress: pair,
      tokenSymbol: tokenSymbolByPair?.get(pair),
      price: currentPrice,
      timestamp: new Date(nowSec * 1000),
      meta: {
        burstScore: result.score,
        volumeAccelZ: result.factors.volumeAccelZ,
        buyPressureZ: result.factors.buyPressureZ,
        txDensityZ: result.factors.txDensityZ,
        priceAccel: result.factors.priceAccel,
        rawBuyRatio: result.factors.rawBuyRatioRecent,
        rawTxCount: result.factors.rawTxCountRecent,
        rawPriceChangeBps: result.factors.rawPriceChangeBps,
      },
      sourceLabel: 'ws_burst_v2',
      discoverySource: 'pure_ws_v2',
    };
    await handlePureWsSignal(syntheticSignal, candleBuilder, ctx);

    // QA fix (F8): cooldown 은 실제로 position 이 생겼을 때만 설정.
    // handler 가 viability/paper-first/concurrency 로 reject 하면 cooldown 안 함 → 다음 candle 에서 재시도.
    if (activePositions.size > activeCountBefore) {
      v2LastTriggerSecByPair.set(pair, nowSec);
    }
  }
}
