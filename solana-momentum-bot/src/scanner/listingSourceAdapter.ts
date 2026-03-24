import type { ListingSourceCandidate } from '../ingester';
import type { ScannerEngine, WatchlistEntry } from './scannerEngine';

type ListingSourceHandler = (candidate: ListingSourceCandidate) => Promise<void> | void;
type ScannerListingSourceClient = Pick<ScannerEngine, 'on'>;

export function mapScannerFreshEntry(entry: WatchlistEntry): ListingSourceCandidate {
  return {
    address: entry.tokenMint,
    symbol: entry.symbol,
    price: entry.lastPriceUsd,
    liquidity: entry.poolInfo?.tvl,
    liquidityAddedAt: entry.addedAt.getTime(),
    source: `scanner_${entry.discoverySource}`,
    raw: {
      discoverySource: entry.discoverySource,
      lane: entry.lane,
      pairAddress: entry.pairAddress,
      watchlistScore: entry.watchlistScore.totalScore,
    },
  };
}

export function attachScannerFreshListingSource(
  scanner: ScannerListingSourceClient,
  onCandidate: ListingSourceHandler
): void {
  scanner.on('candidateDiscovered', (entry: WatchlistEntry) => {
    if (entry.lane !== 'B') return;
    void Promise.resolve(onCandidate(mapScannerFreshEntry(entry)));
  });
}
