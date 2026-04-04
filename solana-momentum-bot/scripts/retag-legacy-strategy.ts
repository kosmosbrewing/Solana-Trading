/**
 * Legacy contamination retag script
 *
 * Why: P0-1 이전에 bootstrap trigger가 strategy='volume_spike'로 기록됐다.
 *      이 스크립트는 source_label='trigger_volume_mcap_spike'인 레코드를
 *      strategy='bootstrap_10s'로 deterministic retag한다.
 *
 * 판별 기준:
 *   - trades: source_label = 'trigger_volume_mcap_spike' AND strategy = 'volume_spike'
 *   - signal_audit_log: source_label = 'trigger_volume_mcap_spike' AND strategy = 'volume_spike'
 *
 * Usage:
 *   npx ts-node scripts/retag-legacy-strategy.ts [--dry-run]
 */
import { Pool } from 'pg';
import { config } from '../src/utils/config';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const pool = new Pool({ connectionString: config.databaseUrl });

  try {
    // 1. Count affected records
    const tradeCount = await pool.query(
      `SELECT count(*) AS cnt FROM trades
       WHERE strategy = 'volume_spike' AND source_label = 'trigger_volume_mcap_spike'`
    );
    const auditCount = await pool.query(
      `SELECT count(*) AS cnt FROM signal_audit_log
       WHERE strategy = 'volume_spike' AND source_label = 'trigger_volume_mcap_spike'`
    );

    const tradesAffected = Number(tradeCount.rows[0].cnt);
    const auditsAffected = Number(auditCount.rows[0].cnt);

    console.log(`[retag] trades to retag: ${tradesAffected}`);
    console.log(`[retag] signal_audit_log to retag: ${auditsAffected}`);

    if (dryRun) {
      console.log('[retag] --dry-run mode, no changes made.');
      return;
    }

    if (tradesAffected === 0 && auditsAffected === 0) {
      console.log('[retag] Nothing to retag.');
      return;
    }

    // 2. Retag trades
    if (tradesAffected > 0) {
      const result = await pool.query(
        `UPDATE trades SET strategy = 'bootstrap_10s'
         WHERE strategy = 'volume_spike' AND source_label = 'trigger_volume_mcap_spike'`
      );
      console.log(`[retag] trades updated: ${result.rowCount}`);
    }

    // 3. Retag signal_audit_log
    if (auditsAffected > 0) {
      const result = await pool.query(
        `UPDATE signal_audit_log SET strategy = 'bootstrap_10s'
         WHERE strategy = 'volume_spike' AND source_label = 'trigger_volume_mcap_spike'`
      );
      console.log(`[retag] signal_audit_log updated: ${result.rowCount}`);
    }

    // 4. Also retag momentum trigger records if any exist
    const momentumTradeCount = await pool.query(
      `SELECT count(*) AS cnt FROM trades
       WHERE strategy = 'volume_spike' AND source_label = 'trigger_momentum'`
    );
    const momentumAuditCount = await pool.query(
      `SELECT count(*) AS cnt FROM signal_audit_log
       WHERE strategy = 'volume_spike' AND source_label = 'trigger_momentum'`
    );

    const momentumTrades = Number(momentumTradeCount.rows[0].cnt);
    const momentumAudits = Number(momentumAuditCount.rows[0].cnt);

    if (momentumTrades > 0) {
      const result = await pool.query(
        `UPDATE trades SET strategy = 'core_momentum'
         WHERE strategy = 'volume_spike' AND source_label = 'trigger_momentum'`
      );
      console.log(`[retag] trades (core_momentum) updated: ${result.rowCount}`);
    }
    if (momentumAudits > 0) {
      const result = await pool.query(
        `UPDATE signal_audit_log SET strategy = 'core_momentum'
         WHERE strategy = 'volume_spike' AND source_label = 'trigger_momentum'`
      );
      console.log(`[retag] signal_audit_log (core_momentum) updated: ${result.rowCount}`);
    }

    // 5. Report remaining untagged records (source_label is null or unknown)
    const remaining = await pool.query(
      `SELECT count(*) AS cnt FROM trades
       WHERE strategy = 'volume_spike' AND (source_label IS NULL OR source_label = 'unknown')`
    );
    const remainingCount = Number(remaining.rows[0].cnt);
    if (remainingCount > 0) {
      console.log(`[retag] WARNING: ${remainingCount} trades still have strategy='volume_spike' with no source_label (cannot deterministically retag)`);
    }

    console.log('[retag] Done.');
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[retag] Fatal error:', err);
  process.exit(1);
});
