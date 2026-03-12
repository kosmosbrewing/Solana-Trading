/**
 * DB 마이그레이션 스크립트
 * 실행: npx ts-node scripts/migrate.ts
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    console.log('Running migrations...');

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
        trade_count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pair_address, timestamp, interval_sec)
      );
    `);
    console.log('  ✓ candles table created');

    try {
      await client.query(`
        SELECT create_hypertable('candles', 'timestamp', if_not_exists => TRUE);
      `);
      console.log('  ✓ candles hypertable created');
    } catch {
      console.log('  ⚠ TimescaleDB not available — using plain table');
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_candles_pair_interval
      ON candles (pair_address, interval_sec, timestamp DESC);
    `);
    console.log('  ✓ candles index created');

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
    console.log('  ✓ trades table created');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);
      CREATE INDEX IF NOT EXISTS idx_trades_created ON trades (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades (pair_address, created_at DESC);
    `);
    console.log('  ✓ trades indexes created');

    console.log('Migration complete!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
