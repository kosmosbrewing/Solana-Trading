import {
  DEFAULT_KOL_CANDLE_TARGET_MAX,
  DEFAULT_KOL_CANDLE_TARGET_TTL_MS,
  MIN_KOL_CANDLE_TARGET_TTL_MS,
  resolveKolCandleCoverageLimits,
  selectKolCandleCoverageEvictions,
} from '../src/realtime/kolCandleCoveragePolicy';

describe('resolveKolCandleCoverageLimits', () => {
  it('passes through valid configured values', () => {
    const limits = resolveKolCandleCoverageLimits({
      configuredTargetMax: 12,
      configuredTtlMs: 10 * 60 * 1000,
      realtimeMaxSubscriptions: 30,
    });
    expect(limits).toEqual({ targetMax: 12, ttlMs: 10 * 60 * 1000 });
  });

  it('clamps targetMax to realtimeMaxSubscriptions cap', () => {
    const limits = resolveKolCandleCoverageLimits({
      configuredTargetMax: 99,
      configuredTtlMs: DEFAULT_KOL_CANDLE_TARGET_TTL_MS,
      realtimeMaxSubscriptions: 30,
    });
    expect(limits.targetMax).toBe(30);
  });

  it('falls back to defaults for non-finite inputs (env unset → NaN)', () => {
    const limits = resolveKolCandleCoverageLimits({
      configuredTargetMax: Number.NaN,
      configuredTtlMs: Number.NaN,
      realtimeMaxSubscriptions: 30,
    });
    expect(limits.targetMax).toBe(DEFAULT_KOL_CANDLE_TARGET_MAX);
    expect(limits.ttlMs).toBe(DEFAULT_KOL_CANDLE_TARGET_TTL_MS);
  });

  it('floors targetMax at 1 (not default) and enforces ttl floor', () => {
    // 운영자가 0/음수로 "줄이기" 를 의도했을 때 default 8 로 되돌리면 의도 반대 방향.
    const limits = resolveKolCandleCoverageLimits({
      configuredTargetMax: 0,
      configuredTtlMs: 1_000,
      realtimeMaxSubscriptions: 30,
    });
    expect(limits.targetMax).toBe(1);
    expect(limits.ttlMs).toBe(MIN_KOL_CANDLE_TARGET_TTL_MS);

    const negative = resolveKolCandleCoverageLimits({
      configuredTargetMax: -5,
      configuredTtlMs: 1_000,
      realtimeMaxSubscriptions: 30,
    });
    expect(negative.targetMax).toBe(1);
  });

  it('survives a broken realtimeMaxSubscriptions value', () => {
    const limits = resolveKolCandleCoverageLimits({
      configuredTargetMax: 16,
      configuredTtlMs: DEFAULT_KOL_CANDLE_TARGET_TTL_MS,
      realtimeMaxSubscriptions: Number.NaN,
    });
    // cap 정보가 깨지면 보수적으로 default(8) cap
    expect(limits.targetMax).toBe(DEFAULT_KOL_CANDLE_TARGET_MAX);
  });
});

describe('selectKolCandleCoverageEvictions', () => {
  const entry = (mint: string, expiresAtMs: number) => ({ tokenMint: mint, expiresAtMs });

  it('returns empty when below max (room exists for the new target)', () => {
    const evictions = selectKolCandleCoverageEvictions(
      [entry('a', 100), entry('b', 200)],
      8
    );
    expect(evictions).toEqual([]);
  });

  it('evicts the earliest-expiry entry at exactly max', () => {
    const evictions = selectKolCandleCoverageEvictions(
      [entry('late', 900), entry('early', 100), entry('mid', 500)],
      3
    );
    expect(evictions).toEqual(['early']);
  });

  it('evicts enough entries when max was lowered via env', () => {
    const evictions = selectKolCandleCoverageEvictions(
      [entry('a', 100), entry('b', 200), entry('c', 300), entry('d', 400)],
      2
    );
    // size 4, max 2 → 신규 1 자리 확보 위해 3개 (earliest first)
    expect(evictions).toEqual(['a', 'b', 'c']);
  });

  it('falls back to default max for invalid max values', () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(`m${i}`, i));
    expect(selectKolCandleCoverageEvictions(entries, Number.NaN)).toEqual(['m0']);
    expect(selectKolCandleCoverageEvictions(entries.slice(0, 7), Number.NaN)).toEqual([]);
  });

  it('does not mutate the input array order', () => {
    const entries = [entry('late', 900), entry('early', 100)];
    selectKolCandleCoverageEvictions(entries, 2);
    expect(entries.map((e) => e.tokenMint)).toEqual(['late', 'early']);
  });
});
