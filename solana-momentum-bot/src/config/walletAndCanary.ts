// Real Asset Guard 의 운영 layer — wallet floor + canary auto-halt + delta drift comparator.
// REFACTORING_v1.0 §2.1 hard constraint:
//   wallet floor=0.8 SOL · canary cumulative loss cap=-0.3 SOL · max concurrent=3 · ticket=0.01 SOL

import { boolOptional, numEnv } from './helpers';

function numOrNullEnv(key: string): number | null {
  const raw = process.env[key];
  if (raw == null || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

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

  // ─── KOL hunter live canary 별도 cap (Sprint 2, 2026-04-28) ───
  // 2026-04-28 B안: ticket 0.03 → 0.02 후퇴 + wallet floor 0.8 → 0.7. cap 도 비례 조정.
  //   - cap 0.3 → 0.2 SOL: wallet floor 도달 전에 KOL lane 자체 차단
  //   - max consec losers 5 유지: 0.02 × 5 = 0.10 SOL streak halt (cap 절반)
  //   - max trades 50 유지: first checkpoint
  //   - drawdown budget = wallet - floor = 1.0 - 0.7 = 0.3 SOL
  //     KOL cap 0.2 < 0.3 budget → KOL 단독으로 floor 위반 불가
  //     단 cupsey/migration 동시 운영 시 합산 cap 0.5 SOL → wallet floor 가 최종 차단
  // Real Asset Guard wallet floor (walletStopGuard) 가 absolute hardstop.
  kolHunterCanaryMaxBudgetSol: numEnv('KOL_HUNTER_CANARY_MAX_BUDGET_SOL', '0.2'),
  kolHunterCanaryMaxConsecLosers: numEnv('KOL_HUNTER_CANARY_MAX_CONSEC_LOSERS', '5'),
  kolHunterCanaryMaxTrades: numEnv('KOL_HUNTER_CANARY_MAX_TRADES', '50'),

  // ─── Block 4 QA fix: wallet-level 전역 concurrency guard ───
  // Why: lane별 maxConcurrent 합계가 mission-pivot 의 "동시 max 3 ticket" 을 초과 가능 (cupsey 5 + pure_ws 3).
  // default false (opt-in) — canary 전환 시점에만 운영자가 활성.
  canaryGlobalConcurrencyEnabled: boolOptional('CANARY_GLOBAL_CONCURRENCY_ENABLED', false),
  canaryGlobalMaxConcurrent: numEnv('CANARY_GLOBAL_MAX_CONCURRENT', '3'),

  // ─── Wallet Stop Guard (override 가드레일 #2, 2026-04-17) ───
  // wallet balance < threshold 시 cupsey + migration 신규 진입 차단. exit 영향 없음.
  walletStopGuardEnabled: boolOptional('WALLET_STOP_GUARD_ENABLED', true),
  // 2026-04-28 B안 운영자 결정: floor 0.8 → 0.7 SOL.
  // 배경: KOL ticket 0.03 → 0.02 후퇴와 동시 적용. drawdown budget 0.2 → 0.3 SOL 으로 50% 확장 →
  //   200 trade Stage 4 gate 도달 가능성 확보 (catastrophic 9건 + bleed 0.102 = 0.282 drawdown).
  //   ralph-loop fix (429 backoff 단축 / inflight dedup / RPC 병렬화 / notifier fire-and-forget)
  //   배포 후 PNL_DRIFT 개선 시 catastrophic rate 감소 기대 — 그 측정 시간 확보.
  walletStopMinSol: numEnv('WALLET_STOP_MIN_SOL', '0.7'),
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
  // 2026-04-28 (Sprint A1): warn alert dedup. 동일 drift 값 5분 spam 차단.
  // - 마지막 alert 후 cooldown 안 지났고
  // - drift 값이 ±warnDriftDeltaToleranceSol 이내면 sendCritical skip (log.warn 은 유지)
  // 새 drift 또는 cooldown 경과 시 다시 발동.
  walletDeltaWarnAlertCooldownMs: numEnv('WALLET_DELTA_WARN_ALERT_COOLDOWN_MS', '1800000'),  // 30분
  walletDeltaWarnDriftDeltaToleranceSol: numEnv('WALLET_DELTA_WARN_DRIFT_DELTA_TOLERANCE_SOL', '0.005'),

  // ─── 2026-04-29: Risk daily loss limit override (D 옵션) ───
  // Why: 2026-04-29 KOL hunter live 운영에서 dailyLoss -0.0943 SOL 으로 halt 발생.
  //   wallet floor 0.7 + canary cap 0.2 가 catastrophic 방어 cover 하는데 5%/15% % equity 가
  //   misalignment. floor 까지 여유 충분한 상황에서 mission §3 측정 차단 = 5x discovery 지연.
  // 본 env 가 set 되면 portfolio.riskTier?.maxDailyLoss 와 무관하게 모든 tier 에 강제 적용.
  // unset (null) 이면 기존 tier 정책 그대로 (Bootstrap 5% / Calibration 15% / Confirmed/Proven 15%).
  // 0 (또는 음수) 설정 시 daily loss limit 사실상 disable — wallet floor + canary cap 만 보호.
  // 권고: mission §3 측정 sprint 동안 0.30 (30% equity) 또는 큰 절대값. catastrophic 발생 시 즉시 복구.
  riskMaxDailyLossOverride: numOrNullEnv('RISK_MAX_DAILY_LOSS_OVERRIDE'),
} as const;
