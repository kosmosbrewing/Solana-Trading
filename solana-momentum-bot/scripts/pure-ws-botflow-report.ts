import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import {
  buildBotflowCandidates,
  buildBotflowMarkouts,
  DEFAULT_PURE_WS_BOTFLOW_PAPER_CONFIG,
  appendPureWsBotflowJsonl,
  loadPureWsBotflowPricePoints,
  loadPureWsBotflowContext,
  parseBotflowEventsFromEnhancedTransactions,
  resolvePureWsBotflowProfile,
  simulateBotflowPaperTrades,
  type EnhancedTransactionLike,
  type PureWsBotflowBotProfile,
  type PureWsBotflowProvenanceConfidence,
  type PureWsBotflowWalletRole,
} from '../src/observability/pureWsBotflow';
import {
  buildPureWsBotflowReport,
  renderPureWsBotflowMarkdown,
  type BotflowReport,
} from '../src/observability/pureWsBotflowReport';
import { renderPureWsBotflowTelegram } from '../src/observability/pureWsBotflowTelegram';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const EVENT_FILE = 'pure-ws-botflow-events.jsonl';
const CANDIDATE_FILE = 'pure-ws-botflow-candidates.jsonl';
const MARKOUT_FILE = 'pure-ws-botflow-markouts.jsonl';
const PAPER_FILE = 'pure-ws-botflow-paper.jsonl';

interface Args {
  botProfile: PureWsBotflowBotProfile;
  trackedAddress: string;
  feePayerFilter?: string;
  walletRole: PureWsBotflowWalletRole;
  provenanceConfidence: PureWsBotflowProvenanceConfidence;
  mayhemAgentWallet?: string;
  mayhemProgramId?: string;
  profileNotes: string[];
  apiKey: string;
  pages: number;
  pageLimit: number;
  realtimeDir: string;
  pairContextFile: string;
  tokenQualityFile: string;
  admissionFile: string;
  priceFile: string;
  marketAccounts: string[];
  horizonsSec: number[];
  windowSecs: number[];
  roundTripCostPct: number;
  maxMarkoutLagMs: number;
  paperTicketSol: number;
  paperMaxHoldSec: number;
  writeLedgers: boolean;
  telegram: boolean;
  mdOut: string;
  jsonOut: string;
}

export function parseArgs(argv: string[]): Args {
  const today = new Date().toISOString().slice(0, 10);
  let trackedAddressExplicit = false;
  let feePayerFilterExplicit = false;
  const args: Args = {
    botProfile: 'custom',
    trackedAddress: '',
    walletRole: 'custom_research',
    provenanceConfidence: 'user_supplied',
    profileNotes: [],
    apiKey: process.env.HELIUS_API_KEY ?? '',
    pages: 3,
    pageLimit: 100,
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    pairContextFile: '',
    tokenQualityFile: path.resolve(process.cwd(), 'data/realtime/token-quality-observations.jsonl'),
    admissionFile: path.resolve(process.cwd(), 'data/realtime/admission-skips-dex.jsonl'),
    priceFile: '',
    marketAccounts: [],
    horizonsSec: [3, 10, 15, 30, 60],
    windowSecs: [3, 10, 15, 30],
    roundTripCostPct: 0.005,
    maxMarkoutLagMs: 2_000,
    paperTicketSol: DEFAULT_PURE_WS_BOTFLOW_PAPER_CONFIG.ticketSol,
    paperMaxHoldSec: DEFAULT_PURE_WS_BOTFLOW_PAPER_CONFIG.maxHoldSec,
    writeLedgers: false,
    telegram: false,
    mdOut: path.resolve(process.cwd(), `reports/pure-ws-botflow-${today}.md`),
    jsonOut: path.resolve(process.cwd(), `reports/pure-ws-botflow-${today}.json`),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bot-profile') args.botProfile = parseBotProfile(argv[++i]);
    else if (arg === '--tracked-address') {
      args.trackedAddress = argv[++i];
      trackedAddressExplicit = true;
    } else if (arg === '--fee-payer') {
      args.trackedAddress = argv[++i];
      args.feePayerFilter = args.trackedAddress;
      trackedAddressExplicit = true;
      feePayerFilterExplicit = true;
    } else if (arg === '--fee-payer-filter') {
      args.feePayerFilter = argv[++i];
      feePayerFilterExplicit = true;
    }
    else if (arg === '--api-key') args.apiKey = argv[++i];
    else if (arg === '--pages') args.pages = parsePositiveInt(argv[++i], arg);
    else if (arg === '--page-limit') args.pageLimit = parsePositiveInt(argv[++i], arg);
    else if (arg === '--realtime-dir') args.realtimeDir = path.resolve(argv[++i]);
    else if (arg === '--pair-context-file') args.pairContextFile = path.resolve(argv[++i]);
    else if (arg === '--token-quality-file') args.tokenQualityFile = path.resolve(argv[++i]);
    else if (arg === '--admission-file') args.admissionFile = path.resolve(argv[++i]);
    else if (arg === '--price-file') args.priceFile = path.resolve(argv[++i]);
    else if (arg === '--market-accounts') args.marketAccounts = parseCsvStrings(argv[++i], arg);
    else if (arg === '--horizons') args.horizonsSec = parseCsvNumbers(argv[++i], arg);
    else if (arg === '--windows') args.windowSecs = parseCsvNumbers(argv[++i], arg);
    else if (arg === '--round-trip-cost-pct') args.roundTripCostPct = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--max-markout-lag-ms') args.maxMarkoutLagMs = parsePositiveInt(argv[++i], arg);
    else if (arg === '--paper-ticket-sol') args.paperTicketSol = parseNonNegativeNumber(argv[++i], arg);
    else if (arg === '--paper-max-hold-sec') args.paperMaxHoldSec = parsePositiveInt(argv[++i], arg);
    else if (arg === '--write-ledgers') args.writeLedgers = true;
    else if (arg === '--telegram') args.telegram = true;
    else if (arg === '--md') args.mdOut = path.resolve(argv[++i]);
    else if (arg === '--json') args.jsonOut = path.resolve(argv[++i]);
  }
  applyProfile(args, trackedAddressExplicit, feePayerFilterExplicit);
  if (!args.apiKey) throw new Error('HELIUS_API_KEY env or --api-key is required');
  if (!args.trackedAddress) throw new Error('Provide --tracked-address or --bot-profile gygj_legacy|mayhem_current');
  if (args.marketAccounts.length === 0) {
    throw new Error('Provide --market-accounts explicitly; Mayhem/agent wallets are not implicit market counterparties');
  }
  return args;
}

async function fetchEnhancedTransactions(args: Args): Promise<EnhancedTransactionLike[]> {
  const rows: EnhancedTransactionLike[] = [];
  let before: string | undefined;
  for (let page = 0; page < args.pages; page += 1) {
    const url = new URL(`https://api.helius.xyz/v0/addresses/${args.trackedAddress}/transactions`);
    url.searchParams.set('api-key', args.apiKey);
    url.searchParams.set('limit', String(args.pageLimit));
    if (before) url.searchParams.set('before', before);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Helius Enhanced request failed: ${res.status} ${await res.text()}`);
    const batch = await res.json() as EnhancedTransactionLike[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    before = batch[batch.length - 1]?.signature;
    if (!before) break;
    await sleep(120);
  }
  return rows;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const txs = await fetchEnhancedTransactions(args);
  const context = await loadPureWsBotflowContext({
    pairContextFile: args.pairContextFile,
    tokenQualityFile: args.tokenQualityFile,
    admissionFile: args.admissionFile,
  });
  const events = parseBotflowEventsFromEnhancedTransactions(txs, {
    feePayerAddress: args.feePayerFilter,
    marketAccounts: args.marketAccounts,
    requireFeePayerMatch: Boolean(args.feePayerFilter),
  });
  const candidates = buildBotflowCandidates(events, {
    windowSecs: args.windowSecs,
    botProfile: args.botProfile,
    walletRole: args.walletRole,
    provenanceConfidence: args.provenanceConfidence,
    pairContextByMint: context.pairContextByMint,
    securityFlagsByMint: context.securityFlagsByMint,
    qualityFlagsByMint: context.qualityFlagsByMint,
    estimatedRoundTripCostPct: args.roundTripCostPct,
    thresholds: {
      minBuyCount: 3,
      minSmallBuyCount: 2,
      minGrossBuySol: 1,
      minNetFlowSol: 0,
      minBuySellRatio: 1.0,
      smallBuyMaxSol: 0.6,
    },
  });
  const markouts = buildBotflowMarkouts(events, candidates, {
    horizonsSec: args.horizonsSec,
    roundTripCostPct: args.roundTripCostPct,
    maxMarkoutLagMs: args.maxMarkoutLagMs,
    pricePoints: await loadPureWsBotflowPricePoints(args.priceFile),
  });
  const paperTrades = simulateBotflowPaperTrades(candidates, markouts, {
    ticketSol: args.paperTicketSol,
    maxHoldSec: args.paperMaxHoldSec,
  });
  const report = buildPureWsBotflowReport(args, txs.length, events, candidates, markouts, paperTrades);

  await mkdir(path.dirname(args.mdOut), { recursive: true });
  await writeFile(args.mdOut, renderPureWsBotflowMarkdown(report), 'utf8');
  await writeFile(args.jsonOut, JSON.stringify({ report, candidates, markouts }, null, 2) + '\n', 'utf8');
  if (args.writeLedgers) {
    await appendPureWsBotflowJsonl(path.join(args.realtimeDir, EVENT_FILE), events, 'eventId');
    await appendPureWsBotflowJsonl(path.join(args.realtimeDir, CANDIDATE_FILE), candidates, 'candidateId');
    await appendPureWsBotflowJsonl(path.join(args.realtimeDir, MARKOUT_FILE), markouts, 'eventId');
    await appendPureWsBotflowJsonl(path.join(args.realtimeDir, PAPER_FILE), paperTrades, 'paperTradeId');
  }
  if (args.telegram) await sendTelegramReport(report);

  console.log(
    `[pure-ws-botflow-report] tx=${txs.length} events=${events.length} ` +
    `candidates=${candidates.length} observed=${report.observedCandidates} ` +
    `paper=${report.paper.resolvedTrades}/${report.paper.trades} net=${report.paper.totalNetSol.toFixed(6)} md=${args.mdOut}`
  );
}

function applyProfile(args: Args, trackedAddressExplicit: boolean, feePayerFilterExplicit: boolean): void {
  const resolved = resolvePureWsBotflowProfile({
    botProfile: args.botProfile,
    trackedAddress: trackedAddressExplicit ? args.trackedAddress : undefined,
    feePayerFilter: feePayerFilterExplicit ? args.feePayerFilter : undefined,
  });
  args.trackedAddress = resolved.trackedAddress;
  args.feePayerFilter = resolved.feePayerFilter;
  args.walletRole = resolved.walletRole;
  args.provenanceConfidence = resolved.provenanceConfidence;
  args.mayhemAgentWallet = resolved.mayhemAgentWallet;
  args.mayhemProgramId = resolved.mayhemProgramId;
  args.profileNotes = resolved.notes;
}

function parseBotProfile(raw: string): PureWsBotflowBotProfile {
  if (raw === 'custom' || raw === 'gygj_legacy' || raw === 'mayhem_current') return raw;
  throw new Error(`invalid --bot-profile: ${raw}`);
}

function parsePositiveInt(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`invalid ${label}: ${raw}`);
  return parsed;
}

function parseNonNegativeNumber(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${label}: ${raw}`);
  return parsed;
}

function parseCsvNumbers(raw: string, label: string): number[] {
  const values = raw.split(',').map((part) => Number(part.trim())).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) throw new Error(`invalid ${label}: ${raw}`);
  return [...new Set(values)].sort((a, b) => a - b);
}

function parseCsvStrings(raw: string, label: string): string[] {
  const values = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`invalid ${label}: ${raw}`);
  return [...new Set(values)];
}

async function sendTelegramReport(report: BotflowReport): Promise<void> {
  try {
    const { Notifier } = await import('../src/notifier/notifier');
    const notifier = new Notifier(
      process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '',
      process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || ''
    );
    await notifier.sendInfo(renderPureWsBotflowTelegram(report), 'pure_ws_botflow_paper');
  } catch (err) {
    console.warn(`[pure-ws-botflow-report] WARN telegram send failed: ${String(err)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[pure-ws-botflow-report] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
