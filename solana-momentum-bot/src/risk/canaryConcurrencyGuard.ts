/**
 * Canary Concurrency Guard (Block 4 QA fix, 2026-04-18)
 *
 * Why: Block 4 QA 에서 `동시 max 3 ticket` guardrail 이 전역이 아니라 lane별 (cupsey 5 + pure_ws 3)
 * 로 적용되어 있다는 지적. canary 단계에서 **wallet 기준 전체 open position 수** 를 제한한다.
 *
 * 설계:
 *   - lane 별 caller 가 entry 전 `acquireCanarySlot(lane)` 호출 → 전역 cap 체크
 *   - 기존 lane별 max concurrent 와 병렬 작동 (더 엄격한 값이 이김)
 *   - close 시 `releaseCanarySlot(lane)` 호출 (에러 경로 포함 필수)
 *   - `CANARY_GLOBAL_MAX_CONCURRENT` env (default 3) 로 제어
 *   - default disabled (`CANARY_GLOBAL_CONCURRENCY_ENABLED=false`) — opt-in
 *     (paper / canary 에서만 유효, 전체 운영에 강제하지 않음)
 */
import { createModuleLogger } from '../utils/logger';
import type { EntryLane } from '../orchestration/entryIntegrity';
import { config } from '../utils/config';

const log = createModuleLogger('CanaryConcurrencyGuard');

interface GuardState {
  active: Map<EntryLane, number>;
}
const state: GuardState = { active: new Map() };

function getCount(lane: EntryLane): number {
  return state.active.get(lane) ?? 0;
}

function total(): number {
  let sum = 0;
  for (const n of state.active.values()) sum += n;
  return sum;
}

/** Entry 전 호출. 전역 cap 을 초과하면 false 반환, 이 경우 entry skip. */
export function acquireCanarySlot(lane: EntryLane): boolean {
  if (!config.canaryGlobalConcurrencyEnabled) return true;
  const max = config.canaryGlobalMaxConcurrent;
  const current = total();
  if (current >= max) {
    log.debug(
      `[CANARY_CONCURRENCY] acquire denied — lane=${lane} global=${current}/${max}`
    );
    return false;
  }
  state.active.set(lane, getCount(lane) + 1);
  return true;
}

/** Close / entry 실패 시 호출. */
export function releaseCanarySlot(lane: EntryLane): void {
  if (!config.canaryGlobalConcurrencyEnabled) return;
  const cur = getCount(lane);
  if (cur <= 0) return;
  state.active.set(lane, cur - 1);
}

export function getCanaryConcurrencySnapshot(): {
  enabled: boolean;
  maxGlobal: number;
  currentGlobal: number;
  perLane: Record<string, number>;
} {
  const perLane: Record<string, number> = {};
  for (const [k, v] of state.active) perLane[k] = v;
  return {
    enabled: config.canaryGlobalConcurrencyEnabled,
    maxGlobal: config.canaryGlobalMaxConcurrent,
    currentGlobal: total(),
    perLane,
  };
}

/** 테스트용 — 모든 카운터 초기화. */
export function resetCanaryConcurrencyGuardForTests(): void {
  state.active.clear();
}
