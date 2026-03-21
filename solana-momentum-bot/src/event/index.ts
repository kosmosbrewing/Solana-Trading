import { EventEmitter } from 'events';
import { GeckoTerminalClient } from '../ingester/geckoTerminalClient';
import { createModuleLogger } from '../utils/logger';
import { EventMonitorConfig, AttentionScore } from './types';
import { AttentionScorer } from './eventScorer';
import { EventScoreStore } from './eventScoreStore';
import { TrendingFetcher } from './trendingFetcher';

const log = createModuleLogger('EventMonitor');

export class EventMonitor extends EventEmitter {
  private readonly fetcher: TrendingFetcher;
  private readonly scorer: AttentionScorer;
  private timer?: NodeJS.Timeout;
  // tokenMint → 최신 AttentionScore (만료 관리 포함)
  private readonly latestScores = new Map<string, AttentionScore>();
  /** Phase 2: Optional persistent store for historical replay (C-1) */
  private scoreStore?: EventScoreStore;

  constructor(
    geckoClient: GeckoTerminalClient,
    private readonly config: EventMonitorConfig
  ) {
    super();
    this.fetcher = new TrendingFetcher(geckoClient, { limit: config.fetchLimit });
    this.scorer = new AttentionScorer({
      expiryMinutes: config.expiryMinutes,
      minLiquidityUsd: config.minLiquidityUsd,
    });
  }

  /** Attach a persistent store for historical EventScore collection (C-1). */
  setScoreStore(store: EventScoreStore): void {
    this.scoreStore = store;
  }

  /** 특정 토큰의 유효한 AttentionScore 반환. 만료 시 undefined. */
  getScoreByMint(tokenMint: string): AttentionScore | undefined {
    const score = this.latestScores.get(tokenMint);
    if (!score) return undefined;
    if (new Date(score.expiresAt).getTime() < Date.now()) {
      this.latestScores.delete(tokenMint);
      return undefined;
    }
    return score;
  }

  /** 전체 유효 AttentionScore Map 반환 (만료 항목 제외) */
  getScoresByMint(): ReadonlyMap<string, AttentionScore> {
    const now = Date.now();
    for (const [mint, score] of this.latestScores) {
      if (new Date(score.expiresAt).getTime() < now) {
        this.latestScores.delete(mint);
      }
    }
    return this.latestScores;
  }

  async start(): Promise<void> {
    await this.poll();
    this.timer = setInterval(() => {
      this.poll().catch((error) => {
        log.error(`Event polling failed: ${error}`);
        this.emit('error', error);
      });
    }, this.config.pollingIntervalMs);
    log.info(`EventMonitor started (poll every ${this.config.pollingIntervalMs / 1000}s)`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<AttentionScore[]> {
    const candidates = await this.fetcher.fetchCandidates();
    const scores = candidates
      .map((candidate) => this.scorer.score(candidate))
      .filter((score) => score.attentionScore >= this.config.minAttentionScore);

    // 최신 스코어 캐시 갱신
    for (const score of scores) {
      this.latestScores.set(score.tokenMint, score);
    }

    if (scores.length > 0) {
      this.emit('events', scores);
      log.info(`Generated ${scores.length} AttentionScore payloads`);

      // Phase 2: Persist to DB for historical replay (C-1)
      if (this.scoreStore) {
        this.scoreStore.insertScores(scores).catch(err => {
          log.warn(`Failed to persist EventScores: ${err}`);
        });
      }
    } else {
      log.info('No AttentionScore payloads passed the minimum threshold');
    }

    return scores;
  }
}

export { AttentionScorer, AttentionScorer as EventScorer } from './eventScorer';
export { TrendingFetcher } from './trendingFetcher';
export { EventScoreStore } from './eventScoreStore';
export type {
  EventMonitorConfig,
  AttentionScore,
  AttentionScoreComponents,
  AttentionScorerConfig,
  // deprecated aliases
  EventScore,
  EventScoreComponents,
  EventScorerConfig,
  TrendingEventCandidate,
  TrendingFetcherConfig,
} from './types';
