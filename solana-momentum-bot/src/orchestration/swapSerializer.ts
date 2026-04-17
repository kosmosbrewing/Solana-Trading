/**
 * Shared Close Mutex (2026-04-17, Patch B1 확장)
 *
 * Why: cupsey 와 migration lane 은 동일 wallet (sandbox executor) 을 공유하므로,
 * 서로 다른 lane 의 close 가 동시 진행되면 `solBefore/solAfter` 측정 구간이 겹쳐서
 * `receivedSol` 과대 기록 → HWM / pnl 오염 (2026-04-17 실측 근거).
 *
 * Patch B1 초기 구현에서는 cupseyLaneHandler 모듈 내부에 mutex 가 있었으나,
 * migration lane 이 추가되며 **두 lane 이 공유하는 serializer** 가 필요해졌다.
 * 이 모듈에 단일 mutex 를 두고 양쪽 lane 에서 import 한다.
 *
 * 설계:
 *   - 단일 Promise chain (FIFO) — 한 번에 하나의 close 만 sell/balance 측정 구간 점유.
 *   - reentrant 불가 — 한 close 내부에서 serializeClose 재호출 금지 (deadlock).
 *   - 예외 안전 — task rejection 시 release 되어 다음 대기자 진행.
 */
let closeMutex: Promise<void> = Promise.resolve();

export async function serializeClose<T>(task: () => Promise<T>): Promise<T> {
  const prev = closeMutex;
  let release: () => void = () => {};
  closeMutex = new Promise<void>((resolve) => { release = resolve; });
  try {
    await prev;
    return await task();
  } finally {
    release();
  }
}

export function resetSharedCloseMutexForTests(): void {
  closeMutex = Promise.resolve();
}
