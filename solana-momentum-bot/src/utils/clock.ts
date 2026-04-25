/**
 * Clock abstraction (Phase H1.2, 2026-04-25)
 *
 * Why: Date.now() / new Date() 직접 사용은 테스트가 시스템 시계에 노출되어 fixture 시간이
 *      "오늘" 과 다르면 실패. 또한 long-running 테스트에서 ms 단위 비결정성 발생.
 *
 *      이 모듈은 모든 시간 의존을 Clock interface 로 격리한다.
 *      production: realClock (Date.now())
 *      test: createFakeClock(initialIso) — 결정적 진행
 *
 * Migration 원칙:
 *  - 신규 모듈은 Clock 주입을 default 로
 *  - 기존 모듈은 사명 critical path (riskManager / canaryAutoHalt / walletDeltaComparator) 부터 우선 전환
 *  - ESLint custom rule (Phase H4) 로 신규 Date.now() 호출 차단 예정
 *
 * 테스트 사용 예:
 *   const clock = createFakeClock('2026-04-16T12:00:00Z');
 *   const rm = new RiskManager(clock);
 *   clock.advance(60_000); // 60s 진행
 *   clock.setNow('2026-04-17T00:00:00Z'); // 절대 시간 점프
 */

export interface Clock {
  /** epoch ms (Date.now() 등가) */
  now(): number;
  /** Date 객체 — formatting / UTC 계산 등에 필요할 때 */
  nowDate(): Date;
}

export interface FakeClock extends Clock {
  /** 시간을 ms 만큼 진행 */
  advance(ms: number): void;
  /** 절대 시간으로 설정 (ISO string 또는 epoch ms) */
  setNow(time: string | number | Date): void;
}

/** Production clock — system time 사용. 모듈 default. */
export const realClock: Clock = {
  now: () => Date.now(),
  nowDate: () => new Date(),
};

/**
 * Test 용 결정적 clock.
 * @param initial 초기 시점 — ISO string (e.g. '2026-04-16T12:00:00Z'), epoch ms, 또는 Date
 */
export function createFakeClock(initial: string | number | Date = 0): FakeClock {
  let currentMs = toEpochMs(initial);
  return {
    now: () => currentMs,
    nowDate: () => new Date(currentMs),
    advance: (ms: number) => {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new Error(`FakeClock.advance: ms must be non-negative finite number, got ${ms}`);
      }
      currentMs += ms;
    },
    setNow: (time: string | number | Date) => {
      currentMs = toEpochMs(time);
    },
  };
}

function toEpochMs(t: string | number | Date): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t;
  const parsed = new Date(t).getTime();
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid time literal: ${t}`);
  }
  return parsed;
}
