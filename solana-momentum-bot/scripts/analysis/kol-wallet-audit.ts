#!/usr/bin/env ts-node
/**
 * KOL Wallet Audit — 특정 trader 의 on-chain trade history 분석
 *
 * Why: cupsey 같은 KOL 의 실전 거래 패턴 (holding time, PnL 분포, token 선택) 을
 * 벤치마크로 사용해 bootstrap_10s 전략 파라미터를 교정한다.
 * Copy trading 이 아니라 전략 calibration source.
 *
 * Usage:
 *   # 로컬 (Helius RPC 필요)
 *   SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY \
 *     npx ts-node scripts/analysis/kol-wallet-audit.ts \
 *       --wallet 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f \
 *       --days 7
 *
 *   # VPS (env 에 RPC 설정 있으면)
 *   npx ts-node scripts/analysis/kol-wallet-audit.ts \
 *       --wallet 2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f \
 *       --days 7 --out docs/audits/kol-cupsey-2026-04-10.md
 *
 * Outputs:
 *   - Per-token trade pairs (buy→sell) with holding time, PnL%
 *   - Aggregate: WR, avg holding time p25/p50/p75, avg win%, avg loss%
 *   - Token mcap/liquidity distribution (if enrichment available)
 *   - Comparison table vs current tradingParams
 */

import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';

// ─── Constants ───
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const KNOWN_DEX_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium V4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter V6
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // PumpSwap
]);

interface ParsedSwapTx {
  signature: string;
  blockTime: number; // unix seconds
  tokenMint: string;
  side: 'buy' | 'sell';
  solAmount: number; // SOL involved
  tokenAmount: number; // token UI amount
  pricePerToken: number; // SOL per token
}

interface TradePair {
  tokenMint: string;
  buyTx: ParsedSwapTx;
  sellTx: ParsedSwapTx;
  holdingTimeSec: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  solPnl: number;
  isWin: boolean;
}

interface Args {
  wallet: string;
  days: number;
  outPath: string | null;
  rpcUrl: string;
  limit: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    wallet: '',
    days: 7,
    outPath: null,
    rpcUrl: process.env.SOLANA_RPC_URL || '',
    limit: 500,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--wallet' && value) { args.wallet = value; i++; }
    else if (flag === '--days' && value) { args.days = Number(value); i++; }
    else if (flag === '--out' && value) { args.outPath = value; i++; }
    else if (flag === '--rpc' && value) { args.rpcUrl = value; i++; }
    else if (flag === '--limit' && value) { args.limit = Number(value); i++; }
  }
  if (!args.wallet) {
    console.error('Usage: --wallet <SOLANA_ADDRESS> [--days 7] [--out path.md] [--rpc URL] [--limit 500]');
    process.exit(1);
  }
  if (!args.rpcUrl) {
    console.error('ERROR: SOLANA_RPC_URL env or --rpc flag required');
    process.exit(1);
  }
  return args;
}

async function fetchSignatures(
  connection: Connection,
  wallet: PublicKey,
  days: number,
  limit: number
): Promise<string[]> {
  const cutoffSec = Math.floor(Date.now() / 1000) - days * 86400;
  const signatures: string[] = [];
  let before: string | undefined;

  process.stderr.write(`Fetching signatures for ${wallet.toBase58()} (last ${days} days, limit ${limit})...\n`);

  while (signatures.length < limit) {
    const batch = await connection.getSignaturesForAddress(wallet, {
      limit: Math.min(1000, limit - signatures.length),
      before,
    });
    if (batch.length === 0) break;

    for (const sig of batch) {
      if (sig.blockTime && sig.blockTime < cutoffSec) {
        return signatures; // crossed cutoff
      }
      if (!sig.err) {
        signatures.push(sig.signature);
      }
    }
    before = batch[batch.length - 1].signature;
    process.stderr.write(`  fetched ${signatures.length} signatures...\n`);

    // Rate limit safety
    await new Promise(r => setTimeout(r, 200));
  }

  return signatures;
}

function extractSwapsFromParsedTx(
  tx: ParsedTransactionWithMeta,
  walletAddress: string,
  signature: string
): ParsedSwapTx[] {
  if (!tx.meta || tx.meta.err) return [];

  const preBalances = tx.meta.preTokenBalances ?? [];
  const postBalances = tx.meta.postTokenBalances ?? [];

  // Group by mint → compute delta for wallet-owned accounts
  const mintDeltas = new Map<string, { preDelta: number; postDelta: number; decimals: number }>();

  for (const bal of preBalances) {
    if (bal.owner !== walletAddress) continue;
    const mint = bal.mint;
    const entry = mintDeltas.get(mint) ?? { preDelta: 0, postDelta: 0, decimals: bal.uiTokenAmount.decimals };
    entry.preDelta += bal.uiTokenAmount.uiAmount ?? 0;
    mintDeltas.set(mint, entry);
  }
  for (const bal of postBalances) {
    if (bal.owner !== walletAddress) continue;
    const mint = bal.mint;
    const entry = mintDeltas.get(mint) ?? { preDelta: 0, postDelta: 0, decimals: bal.uiTokenAmount.decimals };
    entry.postDelta += bal.uiTokenAmount.uiAmount ?? 0;
    mintDeltas.set(mint, entry);
  }

  // SOL delta (lamports)
  const accountKeys = tx.transaction.message.accountKeys;
  let solDelta = 0;
  for (let i = 0; i < accountKeys.length; i++) {
    const key = typeof accountKeys[i] === 'string'
      ? accountKeys[i]
      : (accountKeys[i] as { pubkey: PublicKey }).pubkey?.toBase58() ?? '';
    if (key === walletAddress) {
      const pre = tx.meta.preBalances[i] ?? 0;
      const post = tx.meta.postBalances[i] ?? 0;
      solDelta = (post - pre) / 1e9; // Convert lamports to SOL
      break;
    }
  }

  const swaps: ParsedSwapTx[] = [];
  const blockTime = tx.blockTime ?? Math.floor(Date.now() / 1000);

  for (const [mint, deltas] of mintDeltas) {
    if (mint === SOL_MINT) continue; // skip wrapped SOL
    const tokenDelta = deltas.postDelta - deltas.preDelta;
    if (Math.abs(tokenDelta) < 1e-10) continue;

    const side: 'buy' | 'sell' = tokenDelta > 0 ? 'buy' : 'sell';
    const tokenAmount = Math.abs(tokenDelta);
    const solAmount = Math.abs(solDelta);

    if (solAmount <= 0 || tokenAmount <= 0) continue;
    const pricePerToken = solAmount / tokenAmount;

    swaps.push({
      signature,
      blockTime,
      tokenMint: mint,
      side,
      solAmount,
      tokenAmount,
      pricePerToken,
    });
  }

  return swaps;
}

function pairTrades(swaps: ParsedSwapTx[]): TradePair[] {
  // Sort by time
  const sorted = [...swaps].sort((a, b) => a.blockTime - b.blockTime);

  // Group by token
  const byToken = new Map<string, ParsedSwapTx[]>();
  for (const swap of sorted) {
    const list = byToken.get(swap.tokenMint) ?? [];
    list.push(swap);
    byToken.set(swap.tokenMint, list);
  }

  const pairs: TradePair[] = [];
  for (const [tokenMint, tokenSwaps] of byToken) {
    const buys = tokenSwaps.filter(s => s.side === 'buy');
    const sells = tokenSwaps.filter(s => s.side === 'sell');

    // Simple FIFO pairing
    const maxPairs = Math.min(buys.length, sells.length);
    for (let i = 0; i < maxPairs; i++) {
      const buy = buys[i];
      const sell = sells[i];
      if (sell.blockTime < buy.blockTime) continue; // sell before buy — skip

      const holdingTimeSec = sell.blockTime - buy.blockTime;
      const entryPrice = buy.pricePerToken;
      const exitPrice = sell.pricePerToken;
      const pnlPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
      const solPnl = sell.solAmount - buy.solAmount;

      pairs.push({
        tokenMint,
        buyTx: buy,
        sellTx: sell,
        holdingTimeSec,
        entryPrice,
        exitPrice,
        pnlPct,
        solPnl,
        isWin: solPnl > 0,
      });
    }
  }

  return pairs.sort((a, b) => a.buyTx.blockTime - b.buyTx.blockTime);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function render(args: Args, swaps: ParsedSwapTx[], pairs: TradePair[]): string {
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push(`# KOL Wallet Audit`);
  lines.push('');
  lines.push(`> Generated: ${now}`);
  lines.push(`> Wallet: ${args.wallet}`);
  lines.push(`> Window: last ${args.days} days`);
  lines.push(`> Raw swaps parsed: ${swaps.length}`);
  lines.push(`> Trade pairs reconstructed: ${pairs.length}`);
  lines.push('');

  if (pairs.length === 0) {
    lines.push('**No trade pairs reconstructed.** Wallet may not have matched buy/sell pairs in this window.');
    return lines.join('\n');
  }

  // Aggregate metrics
  const wins = pairs.filter(p => p.isWin);
  const losses = pairs.filter(p => !p.isWin);
  const wr = (wins.length / pairs.length) * 100;
  const totalSolPnl = pairs.reduce((s, p) => s + p.solPnl, 0);

  const holdTimes = pairs.map(p => p.holdingTimeSec).sort((a, b) => a - b);
  const winPcts = wins.map(p => p.pnlPct).sort((a, b) => a - b);
  const lossPcts = losses.map(p => p.pnlPct).sort((a, b) => a - b);
  const solPerTrade = pairs.map(p => p.buyTx.solAmount).sort((a, b) => a - b);

  lines.push(`## Aggregate Metrics`);
  lines.push('');
  lines.push(`| metric | value |`);
  lines.push(`|---|---|`);
  lines.push(`| trade pairs | ${pairs.length} |`);
  lines.push(`| wins / losses | ${wins.length}W / ${losses.length}L |`);
  lines.push(`| **win rate** | **${wr.toFixed(1)}%** |`);
  lines.push(`| total SOL PnL | ${totalSolPnl >= 0 ? '+' : ''}${totalSolPnl.toFixed(4)} SOL |`);
  lines.push(`| avg win % | ${winPcts.length > 0 ? `+${(winPcts.reduce((s, v) => s + v, 0) / winPcts.length).toFixed(2)}%` : 'n/a'} |`);
  lines.push(`| avg loss % | ${lossPcts.length > 0 ? `${(lossPcts.reduce((s, v) => s + v, 0) / lossPcts.length).toFixed(2)}%` : 'n/a'} |`);
  lines.push(`| **holding time p25** | **${fmtTime(quantile(holdTimes, 0.25))}** |`);
  lines.push(`| **holding time p50** | **${fmtTime(quantile(holdTimes, 0.5))}** |`);
  lines.push(`| **holding time p75** | **${fmtTime(quantile(holdTimes, 0.75))}** |`);
  lines.push(`| holding time max | ${fmtTime(Math.max(...holdTimes))} |`);
  lines.push(`| SOL per trade p50 | ${quantile(solPerTrade, 0.5).toFixed(3)} SOL |`);
  lines.push(`| trades per day | ${(pairs.length / args.days).toFixed(1)} |`);
  lines.push('');

  // Our params comparison
  lines.push(`## Comparison vs Current Strategy (Option β)`);
  lines.push('');
  lines.push(`| metric | cupsey observed | our current | gap |`);
  lines.push(`|---|---|---|---|`);
  const htP50 = quantile(holdTimes, 0.5);
  lines.push(`| holding time p50 | ${fmtTime(htP50)} | 20 min (timeStop) | ${htP50 < 1200 ? '🔴 cupsey 더 짧음' : '🟢 유사'} |`);
  const avgWinPct = winPcts.length > 0 ? winPcts.reduce((s, v) => s + v, 0) / winPcts.length : 0;
  lines.push(`| avg win % | +${avgWinPct.toFixed(2)}% | TP1=1.2%, TP2=4% (floor) | ${avgWinPct < 2 ? '🔴 작은 win' : avgWinPct < 5 ? '🟡 유사' : '🟢 큰 win'} |`);
  const avgLossPct = lossPcts.length > 0 ? lossPcts.reduce((s, v) => s + v, 0) / lossPcts.length : 0;
  lines.push(`| avg loss % | ${avgLossPct.toFixed(2)}% | SL=-1.0% (floor) | ${Math.abs(avgLossPct) < 2 ? '🟢 유사' : '🔴 큰 loss'} |`);
  lines.push(`| win rate | ${wr.toFixed(1)}% | 17.6% (live clean) | ${wr > 30 ? '🟢 cupsey 우세' : '🟡 유사'} |`);
  lines.push(`| trades/day | ${(pairs.length / args.days).toFixed(1)} | ~3-5 (observed) | — |`);
  lines.push('');

  // Top tokens
  const tokenStats = new Map<string, { count: number; totalPnl: number; wins: number }>();
  for (const p of pairs) {
    const entry = tokenStats.get(p.tokenMint) ?? { count: 0, totalPnl: 0, wins: 0 };
    entry.count += 1;
    entry.totalPnl += p.solPnl;
    if (p.isWin) entry.wins += 1;
    tokenStats.set(p.tokenMint, entry);
  }
  const sortedTokens = [...tokenStats.entries()].sort((a, b) => b[1].count - a[1].count);

  lines.push(`## Top Tokens (by trade count)`);
  lines.push('');
  lines.push(`| token | trades | wins | WR | total PnL |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  for (const [mint, stats] of sortedTokens.slice(0, 15)) {
    const shortMint = mint.slice(0, 8) + '...' + mint.slice(-4);
    lines.push(`| ${shortMint} | ${stats.count} | ${stats.wins} | ${(stats.wins / stats.count * 100).toFixed(0)}% | ${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(4)} |`);
  }
  lines.push('');

  // Recent trades (last 20)
  lines.push(`## Recent Trades (last 20)`);
  lines.push('');
  lines.push(`| # | token | buy time (UTC) | hold | entry SOL | pnl % | SOL pnl |`);
  lines.push(`|---|---|---|---|---:|---:|---:|`);
  const recent = pairs.slice(-20);
  for (let i = 0; i < recent.length; i++) {
    const p = recent[i];
    const buyTime = new Date(p.buyTx.blockTime * 1000).toISOString().slice(0, 19);
    const short = p.tokenMint.slice(0, 8) + '...';
    lines.push(`| ${i + 1} | ${short} | ${buyTime} | ${fmtTime(p.holdingTimeSec)} | ${p.buyTx.solAmount.toFixed(3)} | ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(2)}% | ${p.solPnl >= 0 ? '+' : ''}${p.solPnl.toFixed(4)} |`);
  }
  lines.push('');

  // Strategy calibration hints
  lines.push(`## Strategy Calibration Hints`);
  lines.push('');
  if (htP50 < 120) {
    lines.push(`- 🔴 **holding time p50 < 2min** → timeStop 20min 은 과도. **3-5min** 검토`);
    lines.push(`- 🔴 **ATR-based TP/SL 대신 fixed % exit** 검토 (cupsey 는 빠른 flip)`);
  } else if (htP50 < 600) {
    lines.push(`- 🟡 holding time p50 2-10min → timeStop 10-15min 적절할 수 있음`);
  } else {
    lines.push(`- 🟢 holding time p50 10min+ → 현재 timeStop 20min 유사`);
  }
  if (avgWinPct > 0 && avgWinPct < 3) {
    lines.push(`- 🟡 avg win < 3% → TP2 distance 3-4% 가 적정. ATR floor 0.8% × 5.0 = 4% 와 부합`);
  }
  if (Math.abs(avgLossPct) < 1.5) {
    lines.push(`- 🟢 avg loss < 1.5% → SL distance 1% (floor × 1.25) 와 부합`);
  }
  if (wr > 40) {
    lines.push(`- 🟢 WR ${wr.toFixed(0)}% 은 meme coin 에서 높은 편. cupsey 의 entry timing 은 참고 가치 있음`);
  }
  lines.push('');

  return lines.join('\n');
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) return 'n/a';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

async function main() {
  const args = parseArgs();
  const connection = new Connection(args.rpcUrl, 'confirmed');
  const wallet = new PublicKey(args.wallet);

  // Step 1: Fetch signatures
  const signatures = await fetchSignatures(connection, wallet, args.days, args.limit);
  process.stderr.write(`Total signatures: ${signatures.length}\n`);

  if (signatures.length === 0) {
    process.stderr.write('No transactions found in the window.\n');
    process.exit(0);
  }

  // Step 2: Parse transactions
  const allSwaps: ParsedSwapTx[] = [];
  const batchSize = 20;
  for (let i = 0; i < signatures.length; i += batchSize) {
    const batch = signatures.slice(i, i + batchSize);
    const txs = await connection.getParsedTransactions(batch, {
      maxSupportedTransactionVersion: 0,
    });

    for (let j = 0; j < txs.length; j++) {
      const tx = txs[j];
      if (!tx) continue;
      const swaps = extractSwapsFromParsedTx(tx, args.wallet, batch[j]);
      allSwaps.push(...swaps);
    }

    process.stderr.write(`  parsed ${Math.min(i + batchSize, signatures.length)}/${signatures.length} txs, ${allSwaps.length} swaps found...\n`);
    await new Promise(r => setTimeout(r, 300)); // Rate limit
  }

  process.stderr.write(`Total swaps: ${allSwaps.length}\n`);

  // Step 3: Pair trades
  const pairs = pairTrades(allSwaps);
  process.stderr.write(`Trade pairs: ${pairs.length}\n`);

  // Step 4: Render
  const md = render(args, allSwaps, pairs);

  if (args.outPath) {
    const outFp = path.resolve(process.cwd(), args.outPath);
    fs.mkdirSync(path.dirname(outFp), { recursive: true });
    fs.writeFileSync(outFp, md, 'utf-8');
    process.stderr.write(`Wrote ${outFp}\n`);
  } else {
    process.stdout.write(md);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
