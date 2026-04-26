/**
 * Daily Bleed Budget Tracker (DEX_TRADE Phase 2, 2026-04-18)
 *
 * Why: pure DEX trading bot 에서 시도 수 통제는 RR 이 아니라 **bleed budget** 로.
 * DEX_TRADE.md Section 8.2:
 *   daily_bleed_cap = alpha * wallet_balance
 *   max_probes_today = floor(daily_bleed_cap / bleed_per_probe)
 *
 * 설계:
 *   - UTC day 기준 (canary 운영 cadence 와 일치)
 *   - baseline wallet balance 는 day 시작 시 snapshot
 *   - `reportBleed(sol)` 로 매 probe 직후 누적
 *   - `remainingBudget()` 으로 남은 예산 조회 (probe viability floor 가 호출)
 *   - day rollover 자동 감지 → reset
 *
 * 운영 원칙:
 *   - config 에서 alpha (default 5%) + hard floor SOL (default 0.05) 주입
 *   - budget exhausted 시 운영자 수동 reset 또는 다음 UTC day 까지 대기
 */
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('DailyBleedBudget');

export interface DailyBleedBudgetConfig {
  /** daily cap = alpha × wallet_baseline. default 0.05 (wallet 5%) */
  alpha: number;
  /** daily cap 최소 SOL (wallet 이 작을 때 floor). default 0.05 */
  minCapSol: number;
  /** daily cap 최대 SOL (wallet 이 클 때 ceiling). 0 = 무제한. default 0 */
  maxCapSol: number;
}

interface DailyBleedState {
  utcDay: number;                   // Date.now() / 86_400_000 floor
  capSol: number;
  spentSol: number;
  walletBaselineSol: number;
  probes: number;
  lastReportAt: Date | null;
}

const state: DailyBleedState = {
  utcDay: -1,
  capSol: 0,
  spentSol: 0,
  walletBaselineSol: 0,
  probes: 0,
  lastReportAt: null,
};

function computeUtcDay(): number {
  return Math.floor(Date.now() / 86_400_000);
}

function computeCap(walletBaselineSol: number, cfg: DailyBleedBudgetConfig): number {
  let cap = cfg.alpha * walletBaselineSol;
  if (cap < cfg.minCapSol) cap = cfg.minCapSol;
  if (cfg.maxCapSol > 0 && cap > cfg.maxCapSol) cap = cfg.maxCapSol;
  return cap;
}

/** 새 UTC day 진입 또는 초기화 시 baseline 재설정 */
export function rollDailyBleedBudget(walletBaselineSol: number, cfg: DailyBleedBudgetConfig): void {
  const today = computeUtcDay();
  state.utcDay = today;
  state.walletBaselineSol = walletBaselineSol;
  state.capSol = computeCap(walletBaselineSol, cfg);
  state.spentSol = 0;
  state.probes = 0;
  state.lastReportAt = new Date();
  log.info(
    `[BLEED_BUDGET] rolled — day=${today} wallet=${walletBaselineSol.toFixed(4)} SOL cap=${state.capSol.toFixed(6)} SOL (alpha=${cfg.alpha})`
  );
}

/** 자동 day rollover — reportBleed / remainingBudget 호출 시 내부적으로 체크 */
function ensureDay(walletBaselineSol: number, cfg: DailyBleedBudgetConfig): void {
  const today = computeUtcDay();
  if (state.utcDay !== today) {
    rollDailyBleedBudget(walletBaselineSol, cfg);
  }
}

/** 매 probe 직후 호출. bleed 액수 누적. */
export function reportBleed(
  bleedSol: number,
  walletBaselineSol: number,
  cfg: DailyBleedBudgetConfig
): void {
  ensureDay(walletBaselineSol, cfg);
  state.spentSol += bleedSol;
  state.probes++;
  state.lastReportAt = new Date();
  if (state.spentSol >= state.capSol) {
    log.warn(
      `[BLEED_BUDGET_EXHAUSTED] spent=${state.spentSol.toFixed(6)} SOL >= cap=${state.capSol.toFixed(6)} SOL ` +
      `probes=${state.probes} (day=${state.utcDay})`
    );
  }
}

/** 남은 예산 조회. viability floor 가 이 값으로 판단. */
export function remainingDailyBudget(
  walletBaselineSol: number,
  cfg: DailyBleedBudgetConfig
): number {
  ensureDay(walletBaselineSol, cfg);
  return Math.max(0, state.capSol - state.spentSol);
}

export function getDailyBleedSnapshot(): Readonly<DailyBleedState> {
  return state;
}

/**
 * Max probes today — 남은 budget 을 expected bleed per probe 로 나눈 값.
 * DEX_TRADE.md Section 8.2:
 *   max_probes_today = floor(daily_bleed_cap / bleed_per_probe)
 *
 * 호출자가 expected bleed 를 venue adapter 로 계산해 넘긴다 (ticket 크기 / venue 조합).
 * 이미 spent > cap 이면 0 반환.
 */
export function maxProbesToday(
  expectedBleedPerProbeSol: number,
  walletBaselineSol: number,
  cfg: DailyBleedBudgetConfig
): number {
  // 2026-04-26 fail-safe fix: misconfig (expectedBleedPerProbeSol <= 0) → 무한 probe 반환은
  // 사명 §3 "시도 수 통제" 위반 위험. caller 가 무한값 인지 안 하면 while 루프 탈진.
  // POSITIVE_INFINITY 대신 0 으로 보수 fallback + error log.
  if (expectedBleedPerProbeSol <= 0) {
    log.error(
      `[BLEED_BUDGET_MISCONFIG] expectedBleedPerProbeSol=${expectedBleedPerProbeSol} ` +
      `(<=0) — returning 0 (no probes allowed). caller 가 cost 계산 점검 필요.`
    );
    return 0;
  }
  const remaining = remainingDailyBudget(walletBaselineSol, cfg);
  return Math.floor(remaining / expectedBleedPerProbeSol);
}

export function resetDailyBleedForTests(): void {
  state.utcDay = -1;
  state.capSol = 0;
  state.spentSol = 0;
  state.walletBaselineSol = 0;
  state.probes = 0;
  state.lastReportAt = null;
}
