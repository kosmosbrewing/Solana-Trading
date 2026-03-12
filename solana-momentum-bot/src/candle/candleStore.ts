import { Pool } from 'pg';
import { createModuleLogger } from '../utils/logger';
import { Candle } from '../utils/types';

const log = createModuleLogger('CandleStore');

const PARAMS_PER_CANDLE = 11;
const MAX_PARAMS = 5000;
const MAX_CANDLES_PER_BATCH = Math.floor(MAX_PARAMS / PARAMS_PER_CANDLE);

const CANDLE_COLUMNS = 'pair_address, timestamp, interval_sec, open, high, low, close, volume, buy_volume, sell_volume, trade_count';

export class CandleStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS candles (
          pair_address  TEXT NOT NULL,
          timestamp     TIMESTAMPTZ NOT NULL,
          interval_sec  INTEGER NOT NULL,
          open          NUMERIC NOT NULL,
          high          NUMERIC NOT NULL,
          low           NUMERIC NOT NULL,
          close         NUMERIC NOT NULL,
          volume        NUMERIC NOT NULL,
          buy_volume    NUMERIC NOT NULL DEFAULT 0,
          sell_volume   NUMERIC NOT NULL DEFAULT 0,
          trade_count   INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (pair_address, timestamp, interval_sec)
        );
      `);

      try {
        await client.query(`
          SELECT create_hypertable('candles', 'timestamp', if_not_exists => TRUE);
        `);
        log.info('Hypertable created/verified for candles');
      } catch {
        log.warn('TimescaleDB not available — using plain PostgreSQL table');
      }

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_candles_pair_interval
        ON candles (pair_address, interval_sec, timestamp DESC);
      `);

      log.info('CandleStore initialized');
    } finally {
      client.release();
    }
  }

  async insertCandles(candles: Candle[]): Promise<void> {
    if (candles.length === 0) return;

    for (let offset = 0; offset < candles.length; offset += MAX_CANDLES_PER_BATCH) {
      const chunk = candles.slice(offset, offset + MAX_CANDLES_PER_BATCH);
      await this.insertChunk(chunk);
    }
  }

  private async insertChunk(candles: Candle[]): Promise<void> {
    const values: string[] = [];
    const params: (string | number | Date)[] = [];
    let paramIdx = 1;

    for (const c of candles) {
      const placeholders: string[] = [];
      for (let i = 0; i < PARAMS_PER_CANDLE; i++) {
        placeholders.push(`$${paramIdx++}`);
      }
      values.push(`(${placeholders.join(', ')})`);
      params.push(
        c.pairAddress, c.timestamp, c.intervalSec,
        c.open, c.high, c.low, c.close,
        c.volume, c.buyVolume, c.sellVolume, c.tradeCount
      );
    }

    await this.pool.query(
      `INSERT INTO candles (${CANDLE_COLUMNS})
       VALUES ${values.join(', ')}
       ON CONFLICT (pair_address, timestamp, interval_sec) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume,
         buy_volume = EXCLUDED.buy_volume, sell_volume = EXCLUDED.sell_volume,
         trade_count = EXCLUDED.trade_count`,
      params
    );
  }

  async getRecentCandles(
    pairAddress: string,
    intervalSec: number,
    limit: number
  ): Promise<Candle[]> {
    const result = await this.pool.query(
      `SELECT ${CANDLE_COLUMNS} FROM candles
       WHERE pair_address = $1 AND interval_sec = $2
       ORDER BY timestamp DESC LIMIT $3`,
      [pairAddress, intervalSec, limit]
    );
    return result.rows.map(rowToCandle).reverse();
  }

  async getCandlesInRange(
    pairAddress: string,
    intervalSec: number,
    from: Date,
    to: Date
  ): Promise<Candle[]> {
    const result = await this.pool.query(
      `SELECT ${CANDLE_COLUMNS} FROM candles
       WHERE pair_address = $1 AND interval_sec = $2
         AND timestamp >= $3 AND timestamp <= $4
       ORDER BY timestamp ASC`,
      [pairAddress, intervalSec, from, to]
    );
    return result.rows.map(rowToCandle);
  }

  async getAllCandles(
    pairAddress: string,
    intervalSec: number
  ): Promise<Candle[]> {
    const result = await this.pool.query(
      `SELECT ${CANDLE_COLUMNS} FROM candles
       WHERE pair_address = $1 AND interval_sec = $2
       ORDER BY timestamp ASC`,
      [pairAddress, intervalSec]
    );
    return result.rows.map(rowToCandle);
  }
}

export function rowToCandle(row: Record<string, unknown>): Candle {
  return {
    pairAddress: row.pair_address as string,
    timestamp: new Date(row.timestamp as string),
    intervalSec: Number(row.interval_sec),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    buyVolume: Number(row.buy_volume ?? 0),
    sellVolume: Number(row.sell_volume ?? 0),
    tradeCount: Number(row.trade_count),
  };
}
