// 2026-04-22 P0+P2: Missed Alpha Observer 호출 helper.
// reject site 여러 곳에서 같은 config 를 조립. 한 곳으로 모아서 호출 부담 최소화.
// observer 자체가 fire-and-forget — 이 helper 도 sync, ticket/signal path 에 무영향.
//
// trackPureWsClose: close-site observer hook (P2-1b). Phase 3 miss 가설 (cut 이후 가격 상승) 측정.

import path from 'path';
import { config } from '../../utils/config';
import {
  trackRejectForMissedAlpha,
  type MissedAlphaEvent,
  type MissedAlphaObserverConfig,
} from '../../observability/missedAlphaObserver';
import { LANE_STRATEGY } from './constants';
import type { PureWsPosition } from './types';

export function buildMissedAlphaConfig(): Partial<MissedAlphaObserverConfig> {
  return {
    enabled: config.missedAlphaObserverEnabled,
    offsetsSec: config.missedAlphaObserverOffsetsSec,
    jitterPct: config.missedAlphaObserverJitterPct,
    maxInflight: config.missedAlphaObserverMaxInflight,
    dedupWindowSec: config.missedAlphaObserverDedupWindowSec,
    outputFile: path.join(config.realtimeDataDir, 'missed-alpha.jsonl'),
    jupiterApiUrl: config.jupiterApiUrl,
    jupiterApiKey: config.jupiterApiKey,
  };
}

export function trackPureWsReject(partial: Omit<MissedAlphaEvent, 'lane'>): void {
  trackRejectForMissedAlpha({ ...partial, lane: LANE_STRATEGY }, buildMissedAlphaConfig());
}

/**
 * Close-site observer hook. signalPrice 는 pos.marketReferencePrice (entry 시점 시장 기준).
 * observer 가 probe 시점 Jupiter price 와 비교 → deltaPct > 0 이면 "cut 이후 price 상승 = 미실현 winner miss".
 */
export function trackPureWsClose(
  pos: PureWsPosition,
  category: MissedAlphaEvent['rejectCategory'],
  closeReason: string,
  nowSec: number,
  mfePct: number,
  maePct: number,
  exitPrice: number
): void {
  // 2026-04-26: shadow arm (paper-only) 은 close 시 missedAlpha 발사 금지.
  // 이유: KMnDBXcP 같은 wash-trade pair 가 shadow close 마다 Jupiter T+60/300/1800s quote 를
  // fire → API 부담 + 측정 noise (post-close trajectory 는 primary close 분석으로 충분).
  // shadow 의 결과는 pure-ws-paper-trades.jsonl 로 분리 측정.
  if (pos.isShadowArm === true) return;
  trackRejectForMissedAlpha(
    {
      rejectCategory: category,
      rejectReason: closeReason,
      tokenMint: pos.pairAddress,
      lane: LANE_STRATEGY,
      signalPrice: pos.marketReferencePrice,
      probeSolAmount: config.pureWsLaneTicketSol,
      signalSource: pos.sourceLabel,
      extras: {
        closeState: pos.state,
        elapsedSecAtClose: nowSec - pos.entryTimeSec,
        mfePctAtClose: mfePct,
        maePctAtClose: maePct,
        entryPrice: pos.entryPrice,
        exitPrice,
        peakPrice: pos.peakPrice,
        troughPrice: pos.troughPrice,
        // 2026-04-22 P2-4: tier visit timestamps — observer 가 "T2 방문했다가 cut 된 position"
        // 의 post-close trajectory 를 구분 분석할 수 있게 한다.
        t1VisitAtSec: pos.t1VisitAtSec ?? null,
        t2VisitAtSec: pos.t2VisitAtSec ?? null,
        t3VisitAtSec: pos.t3VisitAtSec ?? null,
      },
    },
    buildMissedAlphaConfig()
  );
}
