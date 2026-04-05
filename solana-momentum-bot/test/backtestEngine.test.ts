import { BacktestEngine } from '../src/backtest';
import type { AttentionScore } from '../src/event/types';
import type { Candle, Order, Signal } from '../src/utils/types';
import * as strategy from '../src/strategy';

describe('BacktestEngine parity', () => {
  it('can require AttentionScore in backtest gate inputs', () => {
    const engine = new BacktestEngine({ requireAttentionScore: true });
    const result = engine["evaluateSignalGates"](makeSignal(), [makeCandle()], 'pair-1');

    expect(result.rejected).toBe(true);
    expect(result.filterReason).toBe('not_trending');
  });

  it('exits on exhaustion when live monitor conditions are met (after min 2-bar hold)', () => {
    const engine = new BacktestEngine();
    const trade = engine["simulateTrade"](
      makeOrder(),
      [
        makeCandle({ timestamp: new Date('2026-03-15T00:00:00Z'), close: 1.0, high: 1.02, low: 0.98, volume: 100 }),
        // bar 1: 최소 보유 기간 (2봉) — exhaustion 미적용
        makeCandle({ timestamp: new Date('2026-03-15T00:05:00Z'), open: 1.0, close: 1.12, high: 1.16, low: 1.0, volume: 200 }),
        // bar 2: 2봉 경과 후 exhaustion 발생 (body shrink + volume decline)
        makeCandle({ timestamp: new Date('2026-03-15T00:10:00Z'), open: 1.12, close: 1.14, high: 1.2, low: 1.11, volume: 80 }),
      ],
      0,
      120,
      1,
      'volume_spike',
      'pair-1'
    );

    expect(trade?.exitReason).toBe('EXHAUSTION');
    expect(trade?.exitPrice).toBeCloseTo(1.14, 6);
  });

  it('uses RSI-based adaptive trailing in backtest exits', () => {
    const engine = new BacktestEngine();
    const trade = engine["simulateTrade"](
      makeOrder({ takeProfit1: 1.8, takeProfit2: 2.0 }),
      [
        makeCandle({ timestamp: new Date('2026-03-15T00:00:00Z'), open: 1.0, close: 1.0, high: 1.01, low: 0.99 }),
        makeCandle({ timestamp: new Date('2026-03-15T00:05:00Z'), open: 1.0, close: 1.03, high: 1.04, low: 0.99, volume: 100 }),
        makeCandle({ timestamp: new Date('2026-03-15T00:10:00Z'), open: 1.03, close: 1.02, high: 1.04, low: 1.01, volume: 110 }),
        makeCandle({ timestamp: new Date('2026-03-15T00:15:00Z'), open: 1.02, close: 1.05, high: 1.06, low: 1.01, volume: 120 }),
        makeCandle({ timestamp: new Date('2026-03-15T00:20:00Z'), open: 1.05, close: 1.04, high: 1.06, low: 1.03, volume: 130 }),
        makeCandle({ timestamp: new Date('2026-03-15T00:25:00Z'), open: 1.04, close: 1.07, high: 1.08, low: 1.03, volume: 140 }),
        makeCandle({ timestamp: new Date('2026-03-15T00:30:00Z'), open: 1.07, close: 1.06, high: 1.08, low: 1.05, volume: 150 }),
        makeCandle({ timestamp: new Date('2026-03-15T00:35:00Z'), open: 1.06, close: 1.1, high: 1.11, low: 1.05, volume: 160 }),
        makeCandle({ timestamp: new Date('2026-03-15T00:40:00Z'), open: 1.1, close: 1.06, high: 1.11, low: 1.05, volume: 170 }),
      ],
      0,
      180,
      2,
      'volume_spike',
      'pair-1'
    );

    expect(trade?.exitReason).toBe('TRAILING_STOP');
    expect(trade?.exitPrice).toBeCloseTo(1.06, 6);
  });

  it('accepts a configured static AttentionScore for backtest gate scoring', () => {
    const attentionScore: AttentionScore = {
      tokenMint: 'pair-1',
      tokenSymbol: 'PAIR',
      attentionScore: 80,
      components: {
        narrativeStrength: 20,
        sourceQuality: 15,
        timing: 15,
        tokenSpecificity: 15,
        historicalPattern: 15,
      },
      narrative: 'static backtest event',
      sources: ['test'],
      detectedAt: '2026-03-15T00:00:00Z',
      expiresAt: '2026-03-15T01:00:00Z',
      confidence: 'high',
    };
    const engine = new BacktestEngine({
      requireAttentionScore: true,
      gateAttentionScore: attentionScore,
    });
    const result = engine["evaluateSignalGates"](makeSignal(), [makeCandle()], 'pair-1');

    expect(result.rejected).toBe(false);
    expect(result.attentionScore).toEqual(attentionScore);
  });

  it('passes configured execution viability thresholds into backtest gate evaluation', () => {
    const engine = new BacktestEngine({
      gatePoolInfo: {
        tvl: 1_000,
        tokenAgeHours: 24,
        top10HolderPct: 0.8,
        lpBurned: null,
        ownershipRenounced: null,
      },
      executionRrReject: 1.0,
      executionRrPass: 1.2,
      executionRrBasis: 'tp1',
    });

    const result = engine["evaluateSignalGates"](makeSignal(), [makeCandle()], 'pair-1');

    expect(result.rejected).toBe(true);
    expect(result.filterReason).toContain('poor_execution_viability');
  });

  it('does not leak buy-ratio fallback across pairs', () => {
    const engine = new BacktestEngine({ minBuyRatio: 0.65 });

    engine["evaluateSignalGates"](
      makeSignal(),
      [makeCandle({ buyVolume: 0, sellVolume: 0 }), makeCandle({ buyVolume: 0, sellVolume: 0, timestamp: new Date('2026-03-15T00:05:00Z') })],
      'pair-no-volume'
    );
    expect(engine["config"].minBuyRatio).toBe(0.65);

    const withBuySellVolume = engine["evaluateSignalGates"](
      makeSignal(),
      [makeCandle({ buyVolume: 0.4, sellVolume: 0.6 }), makeCandle({ buyVolume: 0.3, sellVolume: 0.7, timestamp: new Date('2026-03-15T00:05:00Z') })],
      'pair-with-volume'
    );

    expect(withBuySellVolume.rejected).toBe(true);
    expect(withBuySellVolume.filterReason).toContain('buy_ratio');
  });

  it('replays timeline AttentionScore entries by candle timestamp', () => {
    const timelineEvent = {
      tokenMint: 'pair-1',
      tokenSymbol: 'PAIR',
      attentionScore: 72,
      components: {
        narrativeStrength: 20,
        sourceQuality: 15,
        timing: 15,
        tokenSpecificity: 12,
        historicalPattern: 10,
      },
      narrative: 'timeline event',
      sources: ['timeline'],
      detectedAt: '2026-03-15T00:05:00Z',
      expiresAt: '2026-03-15T00:15:00Z',
      confidence: 'high' as const,
    };
    const engine = new BacktestEngine({
      requireAttentionScore: true,
      attentionScoreTimeline: [timelineEvent],
    });

    const preEvent = engine["evaluateSignalGates"](makeSignal(), [
      makeCandle({ timestamp: new Date('2026-03-15T00:00:00Z') }),
    ], 'pair-1');
    const inWindow = engine["evaluateSignalGates"](makeSignal(), [
      makeCandle({ timestamp: new Date('2026-03-15T00:10:00Z') }),
    ], 'pair-1');

    expect(preEvent.rejected).toBe(true);
    expect(preEvent.filterReason).toBe('not_trending');
    expect(inWindow.rejected).toBe(false);
    expect(inWindow.attentionScore?.attentionScore).toBe(72);
  });

  it('enforces max-concurrent=1 in combined portfolio simulation', () => {
    const engine = new BacktestEngine();
    const emptyResult = {
      config: {},
      pairAddress: 'pair-1',
      strategy: 'volume_spike',
      candleCount: 0,
      dateRange: { start: new Date('2026-03-15T00:00:00Z'), end: new Date('2026-03-15T00:00:00Z') },
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      grossPnl: 0,
      netPnl: 0,
      netPnlPct: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      sharpeRatio: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      largestWin: 0,
      largestLoss: 0,
      avgHoldingBars: 0,
      rejections: {
        dailyLimit: 0,
        drawdownHalt: 0,
        cooldown: 0,
        positionOpen: 0,
        zeroSize: 0,
        executionViability: 0,
        gradeFiltered: 0,
        safetyFiltered: 0,
      },
      gradeDistribution: { A: 0, B: 0, C: 0 },
      trades: [],
      equityCurve: [],
      finalEquity: 10,
    };
    engine["run"] = jest.fn()
      .mockReturnValueOnce({ ...emptyResult, strategy: 'volume_spike' })
      .mockReturnValueOnce({ ...emptyResult, strategy: 'fib_pullback' });
    engine["buildCombinedCandidates"] = jest.fn().mockReturnValue([
      { signal: makeSignal(), candles: [makeCandle()], timeStopMinutes: 30 },
      { signal: { ...makeSignal(), strategy: 'fib_pullback' as const }, candles: [makeCandle()], timeStopMinutes: 60 },
    ]);
    engine["attemptCandidateTrade"] = jest.fn((riskState: { balance: number }, _candidate: unknown, _candles: unknown, currentIndex: number) => {
      if (riskState.balance !== 10) return null;
      riskState.balance = 11;
      return {
        id: 1,
        strategy: 'volume_spike',
        pairAddress: 'pair-1',
        entryPrice: 1,
        stopLoss: 0.9,
        exitPrice: 1.1,
        quantity: 1,
        pnlSol: 1,
        pnlPct: 0.1,
        exitReason: 'TAKE_PROFIT_2',
        entryTime: new Date('2026-03-15T00:00:00Z'),
        exitTime: new Date('2026-03-15T00:05:00Z'),
        entryIdx: currentIndex,
        exitIdx: currentIndex,
        peakPrice: 1.1,
        drawdownFromPeak: 0,
      };
    });

    const result = engine.runCombined(Array.from({ length: 30 }, () => makeCandle()), 'pair-1');

    expect(result.combined.totalTrades).toBe(1);
    expect(result.combined.rejections.positionOpen).toBe(1);
  });

  it('simulates cascade add-on after TP1 in momentum backtest mode', () => {
    const recompressionSpy = jest.spyOn(strategy, 'detectRecompression').mockReturnValue(true);
    const reaccelerationSpy = jest.spyOn(strategy, 'detectReacceleration').mockReturnValue({
      action: 'BUY',
      strategy: 'momentum_cascade',
      pairAddress: 'pair-1',
      price: 1.15,
      timestamp: new Date('2026-03-15T00:05:00Z'),
      meta: {},
    });

    try {
      const engine = new BacktestEngine();
      const trade = engine["simulateCascadeTrade"](
        makeOrder({
          strategy: 'momentum_cascade',
          takeProfit1: 1.2,
          takeProfit2: 1.4,
          trailingStop: 0,
        }),
        [
          makeCandle({ timestamp: new Date('2026-03-15T00:00:00Z'), open: 1, high: 1.01, low: 0.99, close: 1 }),
          makeCandle({ timestamp: new Date('2026-03-15T00:05:00Z'), open: 1, high: 1.22, low: 1.0, close: 1.15, volume: 120 }),
          makeCandle({ timestamp: new Date('2026-03-15T00:10:00Z'), open: 1.15, high: 1.42, low: 1.14, close: 1.4, volume: 200 }),
        ],
        0,
        120,
        1,
        'pair-1',
        10
      );

      expect(trade?.strategy).toBe('momentum_cascade');
      expect(trade?.exitReason).toBe('TAKE_PROFIT_2');
      expect(trade?.quantity).toBeGreaterThan(1);
      expect(trade?.exitPrice).toBeGreaterThan(1.25);
    } finally {
      recompressionSpy.mockRestore();
      reaccelerationSpy.mockRestore();
    }
  });
});

function makeSignal(): Signal {
  return {
    action: 'BUY',
    strategy: 'volume_spike',
    pairAddress: 'pair-1',
    price: 1,
    timestamp: new Date('2026-03-15T00:00:00Z'),
    meta: { volumeRatio: 3, atr: 0.06 },
  };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    pairAddress: 'pair-1',
    strategy: 'volume_spike',
    side: 'BUY',
    price: 1,
    quantity: 1,
    stopLoss: 0.9,
    takeProfit1: 1.3,
    takeProfit2: 1.5,
    trailingStop: 0.05,
    timeStopMinutes: 120,
    ...overrides,
  };
}

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    pairAddress: 'pair-1',
    timestamp: new Date('2026-03-15T00:00:00Z'),
    intervalSec: 300,
    open: 1,
    high: 1.05,
    low: 0.97,
    close: 1.02,
    volume: 100,
    buyVolume: 80,
    sellVolume: 20,
    tradeCount: 12,
    ...overrides,
  };
}
