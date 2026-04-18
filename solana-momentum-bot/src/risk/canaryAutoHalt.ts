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
import { triggerEntryHalt, type EntryLane } from '../orchestration/entryIntegrity';
import { config } from '../utils/config';

const log = createModuleLogger('CanaryAutoHalt');

export interface CanaryAutoHaltConfig {
  enabled: boolean;
  maxConsecutiveLosers: number;      // default 5
  maxCanaryBudgetSol: number;        // default 0.5 (10 trades × 0.05 loss 대비)
  maxTradesPerCanary: number;        // default 100 (canary 평가 윈도 = 50 기준, 여유 2x)
  minLossToCountSol: number;         // default 0 — 모든 음수 close 가 loss 로 카운트 (작은 flat close 도 포함)
}

interface LaneCanaryState {
  tradeCount: number;
  consecutiveLosers: number;
  cumulativePnlSol: number;
  lastHaltReason: string | null;
}

const DEFAULT_LANES: EntryLane[] = ['cupsey', 'migration', 'main', 'strategy_d', 'pure_ws_breakout'];

const laneStates: Map<EntryLane, LaneCanaryState> = new Map();

function getLane(lane: EntryLane): LaneCanaryState {
  let st = laneStates.get(lane);
  if (!st) {
    st = { tradeCount: 0, consecutiveLosers: 0, cumulativePnlSol: 0, lastHaltReason: null };
    laneStates.set(lane, st);
  }
  return st;
}

function readConfig(): CanaryAutoHaltConfig {
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
  const cfg = readConfig();
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
