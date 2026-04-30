/**
 * KOL Hunter post-close observer hook (2026-04-30, Sprint 1.A4).
 *
 * Why: pure_ws lane 의 trackPureWsClose (P2-1b, missedAlpha.ts:38) 패턴을 KOL lane 에 이식.
 *      현재 KOL lane 은 reject-side (fireRejectObserver, 16 사이트) 만 markout 측정 중 —
 *      close-side post-trajectory 데이터 없음. winner-kill rate 산출 인프라.
 *
 * 기록 위치: data/realtime/missed-alpha.jsonl (pure_ws 와 공용 jsonl, lane 필드로 구분)
 * 발화 정책:
 *   - shadow arm (paper-only A/B) 은 fire 금지 → noise 차단 (pure_ws 패턴 정합)
 *   - live + main paper 만 fire (KOL paper 도 close trajectory 측정 가치 있음)
 *   - rate-limit: missedAlphaObserver 의 maxInflight=50 cap + dedup 30s 가 자체 보호
 */
import path from 'path';
import { config } from '../utils/config';
import {
  trackRejectForMissedAlpha,
  type MissedAlphaObserverConfig,
  type RejectCategory,
} from '../observability/missedAlphaObserver';

const KOL_LANE_STRATEGY = 'kol_hunter';

/** Close reason → MissedAlpha RejectCategory 매핑. 기존 enum 재사용으로 분석 정합성 유지. */
function closeReasonToCategory(reason: string): RejectCategory {
  switch (reason) {
    case 'probe_hard_cut': return 'probe_hard_cut';
    case 'probe_flat_cut': return 'probe_flat_cut';
    case 'probe_reject_timeout': return 'probe_reject_timeout';
    case 'quick_reject_classifier_exit': return 'quick_reject_classifier_exit';
    case 'hold_phase_sentinel_degraded_exit': return 'hold_phase_sentinel_degraded_exit';
    // 2026-04-30 (Sprint 2.A1): structural_kill_sell_route — 새 close reason.
    //   기존 enum 에 없으니 'sell_quote_probe' 로 매핑 (sellability 기준 동일 cohort).
    case 'structural_kill_sell_route': return 'sell_quote_probe';
    // winner / insider / orphan 은 'other' — winner 도 post-close trajectory 측정 가치 있음
    // (5x winner 가 trail 시점에 cut 됐는데 그 후 추가 상승했는지 → winner-kill rate).
    default: return 'other';
  }
}

function buildMissedAlphaConfig(): Partial<MissedAlphaObserverConfig> {
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

/**
 * KOL Hunter close-site observer hook.
 *
 * @param input - close 시점의 핵심 metric. shadow arm 은 caller 에서 사전 차단 권고.
 */
export function trackKolClose(input: {
  tokenMint: string;
  closeReason: string;
  signalPrice: number;
  ticketSol: number;
  state: string;
  entryTimeSec: number;
  nowSec: number;
  mfePct: number;
  maePct: number;
  entryPrice: number;
  exitPrice: number;
  peakPrice: number;
  troughPrice: number;
  isLive: boolean;
  armName?: string;
  t1VisitAtSec?: number;
  t2VisitAtSec?: number;
  t3VisitAtSec?: number;
}): void {
  trackRejectForMissedAlpha(
    {
      // 기존 RejectCategory enum 매핑 — close reason 별로 분리 분석 가능.
      // lane='kol_hunter' + extras.isLive 로 close-site 만 필터 (reject 와 구분: extras.elapsedSecAtClose 존재).
      rejectCategory: closeReasonToCategory(input.closeReason),
      rejectReason: input.closeReason,
      tokenMint: input.tokenMint,
      lane: KOL_LANE_STRATEGY,
      signalPrice: input.signalPrice,
      probeSolAmount: input.ticketSol,
      signalSource: input.armName,
      extras: {
        closeState: input.state,
        elapsedSecAtClose: input.nowSec - input.entryTimeSec,
        mfePctAtClose: input.mfePct,
        maePctAtClose: input.maePct,
        entryPrice: input.entryPrice,
        exitPrice: input.exitPrice,
        peakPrice: input.peakPrice,
        troughPrice: input.troughPrice,
        isLive: input.isLive,
        t1VisitAtSec: input.t1VisitAtSec ?? null,
        t2VisitAtSec: input.t2VisitAtSec ?? null,
        t3VisitAtSec: input.t3VisitAtSec ?? null,
      },
    },
    buildMissedAlphaConfig()
  );
}
