/**
 * Sanitize Oxidized HWM (2026-04-17)
 *
 * Why: 2026-04-17 VPS 실측에서 cupsey WINNER_TIME_STOP 11/11 모두 high_water_mark 이 entry 대비
 * +500% 이상 허수로 기록. Phase A 이전 price-axis bug의 잔재 + ingestClosedCandle 경로가 sanity
 * bound 를 우회한 결과. updateHighWaterMark 쿼리의 `GREATEST(hwm, $2)` 때문에 한 번 오염되면
 * 영구 고착. 본 스크립트는 `high_water_mark > entry_price × max_multiplier` 인 row 의 HWM 을
 * entry_price 로 clamp한다.
 *
 * 안전:
 *   - 기본 dry-run (읽기만). 실제 쓰기는 `--execute` 플래그 필요.
 *   - BEGIN/COMMIT 트랜잭션으로 원자성.
 *   - WHERE 조건에 entry_price > 0 + high_water_mark > entry_price * multiplier.
 *   - exit_price / pnl 등 다른 컬럼은 건드리지 않음 (HWM만 정정).
 *
 * 실행:
 *   npx ts-node scripts/sanitize-oxidized-hwm.ts                  # dry-run
 *   npx ts-node scripts/sanitize-oxidized-hwm.ts --execute        # HWM clamp 적용
 *   npx ts-node scripts/sanitize-oxidized-hwm.ts --multiplier 20  # threshold override
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface CliArgs {
  execute: boolean;
  multiplier: number;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--multiplier');
  const multiplier = idx >= 0 ? Number(argv[idx + 1]) : 15;
  return {
    execute: argv.includes('--execute'),
    multiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 15,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL missing in .env');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: dbUrl });
  console.log(`Mode: ${args.execute ? 'EXECUTE' : 'DRY-RUN'}  multiplier=${args.multiplier}x`);

  try {
    const { rows: candidates } = await pool.query<{
      id: string;
      pair_address: string;
      token_symbol: string | null;
      strategy: string;
      entry_price: string;
      high_water_mark: string;
      ratio: string;
    }>(
      `SELECT id, pair_address, token_symbol, strategy,
              entry_price::text AS entry_price,
              high_water_mark::text AS high_water_mark,
              (high_water_mark / NULLIF(entry_price, 0))::text AS ratio
       FROM trades
       WHERE entry_price > 0 AND high_water_mark > entry_price * $1
       ORDER BY (high_water_mark / NULLIF(entry_price, 0)) DESC`,
      [args.multiplier]
    );

    console.log(`\nOxidized HWM rows (entry × ${args.multiplier}+ 초과): ${candidates.length}`);
    console.log(`${'id'.padEnd(10)} ${'sym'.padEnd(10)} ${'strat'.padEnd(18)} ${'entry'.padEnd(14)} ${'hwm'.padEnd(14)} ${'ratio'.padEnd(10)}`);
    for (const r of candidates.slice(0, 30)) {
      const ratio = Number(r.ratio);
      console.log(
        `${r.id.slice(0, 8).padEnd(10)} ${(r.token_symbol ?? '-').slice(0, 8).padEnd(10)} ${r.strategy.padEnd(18)} ` +
        `${Number(r.entry_price).toExponential(4).padEnd(14)} ${Number(r.high_water_mark).toExponential(4).padEnd(14)} ${ratio.toFixed(1)}x`
      );
    }
    if (candidates.length > 30) console.log(`  ... +${candidates.length - 30} more`);

    if (!args.execute) {
      console.log(`\nDry-run. To apply clamp: --execute`);
      return;
    }

    // Execute: atomic update
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE trades
         SET high_water_mark = entry_price
         WHERE entry_price > 0 AND high_water_mark > entry_price * $1`,
        [args.multiplier]
      );
      await client.query('COMMIT');
      console.log(`\n✓ Clamped high_water_mark on ${rowCount} rows (HWM = entry_price).`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`\n✗ ROLLBACK: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
