// Real Asset Guard 의 운영 layer — wallet floor + canary auto-halt + delta drift comparator.
// REFACTORING_v1.0 §2.1 hard constraint:
//   wallet floor=0.8 SOL · canary cumulative loss cap=-0.3 SOL · max concurrent=3 · ticket=0.01 SOL

import { boolOptional, numEnv } from './helpers';

export const walletAndCanary = {
  // ─── Block 4 (2026-04-18) + 2026-04-21 mission-refinement: per-lane circuit-breaker ───
  // Why: pure_ws_breakout loose gate → 연속 entry loser streak 위험. per-lane auto-halt.
  canaryAutoHaltEnabled: boolOptional('CANARY_AUTO_HALT_ENABLED', true),
  // 2026-04-21 P2: 4 → 8 완화. consecutive counter 는 관측 circuit breaker, budget cap 이 자산 보호.
  canaryMaxConsecutiveLosers: numEnv('CANARY_MAX_CONSEC_LOSERS', '8'),
  // 2026-04-21 mission refinement: -0.3 SOL (1 SOL 중 30% 한도). 이전 default 0.5 는 pivot 당시 loose.
  canaryMaxBudgetSol: numEnv('CANARY_MAX_BUDGET_SOL', '0.3'),
  // 2026-04-21 P2: halt 자동 해제 — consecutiveLosers 만 reset, budget/cumulativePnl 유지.
  canaryAutoResetEnabled: boolOptional('CANARY_AUTO_RESET_ENABLED', true),
  canaryAutoResetMinSec: numEnv('CANARY_AUTO_RESET_MIN_SEC', '1800'),  // 30분
  // 2026-04-21 mission refinement: 200 = scale/retire decision gate (Stage 4).
  canaryMaxTrades: numEnv('CANARY_MAX_TRADES', '200'),
  // 관측 전용 체크포인트 — halt/승격 결정 없음, telemetry summary 에서만 표시.
  canarySafetyCheckpointTrades: numEnv('CANARY_SAFETY_CHECKPOINT_TRADES', '50'),
  canaryPreliminaryReviewTrades: numEnv('CANARY_PRELIMINARY_REVIEW_TRADES', '100'),
  canaryMinLossToCountSol: numEnv('CANARY_MIN_LOSS_TO_COUNT_SOL', '0'),

  // ─── Block 4 QA fix: wallet-level 전역 concurrency guard ───
  // Why: lane별 maxConcurrent 합계가 mission-pivot 의 "동시 max 3 ticket" 을 초과 가능 (cupsey 5 + pure_ws 3).
  // default false (opt-in) — canary 전환 시점에만 운영자가 활성.
  canaryGlobalConcurrencyEnabled: boolOptional('CANARY_GLOBAL_CONCURRENCY_ENABLED', false),
  canaryGlobalMaxConcurrent: numEnv('CANARY_GLOBAL_MAX_CONCURRENT', '3'),

  // ─── Wallet Stop Guard (override 가드레일 #2, 2026-04-17) ───
  // wallet balance < threshold 시 cupsey + migration 신규 진입 차단. exit 영향 없음.
  walletStopGuardEnabled: boolOptional('WALLET_STOP_GUARD_ENABLED', true),
  walletStopMinSol: numEnv('WALLET_STOP_MIN_SOL', '0.8'),
  walletStopPollIntervalMs: numEnv('WALLET_STOP_POLL_INTERVAL_MS', '30000'),
  walletStopWalletName: process.env.WALLET_STOP_WALLET_NAME ?? 'main',
  walletStopRpcFailSafeThreshold: numEnv('WALLET_STOP_RPC_FAIL_SAFE', '3'),

  // ─── Block 1 (2026-04-18): Explicit lane wallet ownership ───
  // Why: 'auto' = 기존 동작 (backward compat) / 'main' / 'sandbox' 명시 가능.
  cupseyWalletMode: (process.env.CUPSEY_WALLET_MODE ?? 'auto') as 'auto' | 'main' | 'sandbox',
  migrationWalletMode: (process.env.MIGRATION_WALLET_MODE ?? 'auto') as 'auto' | 'main' | 'sandbox',

  // ─── Block 1 (2026-04-18): Always-on wallet delta comparator ───
  // Why: 2026-04-17 +18.34 SOL drift 같은 사후 발견이 아닌 상시 감지.
  walletDeltaComparatorEnabled: boolOptional('WALLET_DELTA_COMPARATOR_ENABLED', true),
  walletDeltaPollIntervalMs: numEnv('WALLET_DELTA_POLL_INTERVAL_MS', '300000'),  // 5분
  walletDeltaDriftWarnSol: numEnv('WALLET_DELTA_DRIFT_WARN_SOL', '0.05'),
  walletDeltaDriftHaltSol: numEnv('WALLET_DELTA_DRIFT_HALT_SOL', '0.20'),
  walletDeltaMinSamplesBeforeAlert: numEnv('WALLET_DELTA_MIN_SAMPLES', '2'),  // N회 연속 drift 후 알림
} as const;
