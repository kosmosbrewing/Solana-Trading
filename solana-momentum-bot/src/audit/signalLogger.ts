import { Pool } from 'pg';
import { createModuleLogger } from '../utils/logger';
import { SignalAuditEntry } from '../utils/types';

const log = createModuleLogger('SignalAudit');

/**
 * Signal Audit Log — 모든 시그널의 발생/실행/폐기 추적
 */
export class SignalAuditLogger {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
        CREATE TABLE IF NOT EXISTS signal_audit_log (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          timestamp       TIMESTAMPTZ DEFAULT now(),
          pair_address    TEXT NOT NULL,
          strategy        TEXT NOT NULL,
          source_label    TEXT,
          attention_score NUMERIC,
          attention_confidence TEXT,
          volume_score    INTEGER,
        buy_ratio_score INTEGER,
        multi_tf_score  INTEGER,
        whale_score     INTEGER,
        lp_score        INTEGER,
        total_score     INTEGER NOT NULL,
        grade           TEXT NOT NULL,
        candle_close    NUMERIC NOT NULL,
        volume          NUMERIC NOT NULL,
        buy_volume      NUMERIC,
        sell_volume     NUMERIC,
        pool_tvl        NUMERIC NOT NULL,
        spread_pct      NUMERIC,
        action          TEXT NOT NULL,
        filter_reason   TEXT,
        position_size   NUMERIC,
        size_constraint TEXT,
        exit_price      NUMERIC,
        exit_reason     TEXT,
        pnl             NUMERIC,
        slippage_actual NUMERIC,
        effective_rr    NUMERIC,
        round_trip_cost NUMERIC,
        gate_trace      JSONB
      );

      CREATE INDEX IF NOT EXISTS idx_signal_audit_strategy
        ON signal_audit_log (strategy, grade, action);
      CREATE INDEX IF NOT EXISTS idx_signal_audit_time
        ON signal_audit_log (timestamp DESC);
    `);
    await this.pool.query(`
      ALTER TABLE signal_audit_log
      ADD COLUMN IF NOT EXISTS effective_rr NUMERIC,
      ADD COLUMN IF NOT EXISTS round_trip_cost NUMERIC,
      ADD COLUMN IF NOT EXISTS source_label TEXT,
      ADD COLUMN IF NOT EXISTS attention_score NUMERIC,
      ADD COLUMN IF NOT EXISTS attention_confidence TEXT,
      ADD COLUMN IF NOT EXISTS gate_trace JSONB
    `);
    log.info('SignalAuditLogger initialized');
  }

  async logSignal(entry: SignalAuditEntry): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO signal_audit_log (
        pair_address, strategy, source_label, attention_score, attention_confidence,
        volume_score, buy_ratio_score, multi_tf_score, whale_score, lp_score,
        total_score, grade,
        candle_close, volume, buy_volume, sell_volume,
        pool_tvl, spread_pct,
        action, filter_reason, position_size, size_constraint,
        effective_rr, round_trip_cost, gate_trace
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      RETURNING id`,
      [
        entry.pairAddress, entry.strategy, entry.sourceLabel ?? null,
        entry.attentionScore ?? null, entry.attentionConfidence ?? null,
        entry.volumeScore ?? null, entry.buyRatioScore ?? null,
        entry.multiTfScore ?? null, entry.whaleScore ?? null, entry.lpScore ?? null,
        entry.totalScore, entry.grade,
        entry.candleClose, entry.volume,
        entry.buyVolume ?? null, entry.sellVolume ?? null,
        entry.poolTvl, entry.spreadPct ?? null,
        entry.action, entry.filterReason ?? null,
        entry.positionSize ?? null, entry.sizeConstraint ?? null,
        entry.effectiveRR ?? null, entry.roundTripCost ?? null,
        entry.gateTrace ?? null,
      ]
    );
    return result.rows[0].id;
  }

  async updateTradeResult(
    auditId: string,
    exitPrice: number,
    exitReason: string,
    pnl: number,
    slippageActual: number
  ): Promise<void> {
    await this.pool.query(
      `UPDATE signal_audit_log SET
        exit_price = $2, exit_reason = $3, pnl = $4, slippage_actual = $5
       WHERE id = $1`,
      [auditId, exitPrice, exitReason, pnl, slippageActual]
    );
  }

  async getTodaySignalCounts(): Promise<{ detected: number; executed: number; filtered: number }> {
    const result = await this.pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE action = 'EXECUTED') as executed,
        COUNT(*) FILTER (WHERE action != 'EXECUTED') as filtered
      FROM signal_audit_log
      WHERE timestamp >= CURRENT_DATE
    `);
    const row = result.rows[0];
    return {
      detected: Number(row.total),
      executed: Number(row.executed),
      filtered: Number(row.filtered),
    };
  }

  async getCadenceSignalSummary(hours: number[]): Promise<{
    lastSignalAt?: Date;
    windows: Array<{ hours: number; detected: number; executed: number; filtered: number }>;
  }> {
    const latestResult = await this.pool.query(`
      SELECT MAX(timestamp) AS last_signal_at
      FROM signal_audit_log
    `);
    const lastSignalAtRaw = latestResult.rows[0]?.last_signal_at;
    const windows = [];

    for (const hour of hours) {
      const result = await this.pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE action = 'EXECUTED') AS executed,
          COUNT(*) FILTER (WHERE action != 'EXECUTED') AS filtered
        FROM signal_audit_log
        WHERE timestamp >= now() - ($1::text || ' hours')::interval
      `, [String(hour)]);
      const row = result.rows[0];
      windows.push({
        hours: hour,
        detected: Number(row.total),
        executed: Number(row.executed),
        filtered: Number(row.filtered),
      });
    }

    return {
      lastSignalAt: lastSignalAtRaw ? new Date(lastSignalAtRaw as string) : undefined,
      windows,
    };
  }

  async getRecentGateFilterReasonCounts(hours: number): Promise<Array<{ reason: string; count: number }>> {
    const result = await this.pool.query(`
      SELECT
        COALESCE(filter_reason, 'unknown') AS reason,
        COUNT(DISTINCT pair_address)::INTEGER AS count
      FROM signal_audit_log
      WHERE timestamp >= now() - ($1::text || ' hours')::interval
        AND action = 'FILTERED'
        AND (
          filter_reason LIKE 'security_rejected:%'
          OR filter_reason LIKE 'quote_rejected:%'
          OR filter_reason LIKE 'poor_execution_viability:%'
          OR filter_reason LIKE 'exit_illiquid:%'
          OR filter_reason LIKE 'buy_ratio %'
          OR filter_reason LIKE 'Score %'
          OR filter_reason = 'not_trending'
        )
      GROUP BY COALESCE(filter_reason, 'unknown')
      ORDER BY COUNT(DISTINCT pair_address) DESC, reason ASC
    `, [String(hours)]);

    return result.rows.map((row) => ({
      reason: String(row.reason),
      count: Number(row.count),
    }));
  }
}
