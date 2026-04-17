/**
 * Wallet Reconciliation Audit (2026-04-17)
 *
 * Ground-truth 지갑 감사. DB의 pnl/entry/exit는 전부 신뢰하지 않고,
 * Solana RPC로 지갑의 실제 SOL preBalance↔postBalance delta를 tx-by-tx 합산한다.
 *
 * 목적:
 *   - 실 지갑 (1.3 → 1.07, −0.23 SOL)과 DB pnl 합계(+18.11 SOL)의 +18.34 SOL drift 해소 근거
 *   - 전략별/기간별 "진짜" 실현 손익 산출 (DB tx_signature 기반 crossref)
 *
 * 실행:
 *   npx ts-node scripts/wallet-reconcile.ts [--days 14] [--limit 0]
 *   env 필요: SOLANA_RPC_URL, DATABASE_URL,
 *             + (WALLET_PUBLIC_KEY 권장 — 읽기 전용 감사는 public key만으로 충분)
 *             또는 WALLET_PRIVATE_KEY (fallback, derivation 목적 외에 사용 안 함)
 *
 * 출력:
 *   - 기간 total SOL delta (ground truth)
 *   - buy/sell/other 분류 카운트
 *   - Top positive / negative delta tx
 *   - DB crossref: tx_signature 매칭된 trade별 (stored_pnl vs on-chain delta)
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Pool } from 'pg';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface CliArgs {
  days: number;
  limit: number; // 0 = unlimited
  throttleMs: number;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    days: Number(get('--days') ?? '14'),
    limit: Number(get('--limit') ?? '0'),
    // Helius Developer tier 분당 제한 보수적으로 밟기 — 50ms=1200req/min 여유
    throttleMs: Number(get('--throttle-ms') ?? '50'),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429 / 네트워크 오류 시 exponential backoff retry. 실패 시 null 반환. */
async function withRpcRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3
): Promise<T | null> {
  let attempt = 0;
  let backoffMs = 500;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const is429 = msg.includes('429') || msg.toLowerCase().includes('too many');
      const isRetryable = is429 || msg.includes('fetch failed') || msg.includes('ETIMEDOUT');
      attempt++;
      if (!isRetryable || attempt >= maxAttempts) {
        // Why: 마지막 시도까지 실패하면 집계에서 빠지는 게 명시적으로 보이도록 로그.
        console.error(`  [rpc-retry] ${label} failed (attempt ${attempt}/${maxAttempts}): ${msg}`);
        return null;
      }
      await sleep(backoffMs);
      backoffMs *= 2;
    }
  }
  return null;
}

function parseWalletPubkey(privateKey: string): PublicKey {
  if (privateKey.trim().startsWith('[')) {
    const arr = JSON.parse(privateKey) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr)).publicKey;
  }
  return Keypair.fromSecretKey(bs58.decode(privateKey.trim())).publicKey;
}

/** 최소 권한 원칙: public key가 있으면 private key를 로드하지 않는다. */
function resolveWalletPubkey(): PublicKey {
  const pub = process.env.WALLET_PUBLIC_KEY?.trim();
  if (pub) return new PublicKey(pub);
  const priv = process.env.WALLET_PRIVATE_KEY;
  if (priv) return parseWalletPubkey(priv);
  throw new Error('Missing WALLET_PUBLIC_KEY (recommended) or WALLET_PRIVATE_KEY (fallback) in .env');
}

async function fetchAllSignatures(
  connection: Connection,
  wallet: PublicKey,
  since: Date,
  throttleMs: number
): Promise<string[]> {
  const all: string[] = [];
  let before: string | undefined;
  while (true) {
    const page = await withRpcRetry(
      `getSignaturesForAddress(before=${before?.slice(0, 8) ?? 'head'})`,
      () => connection.getSignaturesForAddress(wallet, { limit: 1000, before })
    );
    if (!page || page.length === 0) break;
    let reachedCutoff = false;
    for (const s of page) {
      if (s.blockTime && new Date(s.blockTime * 1000) < since) {
        reachedCutoff = true;
        break;
      }
      all.push(s.signature);
    }
    if (reachedCutoff || page.length < 1000) break;
    before = page[page.length - 1].signature;
    if (throttleMs > 0) await sleep(throttleMs);
  }
  return all;
}

interface TxDelta {
  signature: string;
  deltaSol: number;
  feeSol: number;
  blockTime: number | null;
  type: 'buy' | 'sell' | 'fee_only' | 'other';
  /** 2026-04-17: wallet이 관여된 SPL token mints (pair_address 매핑용). */
  involvedMints: string[];
}

async function fetchTxDelta(
  connection: Connection,
  signature: string,
  walletStr: string
): Promise<TxDelta | null> {
  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  if (!tx?.meta) return null;
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses,
  });
  let walletIdx = -1;
  for (let i = 0; i < keys.length; i++) {
    if (keys.get(i)!.toBase58() === walletStr) {
      walletIdx = i;
      break;
    }
  }
  if (walletIdx < 0) return null;
  const pre = tx.meta.preBalances[walletIdx];
  const post = tx.meta.postBalances[walletIdx];
  const deltaSol = (post - pre) / 1e9; // fee는 postBalance에 이미 반영됨
  const feeSol = tx.meta.fee / 1e9;
  let type: TxDelta['type'] = 'other';
  // buy: SOL 크게 나감 (0.003 SOL = 30 bps of 0.01 ticket, fee 훨씬 큼)
  if (deltaSol < -0.003) type = 'buy';
  else if (deltaSol > 0.003) type = 'sell';
  else if (Math.abs(deltaSol + feeSol) < 1e-9) type = 'fee_only';

  // 2026-04-17: wallet이 관여된 SPL mint 추출 (preTokenBalances/postTokenBalances 중 owner=wallet).
  // Why: sell tx 는 DB tx_signature 에 기록 안 되므로, mint 를 pair_address 매핑 키로 사용해
  // 각 sell tx 를 strategy 별로 배분할 수 있게 한다.
  const involvedMints = new Set<string>();
  const addMints = (balances: Array<{ owner?: string; mint?: string } | undefined> | null | undefined) => {
    if (!balances) return;
    for (const b of balances) {
      if (!b) continue;
      if (b.owner === walletStr && b.mint) involvedMints.add(b.mint);
    }
  };
  addMints(tx.meta.preTokenBalances as any);
  addMints(tx.meta.postTokenBalances as any);

  return {
    signature, deltaSol, feeSol,
    blockTime: tx.blockTime ?? null,
    type,
    involvedMints: [...involvedMints],
  };
}

/** DB 의 각 buy row — FIFO 매칭용. consumed 는 sell 매칭 시 true 로 표시. */
interface DbBuyEntry {
  strategy: string;
  symbol: string | null;
  pairAddress: string;
  createdAtMs: number;
  txSignature: string | null;
  consumed: boolean;
}

interface DbContext {
  /** tx_signature → strategy/symbol/pnl (buy tx 매칭용) */
  txMap: Map<string, { strategy: string; symbol: string | null; storedPnl: number | null }>;
  /** pair_address (= token mint) → 시간순(ASC) buy queue. FIFO 매칭 */
  buyQueueByMint: Map<string, DbBuyEntry[]>;
}

async function loadDbContext(since: Date): Promise<DbContext> {
  const txMap = new Map<string, { strategy: string; symbol: string | null; storedPnl: number | null }>();
  const buyQueueByMint = new Map<string, DbBuyEntry[]>();
  if (!process.env.DATABASE_URL) return { txMap, buyQueueByMint };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // 2026-04-17 FIFO pair matching: since cutoff 무시하고 전체 DB trades 를 로드.
    // Why: sell tx 의 blockTime 이 window 내 라도 매칭 대상 buy 는 window 이전일 수 있다
    // (volume_spike 2026-04-03 buy + 그 이후 sell).  ASC 정렬로 per-mint queue 를 만든다.
    const { rows } = await pool.query<{ tx_signature: string | null; strategy: string; token_symbol: string | null; pair_address: string; pnl: string | null; created_at: Date; side: string }>(
      `SELECT tx_signature, strategy, token_symbol, pair_address, pnl, created_at, side
       FROM trades
       WHERE side = 'BUY'
       ORDER BY created_at ASC`
    );
    for (const r of rows) {
      if (r.tx_signature) {
        txMap.set(r.tx_signature, {
          strategy: r.strategy,
          symbol: r.token_symbol,
          storedPnl: r.pnl != null ? Number(r.pnl) : null,
        });
      }
      if (r.pair_address) {
        const queue = buyQueueByMint.get(r.pair_address) ?? [];
        queue.push({
          strategy: r.strategy,
          symbol: r.token_symbol,
          pairAddress: r.pair_address,
          createdAtMs: r.created_at.getTime(),
          txSignature: r.tx_signature,
          consumed: false,
        });
        buyQueueByMint.set(r.pair_address, queue);
      }
    }
  } finally {
    await pool.end();
  }
  return { txMap, buyQueueByMint };
}

/**
 * On-chain sell tx 를 해당 mint 의 가장 오래된 unconsumed DB buy 와 FIFO 매칭.
 * Returns null if no eligible buy found (unresolved sell).
 */
function matchSellToFifoBuy(
  involvedMints: string[],
  sellBlockTimeMs: number | null,
  buyQueueByMint: Map<string, DbBuyEntry[]>
): DbBuyEntry | null {
  for (const mint of involvedMints) {
    const queue = buyQueueByMint.get(mint);
    if (!queue) continue;
    for (const entry of queue) {
      if (entry.consumed) continue;
      // sell blockTime 이 buy 보다 이전이면 매칭 불가 (factual ordering).
      // blockTime 미상(null)이면 관대하게 허용 — fallback.
      if (sellBlockTimeMs != null && sellBlockTimeMs < entry.createdAtMs - 60_000) continue;
      entry.consumed = true;
      return entry;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error('Missing SOLANA_RPC_URL in .env');
    process.exit(1);
  }
  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = resolveWalletPubkey();
  const walletStr = wallet.toBase58();
  const usedPubkeyEnv = Boolean(process.env.WALLET_PUBLIC_KEY?.trim());
  console.log(`  (pubkey source: ${usedPubkeyEnv ? 'WALLET_PUBLIC_KEY' : 'WALLET_PRIVATE_KEY derivation'})`);
  const since = new Date(Date.now() - args.days * 86_400_000);

  console.log(`Wallet: ${walletStr}`);
  console.log(`Window: last ${args.days} days (since ${since.toISOString()})`);

  const [sigs, dbCtx] = await Promise.all([
    fetchAllSignatures(connection, wallet, since, args.throttleMs),
    loadDbContext(since),
  ]);
  const dbMap = dbCtx.txMap;
  const buyQueueByMint = dbCtx.buyQueueByMint;
  const totalBuyQueueSize = [...buyQueueByMint.values()].reduce((s, q) => s + q.length, 0);
  console.log(`On-chain tx signatures: ${sigs.length}`);
  console.log(`DB buy tx in txMap: ${dbMap.size}  |  per-mint FIFO queue: ${buyQueueByMint.size} mints, ${totalBuyQueueSize} total buys`);

  const limit = args.limit > 0 ? Math.min(args.limit, sigs.length) : sigs.length;
  const deltas: TxDelta[] = [];
  let rpcFailures = 0;
  for (let i = 0; i < limit; i++) {
    const d = await withRpcRetry(`getTransaction(${sigs[i].slice(0, 8)})`,
      () => fetchTxDelta(connection, sigs[i], walletStr)
    );
    if (d) deltas.push(d);
    else rpcFailures++;
    if (i % 25 === 0) {
      const running = deltas.reduce((s, d) => s + d.deltaSol, 0);
      process.stdout.write(`  [${i + 1}/${limit}] running_sum=${running.toFixed(6)} SOL  (rpc_fail=${rpcFailures})\r`);
    }
    if (args.throttleMs > 0 && i < limit - 1) await sleep(args.throttleMs);
  }
  process.stdout.write('\n');
  if (rpcFailures > 0) {
    console.log(`  ⚠ ${rpcFailures} tx could not be fetched — total_delta is lower bound`);
  }

  const totalDelta = deltas.reduce((s, d) => s + d.deltaSol, 0);
  const totalFees = deltas.reduce((s, d) => s + d.feeSol, 0);
  const byType = new Map<string, { count: number; sum: number }>();
  for (const d of deltas) {
    const acc = byType.get(d.type) ?? { count: 0, sum: 0 };
    acc.count++;
    acc.sum += d.deltaSol;
    byType.set(d.type, acc);
  }

  console.log('\n=== Ground Truth: Wallet SOL Net Delta ===');
  console.log(`  total_delta = ${totalDelta.toFixed(6)} SOL  (includes fees)`);
  console.log(`  total_fees  = ${totalFees.toFixed(6)} SOL`);
  console.log(`  tx_parsed   = ${deltas.length} / ${limit}`);
  for (const [type, { count, sum }] of byType) {
    console.log(`  ${type.padEnd(10)} count=${count}  sum=${sum.toFixed(6)} SOL`);
  }

  // DB crossref
  let matchedCount = 0;
  let matchedDelta = 0;
  let matchedStoredPnl = 0;
  const byStrategy = new Map<string, { count: number; onChainDelta: number; storedPnl: number }>();
  for (const d of deltas) {
    const db = dbMap.get(d.signature);
    if (!db) continue;
    matchedCount++;
    matchedDelta += d.deltaSol;
    const stored = db.storedPnl ?? 0;
    matchedStoredPnl += stored;
    const acc = byStrategy.get(db.strategy) ?? { count: 0, onChainDelta: 0, storedPnl: 0 };
    acc.count++;
    acc.onChainDelta += d.deltaSol;
    acc.storedPnl += stored;
    byStrategy.set(db.strategy, acc);
  }

  console.log('\n=== DB Crossref (trades.tx_signature) ===');
  console.log(`  matched tx      = ${matchedCount} / ${deltas.length}`);
  console.log(`  on-chain delta  = ${matchedDelta.toFixed(6)} SOL  (buy tx는 entry outflow)`);
  console.log(`  DB stored_pnl   = ${matchedStoredPnl.toFixed(6)} SOL  (trades.pnl 합)`);
  console.log('  ※ buy tx는 항상 음수 delta이므로 직접 비교 의미 없음. 전략별 turnover로 해석.');
  for (const [strat, v] of byStrategy) {
    console.log(`  ${strat.padEnd(20)} n=${v.count} on_chain_delta=${v.onChainDelta.toFixed(6)} stored_pnl_sum=${v.storedPnl.toFixed(6)}`);
  }

  // Unmatched (not in DB — e.g., sell tx, dust, non-swap)
  const unmatched = deltas.filter((d) => !dbMap.has(d.signature));
  const unmatchedDelta = unmatched.reduce((s, d) => s + d.deltaSol, 0);
  console.log(`\n  unmatched_tx    = ${unmatched.length}  (not in trades.tx_signature — includes sells, dust)`);
  console.log(`  unmatched_delta = ${unmatchedDelta.toFixed(6)} SOL`);

  // ─── 2026-04-17: Per-strategy Net Wallet Delta (FIFO buy↔sell matching) ───
  // Why: sell tx 는 trades.tx_signature 에 저장 안 됨. 대신 `preTokenBalances/postTokenBalances`
  // 에서 wallet 소유 mint 를 추출하고, 해당 mint 의 **가장 오래된 unconsumed DB buy** 와 FIFO 매칭.
  // 같은 mint 가 여러 strategy 에 쓰여도 (예: pippin = volume_spike + bootstrap + cupsey)
  // 각 sell 은 가장 오래된 buy 의 strategy 로 귀속된다 (standard inventory accounting).
  //
  // 처리 순서: on-chain deltas 를 blockTime ASC 로 정렬 → 시간 순서대로 buy 매칭/sell 매칭.
  // buy: tx_signature 로 직접 strategy 확정 (FIFO queue 에도 이미 존재).
  // sell: FIFO queue 의 가장 오래된 unconsumed buy 에 매칭 → 해당 buy 의 strategy 로 귀속.
  const netByStrategy = new Map<string, { buySol: number; sellSol: number; buyTx: number; sellTx: number; otherTx: number }>();
  const unresolvedSell: TxDelta[] = [];
  const UNKNOWN = '<unknown>';
  const UNRESOLVED = '<unresolved_sell>';

  // blockTime 정렬 (null 은 끝으로)
  const sortedDeltas = [...deltas].sort((a, b) => (a.blockTime ?? Number.MAX_SAFE_INTEGER) - (b.blockTime ?? Number.MAX_SAFE_INTEGER));
  for (const d of sortedDeltas) {
    let strat: string | null = null;
    if (d.type === 'buy') {
      const dbByTx = dbMap.get(d.signature);
      strat = dbByTx?.strategy ?? null;
    } else if (d.type === 'sell') {
      const blockTimeMs = d.blockTime != null ? d.blockTime * 1000 : null;
      const matched = matchSellToFifoBuy(d.involvedMints, blockTimeMs, buyQueueByMint);
      if (matched) {
        strat = matched.strategy;
      } else {
        unresolvedSell.push(d);
      }
    }
    const key = strat ?? (d.type === 'sell' ? UNRESOLVED : UNKNOWN);
    const acc = netByStrategy.get(key) ?? { buySol: 0, sellSol: 0, buyTx: 0, sellTx: 0, otherTx: 0 };
    if (d.type === 'buy') { acc.buySol += d.deltaSol; acc.buyTx++; }
    else if (d.type === 'sell') { acc.sellSol += d.deltaSol; acc.sellTx++; }
    else { acc.otherTx++; }
    netByStrategy.set(key, acc);
  }

  // FIFO queue 에서 unconsumed buy = stuck positions
  let stuckCount = 0;
  const stuckByStrategy = new Map<string, { count: number; mints: Set<string> }>();
  for (const [mint, queue] of buyQueueByMint) {
    for (const entry of queue) {
      if (entry.consumed) continue;
      stuckCount++;
      const acc = stuckByStrategy.get(entry.strategy) ?? { count: 0, mints: new Set<string>() };
      acc.count++;
      acc.mints.add(mint);
      stuckByStrategy.set(entry.strategy, acc);
    }
  }

  console.log('\n=== Per-Strategy Net Wallet Delta (FIFO buy↔sell matching) ===');
  console.log(`${'strategy'.padEnd(22)} ${'buy_tx'.padEnd(8)} ${'sell_tx'.padEnd(8)} ${'buy_sol'.padEnd(14)} ${'sell_sol'.padEnd(14)} ${'net_sol'.padEnd(12)}`);
  for (const [strat, v] of [...netByStrategy.entries()].sort((a, b) => (a[1].buySol + a[1].sellSol) - (b[1].buySol + b[1].sellSol))) {
    const net = v.buySol + v.sellSol;
    console.log(
      `${strat.padEnd(22)} ${String(v.buyTx).padEnd(8)} ${String(v.sellTx).padEnd(8)} ` +
      `${v.buySol.toFixed(6).padEnd(14)} +${v.sellSol.toFixed(6).padEnd(13)} ${net >= 0 ? '+' : ''}${net.toFixed(6)}`
    );
  }
  if (unresolvedSell.length > 0) {
    const unresolvedSolSum = unresolvedSell.reduce((s, d) => s + d.deltaSol, 0);
    console.log(`  ⚠ unresolved sell tx (no matching buy in DB): ${unresolvedSell.length} tx, +${unresolvedSolSum.toFixed(6)} SOL`);
  }

  console.log('\n=== Stuck Buys (unconsumed FIFO entries = buy with no matched sell) ===');
  console.log(`  total stuck: ${stuckCount}`);
  for (const [strat, v] of [...stuckByStrategy.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${strat.padEnd(22)} ${v.count} stuck buys across ${v.mints.size} unique mints`);
  }

  // Ranked deltas
  const sorted = [...deltas].sort((a, b) => b.deltaSol - a.deltaSol);
  console.log('\nTop 5 positive delta (likely sells):');
  for (const d of sorted.slice(0, 5)) {
    const db = dbMap.get(d.signature);
    console.log(`  +${d.deltaSol.toFixed(6)}  ${d.signature.slice(0, 20)}  ${db ? `[${db.strategy} ${db.symbol ?? '-'}]` : ''}`);
  }
  console.log('\nTop 5 negative delta (likely buys):');
  for (const d of sorted.slice(-5).reverse()) {
    const db = dbMap.get(d.signature);
    console.log(`  ${d.deltaSol.toFixed(6)}  ${d.signature.slice(0, 20)}  ${db ? `[${db.strategy} ${db.symbol ?? '-'}]` : ''}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
