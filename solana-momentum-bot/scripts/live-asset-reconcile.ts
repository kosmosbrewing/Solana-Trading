#!/usr/bin/env ts-node
/**
 * Live Asset Reconcile Report
 *
 * Read-only sidecar. It compares the main wallet's current SPL token balances
 * with live execution ledgers and reports residual assets such as:
 *   - closed_but_balance_remaining
 *   - open_but_zero_balance
 *   - unknown_residual
 *
 * It never sells or mutates DB/ledgers.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import {
  buildLiveAssetReconcileReport,
  type LiveAssetKolLiveTrade,
  type LiveAssetLedgerBuy,
  type LiveAssetLedgerSell,
  type LiveAssetReconcileRow,
  type LiveAssetReconcileSummary,
  type LiveWalletTokenBalance,
} from '../src/observability/liveAssetReconciler';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEjRZ2W2d9C9Y4n7PNiJZC2zDzL');

interface Args {
  ledgerDir: string;
  md: string;
  json: string;
  jsonl: string;
  includeOk: boolean;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    ledgerDir: get('--ledger-dir') ?? path.resolve(process.cwd(), 'data/realtime'),
    md: get('--md') ?? path.resolve(process.cwd(), `reports/live-asset-reconcile-${today()}.md`),
    json: get('--json') ?? path.resolve(process.cwd(), `reports/live-asset-reconcile-${today()}.json`),
    jsonl: get('--jsonl') ?? path.resolve(process.cwd(), 'data/realtime/live-asset-reconcile.jsonl'),
    includeOk: argv.includes('--include-ok'),
  };
}

function parseWalletPubkey(privateKey: string): PublicKey {
  if (privateKey.trim().startsWith('[')) {
    const arr = JSON.parse(privateKey) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr)).publicKey;
  }
  return Keypair.fromSecretKey(bs58.decode(privateKey.trim())).publicKey;
}

function resolveWalletPubkey(): PublicKey {
  const pub = process.env.WALLET_PUBLIC_KEY?.trim();
  if (pub) return new PublicKey(pub);
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error('Missing WALLET_PUBLIC_KEY or WALLET_PRIVATE_KEY');
  return parseWalletPubkey(privateKey);
}

async function readJsonlMaybe<T>(file: string): Promise<T[]> {
  let raw = '';
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const rows: T[] = [];
  let badRows = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      badRows += 1;
    }
  }
  if (badRows > 0) {
    console.warn(`[live-asset-reconcile] skipped ${badRows} malformed jsonl rows from ${file}`);
  }
  return rows;
}

function addBalance(
  balances: Map<string, LiveWalletTokenBalance>,
  mint: string,
  raw: string,
  uiAmount: number,
  decimals: number,
  tokenAccount: string,
): void {
  const existing = balances.get(mint);
  if (!existing) {
    balances.set(mint, {
      mint,
      raw,
      uiAmount,
      decimals,
      tokenAccounts: [tokenAccount],
    });
    return;
  }
  existing.raw = (BigInt(existing.raw) + BigInt(raw)).toString();
  existing.uiAmount += uiAmount;
  existing.decimals = Math.max(existing.decimals, decimals);
  existing.tokenAccounts.push(tokenAccount);
}

async function fetchWalletTokenBalances(
  connection: Connection,
  wallet: PublicKey
): Promise<LiveWalletTokenBalance[]> {
  const balances = new Map<string, LiveWalletTokenBalance>();
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const response = await connection.getParsedTokenAccountsByOwner(wallet, { programId });
    for (const account of response.value) {
      const parsed = account.account.data.parsed as {
        info?: {
          mint?: string;
          tokenAmount?: {
            amount?: string;
            decimals?: number;
            uiAmount?: number | null;
            uiAmountString?: string;
          };
        };
      };
      const mint = parsed.info?.mint;
      const amount = parsed.info?.tokenAmount?.amount;
      if (!mint || !amount || amount === '0') continue;
      const uiAmount =
        parsed.info?.tokenAmount?.uiAmount ??
        Number(parsed.info?.tokenAmount?.uiAmountString ?? '0');
      addBalance(
        balances,
        mint,
        amount,
        Number.isFinite(uiAmount) ? uiAmount : 0,
        parsed.info?.tokenAmount?.decimals ?? 0,
        account.pubkey.toBase58(),
      );
    }
  }
  return [...balances.values()];
}

function sol(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(6)} SOL`;
}

function short(value: string | null | undefined): string {
  if (!value) return '-';
  return value.length <= 16 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function formatRow(row: LiveAssetReconcileRow): string {
  return [
    `| ${row.status}`,
    row.symbol ?? '-',
    `\`${short(row.mint)}\``,
    row.walletUiAmount.toFixed(4),
    sol(row.estimatedEntryValueSol),
    row.openBuyCount.toString(),
    row.latestExitReason ?? '-',
    row.latestArmName ?? '-',
    row.recommendedAction,
    `\`${short(row.latestPositionId)}\` |`,
  ].join(' | ');
}

function formatMarkdown(report: LiveAssetReconcileSummary, includeOk: boolean): string {
  const visibleRows = includeOk
    ? report.rows
    : report.rows.filter((row) => row.status !== 'ok_zero');
  const lines: string[] = [];
  lines.push(`# Live Asset Reconcile — ${report.generatedAt.slice(0, 10)}`);
  lines.push('');
  lines.push(`- generatedAt: \`${report.generatedAt}\``);
  lines.push(`- wallet: \`${report.walletAddress}\``);
  lines.push(`- rows: ${report.totalRows}`);
  lines.push(`- anomalies: ${report.anomalyRows}`);
  lines.push('');
  lines.push('## Status');
  lines.push('');
  for (const [status, count] of Object.entries(report.byStatus)) {
    lines.push(`- ${status}: ${count}`);
  }
  lines.push('');
  lines.push('## Residual / Open Review');
  lines.push('');
  lines.push('| Status | Symbol | Mint | Wallet UI | Est Entry Value | Open Buys | Exit Reason | Arm | Action | Position |');
  lines.push('|---|---:|---:|---:|---:|---:|---|---|---|---|');
  if (visibleRows.length === 0) {
    lines.push('| ok | - | - | - | - | - | - | - | none | - |');
  } else {
    for (const row of visibleRows.slice(0, 80)) lines.push(formatRow(row));
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- `closed_but_balance_remaining`: ledger says closed, but wallet still holds tokens. Review cleanup manually.');
  lines.push('- `open_but_zero_balance`: ledger has an open buy without wallet tokens. Review phantom/open-state cleanup.');
  lines.push('- `unknown_residual`: wallet holds tokens without matching live ledgers. Review manually before any sell.');
  lines.push('- This report is read-only and never sells tokens.');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error('Missing SOLANA_RPC_URL');
  const wallet = resolveWalletPubkey();
  const connection = new Connection(rpcUrl, 'confirmed');

  const [walletBalances, buys, sells, liveTrades] = await Promise.all([
    fetchWalletTokenBalances(connection, wallet),
    readJsonlMaybe<LiveAssetLedgerBuy>(path.join(args.ledgerDir, 'executed-buys.jsonl')),
    readJsonlMaybe<LiveAssetLedgerSell>(path.join(args.ledgerDir, 'executed-sells.jsonl')),
    readJsonlMaybe<LiveAssetKolLiveTrade>(path.join(args.ledgerDir, 'kol-live-trades.jsonl')),
  ]);

  const report = buildLiveAssetReconcileReport({
    walletAddress: wallet.toBase58(),
    walletBalances,
    buys,
    sells,
    liveTrades,
  });

  await mkdir(path.dirname(args.md), { recursive: true });
  await writeFile(args.md, formatMarkdown(report, args.includeOk), 'utf8');
  await mkdir(path.dirname(args.json), { recursive: true });
  await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await mkdir(path.dirname(args.jsonl), { recursive: true });
  await appendFile(args.jsonl, `${JSON.stringify({
    generatedAt: report.generatedAt,
    walletAddress: report.walletAddress,
    totalRows: report.totalRows,
    anomalyRows: report.anomalyRows,
    byStatus: report.byStatus,
  })}\n`, 'utf8');

  console.log(
    `[live-asset-reconcile] rows=${report.totalRows} anomalies=${report.anomalyRows} ` +
    `closedResidual=${report.byStatus.closed_but_balance_remaining} ` +
    `openZero=${report.byStatus.open_but_zero_balance} unknown=${report.byStatus.unknown_residual} ` +
    `md=${args.md}`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[live-asset-reconcile] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export { formatMarkdown, fetchWalletTokenBalances };
