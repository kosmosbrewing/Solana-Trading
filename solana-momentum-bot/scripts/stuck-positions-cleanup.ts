/**
 * Stuck Position Cleanup (2026-04-17)
 *
 * DB OPEN 상태이지만 실제 지갑에는 duplicate buy로 누적된 토큰이 남은 포지션을 정리.
 * 2026-04-17 실측: Pnut 10 + SOYJAK 1 = 11개 OPEN. 전부 같은 pair_address(Pnut)이거나
 * 단일 pair(SOYJAK). STALK→PROBE reentrancy(Patch A 이전)의 후유증.
 *
 * 흐름:
 *   1) DB에서 status='OPEN' + strategy='cupsey_flip_10s' 로드
 *   2) pair_address별 그룹 → 같은 mint에 여러 DB row 존재 → duplicate 확인
 *   3) 지갑 실제 SPL 잔고 조회 (mint별 합산 bigint)
 *   4) 실잔고 > 0이면: executor.executeSell(전체)  /  DB 모든 해당 row close (exit_price=receivedSol/qty 합)
 *      실잔고 = 0 이면: DB row만 exit_anomaly_reason='phantom_open'으로 마킹
 *   5) --dry-run 기본값 true — 실제 실행은 --execute 플래그
 *
 * 실행:
 *   npx ts-node scripts/stuck-positions-cleanup.ts                                     # dry-run
 *   npx ts-node scripts/stuck-positions-cleanup.ts --execute --i-understand-phantom    # phantom cleanup
 *
 * 안전:
 *   - Patch A/B1 배포 후 실행 권장 (신규 duplicate 차단된 상태에서만)
 *   - 파괴적 DB 쓰기(`status='CLOSED'`)는 **두 플래그 동시** 요구 (--execute + --i-understand-phantom)
 *   - phantom cleanup은 mint별로 하나의 트랜잭션(BEGIN/COMMIT)으로 묶어 원자성 보장
 *   - 실잔고 있는 mint는 자동 sell 안 함 — 봇 정상 close 경로/수동 swap 권장
 */
import { Pool } from 'pg';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface OpenRow {
  id: string;
  pair_address: string;
  token_symbol: string | null;
  entry_price: number;
  quantity: number;
  created_at: Date;
  tx_signature: string | null;
}

interface CliArgs {
  execute: boolean;
  confirm: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  return {
    execute: argv.includes('--execute'),
    confirm: argv.includes('--i-understand-phantom'),
  };
}

function parseWalletPubkey(privateKey: string): PublicKey {
  if (privateKey.trim().startsWith('[')) {
    const arr = JSON.parse(privateKey) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr)).publicKey;
  }
  return Keypair.fromSecretKey(bs58.decode(privateKey.trim())).publicKey;
}

async function getMintBalance(connection: Connection, wallet: PublicKey, mint: string): Promise<{ raw: bigint; ui: number; decimals: number }> {
  const accounts = await connection.getTokenAccountsByOwner(wallet, { mint: new PublicKey(mint) });
  if (accounts.value.length === 0) return { raw: 0n, ui: 0, decimals: 0 };
  let raw = 0n;
  let decimals = 0;
  let ui = 0;
  for (const { pubkey } of accounts.value) {
    const info = await connection.getTokenAccountBalance(pubkey);
    raw += BigInt(info.value.amount);
    decimals = info.value.decimals;
    ui += info.value.uiAmount ?? 0;
  }
  return { raw, ui, decimals };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const dbUrl = process.env.DATABASE_URL;
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const walletKey = process.env.WALLET_PRIVATE_KEY;
  if (!dbUrl || !rpcUrl || !walletKey) {
    console.error('Missing DATABASE_URL, SOLANA_RPC_URL, or WALLET_PRIVATE_KEY in .env');
    process.exit(1);
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = parseWalletPubkey(walletKey);
  const destructive = args.execute && args.confirm;
  if (args.execute && !args.confirm) {
    console.error('--execute requires --i-understand-phantom to perform destructive DB writes. Aborting.');
    process.exit(2);
  }
  console.log(`Wallet: ${wallet.toBase58()}`);
  console.log(`Mode: ${destructive ? 'EXECUTE (phantom DB rows → CLOSED, atomic per-mint)' : 'DRY-RUN (read-only)'}`);

  const pool = new Pool({ connectionString: dbUrl });
  try {
    const { rows } = await pool.query<OpenRow>(
      `SELECT id, pair_address, token_symbol, entry_price::float AS entry_price,
              quantity::float AS quantity, created_at, tx_signature
       FROM trades
       WHERE status = 'OPEN' AND strategy = 'cupsey_flip_10s'
       ORDER BY created_at`
    );
    console.log(`\nOPEN cupsey_flip_10s rows: ${rows.length}`);

    // Group by pair_address
    const groups = new Map<string, OpenRow[]>();
    for (const r of rows) {
      const list = groups.get(r.pair_address) ?? [];
      list.push(r);
      groups.set(r.pair_address, list);
    }

    console.log(`\nUnique mints: ${groups.size}`);
    for (const [mint, rs] of groups) {
      const sym = rs[0].token_symbol ?? '-';
      const totalDbQty = rs.reduce((s, r) => s + r.quantity, 0);
      console.log(`\n--- ${sym} (${mint.slice(0, 12)}...) ---`);
      console.log(`  DB rows: ${rs.length}  total_qty(UI): ${totalDbQty.toFixed(4)}`);
      for (const r of rs) {
        console.log(`    id=${r.id.slice(0, 8)} qty=${r.quantity.toFixed(4)} entry=${r.entry_price.toExponential(4)} created=${r.created_at.toISOString()}`);
      }

      // Actual wallet balance
      const balance = await getMintBalance(connection, wallet, mint);
      console.log(`  Wallet: raw=${balance.raw.toString()} ui=${balance.ui.toFixed(4)} decimals=${balance.decimals}`);
      const ratio = totalDbQty > 0 ? balance.ui / totalDbQty : 0;
      console.log(`  wallet/DB ratio: ${ratio.toFixed(3)}  ${ratio < 0.1 ? '[PHANTOM: wallet nearly empty — likely DB duplicate or already sold]' : ''}${ratio > 0.95 && ratio < 1.05 ? '[MATCH: wallet ≈ DB total]' : ''}${ratio > 0 && ratio < 0.6 ? '[PARTIAL: wallet < DB — some rows duplicate]' : ''}`);

      if (!destructive) {
        console.log(`  (dry-run: skip sell/DB write)`);
        continue;
      }

      if (balance.raw === 0n) {
        // Mint별로 BEGIN/COMMIT 트랜잭션으로 묶어 원자성 보장 — 일부만 CLOSED 되는 상태 방지.
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const r of rs) {
            await client.query(
              `UPDATE trades SET status='CLOSED', exit_price=entry_price, pnl=0, exit_reason='PHANTOM_CLEANUP',
                      exit_anomaly_reason='wallet_empty_cleanup_2026-04-17', closed_at=now()
               WHERE id=$1 AND status='OPEN'`,
              [r.id]
            );
          }
          await client.query('COMMIT');
          console.log(`  ✓ ${rs.length} rows marked CLOSED (phantom, atomic).`);
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.error(`  ✗ ROLLBACK: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        } finally {
          client.release();
        }
        continue;
      }

      // Wallet has tokens — actual sell required. 이 스크립트는 executor를 직접 호출하지 않고
      // 수동 sell 또는 봇을 통한 정상 close 경로를 권장한다 (복잡한 Jupiter/Jito 경로 재사용 위험).
      console.log(`  → Wallet has ${balance.ui.toFixed(4)} tokens. Manual sell recommended via bot's normal close path:`);
      console.log(`     1) 봇을 잠시 멈추거나 cupsey position을 recoverCupseyOpenPositions로 복구`);
      console.log(`     2) updateCupseyPositions 루프에서 자연 close (time stop 도달 시) 대기`);
      console.log(`     3) 또는 Jupiter UI/Phantom 지갑에서 직접 swap → 이후 PHANTOM_CLEANUP으로 DB row 정리`);
      console.log(`     (이 스크립트는 안전을 위해 자동 sell을 수행하지 않습니다)`);
    }

    // Summary
    console.log('\n=== Summary ===');
    const totalRows = rows.length;
    const totalUniqueMints = groups.size;
    console.log(`  OPEN rows: ${totalRows}`);
    console.log(`  Unique mints: ${totalUniqueMints}`);
    console.log(`  Duplicate exposure: ${totalRows - totalUniqueMints} extra rows beyond unique mints`);
    if (!destructive) {
      console.log(`\n  To apply phantom-cleanup on empty-wallet rows: --execute --i-understand-phantom`);
      console.log(`  Non-empty wallet: use bot's normal close path (see recommendation above).`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
