import { BirdeyeClient } from '../ingester';
import { createModuleLogger } from '../utils/logger';
import { TrendingEventCandidate, TrendingFetcherConfig } from './types';

const log = createModuleLogger('TrendingFetcher');

export class TrendingFetcher {
  constructor(
    private readonly birdeyeClient: BirdeyeClient,
    private readonly config: TrendingFetcherConfig
  ) {}

  async fetchCandidates(): Promise<TrendingEventCandidate[]> {
    const detectedAt = new Date().toISOString();
    const tokens = await this.birdeyeClient.getTrendingTokens(this.config.limit);
    const unique = new Map<string, TrendingEventCandidate>();

    for (const token of tokens) {
      if (unique.has(token.address)) continue;
      unique.set(token.address, {
        ...token,
        detectedAt,
      });
    }

    const candidates = [...unique.values()];
    log.info(`Fetched ${candidates.length} trending event candidates`);
    return candidates;
  }
}
