/* eslint-disable no-console */

/**
 * Cupsey Phase 0 Measurement Report
 *
 * Why: 배포 후 파라미터 동결 기간(Phase 0) 동안 데이터를 수집하고,
 * Phase 1 의사결정(score-outcome 상관, continuous sizing 도입 여부)에 필요한
 * 통계적 검증을 수행한다.
 *
 * 입력:
 *   1. cupsey-gate-log.jsonl — gate pass/reject 기록 (score, factors)
 *   2. DB trades — cupsey_flip_10s closed trades (PnL, exit reason, hold time)
 *
 * 출력:
 *   - Gate pass/reject 분포
 *   - Trade outcomes (WR, PnL, exit reason breakdown)
 *   - bootstrapMeanCI on PnL (기대값 신뢰구간)
 *   - STALK_TIMEOUT 비율 (목표: <50%)
 *   - Phase 1 readiness checklist
 *
 * Usage:
 *   npx ts-node scripts/analysis/cupsey-phase0-report.ts
 *   npx ts-node scripts/analysis/cupsey-phase0-report.ts --json
 */

import path from 'path';
import { readFile } from 'fs/promises';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { bootstrapMeanCI } from '../../src/backtest/statistics';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ─── Types ───

interface GateLogEntry {
  t: string;
  pair: string;
  sym?: string;
  price: number;
  pass: boolean;
  score: number;
  f: {
    volumeAccelRatio: number;
    priceChangePct: number;
    avgBuyRatio: number;
    tradeCountRatio: number;
  };
  reason: string | null;
}

interface TradeRow {
  id: string;
  pair_address: string;
  token_symbol: string | null;
  entry_price: string;
  exit_price: string | null;
  pnl: string | null;
  exit_reason: string | null;
  status: string;
  created_at: Date;
  closed_at: Date | null;
  high_water_mark: string | null;
}

// ─── Data Loading ───

async function loadGateLog(dataDir: string): Promise<GateLogEntry[]> {
  const logPath = path.join(dataDir, 'cupsey-gate-log.jsonl');
  try {
    const raw = await readFile(logPath, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

async function loadCupseyTrades(pool: Pool): Promise<TradeRow[]> {
  const { rows } = await pool.query<TradeRow>(
    `SELECT id, pair_address, token_symbol, entry_price, exit_price,
            pnl, exit_reason, status, created_at, closed_at, high_water_mark
     FROM trades
     WHERE strategy = $1 AND status = $2
     ORDER BY closed_at ASC`,
    ['cupsey_flip_10s', 'CLOSED']
  );
  return rows;
}

// ─── Analysis ───

function analyzeGateLog(entries: GateLogEntry[]) {
  const passed = entries.filter(e => e.pass);
  const rejected = entries.filter(e => !e.pass);

  const passScores = passed.map(e => e.score);
  const rejectReasons: Record<string, number> = {};
  for (const e of rejected) {
    const key = e.reason?.split('=')[0] ?? 'unknown';
    rejectReasons[key] = (rejectReasons[key] ?? 0) + 1;
  }

  return {
    total: entries.length,
    passed: passed.length,
    rejected: rejected.length,
    passRate: entries.length > 0 ? passed.length / entries.length : 0,
    passScoreStats: computePercentiles(passScores),
    rejectReasons,
    firstEntry: entries[0]?.t ?? null,
    lastEntry: entries[entries.length - 1]?.t ?? null,
  };
}

function analyzeTrades(trades: TradeRow[]) {
  const pnls = trades.map(t => Number(t.pnl ?? 0));
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const totalPnl = pnls.reduce((s, v) => s + v, 0);

  // Exit reason breakdown
  const exitReasons: Record<string, number> = {};
  for (const t of trades) {
    const reason = t.exit_reason ?? 'UNKNOWN';
    exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
  }

  // STALK success: non-STALK_TIMEOUT/STALK_CRASH trades = entries that reached PROBE
  const stalkTimeouts = trades.filter(t =>
    t.exit_reason === 'STALK_TIMEOUT' || t.exit_reason === 'STALK_CRASH'
  ).length;
  const probeEntries = trades.length - stalkTimeouts;

  // Hold time (only for trades that entered PROBE)
  const holdSecs = trades
    .filter(t => t.closed_at && t.created_at && t.exit_reason !== 'STALK_TIMEOUT' && t.exit_reason !== 'STALK_CRASH')
    .map(t => (new Date(t.closed_at!).getTime() - new Date(t.created_at).getTime()) / 1000);

  // MFE (from high_water_mark)
  const mfePcts = trades
    .filter(t => t.high_water_mark && t.entry_price && Number(t.entry_price) > 0)
    .map(t => (Number(t.high_water_mark!) - Number(t.entry_price)) / Number(t.entry_price));

  // Bootstrap CI on PnL
  const pnlCI = bootstrapMeanCI(pnls, { nResamples: 10_000, alpha: 0.05 });

  // Bootstrap CI on PnL of PROBE-entered trades only
  const probePnls = trades
    .filter(t => t.exit_reason !== 'STALK_TIMEOUT' && t.exit_reason !== 'STALK_CRASH')
    .map(t => Number(t.pnl ?? 0));
  const probePnlCI = bootstrapMeanCI(probePnls, { nResamples: 10_000, alpha: 0.05 });

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    totalPnl,
    avgPnl: trades.length > 0 ? totalPnl / trades.length : 0,
    pnlCI,
    probePnlCI,
    probeEntries,
    stalkTimeoutRate: trades.length > 0 ? stalkTimeouts / trades.length : 0,
    exitReasons,
    holdSecStats: computePercentiles(holdSecs),
    mfePctStats: computePercentiles(mfePcts.map(m => m * 100)),
    firstTrade: trades[0]?.created_at ?? null,
    lastTrade: trades[trades.length - 1]?.closed_at ?? null,
  };
}

// ─── Output ───

function printReport(gate: ReturnType<typeof analyzeGateLog>, trades: ReturnType<typeof analyzeTrades>) {
  const sep = '─'.repeat(55);

  console.log(`\n${'═'.repeat(55)}`);
  console.log('  Cupsey Phase 0 Measurement Report');
  console.log(`${'═'.repeat(55)}`);

  // Period
  const periodStart = gate.firstEntry || trades.firstTrade;
  const periodEnd = gate.lastEntry || trades.lastTrade;
  if (periodStart) {
    console.log(`Period: ${fmt(periodStart)} ~ ${fmt(periodEnd)}`);
  }

  // Gate Stats
  console.log(`\n${sep}`);
  console.log('GATE EVALUATION');
  console.log(sep);
  console.log(`Total signals: ${gate.total} | Pass: ${gate.passed} | Reject: ${gate.rejected} | Rate: ${pct(gate.passRate)}`);

  if (gate.passScoreStats.count > 0) {
    const s = gate.passScoreStats;
    console.log(`Pass scores: min=${s.min} p25=${s.p25} median=${s.median} p75=${s.p75} max=${s.max}`);
  }

  if (Object.keys(gate.rejectReasons).length > 0) {
    const reasons = Object.entries(gate.rejectReasons)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');
    console.log(`Reject reasons: ${reasons}`);
  }

  if (gate.total === 0) {
    console.log('⚠ No gate evaluations yet. Signal drought?');
  }

  // Trade Outcomes
  console.log(`\n${sep}`);
  console.log('TRADE OUTCOMES');
  console.log(sep);
  console.log(
    `Trades: ${trades.totalTrades} | W: ${trades.wins} L: ${trades.losses} | ` +
    `WR: ${pct(trades.winRate)} | PnL: ${sign(trades.totalPnl)} SOL`
  );
  console.log(
    `Avg PnL: ${sign(trades.avgPnl)} SOL | ` +
    `95% CI: [${sign(trades.pnlCI.lower)}, ${sign(trades.pnlCI.upper)}]`
  );

  if (trades.probeEntries > 0) {
    console.log(
      `PROBE-entered only: avg PnL ${sign(trades.probePnlCI.mean)} SOL | ` +
      `95% CI: [${sign(trades.probePnlCI.lower)}, ${sign(trades.probePnlCI.upper)}]`
    );
  }

  // Exit Reason Breakdown
  console.log(`\n${sep}`);
  console.log('EXIT REASONS');
  console.log(sep);
  const reasons = Object.entries(trades.exitReasons)
    .sort(([, a], [, b]) => b - a);
  for (const [reason, count] of reasons) {
    const ratio = trades.totalTrades > 0 ? count / trades.totalTrades : 0;
    const bar = '█'.repeat(Math.round(ratio * 30));
    console.log(`  ${reason.padEnd(22)} ${String(count).padStart(3)} (${pct(ratio).padStart(6)}) ${bar}`);
  }

  // STALK Success
  console.log(`\n${sep}`);
  console.log('STALK → PROBE SUCCESS');
  console.log(sep);
  console.log(
    `STALK timeout rate: ${pct(trades.stalkTimeoutRate)} (target: <50%) ` +
    `${trades.stalkTimeoutRate < 0.5 ? '✓' : '✗'}`
  );
  console.log(`PROBE entries: ${trades.probeEntries} / ${trades.totalTrades}`);

  // Hold Time & MFE
  if (trades.holdSecStats.count > 0) {
    const h = trades.holdSecStats;
    console.log(`Hold time: median=${h.median.toFixed(0)}s p75=${h.p75.toFixed(0)}s max=${h.max.toFixed(0)}s`);
  }
  if (trades.mfePctStats.count > 0) {
    const m = trades.mfePctStats;
    console.log(`MFE: median=${sign(m.median)}% p75=${sign(m.p75)}% max=${sign(m.max)}%`);
  }

  // Phase 1 Readiness
  console.log(`\n${sep}`);
  console.log('PHASE 1 READINESS');
  console.log(sep);

  const checks = [
    {
      label: '50 trades accumulated',
      status: trades.totalTrades >= 50,
      detail: `${trades.totalTrades}/50`,
    },
    {
      label: 'PnL CI lower > 0 (positive edge)',
      status: trades.pnlCI.lower > 0,
      detail: `CI: [${sign(trades.pnlCI.lower)}, ${sign(trades.pnlCI.upper)}]`,
    },
    {
      label: 'STALK_TIMEOUT < 50%',
      status: trades.stalkTimeoutRate < 0.5,
      detail: pct(trades.stalkTimeoutRate),
    },
    {
      label: 'Gate evaluations ≥ 30 (score analysis)',
      status: gate.total >= 30,
      detail: `${gate.total}/30`,
    },
    {
      label: 'Win Rate ≥ 40%',
      status: trades.winRate >= 0.4,
      detail: pct(trades.winRate),
    },
  ];

  for (const check of checks) {
    const icon = check.status ? '✓' : '○';
    console.log(`  [${icon}] ${check.label}: ${check.detail}`);
  }

  const passedChecks = checks.filter(c => c.status).length;
  console.log(`\n  ${passedChecks}/${checks.length} passed. ` +
    (passedChecks === checks.length
      ? 'Ready for Phase 1 (score-outcome correlation analysis).'
      : 'Continue Phase 0 data collection.')
  );

  console.log(`${'═'.repeat(55)}\n`);
}

// ─── Helpers ───

function computePercentiles(arr: number[]): {
  count: number; min: number; p25: number; median: number; p75: number; max: number; mean: number;
} {
  if (arr.length === 0) return { count: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0, mean: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    count: n,
    min: sorted[0],
    p25: sorted[Math.floor(n * 0.25)],
    median: sorted[Math.floor(n * 0.5)],
    p75: sorted[Math.floor(n * 0.75)],
    max: sorted[n - 1],
    mean: arr.reduce((s, v) => s + v, 0) / n,
  };
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function sign(val: number): string {
  return `${val >= 0 ? '+' : ''}${val.toFixed(6)}`;
}

function fmt(d: string | Date | null): string {
  if (!d) return 'N/A';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

// ─── Main ───

async function main() {
  const args = process.argv.slice(2);
  const dataDir = process.env.REALTIME_DATA_DIR || path.resolve(process.cwd(), 'data/realtime');

  // Load gate log (JSONL, no DB required)
  const gateEntries = await loadGateLog(dataDir);
  const gateAnalysis = analyzeGateLog(gateEntries);

  // Load trades from DB
  const databaseUrl = process.env.DATABASE_URL;
  let tradeAnalysis: ReturnType<typeof analyzeTrades>;

  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const trades = await loadCupseyTrades(pool);
      tradeAnalysis = analyzeTrades(trades);
    } finally {
      await pool.end();
    }
  } else {
    console.warn('DATABASE_URL not set. Trade analysis skipped.');
    tradeAnalysis = analyzeTrades([]);
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify({ gate: gateAnalysis, trades: tradeAnalysis }, null, 2));
    return;
  }

  printReport(gateAnalysis, tradeAnalysis);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
