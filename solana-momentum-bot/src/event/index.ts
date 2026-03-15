import { EventEmitter } from 'events';
import { BirdeyeClient } from '../ingester';
import { createModuleLogger } from '../utils/logger';
import { EventMonitorConfig, EventScore } from './types';
import { EventScorer } from './eventScorer';
import { TrendingFetcher } from './trendingFetcher';

const log = createModuleLogger('EventMonitor');

export class EventMonitor extends EventEmitter {
  private readonly fetcher: TrendingFetcher;
  private readonly scorer: EventScorer;
  private timer?: NodeJS.Timeout;
  // tokenMint → 최신 EventScore (만료 관리 포함)
  private readonly latestScores = new Map<string, EventScore>();

  constructor(
    birdeyeClient: BirdeyeClient,
    private readonly config: EventMonitorConfig
  ) {
    super();
    this.fetcher = new TrendingFetcher(birdeyeClient, { limit: config.fetchLimit });
    this.scorer = new EventScorer({
      expiryMinutes: config.expiryMinutes,
      minLiquidityUsd: config.minLiquidityUsd,
    });
  }

  /** 특정 토큰의 유효한 EventScore 반환. 만료 시 undefined. */
  getScoreByMint(tokenMint: string): EventScore | undefined {
    const score = this.latestScores.get(tokenMint);
    if (!score) return undefined;
    if (new Date(score.expiresAt).getTime() < Date.now()) {
      this.latestScores.delete(tokenMint);
      return undefined;
    }
    return score;
  }

  /** 전체 유효 EventScore Map 반환 (만료 항목 제외) */
  getAllActiveScores(): Map<string, EventScore> {
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

  async poll(): Promise<EventScore[]> {
    const candidates = await this.fetcher.fetchCandidates();
    const scores = candidates
      .map((candidate) => this.scorer.score(candidate))
      .filter((score) => score.eventScore >= this.config.minEventScore);

    // 최신 스코어 캐시 갱신
    for (const score of scores) {
      this.latestScores.set(score.tokenMint, score);
    }

    if (scores.length > 0) {
      this.emit('events', scores);
      log.info(`Generated ${scores.length} EventScore payloads`);
    } else {
      log.info('No EventScore payloads passed the minimum threshold');
    }

    return scores;
  }
}

export { EventScorer } from './eventScorer';
export { TrendingFetcher } from './trendingFetcher';
export type {
  EventMonitorConfig,
  EventScore,
  EventScoreComponents,
  EventScorerConfig,
  TrendingEventCandidate,
  TrendingFetcherConfig,
} from './types';
