/**
 * Canary Auto-Halt (Block 4, 2026-04-18)
 *
 * Why: Block 3 의 `pure_ws_breakout` 은 loose gate 라 초기 entry 양이 cupsey 대비 많을 가능성.
 * Wallet Stop Guard (0.8 SOL) / wallet delta comparator (drift) 는 전체 wallet 보호이지만,
 * **특정 lane 의 연속 손실 / 예산 소진** 에 대한 per-lane automatic circuit-breaker 는 아직 없다.
 *
 * 본 모듈은 canary 단계에서 다음 위험을 자동 차단한다:
 *   1) 연속 loser streak (기본 5) → 해당 lane entry halt
 *   2) 누적 PnL 하락폭 (canary start 대비 `> X SOL`) → 해당 lane entry halt
 *   3) 누적 trade 수 초과 (canary budget, 기본 100) → 해당 lane entry halt (평가 단계 종료)
 *
 * 설계 원칙:
 *   - per-lane isolated state (cupsey / pure_ws_breakout / migration / strategy_d / main)
 *   - `entryIntegrity.triggerEntryHalt(lane, reason)` 로 위임 — halt 경로 하나로 통일
 *   - 운영자 reset 필수 (auto-recover 없음 — false halt 보다 false unblock 이 더 위험)
 *   - close 이벤트에서 호출 (handler 의 closePosition 후에 `reportCanaryClose(lane, pnl)`)
 */
import { createModuleLogger } from '../utils/logger';
import {
  triggerEntryHalt,
  resetEntryHalt,
  getAllLaneIntegrityState,
  type EntryLane,
} from '../state/entryHaltState';
import { config } from '../utils/config';

const log = createModuleLogger('CanaryAutoHalt');

export interface CanaryAutoHaltConfig {
  enabled: boolean;
  maxConsecutiveLosers: number;      // default 5
  maxCanaryBudgetSol: number;        // default 0.5 (10 trades × 0.05 loss 대비)
  maxTradesPerCanary: number;        // default 200 = Stage 4 scale/retire decision gate (2026-04-21 refinement)
  minLossToCountSol: number;         // default 0 — 모든 음수 close 가 loss 로 카운트 (작은 flat close 도 포함)
}

interface LaneCanaryState {
  tradeCount: number;
  consecutiveLosers: number;
  cumulativePnlSol: number;
  lastHaltReason: string | null;
}

const DEFAULT_LANES: EntryLane[] = ['cupsey', 'migration', 'main', 'strategy_d', 'pure_ws_breakout', 'pure_ws_swing_v2'];

const laneStates: Map<EntryLane, LaneCanaryState> = new Map();

function getLane(lane: EntryLane): LaneCanaryState {
  let st = laneStates.get(lane);
  if (!st) {
    st = { tradeCount: 0, consecutiveLosers: 0, cumulativePnlSol: 0, lastHaltReason: null };
    laneStates.set(lane, st);
  }
  return st;
}

function readConfig(lane?: EntryLane): CanaryAutoHaltConfig {
  // 2026-04-26: pure_ws_swing_v2 는 별도 cap (Stage 4 SCALE 후 opt-in canary).
  // Real Asset Guard 정합 — swing-v2 도 ticket 0.01 / max budget 0.1 / max consec 5 등 자체 정책.
  if (lane === 'pure_ws_swing_v2') {
    return {
      enabled: config.canaryAutoHaltEnabled,
      maxConsecutiveLosers: config.canarySwingV2MaxConsecLosers,
      maxCanaryBudgetSol: config.canarySwingV2MaxBudgetSol,
      maxTradesPerCanary: config.canarySwingV2MaxTrades,
      minLossToCountSol: config.canaryMinLossToCountSol,
    };
  }
  return {
    enabled: config.canaryAutoHaltEnabled,
    maxConsecutiveLosers: config.canaryMaxConsecutiveLosers,
    maxCanaryBudgetSol: config.canaryMaxBudgetSol,
    maxTradesPerCanary: config.canaryMaxTrades,
    minLossToCountSol: config.canaryMinLossToCountSol,
  };
}

/** Close 이벤트 보고 — handler 가 매 close 마다 호출한다. */
export function reportCanaryClose(lane: EntryLane, pnlSol: number): void {
  const cfg = readConfig(lane);
  if (!cfg.enabled) return;

  const st = getLane(lane);
  st.tradeCount++;
  st.cumulativePnlSol += pnlSol;

  if (pnlSol < -cfg.minLossToCountSol) {
    st.consecutiveLosers++;
  } else {
    st.consecutiveLosers = 0;
  }

  log.debug(
    `[CANARY] lane=${lane} trade#${st.tradeCount} pnl=${pnlSol.toFixed(6)} ` +
    `streak=${st.consecutiveLosers} cum=${st.cumulativePnlSol.toFixed(6)}`
  );

  // ─── Circuit breaker checks ───
  if (st.consecutiveLosers >= cfg.maxConsecutiveLosers) {
    const reason = `consecutive losers ${st.consecutiveLosers} >= ${cfg.maxConsecutiveLosers}`;
    if (st.lastHaltReason !== reason) {
      st.lastHaltReason = reason;
      log.warn(`[CANARY_HALT] lane=${lane} ${reason} — entry blocked`);
      triggerEntryHalt(lane, reason);
    }
    return;
  }

  if (st.cumulativePnlSol <= -cfg.maxCanaryBudgetSol) {
    const reason = `canary budget exhausted ${st.cumulativePnlSol.toFixed(4)} <= -${cfg.maxCanaryBudgetSol}`;
    if (st.lastHaltReason !== reason) {
      st.lastHaltReason = reason;
      log.warn(`[CANARY_HALT] lane=${lane} ${reason} — entry blocked`);
      triggerEntryHalt(lane, reason);
    }
    return;
  }

  if (st.tradeCount >= cfg.maxTradesPerCanary) {
    const reason = `canary trade count reached ${st.tradeCount} >= ${cfg.maxTradesPerCanary}`;
    if (st.lastHaltReason !== reason) {
      st.lastHaltReason = reason;
      log.info(`[CANARY_COMPLETE] lane=${lane} ${reason} — entry paused for promotion review`);
      triggerEntryHalt(lane, reason);
    }
  }
}

export function getCanaryState(lane: EntryLane): Readonly<LaneCanaryState> {
  return getLane(lane);
}

export function getAllCanaryStates(): Record<EntryLane, Readonly<LaneCanaryState>> {
  const out = {} as Record<EntryLane, LaneCanaryState>;
  for (const lane of DEFAULT_LANES) {
    out[lane] = { ...getLane(lane) };
  }
  return out;
}

/**
 * 2026-04-21 P2: halt 자동 해제 — halt 이후 일정 시간 경과시 consecutiveLosers 만 0 으로 리셋.
 * budget cap (cumulativePnlSol 기반) 과 tradeCount 는 유지 — 실제 위험 guard 는 그대로.
 *
 * Why: 기존 halt 는 운영자 수동 `resetEntryHalt` 만으로 해제되어 Phase 1-3 관측 데이터 축적이
 * 운영자 부재 시 무한 지연. 4-consec-loser streak 은 표본 부족 (uniform random 이어도 빈번).
 * 시간 경과 + pair diversity 확보 후 재시도는 convexity mission 과 부합.
 *
 * Caller: HealthMonitor interval (60s 주기).
 */
export function checkAndAutoResetHalt(lane: EntryLane, nowMs: number = Date.now()): boolean {
  if (!config.canaryAutoResetEnabled) return false;
  const haltStates = getAllLaneIntegrityState();
  const lst = haltStates[lane];
  if (!lst?.haltActive || !lst.triggeredAt) return false;

  const elapsedSec = (nowMs - lst.triggeredAt.getTime()) / 1000;
  if (elapsedSec < config.canaryAutoResetMinSec) return false;

  const st = getLane(lane);
  // budget 초과로 halt 된 경우는 auto-reset 금지 — 실제 자산 보호 유지.
  // 2026-04-26: lane 별 budget cap 사용 (swing-v2 는 별도 cap).
  const laneCfg = readConfig(lane);
  if (config.canaryAutoHaltEnabled && st.cumulativePnlSol <= -laneCfg.maxCanaryBudgetSol) {
    log.info(
      `[CANARY_AUTO_RESET] lane=${lane} skipped — budget exhausted ` +
      `(cumulative=${st.cumulativePnlSol.toFixed(4)} <= -${laneCfg.maxCanaryBudgetSol})`
    );
    return false;
  }

  log.info(
    `[CANARY_AUTO_RESET] lane=${lane} halt cleared after ${Math.round(elapsedSec)}s ` +
    `(consecutiveLosers ${st.consecutiveLosers} → 0, budget/tradeCount 유지)`
  );
  st.consecutiveLosers = 0;
  st.lastHaltReason = null;
  resetEntryHalt(lane, 'auto_after_cooldown');
  return true;
}

/** 전체 lane 에 대해 auto reset 체크 — HealthMonitor interval 에서 호출. */
export function checkAllLanesAutoResetHalt(): void {
  for (const lane of DEFAULT_LANES) {
    checkAndAutoResetHalt(lane);
  }
}

/** 운영자 수동 reset — entryIntegrity halt 는 resetEntryHalt 로 별도 해제. */
export function resetCanaryLaneState(lane: EntryLane): void {
  laneStates.set(lane, {
    tradeCount: 0,
    consecutiveLosers: 0,
    cumulativePnlSol: 0,
    lastHaltReason: null,
  });
  log.info(`[CANARY_RESET] lane=${lane} cleared`);
}

export function resetAllCanaryStatesForTests(): void {
  laneStates.clear();
}
