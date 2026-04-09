#!/usr/bin/env ts-node
/**
 * Exit Latency Audit
 *
 * Why: 2026-04-08 — Phase X2 v2 audit (n=18) 에서 `TP2 intent → actual fill = 0/10 = 0%`
 * 가 확인됐고, `exit-execution-mechanism-2026-04-08.md` Phase E1 의 측정 도구로
 * 본 스크립트가 추가됐다. monitor trigger 발동 시각 ~ Jupiter swap 응답 시각 사이의
 * latency 분포 + monitor_trigger_price → exit_price reverse ratio 분포를 산출해
 * Phase E1 결정 분기 (A/B/C) 의 입력값을 제공한다.
 *
 * Inputs (read-only, DB 의존성 0):
 *   - data/vps-trades-latest.jsonl (sync-vps-data.sh 로 동기화된 trades 테이블 dump)
 *
 * Filter:
 *   - status = 'CLOSED'
 *   - exit_anomaly_reason IS NULL (Phase E fake-fill 마커로 격리된 row 제외)
 *   - monitor_trigger_at IS NOT NULL (E1 telemetry 가 기록된 trade 만)
 *
 * Output:
 *   - 헤드라인: trigger→submit p50/p95, submit→response p50/p95, reverse ratio p50/p95,
 *     actual TP2 match rate, pre-TP1 EXHAUSTION count
 *   - exit reason × {n, latency p50/p95, reverse ratio p50/p95}
 *   - entry-group 기준 realized R 분포
 *   - Phase E1 decision branch hint (A/B/C)
 *
 * Usage:
 *   npx ts-node scripts/analysis/exit-latency-audit.ts
 *   npx ts-node scripts/analysis/exit-latency-audit.ts --strategy bootstrap_10s
 *   npx ts-node scripts/analysis/exit-latency-audit.ts --closed-after 2026-04-08T00:00:00Z
 *   npx ts-node scripts/analysis/exit-latency-audit.ts --out docs/audits/exit-latency-2026-04-08.md
 *
 * Important caveat:
 *   - paper 모드 trade 는 swapSubmitAt = swapResponseAt = monitorTriggerAt 으로 기록되므로
 *     latency 측정의 대부분이 0ms. live trade 만 의미 있는 분포가 나온다.
 *   - 1-level parent grouping (`parent_trade_id ?? id`). exit-distribution-audit.ts 와 동일.
 */

import fs from 'fs';
import path from 'path';

interface TradeRow {
  id: string;
  pair_address: string;
  strategy: string;
  entry_price: number | string;
  exit_price: number | string | null;
  quantity: number | string;
  pnl: number | string | null;
  status: string;
  exit_reason: string | null;
  stop_loss: number | string | null;
  take_profit1: number | string | null;
  take_profit2: number | string | null;
  high_water_mark: number | string | null;
  created_at: string;
  closed_at: string | null;
  parent_trade_id: string | null;
  exit_anomaly_reason: string | null;
  token_symbol: string | null;
  // Phase E1 telemetry
  monitor_trigger_price: number | string | null;
  monitor_trigger_at: string | null;
  swap_submit_at: string | null;
  swap_response_at: string | null;
  pre_submit_tick_price: number | string | null;
}

interface Args {
  inputPath: string;
  strategyFilter: string | null;
  closedAfter: string | null;
  outPath: string | null;
  includeDirty: boolean;
  sampleGate: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    inputPath: 'data/vps-trades-latest.jsonl',
    strategyFilter: null,
    closedAfter: null,
    outPath: null,
    includeDirty: false,
    sampleGate: 20, // Phase E1 acceptance: ≥20 closed trades
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--input' && value) { args.inputPath = value; i++; }
    else if (flag === '--strategy' && value) { args.strategyFilter = value; i++; }
    else if (flag === '--closed-after' && value) { args.closedAfter = value; i++; }
    else if (flag === '--out' && value) { args.outPath = value; i++; }
    else if (flag === '--sample-gate' && value) { args.sampleGate = Number(value); i++; }
    else if (flag === '--include-dirty') { args.includeDirty = true; }
  }
  return args;
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v);
}

function ts(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function loadTrades(args: Args): TradeRow[] {
  const fp = path.resolve(process.cwd(), args.inputPath);
  if (!fs.existsSync(fp)) {
    throw new Error(`trades input not found: ${fp}`);
  }
  const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter((l) => l.trim().length > 0);
  const rows: TradeRow[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as TradeRow);
    } catch (e) {
      process.stderr.write(`skip malformed line: ${(e as Error).message}\n`);
    }
  }
  return rows;
}

function filterRows(rows: TradeRow[], args: Args): TradeRow[] {
  const closedAfterMs = args.closedAfter ? new Date(args.closedAfter).getTime() : null;
  return rows.filter((r) => {
    if (r.status !== 'CLOSED') return false;
    if (!args.includeDirty && r.exit_anomaly_reason != null) return false;
    if (args.strategyFilter && r.strategy !== args.strategyFilter) return false;
    if (closedAfterMs != null) {
      const closedMs = r.closed_at ? new Date(r.closed_at).getTime() : 0;
      if (closedMs < closedAfterMs) return false;
    }
    // Phase E1: telemetry 가 기록된 row 만 (legacy row 제외)
    if (r.monitor_trigger_at == null) return false;
    return true;
  });
}

interface LegMetrics {
  row: TradeRow;
  triggerToSubmitMs: number | null;
  submitToResponseMs: number | null;
  triggerToResponseMs: number | null;
  reverseRatioPct: number | null; // (exit_price - monitor_trigger_price) / monitor_trigger_price * 100
  preSubmitToExitGapPct: number | null; // (exit_price - pre_submit_tick_price) / pre_submit_tick_price * 100
}

function computeLegMetrics(row: TradeRow): LegMetrics {
  const triggerAt = ts(row.monitor_trigger_at);
  const submitAt = ts(row.swap_submit_at);
  const responseAt = ts(row.swap_response_at);
  const triggerToSubmitMs = triggerAt != null && submitAt != null ? submitAt - triggerAt : null;
  const submitToResponseMs = submitAt != null && responseAt != null ? responseAt - submitAt : null;
  const triggerToResponseMs = triggerAt != null && responseAt != null ? responseAt - triggerAt : null;
  const monitorTriggerPrice = num(row.monitor_trigger_price);
  const exitPrice = num(row.exit_price);
  const reverseRatioPct = (monitorTriggerPrice > 0 && exitPrice > 0)
    ? ((exitPrice - monitorTriggerPrice) / monitorTriggerPrice) * 100
    : null;
  const preSubmitTickPrice = num(row.pre_submit_tick_price);
  const preSubmitToExitGapPct = (preSubmitTickPrice > 0 && exitPrice > 0)
    ? ((exitPrice - preSubmitTickPrice) / preSubmitTickPrice) * 100
    : null;
  return {
    row,
    triggerToSubmitMs,
    submitToResponseMs,
    triggerToResponseMs,
    reverseRatioPct,
    preSubmitToExitGapPct,
  };
}

interface EntryGroup {
  parentId: string;
  legs: TradeRow[];
  parent: TradeRow;
  finalExitReason: string;
  finalExitPrice: number;
  realizedR: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  actualTp2Reached: boolean;
  exhaustionBeforeTp1: boolean;
  symbol: string;
}

function groupByParent(rows: TradeRow[]): EntryGroup[] {
  const byParent = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const key = row.parent_trade_id ?? row.id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(row);
  }
  const groups: EntryGroup[] = [];
  for (const [parentId, legs] of byParent.entries()) {
    const parent = legs.find((l) => l.parent_trade_id == null) ?? legs[0];
    const sortedByClose = [...legs].sort((a, b) => {
      const ta = a.closed_at ? new Date(a.closed_at).getTime() : 0;
      const tb = b.closed_at ? new Date(b.closed_at).getTime() : 0;
      return ta - tb;
    });
    const lastLeg = sortedByClose[sortedByClose.length - 1];
    const totalPnl = legs.reduce((s, l) => s + num(l.pnl), 0);
    const totalQuantity = legs.reduce((s, l) => s + num(l.quantity), 0);
    const tp1Hit = legs.some((l) => l.exit_reason === 'TAKE_PROFIT_1');
    const tp2Hit = legs.some((l) => l.exit_reason === 'TAKE_PROFIT_2');
    const finalExitReason = lastLeg.exit_reason ?? 'UNKNOWN';
    const finalExitPrice = num(lastLeg.exit_price);
    const entryPrice = num(parent.entry_price);
    const stopLoss = num(parent.stop_loss);
    const takeProfit1 = num(parent.take_profit1);
    const takeProfit2 = num(parent.take_profit2);
    const maxHighWaterMark = legs.reduce((max, leg) => Math.max(max, num(leg.high_water_mark)), 0);
    const riskPerUnit = (entryPrice > 0 && stopLoss > 0 && entryPrice > stopLoss)
      ? entryPrice - stopLoss
      : 0;
    const realizedR = (totalQuantity > 0 && riskPerUnit > 0)
      ? totalPnl / (totalQuantity * riskPerUnit)
      : NaN;
    // Phase X2 v2: actual TP2 reach = exit_price >= takeProfit2 (intent 와 무관)
    const actualTp2Reached = takeProfit2 > 0 && finalExitPrice >= takeProfit2;
    const exhaustionBeforeTp1 =
      finalExitReason === 'EXHAUSTION' &&
      takeProfit1 > 0 &&
      !tp1Hit &&
      maxHighWaterMark > entryPrice &&
      maxHighWaterMark > 0 &&
      maxHighWaterMark < takeProfit1;
    groups.push({
      parentId,
      legs,
      parent,
      finalExitReason,
      finalExitPrice,
      realizedR,
      tp1Hit,
      tp2Hit,
      actualTp2Reached,
      exhaustionBeforeTp1,
      symbol: parent.token_symbol ?? parent.pair_address.slice(0, 12),
    });
  }
  return groups;
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

function p50(values: (number | null)[]): number {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  return quantile(finite.sort((a, b) => a - b), 0.5);
}

function p95(values: (number | null)[]): number {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  return quantile(finite.sort((a, b) => a - b), 0.95);
}

interface ReasonLatencyStats {
  reason: string;
  n: number;
  triggerToSubmitP50Ms: number;
  triggerToSubmitP95Ms: number;
  submitToResponseP50Ms: number;
  submitToResponseP95Ms: number;
  reverseRatioP50Pct: number;
  reverseRatioP95Pct: number;
}

function aggregateByExitReason(metricsByLeg: LegMetrics[]): ReasonLatencyStats[] {
  const byReason = new Map<string, LegMetrics[]>();
  for (const m of metricsByLeg) {
    const key = m.row.exit_reason ?? 'UNKNOWN';
    if (!byReason.has(key)) byReason.set(key, []);
    byReason.get(key)!.push(m);
  }
  const stats: ReasonLatencyStats[] = [];
  for (const [reason, list] of byReason.entries()) {
    stats.push({
      reason,
      n: list.length,
      triggerToSubmitP50Ms: p50(list.map((m) => m.triggerToSubmitMs)),
      triggerToSubmitP95Ms: p95(list.map((m) => m.triggerToSubmitMs)),
      submitToResponseP50Ms: p50(list.map((m) => m.submitToResponseMs)),
      submitToResponseP95Ms: p95(list.map((m) => m.submitToResponseMs)),
      reverseRatioP50Pct: p50(list.map((m) => m.reverseRatioPct)),
      reverseRatioP95Pct: p95(list.map((m) => m.reverseRatioPct)),
    });
  }
  stats.sort((a, b) => b.n - a.n);
  return stats;
}

function fmtMs(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}

function fmtPct(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function fmtR(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
}

function decideBranch(
  legMetrics: LegMetrics[],
  groups: EntryGroup[],
  sampleGate: number
): { branch: 'A' | 'B' | 'C' | 'inconclusive'; reason: string } {
  if (groups.length < sampleGate) {
    return {
      branch: 'C',
      reason: `sample n=${groups.length} < gate ${sampleGate} → A2 (universe flow) 선행 또는 추가 표본 누적 필요`,
    };
  }
  // Reverse ratio (negative ratio 가 클수록 monitor_trigger_price 대비 fill 이 낮음)
  const reverseList = legMetrics
    .map((m) => m.reverseRatioPct)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (reverseList.length === 0) {
    return { branch: 'inconclusive', reason: 'no measurable reverse ratios in sample' };
  }
  const sortedDesc = [...reverseList].map((v) => Math.abs(v)).sort((a, b) => b - a);
  const p95Abs = quantile(sortedDesc.slice().sort((a, b) => a - b), 0.95);
  if (p95Abs > 2) {
    return {
      branch: 'A',
      reason: `reverse ratio |p95|=${p95Abs.toFixed(2)}% > 2% → swap latency 동안 가격 reverse 가 크다 → C2 tick-level 필요`,
    };
  }
  return {
    branch: 'B',
    reason: `reverse ratio |p95|=${p95Abs.toFixed(2)}% ≤ 2% → polling lag 만 문제 → C5 limited live mini-canary 후보`,
  };
}

function render(
  args: Args,
  rows: TradeRow[],
  filtered: TradeRow[],
  legMetrics: LegMetrics[],
  groups: EntryGroup[],
  reasonStats: ReasonLatencyStats[],
): string {
  const lines: string[] = [];
  const generatedAt = new Date().toISOString();
  lines.push(`# Exit Latency Audit`);
  lines.push('');
  lines.push(`> Generated: ${generatedAt}`);
  lines.push(`> Source: ${args.inputPath}`);
  lines.push(`> Filter: status=CLOSED${args.includeDirty ? '' : ' AND exit_anomaly_reason IS NULL'} AND monitor_trigger_at IS NOT NULL${args.strategyFilter ? ` AND strategy=${args.strategyFilter}` : ''}${args.closedAfter ? ` AND closed_at>=${args.closedAfter}` : ''}`);
  lines.push(`> Sample gate: ${args.sampleGate}`);
  lines.push('');
  lines.push(`## Sample Counts`);
  lines.push('');
  lines.push(`- Raw rows: ${rows.length}`);
  lines.push(`- After filter: ${filtered.length}`);
  lines.push(`- Entry groups (parent-grouped): ${groups.length}`);
  lines.push('');

  // Headlines
  const triggerToSubmitP50 = p50(legMetrics.map((m) => m.triggerToSubmitMs));
  const triggerToSubmitP95 = p95(legMetrics.map((m) => m.triggerToSubmitMs));
  const submitToResponseP50 = p50(legMetrics.map((m) => m.submitToResponseMs));
  const submitToResponseP95 = p95(legMetrics.map((m) => m.submitToResponseMs));
  const reverseP50 = p50(legMetrics.map((m) => m.reverseRatioPct));
  const reverseP95 = p95(legMetrics.map((m) => m.reverseRatioPct));
  const tp2IntentN = legMetrics.filter((m) => m.row.exit_reason === 'TAKE_PROFIT_2').length;
  const actualTp2N = groups.filter((g) => g.actualTp2Reached).length;
  const tp2MatchRate = tp2IntentN > 0 ? (actualTp2N / tp2IntentN) * 100 : 0;
  const exhaustionBeforeTp1N = groups.filter((g) => g.exhaustionBeforeTp1).length;

  lines.push(`## Headlines`);
  lines.push('');
  lines.push(`- trigger→submit latency: p50=${fmtMs(triggerToSubmitP50)}, p95=${fmtMs(triggerToSubmitP95)}`);
  lines.push(`- submit→response latency: p50=${fmtMs(submitToResponseP50)}, p95=${fmtMs(submitToResponseP95)}`);
  lines.push(`- monitor_trigger_price → exit_price reverse: p50=${fmtPct(reverseP50)}, p95=${fmtPct(reverseP95)}`);
  lines.push(`- TP2 intent → actual fill match: ${actualTp2N}/${tp2IntentN} (${tp2MatchRate.toFixed(1)}%)`);
  lines.push(`- pre-TP1 EXHAUSTION count: ${exhaustionBeforeTp1N}`);
  lines.push('');

  // Per-reason
  if (reasonStats.length > 0) {
    lines.push(`## Per-Exit-Reason`);
    lines.push('');
    lines.push(`| reason | n | trigger→submit p50/p95 | submit→response p50/p95 | reverse ratio p50/p95 |`);
    lines.push(`|---|---:|---|---|---|`);
    for (const s of reasonStats) {
      lines.push(
        `| ${s.reason} | ${s.n} | ${fmtMs(s.triggerToSubmitP50Ms)} / ${fmtMs(s.triggerToSubmitP95Ms)} ` +
        `| ${fmtMs(s.submitToResponseP50Ms)} / ${fmtMs(s.submitToResponseP95Ms)} ` +
        `| ${fmtPct(s.reverseRatioP50Pct)} / ${fmtPct(s.reverseRatioP95Pct)} |`
      );
    }
    lines.push('');
  }

  // Entry-group realized R
  const finiteR = groups.map((g) => g.realizedR).filter((r) => Number.isFinite(r));
  if (finiteR.length > 0) {
    const sortedR = [...finiteR].sort((a, b) => a - b);
    lines.push(`## Entry-Group Realized R`);
    lines.push('');
    lines.push(`- n (finite): ${finiteR.length}`);
    lines.push(`- avg: ${fmtR(finiteR.reduce((s, x) => s + x, 0) / finiteR.length)}`);
    lines.push(`- p25: ${fmtR(quantile(sortedR, 0.25))}, p50: ${fmtR(quantile(sortedR, 0.5))}, p75: ${fmtR(quantile(sortedR, 0.75))}`);
    lines.push('');
  }

  // Decision branch
  const decision = decideBranch(legMetrics, groups, args.sampleGate);
  lines.push(`## Phase E1 Decision Branch`);
  lines.push('');
  lines.push(`> **Branch ${decision.branch}** — ${decision.reason}`);
  lines.push('');
  lines.push(`Branch 의미 (exit-execution-mechanism-2026-04-08.md Phase E1 Decision Branch):`);
  lines.push(`- A: Phase E2 (C2 tick-level) 필요`);
  lines.push(`- B: C5 limited live mini-canary 후보 (paper 만으론 단정 금지)`);
  lines.push(`- C: 표본 부족 — A2 (universe flow) 선행 또는 추가 누적`);
  lines.push('');

  return lines.join('\n');
}

function main(): void {
  const args = parseArgs();
  const rows = loadTrades(args);
  const filtered = filterRows(rows, args);
  const legMetrics = filtered.map(computeLegMetrics);
  const groups = groupByParent(filtered);
  const reasonStats = aggregateByExitReason(legMetrics);
  const md = render(args, rows, filtered, legMetrics, groups, reasonStats);
  if (args.outPath) {
    const outFp = path.resolve(process.cwd(), args.outPath);
    fs.mkdirSync(path.dirname(outFp), { recursive: true });
    fs.writeFileSync(outFp, md, 'utf-8');
    process.stdout.write(`Wrote ${outFp}\n`);
  } else {
    process.stdout.write(md);
  }
}

main();
