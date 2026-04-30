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
import { config } from '../utils/config';
import {
  trackRejectForMissedAlpha,
  buildMissedAlphaConfigFromGlobal,
  type MissedAlphaObserverConfig,
  type RejectCategory,
} from '../observability/missedAlphaObserver';

const KOL_LANE_STRATEGY = 'kol_hunter';

/**
 * Close reason → MissedAlpha RejectCategory 매핑.
 * 2026-04-30 (B1 refactor): 모든 KOL close-site 는 'kol_close' 로 통일. 분석 스크립트는
 *   rejectReason 으로 세부 분기 (probe_hard_cut / winner_trailing_t1 등). 이전엔 이미 존재
 *   하던 enum (probe_hard_cut 등) 으로 분산 매핑 → reject-side 와 같은 enum 공유로 close vs
 *   reject 구분이 extras.elapsedSecAtClose 존재 여부로만 가능했음. 이제 enum 자체로 분리.
 */
function closeReasonToCategory(_reason: string): RejectCategory {
  return 'kol_close';
}

// 2026-04-30 (B2 refactor): observer config 공통 helper 사용. KOL 만 writeScheduleMarker=true
// (재시작 직후 close coverage 보존 — pure_ws 는 재시작 시 active position recover 별도 경로).
function buildMissedAlphaConfig(): Partial<MissedAlphaObserverConfig> {
  return buildMissedAlphaConfigFromGlobal({
    realtimeDataDir: config.realtimeDataDir,
    enabled: config.missedAlphaObserverEnabled,
    offsetsSec: config.missedAlphaObserverOffsetsSec,
    jitterPct: config.missedAlphaObserverJitterPct,
    maxInflight: config.missedAlphaObserverMaxInflight,
    dedupWindowSec: config.missedAlphaObserverDedupWindowSec,
    jupiterApiUrl: config.jupiterApiUrl,
    jupiterApiKey: config.jupiterApiKey,
    writeScheduleMarker: true,
  });
}

/**
 * KOL Hunter close-site observer hook.
 *
 * @param input - close 시점의 핵심 metric. shadow arm 은 caller 에서 사전 차단 권고.
 */
export function trackKolClose(input: {
  positionId: string;
  tokenMint: string;
  closeReason: string;
  signalPrice: number;
  ticketSol: number;
  tokenDecimals?: number;
  tokenDecimalsSource?: string;
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
      tokenDecimals: input.tokenDecimals,
      signalSource: input.armName,
      extras: {
        positionId: input.positionId,
        closeState: input.state,
        elapsedSecAtClose: input.nowSec - input.entryTimeSec,
        mfePctAtClose: input.mfePct,
        maePctAtClose: input.maePct,
        entryPrice: input.entryPrice,
        exitPrice: input.exitPrice,
        peakPrice: input.peakPrice,
        troughPrice: input.troughPrice,
        isLive: input.isLive,
        tokenDecimalsSource: input.tokenDecimalsSource ?? null,
        t1VisitAtSec: input.t1VisitAtSec ?? null,
        t2VisitAtSec: input.t2VisitAtSec ?? null,
        t3VisitAtSec: input.t3VisitAtSec ?? null,
      },
    },
    buildMissedAlphaConfig()
  );
}
