import { Pool } from 'pg';
import { createModuleLogger } from '../utils/logger';
import { Trade } from '../utils/types';

const log = createModuleLogger('TradeStore');

export class TradeStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS trades (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          pair_address    TEXT NOT NULL,
          strategy        TEXT NOT NULL,
          side            TEXT NOT NULL,
          token_symbol    TEXT,
          entry_price     NUMERIC NOT NULL,
          source_label    TEXT,
          exit_price      NUMERIC,
          quantity        NUMERIC NOT NULL,
          pnl             NUMERIC,
          slippage        NUMERIC,
          breakout_score  INTEGER,
          breakout_grade  TEXT,
          size_constraint TEXT,
          exit_reason     TEXT,
          tx_signature    TEXT,
          status          TEXT NOT NULL DEFAULT 'OPEN',
          stop_loss       NUMERIC NOT NULL,
          take_profit1    NUMERIC NOT NULL,
          take_profit2    NUMERIC NOT NULL,
          trailing_stop   NUMERIC,
          high_water_mark NUMERIC,
          time_stop_at    TIMESTAMPTZ,
          created_at      TIMESTAMPTZ DEFAULT now(),
          closed_at       TIMESTAMPTZ
        );
      `);

      await client.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS source_label TEXT;
      `);

      await client.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS token_symbol TEXT;
      `);

      await client.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS discovery_source TEXT;
      `);

      // P0-2: cost decomposition 컬럼
      await client.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS entry_slippage_bps INTEGER,
        ADD COLUMN IF NOT EXISTS exit_slippage_bps INTEGER,
        ADD COLUMN IF NOT EXISTS entry_price_impact_pct NUMERIC,
        ADD COLUMN IF NOT EXISTS round_trip_cost_pct NUMERIC,
        ADD COLUMN IF NOT EXISTS effective_rr NUMERIC;
      `);

      // P1-4: degraded exit telemetry 컬럼
      await client.query(`
        ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS degraded_trigger_reason TEXT,
        ADD COLUMN IF NOT EXISTS degraded_quote_fail_count INTEGER,
        ADD COLUMN IF NOT EXISTS parent_trade_id UUID;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);
        CREATE INDEX IF NOT EXISTS idx_trades_created ON trades (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades (pair_address, created_at DESC);
      `);

      log.info('TradeStore initialized');
    } finally {
      client.release();
    }
  }

  async insertTrade(trade: Omit<Trade, 'id'>): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO trades (pair_address, strategy, side, token_symbol, entry_price, source_label, discovery_source, quantity,
        stop_loss, take_profit1, take_profit2, trailing_stop, high_water_mark, time_stop_at,
        status, tx_signature, breakout_score, breakout_grade, size_constraint,
        entry_slippage_bps, entry_price_impact_pct, round_trip_cost_pct, effective_rr,
        degraded_trigger_reason, degraded_quote_fail_count, parent_trade_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23, $24, $25, $26)
       RETURNING id`,
      [
        trade.pairAddress, trade.strategy, trade.side, trade.tokenSymbol ?? null, trade.entryPrice,
        trade.sourceLabel ?? null, trade.discoverySource ?? null,
        trade.quantity, trade.stopLoss, trade.takeProfit1, trade.takeProfit2,
        trade.trailingStop || null, trade.highWaterMark ?? trade.entryPrice, trade.timeStopAt, trade.status,
        trade.txSignature || null,
        trade.breakoutScore ?? null, trade.breakoutGrade ?? null,
        trade.sizeConstraint ?? null,
        trade.entrySlippageBps ?? null, trade.entryPriceImpactPct ?? null,
        trade.roundTripCostPct ?? null, trade.effectiveRR ?? null,
        trade.degradedTriggerReason ?? null, trade.degradedQuoteFailCount ?? null,
        trade.parentTradeId ?? null,
      ]
    );
    if (result.rows.length === 0) {
      throw new Error('INSERT INTO trades returned no rows');
    }
    return result.rows[0].id;
  }

  async closeTrade(
    id: string,
    exitPrice: number,
    pnl: number,
    slippage: number,
    exitReason?: string,
    quantity?: number,
    exitSlippageBps?: number,
    degradedTriggerReason?: string,
    degradedQuoteFailCount?: number
  ): Promise<void> {
    const setClauses = [
      'exit_price = $2',
      'pnl = $3',
      'slippage = $4',
      'exit_reason = $5',
      `status = 'CLOSED'`,
      `closed_at = now()`,
    ];
    const params: unknown[] = [id, exitPrice, pnl, slippage, exitReason ?? null];

    if (quantity !== undefined) {
      setClauses.push(`quantity = $${params.length + 1}`);
      params.push(quantity);
    }

    if (exitSlippageBps !== undefined) {
      setClauses.push(`exit_slippage_bps = $${params.length + 1}`);
      params.push(exitSlippageBps);
    }

    if (degradedTriggerReason !== undefined) {
      setClauses.push(`degraded_trigger_reason = $${params.length + 1}`);
      params.push(degradedTriggerReason);
    }

    if (degradedQuoteFailCount !== undefined) {
      setClauses.push(`degraded_quote_fail_count = $${params.length + 1}`);
      params.push(degradedQuoteFailCount);
    }

    await this.pool.query(
      `UPDATE trades SET ${setClauses.join(', ')}
       WHERE id = $1`,
      params
    );
  }

  async updateHighWaterMark(id: string, highWaterMark: number): Promise<void> {
    await this.pool.query(
      `UPDATE trades
       SET high_water_mark = GREATEST(COALESCE(high_water_mark, 0), $2)
       WHERE id = $1`,
      [id, highWaterMark]
    );
  }

  async failTrade(id: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE trades SET status = 'FAILED', closed_at = now()
       WHERE id = $1`,
      [id]
    );
    log.warn(`Trade ${id} marked as FAILED: ${reason}`);
  }

  async getOpenTrades(): Promise<Trade[]> {
    const result = await this.pool.query(
      `SELECT * FROM trades WHERE status = 'OPEN' ORDER BY created_at ASC`
    );
    return result.rows.map(rowToTrade);
  }

  async getTodayTradeCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as cnt FROM trades WHERE created_at >= CURRENT_DATE`
    );
    return Number(result.rows[0].cnt);
  }

  async getTodayPnl(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(pnl), 0) as total_pnl FROM trades
       WHERE closed_at >= CURRENT_DATE AND status = 'CLOSED'`
    );
    return Number(result.rows[0].total_pnl);
  }

  async getTodayTrades(): Promise<Trade[]> {
    const result = await this.pool.query(
      `SELECT * FROM trades
       WHERE created_at >= CURRENT_DATE
       ORDER BY created_at ASC`
    );
    return result.rows.map(rowToTrade);
  }

  async getTradesCreatedWithinHours(hours: number): Promise<Trade[]> {
    const result = await this.pool.query(
      `SELECT * FROM trades
       WHERE created_at >= now() - ($1::text || ' hours')::interval
       ORDER BY created_at ASC`,
      [String(hours)]
    );
    return result.rows.map(rowToTrade);
  }

  async getClosedPnlWithinHours(hours: number): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(pnl), 0) as total_pnl FROM trades
       WHERE status = 'CLOSED'
         AND closed_at >= now() - ($1::text || ' hours')::interval`,
      [String(hours)]
    );
    return Number(result.rows[0].total_pnl);
  }

  async getClosedTradesWithinHours(hours: number): Promise<Trade[]> {
    const result = await this.pool.query(
      `SELECT * FROM trades
       WHERE status = 'CLOSED'
         AND closed_at >= now() - ($1::text || ' hours')::interval
       ORDER BY closed_at ASC, created_at ASC`,
      [String(hours)]
    );
    return result.rows.map(rowToTrade);
  }

  // Why: MEASUREMENT.md "최근 50 executed trades" — 실제 신규 진입만 (open/closed 무관, created_at 기준)
  // parent_trade_id IS NULL: partial exit child trade 제외 (TP1 잔여, degraded 잔여, Grade B 잔여)
  // status != FAILED: 주문 실패/복구 실패 row는 executed entry 표본에서 제외
  async getRecentExecutedEntries(limit: number): Promise<Trade[]> {
    const result = await this.pool.query(
      `SELECT * FROM trades
       WHERE parent_trade_id IS NULL
         AND status != 'FAILED'
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(rowToTrade);
  }

  async getRecentClosedTrades(limit: number): Promise<Trade[]> {
    const result = await this.pool.query(
      `SELECT * FROM trades
       WHERE status = 'CLOSED'
       ORDER BY closed_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map(rowToTrade);
  }

  async getClosedTradesChronological(): Promise<Trade[]> {
    const result = await this.pool.query(
      `SELECT * FROM trades
       WHERE status = 'CLOSED'
       ORDER BY closed_at ASC, created_at ASC`
    );
    return result.rows.map(rowToTrade);
  }

  async getExitReasonBreakdown(hours: number): Promise<Array<{
    strategy: string;
    exitReason: string;
    count: number;
    avgPnl: number;
  }>> {
    const result = await this.pool.query(`
      SELECT
        strategy,
        COALESCE(exit_reason, 'unknown') AS exit_reason,
        COUNT(*)::INTEGER AS count,
        ROUND(AVG(COALESCE(pnl, 0))::NUMERIC, 6) AS avg_pnl
      FROM trades
      WHERE status = 'CLOSED'
        AND closed_at >= now() - ($1::text || ' hours')::interval
      GROUP BY strategy, COALESCE(exit_reason, 'unknown')
      ORDER BY strategy, count DESC
    `, [String(hours)]);

    return result.rows.map((row) => ({
      strategy: String(row.strategy),
      exitReason: String(row.exit_reason),
      count: Number(row.count),
      avgPnl: Number(row.avg_pnl),
    }));
  }

  async getCadenceTradeSummary(hours: number[]): Promise<{
    lastTradeAt?: Date;
    lastClosedTradeAt?: Date;
    windows: Array<{ hours: number; trades: number; closedTrades: number }>;
  }> {
    const latestResult = await this.pool.query(`
      SELECT
        MAX(created_at) AS last_trade_at,
        MAX(closed_at) FILTER (WHERE status = 'CLOSED') AS last_closed_trade_at
      FROM trades
    `);
    const lastTradeAtRaw = latestResult.rows[0]?.last_trade_at;
    const lastClosedTradeAtRaw = latestResult.rows[0]?.last_closed_trade_at;
    const windows = [];

    for (const hour of hours) {
      const result = await this.pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= now() - ($1::text || ' hours')::interval) AS trades,
          COUNT(*) FILTER (
            WHERE status = 'CLOSED'
              AND closed_at >= now() - ($1::text || ' hours')::interval
          ) AS closed_trades
        FROM trades
      `, [String(hour)]);
      const row = result.rows[0];
      windows.push({
        hours: hour,
        trades: Number(row.trades),
        closedTrades: Number(row.closed_trades),
      });
    }

    return {
      lastTradeAt: lastTradeAtRaw ? new Date(lastTradeAtRaw as string) : undefined,
      lastClosedTradeAt: lastClosedTradeAtRaw ? new Date(lastClosedTradeAtRaw as string) : undefined,
      windows,
    };
  }
}

function rowToTrade(row: Record<string, unknown>): Trade {
  return {
    id: row.id as string,
    pairAddress: row.pair_address as string,
    strategy: row.strategy as Trade['strategy'],
    side: row.side as Trade['side'],
    tokenSymbol: row.token_symbol as string | undefined,
    entryPrice: Number(row.entry_price),
    sourceLabel: row.source_label as string | undefined,
    discoverySource: row.discovery_source as string | undefined,
    exitPrice: row.exit_price != null ? Number(row.exit_price) : undefined,
    quantity: Number(row.quantity),
    pnl: row.pnl != null ? Number(row.pnl) : undefined,
    slippage: row.slippage != null ? Number(row.slippage) : undefined,
    txSignature: row.tx_signature as string | undefined,
    status: row.status as Trade['status'],
    stopLoss: Number(row.stop_loss),
    takeProfit1: Number(row.take_profit1),
    takeProfit2: Number(row.take_profit2),
    trailingStop: row.trailing_stop != null ? Number(row.trailing_stop) : undefined,
    highWaterMark: row.high_water_mark != null ? Number(row.high_water_mark) : undefined,
    timeStopAt: new Date(row.time_stop_at as string),
    createdAt: new Date(row.created_at as string),
    closedAt: row.closed_at ? new Date(row.closed_at as string) : undefined,
    breakoutScore: row.breakout_score != null ? Number(row.breakout_score) : undefined,
    breakoutGrade: row.breakout_grade as Trade['breakoutGrade'],
    sizeConstraint: row.size_constraint as Trade['sizeConstraint'],
    exitReason: row.exit_reason as Trade['exitReason'],
    entrySlippageBps: row.entry_slippage_bps != null ? Number(row.entry_slippage_bps) : undefined,
    exitSlippageBps: row.exit_slippage_bps != null ? Number(row.exit_slippage_bps) : undefined,
    entryPriceImpactPct: row.entry_price_impact_pct != null ? Number(row.entry_price_impact_pct) : undefined,
    roundTripCostPct: row.round_trip_cost_pct != null ? Number(row.round_trip_cost_pct) : undefined,
    effectiveRR: row.effective_rr != null ? Number(row.effective_rr) : undefined,
    degradedTriggerReason: row.degraded_trigger_reason as Trade['degradedTriggerReason'],
    degradedQuoteFailCount: row.degraded_quote_fail_count != null ? Number(row.degraded_quote_fail_count) : undefined,
    parentTradeId: row.parent_trade_id as string | undefined,
  };
}
