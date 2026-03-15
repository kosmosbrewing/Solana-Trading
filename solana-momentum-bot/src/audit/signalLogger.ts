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
        round_trip_cost NUMERIC
      );

      CREATE INDEX IF NOT EXISTS idx_signal_audit_strategy
        ON signal_audit_log (strategy, grade, action);
      CREATE INDEX IF NOT EXISTS idx_signal_audit_time
        ON signal_audit_log (timestamp DESC);
    `);
    await this.pool.query(`
      ALTER TABLE signal_audit_log
      ADD COLUMN IF NOT EXISTS effective_rr NUMERIC,
      ADD COLUMN IF NOT EXISTS round_trip_cost NUMERIC
    `);
    log.info('SignalAuditLogger initialized');
  }

  async logSignal(entry: SignalAuditEntry): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO signal_audit_log (
        pair_address, strategy,
        volume_score, buy_ratio_score, multi_tf_score, whale_score, lp_score,
        total_score, grade,
        candle_close, volume, buy_volume, sell_volume,
        pool_tvl, spread_pct,
        action, filter_reason, position_size, size_constraint,
        effective_rr, round_trip_cost
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING id`,
      [
        entry.pairAddress, entry.strategy,
        entry.volumeScore ?? null, entry.buyRatioScore ?? null,
        entry.multiTfScore ?? null, entry.whaleScore ?? null, entry.lpScore ?? null,
        entry.totalScore, entry.grade,
        entry.candleClose, entry.volume,
        entry.buyVolume ?? null, entry.sellVolume ?? null,
        entry.poolTvl, entry.spreadPct ?? null,
        entry.action, entry.filterReason ?? null,
        entry.positionSize ?? null, entry.sizeConstraint ?? null,
        entry.effectiveRR ?? null, entry.roundTripCost ?? null,
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
}
