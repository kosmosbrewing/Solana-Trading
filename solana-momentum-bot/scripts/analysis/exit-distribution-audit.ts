#!/usr/bin/env ts-node
/**
 * Exit Distribution Audit
 *
 * Why: 2026-04-08 — Codex 진단에서 bootstrap_10s exit 구조의 live 적합성에
 * 의문이 제기됐다. 하지만 표본이 4 trades뿐이라 결론 불가. 본 스크립트는
 * `docs/exec-plans/active/exit-structure-validation-2026-04-08.md` Phase X2의
 * 측정 도구로, clean closed trades의 exit reason 분포 + 평균 R-multiple을
 * 산출해 가설 분기(Phase X3)의 입력값을 제공한다.
 *
 * Inputs (read-only, DB 의존성 0):
 *   - data/vps-trades-latest.jsonl (sync-vps-data.sh로 동기화된 trades 테이블 dump)
 *
 * Filter:
 *   - status = 'CLOSED'
 *   - exit_anomaly_reason IS NULL (Phase E fake-fill 마커로 격리된 row 제외)
 *
 * Output:
 *   - exit reason × {n, %, avg_R, p25/p50/p75 R, avg_pnl_sol}
 *   - TP1/TP2 도달율 헤드라인
 *   - logical entry 단위 (parent-grouped) 집계
 *   - Phase X3 시나리오 후보 hint
 *
 * Usage:
 *   npx ts-node scripts/analysis/exit-distribution-audit.ts
 *   npx ts-node scripts/analysis/exit-distribution-audit.ts --strategy bootstrap_10s
 *   npx ts-node scripts/analysis/exit-distribution-audit.ts --out docs/audits/exit-distribution-2026-04-08.md
 *
 * Important caveat:
 *   1-level parent grouping만 한다 (`parent_trade_id ?? id`). 깊은 chain
 *   (T1→T2→T3) 처리는 trade-report.ts와 동일한 한계가 있으며, 별도 root
 *   parent resolver 도입 시 이 스크립트도 함께 수정해야 한다.
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
  created_at: string;
  closed_at: string | null;
  parent_trade_id: string | null;
  exit_anomaly_reason: string | null;
  token_symbol: string | null;
}

interface Args {
  inputPath: string;
  strategyFilter: string | null;
  outPath: string | null;
  includeDirty: boolean;
  sampleGate: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    inputPath: 'data/vps-trades-latest.jsonl',
    strategyFilter: null,
    outPath: null,
    includeDirty: false,
    sampleGate: 20, // Phase X1 acceptance gate (Bootstrap → Calibration tier 전환점)
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--input' && value) { args.inputPath = value; i++; }
    else if (flag === '--strategy' && value) { args.strategyFilter = value; i++; }
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

// Why: actualBucket = exit_price를 entry/SL/TP1/TP2 level로 분류한 *fill* 결과.
// finalExitReason은 trigger intent (어떤 조건이 monitor loop에서 발동했는가)고,
// actualBucket은 Jupiter swap이 *실제로* 어디에서 fill됐는가다. 두 axis가 다르면
// "intent ≠ actual" — Phase X2 measurement gap 신호.
type ActualBucket =
  | 'SL_OR_WORSE'
  | 'BELOW_ENTRY'
  | 'BELOW_TP1'
  | 'TP1_TO_TP2'
  | 'TP2_OR_BETTER'
  | 'UNKNOWN';

interface EntryGroup {
  parentId: string;
  legs: TradeRow[];
  parent: TradeRow;
  totalPnl: number;
  totalQuantity: number;
  finalExitReason: string;
  finalExitPrice: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  realizedR: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskPerUnit: number;
  symbol: string;
  actualBucket: ActualBucket;
}

function classifyActualBucket(
  exitPrice: number,
  entryPrice: number,
  stopLoss: number,
  takeProfit1: number,
  takeProfit2: number,
): ActualBucket {
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) return 'UNKNOWN';
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 'UNKNOWN';
  // legacy v3 이전 row는 stop_loss/tp가 0일 수 있다 → 분류 불가.
  if (stopLoss <= 0 || takeProfit1 <= 0 || takeProfit2 <= 0) return 'UNKNOWN';
  if (exitPrice <= stopLoss) return 'SL_OR_WORSE';
  if (exitPrice < entryPrice) return 'BELOW_ENTRY';
  if (exitPrice < takeProfit1) return 'BELOW_TP1';
  if (exitPrice < takeProfit2) return 'TP1_TO_TP2';
  return 'TP2_OR_BETTER';
}

// Why: 1-level parent grouping (matches trade-report.ts:123-131). 깊은 chain은
// 별도 root parent resolver 도입 시점에 이 함수도 같이 갱신한다.
function groupByParent(rows: TradeRow[]): EntryGroup[] {
  const byParent = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const key = row.parent_trade_id ?? row.id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(row);
  }
  const groups: EntryGroup[] = [];
  for (const [parentId, legs] of byParent.entries()) {
    // parent row (parent_trade_id == null) 우선, 없으면 첫 leg
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
    // Risk per unit = entry - SL. legacy v3 이전 row는 stop_loss=0 → NaN R.
    const riskPerUnit = (entryPrice > 0 && stopLoss > 0 && entryPrice > stopLoss)
      ? entryPrice - stopLoss
      : 0;
    // Realized R = totalPnl / (totalQuantity * riskPerUnit). 부분 청산 합산 기준.
    const realizedR = (totalQuantity > 0 && riskPerUnit > 0)
      ? totalPnl / (totalQuantity * riskPerUnit)
      : NaN;
    const actualBucket = classifyActualBucket(
      finalExitPrice,
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
    );
    groups.push({
      parentId,
      legs,
      parent,
      totalPnl,
      totalQuantity,
      finalExitReason,
      finalExitPrice,
      tp1Hit,
      tp2Hit,
      realizedR,
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      riskPerUnit,
      symbol: parent.token_symbol ?? parent.pair_address.slice(0, 12),
      actualBucket,
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

interface ExitReasonStats {
  reason: string;
  n: number;
  pctOfTotal: number;
  avgR: number;
  p25R: number;
  p50R: number;
  p75R: number;
  avgPnlSol: number;
  finiteRn: number;
}

function aggregateByExitReason(groups: EntryGroup[]): ExitReasonStats[] {
  const byReason = new Map<string, EntryGroup[]>();
  for (const g of groups) {
    if (!byReason.has(g.finalExitReason)) byReason.set(g.finalExitReason, []);
    byReason.get(g.finalExitReason)!.push(g);
  }
  const total = groups.length;
  const stats: ExitReasonStats[] = [];
  for (const [reason, list] of byReason.entries()) {
    const finiteR = list.map((g) => g.realizedR).filter((r) => Number.isFinite(r));
    const sortedR = [...finiteR].sort((a, b) => a - b);
    const avgR = finiteR.length > 0
      ? finiteR.reduce((s, x) => s + x, 0) / finiteR.length
      : NaN;
    const avgPnl = list.reduce((s, g) => s + g.totalPnl, 0) / list.length;
    stats.push({
      reason,
      n: list.length,
      pctOfTotal: total > 0 ? (list.length / total) * 100 : 0,
      avgR,
      p25R: quantile(sortedR, 0.25),
      p50R: quantile(sortedR, 0.5),
      p75R: quantile(sortedR, 0.75),
      avgPnlSol: avgPnl,
      finiteRn: finiteR.length,
    });
  }
  stats.sort((a, b) => b.n - a.n);
  return stats;
}

function fmt(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function buildReport(groups: EntryGroup[], args: Args, totalRowsBeforeFilter: number, droppedDirty: number): string {
  const lines: string[] = [];
  lines.push('# Exit Distribution Audit');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: ${args.inputPath}`);
  const filterDesc = `status=CLOSED${args.includeDirty ? '' : ' AND exit_anomaly_reason IS NULL'}${args.strategyFilter ? ` AND strategy=${args.strategyFilter}` : ''}`;
  lines.push(`Filter: ${filterDesc}`);
  lines.push(`Input rows: ${totalRowsBeforeFilter}, dropped (anomaly): ${droppedDirty}, parent groups: ${groups.length}`);
  lines.push('');

  if (groups.length === 0) {
    lines.push('No qualifying trades found.');
    return lines.join('\n');
  }

  // Sample size verdict
  lines.push('## Sample Size Verdict');
  lines.push('');
  if (groups.length < args.sampleGate) {
    lines.push(`⚠ **Sample insufficient**: ${groups.length} < ${args.sampleGate} (Phase X1 acceptance gate). Phase X3 가설 분기 진입 금지.`);
  } else {
    lines.push(`✓ Sample sufficient: ${groups.length} ≥ ${args.sampleGate}. Phase X3 분기 검토 가능.`);
  }
  lines.push('');

  // Exit reason × stats
  const stats = aggregateByExitReason(groups);
  lines.push('## Exit Reason Distribution');
  lines.push('');
  lines.push('| Exit Reason | n | % | avg R | p25 R | p50 R | p75 R | avg PnL (SOL) | finite R |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of stats) {
    const pnlStr = `${s.avgPnlSol >= 0 ? '+' : ''}${fmt(s.avgPnlSol, 6)}`;
    lines.push(
      `| ${s.reason} | ${s.n} | ${fmt(s.pctOfTotal, 1)}% | ${fmt(s.avgR)} | ${fmt(s.p25R)} | ${fmt(s.p50R)} | ${fmt(s.p75R)} | ${pnlStr} | ${s.finiteRn} |`
    );
  }
  lines.push('');

  // Hit rate headlines
  const tp1HitCount = groups.filter((g) => g.tp1Hit).length;
  const tp2HitCount = groups.filter((g) => g.tp2Hit).length;
  const slCount = groups.filter((g) => g.finalExitReason === 'STOP_LOSS').length;
  const trailingCount = groups.filter((g) => g.finalExitReason === 'TRAILING_STOP').length;
  const timeStopCount = groups.filter((g) => g.finalExitReason === 'TIME_STOP').length;

  lines.push('## Hit Rate Headlines (Intent — exit_reason 기반)');
  lines.push('');
  lines.push('> 주의: 아래는 *trigger intent* (monitor loop이 어떤 조건을 발동시켰는가) 기반이다.');
  lines.push('> 실제 Jupiter fill은 swap latency 동안 price가 변해 intent와 다른 level에서 체결될 수 있다.');
  lines.push('> Phase X3 가설 분기 판단은 아래 "Intent vs Actual Outcome" 섹션의 actual bucket을 사용한다.');
  lines.push('');
  lines.push(`- **TP1 hit rate (intent)**: ${tp1HitCount}/${groups.length} = ${fmt((tp1HitCount/groups.length)*100, 1)}%`);
  lines.push(`- **TP2 hit rate (intent)**: ${tp2HitCount}/${groups.length} = ${fmt((tp2HitCount/groups.length)*100, 1)}%`);
  lines.push(`- **SL final rate (intent)**: ${slCount}/${groups.length} = ${fmt((slCount/groups.length)*100, 1)}%`);
  lines.push(`- **TRAILING final rate (intent)**: ${trailingCount}/${groups.length} = ${fmt((trailingCount/groups.length)*100, 1)}%`);
  lines.push(`- **TIME_STOP final rate (intent)**: ${timeStopCount}/${groups.length} = ${fmt((timeStopCount/groups.length)*100, 1)}%`);
  lines.push('');

  // Intent vs Actual Outcome cross-tabulation
  // Why: 2026-04-08 smoke test에서 TP2 reason ≠ negative pnl 11/11 발견. 원인은
  // exit_reason이 trigger intent이고 exit_price는 actual fill price인데,
  // monitor loop tick과 Jupiter swap 사이 price 이동이 큰 메모코인에서 두 값이
  // 자주 분리된다는 점이다. Phase X3 판단은 actual bucket을 봐야 한다.
  const bucketOrder: ActualBucket[] = [
    'TP2_OR_BETTER',
    'TP1_TO_TP2',
    'BELOW_TP1',
    'BELOW_ENTRY',
    'SL_OR_WORSE',
    'UNKNOWN',
  ];
  const bucketCounts = new Map<ActualBucket, number>();
  for (const b of bucketOrder) bucketCounts.set(b, 0);
  for (const g of groups) bucketCounts.set(g.actualBucket, (bucketCounts.get(g.actualBucket) ?? 0) + 1);

  lines.push('## Actual Outcome Distribution (exit_price 기반)');
  lines.push('');
  lines.push('| Actual Bucket | n | % | 의미 |');
  lines.push('|---|---:|---:|---|');
  const bucketMeaning: Record<ActualBucket, string> = {
    TP2_OR_BETTER: 'exit_price ≥ take_profit2 — runner 작동',
    TP1_TO_TP2: 'TP1 ≤ exit_price < TP2 — TP1 도달, TP2 미도달',
    BELOW_TP1: 'entry ≤ exit_price < TP1 — 본전~TP1 사이 작은 win',
    BELOW_ENTRY: 'SL < exit_price < entry — 본전 이하 작은 loss',
    SL_OR_WORSE: 'exit_price ≤ SL — full SL 또는 penetration',
    UNKNOWN: '분류 불가 (legacy row, missing levels)',
  };
  for (const b of bucketOrder) {
    const cnt = bucketCounts.get(b) ?? 0;
    if (cnt === 0) continue;
    const pct = (cnt / groups.length) * 100;
    lines.push(`| ${b} | ${cnt} | ${fmt(pct, 1)}% | ${bucketMeaning[b]} |`);
  }
  lines.push('');

  // Intent vs Actual matrix (rows: intent, cols: actual)
  const intents = Array.from(new Set(groups.map((g) => g.finalExitReason))).sort();
  lines.push('## Intent vs Actual Cross-Tabulation');
  lines.push('');
  lines.push('Rows = intent (exit_reason), columns = actual price-level bucket. 대각선 외 셀이 클수록 intent ≠ actual gap이 크다.');
  lines.push('');
  const visibleBuckets = bucketOrder.filter((b) => (bucketCounts.get(b) ?? 0) > 0);
  lines.push('| intent \\\\ actual | ' + visibleBuckets.join(' | ') + ' | total |');
  lines.push('|---' + visibleBuckets.map(() => '|---:').join('') + '|---:|');
  for (const intent of intents) {
    const intentGroups = groups.filter((g) => g.finalExitReason === intent);
    const cells: string[] = [];
    for (const b of visibleBuckets) {
      const n = intentGroups.filter((g) => g.actualBucket === b).length;
      cells.push(n === 0 ? '·' : String(n));
    }
    lines.push(`| **${intent}** | ${cells.join(' | ')} | ${intentGroups.length} |`);
  }
  lines.push('');

  // Mismatch headline: TP2 intent → actual TP2_OR_BETTER 비율
  const tp2IntentGroups = groups.filter((g) => g.finalExitReason === 'TAKE_PROFIT_2');
  if (tp2IntentGroups.length > 0) {
    const tp2IntentMatched = tp2IntentGroups.filter((g) => g.actualBucket === 'TP2_OR_BETTER').length;
    const tp2MatchRate = (tp2IntentMatched / tp2IntentGroups.length) * 100;
    lines.push(`> **TP2 intent → actual TP2 match rate**: ${tp2IntentMatched}/${tp2IntentGroups.length} = ${fmt(tp2MatchRate, 1)}%`);
    if (tp2MatchRate < 50 && tp2IntentGroups.length >= 5) {
      lines.push(`> ⚠ **measurement gap detected**: TP2 trigger fired ${tp2IntentGroups.length}건 중 실제로 TP2 level에서 fill된 건은 ${tp2IntentMatched}건뿐. 나머지는 swap latency 동안 price가 reverse되어 lower level에서 체결됨. exit_reason 기반 hit rate는 over-counting이다.`);
    }
    lines.push('');
  }

  // Actual TP2_OR_BETTER rate (the *real* TP2 reach rate)
  const actualTp2Reach = bucketCounts.get('TP2_OR_BETTER') ?? 0;
  const actualTp2Rate = (actualTp2Reach / groups.length) * 100;
  lines.push(`> **Actual TP2 reach rate (price-based)**: ${actualTp2Reach}/${groups.length} = ${fmt(actualTp2Rate, 1)}% — Phase X3 Scenario A 판단의 정확한 입력값`);
  lines.push('');

  // Aggregate R distribution
  const allR = groups.map((g) => g.realizedR).filter((r) => Number.isFinite(r));
  const sortedR = [...allR].sort((a, b) => a - b);
  const totalPnl = groups.reduce((s, g) => s + g.totalPnl, 0);
  const wins = groups.filter((g) => g.totalPnl > 0).length;
  lines.push('## Overall R-Multiple Distribution');
  lines.push('');
  lines.push(`- finite R count: ${allR.length} / ${groups.length}`);
  lines.push(`- avg R: ${fmt(allR.length > 0 ? allR.reduce((s,x)=>s+x,0)/allR.length : NaN)}`);
  lines.push(`- median R (p50): ${fmt(quantile(sortedR, 0.5))}`);
  lines.push(`- p25 R: ${fmt(quantile(sortedR, 0.25))}`);
  lines.push(`- p75 R: ${fmt(quantile(sortedR, 0.75))}`);
  lines.push(`- max R: ${sortedR.length > 0 ? fmt(sortedR[sortedR.length - 1]) : '—'}`);
  lines.push(`- min R: ${sortedR.length > 0 ? fmt(sortedR[0]) : '—'}`);
  lines.push(`- win rate (entry-level): ${wins}/${groups.length} = ${fmt((wins/groups.length)*100, 1)}%`);
  lines.push(`- net realized PnL: ${totalPnl >= 0 ? '+' : ''}${fmt(totalPnl, 6)} SOL`);
  lines.push('');

  // Phase X3 scenario hints
  // Why: 2026-04-08 갱신 — Scenario A/C/D 판단은 *actual bucket* 기반으로
  // 옮긴다 (intent 기반 hit rate는 measurement gap 때문에 over-counting).
  lines.push('## Phase X3 Scenario Hints (actual bucket 기반)');
  lines.push('');
  if (groups.length < args.sampleGate) {
    lines.push(`- 표본 부족 (${groups.length} < ${args.sampleGate}). Phase X1 누적 대기.`);
  } else {
    let anyHint = false;
    // actual TP2 reach rate (price-based, swap latency 보정)
    const actualTp2ReachLocal = bucketCounts.get('TP2_OR_BETTER') ?? 0;
    const actualTp2RateLocal = (actualTp2ReachLocal / groups.length) * 100;
    // actual TP1+ reach rate (TP1_TO_TP2 + TP2_OR_BETTER)
    const actualTp1Reach =
      (bucketCounts.get('TP1_TO_TP2') ?? 0) + (bucketCounts.get('TP2_OR_BETTER') ?? 0);
    const actualTp1Rate = (actualTp1Reach / groups.length) * 100;

    if (actualTp2RateLocal <= 10) {
      lines.push(`- **Scenario A 후보**: actual TP2 reach rate ${fmt(actualTp2RateLocal, 1)}% ≤ 10% — TP2 10×ATR 너무 낙관적 가설 (price-based, intent 아님).`);
      anyHint = true;
    }
    if (actualTp1Rate >= 50 && actualTp2RateLocal <= 10) {
      lines.push(`- **Scenario C 후보**: actual TP1+ reach ${fmt(actualTp1Rate, 1)}% ≥ 50% AND actual TP2 ${fmt(actualTp2RateLocal, 1)}% ≤ 10% — 본전 보호 + trailing이 잔여 70%를 의미 없게 종결시키는 가설.`);
      anyHint = true;
    }
    if (actualTp2RateLocal >= 20) {
      const tp2ActualGroups = groups.filter((g) => g.actualBucket === 'TP2_OR_BETTER');
      const tp2FiniteR = tp2ActualGroups.map((g) => g.realizedR).filter((r) => Number.isFinite(r));
      const tp2AvgR = tp2FiniteR.length > 0
        ? tp2FiniteR.reduce((s,x)=>s+x,0) / tp2FiniteR.length
        : NaN;
      if (Number.isFinite(tp2AvgR) && tp2AvgR >= 5) {
        lines.push(`- **Scenario D**: actual TP2 ${fmt(actualTp2RateLocal,1)}% ≥ 20% AND avg R per actual-TP2 ${fmt(tp2AvgR)} ≥ 5R — runner-centric 구조 작동 중. 튜닝 없음, 표본 누적 진행.`);
        anyHint = true;
      }
    }
    // Scenario B: SL distance % check (intent-independent, ATR 자체 측정)
    const slDistPcts = groups
      .filter((g) => g.entryPrice > 0 && g.stopLoss > 0)
      .map((g) => ((g.entryPrice - g.stopLoss) / g.entryPrice) * 100);
    const sortedSlDist = [...slDistPcts].sort((a,b)=>a-b);
    const medianSlDist = quantile(sortedSlDist, 0.5);
    const slOrWorseCount = bucketCounts.get('SL_OR_WORSE') ?? 0;
    if (Number.isFinite(medianSlDist) && medianSlDist < 0.3 && slOrWorseCount > 0) {
      lines.push(`- **Scenario B 후보**: median SL distance ${fmt(medianSlDist)}% < 0.3% — ATR 자체가 너무 작아 SL이 노이즈에 잡히는 가설.`);
      anyHint = true;
    }
    if (!anyHint) {
      lines.push('- 명확한 시나리오 후보 없음. 표본 누적 후 재측정 권장.');
    }
  }
  lines.push('');

  // Per-group detail (first 30)
  lines.push('## Entry Group Detail (first 30)');
  lines.push('');
  lines.push('| symbol | n legs | intent reason | actual bucket | total pnl SOL | realized R |');
  lines.push('|---|---:|---|---|---:|---:|');
  const detailGroups = groups.slice(0, 30);
  for (const g of detailGroups) {
    const sym = (g.symbol ?? '?').slice(0, 14);
    const pnlStr = `${g.totalPnl >= 0 ? '+' : ''}${fmt(g.totalPnl, 6)}`;
    const mismatch = g.finalExitReason === 'TAKE_PROFIT_2' && g.actualBucket !== 'TP2_OR_BETTER'
      ? ' ⚠'
      : g.finalExitReason === 'TAKE_PROFIT_1' && g.actualBucket === 'SL_OR_WORSE'
        ? ' ⚠'
        : '';
    lines.push(
      `| ${sym} | ${g.legs.length} | ${g.finalExitReason} | ${g.actualBucket}${mismatch} | ${pnlStr} | ${fmt(g.realizedR)} |`
    );
  }
  lines.push('');
  lines.push('⚠ = intent ≠ actual mismatch (TP2 intent → non-TP2 actual, 또는 TP1 intent → SL actual).');
  lines.push('');

  // Caveats
  lines.push('## Caveats');
  lines.push('');
  lines.push('- 1-level parent grouping (`parent_trade_id ?? id`). 깊은 chain (T1→T2→T3) 처리 한계는 trade-report.ts와 동일. root parent resolver 도입 시 본 스크립트도 함께 갱신 필요.');
  lines.push('- `stop_loss == 0` 인 legacy row는 R 계산에서 NaN 처리 + actualBucket=UNKNOWN (legacy v3 이전 데이터).');
  lines.push('- `exit_anomaly_reason IS NULL` 필터로 Phase E fake-fill 마커가 있는 row는 제외. `--include-dirty` 로 해제 가능.');
  lines.push(`- Phase X1 acceptance gate (≥ ${args.sampleGate} clean trades) 미달 시 본 결과로 가설 분기 금지.`);
  lines.push('- **measurement gap**: `exit_reason`은 monitor loop가 발동시킨 *trigger intent*고, `exit_price`는 Jupiter swap의 *actual fill*이다. 메모코인 빠른 변동 + swap latency 때문에 두 값이 자주 분리된다. Phase X3 판단은 actual bucket을 사용해야 한다 (intent 기반 hit rate는 over-counting).');
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs();
  const allTrades = loadTrades(args);
  const closed = allTrades.filter((t) => t.status === 'CLOSED');
  const droppedDirty = args.includeDirty
    ? 0
    : closed.filter((t) => t.exit_anomaly_reason != null).length;
  const filtered = closed.filter((t) => {
    if (!args.includeDirty && t.exit_anomaly_reason != null) return false;
    if (args.strategyFilter && t.strategy !== args.strategyFilter) return false;
    return true;
  });
  const groups = groupByParent(filtered);
  const report = buildReport(groups, args, allTrades.length, droppedDirty);
  console.log(report);
  if (args.outPath) {
    const outAbs = path.resolve(process.cwd(), args.outPath);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, report);
    console.log(`\nReport written to: ${outAbs}`);
  }
}

main();
