/* eslint-disable no-console */
/**
 * Aggregate cupsey-backtest 3-week per-session JSON outputs → summary report.
 *
 * Why: LANE_20260422 §8 Path B 선행 평가. 3주 전체에 대해 cupsey benchmark 가
 *      실제 session 풀에서 어느 정도 signal / STALK / WINNER / 5x+ 를 만들어내는지
 *      기록. Path B (pure_ws replay engine) 구현 여부 판단의 비교 baseline.
 *
 * Input: `results/3week-backtest-2026-04-23/cupsey/*.json` — cupsey-backtest.ts --json 출력.
 * Output:
 *   results/3week-backtest-2026-04-23/cupsey-summary.json
 *   results/3week-backtest-2026-04-23/cupsey-summary.md
 */
import { readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

interface SessionSummary {
  totalSignals?: number;
  stalkEntries?: number;
  stalkSkips?: number;
  stalkSuccessRate?: number;
  probeWinners?: number;
  probeRejects?: number;
  probeToWinnerRate?: number;
  winRate?: number;
  avgNetPnlPct?: number;
  totalNetPnlPct?: number;
  avgHoldSec?: number;
  avgMfePct?: number;
  avgMaePct?: number;
  exitReasonBreakdown?: Record<string, number>;
  maxConcurrentUsed?: number;
  gateRejects?: number;
  gatePassRate?: number;
  bootstrapStats?: unknown;
}

interface SessionFile {
  id: string;
  datasetDir?: string;
  dataset?: { candleCount?: number; keptCandleCount?: number };
  totalCandles?: number;
  triggerType?: string;
  summary?: SessionSummary;
  trades?: Array<{
    entryTimeSec?: number;
    exitTimeSec?: number;
    entryPrice?: number;
    exitPrice?: number;
    mfePct?: number;
    maePct?: number;
    netPnlPct?: number;
    exitReason?: string;
    holdSec?: number;
  }>;
}

async function main() {
  const dir = path.resolve('results/3week-backtest-2026-04-23/cupsey');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.endsWith('.err.json'));

  const rows: SessionFile[] = [];
  for (const f of files) {
    const raw = await readFile(path.join(dir, f), 'utf8');
    // Strip any leading log lines before the JSON object
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

  // Aggregate (session summary level — trades[] was not included in run)
  const agg = {
    sessions: rows.length,
    totalCandles: rows.reduce((s, r) => s + (r.dataset?.candleCount ?? 0), 0),
    keptCandles: rows.reduce((s, r) => s + (r.dataset?.keptCandleCount ?? 0), 0),
    totalSignals: rows.reduce((s, r) => s + (r.summary?.totalSignals ?? 0), 0),
    stalkEntries: rows.reduce((s, r) => s + (r.summary?.stalkEntries ?? 0), 0),
    stalkSkips: rows.reduce((s, r) => s + (r.summary?.stalkSkips ?? 0), 0),
    probeWinners: rows.reduce((s, r) => s + (r.summary?.probeWinners ?? 0), 0),
    probeRejects: rows.reduce((s, r) => s + (r.summary?.probeRejects ?? 0), 0),
    gateRejects: rows.reduce((s, r) => s + (r.summary?.gateRejects ?? 0), 0),
    // weighted sums (session avg × session trade count)
    weightedNetPnlSum: 0,
    weightedMfeSum: 0,
    weightedMaeSum: 0,
    weightedHoldSum: 0,
    winCount: 0,
    exitReasonBreakdown: {} as Record<string, number>,
    sessionsWithTrades: 0,
    sessionsWithWinners: 0,
    // per-session peak MFE across sessions (needed proxy for tail until --include-trades rerun)
    maxSessionAvgMfePct: 0,
    maxSessionAvgNetPct: 0,
  };

  for (const r of rows) {
    const breakdown = r.summary?.exitReasonBreakdown ?? {};
    for (const [k, v] of Object.entries(breakdown)) {
      agg.exitReasonBreakdown[k] = (agg.exitReasonBreakdown[k] ?? 0) + (v as number);
    }
    const stalkEntries = r.summary?.stalkEntries ?? 0;
    const winners = r.summary?.probeWinners ?? 0;
    if (stalkEntries > 0) {
      agg.sessionsWithTrades++;
      const tradeCount = stalkEntries;
      agg.weightedNetPnlSum += (r.summary?.avgNetPnlPct ?? 0) * tradeCount;
      agg.weightedMfeSum += (r.summary?.avgMfePct ?? 0) * tradeCount;
      agg.weightedMaeSum += (r.summary?.avgMaePct ?? 0) * tradeCount;
      agg.weightedHoldSum += (r.summary?.avgHoldSec ?? 0) * tradeCount;
      agg.winCount += Math.round((r.summary?.winRate ?? 0) * tradeCount);
      if ((r.summary?.avgMfePct ?? 0) > agg.maxSessionAvgMfePct) {
        agg.maxSessionAvgMfePct = r.summary?.avgMfePct ?? 0;
      }
      if ((r.summary?.avgNetPnlPct ?? 0) > agg.maxSessionAvgNetPct) {
        agg.maxSessionAvgNetPct = r.summary?.avgNetPnlPct ?? 0;
      }
    }
    if (winners > 0) agg.sessionsWithWinners++;
  }

  const totalTrades = agg.stalkEntries;
  const avgNet = totalTrades > 0 ? agg.weightedNetPnlSum / totalTrades : 0;
  const avgMfe = totalTrades > 0 ? agg.weightedMfeSum / totalTrades : 0;
  const avgMae = totalTrades > 0 ? agg.weightedMaeSum / totalTrades : 0;
  const avgHold = totalTrades > 0 ? agg.weightedHoldSum / totalTrades : 0;
  const winRate = totalTrades > 0 ? agg.winCount / totalTrades : 0;
  const stalkRate = agg.totalSignals > 0 ? agg.stalkEntries / agg.totalSignals : 0;

  const outJson = {
    generatedAt: new Date().toISOString(),
    ...agg,
    totalTrades,
    avgNetPnlPct: avgNet,
    avgMfePct: avgMfe,
    avgMaePct: avgMae,
    avgHoldSec: avgHold,
    winRate,
    stalkRate,
  };

  const outPath = path.resolve('results/3week-backtest-2026-04-23/cupsey-summary.json');
  await writeFile(outPath, JSON.stringify(outJson, null, 2));
  console.log(`[aggregate] wrote ${outPath}`);

  const md = [
    `# Cupsey Benchmark 3-Week Replay Summary (2026-04-23)`,
    ``,
    `> Generated: ${outJson.generatedAt}`,
    `> Input: ${agg.sessions} session JSONs from \`results/3week-backtest-2026-04-23/cupsey/\``,
    ``,
    `## Coverage`,
    ``,
    `| 항목 | 값 |`,
    `|---|---:|`,
    `| Sessions processed | ${agg.sessions} |`,
    `| Sessions with ≥1 trade | ${agg.sessionsWithTrades} |`,
    `| Sessions with ≥1 winner | ${agg.sessionsWithWinners} |`,
    `| Total candles | ${agg.totalCandles.toLocaleString()} |`,
    `| Kept candles | ${agg.keptCandles.toLocaleString()} |`,
    `| Total signals | ${agg.totalSignals.toLocaleString()} |`,
    `| Gate rejects | ${agg.gateRejects.toLocaleString()} |`,
    ``,
    `## State Transitions`,
    ``,
    `| 단계 | 카운트 | 비율 |`,
    `|---|---:|---:|`,
    `| Signals | ${agg.totalSignals} | 100% |`,
    `| STALK entries | ${agg.stalkEntries} | ${(stalkRate * 100).toFixed(1)}% |`,
    `| STALK skips | ${agg.stalkSkips} | ${((agg.stalkSkips / Math.max(1, agg.totalSignals)) * 100).toFixed(1)}% |`,
    `| Probe → WINNER | ${agg.probeWinners} | ${((agg.probeWinners / Math.max(1, agg.stalkEntries)) * 100).toFixed(1)}% of STALK |`,
    `| Probe → REJECT | ${agg.probeRejects} | ${((agg.probeRejects / Math.max(1, agg.stalkEntries)) * 100).toFixed(1)}% of STALK |`,
    ``,
    `## Trade Performance (session-summary weighted)`,
    ``,
    `> Note: --include-trades 미적용 상태 — 개별 trade 단위 2x/5x/10x 분해는 재실행 필요.`,
    `> 아래는 session summary (avgNetPnlPct × stalkEntries) 가중 집계.`,
    ``,
    `| 항목 | 값 |`,
    `|---|---:|`,
    `| Total closed trades (STALK entries) | ${totalTrades} |`,
    `| Win rate (weighted) | ${(winRate * 100).toFixed(1)}% |`,
    `| Avg net PnL% (weighted) | ${(avgNet * 100).toFixed(3)}% |`,
    `| Avg MFE% (weighted) | ${(avgMfe * 100).toFixed(2)}% |`,
    `| Avg MAE% (weighted) | ${(avgMae * 100).toFixed(2)}% |`,
    `| Avg hold (weighted) | ${avgHold.toFixed(0)}s |`,
    `| Max session avg MFE% | ${(agg.maxSessionAvgMfePct * 100).toFixed(2)}% |`,
    `| Max session avg net% | ${(agg.maxSessionAvgNetPct * 100).toFixed(2)}% |`,
    ``,
    `## Exit Reason Breakdown`,
    ``,
    `| Reason | Count | % of closed |`,
    `|---|---:|---:|`,
    ...Object.entries(agg.exitReasonBreakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `| ${k} | ${v} | ${((v / Math.max(1, Object.values(agg.exitReasonBreakdown).reduce((a, b) => a + b, 0))) * 100).toFixed(1)}% |`),
    ``,
    `## Interpretation`,
    ``,
    `- **cupsey benchmark 의 3주 backtest 결과**. 현재 운영 파라미터 (stalk 60s / probe 45s / MFE +2% / trail 4% / max-hold 12min) 기준.`,
    `- 사명 관점 5x+/10x+ 카운트가 핵심. cupsey 설계상 flip 2% 전략이므로 5x+ 는 드물게만 잡힘 (memecoin 급 폭발에서 trail 4% 이상 버틸 때).`,
    `- Path B (pure_ws replay engine) 설계 시 이 결과를 benchmark 으로 비교.`,
    ``,
  ].join('\n');

  const mdPath = path.resolve('results/3week-backtest-2026-04-23/cupsey-summary.md');
  await writeFile(mdPath, md);
  console.log(`[aggregate] wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
