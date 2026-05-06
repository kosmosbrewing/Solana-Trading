// Tier 2: Operational switches (.env 토글 — 배포 없이 변경).
// trading mode, lane enable/disable, gate enable/disable, runner mode flags.

import { boolOptional, numEnv, optional, parseTradingMode } from './helpers';

const tradingMode = parseTradingMode();

export const operationalToggles = {
  tradingMode,
  scannerEnabled: process.env.SCANNER_ENABLED === 'true',
  realtimeEnabled: boolOptional('REALTIME_ENABLED', false),
  realtimePersistenceEnabled: boolOptional('REALTIME_PERSISTENCE_ENABLED', true),
  realtimeTriggerMode: optional('REALTIME_TRIGGER_MODE', 'bootstrap') as 'bootstrap' | 'core' | 'tick',
  realtimeReplayWarmSyncEnabled: boolOptional('REALTIME_REPLAY_WARM_SYNC_ENABLED', true),
  // Why: Paper 모드에서 Birdeye Premium 미보유 시 401 → 자동 비활성화
  securityGateEnabled: process.env.SECURITY_GATE_ENABLED
    ? process.env.SECURITY_GATE_ENABLED !== 'false'
    : tradingMode === 'live',
  // Why: Paper 모드에서 exit liquidity/sell impact 조회 불필요 → 자동 비활성화
  quoteGateEnabled: process.env.QUOTE_GATE_ENABLED
    ? process.env.QUOTE_GATE_ENABLED !== 'false'
    : tradingMode === 'live',
  preflightEnforceGate: process.env.PREFLIGHT_ENFORCE_GATE !== 'false',
  useJitoBundles: process.env.USE_JITO_BUNDLES === 'true',
  useJupiterUltra: process.env.USE_JUPITER_ULTRA === 'true',
  runnerEnabled: process.env.RUNNER_ENABLED === 'true',
  runnerGradeBEnabled: process.env.RUNNER_GRADE_B_ENABLED === 'true',
  runnerConcurrentEnabled: process.env.RUNNER_CONCURRENT_ENABLED === 'true',
  degradedExitEnabled: process.env.DEGRADED_EXIT_ENABLED === 'true',
  // Phase E1 (2026-04-08): exit execution mechanism mode flag.
  // 자세한 lifecycle 은 docs/exec-plans/active/exit-execution-mechanism-2026-04-08.md
  exitMechanismMode: (process.env.EXIT_MECHANISM_MODE === 'hybrid_c5' ? 'hybrid_c5' : 'legacy') as 'legacy' | 'hybrid_c5',
  // Phase B2: CRITICAL_LIVE canary용 임시 backdoor — DO NOT enable in production.
  bypassEdgeBlacklist: boolOptional('BOT_BYPASS_EDGE_BLACKLIST', false),
  realtimePoolDiscoveryEnabled: boolOptional('REALTIME_POOL_DISCOVERY_ENABLED', true),
  realtimeSeedBackfillEnabled: boolOptional('REALTIME_SEED_BACKFILL_ENABLED', true),
  // 2026-04-11: Path A — cupsey-inspired lane (sandbox, post-entry state machine)
  cupseyLaneEnabled: boolOptional('CUPSEY_LANE_ENABLED', false),
  // 2026-04-17: Tier 1 — Migration Handoff Reclaim lane (off by default)
  migrationLaneEnabled: boolOptional('MIGRATION_LANE_ENABLED', false),
  migrationLaneSignalOnly: boolOptional('MIGRATION_LANE_SIGNAL_ONLY', true),
  // 2026-04-18: Block 3 — pure_ws_breakout lane (mission-pivot convexity). paper-first.
  pureWsLaneEnabled: boolOptional('PUREWS_LANE_ENABLED', false),
  // 2026-05-04: pure_ws rebuild evidence must be new-pair only. Legacy trending/bootstrap
  // signals are rejected before paper/live entry so pippin-style mixed-source rows cannot pollute metrics.
  pureWsNewPairSourceGateEnabled: boolOptional('PUREWS_NEW_PAIR_SOURCE_GATE_ENABLED', true),
  pureWsLaneWalletMode: (process.env.PUREWS_WALLET_MODE ?? 'auto') as 'auto' | 'main' | 'sandbox',
  // Why: PUREWS_LANE_ENABLED + TRADING_MODE=live 만으로 자동 live 가 되지 않게 하기 위함.
  pureWsLiveCanaryEnabled: boolOptional('PUREWS_LIVE_CANARY_ENABLED', false),
  // live 운영 중에도 pure_ws primary 를 paper-only 로 계속 검증한다.
  // false 로 두면 예전처럼 PUREWS_LIVE_CANARY_ENABLED=false 에서 로그만 남기고 return.
  pureWsPaperShadowEnabled: boolOptional('PUREWS_PAPER_SHADOW_ENABLED', true),
  // pure_ws paper 관측 알림 master switch. 개별 open/close 는 별도 flag 로 opt-in.
  pureWsPaperNotifyEnabled: boolOptional('PUREWS_PAPER_NOTIFY_ENABLED', true),
  pureWsPaperNotifyIndividualEnabled: boolOptional('PUREWS_PAPER_NOTIFY_INDIVIDUAL_ENABLED', false),
  pureWsPaperDigestEnabled: boolOptional('PUREWS_PAPER_DIGEST_ENABLED', true),
  // Fast paper lane: keep operator feedback frequent without per-open/per-close spam.
  pureWsPaperDigestIntervalMs: numEnv('PUREWS_PAPER_DIGEST_INTERVAL_MS', '900000'),
  pureWsPaperRareMfePct: numEnv('PUREWS_PAPER_RARE_MFE_PCT', '0.30'),
  pureWsPaperRareAfterSellPct: numEnv('PUREWS_PAPER_RARE_AFTER_SELL_PCT', '1.00'),
} as const;
