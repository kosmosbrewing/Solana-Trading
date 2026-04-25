/**
 * Clock 단위 테스트 (Phase H1.2)
 */
import { realClock, createFakeClock } from '../../src/utils/clock';

describe('Clock', () => {
  it('realClock.now() 는 시스템 Date.now() 와 ±100ms 이내 일치', () => {
    const sys = Date.now();
    const real = realClock.now();
    expect(Math.abs(real - sys)).toBeLessThan(100);
  });

  it('realClock.nowDate() 는 Date 객체', () => {
    const d = realClock.nowDate();
    expect(d).toBeInstanceOf(Date);
  });

  it('FakeClock 초기 시점 ISO string', () => {
    const c = createFakeClock('2026-04-16T12:00:00Z');
    expect(c.now()).toBe(new Date('2026-04-16T12:00:00Z').getTime());
    expect(c.nowDate().toISOString()).toBe('2026-04-16T12:00:00.000Z');
  });

  it('FakeClock.advance 는 결정적', () => {
    const c = createFakeClock('2026-04-16T12:00:00Z');
    c.advance(60_000);
    expect(c.nowDate().toISOString()).toBe('2026-04-16T12:01:00.000Z');
    c.advance(3600_000);
    expect(c.nowDate().toISOString()).toBe('2026-04-16T13:01:00.000Z');
  });

  it('FakeClock.setNow 절대 시간 점프', () => {
    const c = createFakeClock(0);
    c.setNow('2026-04-25T00:00:00Z');
    expect(c.nowDate().toISOString()).toBe('2026-04-25T00:00:00.000Z');
    c.setNow(1_000_000_000);
    expect(c.now()).toBe(1_000_000_000);
  });

  it('FakeClock.advance 음수 / NaN 거부', () => {
    const c = createFakeClock(0);
    expect(() => c.advance(-1)).toThrow();
    expect(() => c.advance(NaN)).toThrow();
    expect(() => c.advance(Infinity)).toThrow();
  });

  it('FakeClock 잘못된 ISO 거부', () => {
    expect(() => createFakeClock('not-a-date')).toThrow(/Invalid time literal/);
  });

  it('Date 객체 직접 주입', () => {
    const d = new Date('2026-04-25T08:00:00Z');
    const c = createFakeClock(d);
    expect(c.now()).toBe(d.getTime());
  });
});
