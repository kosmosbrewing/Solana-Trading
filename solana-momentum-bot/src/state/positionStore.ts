import { Pool } from 'pg';
import { createModuleLogger } from '../utils/logger';
import { PositionRecord, PositionState } from '../utils/types';

const log = createModuleLogger('PositionStore');

/**
 * 포지션 상태 영속화 — Write-Ahead 패턴
 */
export class PositionStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS position_states (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pair_address    TEXT NOT NULL,
        state           TEXT NOT NULL,
        signal_data     JSONB,
        entry_price     NUMERIC,
        quantity        NUMERIC,
        stop_loss       NUMERIC,
        take_profit_1   NUMERIC,
        take_profit_2   NUMERIC,
        trailing_stop   NUMERIC,
        tx_entry        TEXT,
        tx_exit         TEXT,
        exit_reason     TEXT,
        pnl             NUMERIC,
        updated_at      TIMESTAMPTZ DEFAULT now(),
        created_at      TIMESTAMPTZ DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_position_states_open
        ON position_states (state) WHERE state != 'EXIT_CONFIRMED';
    `);
    log.info('PositionStore initialized');
  }

  async createPosition(pairAddress: string, signalData: Record<string, unknown>): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO position_states (pair_address, state, signal_data)
       VALUES ($1, 'SIGNAL_DETECTED', $2)
       RETURNING id`,
      [pairAddress, JSON.stringify(signalData)]
    );
    return result.rows[0].id;
  }

  async updateState(
    id: string,
    state: PositionState,
    updates: Partial<{
      entryPrice: number;
      quantity: number;
      stopLoss: number;
      takeProfit1: number;
      takeProfit2: number;
      trailingStop: number;
      txEntry: string;
      txExit: string;
      exitReason: string;
      pnl: number;
    }> = {}
  ): Promise<void> {
    const setClauses = ['state = $2', 'updated_at = now()'];
    const params: unknown[] = [id, state];
    let idx = 3;

    const fieldMap: Record<string, string> = {
      entryPrice: 'entry_price',
      quantity: 'quantity',
      stopLoss: 'stop_loss',
      takeProfit1: 'take_profit_1',
      takeProfit2: 'take_profit_2',
      trailingStop: 'trailing_stop',
      txEntry: 'tx_entry',
      txExit: 'tx_exit',
      exitReason: 'exit_reason',
      pnl: 'pnl',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      const val = (updates as Record<string, unknown>)[key];
      if (val !== undefined) {
        setClauses.push(`${col} = $${idx}`);
        params.push(val);
        idx++;
      }
    }

    await this.pool.query(
      `UPDATE position_states SET ${setClauses.join(', ')} WHERE id = $1`,
      params
    );
  }

  async getOpenPositions(): Promise<PositionRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM position_states
       WHERE state NOT IN ('EXIT_CONFIRMED', 'ORDER_FAILED', 'IDLE')
       ORDER BY created_at ASC`
    );
    return result.rows.map(rowToPosition);
  }

  async getById(id: string): Promise<PositionRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM position_states WHERE id = $1',
      [id]
    );
    return result.rows.length > 0 ? rowToPosition(result.rows[0]) : null;
  }
}

function rowToPosition(row: Record<string, unknown>): PositionRecord {
  return {
    id: row.id as string,
    pairAddress: row.pair_address as string,
    state: row.state as PositionState,
    signalData: row.signal_data as Record<string, unknown> | undefined,
    entryPrice: row.entry_price ? Number(row.entry_price) : undefined,
    quantity: row.quantity ? Number(row.quantity) : undefined,
    stopLoss: row.stop_loss ? Number(row.stop_loss) : undefined,
    takeProfit1: row.take_profit_1 ? Number(row.take_profit_1) : undefined,
    takeProfit2: row.take_profit_2 ? Number(row.take_profit_2) : undefined,
    trailingStop: row.trailing_stop ? Number(row.trailing_stop) : undefined,
    txEntry: row.tx_entry as string | undefined,
    txExit: row.tx_exit as string | undefined,
    exitReason: row.exit_reason as string | undefined,
    pnl: row.pnl ? Number(row.pnl) : undefined,
    updatedAt: new Date(row.updated_at as string),
    createdAt: new Date(row.created_at as string),
  };
}
