#!/usr/bin/env ts-node
/**
 * Strategy Backtest Comparison — 실제 운영 데이터로 두 전략 비교
 *
 * 기존 micro-candles.jsonl + signal-intents.jsonl 에서:
 *   1. Option β (ATR floor + SL/TP) exit 시뮬레이션
 *   2. Cupsey Lane (PROBE → REJECT/WINNER) exit 시뮬레이션
 *
 * 각 signal 에 대해 이후 candle 을 순회하며 어떤 exit 에 먼저 걸리는지 계산.
 *
 * Usage:
 *   npx ts-node scripts/analysis/strategy-backtest-compare.ts
 *   npx ts-node scripts/analysis/strategy-backtest-compare.ts --out docs/audits/strategy-compare-2026-04-11.md
 */

import fs from 'fs';
import path from 'path';

interface MicroCandle {
  pairAddress: string;
  tokenMint: string;
  timestamp: string;
  intervalSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
}

interface SignalIntent {
  id: string;
  pairAddress: string;
  tokenSymbol?: string;
  referencePrice: number;
  signalTimestamp: string;
  strategy: string;
  processing: { status: string; tradeId?: string };
}

// ─── Strategy Parameters ───

const OPTION_BETA = {
  name: 'Option β (ATR floor)',
  atrFloorPct: 0.008,
  slMultiplier: 1.25,
  tp1Multiplier: 1.5,
  tp2Multiplier: 5.0,
  timeStopSec: 20 * 60,
};

const CUPSEY_LANE = {
  name: 'Cupsey Lane v2 (STALK + wider trail)',
  // STALK: pullback 대기 (spike 꼭대기 매수 방지)
  stalkWindowSec: 20,
  stalkDropPct: 0.003,       // signal 에서 -0.3% pullback 시 entry
  stalkMaxDropPct: 0.015,    // -1.5% 이상이면 skip
  // PROBE
  probeWindowSec: 45,
  probeMfeThreshold: 0.0005, // +0.05% (완화)
  probeHardCutPct: 0.008,    // -0.8% (타이트)
  // WINNER
  winnerMaxHoldSec: 300,     // 5min
  winnerTrailingPct: 0.015,  // 1.5% (넓어짐)
};

// ─── Simulated Trade Result ───

interface SimResult {
  signalId: string;
  pairAddress: string;
  tokenSymbol: string;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  holdSec: number;
  pnlPct: number;
  isWin: boolean;
}

// ─── ATR Calculation ───

function calcATR(candles: MicroCandle[], period: number): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length && trs.length < period; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    trs.push(tr);
  }
  return trs.length > 0 ? trs.reduce((a, b) => a + b, 0) / trs.length : 0;
}

// ─── Option β Simulation ───

function simulateOptionBeta(
  entryPrice: number,
  entryTimeSec: number,
  candles: MicroCandle[]  // sorted by time, after entry
): SimResult | null {
  const rawAtr = calcATR(candles.slice(0, 20), 14);
  const effectiveAtr = Math.max(rawAtr, entryPrice * OPTION_BETA.atrFloorPct);

  const sl = entryPrice - effectiveAtr * OPTION_BETA.slMultiplier;
  const tp1 = entryPrice + effectiveAtr * OPTION_BETA.tp1Multiplier;
  const tp2 = entryPrice + effectiveAtr * OPTION_BETA.tp2Multiplier;

  for (const c of candles) {
    const cTimeSec = new Date(c.timestamp).getTime() / 1000;
    const elapsed = cTimeSec - entryTimeSec;
    if (elapsed < 0) continue;

    // Time stop
    if (elapsed >= OPTION_BETA.timeStopSec) {
      return makeResult(entryPrice, c.close, 'TIME_STOP', elapsed);
    }

    // SL
    if (c.low <= sl) {
      const exitPrice = Math.min(c.open, sl); // conservative: fill at SL or open
      return makeResult(entryPrice, exitPrice, 'STOP_LOSS', elapsed);
    }

    // TP2
    if (c.high >= tp2) {
      return makeResult(entryPrice, tp2, 'TAKE_PROFIT_2', elapsed);
    }

    // TP1 (full close — Option β tp1PartialPct = 0)
    if (c.high >= tp1) {
      return makeResult(entryPrice, tp1, 'TAKE_PROFIT_1', elapsed);
    }
  }

  // No exit within data → close at last candle
  const last = candles[candles.length - 1];
  if (last) {
    const elapsed = new Date(last.timestamp).getTime() / 1000 - entryTimeSec;
    return makeResult(entryPrice, last.close, 'DATA_END', elapsed);
  }
  return null;
}

// ─── Cupsey Lane Simulation ───

function simulateCupseyLane(
  signalPrice: number,
  signalTimeSec: number,
  candles: MicroCandle[]
): SimResult | null {
  let state: 'STALK' | 'PROBE' | 'WINNER' = 'STALK';
  let entryPrice = signalPrice;
  let entryTimeSec = signalTimeSec;
  let peakPrice = signalPrice;

  for (const c of candles) {
    const cTimeSec = new Date(c.timestamp).getTime() / 1000;

    // ─── STALK: pullback 대기 ───
    if (state === 'STALK') {
      const stalkElapsed = cTimeSec - signalTimeSec;
      if (stalkElapsed < 0) continue;

      const dropFromSignal = (c.low - signalPrice) / signalPrice;

      // Timeout → skip
      if (stalkElapsed >= CUPSEY_LANE.stalkWindowSec) {
        return makeResult(signalPrice, signalPrice, 'STALK_SKIP_TIMEOUT', stalkElapsed);
      }

      // Crash → skip
      if (dropFromSignal <= -CUPSEY_LANE.stalkMaxDropPct) {
        return makeResult(signalPrice, signalPrice, 'STALK_SKIP_CRASH', stalkElapsed);
      }

      // Pullback confirmed → PROBE entry
      if (dropFromSignal <= -CUPSEY_LANE.stalkDropPct) {
        entryPrice = signalPrice * (1 - CUPSEY_LANE.stalkDropPct); // entry at pullback level
        entryTimeSec = cTimeSec;
        peakPrice = entryPrice;
        state = 'PROBE';
        continue;
      }

      continue; // still waiting
    }

    // ─── PROBE / WINNER ───
    const elapsed = cTimeSec - entryTimeSec;
    if (elapsed < 0) continue;

    peakPrice = Math.max(peakPrice, c.high);
    const mfePct = (peakPrice - entryPrice) / entryPrice;
    const maePct = (c.low - entryPrice) / entryPrice;

    if (state === 'PROBE') {
      if (maePct <= -CUPSEY_LANE.probeHardCutPct) {
        return makeResult(entryPrice, c.low, 'REJECT_HARD_CUT', elapsed);
      }
      if (mfePct >= CUPSEY_LANE.probeMfeThreshold) {
        state = 'WINNER';
        continue;
      }
      if (elapsed >= CUPSEY_LANE.probeWindowSec) {
        return makeResult(entryPrice, c.close, 'REJECT_TIMEOUT', elapsed);
      }
    }

    if (state === 'WINNER') {
      if (elapsed >= CUPSEY_LANE.winnerMaxHoldSec) {
        return makeResult(entryPrice, c.close, 'WINNER_TIME_STOP', elapsed);
      }
      const trailingStop = peakPrice * (1 - CUPSEY_LANE.winnerTrailingPct);
      if (c.low <= trailingStop) {
        const exitPrice = Math.max(c.open, trailingStop);
        return makeResult(entryPrice, exitPrice, 'WINNER_TRAILING', elapsed);
      }
    }
  }

  const last = candles[candles.length - 1];
  if (last) {
    const elapsed = new Date(last.timestamp).getTime() / 1000 - entryTimeSec;
    return makeResult(entryPrice, last.close, 'DATA_END', elapsed);
  }
  return null;
}

function makeResult(
  entryPrice: number, exitPrice: number, exitReason: string, holdSec: number
): SimResult {
  const pnlPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
  return {
    signalId: '', pairAddress: '', tokenSymbol: '',
    entryPrice, exitPrice, exitReason,
    holdSec, pnlPct, isWin: pnlPct > 0,
  };
}

// ─── Main ───

function loadJsonl<T>(filepath: string): T[] {
  if (!fs.existsSync(filepath)) return [];
  return fs.readFileSync(filepath, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
    .filter((x): x is T => x !== null);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function main(): void {
  const args = process.argv.slice(2);
  let outPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) { outPath = args[i + 1]; i++; }
  }

  const sessionsRoot = path.resolve(process.cwd(), 'data/realtime/sessions');
  const sessionDirs = fs.readdirSync(sessionsRoot)
    .filter(d => d.endsWith('-live'))
    .map(d => path.join(sessionsRoot, d))
    .filter(d =>
      fs.existsSync(path.join(d, 'signal-intents.jsonl')) &&
      fs.existsSync(path.join(d, 'micro-candles.jsonl'))
    );

  console.error(`Sessions: ${sessionDirs.length}`);

  const betaResults: SimResult[] = [];
  const cupseyResults: SimResult[] = [];

  for (const sessionDir of sessionDirs) {
    const signals = loadJsonl<SignalIntent>(path.join(sessionDir, 'signal-intents.jsonl'));
    const candles = loadJsonl<MicroCandle>(path.join(sessionDir, 'micro-candles.jsonl'))
      .filter(c => c.intervalSec === 10);

    // Index candles by pair
    const candleIndex = new Map<string, MicroCandle[]>();
    for (const c of candles) {
      const key = c.pairAddress || c.tokenMint;
      if (!candleIndex.has(key)) candleIndex.set(key, []);
      candleIndex.get(key)!.push(c);
    }
    for (const arr of candleIndex.values()) {
      arr.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }

    // Filter to executed signals
    const executed = signals.filter(s =>
      s.processing.status === 'executed_live' || s.processing.status === 'executed_paper'
    );

    for (const signal of executed) {
      const entryPrice = signal.referencePrice;
      if (!entryPrice || entryPrice <= 0) continue;

      const entryTimeSec = new Date(signal.signalTimestamp).getTime() / 1000;
      const pairKey = signal.pairAddress;
      const pairCandles = candleIndex.get(pairKey);
      if (!pairCandles || pairCandles.length < 10) continue;

      // Filter candles after entry
      const afterEntry = pairCandles.filter(c =>
        new Date(c.timestamp).getTime() / 1000 >= entryTimeSec
      );
      if (afterEntry.length < 3) continue;

      // Simulate both strategies
      const beta = simulateOptionBeta(entryPrice, entryTimeSec, afterEntry);
      const cupsey = simulateCupseyLane(entryPrice, entryTimeSec, afterEntry);

      if (beta) {
        beta.signalId = signal.id;
        beta.pairAddress = pairKey;
        beta.tokenSymbol = signal.tokenSymbol || pairKey.slice(0, 8);
        betaResults.push(beta);
      }
      if (cupsey) {
        cupsey.signalId = signal.id;
        cupsey.pairAddress = pairKey;
        cupsey.tokenSymbol = signal.tokenSymbol || pairKey.slice(0, 8);
        cupseyResults.push(cupsey);
      }
    }

    console.error(`  ${path.basename(sessionDir)}: ${executed.length} executed, ${betaResults.length} simulated`);
  }

  // ─── Render ───
  const lines: string[] = [];
  lines.push(`# Strategy Backtest Comparison (Real Operational Data)`);
  lines.push('');
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push(`> Sessions: ${sessionDirs.length}`);
  lines.push(`> Signals simulated: ${betaResults.length}`);
  lines.push('');

  for (const { name, results } of [
    { name: OPTION_BETA.name, results: betaResults },
    { name: CUPSEY_LANE.name, results: cupseyResults },
  ]) {
    if (results.length === 0) { lines.push(`## ${name}: no results\n`); continue; }

    const wins = results.filter(r => r.isWin);
    const losses = results.filter(r => !r.isWin);
    const wr = (wins.length / results.length) * 100;
    const pnls = results.map(r => r.pnlPct).sort((a, b) => a - b);
    const winPnls = wins.map(r => r.pnlPct).sort((a, b) => a - b);
    const lossPnls = losses.map(r => r.pnlPct).sort((a, b) => a - b);
    const holds = results.map(r => r.holdSec).sort((a, b) => a - b);

    lines.push(`## ${name}`);
    lines.push('');
    lines.push(`| metric | value |`);
    lines.push(`|---|---|`);
    lines.push(`| simulated trades | ${results.length} |`);
    lines.push(`| wins / losses | ${wins.length}W / ${losses.length}L |`);
    lines.push(`| **win rate** | **${wr.toFixed(1)}%** |`);
    lines.push(`| avg PnL % | ${(pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(3)}% |`);
    lines.push(`| median PnL % | ${quantile(pnls, 0.5).toFixed(3)}% |`);
    if (winPnls.length > 0)
      lines.push(`| avg win % | +${(winPnls.reduce((a, b) => a + b, 0) / winPnls.length).toFixed(3)}% |`);
    if (lossPnls.length > 0)
      lines.push(`| avg loss % | ${(lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length).toFixed(3)}% |`);
    if (winPnls.length > 0 && lossPnls.length > 0) {
      const avgWin = winPnls.reduce((a, b) => a + b, 0) / winPnls.length;
      const avgLoss = Math.abs(lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length);
      lines.push(`| **win/loss ratio** | **${(avgWin / avgLoss).toFixed(2)}x** |`);
      const expectancy = (wr / 100) * avgWin - (1 - wr / 100) * avgLoss;
      lines.push(`| **expectancy** | **${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(3)}% per trade** |`);
    }
    lines.push(`| hold time p25 | ${fmtTime(quantile(holds, 0.25))} |`);
    lines.push(`| hold time p50 | ${fmtTime(quantile(holds, 0.5))} |`);
    lines.push(`| hold time p75 | ${fmtTime(quantile(holds, 0.75))} |`);
    lines.push('');

    // Exit reason breakdown
    const reasons = new Map<string, number>();
    for (const r of results) reasons.set(r.exitReason, (reasons.get(r.exitReason) ?? 0) + 1);
    lines.push(`| exit reason | count | % |`);
    lines.push(`|---|---:|---:|`);
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${reason} | ${count} | ${(count / results.length * 100).toFixed(1)}% |`);
    }
    lines.push('');
  }

  // Head-to-head comparison
  if (betaResults.length > 0 && cupseyResults.length > 0) {
    lines.push(`## Head-to-Head Comparison`);
    lines.push('');
    lines.push(`| metric | Option β | Cupsey Lane | winner |`);
    lines.push(`|---|---|---|---|`);

    const bWR = betaResults.filter(r => r.isWin).length / betaResults.length * 100;
    const cWR = cupseyResults.filter(r => r.isWin).length / cupseyResults.length * 100;
    lines.push(`| WR | ${bWR.toFixed(1)}% | ${cWR.toFixed(1)}% | ${bWR > cWR ? 'Option β' : cWR > bWR ? 'Cupsey' : 'Tie'} |`);

    const bAvg = betaResults.reduce((s, r) => s + r.pnlPct, 0) / betaResults.length;
    const cAvg = cupseyResults.reduce((s, r) => s + r.pnlPct, 0) / cupseyResults.length;
    lines.push(`| avg PnL % | ${bAvg >= 0 ? '+' : ''}${bAvg.toFixed(3)}% | ${cAvg >= 0 ? '+' : ''}${cAvg.toFixed(3)}% | ${bAvg > cAvg ? 'Option β' : 'Cupsey'} |`);

    const bHold = quantile(betaResults.map(r => r.holdSec).sort((a, b) => a - b), 0.5);
    const cHold = quantile(cupseyResults.map(r => r.holdSec).sort((a, b) => a - b), 0.5);
    lines.push(`| hold p50 | ${fmtTime(bHold)} | ${fmtTime(cHold)} | ${cHold < bHold ? 'Cupsey (빠름)' : 'Option β'} |`);

    // Per-signal comparison
    let cupseyBetter = 0;
    let betaBetter = 0;
    let tie = 0;
    for (let i = 0; i < Math.min(betaResults.length, cupseyResults.length); i++) {
      if (cupseyResults[i].pnlPct > betaResults[i].pnlPct) cupseyBetter++;
      else if (betaResults[i].pnlPct > cupseyResults[i].pnlPct) betaBetter++;
      else tie++;
    }
    lines.push(`| per-signal winner | ${betaBetter} signals | ${cupseyBetter} signals | ${cupseyBetter > betaBetter ? 'Cupsey' : 'Option β'} (${tie} ties) |`);
    lines.push('');
  }

  const md = lines.join('\n');
  if (outPath) {
    const fp = path.resolve(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, md);
    console.error(`Wrote ${fp}`);
  } else {
    process.stdout.write(md);
  }
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) return 'n/a';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

main();
