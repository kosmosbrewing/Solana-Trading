import { replayRealtimeDataset } from '../src/backtest/microReplayEngine';
import { StoredRealtimeSwap } from '../src/realtime/replayStore';

function makeSwap(timestamp: number, priceNative: number, amountQuote: number, signature: string): StoredRealtimeSwap {
  return {
    pairAddress: 'pool-1',
    poolAddress: 'pool-1',
    pool: 'pool-1',
    signature,
    timestamp,
    side: 'buy',
    priceNative,
    amountBase: 10,
    amountQuote,
    slot: timestamp,
    source: 'logs',
    tokenMint: 'pool-1',
  };
}

describe('microReplayEngine', () => {
  it('replays raw swaps into realtime signals and summary metrics', async () => {
    const swaps: StoredRealtimeSwap[] = [
      makeSwap(1, 1.00, 5, 'a1'),
      makeSwap(4, 1.05, 12, 'a2'),
      makeSwap(6, 1.06, 6, 'b1'),
      makeSwap(9, 1.12, 20, 'b2'),
      makeSwap(11, 1.13, 7, 'c1'),
      makeSwap(14, 1.20, 22, 'c2'),
      makeSwap(41, 1.28, 10, 'd1'),
      makeSwap(71, 1.35, 10, 'e1'),
    ];

    const result = await replayRealtimeDataset(swaps, {
      triggerConfig: {
        primaryIntervalSec: 5,
        confirmIntervalSec: 5,
        volumeSurgeLookback: 1,
        volumeSurgeMultiplier: 1,
        priceBreakoutLookback: 1,
        confirmMinBars: 1,
        confirmMinPriceChangePct: 0,
        cooldownSec: 300,
      },
      horizonsSec: [30, 60],
      gateMode: 'off',
    });

    expect(result.dataset.swapCount).toBe(8);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].horizons.map((item) => item.horizonSec)).toEqual([30, 60]);
    expect(result.summary.totalSignals).toBe(1);
    expect(result.summary.avgReturnPct).toBeGreaterThan(0);
  });
});
