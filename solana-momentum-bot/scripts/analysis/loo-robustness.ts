#!/usr/bin/env ts-node
/**
 * Leave-One-Out (LOO) Robustness Analysis
 *
 * Why: 2026-04-07 P2 — 04-06 swaps sweep top profile vm2.4-br0.65-lb20-cd180의
 * +24.02%가 outlier 1-2 세션에 의존하는지 정량 검증한다. Top 5 profiles 각각에
 * 대해 9개 LOO 변형을 계산하고, 다음 robust criteria를 적용한다:
 *   - rank Δ ≤ 1 (top 5 안에서 순위 1단계 이하 변동)
 *   - 부호 유지 (LOO 후 weighted adj가 양수 유지)
 *   - gate-pass ≥ baseline − 1 (passing session 1개 제거의 자연 감소만 허용)
 */

import fs from 'fs';
import path from 'path';

interface ProfileRow {
  sessionId: string;
  summary: string;
}

interface Profile {
  id: string;
  params: Record<string, number>;
  rows: ProfileRow[];
  sortKey: number[];
  summary: string;
}

interface SweepData {
  strategy: string;
  inputMode: string;
  runner: string;
  gridSize: number;
  sessions: Array<{ id: string; storedSignals: number }>;
  profiles: Profile[];
}

interface ParsedRow {
  sessionId: string;
  signals: number;
  adj: number;
  edge: number;
  decision: string;
}

const GATE_PASS_DECISIONS = new Set(['keep', 'keep_watch']);

function parseRow(row: ProfileRow): ParsedRow {
  // Why: row.summary 형식 = "signals N | adj X.XX% | edge Y.Y | decision label"
  const signalsMatch = row.summary.match(/signals\s+(\d+)/);
  const adjMatch = row.summary.match(/adj\s+(-?[\d.]+)%/);
  const edgeMatch = row.summary.match(/edge\s+([\d.]+)/);
  const decisionMatch = row.summary.match(/decision\s+(\w+)/);
  if (!signalsMatch || !adjMatch || !edgeMatch || !decisionMatch) {
    throw new Error(`Failed to parse row: ${row.summary}`);
  }
  return {
    sessionId: row.sessionId,
    signals: Number(signalsMatch[1]),
    adj: Number(adjMatch[1]),
    edge: Number(edgeMatch[1]),
    decision: decisionMatch[1],
  };
}

function weightedAdj(rows: ParsedRow[]): number {
  const totalSignals = rows.reduce((sum, row) => sum + row.signals, 0);
  if (totalSignals === 0) return 0;
  const weighted = rows.reduce((sum, row) => sum + row.signals * row.adj, 0);
  return weighted / totalSignals;
}

function gatePassCount(rows: ParsedRow[]): number {
  return rows.filter((row) => GATE_PASS_DECISIONS.has(row.decision)).length;
}

function avgEdge(rows: ParsedRow[]): number {
  if (rows.length === 0) return 0;
  return rows.reduce((sum, row) => sum + row.edge, 0) / rows.length;
}

interface ProfileSummary {
  id: string;
  params: Record<string, number>;
  parsed: ParsedRow[];
  weightedAdj: number;
  gatePass: number;
  avgEdge: number;
  totalSignals: number;
}

function buildProfileSummary(profile: Profile): ProfileSummary {
  const parsed = profile.rows.map(parseRow);
  return {
    id: profile.id,
    params: profile.params,
    parsed,
    weightedAdj: weightedAdj(parsed),
    gatePass: gatePassCount(parsed),
    avgEdge: avgEdge(parsed),
    totalSignals: parsed.reduce((sum, row) => sum + row.signals, 0),
  };
}

interface LooResult {
  droppedSession: string;
  weightedAdj: number;
  gatePass: number;
  avgEdge: number;
  totalSignals: number;
}

function computeLoo(parsed: ParsedRow[]): LooResult[] {
  return parsed.map((dropped) => {
    const remaining = parsed.filter((row) => row.sessionId !== dropped.sessionId);
    return {
      droppedSession: dropped.sessionId,
      weightedAdj: weightedAdj(remaining),
      gatePass: gatePassCount(remaining),
      avgEdge: avgEdge(remaining),
      totalSignals: remaining.reduce((sum, row) => sum + row.signals, 0),
    };
  });
}

function rankProfiles(summaries: ProfileSummary[]): Map<string, number> {
  const sorted = [...summaries].sort((left, right) => right.weightedAdj - left.weightedAdj);
  const ranks = new Map<string, number>();
  sorted.forEach((profile, index) => ranks.set(profile.id, index + 1));
  return ranks;
}

function rankProfilesAfterLoo(summaries: ProfileSummary[], droppedSession: string): Map<string, number> {
  const looSummaries = summaries.map((profile) => {
    const remaining = profile.parsed.filter((row) => row.sessionId !== droppedSession);
    return { id: profile.id, weightedAdj: weightedAdj(remaining) };
  });
  const sorted = looSummaries.sort((left, right) => right.weightedAdj - left.weightedAdj);
  const ranks = new Map<string, number>();
  sorted.forEach((profile, index) => ranks.set(profile.id, index + 1));
  return ranks;
}

function fmt(value: number, digits = 2): string {
  return value.toFixed(digits);
}

function main() {
  const args = process.argv.slice(2);
  const inputArg = args[0] ?? 'results/session-replay-sweep-bootstrap-swaps-focused-2026-04-07.json';
  const topNArg = Number(args[1] ?? '5');
  const outputArg = args[2] ?? 'docs/audits/bootstrap-loo-robustness-2026-04-07.md';

  const inputPath = path.resolve(inputArg);
  const data: SweepData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

  const summaries = data.profiles.map(buildProfileSummary);
  const baselineRanks = rankProfiles(summaries);
  const sessionCount = data.sessions.length;

  const topProfiles = [...summaries]
    .sort((left, right) => right.weightedAdj - left.weightedAdj)
    .slice(0, topNArg);

  const lines: string[] = [];
  lines.push(`# Bootstrap LOO Robustness Analysis — 2026-04-07`);
  lines.push('');
  lines.push(`> Source: \`${path.relative(path.resolve('.'), inputPath)}\``);
  lines.push(`> Strategy: ${data.strategy} | Input: ${data.inputMode} | Grid: ${data.gridSize} profiles`);
  lines.push(`> Sessions: ${sessionCount} | Top profiles analyzed: ${topNArg}`);
  lines.push('');
  lines.push('## Robust Criteria');
  lines.push('');
  lines.push('1. **Rank Δ ≤ 1**: 모든 LOO 변형에서 top 5 안 순위 1단계 이하 변동');
  lines.push('2. **Sign hold**: 모든 LOO 변형에서 weighted adj > 0');
  lines.push(`3. **Gate-pass floor**: 모든 LOO 변형에서 gate-pass ≥ baseline − 1 (passing 세션 1개 제거의 자연 감소만 허용)`);
  lines.push('');
  lines.push('## Baseline (10 sessions)');
  lines.push('');
  lines.push('| Rank | Profile | Weighted Adj | Gate-pass | Avg Edge | Signals |');
  lines.push('|---:|---|---:|---:|---:|---:|');
  topProfiles.forEach((profile, index) => {
    lines.push(`| ${index + 1} | ${profile.id} | ${fmt(profile.weightedAdj)}% | ${profile.gatePass}/${sessionCount} | ${fmt(profile.avgEdge, 1)} | ${profile.totalSignals} |`);
  });
  lines.push('');

  // Per-profile LOO breakdown
  for (const profile of topProfiles) {
    const looResults = computeLoo(profile.parsed);
    const baselineRank = baselineRanks.get(profile.id) ?? 0;
    const baselineGatePass = profile.gatePass;
    const gatePassFloor = Math.max(0, baselineGatePass - 1);

    let allRankOk = true;
    let allSignOk = true;
    let allGateOk = true;
    let maxRankDelta = 0;
    let minLooAdj = Infinity;
    let minLooGatePass = Infinity;

    lines.push(`## ${profile.id}`);
    lines.push('');
    lines.push(`- Baseline: rank ${baselineRank} | weighted adj ${fmt(profile.weightedAdj)}% | gate-pass ${baselineGatePass}/${sessionCount}`);
    lines.push(`- Gate-pass floor (${sessionCount - 1} sessions): ${gatePassFloor}/${sessionCount - 1}`);
    lines.push('');
    lines.push('| Dropped Session | LOO Adj | Δ vs base | LOO Gate-pass | LOO Rank | Rank Δ |');
    lines.push('|---|---:|---:|---:|---:|---:|');

    for (const result of looResults) {
      const delta = result.weightedAdj - profile.weightedAdj;
      const looRanks = rankProfilesAfterLoo(summaries, result.droppedSession);
      const looRank = looRanks.get(profile.id) ?? 0;
      const rankDelta = looRank - baselineRank;
      const rankOk = Math.abs(rankDelta) <= 1;
      const signOk = result.weightedAdj > 0;
      const gateOk = result.gatePass >= gatePassFloor;

      if (!rankOk) allRankOk = false;
      if (!signOk) allSignOk = false;
      if (!gateOk) allGateOk = false;
      if (Math.abs(rankDelta) > maxRankDelta) maxRankDelta = Math.abs(rankDelta);
      if (result.weightedAdj < minLooAdj) minLooAdj = result.weightedAdj;
      if (result.gatePass < minLooGatePass) minLooGatePass = result.gatePass;

      const flags: string[] = [];
      if (!rankOk) flags.push('rank');
      if (!signOk) flags.push('sign');
      if (!gateOk) flags.push('gate');
      const flagStr = flags.length > 0 ? ` ⚠ ${flags.join(',')}` : '';

      lines.push(`| ${result.droppedSession} | ${fmt(result.weightedAdj)}% | ${delta >= 0 ? '+' : ''}${fmt(delta)}pp | ${result.gatePass}/${sessionCount - 1} | ${looRank} | ${rankDelta >= 0 ? '+' : ''}${rankDelta}${flagStr} |`);
    }

    lines.push('');
    const overallRobust = allRankOk && allSignOk && allGateOk;
    lines.push('### Verdict');
    lines.push('');
    lines.push(`- Rank stability: ${allRankOk ? 'PASS' : 'FAIL'} (max Δ = ${maxRankDelta})`);
    lines.push(`- Sign hold: ${allSignOk ? 'PASS' : 'FAIL'} (min LOO adj = ${fmt(minLooAdj)}%)`);
    lines.push(`- Gate-pass floor: ${allGateOk ? 'PASS' : 'FAIL'} (min LOO gate-pass = ${minLooGatePass}/${sessionCount - 1})`);
    lines.push(`- **Overall: ${overallRobust ? 'ROBUST' : 'FRAGILE'}**`);
    lines.push('');
  }

  // Compact summary table
  lines.push('## Summary Table');
  lines.push('');
  lines.push('| Profile | Baseline Adj | Min LOO Adj | Max Adj Δ (pp) | Max Rank Δ | Sign Hold | Gate Hold | Verdict |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const profile of topProfiles) {
    const looResults = computeLoo(profile.parsed);
    const baselineRank = baselineRanks.get(profile.id) ?? 0;
    const baselineGatePass = profile.gatePass;
    const gatePassFloor = Math.max(0, baselineGatePass - 1);

    let allRankOk = true;
    let allSignOk = true;
    let allGateOk = true;
    let maxRankDelta = 0;
    let minLooAdj = Infinity;
    let maxAdjDelta = 0;

    for (const result of looResults) {
      const delta = Math.abs(result.weightedAdj - profile.weightedAdj);
      const looRanks = rankProfilesAfterLoo(summaries, result.droppedSession);
      const looRank = looRanks.get(profile.id) ?? 0;
      const rankDelta = Math.abs(looRank - baselineRank);
      if (rankDelta > 1) allRankOk = false;
      if (result.weightedAdj <= 0) allSignOk = false;
      if (result.gatePass < gatePassFloor) allGateOk = false;
      if (rankDelta > maxRankDelta) maxRankDelta = rankDelta;
      if (result.weightedAdj < minLooAdj) minLooAdj = result.weightedAdj;
      if (delta > maxAdjDelta) maxAdjDelta = delta;
    }

    const verdict = allRankOk && allSignOk && allGateOk ? 'ROBUST' : 'FRAGILE';
    lines.push(`| ${profile.id} | ${fmt(profile.weightedAdj)}% | ${fmt(minLooAdj)}% | ${fmt(maxAdjDelta)} | ${maxRankDelta} | ${allSignOk ? 'OK' : 'FAIL'} | ${allGateOk ? 'OK' : 'FAIL'} | ${verdict} |`);
  }
  lines.push('');

  // Identify which session(s) drive the headline
  lines.push('## Outlier Contribution');
  lines.push('');
  lines.push('Best profile에서 각 세션이 weighted adj에 기여하는 비율:');
  lines.push('');
  const best = topProfiles[0];
  const totalSignals = best.totalSignals;
  const totalWeighted = best.parsed.reduce((sum, row) => sum + row.signals * row.adj, 0);
  lines.push(`- Profile: \`${best.id}\``);
  lines.push(`- Total signals: ${totalSignals} | Weighted sum: ${fmt(totalWeighted)} | Weighted adj: ${fmt(best.weightedAdj)}%`);
  lines.push('');
  lines.push('| Session | Signals | Adj | Contribution (signals × adj) | % of total |');
  lines.push('|---|---:|---:|---:|---:|');
  const sortedRows = [...best.parsed].sort((left, right) => Math.abs(right.signals * right.adj) - Math.abs(left.signals * left.adj));
  for (const row of sortedRows) {
    const contribution = row.signals * row.adj;
    const pct = totalWeighted !== 0 ? (contribution / totalWeighted) * 100 : 0;
    lines.push(`| ${row.sessionId} | ${row.signals} | ${fmt(row.adj)}% | ${fmt(contribution)} | ${fmt(pct, 1)}% |`);
  }
  lines.push('');

  // Leave-Two-Out stress test: drop top-2 contributing sessions for the best profile
  lines.push('## Leave-Two-Out Stress (Best Profile)');
  lines.push('');
  lines.push('Best profile에서 절대 기여도 상위 2개 세션을 동시에 제거한 worst-case 시나리오:');
  lines.push('');
  const stressBest = topProfiles[0];
  const sortedByContribution = [...stressBest.parsed].sort((left, right) => Math.abs(right.signals * right.adj) - Math.abs(left.signals * left.adj));
  const top1 = sortedByContribution[0];
  const top2 = sortedByContribution[1];
  const dropOne1 = stressBest.parsed.filter((row) => row.sessionId !== top1.sessionId);
  const dropOne2 = stressBest.parsed.filter((row) => row.sessionId !== top2.sessionId);
  const dropBoth = stressBest.parsed.filter((row) => row.sessionId !== top1.sessionId && row.sessionId !== top2.sessionId);

  lines.push(`- Profile: \`${stressBest.id}\``);
  lines.push(`- Top contributor #1: ${top1.sessionId} (${fmt((top1.signals * top1.adj / stressBest.parsed.reduce((s, r) => s + r.signals * r.adj, 0)) * 100, 1)}% of total)`);
  lines.push(`- Top contributor #2: ${top2.sessionId} (${fmt((top2.signals * top2.adj / stressBest.parsed.reduce((s, r) => s + r.signals * r.adj, 0)) * 100, 1)}% of total)`);
  lines.push('');
  lines.push('| Scenario | Sessions | Weighted Adj | Δ vs base | Gate-pass |');
  lines.push('|---|---:|---:|---:|---:|');
  lines.push(`| Baseline | ${stressBest.parsed.length} | ${fmt(stressBest.weightedAdj)}% | — | ${stressBest.gatePass}/${sessionCount} |`);
  lines.push(`| Drop #1 only | ${dropOne1.length} | ${fmt(weightedAdj(dropOne1))}% | ${fmt(weightedAdj(dropOne1) - stressBest.weightedAdj)}pp | ${gatePassCount(dropOne1)}/${dropOne1.length} |`);
  lines.push(`| Drop #2 only | ${dropOne2.length} | ${fmt(weightedAdj(dropOne2))}% | ${fmt(weightedAdj(dropOne2) - stressBest.weightedAdj)}pp | ${gatePassCount(dropOne2)}/${dropOne2.length} |`);
  lines.push(`| **Drop both** | ${dropBoth.length} | **${fmt(weightedAdj(dropBoth))}%** | **${fmt(weightedAdj(dropBoth) - stressBest.weightedAdj)}pp** | ${gatePassCount(dropBoth)}/${dropBoth.length} |`);
  lines.push('');
  const lo2oAdj = weightedAdj(dropBoth);
  const lo2oVerdict = lo2oAdj > 0 ? (lo2oAdj > 5 ? 'LO2O sign + magnitude hold (>+5%)' : 'LO2O sign hold only (≤+5%, marginal)') : 'LO2O sign FAIL — outlier-driven';
  lines.push(`**LO2O verdict**: ${lo2oVerdict}`);
  lines.push('');

  const outputPath = path.resolve(outputArg);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join('\n'));
  console.log(`Saved: ${outputPath}`);
}

main();
