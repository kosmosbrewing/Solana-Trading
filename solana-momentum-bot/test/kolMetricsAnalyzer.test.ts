/**
 * Tests for scripts/kol-metrics-analyzer.ts
 *
 * 검증:
 *   1. 4-class 분류 분기 (whale / scalper / swing_accumulator / momentum_confirmer / unknown)
 *   2. trimmedMedian outlier 제외 (top 5% / bottom 5%)
 *   3. diffStyle bucket (match / change / newly_classified / sample_too_small)
 *   4. computeKolMetric: re-buy density + first-sell hold time 계산
 */
import {
  classifyStyle,
  trimmedMedian,
  diffStyle,
  computeKolMetric,
  type KolMetric,
  type KolTxRecord,
} from '../scripts/kol-metrics-analyzer';

const baseMetric = (override: Partial<KolMetric> = {}): KolMetric => ({
  kolId: 'test',
  txCount30d: 50,
  buyCount30d: 25,
  sellCount30d: 25,
  avgTicketSol: 0.5,
  medianHoldTimeMs: 30 * 60 * 1000, // 30분 — momentum_confirmer
  reBuyDensity: 0.2,
  timeToFirstSellMs: 30 * 60 * 1000,
  uniqueMintsBought30d: 20,
  ...override,
});

describe('classifyStyle 4-class 분기', () => {
  it('sample 부족 (<10 tx) → unknown', () => {
    expect(classifyStyle(baseMetric({ txCount30d: 5 }))).toBe('unknown');
  });

  it('avg ticket ≥ 5 SOL → whale (hold time 무관)', () => {
    expect(classifyStyle(baseMetric({ avgTicketSol: 5.0 }))).toBe('whale');
    expect(classifyStyle(baseMetric({ avgTicketSol: 12.7, medianHoldTimeMs: 60_000 }))).toBe('whale');
  });

  it('hold < 5분 → scalper', () => {
    expect(classifyStyle(baseMetric({ medianHoldTimeMs: 4 * 60 * 1000 }))).toBe('scalper');
    expect(classifyStyle(baseMetric({ medianHoldTimeMs: 60_000 }))).toBe('scalper');
  });

  it('hold > 1h → swing_accumulator', () => {
    expect(classifyStyle(baseMetric({ medianHoldTimeMs: 2 * 60 * 60 * 1000 }))).toBe('swing_accumulator');
  });

  it('5분 ≤ hold ≤ 1h → momentum_confirmer', () => {
    expect(classifyStyle(baseMetric({ medianHoldTimeMs: 30 * 60 * 1000 }))).toBe('momentum_confirmer');
  });

  it('whale 우선순위 > scalper (high ticket + short hold)', () => {
    expect(classifyStyle(baseMetric({ avgTicketSol: 7, medianHoldTimeMs: 1000 }))).toBe('whale');
  });
});

describe('trimmedMedian outlier 제외', () => {
  it('빈 배열 → 0', () => {
    expect(trimmedMedian([])).toBe(0);
  });

  it('n<3 은 trim 없이 median', () => {
    expect(trimmedMedian([10])).toBe(10);
    expect(trimmedMedian([5, 100])).toBe(100); // floor(2/2)=1 → sorted[1]=100
  });

  it('outlier 가 median 을 흔들지 않음', () => {
    // 100 개 값 중 하나만 거대한 outlier — 5% trim 후 median 정상
    const values = Array.from({ length: 99 }, (_, i) => i + 1).concat([1_000_000]);
    const med = trimmedMedian(values);
    expect(med).toBeLessThan(100); // outlier 없으면 50, 있으면 ≤55
    expect(med).toBeGreaterThan(40);
  });

  it('대칭 분포 + 양쪽 outlier 제거', () => {
    const values = [-1_000_000, ...Array.from({ length: 100 }, (_, i) => i), 1_000_000];
    const med = trimmedMedian(values);
    expect(med).toBeGreaterThanOrEqual(45);
    expect(med).toBeLessThanOrEqual(55);
  });
});

describe('diffStyle', () => {
  it('auto=unknown → sample_too_small', () => {
    expect(diffStyle('scalper', 'unknown')).toBe('sample_too_small');
    expect(diffStyle(undefined, 'unknown')).toBe('sample_too_small');
  });

  it('current 미설정 + auto != unknown → newly_classified', () => {
    expect(diffStyle(undefined, 'scalper')).toBe('newly_classified');
    expect(diffStyle('unknown', 'whale')).toBe('newly_classified');
  });

  it('current == auto → match', () => {
    expect(diffStyle('scalper', 'scalper')).toBe('match');
  });

  it('current != auto → change', () => {
    expect(diffStyle('longhold', 'scalper')).toBe('change');
    expect(diffStyle('hybrid', 'whale')).toBe('change');
  });
});

describe('computeKolMetric', () => {
  const mkTx = (
    o: Partial<KolTxRecord> & { ts: number; act: 'buy' | 'sell'; mint: string; sol?: number },
  ): KolTxRecord => ({
    kolId: 'k1',
    walletAddress: 'W1',
    tier: 'A',
    tokenMint: o.mint,
    action: o.act,
    timestamp: o.ts,
    txSignature: `sig_${o.ts}`,
    solAmount: o.sol,
  });

  it('buy → 첫 sell 까지 hold 계산 (mint 별 첫 매칭)', () => {
    const t0 = 1_000_000_000_000;
    const txs: KolTxRecord[] = [
      mkTx({ ts: t0, act: 'buy', mint: 'M1', sol: 0.5 }),
      mkTx({ ts: t0 + 60_000, act: 'sell', mint: 'M1' }), // 1분 hold
      mkTx({ ts: t0 + 120_000, act: 'buy', mint: 'M2', sol: 0.5 }),
      mkTx({ ts: t0 + 120_000 + 600_000, act: 'sell', mint: 'M2' }), // 10분 hold
    ];
    const m = computeKolMetric('k1', txs);
    expect(m.buyCount30d).toBe(2);
    expect(m.sellCount30d).toBe(2);
    // median of [60_000, 600_000] (n<3 path) = sorted[1] = 600_000
    expect(m.medianHoldTimeMs).toBe(600_000);
    expect(m.uniqueMintsBought30d).toBe(2);
    expect(m.avgTicketSol).toBeCloseTo(0.5, 3);
  });

  it('re-buy density: 60s 이내 추가 buy 평균', () => {
    const t0 = 1_000_000_000_000;
    const txs: KolTxRecord[] = [
      mkTx({ ts: t0, act: 'buy', mint: 'M1', sol: 0.1 }),
      mkTx({ ts: t0 + 30_000, act: 'buy', mint: 'M1', sol: 0.1 }), // re-buy within 60s
      mkTx({ ts: t0 + 50_000, act: 'buy', mint: 'M1', sol: 0.1 }), // re-buy within 60s
      mkTx({ ts: t0 + 200_000, act: 'buy', mint: 'M2', sol: 0.1 }), // single
    ];
    const m = computeKolMetric('k1', txs);
    // M1 has 2 re-buys, M2 has 0 → avg = 2/2 = 1
    expect(m.reBuyDensity).toBe(1);
  });

  it('빈 tx → 모두 0', () => {
    const m = computeKolMetric('empty', []);
    expect(m.txCount30d).toBe(0);
    expect(m.medianHoldTimeMs).toBe(0);
    expect(m.avgTicketSol).toBe(0);
  });
});
