/**
 * Block 4 QA fix (2026-04-18): wallet-level 전역 canary concurrency guard.
 * lane 별 cap 과 별개로 wallet 기준 최대 ticket cap. acquire/release 누수 방지 검증.
 */
import {
  acquireCanarySlot,
  releaseCanarySlot,
  getCanaryConcurrencySnapshot,
  resetCanaryConcurrencyGuardForTests,
} from '../src/risk/canaryConcurrencyGuard';
import { config } from '../src/utils/config';

function override(key: string, value: unknown): void {
  Object.defineProperty(config, key, { value, writable: true, configurable: true });
}

describe('canaryConcurrencyGuard', () => {
  beforeEach(() => {
    resetCanaryConcurrencyGuardForTests();
    override('canaryGlobalConcurrencyEnabled', true);
    override('canaryGlobalMaxConcurrent', 3);
  });

  it('enforces global cap across multiple lanes', () => {
    expect(acquireCanarySlot('cupsey')).toBe(true);
    expect(acquireCanarySlot('pure_ws_breakout')).toBe(true);
    expect(acquireCanarySlot('cupsey')).toBe(true); // 3/3
    expect(acquireCanarySlot('pure_ws_breakout')).toBe(false); // denied
    const snap = getCanaryConcurrencySnapshot();
    expect(snap.currentGlobal).toBe(3);
    expect(snap.perLane.cupsey).toBe(2);
    expect(snap.perLane.pure_ws_breakout).toBe(1);
  });

  it('releases slot for reuse', () => {
    acquireCanarySlot('cupsey');
    acquireCanarySlot('pure_ws_breakout');
    acquireCanarySlot('cupsey');
    expect(acquireCanarySlot('cupsey')).toBe(false);
    releaseCanarySlot('cupsey');
    expect(acquireCanarySlot('pure_ws_breakout')).toBe(true);
  });

  it('release for non-existent lane is no-op (safe)', () => {
    releaseCanarySlot('strategy_d');
    const snap = getCanaryConcurrencySnapshot();
    expect(snap.currentGlobal).toBe(0);
  });

  it('disabled guard always allows acquire (no-op)', () => {
    override('canaryGlobalConcurrencyEnabled', false);
    // acquire many — all true
    for (let i = 0; i < 10; i++) {
      expect(acquireCanarySlot('cupsey')).toBe(true);
    }
    const snap = getCanaryConcurrencySnapshot();
    expect(snap.enabled).toBe(false);
    // state 는 변경되지 않음 (enabled=false 시 skip)
    expect(snap.currentGlobal).toBe(0);
  });

  it('respects custom max via config', () => {
    override('canaryGlobalMaxConcurrent', 1);
    expect(acquireCanarySlot('cupsey')).toBe(true);
    expect(acquireCanarySlot('pure_ws_breakout')).toBe(false);
  });
});
