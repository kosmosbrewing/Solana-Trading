/**
 * Wallet Stop Guard (2026-04-17)
 *
 * Why: override 가드레일 #2 — wallet balance 가 임계 이하로 떨어지면 cupsey + migration 두 lane
 * 의 **신규 진입(buy)** 을 즉시 차단한다. 기존 OPEN 포지션의 정상 close(sell) 는 계속 허용되어
 * stuck 토큰이 자연스럽게 해소되도록 한다.
 *
 * 설계 원칙:
 *   - entry 차단만 (exit는 영향 없음) — wallet 보존 + 기존 포지션 자연 unwind
 *   - module-level state + polling (기존 cupseyLaneHandler.integrityHaltActive 패턴 확장)
 *   - stop 발동은 한 번, reset 은 operator 수동 (자동 복구 금지 — false stop 보다 false unblock 이 더 위험)
 *   - Telegram critical alert 1회 (발동 시점) — flood 방지
 *
 * 호출 지점:
 *   - cupseyLaneHandler.handleCupseyLaneSignal: signal 진입 전 isWalletStopActive() 체크
 *   - cupseyLaneHandler.updateCupseyPositions STALK→PROBE: buy 직전 체크
 *   - migrationLaneHandler.onMigrationEvent: event 등록 직전 체크
 *   - migrationLaneHandler.updateMigrationPositions READY: buy 직전 체크
 */
import { createModuleLogger } from '../utils/logger';
import { Notifier } from '../notifier/notifier';
import { WalletManager } from '../executor/walletManager';

const log = createModuleLogger('WalletStopGuard');

export interface WalletStopGuardConfig {
  minWalletSol: number;         // 이 값 미만이면 stop 발동 (기본 0.8)
  pollIntervalMs: number;       // 체크 주기 (기본 30_000 = 30초)
  walletName: string;           // walletManager에 등록된 wallet 식별자 (기본 'main')
  rpcFailSafeThreshold?: number; // 연속 N 회 RPC 실패 시 precautionary halt (기본 3)
}

interface WalletStopGuardState {
  active: boolean;
  lastBalanceSol: number;
  lastCheckAt: Date | null;
  triggeredAt: Date | null;
  triggerReason: string | null;
  consecutiveRpcFailures: number;
}

const state: WalletStopGuardState = {
  active: false,
  lastBalanceSol: Number.POSITIVE_INFINITY,
  lastCheckAt: null,
  triggeredAt: null,
  triggerReason: null,
  consecutiveRpcFailures: 0,
};

let pollerHandle: ReturnType<typeof setInterval> | null = null;

export function isWalletStopActive(): boolean {
  return state.active;
}

export function getWalletStopGuardState(): Readonly<WalletStopGuardState> {
  return state;
}

export function resetWalletStopGuard(reason = 'manual'): void {
  if (!state.active) {
    log.info(`[WALLET_STOP_RESET] guard not active — noop (${reason})`);
    return;
  }
  log.info(`[WALLET_STOP_RESET] cleared by ${reason} (prev_balance=${state.lastBalanceSol.toFixed(4)} SOL)`);
  state.active = false;
  state.triggeredAt = null;
  state.triggerReason = null;
  state.consecutiveRpcFailures = 0; // reset 시 실패 카운터도 초기화
}

/**
 * poller 를 시작한다. 이미 돌고 있으면 noop.
 */
export function startWalletStopGuard(
  walletManager: WalletManager,
  notifier: Notifier,
  config: WalletStopGuardConfig
): void {
  if (pollerHandle) {
    log.debug('[WALLET_STOP] poller already running — skip start');
    return;
  }
  const failSafeThreshold = Math.max(1, config.rpcFailSafeThreshold ?? 3);
  log.info(
    `[WALLET_STOP] poller started — wallet='${config.walletName}' ` +
    `threshold=${config.minWalletSol} SOL interval=${config.pollIntervalMs}ms ` +
    `rpc_fail_safe=${failSafeThreshold}`
  );
  const check = async (): Promise<void> => {
    try {
      const balance = await walletManager.getBalance(config.walletName);
      state.lastBalanceSol = balance;
      state.lastCheckAt = new Date();
      state.consecutiveRpcFailures = 0; // 성공 → reset
      if (!state.active && balance < config.minWalletSol) {
        state.active = true;
        state.triggeredAt = new Date();
        state.triggerReason = `balance ${balance.toFixed(4)} SOL < threshold ${config.minWalletSol} SOL`;
        log.warn(`[WALLET_STOP_TRIGGERED] ${state.triggerReason} — new entries blocked (both lanes)`);
        await notifier.sendCritical(
          'wallet_stop_guard',
          `Wallet stop guard TRIGGERED — balance ${balance.toFixed(4)} SOL < ${config.minWalletSol}. ` +
          `Cupsey + Migration lanes: NEW ENTRIES BLOCKED. Existing positions continue normal close. ` +
          `Reset via operator command after reconciliation.`
        ).catch(() => {});
      }
    } catch (err) {
      // Fail-safe: 연속 N 회 RPC 실패 시 precautionary halt.
      // RPC 다운 시 silently 방어 비활성되지 않도록 — fail-open 대신 fail-safe.
      state.consecutiveRpcFailures++;
      log.warn(
        `[WALLET_STOP] balance check failed (${state.consecutiveRpcFailures}/${failSafeThreshold}): ${err}`
      );
      if (!state.active && state.consecutiveRpcFailures >= failSafeThreshold) {
        state.active = true;
        state.triggeredAt = new Date();
        state.triggerReason = `RPC failure × ${state.consecutiveRpcFailures} (fail-safe)`;
        log.warn(`[WALLET_STOP_TRIGGERED] ${state.triggerReason} — new entries blocked (fail-safe halt)`);
        await notifier.sendCritical(
          'wallet_stop_guard',
          `Wallet stop guard TRIGGERED (fail-safe) — RPC balance check failed ${state.consecutiveRpcFailures}×. ` +
          `Cannot verify wallet balance. NEW ENTRIES BLOCKED. Inspect RPC + reset via operator command.`
        ).catch(() => {});
      }
    }
  };
  // 초기 1회 즉시 실행 + 이후 interval
  void check();
  pollerHandle = setInterval(() => { void check(); }, config.pollIntervalMs);
}

export function stopWalletStopGuardPoller(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
}

/** 테스트용 — state/poller 완전 초기화 */
export function resetWalletStopGuardForTests(): void {
  state.active = false;
  state.lastBalanceSol = Number.POSITIVE_INFINITY;
  state.lastCheckAt = null;
  state.triggeredAt = null;
  state.triggerReason = null;
  state.consecutiveRpcFailures = 0;
  stopWalletStopGuardPoller();
}

/** 테스트용 — poller 없이 상태 직접 설정 */
export function setWalletStopGuardStateForTests(active: boolean, reason = 'test'): void {
  state.active = active;
  state.triggeredAt = active ? new Date() : null;
  state.triggerReason = active ? reason : null;
}
