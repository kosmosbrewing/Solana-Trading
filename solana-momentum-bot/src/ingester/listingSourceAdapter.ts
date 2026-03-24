import { createModuleLogger } from '../utils/logger';
import type { BirdeyeWSClient, WSNewListingUpdate } from './birdeyeWSClient';

const log = createModuleLogger('ListingSource');

export interface ListingSourceCandidate {
  address: string;
  symbol?: string;
  price?: number;
  liquidity?: number;
  liquidityAddedAt?: number;
  decimals?: number;
  source: string;
  raw: Record<string, unknown>;
}

type ListingSourceHandler = (candidate: ListingSourceCandidate) => Promise<void> | void;

type BirdeyeListingSourceClient = Pick<BirdeyeWSClient, 'subscribeNewListings' | 'on'>;

export function mapBirdeyeNewListingUpdate(update: WSNewListingUpdate): ListingSourceCandidate {
  return {
    address: update.address,
    symbol: update.symbol,
    liquidity: update.liquidity,
    liquidityAddedAt: update.liquidityAddedAt,
    decimals: update.decimals,
    source: 'birdeye_ws',
    raw: update as unknown as Record<string, unknown>,
  };
}

export function attachBirdeyeListingSource(
  client: BirdeyeListingSourceClient,
  onCandidate: ListingSourceHandler
): void {
  client.subscribeNewListings();
  client.on('newListing', (update: WSNewListingUpdate) => {
    const candidate = mapBirdeyeNewListingUpdate(update);
    Promise.resolve(onCandidate(candidate)).catch((error) => {
      log.warn(`Listing source handler failed for ${candidate.address}: ${error}`);
    });
  });
}
