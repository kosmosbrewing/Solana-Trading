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
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          pair_address  TEXT NOT NULL,
          strategy      TEXT NOT NULL,
          side          TEXT NOT NULL,
          entry_price   NUMERIC NOT NULL,
          exit_price    NUMERIC,
          quantity      NUMERIC NOT NULL,
          pnl           NUMERIC,
          slippage      NUMERIC,
          tx_signature  TEXT,
          status        TEXT NOT NULL DEFAULT 'OPEN',
          stop_loss     NUMERIC NOT NULL,
          take_profit1  NUMERIC NOT NULL,
          take_profit2  NUMERIC NOT NULL,
          trailing_stop NUMERIC,
          time_stop_at  TIMESTAMPTZ,
          created_at    TIMESTAMPTZ DEFAULT now(),
          closed_at     TIMESTAMPTZ
        );
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
      `INSERT INTO trades (pair_address, strategy, side, entry_price, quantity,
        stop_loss, take_profit1, take_profit2, trailing_stop, time_stop_at, status, tx_signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        trade.pairAddress, trade.strategy, trade.side, trade.entryPrice,
        trade.quantity, trade.stopLoss, trade.takeProfit1, trade.takeProfit2,
        trade.trailingStop || null, trade.timeStopAt, trade.status,
        trade.txSignature || null,
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
    slippage: number
  ): Promise<void> {
    await this.pool.query(
      `UPDATE trades SET
        exit_price = $2, pnl = $3, slippage = $4,
        status = 'CLOSED', closed_at = now()
       WHERE id = $1`,
      [id, exitPrice, pnl, slippage]
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
}

function rowToTrade(row: Record<string, unknown>): Trade {
  return {
    id: row.id as string,
    pairAddress: row.pair_address as string,
    strategy: row.strategy as Trade['strategy'],
    side: row.side as Trade['side'],
    entryPrice: Number(row.entry_price),
    exitPrice: row.exit_price ? Number(row.exit_price) : undefined,
    quantity: Number(row.quantity),
    pnl: row.pnl ? Number(row.pnl) : undefined,
    slippage: row.slippage ? Number(row.slippage) : undefined,
    txSignature: row.tx_signature as string | undefined,
    status: row.status as Trade['status'],
    stopLoss: Number(row.stop_loss),
    takeProfit1: Number(row.take_profit1),
    takeProfit2: Number(row.take_profit2),
    trailingStop: row.trailing_stop ? Number(row.trailing_stop) : undefined,
    timeStopAt: new Date(row.time_stop_at as string),
    createdAt: new Date(row.created_at as string),
    closedAt: row.closed_at ? new Date(row.closed_at as string) : undefined,
  };
}
