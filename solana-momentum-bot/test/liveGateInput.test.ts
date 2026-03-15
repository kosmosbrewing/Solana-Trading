import { buildLiveGateInput } from '../src/gate/liveGateInput';
import type { AttentionScore } from '../src/event/types';
import type { Candle, PoolInfo, Signal } from '../src/utils/types';

describe('buildLiveGateInput', () => {
  it('always enforces AttentionScore for live gate evaluation', () => {
    const attentionScore: AttentionScore = {
      tokenMint: 'mint-1',
      tokenSymbol: 'TEST',
      attentionScore: 80,
      components: {
        narrativeStrength: 16,
        sourceQuality: 16,
        timing: 16,
        tokenSpecificity: 16,
        historicalPattern: 16,
      },
      narrative: 'news catalyst',
      sources: ['source-a'],
      detectedAt: '2026-03-15T00:00:00Z',
      expiresAt: '2026-03-15T01:00:00Z',
      confidence: 'high',
    };

    const input = buildLiveGateInput({
      signal: {
        action: 'BUY',
        strategy: 'fib_pullback',
        pairAddress: 'pair-1',
        price: 1,
        timestamp: new Date('2026-03-15T00:00:00Z'),
        meta: {},
      } as Signal,
      candles: [] as Candle[],
      poolInfo: {
        pairAddress: 'pair-1',
        tokenMint: 'mint-1',
        tvl: 1,
        dailyVolume: 1,
        tradeCount24h: 1,
        spreadPct: 0.01,
        tokenAgeHours: 24,
        top10HolderPct: 0.4,
        lpBurned: true,
        ownershipRenounced: true,
        rankScore: 1,
      } as PoolInfo,
      previousTvl: 1,
      attentionScore,
      fibConfig: {
        impulseMinPct: 0.15,
        volumeClimaxMultiplier: 2.5,
        minWickRatio: 0.4,
      },
    });

    expect(input.requireAttentionScore).toBe(true);
    expect(input.attentionScore).toBe(attentionScore);
  });
});
