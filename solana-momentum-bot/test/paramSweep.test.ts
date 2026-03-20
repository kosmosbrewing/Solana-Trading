import { generateValues, generateGrid, runParameterSweep, formatSweepReport, SweepConfig } from '../src/backtest/paramSweep';
import { Candle } from '../src/utils/types';

// ─── Unit: Grid Generation ───

describe('ParamSweep — Grid Generation', () => {
  it('generates correct values for a range', () => {
    const values = generateValues({ min: 1.0, max: 3.0, step: 1.0 });
    expect(values).toEqual([1.0, 2.0, 3.0]);
  });

  it('generates cartesian product', () => {
    const grid = generateGrid({
      a: { min: 1, max: 2, step: 1 },
      b: { min: 10, max: 20, step: 10 },
    });
    expect(grid).toHaveLength(4);
    expect(grid).toContainEqual({ a: 1, b: 10 });
    expect(grid).toContainEqual({ a: 1, b: 20 });
    expect(grid).toContainEqual({ a: 2, b: 10 });
    expect(grid).toContainEqual({ a: 2, b: 20 });
  });

  it('handles single-step range', () => {
    const values = generateValues({ min: 0.5, max: 0.5, step: 0.1 });
    expect(values).toEqual([0.5]);
  });
});

// ─── Integration: Sweep with minimal candles ───

function makeCandles(count: number): Candle[] {
  const base = new Date('2024-01-01T00:00:00Z');
  return Array.from({ length: count }, (_, i) => {
    const price = 1.0 + Math.sin(i * 0.1) * 0.1;
    const vol = 10000 + Math.random() * 5000;
    return {
      pairAddress: 'TEST-PAIR',
      timestamp: new Date(base.getTime() + i * 300_000),
      intervalSec: 300,
      open: price,
      high: price * 1.02,
      low: price * 0.98,
      close: price + (i % 3 === 0 ? 0.01 : -0.005),
      volume: vol,
      buyVolume: vol * 0.6,
      sellVolume: vol * 0.4,
      tradeCount: 50,
    };
  });
}

describe('ParamSweep — Integration', () => {
  const candles = makeCandles(200);

  it('runs a minimal sweep and returns sorted results', () => {
    const config: SweepConfig = {
      params: {
        maxRiskPerTrade: { min: 0.01, max: 0.02, step: 0.01 },
      },
      objective: 'sharpeRatio',
      topN: 5,
    };

    const results = runParameterSweep(candles, 'volume_spike', config);

    // 결과가 있을 수도, 없을 수도 (candle data에 따라)
    // 최소한 에러 없이 실행되는지 확인
    expect(Array.isArray(results)).toBe(true);
    if (results.length > 1) {
      // 정렬 확인
      for (let i = 1; i < results.length; i++) {
        expect(results[i].rank).toBe(i + 1);
      }
    }
  });

  it('filters by constraints', () => {
    const config: SweepConfig = {
      params: {
        maxRiskPerTrade: { min: 0.01, max: 0.02, step: 0.01 },
      },
      objective: 'netPnlPct',
      constraints: {
        minTrades: 999, // 불가능한 조건 → 결과 0
      },
      topN: 10,
    };

    const results = runParameterSweep(candles, 'volume_spike', config);
    expect(results).toHaveLength(0);
  });

  it('formats report without errors', () => {
    const config: SweepConfig = {
      params: {
        maxRiskPerTrade: { min: 0.01, max: 0.02, step: 0.01 },
      },
      objective: 'sharpeRatio',
      topN: 3,
    };

    const results = runParameterSweep(candles, 'volume_spike', config);
    const report = formatSweepReport(results, 'sharpeRatio');
    expect(typeof report).toBe('string');
  });
});
