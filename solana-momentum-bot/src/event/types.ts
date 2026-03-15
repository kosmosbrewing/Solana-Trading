import { BirdeyeTrendingToken } from '../ingester/birdeyeClient';

export interface AttentionScoreComponents {
  narrativeStrength: number;
  sourceQuality: number;
  timing: number;
  tokenSpecificity: number;
  historicalPattern: number;
}

export interface AttentionScore {
  tokenMint: string;
  tokenSymbol: string;
  attentionScore: number;
  components: AttentionScoreComponents;
  narrative: string;
  sources: string[];
  detectedAt: string;
  expiresAt: string;
  confidence: 'low' | 'medium' | 'high';
}

/** @deprecated use AttentionScoreComponents */
export type EventScoreComponents = AttentionScoreComponents;
/** @deprecated use AttentionScore */
export type EventScore = AttentionScore;

export interface AttentionScorerConfig {
  expiryMinutes: number;
  minLiquidityUsd: number;
}

/** @deprecated use AttentionScorerConfig */
export type EventScorerConfig = AttentionScorerConfig;

export interface TrendingFetcherConfig {
  limit: number;
}

export interface EventMonitorConfig {
  pollingIntervalMs: number;
  minAttentionScore: number;
  fetchLimit: number;
  expiryMinutes: number;
  minLiquidityUsd: number;
}

export interface TrendingEventCandidate extends BirdeyeTrendingToken {
  detectedAt: string;
}
