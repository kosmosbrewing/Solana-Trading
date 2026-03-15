import { evaluateExecutionViabilityForOrder, evaluateGates } from '../src/gate';
import { buildLiveGateInput } from '../src/gate/liveGateInput';
import type { AttentionScore } from '../src/event/types';
import type { Candle, PoolInfo, Signal } from '../src/utils/types';

const signal: Signal = {
  action: 'BUY',
  strategy: 'volume_spike',
  pairAddress: 'pair-1',
  price: 1,
  timestamp: new Date('2026-03-15T00:00:00Z'),
  meta: { volumeRatio: 3, atr: 0.06 },
};

const candles: Candle[] = [
  {
    pairAddress: 'pair-1',
    timestamp: new Date('2026-03-15T00:00:00Z'),
    intervalSec: 300,
    open: 1,
    high: 1.1,
    low: 0.95,
    close: 1.05,
    volume: 100,
    buyVolume: 80,
    sellVolume: 20,
    tradeCount: 12,
  },
];

const poolInfo: PoolInfo = {
  pairAddress: 'pair-1',
  tokenMint: 'mint-1',
  tvl: 100_000,
  dailyVolume: 50_000,
  tradeCount24h: 100,
  spreadPct: 0.01,
  tokenAgeHours: 48,
  top10HolderPct: 0.4,
  lpBurned: true,
  ownershipRenounced: true,
  rankScore: 80,
};

const highConfidenceEvent: AttentionScore = {
  tokenMint: 'mint-1',
  tokenSymbol: 'TEST',
  attentionScore: 75,
  components: {
    narrativeStrength: 15,
    sourceQuality: 15,
    timing: 15,
    tokenSpecificity: 15,
    historicalPattern: 15,
  },
  narrative: 'fresh catalyst',
  sources: ['source-a'],
  detectedAt: '2026-03-15T00:00:00Z',
  expiresAt: '2026-03-15T01:00:00Z',
  confidence: 'high',
};

describe('AttentionScore gate integration', () => {
  it('rejects live signals without AttentionScore context', () => {
    const result = evaluateGates(buildLiveGateInput({
      signal,
      candles,
      poolInfo,
      previousTvl: poolInfo.tvl,
      fibConfig: {
        impulseMinPct: 0.15,
        volumeClimaxMultiplier: 2.5,
        minWickRatio: 0.4,
      },
    }));

    expect(result.rejected).toBe(true);
    expect(result.filterReason).toBe('not_trending');
  });

  it('hard-rejects volume spike entries when buy ratio is below threshold', () => {
    const weakBuyCandles: Candle[] = [
      {
        ...candles[0],
        buyVolume: 40,
        sellVolume: 60,
      },
    ];

    const result = evaluateGates(buildLiveGateInput({
      signal,
      candles: weakBuyCandles,
      poolInfo,
      previousTvl: poolInfo.tvl,
      attentionScore: highConfidenceEvent,
      fibConfig: {
        impulseMinPct: 0.15,
        volumeClimaxMultiplier: 2.5,
        minWickRatio: 0.4,
      },
      thresholds: {
        minBuyRatio: 0.65,
        minBreakoutScore: 50,
      },
    }));

    expect(result.rejected).toBe(true);
    expect(result.filterReason).toContain('buy_ratio');
  });

  it('adds AttentionScore points into breakout score and sizing bonus', () => {
    const withoutEvent = evaluateGates({
      signal,
      candles,
      poolInfo,
      previousTvl: poolInfo.tvl,
      fibConfig: {
        impulseMinPct: 0.15,
        volumeClimaxMultiplier: 2.5,
        minWickRatio: 0.4,
      },
    });
    const withEvent = evaluateGates(buildLiveGateInput({
      signal,
      candles,
      poolInfo,
      previousTvl: poolInfo.tvl,
      attentionScore: highConfidenceEvent,
      fibConfig: {
        impulseMinPct: 0.15,
        volumeClimaxMultiplier: 2.5,
        minWickRatio: 0.4,
      },
    }));

    expect(withoutEvent.breakoutScore.totalScore).toBe(55);
    expect(withEvent.breakoutScore.totalScore).toBe(70);
    expect(withEvent.breakoutScore.grade).toBe('A');
    expect(withEvent.gradeSizeMultiplier).toBeCloseTo(1.2, 6);
    expect(withEvent.breakoutScore.components?.find(component => component.key === 'attention_score')).toMatchObject({
      score: 15,
      maxScore: 20,
      value: 75,
    });
  });

  it('applies Gate 4 execution viability sizing and rejection bands', () => {
    const rrCandles: Candle[] = [
      {
        ...candles[0],
        low: 0.97,
      },
    ];
    const baseInput = buildLiveGateInput({
      signal: {
        ...signal,
        meta: { atr: 0.06, volumeRatio: 3 },
      },
      candles: rrCandles,
      previousTvl: poolInfo.tvl,
      attentionScore: highConfidenceEvent,
      fibConfig: {
        impulseMinPct: 0.15,
        volumeClimaxMultiplier: 2.5,
        minWickRatio: 0.4,
      },
      poolInfo,
    });

    const healthy = evaluateGates({
      ...baseInput,
      poolInfo: { ...poolInfo, tvl: 1_000 },
    });
    const middling = evaluateGates({
      ...baseInput,
      poolInfo: { ...poolInfo, tvl: 100 },
    });
    const poor = evaluateGates({
      ...baseInput,
      poolInfo: { ...poolInfo, tvl: 40 },
    });

    expect(healthy.executionViability.effectiveRR).toBeGreaterThanOrEqual(1.5);
    expect(healthy.gradeSizeMultiplier).toBeCloseTo(1.2, 6);

    expect(middling.executionViability.effectiveRR).toBeGreaterThanOrEqual(1.2);
    expect(middling.executionViability.effectiveRR).toBeLessThan(1.5);
    expect(middling.gradeSizeMultiplier).toBeCloseTo(0.6, 6);

    expect(poor.rejected).toBe(true);
    expect(poor.filterReason).toContain('poor_execution_viability');
    expect(poor.executionViability.roundTripCost).toBeGreaterThan(0.09);
  });

  it('rejects orders that only fail once actual position size is applied', () => {
    const tinyProbe = evaluateGates(buildLiveGateInput({
      signal: {
        ...signal,
        meta: { atr: 0.06, volumeRatio: 3 },
      },
      candles: [{
        ...candles[0],
        low: 0.97,
      }],
      previousTvl: poolInfo.tvl,
      attentionScore: highConfidenceEvent,
      fibConfig: {
        impulseMinPct: 0.15,
        volumeClimaxMultiplier: 2.5,
        minWickRatio: 0.4,
      },
      poolInfo: { ...poolInfo, tvl: 100 },
    }));

    const actualSize = evaluateExecutionViabilityForOrder({
      price: 1,
      quantity: 10,
      stopLoss: 0.97,
      takeProfit2: 1.15,
    }, 100);

    expect(tinyProbe.rejected).toBe(false);
    expect(actualSize.rejected).toBe(true);
    expect(actualSize.filterReason).toContain('poor_execution_viability');
  });
});
