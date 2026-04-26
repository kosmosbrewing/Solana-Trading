// Per-pair cooldown maps — pair diversity 확보 (top pair 쏠림 방어).
// v2: scanner 주도 (scanPureWsV2Burst 가 entry 성공 시 set).
// v1: bootstrap signal 주도 (handlePureWsSignal 이 ws_burst_v2 가 아닌 source 에 한해 set).
// 둘 다 module-level Map — 모든 lane 호출이 같은 인스턴스 공유.

export const v2LastTriggerSecByPair = new Map<string, number>();

// 2026-04-21 P1: v1 (bootstrap) 경로 per-pair cooldown.
// Why: BOME(ukHH6c7m) 한 토큰에 반복 signal → duplicate guard 는 "이미 holding" 만 차단 →
// close 직후 재signal → 또 진입 → 4 consecutive losers → canary halt 조기 유발.
// v2 와 동일 메커니즘으로 close 이후에도 pair-level cooldown 적용 (config.pureWsV1PerPairCooldownSec).
export const v1LastEntrySecByPair = new Map<string, number>();

/** Test helper — scanPureWsV2Burst 이후 cooldown state 초기화 */
export function resetPureWsV2CooldownForTests(): void {
  v2LastTriggerSecByPair.clear();
}
