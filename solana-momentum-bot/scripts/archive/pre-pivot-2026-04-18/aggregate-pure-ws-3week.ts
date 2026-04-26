/* eslint-disable no-console */
/**
 * Aggregate pure-ws-backtest 3-week per-session JSON → summary report.
 *
 * Output:
 *   results/3week-backtest-2026-04-23/pure-ws-summary.json
 *   results/3week-backtest-2026-04-23/pure-ws-summary.md
 */
import { readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

interface PureWsSummary {
  totalSignals?: number;
  gateRejects?: number;
  gatePassRate?: number;
  entries?: number;
  probeHardCuts?: number;
  probeRejectTimeouts?: number;
  probeFlatCuts?: number;
  probeTrails?: number;
  t1Visits?: number;
  t2Visits?: number;
  t3Visits?: number;
  t1TrailExits?: number;
  t2TrailExits?: number;
  t3TrailExits?: number;
  winRate?: number;
  avgNetPnlPct?: number;
  totalNetPnlPct?: number;
  avgHoldSec?: number;
  avgMfePct?: number;
  avgMaePct?: number;
  maxMfePct?: number;
  maxNetPnlPct?: number;
  winners2xNet?: number;
  winners5xNet?: number;
  winners10xNet?: number;
  exitReasonBreakdown?: Record<string, number>;
  closeStateBreakdown?: Record<string, number>;
  maxConcurrentUsed?: number;
}

interface Trade {
  pairAddress?: string;
  entryPrice?: number;
  exitPrice?: number;
  mfePct?: number;
  maePct?: number;
  netPnlPct?: number;
  exitReason?: string;
  holdSec?: number;
  t1VisitAtSec?: number | null;
  t2VisitAtSec?: number | null;
  t3VisitAtSec?: number | null;
  closeState?: string;
}

interface SessionFile {
  id: string;
  dataset?: { candleCount?: number; keptCandleCount?: number };
  summary?: PureWsSummary;
  trades?: Trade[];
}

async function main() {
  const dir = path.resolve('results/3week-backtest-2026-04-23/pure-ws');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));

  const rows: SessionFile[] = [];
  for (const f of files) {
    const raw = await readFile(path.join(dir, f), 'utf8');
    const firstBrace = raw.indexOf('{');
    const jsonText = firstBrace >= 0 ? raw.slice(firstBrace) : raw;
    try {
      const j = JSON.parse(jsonText) as SessionFile;
      j.id = f.replace('.json', '');
      rows.push(j);
    } catch {
      console.warn(`[skip] cannot parse ${f}`);
    }
  }

  const allTrades: Trade[] = [];
  for (const r of rows) {
    if (r.trades) allTrades.push(...r.trades);
  }

  const agg = {
    sessions: rows.length,
    sessionsWithTrades: rows.filter((r) => (r.summary?.entries ?? 0) > 0).length,
    totalCandles: rows.reduce((s, r) => s + (r.dataset?.candleCount ?? 0), 0),
    keptCandles: rows.reduce((s, r) => s + (r.dataset?.keptCandleCount ?? 0), 0),
    totalSignals: rows.reduce((s, r) => s + (r.summary?.totalSignals ?? 0), 0),
    gateRejects: rows.reduce((s, r) => s + (r.summary?.gateRejects ?? 0), 0),
    entries: rows.reduce((s, r) => s + (r.summary?.entries ?? 0), 0),
    t1Visits: rows.reduce((s, r) => s + (r.summary?.t1Visits ?? 0), 0),
    t2Visits: rows.reduce((s, r) => s + (r.summary?.t2Visits ?? 0), 0),
    t3Visits: rows.reduce((s, r) => s + (r.summary?.t3Visits ?? 0), 0),
    winners2xNet: rows.reduce((s, r) => s + (r.summary?.winners2xNet ?? 0), 0),
    winners5xNet: rows.reduce((s, r) => s + (r.summary?.winners5xNet ?? 0), 0),
    winners10xNet: rows.reduce((s, r) => s + (r.summary?.winners10xNet ?? 0), 0),
    probeHardCuts: rows.reduce((s, r) => s + (r.summary?.probeHardCuts ?? 0), 0),
    probeRejectTimeouts: rows.reduce((s, r) => s + (r.summary?.probeRejectTimeouts ?? 0), 0),
    probeFlatCuts: rows.reduce((s, r) => s + (r.summary?.probeFlatCuts ?? 0), 0),
    probeTrails: rows.reduce((s, r) => s + (r.summary?.probeTrails ?? 0), 0),
    t1TrailExits: rows.reduce((s, r) => s + (r.summary?.t1TrailExits ?? 0), 0),
    t2TrailExits: rows.reduce((s, r) => s + (r.summary?.t2TrailExits ?? 0), 0),
    t3TrailExits: rows.reduce((s, r) => s + (r.summary?.t3TrailExits ?? 0), 0),
    exitReasonBreakdown: {} as Record<string, number>,
    closeStateBreakdown: {} as Record<string, number>,
  };

  for (const r of rows) {
    for (const [k, v] of Object.entries(r.summary?.exitReasonBreakdown ?? {})) {
      agg.exitReasonBreakdown[k] = (agg.exitReasonBreakdown[k] ?? 0) + (v as number);
    }
    for (const [k, v] of Object.entries(r.summary?.closeStateBreakdown ?? {})) {
      agg.closeStateBreakdown[k] = (agg.closeStateBreakdown[k] ?? 0) + (v as number);
    }
  }

  // Trade-level aggregates (from --include-trades)
  const wins = allTrades.filter((t) => (t.netPnlPct ?? 0) > 0).length;
  const sumNet = allTrades.reduce((s, t) => s + (t.netPnlPct ?? 0), 0);
  const sumMfe = allTrades.reduce((s, t) => s + (t.mfePct ?? 0), 0);
  const sumMae = allTrades.reduce((s, t) => s + (t.maePct ?? 0), 0);
  const sumHold = allTrades.reduce((s, t) => s + (t.holdSec ?? 0), 0);
  const maxMfe = allTrades.reduce((m, t) => Math.max(m, t.mfePct ?? 0), 0);
  const maxNet = allTrades.reduce((m, t) => Math.max(m, t.netPnlPct ?? 0), -Infinity);
  const n = allTrades.length;

  // Top winners by MFE and net
  const topByMfe = [...allTrades].sort((a, b) => (b.mfePct ?? 0) - (a.mfePct ?? 0)).slice(0, 10);
  const topByNet = [...allTrades].sort((a, b) => (b.netPnlPct ?? 0) - (a.netPnlPct ?? 0)).slice(0, 10);

  const winRate = n > 0 ? wins / n : 0;
  const avgNet = n > 0 ? sumNet / n : 0;
  const avgMfe = n > 0 ? sumMfe / n : 0;
  const avgMae = n > 0 ? sumMae / n : 0;
  const avgHold = n > 0 ? sumHold / n : 0;

  const outJson = {
    generatedAt: new Date().toISOString(),
    aggregateFromTrades: n,
    ...agg,
    winRate,
    avgNetPnlPct: avgNet,
    totalNetPnlPct: sumNet,
    avgMfePct: avgMfe,
    avgMaePct: avgMae,
    avgHoldSec: avgHold,
    maxMfePct: maxMfe,
    maxNetPnlPct: maxNet === -Infinity ? 0 : maxNet,
    topByMfe,
    topByNet,
  };

  const outPath = path.resolve('results/3week-backtest-2026-04-23/pure-ws-summary.json');
  await writeFile(outPath, JSON.stringify(outJson, null, 2));
  console.log(`[aggregate] wrote ${outPath}`);

  const md = [
    `# Pure WS Breakout 3-Week Replay Summary (2026-04-23)`,
    ``,
    `> Generated: ${outJson.generatedAt}`,
    `> Input: ${agg.sessions} session JSONs from \`results/3week-backtest-2026-04-23/pure-ws/\``,
    `> Engine: \`src/backtest/pureWsReplayEngine.ts\` + \`pureWsStateMachine.ts\``,
    `> Signal source: bootstrap_10s (VolumeMcapSpikeTrigger). Gate: pure_ws relaxed (vol_accel ≥ 1.0, buy_ratio ≥ 0.45, trade_count ≥ 0.8, price_chg ≥ -0.5%).`,
    `> **Entry-price idealization**: signal price = entry price (entryDriftGuard / Jupiter slippage 제외). 결과는 upper bound.`,
    ``,
    `## Coverage`,
    ``,
    `| 항목 | 값 |`,
    `|---|---:|`,
    `| Sessions processed | ${agg.sessions} |`,
    `| Sessions with ≥1 trade | ${agg.sessionsWithTrades} |`,
    `| Total candles | ${agg.totalCandles.toLocaleString()} |`,
    `| Kept candles | ${agg.keptCandles.toLocaleString()} |`,
    `| Total signals | ${agg.totalSignals.toLocaleString()} |`,
    `| Gate rejects | ${agg.gateRejects.toLocaleString()} |`,
    `| Entries (total trades) | ${agg.entries.toLocaleString()} |`,
    ``,
    `## Tier Visit Distribution`,
    ``,
    `> MFE peak 기반 — net return 이 아니라 "한 번이라도 해당 tier 에 진입한 position 수"`,
    ``,
    `| Tier | Visits | % of entries |`,
    `|---|---:|---:|`,
    `| T1 (+100% MFE) | ${agg.t1Visits} | ${((agg.t1Visits / Math.max(1, agg.entries)) * 100).toFixed(2)}% |`,
    `| T2 (+400% MFE) | ${agg.t2Visits} | ${((agg.t2Visits / Math.max(1, agg.entries)) * 100).toFixed(2)}% |`,
    `| T3 (+900% MFE) | ${agg.t3Visits} | ${((agg.t3Visits / Math.max(1, agg.entries)) * 100).toFixed(2)}% |`,
    ``,
    `## Trade Performance (trade-level, --include-trades)`,
    ``,
    `| 항목 | 값 |`,
    `|---|---:|`,
    `| Total closed trades | ${n.toLocaleString()} |`,
    `| Win rate (net > 0) | ${(winRate * 100).toFixed(1)}% |`,
    `| Sum net PnL% | ${(sumNet * 100).toFixed(2)}% |`,
    `| Avg net PnL% | ${(avgNet * 100).toFixed(3)}% |`,
    `| Avg MFE% | ${(avgMfe * 100).toFixed(2)}% |`,
    `| Avg MAE% | ${(avgMae * 100).toFixed(2)}% |`,
    `| Avg hold | ${avgHold.toFixed(0)}s |`,
    `| **MAX MFE%** | **${(maxMfe * 100).toFixed(1)}%** |`,
    `| **MAX net%** | **${((maxNet === -Infinity ? 0 : maxNet) * 100).toFixed(1)}%** |`,
    `| **Winners 2x+** (net ≥ +100%) | **${agg.winners2xNet}** |`,
    `| **Winners 5x+** (net ≥ +400%) | **${agg.winners5xNet}** |`,
    `| **Winners 10x+** (net ≥ +900%) | **${agg.winners10xNet}** |`,
    ``,
    `## Exit Reason Breakdown`,
    ``,
    `| Reason | Count | % of entries |`,
    `|---|---:|---:|`,
    ...Object.entries(agg.exitReasonBreakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `| ${k} | ${v} | ${((v / Math.max(1, agg.entries)) * 100).toFixed(1)}% |`),
    ``,
    `## Close State Breakdown (tier reached at close)`,
    ``,
    `| State | Count | % of entries |`,
    `|---|---:|---:|`,
    ...Object.entries(agg.closeStateBreakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `| ${k} | ${v} | ${((v / Math.max(1, agg.entries)) * 100).toFixed(1)}% |`),
    ``,
    `## Top 10 Trades by MFE`,
    ``,
    `| # | pair | MFE% | Net% | hold s | exitReason | T1 | T2 | T3 |`,
    `|---|---|---:|---:|---:|---|:-:|:-:|:-:|`,
    ...topByMfe.map(
      (t, i) =>
        `| ${i + 1} | ${(t.pairAddress ?? '').slice(0, 10)} | ${((t.mfePct ?? 0) * 100).toFixed(1)}% | ${((t.netPnlPct ?? 0) * 100).toFixed(1)}% | ${t.holdSec ?? 0} | ${t.exitReason ?? ''} | ${t.t1VisitAtSec ? '✓' : ''} | ${t.t2VisitAtSec ? '✓' : ''} | ${t.t3VisitAtSec ? '✓' : ''} |`
    ),
    ``,
    `## Top 10 Trades by Net`,
    ``,
    `| # | pair | Net% | MFE% | hold s | exitReason | T1 | T2 | T3 |`,
    `|---|---|---:|---:|---:|---|:-:|:-:|:-:|`,
    ...topByNet.map(
      (t, i) =>
        `| ${i + 1} | ${(t.pairAddress ?? '').slice(0, 10)} | ${((t.netPnlPct ?? 0) * 100).toFixed(1)}% | ${((t.mfePct ?? 0) * 100).toFixed(1)}% | ${t.holdSec ?? 0} | ${t.exitReason ?? ''} | ${t.t1VisitAtSec ? '✓' : ''} | ${t.t2VisitAtSec ? '✓' : ''} | ${t.t3VisitAtSec ? '✓' : ''} |`
    ),
    ``,
    `## Interpretation`,
    ``,
    `- **pure_ws_breakout 3주 candle replay 결과**. 현재 runtime 파라미터 (PROBE 30s / hardcut -3% / T1 +100% / T2 +400% / T3 +900%) + pure_ws 완화 gate.`,
    `- Entry-price idealization 으로 결과는 실운영보다 낙관적. live 에서는 entryDriftGuard + slippage 로 실효 진입률 ↓.`,
    `- **핵심 판단**: T1/T2/T3 visit 수가 사명 적합성 판정 기준. T2+ visit 0 건이면 현 파라미터로 tail 포획 불가.`,
    ``,
  ].join('\n');

  const mdPath = path.resolve('results/3week-backtest-2026-04-23/pure-ws-summary.md');
  await writeFile(mdPath, md);
  console.log(`[aggregate] wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
