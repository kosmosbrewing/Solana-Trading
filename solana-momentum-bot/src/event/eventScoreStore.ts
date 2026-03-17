import { Pool } from 'pg';
import { createModuleLogger } from '../utils/logger';
import { AttentionScore } from './types';

const log = createModuleLogger('EventScoreStore');

/**
 * Persistent store for AttentionScore history.
 *
 * Stores every generated AttentionScore with timestamp for:
 * - Historical replay in backtest (C-1)
 * - Regime filter breadth/follow-through analysis
 * - Post-mortem analysis of missed/false signals
 */
export class EventScoreStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS event_scores (
        id SERIAL PRIMARY KEY,
        token_mint TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        attention_score REAL NOT NULL,
        components JSONB NOT NULL,
        narrative TEXT,
        sources JSONB,
        confidence TEXT NOT NULL,
        detected_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_event_scores_mint_detected
      ON event_scores (token_mint, detected_at)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_event_scores_detected
      ON event_scores (detected_at)
    `);
    log.info('EventScoreStore initialized');
  }

  /**
   * Persist a batch of AttentionScores.
   * Called after each EventMonitor poll cycle.
   */
  async insertScores(scores: AttentionScore[]): Promise<void> {
    if (scores.length === 0) return;

    const values: unknown[] = [];
    const placeholders: string[] = [];
    let idx = 1;

    for (const s of scores) {
      placeholders.push(
        `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
      );
      values.push(
        s.tokenMint,
        s.tokenSymbol,
        s.attentionScore,
        JSON.stringify(s.components),
        s.narrative,
        JSON.stringify(s.sources),
        s.confidence,
        s.detectedAt,
        s.expiresAt,
      );
    }

    await this.pool.query(
      `INSERT INTO event_scores
        (token_mint, token_symbol, attention_score, components, narrative, sources, confidence, detected_at, expires_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT DO NOTHING`,
      values
    );
  }

  /**
   * Retrieve historical scores for a token within a time window.
   * Used for backtest replay (C-1).
   */
  async getScoresForToken(
    tokenMint: string,
    fromTime: Date,
    toTime: Date
  ): Promise<AttentionScore[]> {
    const result = await this.pool.query<{
      token_mint: string;
      token_symbol: string;
      attention_score: number;
      components: AttentionScore['components'];
      narrative: string;
      sources: string[];
      confidence: string;
      detected_at: Date;
      expires_at: Date;
    }>(`
      SELECT token_mint, token_symbol, attention_score, components,
             narrative, sources, confidence, detected_at, expires_at
      FROM event_scores
      WHERE token_mint = $1 AND detected_at >= $2 AND detected_at <= $3
      ORDER BY detected_at ASC
    `, [tokenMint, fromTime, toTime]);

    return result.rows.map(row => ({
      tokenMint: row.token_mint,
      tokenSymbol: row.token_symbol,
      attentionScore: row.attention_score,
      components: row.components,
      narrative: row.narrative,
      sources: row.sources,
      confidence: row.confidence as AttentionScore['confidence'],
      detectedAt: row.detected_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    }));
  }

  /**
   * Export all scores in a time range for backtest timeline file.
   * Returns data compatible with BacktestAttentionScoreEntry format.
   */
  async exportTimeline(
    fromTime: Date,
    toTime: Date,
    limit = 10000
  ): Promise<AttentionScore[]> {
    const result = await this.pool.query<{
      token_mint: string;
      token_symbol: string;
      attention_score: number;
      components: AttentionScore['components'];
      narrative: string;
      sources: string[];
      confidence: string;
      detected_at: Date;
      expires_at: Date;
    }>(`
      SELECT token_mint, token_symbol, attention_score, components,
             narrative, sources, confidence, detected_at, expires_at
      FROM event_scores
      WHERE detected_at >= $1 AND detected_at <= $2
      ORDER BY detected_at ASC
      LIMIT $3
    `, [fromTime, toTime, limit]);

    return result.rows.map(row => ({
      tokenMint: row.token_mint,
      tokenSymbol: row.token_symbol,
      attentionScore: row.attention_score,
      components: row.components,
      narrative: row.narrative,
      sources: row.sources,
      confidence: row.confidence as AttentionScore['confidence'],
      detectedAt: row.detected_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    }));
  }

  /**
   * Cleanup old entries to prevent unbounded growth.
   * Keeps last N days of data.
   */
  async pruneOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86400_000);
    const result = await this.pool.query(
      'DELETE FROM event_scores WHERE detected_at < $1',
      [cutoff]
    );
    const deleted = result.rowCount ?? 0;
    if (deleted > 0) {
      log.info(`Pruned ${deleted} event scores older than ${days} days`);
    }
    return deleted;
  }
}
