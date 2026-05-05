/**
 * KOL Transfer Backfill via Helius getTransfersByAddress (2026-05-05).
 *
 * 목적: KOL wallet 행동분포 구축의 1차 sidecar ledger.
 * 정책:
 *   - data/kol/wallets.json 자동 수정 금지.
 *   - live/paper trading policy 에 연결하지 않음.
 *   - transfer 후보만 싸게 수집하고, 정밀 검증은 후속 gTFA drill-down 으로 수행.
 *
 * Usage:
 *   Helius RPC URL:
 *     HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=KEY" \
 *       npx ts-node scripts/kol-transfer-backfill.ts --since 30d
 *
 *   or API key:
 *     HELIUS_API_KEY=KEY npx ts-node scripts/kol-transfer-backfill.ts --since 30d
 */

import 'dotenv/config';
import { appendFile, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import path from 'path';
import {
  classifyTransferDirection,
  getTransfersByAddress,
  type HeliusTransferRecord,
  type HeliusTransferSolMode,
  type HeliusTransferSortOrder,
} from '../src/ingester/heliusTransferClient';

export const KOL_TRANSFER_SCHEMA_VERSION = 'kol-transfer-backfill/v1' as const;

interface Args {
  rpcUrl: string;
  kolDbPath: string;
  researchDir: string;
  realtimeDir: string;
  sinceSec: number;
  maxPagesPerWallet: number;
  limit: number;
  activeOnly: boolean;
  solMode: HeliusTransferSolMode;
  sortOrder: HeliusTransferSortOrder;
  overwrite: boolean;
  dryRun: boolean;
}

interface KolWalletEntry {
  id?: string;
  addresses?: string[];
  tier?: string;
  is_active?: boolean;
  lane_role?: string;
  trading_style?: string;
}

interface BackfillTarget {
  kolId: string;
  address: string;
  tier?: string;
  laneRole?: string;
  tradingStyle?: string;
}

export interface KolTransferBackfillRecord {
  schemaVersion: typeof KOL_TRANSFER_SCHEMA_VERSION;
  capturedAtIso: string;
  kolId: string;
  kolAddress: string;
  kolTier?: string;
  laneRole?: string;
  tradingStyle?: string;
  walletDirection: 'in' | 'out' | 'self' | 'unknown';
  eventId: string;
  transfer: HeliusTransferRecord;
}

export function parseArgs(argv: string[], nowSec = Math.floor(Date.now() / 1000)): Args {
  const envRpc = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || '';
  const envKey = process.env.HELIUS_API_KEY || '';
  const args: Args = {
    rpcUrl: envRpc || (envKey ? `https://mainnet.helius-rpc.com/?api-key=${envKey}` : ''),
    kolDbPath: path.resolve(process.cwd(), 'data/kol/wallets.json'),
    researchDir: path.resolve(process.cwd(), 'data/research'),
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    sinceSec: nowSec - 30 * 24 * 60 * 60,
    maxPagesPerWallet: 20,
    limit: 100,
    activeOnly: true,
    solMode: 'separate',
    sortOrder: 'asc',
    overwrite: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--rpc-url') args.rpcUrl = requireValue(argv[++i], a);
    else if (a === '--api-key') args.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${requireValue(argv[++i], a)}`;
    else if (a === '--kol-db') args.kolDbPath = path.resolve(requireValue(argv[++i], a));
    else if (a === '--research-dir') args.researchDir = path.resolve(requireValue(argv[++i], a));
    else if (a === '--realtime-dir') args.realtimeDir = path.resolve(requireValue(argv[++i], a));
    else if (a === '--since') args.sinceSec = nowSec - parseDurationSec(requireValue(argv[++i], a));
    else if (a === '--since-unix') args.sinceSec = parsePositiveInt(requireValue(argv[++i], a), a);
    else if (a === '--max-pages-per-wallet') args.maxPagesPerWallet = parsePositiveInt(requireValue(argv[++i], a), a);
    else if (a === '--limit') args.limit = Math.min(100, parsePositiveInt(requireValue(argv[++i], a), a));
    else if (a === '--include-inactive') args.activeOnly = false;
    else if (a === '--sol-mode') args.solMode = parseSolMode(requireValue(argv[++i], a));
    else if (a === '--sort-order') args.sortOrder = parseSortOrder(requireValue(argv[++i], a));
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--dry-run') args.dryRun = true;
  }

  if (!args.rpcUrl) {
    throw new Error('Provide HELIUS_RPC_URL, SOLANA_RPC_URL, HELIUS_API_KEY, --rpc-url, or --api-key');
  }
  return args;
}

function requireValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseDurationSec(input: string): number {
  const m = input.match(/^(\d+)([mhd])$/);
  if (!m) throw new Error(`invalid duration '${input}', expected 30m/12h/30d`);
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 60 * 60;
  return n * 24 * 60 * 60;
}

function parsePositiveInt(input: string, flag: string): number {
  const n = Number(input);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function parseSolMode(input: string): HeliusTransferSolMode {
  if (input === 'merged' || input === 'separate') return input;
  throw new Error(`--sol-mode must be merged|separate`);
}

function parseSortOrder(input: string): HeliusTransferSortOrder {
  if (input === 'asc' || input === 'desc') return input;
  throw new Error(`--sort-order must be asc|desc`);
}

export async function loadKolTargets(kolDbPath: string, activeOnly: boolean): Promise<BackfillTarget[]> {
  const raw = JSON.parse(await readFile(kolDbPath, 'utf8')) as { kols?: KolWalletEntry[] };
  const kols = Array.isArray(raw.kols) ? raw.kols : [];
  const targets: BackfillTarget[] = [];
  for (const kol of kols) {
    if (activeOnly && kol.is_active === false) continue;
    const addresses = Array.isArray(kol.addresses) ? kol.addresses : [];
    for (const address of addresses) {
      if (typeof address !== 'string' || address.length === 0) continue;
      targets.push({
        kolId: kol.id ?? address.slice(0, 8),
        address,
        tier: kol.tier,
        laneRole: kol.lane_role,
        tradingStyle: kol.trading_style,
      });
    }
  }
  return targets;
}

function buildEventId(address: string, t: HeliusTransferRecord): string {
  return [
    address,
    t.signature,
    t.instructionIdx ?? 'ix',
    t.innerInstructionIdx ?? 'inner',
    t.mint,
    t.amount,
  ].join(':');
}

export function buildBackfillRecord(target: BackfillTarget, transfer: HeliusTransferRecord): KolTransferBackfillRecord {
  return {
    schemaVersion: KOL_TRANSFER_SCHEMA_VERSION,
    capturedAtIso: new Date().toISOString(),
    kolId: target.kolId,
    kolAddress: target.address,
    kolTier: target.tier,
    laneRole: target.laneRole,
    tradingStyle: target.tradingStyle,
    walletDirection: classifyTransferDirection(transfer, target.address),
    eventId: buildEventId(target.address, transfer),
    transfer,
  };
}

async function appendRows(filePath: string, rows: KolTransferBackfillRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function backupPathFor(filePath: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${filePath}.bak-${stamp}`;
}

async function prepareOutputPath(
  outPath: string,
  overwrite: boolean,
  dryRun: boolean,
): Promise<{ writePath: string; backupPath?: string; tempPath?: string }> {
  if (!overwrite || dryRun) return { writePath: outPath };
  await mkdir(path.dirname(outPath), { recursive: true });
  const backupPath = await fileExists(outPath) ? backupPathFor(outPath) : undefined;
  if (backupPath) await copyFile(outPath, backupPath);
  const tempPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, '', 'utf8');
  return {
    writePath: tempPath,
    backupPath,
    tempPath,
  };
}

async function finalizeOutputPath(
  outPath: string,
  prepared: { writePath: string; tempPath?: string },
  successfulPages: number,
): Promise<void> {
  if (!prepared.tempPath) return;
  if (successfulPages <= 0) {
    await unlink(prepared.writePath).catch(() => {});
    throw new Error(`refusing to overwrite ${outPath}: no successful Helius pages`);
  }
  await rename(prepared.writePath, outPath);
}

export async function runBackfill(args: Args): Promise<{ targets: number; rows: number; requests: number; successfulPages: number; backupPath?: string }> {
  const targets = await loadKolTargets(args.kolDbPath, args.activeOnly);
  const outPath = path.join(args.researchDir, 'kol-transfers.jsonl');
  const prepared = await prepareOutputPath(outPath, args.overwrite, args.dryRun);
  let rows = 0;
  let requests = 0;
  let successfulPages = 0;

  for (const target of targets) {
    let paginationToken: string | undefined;
    for (let page = 0; page < args.maxPagesPerWallet; page += 1) {
      const result = await getTransfersByAddress(args.rpcUrl, {
        address: target.address,
        config: {
          limit: args.limit,
          paginationToken,
          sortOrder: args.sortOrder,
          solMode: args.solMode,
          filters: { blockTime: { gte: args.sinceSec } },
        },
      }, {
        traceId: `kol-transfer-${target.kolId}-${page}`,
        creditLedgerDir: args.realtimeDir,
        purpose: 'wallet_style_backfill',
      });
      requests += 1;
      if (!result) break;
      successfulPages += 1;

      const records = result.data.map((t) => buildBackfillRecord(target, t));
      rows += records.length;
      if (!args.dryRun) await appendRows(prepared.writePath, records);

      paginationToken = result.paginationToken ?? undefined;
      if (!paginationToken || result.data.length === 0) break;
    }
  }

  if (!args.dryRun) await finalizeOutputPath(outPath, prepared, successfulPages);
  return { targets: targets.length, rows, requests, successfulPages, backupPath: prepared.backupPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runBackfill(args);
  const creditEstimate = summary.requests * 10;
  console.log(
    `[kol-transfer-backfill] targets=${summary.targets} rows=${summary.rows} ` +
    `requests=${summary.requests} successfulPages=${summary.successfulPages} ` +
    `estimatedCredits=${creditEstimate} overwrite=${args.overwrite} dryRun=${args.dryRun}` +
    `${summary.backupPath ? ` backup=${summary.backupPath}` : ''}`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
