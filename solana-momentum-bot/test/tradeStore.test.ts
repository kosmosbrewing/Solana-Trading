import { TradeStore } from '../src/candle/tradeStore';

describe('TradeStore.getRecentExecutedEntries', () => {
  it('filters out child trades and failed trades', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{
          id: 'trade-1',
          pair_address: 'pair-1',
          strategy: 'volume_spike',
          side: 'BUY',
          token_symbol: 'TEST',
          entry_price: '1.0',
          source_label: 'trigger_volume_mcap_spike',
          discovery_source: 'gecko_trending',
          quantity: '1.5',
          status: 'OPEN',
          stop_loss: '0.9',
          take_profit1: '1.1',
          take_profit2: '1.2',
          time_stop_at: '2026-04-04T00:20:00Z',
          created_at: '2026-04-04T00:00:00Z',
          closed_at: null,
        }],
      }),
    };

    const store = new TradeStore(pool as any);
    const result = await store.getRecentExecutedEntries(50);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE parent_trade_id IS NULL'),
      [50]
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("AND status != 'FAILED'"),
      [50]
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'trade-1',
      pairAddress: 'pair-1',
      strategy: 'volume_spike',
      sourceLabel: 'trigger_volume_mcap_spike',
      discoverySource: 'gecko_trending',
      quantity: 1.5,
      status: 'OPEN',
    });
  });
});
