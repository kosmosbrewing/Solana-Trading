#!/usr/bin/env ts-node
/**
 * Post-Entry Trajectory Analysis (Phase 1 — cupsey quick reject 유효성 검증)
 *
 * Why: cupsey 는 진입 후 25-30초에 "안 움직이면 즉시 자름". 우리 데이터에서도
 * 진입 후 30초 MFE 가 winner/loser 를 유의미하게 분류하는지 검증한다.
 * 이게 확인되면 "quick reject overlay" (cupsey lane) 구현의 데이터 근거가 된다.
 *
 * Inputs:
 *   - data/realtime/sessions/<session>/signal-intents.jsonl (진입 시점 + 가격)
 *   - data/realtime/sessions/<session>/micro-candles.jsonl (이후 가격 추적)
 *   - data/vps-trades-latest.jsonl (최종 outcome — win/loss/PnL)
 *
 * Output:
 *   - Per-signal MFE/MAE at 10s/30s/60s/120s/300s horizons
 *   - "30s MFE > threshold" → winner 예측 정확도
 *   - quick reject 가 아꼈을 예상 SOL
 *   - Strategy calibration 권장
 *
 * Usage:
 *   npx ts-node scripts/analysis/post-entry-trajectory.ts
 *   npx ts-node scripts/analysis/post-entry-trajectory.ts --session data/realtime/sessions/2026-04-08T09-48-10-685Z-live
 *   npx ts-node scripts/analysis/post-entry-trajectory.ts --out docs/audits/post-entry-trajectory-2026-04-10.md
 */

import fs from 'fs';
import path from 'path';

interface SignalIntent {
  id: string;
  pairAddress: string;
  tokenMint: string;
  tokenSymbol?: string;
  referencePrice: number;
  signalTimestamp: string;
  strategy: string;
  processing: {
    status: string;
    filterReason?: string;
    tradeId?: string;
  };
  gate?: {
    rejected: boolean;
  };
}

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
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
}

interface TradeRow {
  id: string;
  pair_address: string;
  entry_price: number | string;
  exit_price: number | string | null;
  pnl: number | string | null;
  status: string;
  exit_reason: string | null;
  exit_anomaly_reason: string | null;
  created_at: string;
}

interface TrajectoryPoint {
  horizonSec: number;
  mfePct: number;  // max favorable excursion up to this horizon
  maePct: number;  // max adverse excursion up to this horizon
  closePct: number; // price at horizon vs entry
}

interface SignalTrajectory {
  signalId: string;
  pairAddress: string;
  tokenSymbol: string;
  entryPrice: number;
  entryTimeSec: number;
  processingStatus: string;
  tradeId?: string;
  finalPnl?: number;
  finalExitReason?: string;
  isCleanWin?: boolean;
  trajectory: TrajectoryPoint[];
}

interface Args {
  sessionDirs: string[];
  tradesPath: string;
  outPath: string | null;
  horizons: number[];
  quickRejectThresholdPct: number;
  quickRejectHorizonSec: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    sessionDirs: [],
    tradesPath: 'data/vps-trades-latest.jsonl',
    outPath: null,
    horizons: [10, 30, 60, 120, 300],
    quickRejectThresholdPct: 0.3,
    quickRejectHorizonSec: 30,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--session' && value) { args.sessionDirs.push(value); i++; }
    else if (flag === '--trades' && value) { args.tradesPath = value; i++; }
    else if (flag === '--out' && value) { args.outPath = value; i++; }
    else if (flag === '--threshold' && value) { args.quickRejectThresholdPct = Number(value); i++; }
    else if (flag === '--reject-horizon' && value) { args.quickRejectHorizonSec = Number(value); i++; }
  }

  // Auto-discover sessions if none specified
  if (args.sessionDirs.length === 0) {
    const sessionsRoot = path.resolve(process.cwd(), 'data/realtime/sessions');
    if (fs.existsSync(sessionsRoot)) {
      const dirs = fs.readdirSync(sessionsRoot)
        .filter(d => d.endsWith('-live'))
        .map(d => path.join(sessionsRoot, d))
        .filter(d => fs.existsSync(path.join(d, 'signal-intents.jsonl')) &&
                      fs.existsSync(path.join(d, 'micro-candles.jsonl')));
      args.sessionDirs = dirs;
    }
  }

  return args;
}

function loadJsonl<T>(filepath: string): T[] {
  if (!fs.existsSync(filepath)) return [];
  const lines = fs.readFileSync(filepath, 'utf-8').split('\n').filter(l => l.trim());
  const items: T[] = [];
  for (const line of lines) {
    try { items.push(JSON.parse(line) as T); }
    catch { /* skip malformed */ }
  }
  return items;
}

function buildCandleIndex(candles: MicroCandle[]): Map<string, MicroCandle[]> {
  // Key: pairAddress, sorted by timestamp
  const index = new Map<string, MicroCandle[]>();
  for (const c of candles) {
    // Only use 10s candles for trajectory (most granular)
    if (c.intervalSec !== 10) continue;
    const key = c.pairAddress || c.tokenMint;
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(c);
  }
  // Sort each by timestamp
  for (const [, arr] of index) {
    arr.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
  return index;
}

function computeTrajectory(
  entryPrice: number,
  entryTimeSec: number,
  candles: MicroCandle[],
  horizons: number[]
): TrajectoryPoint[] {
  const points: TrajectoryPoint[] = [];
  const maxHorizon = Math.max(...horizons);

  for (const h of horizons) {
    const windowEnd = entryTimeSec + h;
    let mfe = 0;
    let mae = 0;
    let lastClose = entryPrice;

    for (const c of candles) {
      const cTimeSec = new Date(c.timestamp).getTime() / 1000;
      if (cTimeSec < entryTimeSec) continue;
      if (cTimeSec > windowEnd) break;

      const highPct = entryPrice > 0 ? ((c.high - entryPrice) / entryPrice) * 100 : 0;
      const lowPct = entryPrice > 0 ? ((c.low - entryPrice) / entryPrice) * 100 : 0;
      mfe = Math.max(mfe, highPct);
      mae = Math.min(mae, lowPct);
      lastClose = c.close;
    }

    const closePct = entryPrice > 0 ? ((lastClose - entryPrice) / entryPrice) * 100 : 0;
    points.push({ horizonSec: h, mfePct: mfe, maePct: mae, closePct });
  }

  return points;
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

function render(args: Args, trajectories: SignalTrajectory[]): string {
  const lines: string[] = [];
  lines.push(`# Post-Entry Trajectory Analysis`);
  lines.push('');
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push(`> Sessions: ${args.sessionDirs.length}`);
  lines.push(`> Signals analyzed: ${trajectories.length}`);
  lines.push(`> Quick reject threshold: +${args.quickRejectThresholdPct}% MFE at ${args.quickRejectHorizonSec}s`);
  lines.push('');

  if (trajectories.length === 0) {
    lines.push('No executed signals found with candle data.');
    return lines.join('\n');
  }

  // Filter to executed signals only
  const executed = trajectories.filter(t =>
    t.processingStatus === 'executed_live' || t.processingStatus === 'executed_paper'
  );
  const withOutcome = executed.filter(t => t.finalPnl !== undefined);

  lines.push(`## Sample Counts`);
  lines.push('');
  lines.push(`- Total signals with trajectory: ${trajectories.length}`);
  lines.push(`- Executed (live/paper): ${executed.length}`);
  lines.push(`- With final PnL outcome: ${withOutcome.length}`);
  lines.push('');

  // MFE/MAE at each horizon (all executed)
  lines.push(`## MFE / MAE Distribution (executed signals, n=${executed.length})`);
  lines.push('');
  lines.push(`| horizon | MFE p25 | MFE p50 | MFE p75 | MAE p25 | MAE p50 | MAE p75 | close p50 |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);

  for (const h of args.horizons) {
    const mfes = executed
      .map(t => t.trajectory.find(p => p.horizonSec === h)?.mfePct ?? 0)
      .sort((a, b) => a - b);
    const maes = executed
      .map(t => t.trajectory.find(p => p.horizonSec === h)?.maePct ?? 0)
      .sort((a, b) => a - b);
    const closes = executed
      .map(t => t.trajectory.find(p => p.horizonSec === h)?.closePct ?? 0)
      .sort((a, b) => a - b);

    lines.push(
      `| ${h}s | ${fmtPct(quantile(mfes, 0.25))} | ${fmtPct(quantile(mfes, 0.5))} | ${fmtPct(quantile(mfes, 0.75))} ` +
      `| ${fmtPct(quantile(maes, 0.25))} | ${fmtPct(quantile(maes, 0.5))} | ${fmtPct(quantile(maes, 0.75))} ` +
      `| ${fmtPct(quantile(closes, 0.5))} |`
    );
  }
  lines.push('');

  // Quick reject analysis
  const qrHorizon = args.quickRejectHorizonSec;
  const qrThreshold = args.quickRejectThresholdPct;

  lines.push(`## Quick Reject Analysis (${qrHorizon}s horizon, +${qrThreshold}% threshold)`);
  lines.push('');

  if (withOutcome.length > 0) {
    const earlyMomentum = withOutcome.filter(t => {
      const pt = t.trajectory.find(p => p.horizonSec === qrHorizon);
      return pt && pt.mfePct >= qrThreshold;
    });
    const noMomentum = withOutcome.filter(t => {
      const pt = t.trajectory.find(p => p.horizonSec === qrHorizon);
      return pt && pt.mfePct < qrThreshold;
    });

    const emWins = earlyMomentum.filter(t => t.isCleanWin);
    const nmWins = noMomentum.filter(t => t.isCleanWin);
    const emPnl = earlyMomentum.reduce((s, t) => s + (t.finalPnl ?? 0), 0);
    const nmPnl = noMomentum.reduce((s, t) => s + (t.finalPnl ?? 0), 0);

    lines.push(`| group | n | wins | WR | total PnL | avg PnL |`);
    lines.push(`|---|---:|---:|---:|---:|---:|`);
    lines.push(
      `| **Early momentum** (MFE ≥ +${qrThreshold}% at ${qrHorizon}s) ` +
      `| ${earlyMomentum.length} | ${emWins.length} | ${earlyMomentum.length > 0 ? (emWins.length / earlyMomentum.length * 100).toFixed(1) : 'n/a'}% ` +
      `| ${emPnl >= 0 ? '+' : ''}${emPnl.toFixed(6)} | ${earlyMomentum.length > 0 ? (emPnl / earlyMomentum.length >= 0 ? '+' : '') + (emPnl / earlyMomentum.length).toFixed(6) : 'n/a'} |`
    );
    lines.push(
      `| **No momentum** (MFE < +${qrThreshold}% at ${qrHorizon}s) ` +
      `| ${noMomentum.length} | ${nmWins.length} | ${noMomentum.length > 0 ? (nmWins.length / noMomentum.length * 100).toFixed(1) : 'n/a'}% ` +
      `| ${nmPnl >= 0 ? '+' : ''}${nmPnl.toFixed(6)} | ${noMomentum.length > 0 ? (nmPnl / noMomentum.length >= 0 ? '+' : '') + (nmPnl / noMomentum.length).toFixed(6) : 'n/a'} |`
    );
    lines.push('');

    // Quick reject savings
    if (noMomentum.length > 0) {
      const nmLosses = noMomentum.filter(t => !t.isCleanWin);
      const savedSol = Math.abs(nmLosses.reduce((s, t) => s + Math.min(0, t.finalPnl ?? 0), 0));
      const missedWins = noMomentum.filter(t => t.isCleanWin);
      const missedSol = missedWins.reduce((s, t) => s + Math.max(0, t.finalPnl ?? 0), 0);

      lines.push(`### Quick Reject Impact Estimate`);
      lines.push('');
      lines.push(`- If we rejected all "no momentum" trades at ${qrHorizon}s:`);
      lines.push(`  - **Saved losses**: ${savedSol.toFixed(6)} SOL (${nmLosses.length} losing trades avoided)`);
      lines.push(`  - **Missed wins**: ${missedSol.toFixed(6)} SOL (${missedWins.length} winning trades lost)`);
      lines.push(`  - **Net impact**: ${(savedSol - missedSol) >= 0 ? '+' : ''}${(savedSol - missedSol).toFixed(6)} SOL`);
      lines.push(`  - **Verdict**: ${savedSol > missedSol ? '🟢 Quick reject would IMPROVE performance' : '🔴 Quick reject would HURT performance'}`);
      lines.push('');
    }
  } else {
    lines.push('No signals with final PnL outcome — cannot compute quick reject impact.');
    lines.push('');
  }

  // Per-signal detail (last 20)
  lines.push(`## Per-Signal Detail (last 20 executed)`);
  lines.push('');
  lines.push(`| # | token | entry time | MFE@30s | MAE@30s | MFE@60s | final PnL | exit reason | QR? |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);

  const recent = executed.slice(-20);
  for (let i = 0; i < recent.length; i++) {
    const t = recent[i];
    const mfe30 = t.trajectory.find(p => p.horizonSec === 30)?.mfePct ?? 0;
    const mae30 = t.trajectory.find(p => p.horizonSec === 30)?.maePct ?? 0;
    const mfe60 = t.trajectory.find(p => p.horizonSec === 60)?.mfePct ?? 0;
    const pnl = t.finalPnl !== undefined ? `${t.finalPnl >= 0 ? '+' : ''}${t.finalPnl.toFixed(6)}` : '—';
    const qr = mfe30 < qrThreshold ? '🔴 REJECT' : '🟢 KEEP';
    lines.push(
      `| ${i + 1} | ${t.tokenSymbol || t.pairAddress.slice(0, 8)} | ${t.entryTimeSec ? new Date(t.entryTimeSec * 1000).toISOString().slice(11, 19) : '—'} ` +
      `| ${fmtPct(mfe30)} | ${fmtPct(mae30)} | ${fmtPct(mfe60)} | ${pnl} | ${t.finalExitReason || '—'} | ${qr} |`
    );
  }
  lines.push('');

  // Calibration hints
  lines.push(`## Strategy Calibration Hints`);
  lines.push('');
  if (executed.length > 0) {
    const mfe30s = executed
      .map(t => t.trajectory.find(p => p.horizonSec === 30)?.mfePct ?? 0);
    const aboveThreshold = mfe30s.filter(m => m >= qrThreshold).length;
    const pctAbove = (aboveThreshold / mfe30s.length) * 100;
    lines.push(`- ${qrHorizon}s 시점 MFE ≥ +${qrThreshold}% 비율: ${aboveThreshold}/${mfe30s.length} = ${pctAbove.toFixed(1)}%`);

    if (pctAbove < 30) {
      lines.push(`- 🔴 대부분 signal 이 ${qrHorizon}s 내 +${qrThreshold}% 미도달 → **quick reject 가 대부분 trade 를 자를 것**. threshold 를 낮추거나 horizon 을 늘려야`);
    } else if (pctAbove < 60) {
      lines.push(`- 🟡 ${pctAbove.toFixed(0)}% 가 early momentum 확인 → quick reject 가 loser 를 분류할 가능성 있음`);
    } else {
      lines.push(`- 🟢 ${pctAbove.toFixed(0)}% 가 early momentum → 대부분 빠르게 움직임. quick reject threshold 를 올려야`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function main(): void {
  const args = parseArgs();

  if (args.sessionDirs.length === 0) {
    console.error('No sessions found. Use --session <path> or ensure data/realtime/sessions/ has *-live dirs.');
    process.exit(1);
  }

  console.error(`Sessions to analyze: ${args.sessionDirs.length}`);

  // Load trades for outcome matching
  const trades = loadJsonl<TradeRow>(args.tradesPath);
  const tradeById = new Map<string, TradeRow>();
  const tradeByPair = new Map<string, TradeRow[]>();
  for (const t of trades) {
    tradeById.set(t.id, t);
    if (!tradeByPair.has(t.pair_address)) tradeByPair.set(t.pair_address, []);
    tradeByPair.get(t.pair_address)!.push(t);
  }
  console.error(`Trades loaded: ${trades.length}`);

  const allTrajectories: SignalTrajectory[] = [];

  for (const sessionDir of args.sessionDirs) {
    console.error(`\nProcessing ${path.basename(sessionDir)}...`);

    // Load signal intents
    const signals = loadJsonl<SignalIntent>(path.join(sessionDir, 'signal-intents.jsonl'));
    console.error(`  Signals: ${signals.length}`);

    // Load micro candles
    const candles = loadJsonl<MicroCandle>(path.join(sessionDir, 'micro-candles.jsonl'));
    console.error(`  Candles: ${candles.length}`);

    // Build index
    const candleIndex = buildCandleIndex(candles);
    console.error(`  Candle index: ${candleIndex.size} pairs`);

    // Process each signal
    for (const signal of signals) {
      const entryPrice = signal.referencePrice;
      if (!entryPrice || entryPrice <= 0) continue;

      const entryTimeSec = new Date(signal.signalTimestamp).getTime() / 1000;
      const pairKey = signal.pairAddress || signal.tokenMint;
      const pairCandles = candleIndex.get(pairKey);

      if (!pairCandles || pairCandles.length === 0) continue;

      const trajectory = computeTrajectory(entryPrice, entryTimeSec, pairCandles, args.horizons);

      // Match with trade outcome
      let finalPnl: number | undefined;
      let finalExitReason: string | undefined;
      let isCleanWin: boolean | undefined;

      if (signal.processing.tradeId) {
        const trade = tradeById.get(signal.processing.tradeId);
        if (trade && trade.status === 'CLOSED' && trade.pnl != null) {
          finalPnl = Number(trade.pnl);
          finalExitReason = trade.exit_reason ?? undefined;
          isCleanWin = finalPnl > 0 && !trade.exit_anomaly_reason;
        }
      }

      // Fallback: match by pair + closest created_at within ±120s
      if (finalPnl === undefined) {
        const pairTrades = tradeByPair.get(pairKey) ?? [];
        const candidates = pairTrades
          .filter(t => t.status === 'CLOSED')
          .map(t => {
            const createdAt = new Date((t as any).created_at).getTime() / 1000;
            return { trade: t, gap: Math.abs(createdAt - entryTimeSec) };
          })
          .filter(c => c.gap < 120) // ±2min window
          .sort((a, b) => a.gap - b.gap);
        if (candidates.length > 0) {
          const match = candidates[0].trade;
          finalPnl = Number(match.pnl);
          finalExitReason = match.exit_reason ?? undefined;
          isCleanWin = finalPnl > 0 && !match.exit_anomaly_reason;
        }
      }

      allTrajectories.push({
        signalId: signal.id,
        pairAddress: pairKey,
        tokenSymbol: signal.tokenSymbol || pairKey.slice(0, 8),
        entryPrice,
        entryTimeSec,
        processingStatus: signal.processing.status,
        tradeId: signal.processing.tradeId,
        finalPnl,
        finalExitReason,
        isCleanWin,
        trajectory,
      });
    }
  }

  console.error(`\nTotal trajectories: ${allTrajectories.length}`);

  const md = render(args, allTrajectories);

  if (args.outPath) {
    const outFp = path.resolve(process.cwd(), args.outPath);
    fs.mkdirSync(path.dirname(outFp), { recursive: true });
    fs.writeFileSync(outFp, md, 'utf-8');
    console.error(`Wrote ${outFp}`);
  } else {
    process.stdout.write(md);
  }
}

main();
