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

  /**
   * H-26: DB 쿼리 retry 래퍼 — 일시 장애 시 최대 retries회 재시도 (exponential backoff)
   */
  private async withRetry<T>(label: string, fn: () => Promise<T>, retries = 2): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt > retries) throw err;
        const delay = Math.pow(2, attempt) * 500;
        log.warn(`${label} failed (attempt ${attempt}/${retries + 1}): ${err}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  /**
   * H-19: retry 포함 초기화 — DB 일시 장애 시 최대 3회 재시도
   */
  async initialize(maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
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
          CREATE UNIQUE INDEX IF NOT EXISTS idx_event_scores_mint_detected
          ON event_scores (token_mint, detected_at)
        `);
        await this.pool.query(`
          CREATE INDEX IF NOT EXISTS idx_event_scores_detected
          ON event_scores (detected_at)
        `);
        log.info('EventScoreStore initialized');
        return;
      } catch (err) {
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000;
          log.warn(`EventScoreStore init failed (attempt ${attempt}/${maxRetries}): ${err}. Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw new Error(`EventScoreStore initialization failed after ${maxRetries} attempts: ${err}`);
        }
      }
    }
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

    await this.withRetry('insertScores', () =>
      this.pool.query(
        `INSERT INTO event_scores
          (token_mint, token_symbol, attention_score, components, narrative, sources, confidence, detected_at, expires_at)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (token_mint, detected_at) DO NOTHING`,
        values
      )
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
    const result = await this.withRetry('getScoresForToken', () =>
      this.pool.query<{
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
      `, [tokenMint, fromTime, toTime])
    );

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
    const result = await this.withRetry('exportTimeline', () =>
      this.pool.query<{
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
      `, [fromTime, toTime, limit])
    );

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
    // 배치 삭제로 DB lock 방지 (H-16)
    let totalDeleted = 0;
    const BATCH_SIZE = 1000;
    let deleted: number;
    do {
      const result = await this.pool.query(
        `DELETE FROM event_scores WHERE id IN (
           SELECT id FROM event_scores WHERE detected_at < $1 LIMIT $2
         )`,
        [cutoff, BATCH_SIZE]
      );
      deleted = result.rowCount ?? 0;
      totalDeleted += deleted;
    } while (deleted === BATCH_SIZE);
    if (totalDeleted > 0) {
      log.info(`Pruned ${totalDeleted} event scores older than ${days} days`);
    }
    return totalDeleted;
  }
}
