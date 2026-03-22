import { MicroCandleBuilder } from '../src/realtime';
import { Candle } from '../src/utils/types';
import { MomentumTrigger } from '../src/strategy';

function makeCandle(
  intervalSec: number,
  timestampSec: number,
  open: number,
  close: number,
  volume: number
): Candle {
  return {
    pairAddress: 'pool-1',
    timestamp: new Date(timestampSec * 1000),
    intervalSec,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close) * 0.99,
    close,
    volume,
    buyVolume: volume * 0.7,
    sellVolume: volume * 0.3,
    tradeCount: 10,
  };
}

function seedCandles(builder: MicroCandleBuilder, intervalSec: number, candles: Candle[]): void {
  (builder as any).closedCandles.set(
    'pool-1',
    new Map<number, Candle[]>([
      [intervalSec, candles],
      ...(((builder as any).closedCandles.get('pool-1')?.entries?.() ?? []) as Iterable<[number, Candle[]]>),
    ])
  );
}

describe('MomentumTrigger', () => {
  it('emits a BUY signal when breakout, volume, confirmation, and cooldown all pass', () => {
    const builder = new MicroCandleBuilder({ intervals: [15, 60], maxHistory: 50 });
    const trigger = new MomentumTrigger({
      primaryIntervalSec: 15,
      confirmIntervalSec: 60,
      volumeSurgeLookback: 20,
      volumeSurgeMultiplier: 3,
      priceBreakoutLookback: 20,
      confirmMinBars: 3,
      confirmMinPriceChangePct: 0.02,
      cooldownSec: 300,
    });

    const primaryCandles = Array.from({ length: 20 }, (_, index) =>
      makeCandle(15, 15 * (index + 1), 1 + index * 0.01, 1.01 + index * 0.01, 10)
    );
    primaryCandles.push(makeCandle(15, 15 * 21, 1.25, 1.35, 50));
    const confirmCandles = [
      makeCandle(60, 60, 1.0, 1.03, 30),
      makeCandle(60, 120, 1.03, 1.07, 30),
      makeCandle(60, 180, 1.07, 1.12, 30),
    ];

    seedCandles(builder, 15, primaryCandles);
    seedCandles(builder, 60, confirmCandles);

    const signal = trigger.onCandle(primaryCandles[primaryCandles.length - 1], builder);
    expect(signal).not.toBeNull();
    expect(signal).toMatchObject({
      action: 'BUY',
      strategy: 'volume_spike',
      pairAddress: 'pool-1',
      price: 1.35,
    });
    expect(signal?.meta.realtimeSignal).toBe(1);
  });

  it('suppresses repeated signals inside cooldown window', () => {
    const builder = new MicroCandleBuilder({ intervals: [15, 60], maxHistory: 50 });
    const trigger = new MomentumTrigger({
      primaryIntervalSec: 15,
      confirmIntervalSec: 60,
      volumeSurgeLookback: 20,
      volumeSurgeMultiplier: 2,
      priceBreakoutLookback: 20,
      confirmMinBars: 3,
      confirmMinPriceChangePct: 0.01,
      cooldownSec: 300,
    });

    const primaryCandles = Array.from({ length: 20 }, (_, index) =>
      makeCandle(15, 15 * (index + 1), 2 + index * 0.01, 2.01 + index * 0.01, 10)
    );
    primaryCandles.push(makeCandle(15, 15 * 21, 2.25, 2.4, 40));
    const confirmCandles = [
      makeCandle(60, 60, 2.0, 2.04, 30),
      makeCandle(60, 120, 2.04, 2.08, 30),
      makeCandle(60, 180, 2.08, 2.12, 30),
    ];

    seedCandles(builder, 15, primaryCandles);
    seedCandles(builder, 60, confirmCandles);

    const first = trigger.onCandle(primaryCandles[primaryCandles.length - 1], builder);
    expect(first?.action).toBe('BUY');

    const secondSignalCandle = makeCandle(15, 15 * 22, 2.4, 2.55, 45);
    seedCandles(builder, 15, [...primaryCandles.slice(1), secondSignalCandle]);
    const second = trigger.onCandle(secondSignalCandle, builder);
    expect(second).toBeNull();
  });
});
