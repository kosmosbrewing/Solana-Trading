import {
  evaluateExecutionViability,
  evaluateExecutionViabilityForOrder,
  evaluateGates,
  evaluateGatesAsync,
} from '../src/gate';
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

  it('adds volume/marketCap factor for strong turnover tokens', () => {
    const result = evaluateGates({
      signal: {
        ...signal,
        meta: { ...signal.meta, currentVolume24hUsd: 40_000 },
      },
      candles,
      poolInfo: {
        ...poolInfo,
        marketCap: 100_000,
      },
      previousTvl: poolInfo.tvl,
      fibConfig: {
        impulseMinPct: 0.15,
        volumeClimaxMultiplier: 2.5,
        minWickRatio: 0.4,
      },
    });

    expect(result.breakoutScore.mcapVolumeScore).toBe(9);
    expect(result.breakoutScore.totalScore).toBe(64);
    expect(result.breakoutScore.components?.find(component => component.key === 'volume_mcap_ratio')).toMatchObject({
      score: 9,
      maxScore: 15,
      value: 0.4,
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
      poolInfo: { ...poolInfo, tvl: 65 },
    });
    const poor = evaluateGates({
      ...baseInput,
      poolInfo: { ...poolInfo, tvl: 5 },  // v5: TP2=ATR×10 → TVL 대폭 축소 필요
    });

    expect(healthy.executionViability.effectiveRR).toBeGreaterThanOrEqual(1.5);
    expect(healthy.gradeSizeMultiplier).toBeCloseTo(1.2, 6);

    // v5: TP2=ATR×10으로 변경되어 middling TVL 65에서 RR 상승 → full pass
    expect(middling.executionViability.effectiveRR).toBeGreaterThanOrEqual(1.5);
    expect(middling.gradeSizeMultiplier).toBeCloseTo(1.2, 6);

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
      takeProfit1: 1.075,
      takeProfit2: 1.15,
    }, 100);

    expect(tinyProbe.rejected).toBe(false);
    expect(actualSize.rejected).toBe(true);
    expect(actualSize.filterReason).toContain('poor_execution_viability');
  });

  it('applies configured execution viability thresholds and rr basis in gate evaluation', () => {
    const gateParams = {
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
      poolInfo: { ...poolInfo, tvl: 1_000 },
      executionRrReject: 1.0,
      executionRrPass: 1.2,
    };

    const tp1Basis = evaluateGates(buildLiveGateInput({
      ...gateParams,
      executionRrBasis: 'tp1',
    }));
    const tp2Basis = evaluateGates(buildLiveGateInput({
      ...gateParams,
      executionRrBasis: 'tp2',
    }));

    expect(tp1Basis.rejected).toBe(true);
    expect(tp1Basis.filterReason).toContain('poor_execution_viability');
    expect(tp2Basis.rejected).toBe(false);
    expect(tp2Basis.executionViability.effectiveRR).toBeGreaterThan(tp1Basis.executionViability.effectiveRR);
  });

  it('converts SOL probe notionals into token quantity for pre-gate execution viability', () => {
    const pricedSignal: Signal = {
      ...signal,
      price: 2,
      meta: { atr: 0.2, volumeRatio: 3 },
    };
    const pricedCandles: Candle[] = [
      {
        ...candles[0],
        low: 1.9,
        close: 2,
      },
    ];

    const result = evaluateExecutionViability(
      pricedSignal,
      pricedCandles,
      { ...poolInfo, tvl: 1_000 },
      0.5
    );

    expect(result.notionalSol).toBeCloseTo(0.5, 6);
    expect(result.quantity).toBeCloseTo(0.25, 6);
    expect(result.entryPriceImpactPct).toBeGreaterThanOrEqual(0);
    expect(result.exitPriceImpactPct).toBeGreaterThanOrEqual(0);
  });

  it('uses momentum trigger order params for realtime execution probes', () => {
    const realtimeSignal: Signal = {
      ...signal,
      meta: { ...signal.meta, realtimeSignal: 1 },
    };
    const realtimeCandles: Candle[] = [
      {
        ...candles[0],
        low: 0.8,
      },
      {
        ...candles[0],
        timestamp: new Date('2026-03-15T00:05:00Z'),
        low: 0.85,
        close: 1.0,
      },
    ];

    const result = evaluateExecutionViability(
      realtimeSignal,
      realtimeCandles,
      { ...poolInfo, tvl: 1_000 },
      1,
      {
        realtimeOrderParams: {
          slMode: 'candle_low',
          slAtrMultiplier: 1.0,
          slSwingLookback: 2,
          timeStopMinutes: 20,
          atrPeriod: 14,
          tp1Multiplier: 1.0,
          tp2Multiplier: 10.0,
        },
      }
    );

    expect(result.riskPct).toBeCloseTo(0.15, 6);
    expect(result.rewardPct).toBeCloseTo(0.6, 6);
  });
});

describe('Sell-side impact exit gate', () => {
  const baseInput = {
    signal,
    candles,
    poolInfo,
    previousTvl: poolInfo.tvl,
    fibConfig: {
      impulseMinPct: 0.15,
      volumeClimaxMultiplier: 2.5,
      minWickRatio: 0.4,
    },
  };

  it('passes when sellImpactPct is below sizing threshold', async () => {
    const result = await evaluateGatesAsync({
      ...baseInput,
      sellImpactPct: 0.005, // 0.5% — well below 1.5% threshold
      maxSellImpact: 0.03,
      sellImpactSizingThreshold: 0.015,
    });

    expect(result.rejected).toBe(false);
    expect(result.sellImpactPct).toBe(0.005);
  });

  it('reduces sizing 50% when sellImpactPct exceeds sizing threshold', async () => {
    const baseline = await evaluateGatesAsync({
      ...baseInput,
      sellImpactPct: 0.005,
    });
    const highSellImpact = await evaluateGatesAsync({
      ...baseInput,
      sellImpactPct: 0.02, // 2% — above 1.5% threshold
      maxSellImpact: 0.03,
      sellImpactSizingThreshold: 0.015,
    });

    expect(highSellImpact.rejected).toBe(false);
    expect(highSellImpact.gradeSizeMultiplier).toBeCloseTo(baseline.gradeSizeMultiplier * 0.5, 6);
  });

  it('rejects when sellImpactPct exceeds maxSellImpact', async () => {
    const result = await evaluateGatesAsync({
      ...baseInput,
      sellImpactPct: 0.04, // 4% — above 3% max
      maxSellImpact: 0.03,
      sellImpactSizingThreshold: 0.015,
    });

    expect(result.rejected).toBe(true);
    expect(result.filterReason).toContain('exit_illiquid');
    expect(result.gradeSizeMultiplier).toBe(0);
  });

  it('skips sell impact check when sellImpactPct is undefined', async () => {
    const result = await evaluateGatesAsync({
      ...baseInput,
      // sellImpactPct not provided
    });

    expect(result.sellImpactPct).toBeUndefined();
  });

  it('sync evaluateGates ignores sellImpactPct (by design — backtest has no live quotes)', () => {
    const withHighSellImpact = evaluateGates({
      ...baseInput,
      sellImpactPct: 0.10, // 10% — would reject in async path
      maxSellImpact: 0.03,
    });
    const withoutSellImpact = evaluateGates(baseInput);

    // Sync path does not apply sell impact gate
    expect(withHighSellImpact.rejected).toBe(withoutSellImpact.rejected);
    expect(withHighSellImpact.gradeSizeMultiplier).toBe(withoutSellImpact.gradeSizeMultiplier);
    expect(withHighSellImpact.sellImpactPct).toBeUndefined();
  });
});
