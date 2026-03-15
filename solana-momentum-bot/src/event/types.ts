import { BirdeyeTrendingToken } from '../ingester/birdeyeClient';

export interface EventScoreComponents {
  narrativeStrength: number;
  sourceQuality: number;
  timing: number;
  tokenSpecificity: number;
  historicalPattern: number;
}

export interface EventScore {
  tokenMint: string;
  tokenSymbol: string;
  eventScore: number;
  components: EventScoreComponents;
  narrative: string;
  sources: string[];
  detectedAt: string;
  expiresAt: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface EventScorerConfig {
  expiryMinutes: number;
  minLiquidityUsd: number;
}

export interface TrendingFetcherConfig {
  limit: number;
}

export interface EventMonitorConfig {
  pollingIntervalMs: number;
  minEventScore: number;
  fetchLimit: number;
  expiryMinutes: number;
  minLiquidityUsd: number;
}

export interface TrendingEventCandidate extends BirdeyeTrendingToken {
  detectedAt: string;
}
