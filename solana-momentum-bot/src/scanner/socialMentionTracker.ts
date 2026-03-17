import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('SocialMentionTracker');

const X_FILTERED_STREAM_URL =
  'https://api.twitter.com/2/tweets/search/stream?tweet.fields=created_at,author_id&expansions=author_id&user.fields=public_metrics,username';

type FetchLike = typeof fetch;

export interface TrackedSocialToken {
  tokenMint: string;
  tokenSymbol: string;
  keywords: string[];
}

export interface FilteredStreamUser {
  id: string;
  username?: string;
  public_metrics?: {
    followers_count?: number;
  };
}

export interface FilteredStreamTweetPayload {
  data?: {
    id?: string;
    text?: string;
    author_id?: string;
    created_at?: string;
  };
  includes?: {
    users?: FilteredStreamUser[];
  };
}

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
  private trackedTokens = new Map<string, TrackedSocialToken>();
  private streamAbort: AbortController | null = null;
  private streamTask: Promise<void> | null = null;

  constructor(config: Partial<SocialMentionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  registerTrackedToken(
    tokenMint: string,
    tokenSymbol: string,
    keywords: string[] = []
  ): void {
    const normalized = normalizeKeywords([
      tokenSymbol,
      tokenMint,
      ...keywords,
    ]);
    if (normalized.length === 0) return;

    this.trackedTokens.set(tokenMint, {
      tokenMint,
      tokenSymbol,
      keywords: normalized,
    });
  }

  unregisterTrackedToken(tokenMint: string): void {
    this.trackedTokens.delete(tokenMint);
  }

  getTrackedTokenCount(): number {
    return this.trackedTokens.size;
  }

  async startFilteredStream(fetchImpl: FetchLike = fetch): Promise<boolean> {
    if (!this.config.twitterBearerToken) {
      log.info('Filtered stream disabled: TWITTER_BEARER_TOKEN not configured');
      return false;
    }
    if (this.streamTask) {
      return true;
    }
    if (this.trackedTokens.size === 0) {
      log.info('Filtered stream skipped: no tracked tokens registered');
      return false;
    }

    this.streamAbort = new AbortController();
    this.streamTask = this.runFilteredStream(fetchImpl, this.streamAbort.signal)
      .catch((error) => {
        if ((error as Error)?.name !== 'AbortError') {
          log.warn(`Filtered stream stopped: ${error}`);
        }
      })
      .finally(() => {
        this.streamTask = null;
        this.streamAbort = null;
      });

    return true;
  }

  stopFilteredStream(): void {
    this.streamAbort?.abort();
  }

  async waitForStreamStop(): Promise<void> {
    await this.streamTask;
  }

  consumeFilteredStreamLine(line: string): number {
    const trimmed = line.trim();
    if (!trimmed) return 0;

    try {
      const payload = JSON.parse(trimmed) as FilteredStreamTweetPayload;
      return this.ingestFilteredStreamEvent(payload);
    } catch (error) {
      log.debug(`Ignoring malformed filtered stream line: ${error}`);
      return 0;
    }
  }

  ingestFilteredStreamEvent(payload: FilteredStreamTweetPayload): number {
    const text = payload.data?.text?.toLowerCase();
    if (!text) return 0;

    const authorId = payload.data?.author_id;
    const user = payload.includes?.users?.find(candidate => candidate.id === authorId);
    const isInfluencer = (user?.public_metrics?.followers_count ?? 0) >= this.config.influencerMinFollowers;

    let matched = 0;
    for (const tracked of this.trackedTokens.values()) {
      if (tracked.keywords.some(keyword => text.includes(keyword))) {
        this.recordMention(tracked.tokenMint, tracked.tokenSymbol, isInfluencer);
        matched++;
      }
    }

    return matched;
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
      // 윈도우 초과 시 먼저 리셋한 뒤 현재 mention 반영 (C-05)
      const windowStart = new Date(Date.now() - this.config.mentionWindowMs);
      if (existing.firstSeenAt < windowStart) {
        existing.firstSeenAt = now;
        existing.mentionCount = 0;
        existing.influencerMentions = 0;
      }

      existing.mentionCount++;
      if (isInfluencer) existing.influencerMentions++;
      existing.lastSeenAt = now;
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

  private async runFilteredStream(fetchImpl: FetchLike, signal: AbortSignal): Promise<void> {
    const response = await fetchImpl(X_FILTERED_STREAM_URL, {
      headers: {
        Authorization: `Bearer ${this.config.twitterBearerToken}`,
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`X filtered stream request failed: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error('X filtered stream response body unavailable');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        this.consumeFilteredStreamLine(line);
      }
    }
  }
}

function normalizeKeywords(keywords: string[]): string[] {
  return [...new Set(
    keywords
      .map(keyword => keyword.trim().toLowerCase())
      .filter(keyword => keyword.length > 0)
  )];
}
