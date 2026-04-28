// Pair-level 격리 + token-level session 추적 + reject 후 관측 layer.
// - Pair Quarantine (Phase 4 P2-3, 2026-04-25): pippin 류 stale price 자동 격리.
// - Token Session Tracker (Phase 3 P1-8, 2026-04-25): winner 후 sliced 재진입 차단.
// - Missed Alpha Observer (P0+P2, 2026-04-22): reject 이후 T+N초 Jupiter price 관측.

import { boolOptional, numEnv } from './helpers';

export const pairAndSession = {
  // Phase 4 P2-3 (2026-04-25): Pair quarantine.
  pairQuarantineEnabled: boolOptional('PAIR_QUARANTINE_ENABLED', true),
  pairQuarantineDriftRejectThreshold: numEnv('PAIR_QUARANTINE_DRIFT_REJECT_THRESHOLD', '20'),
  pairQuarantineFavorableDriftThreshold: numEnv('PAIR_QUARANTINE_FAVORABLE_THRESHOLD', '5'),
  pairQuarantineWindowMin: numEnv('PAIR_QUARANTINE_WINDOW_MIN', '10'),
  pairQuarantineDurationMin: numEnv('PAIR_QUARANTINE_DURATION_MIN', '60'),

  // Phase 3 P1-8 (2026-04-25): Token session continuation guard.
  // Why: BZtgGZqx 같이 winner 후 5번 sliced 재진입 패턴 차단 — winner ≥ threshold 가 lookback 내면
  // continuation mode (정상 PROBE 대신 더 긴 window + 낮은 T1).
  tokenSessionTrackerEnabled: boolOptional('TOKEN_SESSION_TRACKER_ENABLED', true),
  tokenSessionTtlMin: numEnv('TOKEN_SESSION_TTL_MIN', '30'),
  tokenSessionWinnerThresholdPct: numEnv('TOKEN_SESSION_WINNER_THRESHOLD_PCT', '0.50'),
  tokenSessionWinnerLookbackMin: numEnv('TOKEN_SESSION_WINNER_LOOKBACK_MIN', '15'),
  tokenSessionContinuationT1Pct: numEnv('TOKEN_SESSION_CONTINUATION_T1_PCT', '0.30'),
  tokenSessionContinuationProbeWindowSec: numEnv('TOKEN_SESSION_CONTINUATION_PROBE_WINDOW_SEC', '60'),
  tokenSessionBlockOpenPositionEntries: boolOptional('TOKEN_SESSION_BLOCK_OPEN_POSITION_ENTRIES', true),

  // 2026-04-22 P0+P2 (mission-refinement): Missed Alpha Observer.
  // reject 이후 T+N초 Jupiter price 를 비동기로 기록 → reject 옳고 그름 분포 판정.
  // observer 는 trade 결정에 간섭하지 않는다. 출력: `${realtimeDataDir}/missed-alpha.jsonl`
  missedAlphaObserverEnabled: boolOptional('MISSED_ALPHA_OBSERVER_ENABLED', true),
  // 2026-04-28 (Phase 2B, ralph-loop): T+30s 추가 — close 직후 즉시 rebound (scalper sell 후 회복)
  // 측정. 외부 피드백의 "post-close T+30/60/300/1800s" 정합. close 30초 안 reject 후 30s probe
  // 가 가장 critical (scalper KOL sell trigger 가 misfire 인지 즉시 판정 가능).
  missedAlphaObserverOffsetsSec: (process.env.MISSED_ALPHA_OBSERVER_OFFSETS_SEC ?? '30,60,300,1800')
    .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
  missedAlphaObserverJitterPct: numEnv('MISSED_ALPHA_OBSERVER_JITTER_PCT', '0.1'),
  missedAlphaObserverMaxInflight: numEnv('MISSED_ALPHA_OBSERVER_MAX_INFLIGHT', '50'),
  missedAlphaObserverDedupWindowSec: numEnv('MISSED_ALPHA_OBSERVER_DEDUP_WINDOW_SEC', '30'),
} as const;
