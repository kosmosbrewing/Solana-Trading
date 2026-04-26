// 2026-04-25 Phase 1 P0-1: in-flight entry mutex (Set of pairAddress).
// Why: 6h 운영 로그에서 BZtgGZqx (CATCOIN) 가 09:28:53.097 + 09:28:53.191 (94ms) 두 번 PROBE_OPEN.
// 기존 duplicate guard 는 activePositions 만 본다 — async Jupiter quote 시작 후
// activePositions.set 사이의 race window 에 두 번째 signal 이 통과 가능. 이 Set 은 handler
// 진입 직후 sync 추가, 모든 exit path (성공/실패/early return) 에서 해제. ms-level race 차단.

export const inflightEntryByPair = new Set<string>();

export function resetInflightEntryForTests(): void {
  inflightEntryByPair.clear();
}
