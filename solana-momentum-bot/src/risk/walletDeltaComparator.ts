/**
 * Wallet Delta Comparator (2026-04-18, Block 1)
 *
 * Why: 2026-04-17 wallet-reconcile 감사에서 DB pnl 합계 `+18.11 SOL` vs 실제 wallet `-0.23 SOL` 의
 * `+18.34 SOL` drift 가 사후에서야 발견되었다. 운영 중엔 아무도 이 괴리를 감지하지 못했다.
 * 본 모듈은 이 간극을 **상시 감지**로 전환한다.
 *
 * 동작:
 *   1) 봇 시작 시 baseline wallet balance 캡처
 *   2) fallback ledger 파일(`executed-buys.jsonl` / `executed-sells.jsonl`) 초기 상태 마킹
 *   3) 주기적 poll (기본 5분) 마다:
 *        - 현재 wallet balance 조회 (observedDelta = now - baseline)
 *        - baseline 이후 기록된 ledger 합산 (expectedDelta)
 *        - drift = |observedDelta - expectedDelta|
 *   4) drift 가 warn threshold 초과 → Telegram 경고
 *      drift 가 halt threshold 초과 → 모든 lane entry halt (entryIntegrity 경유)
 *
 * Ledger 규칙:
 *   - BUY: `actualEntryPrice × actualQuantity` 를 solSpent 추정치로 사용 (nominal — fees 제외)
 *   - SELL: `receivedSol` (wallet delta 직접 측정값) 사용
 *   - expectedDelta = Σ(sells.receivedSol) − Σ(buys.actualEntryPrice × actualQuantity)
 *
 * 한계:
 *   - 진입 slippage / priority fee 는 expectedDelta 에 반영 안 됨 → 약간의 negative drift 는 정상
 *   - OPEN 상태 포지션 (미실현) 은 expectedDelta 에 들어가지만 observed 는 SOL 나간 상태 → negative drift
 *   - 따라서 warn/halt threshold 는 "비정상" 드리프트만 잡도록 보수적으로 설정해야 함
 *
 * Fail-safe:
 *   - RPC 조회 실패는 단일 trigger 아님 — consecutiveRpcFailures 로 카운트만 (walletStopGuard 가 이미 rpc halt 처리)
 *   - ledger 파일 부재/읽기 실패는 comparator 비활성화 (trading path 차단 금지)
 */
import { readFile } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { Notifier } from '../notifier/notifier';
import { WalletManager } from '../executor/walletManager';
import { config } from '../utils/config';
import { triggerEntryHalt, type EntryLane } from '../state/entryHaltState';

const log = createModuleLogger('WalletDeltaComparator');

export interface WalletDeltaComparatorConfig {
  enabled: boolean;
  pollIntervalMs: number;
  driftWarnSol: number;
  driftHaltSol: number;
  minSamplesBeforeAlert: number;
  walletName: string;
  realtimeDataDir: string;
  /**
   * 2026-04-28 (Sprint A1): warn alert dedup cooldown (ms).
   * 동일 drift 값이 cooldown 안에 재발동하면 sendCritical skip. log.warn 은 유지.
   * Default 30분 — 5분 polling 의 6 cycle 동안 spam 차단.
   */
  warnAlertCooldownMs?: number;
  /**
   * 2026-04-28 (Sprint A1): drift 값 변화 허용 오차 (SOL).
   * 마지막 alert 의 drift 와 ±tolerance 안이면 "동일 drift" 로 간주하고 dedup.
   * 새 drift (변화 ≥ tolerance) 면 cooldown 무시하고 재발동 — 운영자에게 변화 알림.
   * Default 0.005 SOL.
   */
  warnDriftDeltaToleranceSol?: number;
}

interface LedgerLineCount {
  buys: number;
  sells: number;
}

interface ComparatorState {
  baselineBalanceSol: number | null;
  baselineAt: Date | null;
  baselineLedgerOffsets: LedgerLineCount;
  lastObservedDelta: number;
  lastExpectedDelta: number;
  lastDrift: number;
  lastCheckAt: Date | null;
  consecutiveDriftBreaches: number;
  consecutiveRpcFailures: number;
  haltTriggered: boolean;
  /** 2026-04-28 (Sprint A1): 마지막 warn sendCritical 시각 (epoch ms). 0 = 미발사. */
  lastWarnAlertAtMs: number;
  /** 2026-04-28 (Sprint A1): 마지막 warn alert 의 drift 값. cooldown 중 동일성 비교용. */
  lastWarnAlertDrift: number;
}

const state: ComparatorState = {
  baselineBalanceSol: null,
  baselineAt: null,
  baselineLedgerOffsets: { buys: 0, sells: 0 },
  lastObservedDelta: 0,
  lastExpectedDelta: 0,
  lastDrift: 0,
  lastCheckAt: null,
  consecutiveDriftBreaches: 0,
  consecutiveRpcFailures: 0,
  haltTriggered: false,
  lastWarnAlertAtMs: 0,
  lastWarnAlertDrift: 0,
};

let pollerHandle: ReturnType<typeof setInterval> | null = null;

export function getWalletDeltaComparatorState(): Readonly<ComparatorState> {
  return state;
}

async function countLedgerLines(dir: string): Promise<LedgerLineCount> {
  const count = async (file: string): Promise<number> => {
    try {
      const text = await readFile(path.join(dir, file), 'utf8');
      if (!text) return 0;
      return text.split('\n').filter((line) => line.trim().length > 0).length;
    } catch {
      return 0;
    }
  };
  const [buys, sells] = await Promise.all([count('executed-buys.jsonl'), count('executed-sells.jsonl')]);
  return { buys, sells };
}

async function sumLedgerFromOffset(
  dir: string,
  file: 'executed-buys.jsonl' | 'executed-sells.jsonl',
  skipLines: number,
  walletName: string
): Promise<number> {
  let text: string;
  try {
    text = await readFile(path.join(dir, file), 'utf8');
  } catch {
    return 0;
  }
  if (!text) return 0;
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  let sum = 0;
  for (let i = skipLines; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]) as Record<string, unknown>;
      // Block 1 QA fix (2026-04-18): wallet-aware ledger filter.
      // lane handler 가 ledger 기록 시 `wallet` 필드 포함 → 다른 wallet 의 ledger 는 expected 계산에서 제외.
      // backward-compat: `wallet` 필드 누락 entry 는 'main' 으로 간주 (이전 배포 ledger 호환).
      const entryWallet = typeof entry.wallet === 'string' ? entry.wallet : 'main';
      if (entryWallet !== walletName) continue;
      if (file === 'executed-sells.jsonl') {
        const received = typeof entry.receivedSol === 'number' ? entry.receivedSol : 0;
        sum += received;
      } else {
        const price = typeof entry.actualEntryPrice === 'number' ? entry.actualEntryPrice : 0;
        const qty = typeof entry.actualQuantity === 'number' ? entry.actualQuantity : 0;
        sum += price * qty;
      }
    } catch {
      // malformed line — skip
    }
  }
  return sum;
}

async function computeExpectedDelta(cfg: WalletDeltaComparatorConfig): Promise<number> {
  const sellsSol = await sumLedgerFromOffset(
    cfg.realtimeDataDir,
    'executed-sells.jsonl',
    state.baselineLedgerOffsets.sells,
    cfg.walletName
  );
  const buysSol = await sumLedgerFromOffset(
    cfg.realtimeDataDir,
    'executed-buys.jsonl',
    state.baselineLedgerOffsets.buys,
    cfg.walletName
  );
  return sellsSol - buysSol;
}

/** Block entries on all lanes. Called when drift exceeds halt threshold. */
function haltAllLanes(reason: string): void {
  // 2026-04-27 fix: KOL live canary + swing-v2 누락 사명 §3 위반.
  // drift halt 시 모든 lane 차단해야 하는데 이전엔 5 lane 만 → kol_hunter, pure_ws_swing_v2
  // 가 계속 진입 가능. 두 lane 도 추가하여 EntryLane 전체 정합.
  const lanes: EntryLane[] = [
    'cupsey', 'migration', 'main', 'strategy_d', 'pure_ws_breakout',
    'pure_ws_swing_v2', 'kol_hunter',
  ];
  for (const lane of lanes) {
    triggerEntryHalt(lane, reason);
  }
  state.haltTriggered = true;
}

/** Start the always-on comparator. Idempotent. */
export async function startWalletDeltaComparator(
  walletManager: WalletManager,
  notifier: Notifier,
  cfg: WalletDeltaComparatorConfig
): Promise<void> {
  if (pollerHandle) {
    log.debug('[WALLET_DELTA] poller already running — skip start');
    return;
  }
  if (!cfg.enabled) {
    log.info('[WALLET_DELTA] disabled via config — comparator not started');
    return;
  }

  // Baseline: capture current balance + ledger offsets
  try {
    const balance = await walletManager.getBalance(cfg.walletName);
    state.baselineBalanceSol = balance;
    state.baselineAt = new Date();
    state.baselineLedgerOffsets = await countLedgerLines(cfg.realtimeDataDir);
    log.info(
      `[WALLET_DELTA_BASELINE] wallet='${cfg.walletName}' balance=${balance.toFixed(6)} SOL ` +
      `ledger_offsets buys=${state.baselineLedgerOffsets.buys} sells=${state.baselineLedgerOffsets.sells}`
    );
  } catch (err) {
    // Block 1 QA fix: comparator silent 비활성화 방지 — operator 에게 즉시 알림.
    log.error(`[WALLET_DELTA] baseline capture failed: ${err} — comparator NOT started`);
    await notifier.sendCritical(
      'wallet_delta_baseline_fail',
      `Wallet delta comparator baseline capture FAILED: ${err}. ` +
      `Always-on drift detection is NOT active. Investigate RPC / wallet binding and restart.`
    ).catch(() => {});
    return;
  }

  const check = async (): Promise<void> => {
    try {
      const currentBalance = await walletManager.getBalance(cfg.walletName);
      const observedDelta = currentBalance - (state.baselineBalanceSol ?? currentBalance);
      const expectedDelta = await computeExpectedDelta(cfg);
      const drift = observedDelta - expectedDelta;
      const absDrift = Math.abs(drift);

      state.lastObservedDelta = observedDelta;
      state.lastExpectedDelta = expectedDelta;
      state.lastDrift = drift;
      state.lastCheckAt = new Date();
      state.consecutiveRpcFailures = 0;

      log.info(
        `[WALLET_DELTA] observed=${observedDelta.toFixed(6)} expected=${expectedDelta.toFixed(6)} ` +
        `drift=${drift.toFixed(6)} SOL`
      );

      if (absDrift < cfg.driftWarnSol) {
        state.consecutiveDriftBreaches = 0;
        // 2026-04-28 (Sprint A1 QA Q9): drift 회복 시 warn dedup state 도 reset.
        // Why: 회복 후 같은 drift 값이 재발생하면 cooldown 안에서 skip 되어 운영자가 incident
        // 재발생을 인지 못 한다 (real incident risk). 회복 시 dedup state 초기화하여
        // 다음 breach 시 즉시 alert.
        state.lastWarnAlertAtMs = 0;
        state.lastWarnAlertDrift = 0;
        // 2026-04-26 fix: drift 복구 시 haltTriggered flag 도 reset.
        // 이전: state.haltTriggered 가 한 번 true 되면 영구 → 운영자 수동 reset 후 재halt 불가.
        // 수정: drift 가 warn threshold 미만으로 복구되면 자동 reset → 다음 breach 감지 가능.
        // 단 lane entry halt 자체는 별도 (haltAllLanes 가 entryHaltState 를 trigger 했으므로
        // 그 reset 은 운영자 책임 — canaryAutoResetEnabled 가 처리).
        if (state.haltTriggered) {
          state.haltTriggered = false;
          log.info(
            `[WALLET_DELTA_HALT_FLAG_RESET] drift recovered to ${drift.toFixed(6)} SOL ` +
            `(< warn ${cfg.driftWarnSol}) — comparator 가 다음 breach 재감지 가능`
          );
        }
        return;
      }

      state.consecutiveDriftBreaches++;
      if (state.consecutiveDriftBreaches < cfg.minSamplesBeforeAlert) {
        log.debug(
          `[WALLET_DELTA] drift ${drift.toFixed(6)} SOL above warn but below sample count ` +
          `(${state.consecutiveDriftBreaches}/${cfg.minSamplesBeforeAlert}) — suppressing alert`
        );
        return;
      }

      if (absDrift >= cfg.driftHaltSol && !state.haltTriggered) {
        const reason =
          `wallet delta drift ${drift.toFixed(6)} SOL >= halt threshold ${cfg.driftHaltSol}. ` +
          `observed=${observedDelta.toFixed(6)} expected=${expectedDelta.toFixed(6)}`;
        log.error(`[WALLET_DELTA_HALT] ${reason}`);
        haltAllLanes(reason);
        await notifier.sendCritical(
          'wallet_delta_halt',
          `Wallet delta HALT — drift ${drift.toFixed(4)} SOL (>= ${cfg.driftHaltSol}). ` +
          `All lanes entry-blocked. observed=${observedDelta.toFixed(4)} expected=${expectedDelta.toFixed(4)}. ` +
          `Run ops:reconcile:wallet, inspect ledger and DB, then reset lane halts.`
        ).catch(() => {});
      } else if (absDrift >= cfg.driftWarnSol) {
        log.warn(
          `[WALLET_DELTA_WARN] drift ${drift.toFixed(6)} SOL >= warn threshold ${cfg.driftWarnSol} ` +
          `(x${state.consecutiveDriftBreaches})`
        );
        // 2026-04-28 (Sprint A1): warn alert dedup.
        // - cooldown 안에 동일 drift (±tolerance) 면 sendCritical skip → 5분 polling spam 차단
        // - 새 drift (변화 ≥ tolerance) 또는 cooldown 경과 시 재발동
        // - log.warn 은 항상 유지 (운영자 grep / 로그 분석 채널)
        // 2026-04-28 (Sprint A1 QA Q5): defensive — negative/non-finite 면 default fallback.
        const cooldownMs = Math.max(0, Number.isFinite(cfg.warnAlertCooldownMs) ? cfg.warnAlertCooldownMs! : 1_800_000);
        const tolerance = Math.max(0, Number.isFinite(cfg.warnDriftDeltaToleranceSol) ? cfg.warnDriftDeltaToleranceSol! : 0.005);
        const nowMs = Date.now();
        const sinceLastAlertMs = nowMs - state.lastWarnAlertAtMs;
        const driftChanged = Math.abs(drift - state.lastWarnAlertDrift) >= tolerance;
        const shouldSendAlert =
          state.lastWarnAlertAtMs === 0 ||  // 처음 발동
          sinceLastAlertMs >= cooldownMs ||  // cooldown 경과
          driftChanged;                       // 새 drift 값
        if (shouldSendAlert) {
          state.lastWarnAlertAtMs = nowMs;
          state.lastWarnAlertDrift = drift;
          await notifier.sendCritical(
            'wallet_delta_warn',
            `Wallet delta drift ${drift.toFixed(4)} SOL (warn ≥ ${cfg.driftWarnSol}). ` +
            `observed=${observedDelta.toFixed(4)} expected=${expectedDelta.toFixed(4)}. ` +
            `Run ops:reconcile:wallet to investigate.`
          ).catch(() => {});
        } else {
          log.debug(
            `[WALLET_DELTA_WARN_DEDUP] drift=${drift.toFixed(6)} ` +
            `last=${state.lastWarnAlertDrift.toFixed(6)} elapsed=${Math.round(sinceLastAlertMs/1000)}s ` +
            `cooldown=${Math.round(cooldownMs/1000)}s — alert suppressed`
          );
        }
      }
    } catch (err) {
      state.consecutiveRpcFailures++;
      log.warn(`[WALLET_DELTA] check failed (${state.consecutiveRpcFailures}): ${err}`);
    }
  };

  // 첫 1회 즉시 + interval
  void check();
  pollerHandle = setInterval(() => { void check(); }, cfg.pollIntervalMs);
  log.info(
    `[WALLET_DELTA] poller started — interval=${cfg.pollIntervalMs}ms warn=${cfg.driftWarnSol} halt=${cfg.driftHaltSol}`
  );
}

export function stopWalletDeltaComparator(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
}

/** 테스트용 — state / poller 완전 초기화 */
export function resetWalletDeltaComparatorForTests(): void {
  state.baselineBalanceSol = null;
  state.baselineAt = null;
  state.baselineLedgerOffsets = { buys: 0, sells: 0 };
  state.lastObservedDelta = 0;
  state.lastExpectedDelta = 0;
  state.lastDrift = 0;
  state.lastCheckAt = null;
  state.consecutiveDriftBreaches = 0;
  state.consecutiveRpcFailures = 0;
  state.haltTriggered = false;
  state.lastWarnAlertAtMs = 0;
  state.lastWarnAlertDrift = 0;
  stopWalletDeltaComparator();
}

/** 테스트용 — 한 번만 check 실행 (poller 없이) */
export async function runWalletDeltaCheckOnceForTests(
  walletManager: WalletManager,
  notifier: Notifier,
  cfg: WalletDeltaComparatorConfig
): Promise<Readonly<ComparatorState>> {
  if (state.baselineBalanceSol == null) {
    const balance = await walletManager.getBalance(cfg.walletName);
    state.baselineBalanceSol = balance;
    state.baselineAt = new Date();
    state.baselineLedgerOffsets = await countLedgerLines(cfg.realtimeDataDir);
  }
  const currentBalance = await walletManager.getBalance(cfg.walletName);
  const observedDelta = currentBalance - state.baselineBalanceSol;
  const expectedDelta = await computeExpectedDelta(cfg);
  const drift = observedDelta - expectedDelta;
  state.lastObservedDelta = observedDelta;
  state.lastExpectedDelta = expectedDelta;
  state.lastDrift = drift;
  state.lastCheckAt = new Date();

  const absDrift = Math.abs(drift);
  if (absDrift >= cfg.driftWarnSol) {
    state.consecutiveDriftBreaches++;
    if (
      state.consecutiveDriftBreaches >= cfg.minSamplesBeforeAlert &&
      absDrift >= cfg.driftHaltSol &&
      !state.haltTriggered
    ) {
      const reason = `test drift ${drift.toFixed(6)} SOL >= halt ${cfg.driftHaltSol}`;
      haltAllLanes(reason);
      await notifier.sendCritical('wallet_delta_halt', reason).catch(() => {});
    } else if (state.consecutiveDriftBreaches >= cfg.minSamplesBeforeAlert) {
      // 2026-04-28 (Sprint A1): production check() 와 동일한 dedup 적용 (회귀 검증).
      // 2026-04-28 (Sprint A1 QA Q5): defensive — negative/non-finite 면 default fallback.
      const cooldownMs = Math.max(0, Number.isFinite(cfg.warnAlertCooldownMs) ? cfg.warnAlertCooldownMs! : 1_800_000);
      const tolerance = Math.max(0, Number.isFinite(cfg.warnDriftDeltaToleranceSol) ? cfg.warnDriftDeltaToleranceSol! : 0.005);
      const nowMs = Date.now();
      const sinceLastAlertMs = nowMs - state.lastWarnAlertAtMs;
      const driftChanged = Math.abs(drift - state.lastWarnAlertDrift) >= tolerance;
      const shouldSendAlert =
        state.lastWarnAlertAtMs === 0 ||
        sinceLastAlertMs >= cooldownMs ||
        driftChanged;
      if (shouldSendAlert) {
        state.lastWarnAlertAtMs = nowMs;
        state.lastWarnAlertDrift = drift;
        await notifier.sendCritical('wallet_delta_warn', `drift ${drift.toFixed(6)}`).catch(() => {});
      }
    }
  } else {
    state.consecutiveDriftBreaches = 0;
    // 2026-04-28 (Sprint A1 QA Q9): drift 회복 시 dedup state reset (production check 와 정합).
    state.lastWarnAlertAtMs = 0;
    state.lastWarnAlertDrift = 0;
  }
  return state;
}
