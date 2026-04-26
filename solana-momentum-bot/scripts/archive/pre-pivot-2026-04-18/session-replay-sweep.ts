#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { renderSessionReplaySweepReport } from '../src/reporting/sessionReplaySweepReport';

type StrategyName = 'bootstrap_10s' | 'volume_spike' | 'fib_pullback';
// Why: 'focused' = 2026-04-07 P0 audit 이후 bootstrap 전용 12-combo 핵심 grid. standard=135 → focused=12로
// samples/combo를 0.067 → 0.75로 상승. swaps replay만 truth이므로 volume/fib는 focused 미지원.
type GridPreset = 'standard' | 'wide' | 'focused';
type InputMode = 'auto' | 'swaps' | 'candles';

interface SessionInfo {
  id: string;
  storedSignals: number;
}

interface ProfileResult {
  id: string;
  params: Record<string, number>;
  rows: Array<{ sessionId: string; summary: string }>;
  sortKey: number[];
  summary: string;
}

const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'results');

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback: string) => {
    const index = args.indexOf(flag);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
  };
  return {
    strategy: get('--strategy', 'bootstrap_10s') as StrategyName,
    gridPreset: get('--grid-preset', 'standard') as GridPreset,
    top: Number(get('--top', '10')),
    maxProfiles: Number(get('--max-profiles', '0')),
    sessionCount: Number(get('--session-count', '5')),
    minStoredSignals: Number(get('--min-stored-signals', '1')),
    includeLegacy: args.includes('--include-legacy'),
    saveBase: get('--save', `session-replay-sweep-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`),
    bootstrapHorizon: Number(get('--bootstrap-horizon', '180')),
    estimatedCostPct: Number(get('--estimated-cost-pct', '0.003')),
    inputMode: get('--input-mode', 'auto') as InputMode,
  };
}

function listSessions(minStoredSignals: number, sessionCount: number, includeLegacy: boolean): SessionInfo[] {
  const root = path.join(ROOT, 'data/realtime/sessions');
  const entries = fs.readdirSync(root)
    .filter((name) => name.endsWith('-live') || (includeLegacy && name.startsWith('legacy-')))
    .map((name) => {
      const signalsPath = path.join(root, name, 'realtime-signals.jsonl');
      const storedSignals = fs.existsSync(signalsPath)
        ? fs.readFileSync(signalsPath, 'utf8').trim().split('\n').filter(Boolean).length
        : 0;
      return { id: name, storedSignals };
    })
    .filter((item) => item.storedSignals >= minStoredSignals)
    .sort((left, right) => right.storedSignals - left.storedSignals || left.id.localeCompare(right.id));
  return entries.slice(0, sessionCount);
}

function buildGrid(strategy: StrategyName, preset: GridPreset): Array<Record<string, number>> {
  let values: Record<string, number[]>;
  if (strategy === 'bootstrap_10s') {
    if (preset === 'focused') {
      // Why: 2026-04-07 P0 audit 기반 12-combo 핵심 grid. 04-06 swaps sweep top 10이 전부
      // vm∈[1.8,2.4] × br∈[0.55,0.65] × lb=20 × cd=180 영역에 집중된 사실을 반영.
      values = {
        volumeMultiplier: [1.8, 2.0, 2.2, 2.4],
        minBuyRatio: [0.55, 0.60, 0.65],
        volumeLookback: [20],
        cooldownSec: [180],
      };
    } else {
      values = {
        volumeMultiplier: preset === 'wide' ? [1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6] : [1.6, 1.8, 2.0, 2.2, 2.4],
        minBuyRatio: preset === 'wide' ? [0.50, 0.55, 0.60, 0.65, 0.70] : [0.55, 0.60, 0.65],
        volumeLookback: preset === 'wide' ? [10, 20, 30, 40] : [20, 30, 40],
        cooldownSec: preset === 'wide' ? [120, 180, 300, 420, 600] : [180, 300, 420],
      };
    }
  } else if (strategy === 'volume_spike') {
    if (preset === 'focused') {
      throw new Error("preset 'focused' is bootstrap_10s-only (volume_spike is dormant per 2026-04-07 P0 audit)");
    }
    values = {
      volumeMultiplier: preset === 'wide' ? [1.5, 2.0, 2.5, 3.0, 3.5] : [2.0, 2.5, 3.0, 3.5],
      minBreakoutScore: preset === 'wide' ? [30, 40, 50, 60, 70] : [40, 50, 60],
      minBuyRatio: preset === 'wide' ? [0.55, 0.60, 0.65, 0.70] : [0.60, 0.65],
      tp1Multiplier: preset === 'wide' ? [0.5, 0.75, 1.0, 1.25] : [0.75, 1.0],
      tp2Multiplier: preset === 'wide' ? [5.0, 7.5, 10.0, 12.5, 15.0] : [7.5, 10.0, 12.5],
      slAtrMultiplier: preset === 'wide' ? [0.75, 1.0, 1.25, 1.5] : [1.0, 1.25],
    };
  } else {
    if (preset === 'focused') {
      throw new Error("preset 'focused' is bootstrap_10s-only (fib_pullback is dormant per 2026-04-07 P0 audit)");
    }
    values = {
      impulseWindowBars: preset === 'wide' ? [4, 6, 8, 10, 12] : [6, 8, 10],
      impulseMinPct: preset === 'wide' ? [0.06, 0.08, 0.10, 0.12, 0.15] : [0.08, 0.10, 0.12, 0.15],
      tp1Multiplier: preset === 'wide' ? [0.75, 0.80, 0.85, 0.90, 0.95] : [0.80, 0.85, 0.90],
      timeStopMinutes: preset === 'wide' ? [15, 20, 30, 40, 60] : [20, 40, 60],
    };
  }
  return cartesian(values);
}

async function main() {
  const args = parseArgs();
  const sessions = listSessions(args.minStoredSignals, args.sessionCount, args.includeLegacy);
  if (sessions.length === 0) {
    throw new Error('No sessions matched the current filters');
  }

  const fullGrid = buildGrid(args.strategy, args.gridPreset);
  const grid = args.maxProfiles > 0 ? fullGrid.slice(0, args.maxProfiles) : fullGrid;
  const profiles = grid.map((params) => runProfile(args.strategy, params, sessions, args.bootstrapHorizon, args.estimatedCostPct, args.inputMode));
  const sorted = profiles.sort((left, right) => compareSortKey(left.sortKey, right.sortKey)).slice(0, args.top);
  const best = sorted[0];

  const title = `Session Replay Sweep — ${args.strategy}`;
  const report = renderSessionReplaySweepReport({
    title,
    generatedAt: new Date().toISOString(),
    strategy: args.strategy,
    mode: args.strategy === 'bootstrap_10s' ? 'realtime micro replay' : '5m price replay screening',
    inputMode: args.inputMode,
    gridPreset: args.gridPreset,
    gridSize: grid.length,
    sessions,
    topProfiles: sorted.map((profile) => ({ id: profile.id, summary: profile.summary })),
    bestProfileId: best?.id,
    bestProfileSummary: best?.summary,
    bestProfileRows: best?.rows ?? [],
    notes: buildNotes(args.strategy),
  });

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonPath = path.join(RESULTS_DIR, `${args.saveBase}.json`);
  const mdPath = path.join(RESULTS_DIR, `${args.saveBase}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify({ strategy: args.strategy, inputMode: args.inputMode, runner: 'session-replay-sweep.ts', gridSize: grid.length, sessions, profiles: sorted }, null, 2));
  fs.writeFileSync(mdPath, report, 'utf8');

  console.log(`Strategy: ${args.strategy} | Input mode: ${args.inputMode}`);
  console.log(`Grid: ${grid.length} profiles | Sessions: ${sessions.length}`);
  if (best) {
    console.log(`Best: ${best.id}`);
    console.log(best.summary);
  }
  console.log(`Saved: ${jsonPath}`);
  console.log(`Saved: ${mdPath}`);
}

function runProfile(
  strategy: StrategyName,
  params: Record<string, number>,
  sessions: SessionInfo[],
  bootstrapHorizon: number,
  estimatedCostPct: number,
  inputMode: InputMode
): ProfileResult {
  return strategy === 'bootstrap_10s'
    ? runBootstrapProfile(params, sessions, bootstrapHorizon, estimatedCostPct, inputMode)
    : runSessionProfile(strategy, params, sessions);
}

function runBootstrapProfile(params: Record<string, number>, sessions: SessionInfo[], horizon: number, estimatedCostPct: number, inputMode: InputMode): ProfileResult {
  let totalSignals = 0;
  let weightedAdjustedReturnPct = 0;
  let avgEdgeScore = 0;
  let gatePassSessions = 0;
  let keepLikeSessions = 0;
  const rows = sessions.map((session) => {
    const raw = execFileSync('npx', ['ts-node', 'scripts/micro-backtest.ts', '--dataset', `data/realtime/sessions/${session.id}`, '--trigger-type', 'bootstrap', '--input-mode', inputMode, '--gate-mode', 'stored', '--volume-multiplier', String(params.volumeMultiplier), '--min-buy-ratio', String(params.minBuyRatio), '--volume-lookback', String(params.volumeLookback), '--cooldown-sec', String(params.cooldownSec), '--estimated-cost-pct', String(estimatedCostPct), '--horizons', '30,60,180,300', '--horizon', String(horizon), '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
    const data = JSON.parse(raw.slice(raw.indexOf('{')));
    totalSignals += data.summary.totalSignals;
    weightedAdjustedReturnPct += data.summary.avgAdjustedReturnPct * data.summary.totalSignals;
    avgEdgeScore += data.summary.edgeScore;
    if (data.summary.edgeGateStatus !== 'fail') gatePassSessions++;
    if (['keep', 'keep_watch'].includes(data.summary.stageDecision)) keepLikeSessions++;
    return { sessionId: session.id, summary: `signals ${data.summary.totalSignals} | adj ${(data.summary.avgAdjustedReturnPct * 100).toFixed(2)}% | edge ${data.summary.edgeScore.toFixed(1)} | decision ${data.summary.stageDecision}` };
  });
  const weightedAdj = totalSignals > 0 ? weightedAdjustedReturnPct / totalSignals : 0;
  const avgEdge = sessions.length > 0 ? avgEdgeScore / sessions.length : 0;
  return { id: profileId(params), params, rows, sortKey: [-gatePassSessions, -keepLikeSessions, -weightedAdj, -avgEdge, -totalSignals], summary: `gate-pass ${gatePassSessions}/${sessions.length} | keep-like ${keepLikeSessions}/${sessions.length} | weighted adj ${(weightedAdj * 100).toFixed(2)}% | avg edge ${avgEdge.toFixed(1)} | total signals ${totalSignals}` };
}

function runSessionProfile(strategy: Exclude<StrategyName, 'bootstrap_10s'>, params: Record<string, number>, sessions: SessionInfo[]): ProfileResult {
  let totalTrades = 0;
  let avgStageScore = 0;
  let avgNetPnlPct = 0;
  let gatePassSessions = 0;
  let keepLikeSessions = 0;
  const rows = sessions.map((session) => {
    const args = ['ts-node', 'scripts/session-backtest.ts', '--dataset', `data/realtime/sessions/${session.id}`, '--strategy', strategy, '--json'];
    if (strategy === 'volume_spike') {
      args.push(
        '--vol-mult', String(params.volumeMultiplier),
        '--min-score', String(params.minBreakoutScore),
        '--min-buy-ratio', String(params.minBuyRatio),
        '--vol-tp1', String(params.tp1Multiplier),
        '--vol-tp2', String(params.tp2Multiplier),
        '--vol-sl-atr', String(params.slAtrMultiplier),
      );
    } else {
      args.push(
        '--fib-impulse-bars', String(params.impulseWindowBars),
        '--fib-impulse-min-pct', String(params.impulseMinPct),
        '--fib-tp1', String(params.tp1Multiplier),
        '--fib-time-stop', String(params.timeStopMinutes),
      );
    }
    const raw = execFileSync('npx', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
    const data = JSON.parse(raw);
    const active = data.summaries.filter((item: any) => item.totalTrades > 0);
    const trades = active.reduce((sum: number, item: any) => sum + item.totalTrades, 0);
    const positivePairs = active.filter((item: any) => item.netPnlPct > 0).length;
    const avgNet = average(active.map((item: any) => item.netPnlPct));
    const avgPF = average(active.map((item: any) => Number.isFinite(item.profitFactor) ? item.profitFactor : 5));
    const avgSharpe = average(active.map((item: any) => Number.isFinite(item.sharpeRatio) ? item.sharpeRatio : 0));
    const maxDd = max(active.map((item: any) => item.maxDrawdownPct));
    const stageScore = scoreStage(avgNet, avgPF, avgSharpe, trades, active.length > 0 ? positivePairs / active.length : 0, maxDd);
    totalTrades += trades;
    avgStageScore += stageScore.edgeScore;
    avgNetPnlPct += avgNet;
    if (stageScore.gateStatus !== 'fail') gatePassSessions++;
    if (['keep', 'keep_watch'].includes(stageScore.decision)) keepLikeSessions++;
    return { sessionId: session.id, summary: `trades ${trades} | active pairs ${active.length} | avg net ${(avgNet * 100).toFixed(2)}% | edge ${stageScore.edgeScore.toFixed(1)} | decision ${stageScore.decision}` };
  });
  const meanEdge = sessions.length > 0 ? avgStageScore / sessions.length : 0;
  const meanNet = sessions.length > 0 ? avgNetPnlPct / sessions.length : 0;
  return { id: profileId(params), params, rows, sortKey: [-gatePassSessions, -keepLikeSessions, -meanEdge, -totalTrades, -meanNet], summary: `gate-pass ${gatePassSessions}/${sessions.length} | keep-like ${keepLikeSessions}/${sessions.length} | avg edge ${meanEdge.toFixed(1)} | total trades ${totalTrades} | avg net ${(meanNet * 100).toFixed(2)}%` };
}

function scoreStage(netPnlPct: number, profitFactor: number, sharpeRatio: number, totalTrades: number, positiveTokenRatio: number, maxDrawdownPct: number) {
  const reasons: string[] = [];
  if (netPnlPct <= 0) reasons.push('netPnl<=0');
  if (profitFactor < 1.0) reasons.push('profitFactor<1.0');
  if (positiveTokenRatio < 0.4) reasons.push('positiveTokenRatio<40%');
  if (totalTrades < 10) reasons.push('totalTrades<10');
  const edgeScore = (netPnlPct > 0 ? 20 : 0) + (profitFactor >= 1.3 ? 10 : profitFactor >= 1 ? 5 : 0) + (sharpeRatio >= 1 ? 13 : sharpeRatio > 0 ? 5 : 0) + (maxDrawdownPct < 0.05 ? 8 : maxDrawdownPct < 0.1 ? 6 : 3) + (totalTrades >= 20 ? 6 : totalTrades >= 10 ? 3 : 0) + (positiveTokenRatio >= 0.6 ? 8 : positiveTokenRatio >= 0.5 ? 6 : positiveTokenRatio >= 0.4 ? 3 : 0);
  return { edgeScore, gateStatus: reasons.length > 0 ? 'fail' : 'pass', decision: reasons.length > 0 ? 'reject_gate' : edgeScore >= 80 ? 'keep' : edgeScore >= 70 ? 'keep_watch' : edgeScore >= 60 ? 'retune' : 'reject' };
}

function cartesian(values: Record<string, number[]>): Array<Record<string, number>> {
  const keys = Object.keys(values);
  const result: Array<Record<string, number>> = [];
  const walk = (index: number, current: Record<string, number>) => {
    if (index >= keys.length) {
      result.push({ ...current });
      return;
    }
    for (const value of values[keys[index]]) {
      current[keys[index]] = value;
      walk(index + 1, current);
    }
  };
  walk(0, {});
  return result;
}

function profileId(params: Record<string, number>): string {
  return Object.entries(params).map(([key, value]) => `${shortKey(key)}${value}`).join('-');
}

function shortKey(key: string): string {
  const mapping: Record<string, string> = { volumeMultiplier: 'vm', minBuyRatio: 'br', volumeLookback: 'lb', cooldownSec: 'cd', minBreakoutScore: 'sc', tp1Multiplier: 'tp1', tp2Multiplier: 'tp2', slAtrMultiplier: 'sl', impulseWindowBars: 'ib', impulseMinPct: 'ip', timeStopMinutes: 'ts' };
  return mapping[key] ?? key.slice(0, 3);
}

function compareSortKey(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function buildNotes(strategy: StrategyName): string[] {
  return strategy === 'bootstrap_10s'
    ? ['`bootstrap_10s` 결과는 realtime micro replay 기준이다.', 'ranking은 gate-pass session count와 weighted adjusted return을 우선한다.']
    : ['5m 전략 결과는 `price_replay_only` screening이다.', 'runtime gate/risk/execution equivalence로 해석하면 안 된다.'];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
