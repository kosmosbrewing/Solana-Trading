/**
 * Entry Halt State (Phase H2.2, 2026-04-26)
 *
 * Why: ESLint `no-restricted-imports` 규칙 — risk/* 가 orchestration/* 를 import 못 함.
 *      그러나 `walletDeltaComparator` / `canaryAutoHalt` / `canaryConcurrencyGuard` 가
 *      `triggerEntryHalt` / `EntryLane` 을 사용해야 함. 이는 **state machine 데이터** 이지
 *      orchestration 의 책임이 아님.
 *
 * 본 모듈은 entry halt 의 **순수 상태 머신** 만 담당. orchestration 의 ledger / persist 로직은
 * `src/orchestration/entryIntegrity.ts` 에 그대로 유지.
 *
 * Layer 정합:
 *   src/state/entryHaltState.ts          ← lower (순수 상태)
 *      ↑                          ↑
 *   src/risk/* (canaryAutoHalt 등)        src/orchestration/entryIntegrity.ts
 *                                              ↑
 *                                         src/orchestration/* (handler, persist)
 *
 * No external deps — utils/logger 외 import 없음.
 */
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('EntryHaltState');

export type EntryLane = 'cupsey' | 'migration' | 'main' | 'strategy_d' | 'pure_ws_breakout' | 'pure_ws_swing_v2';

export interface LaneIntegrityState {
  haltActive: boolean;
  triggeredAt: Date | null;
  triggerReason: string | null;
  failCount: number;
}

const laneState: Map<EntryLane, LaneIntegrityState> = new Map();

function getLaneState(lane: EntryLane): LaneIntegrityState {
  let st = laneState.get(lane);
  if (!st) {
    st = { haltActive: false, triggeredAt: null, triggerReason: null, failCount: 0 };
    laneState.set(lane, st);
  }
  return st;
}

// ─── Halt API ───

export function isEntryHaltActive(lane: EntryLane): boolean {
  return getLaneState(lane).haltActive;
}

export function triggerEntryHalt(lane: EntryLane, reason: string): void {
  const st = getLaneState(lane);
  if (st.haltActive) return;
  st.haltActive = true;
  st.triggeredAt = new Date();
  st.triggerReason = reason;
  st.failCount += 1;
  log.warn(`[ENTRY_HALT_TRIGGERED] lane=${lane} reason=${reason} — NEW ENTRIES BLOCKED`);
}

export function resetEntryHalt(lane: EntryLane, reason = 'manual'): void {
  const st = getLaneState(lane);
  if (!st.haltActive) {
    log.info(`[ENTRY_HALT_RESET] lane=${lane} not active — noop (${reason})`);
    return;
  }
  log.info(`[ENTRY_HALT_RESET] lane=${lane} cleared by ${reason}`);
  st.haltActive = false;
  st.triggeredAt = null;
  st.triggerReason = null;
}

export function getAllLaneIntegrityState(): Record<EntryLane, Readonly<LaneIntegrityState>> {
  const out = {} as Record<EntryLane, LaneIntegrityState>;
  for (const lane of ['cupsey', 'migration', 'main', 'strategy_d', 'pure_ws_breakout'] as EntryLane[]) {
    out[lane] = { ...getLaneState(lane) };
  }
  return out;
}

export function resetAllEntryHaltsForTests(): void {
  laneState.clear();
}
