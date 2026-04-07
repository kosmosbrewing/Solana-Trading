#!/usr/bin/env ts-node
/**
 * Realized vs Replay Edge Ratio
 *
 * Why: 2026-04-07 P3 — replay headline edge(+24.02% per-signal weighted adj)가
 * 실제 paper 모드 체결을 거치면 얼마나 보존되는지 측정한다. 핵심 질문은
 * "1 SOL → 100 SOL mission에 도달하기 위한 edge 부족분이 얼마나 큰가?".
 *
 * Inputs:
 *   - DB: PostgreSQL `trades` 테이블 (tx_signature='PAPER_TRADE', status='CLOSED')
 *   - jsonl: 각 세션의 realtime-signals.jsonl (replay-equivalent adj return horizon 포함)
 *
 * Output: 세션별 + 전체 ratio. realized_pnl_pct / predicted_adj_return_pct.
 *
 * Usage:
 *   npx ts-node scripts/analysis/realized-replay-ratio.ts \
 *     [--horizon 180] [--strategy bootstrap] [--session-glob '*-live'] \
 *     [--out docs/audits/realized-replay-ratio-2026-04-07.md]
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { RealtimeReplayStore } from '../../src/realtime/replayStore';
import type { RealtimeSignalRecord } from '../../src/reporting/realtimeMeasurement';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

interface PaperTradeRow {
  id: string;
  pair_address: string;
  strategy: string;
  entry_price: number;
  exit_price: number | null;
  pnl: number | null;
  closed_at: Date | null;
  created_at: Date;
  exit_reason: string | null;
  decision_price: number | null;
  entry_slippage_bps: number | null;
  exit_slippage_bps: number | null;
  round_trip_cost_pct: number | null;
}

interface MatchedTrade {
  tradeId: string;
  sessionId: string;
  pairAddress: string;
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  realizedPct: number;          // (exit - entry) / entry
  predictedAdjPct: number;      // signal.horizons[horizonSec].adjustedReturnPct
  predictedRawPct: number;      // signal.horizons[horizonSec].returnPct (no cost)
  ratio: number;                 // realizedPct / predictedAdjPct
  exitReason: string | null;
  decisionGapPct: number | null; // (entry - decision) / decision (entry slippage)
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const index = args.indexOf(flag);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
  };
  return {
    horizonSec: Number(get('--horizon', '180')),
    strategyFilter: get('--strategy', ''),
    sessionGlob: get('--session-glob', ''),
    outPath: get('--out', 'docs/audits/realized-replay-ratio-2026-04-07.md'),
    dryRun: args.includes('--dry-run'),
  };
}

function listSessionDirs(sessionGlob: string): string[] {
  const root = path.resolve(__dirname, '../../data/realtime/sessions');
  if (!fs.existsSync(root)) return [];
  const all = fs.readdirSync(root).filter((name) => name.endsWith('-live') || name.startsWith('legacy-'));
  if (!sessionGlob) return all.map((name) => path.join(root, name));
  // Why: 단순 substring 매칭. 대규모 glob 필요 시 별도 lib 도입.
  return all.filter((name) => name.includes(sessionGlob)).map((name) => path.join(root, name));
}

async function loadSignalsFromSessions(sessionDirs: string[]): Promise<Array<{ sessionId: string; record: RealtimeSignalRecord }>> {
  const out: Array<{ sessionId: string; record: RealtimeSignalRecord }> = [];
  for (const dir of sessionDirs) {
    const sessionId = path.basename(dir);
    const store = new RealtimeReplayStore(dir);
    try {
      const records = await store.loadSignals();
      for (const record of records) out.push({ sessionId, record });
    } catch (error) {
      console.warn(`skip ${sessionId}: ${(error as Error).message}`);
    }
  }
  return out;
}

async function detectExistingColumns(pool: Pool, candidates: string[]): Promise<Set<string>> {
  // Why: 일부 DB는 cost-decomposition 컬럼 (decision_price, *_slippage_bps 등) 없는 구버전 스키마.
  // 컬럼 부재 시 SQL 실패 대신 graceful degrade.
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'trades' AND column_name = ANY($1)`,
    [candidates]
  );
  return new Set<string>(result.rows.map((row) => row.column_name as string));
}

async function loadPaperTrades(pool: Pool, strategyFilter: string): Promise<PaperTradeRow[]> {
  const params: unknown[] = [];
  let strategyClause = '';
  if (strategyFilter) {
    params.push(`%${strategyFilter}%`);
    strategyClause = `AND strategy ILIKE $${params.length}`;
  }
  const optional = ['decision_price', 'entry_slippage_bps', 'exit_slippage_bps', 'round_trip_cost_pct'];
  const present = await detectExistingColumns(pool, optional);
  const optionalSelect = optional
    .map((column) => (present.has(column) ? column : `NULL::numeric AS ${column}`))
    .join(', ');
  const result = await pool.query(
    `
      SELECT id, pair_address, strategy, entry_price, exit_price, pnl, closed_at, created_at,
             exit_reason, ${optionalSelect}
      FROM trades
      WHERE status = 'CLOSED' AND tx_signature = 'PAPER_TRADE' ${strategyClause}
      ORDER BY closed_at ASC NULLS LAST
    `,
    params
  );
  return result.rows.map((row) => ({
    id: row.id,
    pair_address: row.pair_address,
    strategy: row.strategy,
    entry_price: Number(row.entry_price),
    exit_price: row.exit_price !== null ? Number(row.exit_price) : null,
    pnl: row.pnl !== null ? Number(row.pnl) : null,
    closed_at: row.closed_at ? new Date(row.closed_at) : null,
    created_at: new Date(row.created_at),
    exit_reason: row.exit_reason,
    decision_price: row.decision_price !== null ? Number(row.decision_price) : null,
    entry_slippage_bps: row.entry_slippage_bps !== null ? Number(row.entry_slippage_bps) : null,
    exit_slippage_bps: row.exit_slippage_bps !== null ? Number(row.exit_slippage_bps) : null,
    round_trip_cost_pct: row.round_trip_cost_pct !== null ? Number(row.round_trip_cost_pct) : null,
  }));
}

function joinTradesToSignals(
  trades: PaperTradeRow[],
  signals: Array<{ sessionId: string; record: RealtimeSignalRecord }>,
  horizonSec: number
): MatchedTrade[] {
  // Why: signal.processing.tradeId가 1차 join key. fallback으로 (pair, time window) 사용 가능하나
  // 1차 구현은 tradeId 기반만. mismatch는 unmatched 카운트로 보고.
  const signalByTradeId = new Map<string, { sessionId: string; record: RealtimeSignalRecord }>();
  for (const item of signals) {
    const tradeId = item.record.processing?.tradeId;
    if (tradeId) signalByTradeId.set(tradeId, item);
  }

  const matched: MatchedTrade[] = [];
  for (const trade of trades) {
    if (trade.exit_price === null) continue;
    const signalMatch = signalByTradeId.get(trade.id);
    if (!signalMatch) continue;
    const horizon = signalMatch.record.horizons.find((item) => item.horizonSec === horizonSec);
    if (!horizon) continue;

    const realizedPct = ((trade.exit_price - trade.entry_price) / trade.entry_price) * 100;
    const predictedAdjPct = horizon.adjustedReturnPct;
    const predictedRawPct = horizon.returnPct;
    const ratio = predictedAdjPct !== 0 ? realizedPct / predictedAdjPct : NaN;
    const decisionGapPct =
      trade.decision_price && trade.decision_price > 0
        ? ((trade.entry_price - trade.decision_price) / trade.decision_price) * 100
        : null;

    matched.push({
      tradeId: trade.id,
      sessionId: signalMatch.sessionId,
      pairAddress: trade.pair_address,
      strategy: trade.strategy,
      entryPrice: trade.entry_price,
      exitPrice: trade.exit_price,
      realizedPct,
      predictedAdjPct,
      predictedRawPct,
      ratio,
      exitReason: trade.exit_reason,
      decisionGapPct,
    });
  }
  return matched;
}

function fmt(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function aggregate(matched: MatchedTrade[]) {
  if (matched.length === 0) {
    return {
      n: 0,
      avgRealized: 0,
      avgPredictedAdj: 0,
      avgPredictedRaw: 0,
      avgRatio: 0,
      medianRatio: 0,
      ratioRealizedTotal: 0,
      winRate: 0,
    };
  }
  const n = matched.length;
  const sumRealized = matched.reduce((sum, item) => sum + item.realizedPct, 0);
  const sumPredAdj = matched.reduce((sum, item) => sum + item.predictedAdjPct, 0);
  const sumPredRaw = matched.reduce((sum, item) => sum + item.predictedRawPct, 0);
  const finiteRatios = matched.map((item) => item.ratio).filter((ratio) => Number.isFinite(ratio));
  const avgRatio = finiteRatios.length > 0 ? finiteRatios.reduce((sum, ratio) => sum + ratio, 0) / finiteRatios.length : 0;
  const sortedRatios = [...finiteRatios].sort((left, right) => left - right);
  const medianRatio = sortedRatios.length > 0 ? sortedRatios[Math.floor(sortedRatios.length / 2)] : 0;
  // Aggregated ratio = sum of realized / sum of predicted (signal-weighted-equivalent at trade level)
  const ratioRealizedTotal = sumPredAdj !== 0 ? sumRealized / sumPredAdj : NaN;
  const winRate = matched.filter((item) => item.realizedPct > 0).length / n;
  return {
    n,
    avgRealized: sumRealized / n,
    avgPredictedAdj: sumPredAdj / n,
    avgPredictedRaw: sumPredRaw / n,
    avgRatio,
    medianRatio,
    ratioRealizedTotal,
    winRate,
  };
}

async function main() {
  const args = parseArgs();
  console.log(`Horizon: ${args.horizonSec}s | Strategy filter: ${args.strategyFilter || '(all)'} | Session glob: ${args.sessionGlob || '(all)'}`);

  const sessionDirs = listSessionDirs(args.sessionGlob);
  console.log(`Sessions: ${sessionDirs.length}`);
  const signalEntries = await loadSignalsFromSessions(sessionDirs);
  console.log(`Loaded ${signalEntries.length} signal records`);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set. Cannot load paper trades.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  let trades: PaperTradeRow[] = [];
  try {
    trades = await loadPaperTrades(pool, args.strategyFilter);
  } finally {
    await pool.end();
  }
  console.log(`Loaded ${trades.length} closed paper trades`);

  const matched = joinTradesToSignals(trades, signalEntries, args.horizonSec);
  console.log(`Matched ${matched.length}/${trades.length} trades to signals`);

  const overall = aggregate(matched);
  const bySessionMap = new Map<string, MatchedTrade[]>();
  for (const item of matched) {
    if (!bySessionMap.has(item.sessionId)) bySessionMap.set(item.sessionId, []);
    bySessionMap.get(item.sessionId)!.push(item);
  }

  const lines: string[] = [];
  lines.push(`# Realized vs Replay Edge Ratio — 2026-04-07`);
  lines.push('');
  lines.push(`> Horizon: ${args.horizonSec}s | Strategy filter: \`${args.strategyFilter || 'all'}\``);
  lines.push(`> Sessions scanned: ${sessionDirs.length} | Signal records: ${signalEntries.length}`);
  lines.push(`> Closed paper trades: ${trades.length} | Matched to signals: ${matched.length}`);
  lines.push('');
  lines.push('## What this measures');
  lines.push('');
  lines.push(`- **Realized %** = (exit_price − entry_price) / entry_price × 100 (paper fill price 기반)`);
  lines.push(`- **Predicted adj %** = signal.horizons[${args.horizonSec}s].adjustedReturnPct (replay 헤드라인과 동일 metric)`);
  lines.push(`- **Ratio** = realized / predicted_adj (1.0 = replay 그대로 실현, 0.0 = 완전 손실)`);
  lines.push(`- 이상치 수렴을 위해 \`ratioRealizedTotal\` = Σ realized / Σ predicted_adj 도 함께 보고`);
  lines.push('');

  lines.push('## Overall');
  lines.push('');
  if (overall.n === 0) {
    lines.push('No matched trades. Run paper mode to accumulate signals + trades, then re-run this script.');
    lines.push('');
  } else {
    lines.push(`- Matched trades: **${overall.n}**`);
    lines.push(`- Avg realized: **${fmt(overall.avgRealized)}%**`);
    lines.push(`- Avg predicted adj (replay): **${fmt(overall.avgPredictedAdj)}%**`);
    lines.push(`- Avg predicted raw (no cost): ${fmt(overall.avgPredictedRaw)}%`);
    lines.push(`- Mean of per-trade ratios: **${fmt(overall.avgRatio)}**`);
    lines.push(`- Median per-trade ratio: ${fmt(overall.medianRatio)}`);
    lines.push(`- Sum-based ratio (Σ realized / Σ predicted_adj): **${fmt(overall.ratioRealizedTotal)}**`);
    lines.push(`- Win rate: ${fmt(overall.winRate * 100, 1)}%`);
    lines.push('');
  }

  lines.push('## Per-session');
  lines.push('');
  if (bySessionMap.size === 0) {
    lines.push('(no session breakdown — no matched trades)');
  } else {
    lines.push('| Session | n | Avg Realized | Avg Predicted Adj | Sum Ratio | Avg Ratio |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const [sessionId, items] of [...bySessionMap.entries()].sort()) {
      const agg = aggregate(items);
      lines.push(`| ${sessionId} | ${agg.n} | ${fmt(agg.avgRealized)}% | ${fmt(agg.avgPredictedAdj)}% | ${fmt(agg.ratioRealizedTotal)} | ${fmt(agg.avgRatio)} |`);
    }
  }
  lines.push('');

  lines.push('## Per-trade detail');
  lines.push('');
  if (matched.length === 0) {
    lines.push('(none)');
  } else {
    lines.push('| Trade ID (8) | Session | Pair (8) | Realized | Predicted Adj | Ratio | Decision Gap | Exit Reason |');
    lines.push('|---|---|---|---:|---:|---:|---:|---|');
    for (const item of matched) {
      lines.push(
        `| ${item.tradeId.slice(0, 8)} | ${item.sessionId.slice(0, 16)} | ${item.pairAddress.slice(0, 8)} | ${fmt(item.realizedPct)}% | ${fmt(item.predictedAdjPct)}% | ${fmt(item.ratio)} | ${fmt(item.decisionGapPct)}% | ${item.exitReason ?? '—'} |`
      );
    }
  }
  lines.push('');

  lines.push('## Interpretation guide');
  lines.push('');
  lines.push('| Sum Ratio | Verdict | Mission Implication |');
  lines.push('|---:|---|---|');
  lines.push('| ≥ 0.8 | execution layer가 replay edge를 거의 보존 | replay 예측을 mission math에 사실상 그대로 사용 가능 |');
  lines.push('| 0.5 – 0.8 | 30-50% 손실 (slippage / timing) | edge 낙폭 반영 후 mission horizon 1.5-2x 연장 |');
  lines.push('| 0.2 – 0.5 | 절반 이상 손실, slippage 또는 SL 오작동 의심 | 실행 layer 개선 없이는 mission 도달 가능성 낮음 |');
  lines.push('| < 0.2 | edge 사실상 전무 | 전략 또는 execution path 재검토 필수 |');
  lines.push('| < 0 | 음수 — replay 양수가 실현 음수로 뒤집힘 | sample contamination 또는 chronic adverse selection |');
  lines.push('');
  lines.push('### Notes');
  lines.push('- Match rate는 (matched / total trades). 낮으면 signal-trade tradeId 누락 또는 sessions/시기 불일치.');
  lines.push('- Decision gap = paper에서 발생한 entry slippage (decision_price → fill price).');
  lines.push('- 표본 < 20이면 ratio는 reference만. 20 trades 누적 후 P3 verdict 확정.');

  const outAbs = path.resolve(args.outPath);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, lines.join('\n'));
  console.log(`Saved: ${outAbs}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
