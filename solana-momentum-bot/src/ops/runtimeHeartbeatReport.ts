import fs from 'fs/promises';
import path from 'path';
import bs58 from 'bs58';
import { Pool } from 'pg';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TradeStore } from '../candle';
import {
  HEARTBEAT_WINDOW_HOURS,
  buildHeartbeatPerformanceSummary,
  buildHeartbeatRegimeSummary,
  buildHeartbeatTradingSummary,
} from '../reporting/heartbeatSummary';
import { PaperMetricsSummary } from '../reporting/paperMetrics';
import { buildSparseOpsSummaryMessage, loadSparseOpsSummary } from '../reporting/sparseOpsSummary';
import { RegimeState } from '../risk/regimeFilter';
import { config, TradingMode } from '../utils/config';
import { Trade } from '../utils/types';
import { Pm2Service } from './pm2Service';

interface SessionPointer {
  tradingMode?: TradingMode;
}

interface RuntimeHeartbeatDeps {
  pool: Pool;
  pm2Service: Pm2Service;
  tradeStore: TradeStore;
  connection: Connection;
  wallet: Keypair;
}

const SESSION_POINTER_PATH = path.join(config.realtimeDataDir, 'current-session.json');
const REGIME_LOG_PATTERN = /Regime: (\w+) \(size=([0-9.]+)x\) SOL=(bull|bear) breadth=([0-9.]+)% follow=([0-9.]+)%/;

export function createRuntimeHeartbeatDeps(): RuntimeHeartbeatDeps {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const tradeStore = new TradeStore(pool);

  return {
    pool,
    pm2Service: new Pm2Service(),
    tradeStore,
    connection: new Connection(config.solanaRpcUrl, 'confirmed'),
    wallet: Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey)),
  };
}

export async function closeRuntimeHeartbeatDeps(deps: RuntimeHeartbeatDeps): Promise<void> {
  await deps.pool.end();
}

export async function buildRuntimeHeartbeatReport(deps: RuntimeHeartbeatDeps): Promise<string> {
  const tradingMode = await resolveRuntimeTradingMode();
  const [openTrades, recentTrades, recentClosedTrades, allClosedTrades, pnl, regimeSummary] = await Promise.all([
    deps.tradeStore.getOpenTrades(),
    deps.tradeStore.getTradesCreatedWithinHours(HEARTBEAT_WINDOW_HOURS),
    deps.tradeStore.getClosedTradesWithinHours(HEARTBEAT_WINDOW_HOURS),
    deps.tradeStore.getClosedTradesChronological(),
    deps.tradeStore.getClosedPnlWithinHours(HEARTBEAT_WINDOW_HOURS),
    loadLatestRegimeSummary(deps.pm2Service),
  ]);
  const balanceSol = tradingMode === 'paper'
    ? computePaperCashBalance(config.paperInitialBalance, openTrades, allClosedTrades)
    : await getLiveBalance(deps);

  const lines = [
    buildHeartbeatTradingSummary({
      tradingMode,
      windowHours: HEARTBEAT_WINDOW_HOURS,
      balanceSol,
      pnl,
      enteredTrades: recentTrades.length,
      closedTrades: recentClosedTrades.length,
      openTrades: openTrades.length,
    }),
  ];

  const performanceSummary = buildHeartbeatPerformanceSummary(
    summarizeClosedTrades(recentClosedTrades)
  );
  if (performanceSummary) {
    lines.push(performanceSummary);
  }

  const sparseSummary = buildSparseOpsSummaryMessage(
    loadSparseOpsSummary(config.realtimeDataDir, HEARTBEAT_WINDOW_HOURS, 3)
  );
  if (sparseSummary) {
    lines.push(sparseSummary);
  }

  if (regimeSummary) {
    lines.push(regimeSummary);
  }

  return lines.join('\n\n');
}

export function summarizeClosedTrades(trades: Trade[]): PaperMetricsSummary {
  const wins = trades.filter((trade) => (trade.pnl ?? 0) > 0).length;
  const losses = trades.length - wins;
  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    avgMaePct: Number.NaN,
    avgMfePct: Number.NaN,
    falsePositiveRate: trades.length > 0
      ? trades.filter((trade) => trade.exitReason === 'STOP_LOSS').length / trades.length
      : 0,
    avgPriceImpactPct: 0,
    avgQuoteDecayPct: 0,
    avgTimeToFillMs: 0,
    tradesByRegime: {},
    tradesBySource: {},
    tp1HitRate: trades.length > 0
      ? trades.filter((trade) => (
        trade.exitReason === 'TAKE_PROFIT_1' || trade.exitReason === 'TAKE_PROFIT_2'
      )).length / trades.length
      : 0,
  };
}

export function computePaperCashBalance(
  initialBalance: number,
  openTrades: Trade[],
  closedTrades: Trade[]
): number {
  const realizedPnl = closedTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);
  const reservedNotional = openTrades.reduce(
    (sum, trade) => sum + Math.max(0, trade.entryPrice) * Math.max(0, trade.quantity),
    0
  );
  return Math.max(0, initialBalance + realizedPnl - reservedNotional);
}

export function parseLatestRegimeState(logText: string): RegimeState | undefined {
  const lines = logText.split('\n').reverse();
  for (const line of lines) {
    const match = line.match(REGIME_LOG_PATTERN);
    if (!match) continue;

    const [, regime, sizeMultiplier, solTrend, breadthPct, followThroughPct] = match;
    if (regime !== 'risk_on' && regime !== 'risk_off' && regime !== 'neutral') {
      continue;
    }

    return {
      regime,
      sizeMultiplier: Number(sizeMultiplier),
      solTrendBullish: solTrend === 'bull',
      breadthPct: Number(breadthPct) / 100,
      followThroughPct: Number(followThroughPct) / 100,
      updatedAt: new Date(),
    };
  }

  return undefined;
}

async function getLiveBalance(deps: RuntimeHeartbeatDeps): Promise<number> {
  const lamports = await deps.connection.getBalance(deps.wallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

async function resolveRuntimeTradingMode(): Promise<TradingMode> {
  try {
    const raw = await fs.readFile(SESSION_POINTER_PATH, 'utf8');
    const parsed = JSON.parse(raw) as SessionPointer;
    if (parsed.tradingMode === 'paper' || parsed.tradingMode === 'live') {
      return parsed.tradingMode;
    }
  } catch {
    // Ignore and fall back to configured mode.
  }

  return config.tradingMode;
}

async function loadLatestRegimeSummary(pm2Service: Pm2Service): Promise<string | undefined> {
  try {
    const logs = await pm2Service.readLogs('momentum-bot', 200);
    const regimeState = parseLatestRegimeState(logs);
    return regimeState ? buildHeartbeatRegimeSummary(regimeState) : undefined;
  } catch {
    return undefined;
  }
}
