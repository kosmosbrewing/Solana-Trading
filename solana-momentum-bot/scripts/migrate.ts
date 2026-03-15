/**
 * DB 마이그레이션 스크립트 (v0.3)
 * 실행: npx ts-node scripts/migrate.ts
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { ensureTradeHighWaterMarkColumn } from '../src/candle/tradeSchema';

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
    console.log('Running migrations (v0.3)...');

    // ─── Candles table (with buy/sell volume) ───
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
    console.log('  ✓ candles table created');

    await safeAddColumn(client, 'candles', 'buy_volume', 'NUMERIC NOT NULL DEFAULT 0');
    await safeAddColumn(client, 'candles', 'sell_volume', 'NUMERIC NOT NULL DEFAULT 0');

    try {
      await client.query(`
        SELECT create_hypertable('candles', 'timestamp', if_not_exists => TRUE);
      `);
      console.log('  ✓ candles hypertable created');

      try {
        await client.query(`
          ALTER TABLE candles SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'pair_address, interval_sec',
            timescaledb.compress_orderby = 'timestamp DESC'
          );
          SELECT add_compression_policy('candles', INTERVAL '7 days', if_not_exists => TRUE);
          SELECT add_retention_policy('candles', INTERVAL '90 days', if_not_exists => TRUE);
        `);
        console.log('  ✓ candles compression/retention policies set');
      } catch {
        console.log('  ⚠ Could not set compression/retention policies');
      }
    } catch {
      console.log('  ⚠ TimescaleDB not available — using plain table');
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_candles_pair_interval
      ON candles (pair_address, interval_sec, timestamp DESC);
    `);
    console.log('  ✓ candles index created');

    // ─── Trades table (v0.3 fields) ───
    await client.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pair_address    TEXT NOT NULL,
        strategy        TEXT NOT NULL,
        side            TEXT NOT NULL,
        entry_price     NUMERIC NOT NULL,
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
    console.log('  ✓ trades table created');

    await safeAddColumn(client, 'trades', 'breakout_score', 'INTEGER');
    await safeAddColumn(client, 'trades', 'breakout_grade', 'TEXT');
    await safeAddColumn(client, 'trades', 'size_constraint', 'TEXT');
    await safeAddColumn(client, 'trades', 'exit_reason', 'TEXT');
    await safeAddColumn(client, 'trades', 'high_water_mark', 'NUMERIC');
    await ensureTradeHighWaterMarkColumn(client);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status);
      CREATE INDEX IF NOT EXISTS idx_trades_created ON trades (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades (pair_address, created_at DESC);
    `);
    console.log('  ✓ trades indexes created');

    // ─── Position States (v0.3) ───
    await client.query(`
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
    console.log('  ✓ position_states table created');

    // ─── Signal Audit Log (v0.3) ───
    await client.query(`
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
        slippage_actual NUMERIC
      );

      CREATE INDEX IF NOT EXISTS idx_signal_audit_strategy
        ON signal_audit_log (strategy, grade, action);
      CREATE INDEX IF NOT EXISTS idx_signal_audit_time
        ON signal_audit_log (timestamp DESC);
    `);
    console.log('  ✓ signal_audit_log table created');

    try {
      await client.query(`
        SELECT create_hypertable('signal_audit_log', 'timestamp', if_not_exists => TRUE);
        ALTER TABLE signal_audit_log SET (
          timescaledb.compress,
          timescaledb.compress_orderby = 'timestamp DESC'
        );
        SELECT add_compression_policy('signal_audit_log', INTERVAL '30 days', if_not_exists => TRUE);
        SELECT add_retention_policy('signal_audit_log', INTERVAL '90 days', if_not_exists => TRUE);
      `);
      console.log('  ✓ signal_audit_log hypertable + policies set');
    } catch {
      console.log('  ⚠ signal_audit_log TimescaleDB policies skipped');
    }

    // ─── Universe Snapshots ───
    await client.query(`
      CREATE TABLE IF NOT EXISTS universe_snapshots (
        snapshot_time   TIMESTAMPTZ NOT NULL,
        pair_address    TEXT NOT NULL,
        tvl             NUMERIC NOT NULL,
        daily_volume    NUMERIC NOT NULL,
        trade_count_24h INTEGER NOT NULL,
        spread_pct      NUMERIC NOT NULL,
        rank_score      NUMERIC NOT NULL,
        PRIMARY KEY (snapshot_time, pair_address)
      );
    `);
    console.log('  ✓ universe_snapshots table created');

    try {
      await client.query(`
        SELECT create_hypertable('universe_snapshots', 'snapshot_time', if_not_exists => TRUE);
        SELECT add_retention_policy('universe_snapshots', INTERVAL '30 days', if_not_exists => TRUE);
      `);
      console.log('  ✓ universe_snapshots hypertable + retention set');
    } catch {
      console.log('  ⚠ universe_snapshots TimescaleDB policies skipped');
    }

    // ─── Backtest Runs ───
    await client.query(`
      CREATE TABLE IF NOT EXISTS backtest_runs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_at          TIMESTAMPTZ DEFAULT now(),
        data_start      TIMESTAMPTZ NOT NULL,
        data_end        TIMESTAMPTZ NOT NULL,
        params          JSONB NOT NULL,
        sharpe_ratio    NUMERIC,
        profit_factor   NUMERIC,
        max_drawdown    NUMERIC,
        win_rate        NUMERIC,
        total_trades    INTEGER,
        adjusted_pnl    NUMERIC,
        degradation     NUMERIC
      );
    `);
    console.log('  ✓ backtest_runs table created');

    console.log('\nMigration complete!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

async function safeAddColumn(
  client: any,
  table: string,
  column: string,
  type: string
): Promise<void> {
  const allowedColumns: Record<string, Record<string, string>> = {
    candles: {
      buy_volume: 'NUMERIC NOT NULL DEFAULT 0',
      sell_volume: 'NUMERIC NOT NULL DEFAULT 0',
    },
    trades: {
      breakout_score: 'INTEGER',
      breakout_grade: 'TEXT',
      size_constraint: 'TEXT',
      exit_reason: 'TEXT',
      high_water_mark: 'NUMERIC',
    },
  };

  const tableColumns = allowedColumns[table];
  if (!tableColumns) {
    throw new Error(`safeAddColumn rejected table: ${table}`);
  }

  const expectedType = tableColumns[column];
  if (!expectedType) {
    throw new Error(`safeAddColumn rejected column: ${table}.${column}`);
  }

  if (expectedType !== type) {
    throw new Error(
      `safeAddColumn rejected type for ${table}.${column}: expected "${expectedType}", got "${type}"`
    );
  }

  await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
