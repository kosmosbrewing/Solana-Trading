import { handleRealtimeSignal } from '../src/orchestration/realtimeHandler';
import { config } from '../src/utils/config';
import { processSignal } from '../src/orchestration/signalProcessor';

jest.mock('../src/orchestration/signalProcessor', () => ({
  processSignal: jest.fn(),
}));

describe('handleRealtimeSignal operator blacklist', () => {
  const originalBlacklist = [...config.operatorTokenBlacklist];
  const mutableConfig = config as { operatorTokenBlacklist: string[] };

  afterEach(() => {
    mutableConfig.operatorTokenBlacklist = [...originalBlacklist];
    jest.clearAllMocks();
  });

  it('rejects blacklisted realtime signals before gate processing', async () => {
    mutableConfig.operatorTokenBlacklist = ['mint-blocked'];
    const track = jest.fn();
    const candles = Array.from({ length: 21 }, (_, index) => ({
      pairAddress: 'pair-blocked',
      timestamp: new Date(`2026-04-04T00:${String(index).padStart(2, '0')}:00.000Z`),
      intervalSec: 10,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      buyVolume: 1,
      sellVolume: 0,
      tradeCount: 1,
    }));

    await handleRealtimeSignal(
      {
        action: 'BUY',
        strategy: 'volume_spike',
        pairAddress: 'pair-blocked',
        price: 1,
        timestamp: new Date('2026-04-04T00:21:00.000Z'),
        meta: {},
      },
      {
        getRecentCandles: jest.fn().mockReturnValue(candles),
      } as never,
      {
        universeEngine: {
          getWatchlist: () => [{
            pairAddress: 'pair-blocked',
            tokenMint: 'mint-blocked',
            tvl: 100_000,
            dailyVolume: 250_000,
            symbol: 'BLK',
          }],
        },
        realtimeOutcomeTracker: {
          getRequiredHistoryCount: () => 5,
          track,
        },
      } as never
    );

    expect(processSignal).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][0]).toMatchObject({
      pairAddress: 'pair-blocked',
      tokenMint: 'mint-blocked',
      gate: {
        rejected: true,
        filterReason: 'operator_blacklist',
      },
      processing: {
        status: 'gate_rejected',
        filterReason: 'operator_blacklist',
      },
    });
  });
});
