import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('SocialMentionTracker');

export interface SocialMention {
  tokenMint: string;
  tokenSymbol: string;
  mentionCount: number;
  influencerMentions: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface SocialMentionConfig {
  /** X/Twitter Bearer Token (API v2 Filtered Stream) */
  twitterBearerToken?: string;
  /** Minimum follower count to qualify as "influencer" */
  influencerMinFollowers: number;
  /** Window for counting mentions (ms) */
  mentionWindowMs: number;
  /** Keywords to track (e.g., token symbols, contract addresses) */
  trackKeywords: string[];
}

const DEFAULT_CONFIG: SocialMentionConfig = {
  influencerMinFollowers: 10_000,
  mentionWindowMs: 3600_000, // 1 hour
  trackKeywords: [],
};

/**
 * Social Mention Tracker — X/Twitter mention count for WatchlistScore.
 *
 * Phase 2 구현:
 *   - X Filtered Stream P99 ≈ 6~7초 → 매수 트리거로는 불적합
 *   - WatchlistScore의 social_mention_count 피처로만 사용
 *   - influencer 멘션은 별도 가중치
 *
 * Note: Full X Filtered Stream integration requires elevated API access.
 * This implementation provides:
 *   1. Manual mention registration (from external feed/webhook)
 *   2. Mention count aggregation within rolling window
 *   3. Score calculation for WatchlistScore integration
 */
export class SocialMentionTracker {
  private config: SocialMentionConfig;
  private mentions = new Map<string, SocialMention>();

  constructor(config: Partial<SocialMentionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a mention event (from X stream, webhook, or manual feed).
   */
  recordMention(
    tokenMint: string,
    tokenSymbol: string,
    isInfluencer = false
  ): void {
    const now = new Date();
    const existing = this.mentions.get(tokenMint);

    if (existing) {
      existing.mentionCount++;
      if (isInfluencer) existing.influencerMentions++;
      existing.lastSeenAt = now;

      // Reset if outside window
      const windowStart = new Date(Date.now() - this.config.mentionWindowMs);
      if (existing.firstSeenAt < windowStart) {
        existing.firstSeenAt = now;
        existing.mentionCount = 1;
        existing.influencerMentions = isInfluencer ? 1 : 0;
      }
    } else {
      this.mentions.set(tokenMint, {
        tokenMint,
        tokenSymbol,
        mentionCount: 1,
        influencerMentions: isInfluencer ? 1 : 0,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
  }

  /**
   * Get mention data for WatchlistScore integration.
   * Returns mention count within the rolling window.
   */
  getMentionData(tokenMint: string): SocialMention | undefined {
    const mention = this.mentions.get(tokenMint);
    if (!mention) return undefined;

    const windowStart = new Date(Date.now() - this.config.mentionWindowMs);
    if (mention.lastSeenAt < windowStart) {
      this.mentions.delete(tokenMint);
      return undefined;
    }

    return { ...mention };
  }

  /**
   * Calculate social score component for WatchlistScore (0-15).
   * Replaces the unused portion of the momentum score allocation.
   */
  calcSocialScore(tokenMint: string): number {
    const mention = this.getMentionData(tokenMint);
    if (!mention) return 0;

    let score = 0;

    // Mention volume (0-8)
    if (mention.mentionCount >= 50) score += 8;
    else if (mention.mentionCount >= 20) score += 6;
    else if (mention.mentionCount >= 10) score += 4;
    else if (mention.mentionCount >= 3) score += 2;

    // Influencer signal (0-7)
    if (mention.influencerMentions >= 3) score += 7;
    else if (mention.influencerMentions >= 2) score += 5;
    else if (mention.influencerMentions >= 1) score += 3;

    return Math.min(15, score);
  }

  /**
   * Get all active mentions (within window).
   */
  getActiveMentions(): SocialMention[] {
    const windowStart = new Date(Date.now() - this.config.mentionWindowMs);
    const active: SocialMention[] = [];

    for (const [mint, mention] of this.mentions) {
      if (mention.lastSeenAt < windowStart) {
        this.mentions.delete(mint);
      } else {
        active.push({ ...mention });
      }
    }

    return active;
  }

  /**
   * Prune expired mentions.
   */
  prune(): number {
    const windowStart = new Date(Date.now() - this.config.mentionWindowMs);
    let pruned = 0;

    for (const [mint, mention] of this.mentions) {
      if (mention.lastSeenAt < windowStart) {
        this.mentions.delete(mint);
        pruned++;
      }
    }

    if (pruned > 0) {
      log.debug(`Pruned ${pruned} expired mentions`);
    }
    return pruned;
  }
}
