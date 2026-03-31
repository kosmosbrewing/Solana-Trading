import { AttentionScore, AttentionScoreComponents, AttentionScorerConfig, TrendingEventCandidate } from './types';

export class AttentionScorer {
  constructor(private readonly config: AttentionScorerConfig) {}

  score(candidate: TrendingEventCandidate): AttentionScore {
    const components = this.buildComponents(candidate);
    const attentionScore = clamp(
      components.narrativeStrength +
      components.sourceQuality +
      components.timing +
      components.tokenSpecificity +
      components.historicalPattern,
      0,
      100
    );
    const detectedAt = normalizeIso(candidate.detectedAt);

    return {
      tokenMint: candidate.address,
      tokenSymbol: candidate.symbol,
      attentionScore,
      components,
      narrative: this.buildNarrative(candidate, components),
      sources: [resolveSourceLabel(candidate)],
      detectedAt,
      expiresAt: new Date(Date.parse(detectedAt) + this.config.expiryMinutes * 60_000).toISOString(),
      confidence: this.resolveConfidence(attentionScore, candidate),
    };
  }

  private buildComponents(candidate: TrendingEventCandidate): AttentionScoreComponents {
    return {
      narrativeStrength: this.calcNarrativeStrength(candidate),
      sourceQuality: this.calcSourceQuality(candidate),
      timing: this.calcTiming(candidate),
      tokenSpecificity: this.calcTokenSpecificity(candidate),
      historicalPattern: this.calcHistoricalPattern(candidate),
    };
  }

  private calcNarrativeStrength(candidate: TrendingEventCandidate): number {
    let score = 0;
    if (candidate.rank <= 3) score += 12;
    else if (candidate.rank <= 10) score += 8;
    else if (candidate.rank <= 20) score += 4;

    const change = Math.abs(candidate.priceChange24hPct || 0);
    if (change >= 100) score += 10;
    else if (change >= 40) score += 7;
    else if (change >= 15) score += 4;

    const volume = candidate.volume24hUsd || 0;
    if (volume >= 1_000_000) score += 8;
    else if (volume >= 250_000) score += 5;
    else if (volume >= 50_000) score += 2;

    return clamp(score, 0, 30);
  }

  private calcSourceQuality(candidate: TrendingEventCandidate): number {
    let score = 10;
    if (candidate.updatedAt) score += 3;
    if (typeof candidate.priceChange24hPct === 'number') score += 2;
    if (typeof candidate.volume24hUsd === 'number') score += 2;
    if (typeof candidate.liquidityUsd === 'number') score += 2;
    if (typeof candidate.marketCap === 'number') score += 1;
    return clamp(score, 0, 20);
  }

  private calcTiming(candidate: TrendingEventCandidate): number {
    const observedAt = Date.parse(candidate.updatedAt || candidate.detectedAt);
    if (Number.isNaN(observedAt)) return 8;

    const ageMinutes = Math.max(0, (Date.now() - observedAt) / 60_000);
    if (ageMinutes <= 15) return 20;
    if (ageMinutes <= 60) return 16;
    if (ageMinutes <= 180) return 10;
    if (ageMinutes <= 360) return 6;
    return 3;
  }

  private calcTokenSpecificity(candidate: TrendingEventCandidate): number {
    let score = 8;
    if (candidate.symbol) score += 3;
    if (candidate.name) score += 2;
    if (candidate.address) score += 2;
    return clamp(score, 0, 15);
  }

  private calcHistoricalPattern(candidate: TrendingEventCandidate): number {
    let score = 0;
    const liquidity = candidate.liquidityUsd || 0;
    const volume = candidate.volume24hUsd || 0;
    const marketCap = candidate.marketCap || 0;

    if (liquidity >= this.config.minLiquidityUsd * 4) score += 6;
    else if (liquidity >= this.config.minLiquidityUsd) score += 3;

    if (volume >= 500_000) score += 5;
    else if (volume >= 100_000) score += 3;

    if (marketCap >= 2_000_000) score += 4;
    else if (marketCap >= 500_000) score += 2;

    return clamp(score, 0, 15);
  }

  private buildNarrative(candidate: TrendingEventCandidate, components: AttentionScoreComponents): string {
    const sourceLabel = resolveSourceLabel(candidate);
    const fragments = [
      `${sourceLabel} rank ${candidate.rank}`,
      typeof candidate.priceChange24hPct === 'number' ? `24h change ${candidate.priceChange24hPct.toFixed(1)}%` : null,
      typeof candidate.volume24hUsd === 'number' ? `24h volume $${Math.round(candidate.volume24hUsd).toLocaleString('en-US')}` : null,
      `timing ${components.timing}/20`,
    ].filter((fragment): fragment is string => !!fragment);

    return `${candidate.symbol} attention detected: ${fragments.join(', ')}`;
  }

  private resolveConfidence(
    attentionScore: number,
    candidate: TrendingEventCandidate
  ): 'low' | 'medium' | 'high' {
    const hasCoreMetrics =
      typeof candidate.priceChange24hPct === 'number' &&
      typeof candidate.volume24hUsd === 'number' &&
      typeof candidate.liquidityUsd === 'number';

    if (attentionScore >= 70 && hasCoreMetrics) return 'high';
    if (attentionScore >= 40) return 'medium';
    return 'low';
  }
}

/** @deprecated use AttentionScorer */
export const EventScorer = AttentionScorer;

function normalizeIso(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveSourceLabel(candidate: TrendingEventCandidate): string {
  const discoverySource = candidate.raw?.discovery_source;
  if (typeof discoverySource === 'string' && discoverySource.length > 0) {
    return discoverySource;
  }
  return candidate.source;
}
