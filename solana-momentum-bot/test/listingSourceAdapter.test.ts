import { EventEmitter } from 'events';
import { attachBirdeyeListingSource, mapBirdeyeNewListingUpdate } from '../src/ingester/listingSourceAdapter';

describe('listingSourceAdapter', () => {
  it('maps Birdeye new listing updates into generic listing candidates', () => {
    const candidate = mapBirdeyeNewListingUpdate({
      type: 'NEW_LISTING',
      address: 'mint-1',
      symbol: 'TEST',
      decimals: 6,
      liquidity: 15_000,
      liquidityAddedAt: 1234567890,
    });

    expect(candidate).toMatchObject({
      address: 'mint-1',
      symbol: 'TEST',
      decimals: 6,
      liquidity: 15_000,
      liquidityAddedAt: 1234567890,
      source: 'birdeye_ws',
    });
    expect(candidate.raw).toMatchObject({
      type: 'NEW_LISTING',
      address: 'mint-1',
      symbol: 'TEST',
    });
  });

  it('subscribes to Birdeye listing events and forwards generic candidates', async () => {
    const client = new EventEmitter() as EventEmitter & {
      subscribeNewListings: jest.Mock;
    };
    client.subscribeNewListings = jest.fn();
    const received: Array<{ address: string; source: string }> = [];

    attachBirdeyeListingSource(client as never, async (candidate) => {
      received.push({ address: candidate.address, source: candidate.source });
    });

    client.emit('newListing', {
      type: 'NEW_LISTING',
      address: 'mint-2',
      symbol: 'NEXT',
      liquidity: 22_000,
      liquidityAddedAt: 123,
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(client.subscribeNewListings).toHaveBeenCalledTimes(1);
    expect(received).toEqual([{ address: 'mint-2', source: 'birdeye_ws' }]);
  });
});
