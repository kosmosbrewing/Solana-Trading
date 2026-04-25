/* eslint-disable no-console */
/**
 * Equity Decomposition Report (MISSION_CONTROL §Control 1, 2026-04-25)
 *
 * Why: MISSION_CONTROL.md §Control 1 마지막 단락 — "Every live report separates:
 *   wallet_cash_delta, wallet_equity_delta, realized_lane_pnl, execution_cost_breakdown"
 * 이 4종을 한 번에 분리해 출력하는 도구가 없었다.
 *
 * ⚠ Honesty disclaimer (2026-04-25 review fix):
 *   본 스크립트의 기본 모드는 **ledger 기반 추정**이며, MISSION_CONTROL 의 wallet truth (RPC 실측)
 *   가 아니다. ledger sum 을 wallet_cash_delta 로 호도하지 않도록 출력은 명시적으로
 *   `walletCashDeltaSource = 'ledger_realized_sum' | 'rpc_balance'` 를 보고한다.
 *   실제 wallet RPC 검증은 `scripts/wallet-reconcile.ts` (현존) 와 cross-check 필요.
 *   `--rpc-check` 플래그가 들어오면 SOLANA_RPC_URL + WALLET_PUBLIC_KEY 로 live balance 비교 시도.
 *
 * 입력:
 *   - data/realtime/executed-buys.jsonl
 *   - data/realtime/executed-sells.jsonl
 *   - data/realtime/sessions/<latest>/kol-paper-trades.jsonl  (KOL paper)
 *
 * 출력 (MISSION_CONTROL §Control 1 4 layer):
 *   1. wallet_cash_delta       — ledger realized sum (default) 또는 RPC live diff (--rpc-check)
 *   2. wallet_equity_delta     — wallet_cash_delta + open inventory cost basis
 *   3. realized_lane_pnl       — lane 별 closed-trade net PnL 합 (FIFO paired)
 *   4. execution_cost_breakdown — entry/exit slippage avg + total bleed estimate
 *
 * 실행:
 *   npx ts-node scripts/equity-decomposition.ts [--ledger-dir data/realtime] [--paper-dir <session>]
 *                                                [--baseline-sol 1.07] [--rpc-check]
 *                                                [--md out.md] [--json out.json]
 */
import { readFile, readdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

interface BuyLedger {
  positionId?: string;
  txSignature?: string;
  strategy?: string;
  pairAddress?: string;
  tokenSymbol?: string;
  actualEntryPrice?: number;
  actualQuantity?: number;
  slippageBps?: number;
  signalPrice?: number;
  recordedAt?: string;
}

interface SellLedger {
  positionId?: string;
  entryTxSignature?: string;
  strategy?: string;
  pairAddress?: string;
  tokenSymbol?: string;
  exitReason?: string;
  receivedSol?: number;
  actualExitPrice?: number;
  slippageBps?: number;
  entryPrice?: number;
  holdSec?: number;
  recordedAt?: string;
}

interface PaperTrade {
  positionId?: string;
  strategy?: string;
  lane?: string;
  tokenMint?: string;
  entryPrice?: number;
  exitPrice?: number;
  netSol?: number;
  netPct?: number;
  exitReason?: string;
  parameterVersion?: string;
  detectorVersion?: string;
}

interface CliArgs {
  ledgerDir: string;
  paperDir?: string;
  baselineSol?: number;
  rpcCheck: boolean;
  json?: string;
  md?: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    ledgerDir: get('--ledger-dir') ?? path.resolve('data/realtime'),
    paperDir: get('--paper-dir'),
    baselineSol: get('--baseline-sol') ? Number(get('--baseline-sol')) : undefined,
    rpcCheck: argv.includes('--rpc-check'),
    json: get('--json'),
    md: get('--md'),
  };
}

/**
 * RPC live wallet balance diff vs --baseline-sol. ground truth 비교용.
 * 실패 시 null 반환. SOLANA_RPC_URL + WALLET_PUBLIC_KEY 환경변수 필요.
 */
async function fetchRpcWalletDelta(baselineSol: number): Promise<{ currentSol: number; deltaSol: number } | null> {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const pubkey = process.env.WALLET_PUBLIC_KEY;
  if (!rpcUrl || !pubkey) {
    console.warn('[equity-decomposition] --rpc-check skipped: SOLANA_RPC_URL or WALLET_PUBLIC_KEY missing');
    return null;
  }
  try {
    // Lazy import — avoid loading web3.js when --rpc-check 미사용
    const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
    const connection = new Connection(rpcUrl, 'confirmed');
    const lamports = await connection.getBalance(new PublicKey(pubkey));
    const currentSol = lamports / LAMPORTS_PER_SOL;
    return { currentSol, deltaSol: currentSol - baselineSol };
  } catch (err) {
    console.warn(`[equity-decomposition] RPC balance fetch failed: ${err}`);
    return null;
  }
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((row): row is T => row !== null);
}

async function findLatestSessionPaperLedger(): Promise<string | null> {
  const sessionsDir = path.resolve('data/realtime/sessions');
  if (!existsSync(sessionsDir)) return null;
  const entries = (await readdir(sessionsDir))
    .filter((n) => n.endsWith('-live') || n.endsWith('-paper'))
    .sort()
    .reverse();
  for (const entry of entries) {
    const candidate = path.join(sessionsDir, entry, 'kol-paper-trades.jsonl');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface Decomposition {
  generatedAt: string;
  laneRealizedPnl: Record<string, { trades: number; netSol: number; meanNetSol: number; medianNetSol: number }>;
  totalRealizedSol: number;
  // Layer 4: execution cost breakdown
  executionCosts: {
    sumEntrySlippageBps: number;
    sumExitSlippageBps: number;
    avgEntrySlippageBps: number;
    avgExitSlippageBps: number;
    totalBleedSolEstimate: number;
    countWithSlippage: number;
  };
  // Layer 1-2: wallet (only if baseline given)
  walletCashDelta: number | null;
  walletCashDeltaSource: 'ledger_realized_sum' | 'rpc_balance';
  rpcCurrentSol: number | null;
  walletEquityDelta: number | null;
  openInventoryNotionalSol: number;
  // Paper (if available)
  paperRealizedSolByLane: Record<string, { trades: number; netSol: number }>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function decompose(args: CliArgs): Promise<Decomposition> {
  const buys = await readJsonl<BuyLedger>(path.join(args.ledgerDir, 'executed-buys.jsonl'));
  const sells = await readJsonl<SellLedger>(path.join(args.ledgerDir, 'executed-sells.jsonl'));

  // FIFO pair by entryTxSignature → buy
  const buysByTx = new Map<string, BuyLedger>();
  for (const b of buys) {
    if (b.txSignature) buysByTx.set(b.txSignature, b);
  }

  const laneNetSols: Record<string, number[]> = {};
  let sumEntrySlipBps = 0;
  let sumExitSlipBps = 0;
  let countWithSlippage = 0;
  let totalBleedEstimate = 0;

  for (const s of sells) {
    const buy = s.entryTxSignature ? buysByTx.get(s.entryTxSignature) : undefined;
    if (!buy) continue;
    const lane = s.strategy ?? 'unknown';
    const entryPrice = buy.actualEntryPrice ?? s.entryPrice ?? 0;
    const quantity = buy.actualQuantity ?? 0;
    const exitSol = s.receivedSol ?? 0;
    const entrySolNominal = entryPrice * quantity;
    const netSol = exitSol - entrySolNominal;
    if (!laneNetSols[lane]) laneNetSols[lane] = [];
    laneNetSols[lane].push(netSol);

    if (buy.slippageBps != null || s.slippageBps != null) {
      countWithSlippage++;
      sumEntrySlipBps += buy.slippageBps ?? 0;
      sumExitSlipBps += s.slippageBps ?? 0;
      // bleed estimate = (|entryBps| + |exitBps|) / 10000 × entrySolNominal
      const bleedPct = (Math.abs(buy.slippageBps ?? 0) + Math.abs(s.slippageBps ?? 0)) / 10000;
      totalBleedEstimate += bleedPct * entrySolNominal;
    }
  }

  const laneRealizedPnl: Decomposition['laneRealizedPnl'] = {};
  let totalRealizedSol = 0;
  for (const [lane, vals] of Object.entries(laneNetSols)) {
    const sum = vals.reduce((a, b) => a + b, 0);
    laneRealizedPnl[lane] = {
      trades: vals.length,
      netSol: sum,
      meanNetSol: sum / vals.length,
      medianNetSol: median(vals),
    };
    totalRealizedSol += sum;
  }

  // Layer 1-2 wallet — open inventory: buys without matching sell × current entry price
  const sellEntryTxs = new Set(sells.map((s) => s.entryTxSignature).filter(Boolean));
  const openBuys = buys.filter((b) => b.txSignature && !sellEntryTxs.has(b.txSignature));
  const openInventoryNotionalSol = openBuys.reduce(
    (acc, b) => acc + (b.actualEntryPrice ?? 0) * (b.actualQuantity ?? 0),
    0
  );

  // ⚠ ledger sum 은 wallet truth 가 아니다. Default 는 'ledger_realized_sum' 으로 명시 보고하고,
  // --rpc-check 가 들어오면 실제 wallet balance 와 baseline diff 로 override.
  let walletCashDelta: number | null = args.baselineSol != null ? totalRealizedSol : null;
  let walletCashDeltaSource: 'ledger_realized_sum' | 'rpc_balance' = 'ledger_realized_sum';
  let rpcCurrentSol: number | null = null;
  if (args.rpcCheck && args.baselineSol != null) {
    const rpc = await fetchRpcWalletDelta(args.baselineSol);
    if (rpc) {
      walletCashDelta = rpc.deltaSol;
      walletCashDeltaSource = 'rpc_balance';
      rpcCurrentSol = rpc.currentSol;
    }
  }
  // Equity = cash + open inventory at cost basis (보수적 — current price 미조회)
  const walletEquityDelta =
    args.baselineSol != null && walletCashDelta != null
      ? walletCashDelta + openInventoryNotionalSol
      : null;

  // Paper aggregation
  const paperRealizedSolByLane: Decomposition['paperRealizedSolByLane'] = {};
  const paperLedger = args.paperDir
    ? path.join(args.paperDir, 'kol-paper-trades.jsonl')
    : await findLatestSessionPaperLedger();
  if (paperLedger && existsSync(paperLedger)) {
    const trades = await readJsonl<PaperTrade>(paperLedger);
    for (const t of trades) {
      const lane = t.lane ?? t.strategy ?? 'unknown';
      if (!paperRealizedSolByLane[lane]) {
        paperRealizedSolByLane[lane] = { trades: 0, netSol: 0 };
      }
      paperRealizedSolByLane[lane].trades++;
      paperRealizedSolByLane[lane].netSol += t.netSol ?? 0;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    laneRealizedPnl,
    totalRealizedSol,
    executionCosts: {
      sumEntrySlippageBps: sumEntrySlipBps,
      sumExitSlippageBps: sumExitSlipBps,
      avgEntrySlippageBps: countWithSlippage > 0 ? sumEntrySlipBps / countWithSlippage : 0,
      avgExitSlippageBps: countWithSlippage > 0 ? sumExitSlipBps / countWithSlippage : 0,
      totalBleedSolEstimate: totalBleedEstimate,
      countWithSlippage,
    },
    walletCashDelta,
    walletCashDeltaSource,
    rpcCurrentSol,
    walletEquityDelta,
    openInventoryNotionalSol,
    paperRealizedSolByLane,
  };
}

function buildMarkdown(d: Decomposition, args: CliArgs): string {
  const lines: string[] = [];
  lines.push('# Equity Decomposition Report (MISSION_CONTROL §Control 1)');
  lines.push('');
  lines.push(`> Generated: ${d.generatedAt}`);
  lines.push(`> Ledger: ${args.ledgerDir}`);
  if (args.baselineSol != null) lines.push(`> Baseline wallet: ${args.baselineSol} SOL`);
  lines.push('');
  lines.push('## Layer 1 — Wallet Cash Delta');
  lines.push('');
  if (d.walletCashDeltaSource === 'rpc_balance') {
    lines.push('Source: **RPC live balance** (ground truth). `WALLET_PUBLIC_KEY` 의 현재 잔액 vs `--baseline-sol` 차이.');
  } else {
    lines.push(
      'Source: **ledger realized sum (proxy)** — closed-trade FIFO 합. RPC 실측 아니므로 wallet truth 가 아닌 추정값.'
    );
    lines.push('실제 wallet 검증은 `--rpc-check` 또는 `scripts/wallet-reconcile.ts` 사용.');
  }
  lines.push('');
  if (d.walletCashDelta != null) {
    lines.push(`- **wallet_cash_delta**: ${d.walletCashDelta.toFixed(6)} SOL  *(source=${d.walletCashDeltaSource})*`);
    if (d.rpcCurrentSol != null) {
      lines.push(`- RPC current wallet: ${d.rpcCurrentSol.toFixed(6)} SOL`);
    }
  } else {
    lines.push(`- baseline 미지정 → cash delta 산출 skip (ledger realized sum = ${d.totalRealizedSol.toFixed(6)} SOL)`);
  }
  lines.push('');
  lines.push('## Layer 2 — Wallet Equity Delta');
  lines.push('');
  lines.push('cash + open inventory cost basis. 미실현 equity 보수적 추정.');
  lines.push('');
  lines.push(`- **wallet_equity_delta**: ${d.walletEquityDelta != null ? d.walletEquityDelta.toFixed(6) : 'n/a'} SOL`);
  lines.push(`- open inventory notional: ${d.openInventoryNotionalSol.toFixed(6)} SOL`);
  lines.push('');
  lines.push('## Layer 3 — Realized Lane PnL (live)');
  lines.push('');
  lines.push('| Lane | Trades | Sum Net SOL | Mean | Median |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const [lane, stat] of Object.entries(d.laneRealizedPnl).sort()) {
    lines.push(
      `| ${lane} | ${stat.trades} | ${stat.netSol.toFixed(6)} | ${stat.meanNetSol.toFixed(6)} | ${stat.medianNetSol.toFixed(6)} |`
    );
  }
  if (Object.keys(d.laneRealizedPnl).length === 0) {
    lines.push('| (no closed trades) | — | — | — | — |');
  }
  lines.push('');
  if (Object.keys(d.paperRealizedSolByLane).length > 0) {
    lines.push('## Layer 3b — Paper Realized PnL (kol_hunter)');
    lines.push('');
    lines.push('| Lane | Trades | Sum Net SOL |');
    lines.push('|---|---:|---:|');
    for (const [lane, stat] of Object.entries(d.paperRealizedSolByLane).sort()) {
      lines.push(`| ${lane} | ${stat.trades} | ${stat.netSol.toFixed(6)} |`);
    }
    lines.push('');
  }
  lines.push('## Layer 4 — Execution Cost Breakdown');
  lines.push('');
  lines.push(`- avg entry slippage: ${d.executionCosts.avgEntrySlippageBps.toFixed(1)} bps`);
  lines.push(`- avg exit slippage: ${d.executionCosts.avgExitSlippageBps.toFixed(1)} bps`);
  lines.push(`- total estimated bleed: ${d.executionCosts.totalBleedSolEstimate.toFixed(6)} SOL`);
  lines.push(`- trades with slippage data: ${d.executionCosts.countWithSlippage}`);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- DB pnl 단독 판정 금지 (`mission-pivot-2026-04-18.md`).');
  lines.push('- Default Layer 1 = ledger sum proxy (NOT wallet truth). Ground truth 는 `--rpc-check` 또는 `wallet-reconcile.ts`.');
  lines.push('- Paper KOL ledger 는 ledger 디렉토리와 별개 (sessions/<latest>).');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const result = await decompose(args);

  if (args.json) {
    await writeFile(args.json, JSON.stringify(result, null, 2));
    console.log(`[equity-decomposition] wrote ${args.json}`);
  }

  const md = buildMarkdown(result, args);
  if (args.md) {
    await writeFile(args.md, md);
    console.log(`[equity-decomposition] wrote ${args.md}`);
  } else {
    console.log(md);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
