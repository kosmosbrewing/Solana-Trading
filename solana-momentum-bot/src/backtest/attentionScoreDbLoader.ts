import { Pool } from 'pg';
import { BacktestAttentionScoreEntry } from './types';
import { EventScoreStore } from '../event/eventScoreStore';

/**
 * DB-based AttentionScore loader for backtesting (C-1 완결).
 *
 * Preloads historical EventScores from DB into an in-memory timeline
 * compatible with BacktestConfig.attentionScoreTimeline.
 *
 * Usage:
 *   const loader = new AttentionScoreDbLoader(pool);
 *   const timeline = await loader.loadTimeline(startDate, endDate);
 *   engine = new BacktestEngine({ ...config, attentionScoreTimeline: timeline });
 */
export class AttentionScoreDbLoader {
  private store: EventScoreStore;

  constructor(pool: Pool) {
    this.store = new EventScoreStore(pool);
  }

  /**
   * Load all EventScores within a backtest date range.
   * Returns data compatible with BacktestConfig.attentionScoreTimeline.
   */
  async loadTimeline(
    fromTime: Date,
    toTime: Date,
    tokenMint?: string
  ): Promise<BacktestAttentionScoreEntry[]> {
    if (tokenMint) {
      const scores = await this.store.getScoresForToken(tokenMint, fromTime, toTime);
      return scores.map(s => ({ ...s }));
    }

    const scores = await this.store.exportTimeline(fromTime, toTime);
    return scores.map(s => ({ ...s }));
  }
}
