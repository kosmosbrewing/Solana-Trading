/**
 * Pure WS Breakout Replay Engine — candle replay + tiered-runner state machine orchestration.
 *
 * Why: cupseyReplayEngine.ts 와 대칭. VolumeMcapSpikeTrigger (bootstrap_10s) 를 signal source 로
 * 재사용하고 PureWs state machine 을 tick-by-tick 실행.
 * Entry-price idealization: signal price = entry price (entryDriftGuard / Jupiter slippage 제외).
 */

import {
  VolumeMcapSpikeTriggerConfig,
  VolumeMcapSpikeTrigger,
  BootstrapRejectStats,
} from '../strategy';
import {
  evaluateCupseySignalGate,
  CupseySignalGateConfig,
} from '../strategy/cupseySignalGate';
import { MicroCandleBuilder } from '../realtime';
import { Candle } from '../utils/types';
import { fillCandleGaps } from './microReplayEngine';
import {
  PureWsReplayConfig,
  PureWsReplayPosition,
  PureWsTradeResult,
  tryOpenPureWsPosition,
  tickPureWsPositions,
  forcePureWsCloseAll,
} from './pureWsStateMachine';

// ─── Options / Summary ───

export interface PureWsReplayOptions {
  bootstrapTriggerConfig: VolumeMcapSpikeTriggerConfig;
  pureWsConfig: PureWsReplayConfig;
  gateConfig?: CupseySignalGateConfig;
}

export interface PureWsReplaySummary {
  totalSignals: number;
  gateRejects: number;
  gatePassRate: number;
  entries: number;
  probeHardCuts: number;
  probeRejectTimeouts: number;
  probeFlatCuts: number;
  probeTrails: number;
  t1Visits: number;
  t2Visits: number;
  t3Visits: number;
  t1TrailExits: number;
  t2TrailExits: number;
  t3TrailExits: number;
  dataEndOpen: number;
  winRate: number;
  avgNetPnlPct: number;
  totalNetPnlPct: number;
  avgHoldSec: number;
  avgMfePct: number;
  avgMaePct: number;
  maxMfePct: number;
  maxNetPnlPct: number;
  winners2xNet: number; // netPnlPct >= 1.0
  winners5xNet: number; // netPnlPct >= 4.0
  winners10xNet: number; // netPnlPct >= 9.0
  exitReasonBreakdown: Record<string, number>;
  closeStateBreakdown: Record<string, number>;
  maxConcurrentUsed: number;
}

export interface PureWsReplayResult {
  trades: PureWsTradeResult[];
  summary: PureWsReplaySummary;
  dataset: {
    inputMode: 'candles';
    candleCount: number;
    keptCandleCount: number;
    droppedCandleCount: number;
  };
  rejectStats: BootstrapRejectStats;
}

// ─── Candle Replay ───

export function replayPureWsCandles(
  candles: Candle[],
  options: PureWsReplayOptions
): PureWsReplayResult {
  const sanitized = sanitizeAndFillCandles(candles);
  const runtime = createRuntime(options);

  for (const candle of sanitized.candles) {
    processCandle(candle, runtime);
  }
  finalize(runtime);

  return buildResult(runtime, {
    candleCount: candles.length,
    keptCandleCount: sanitized.keptCount,
    droppedCandleCount: sanitized.droppedCount,
  });
}

export async function replayPureWsStream(
  candles: AsyncIterable<Candle>,
  options: PureWsReplayOptions
): Promise<PureWsReplayResult> {
  const runtime = createRuntime(options);
  let totalCount = 0;
  let droppedCount = 0;

  // Simple sanitizer — filter only replayable candles. We intentionally skip the
  // heavy outlier-ratio sanitizer from cupseyReplayEngine (MAX_INTRA_CANDLE_RANGE_RATIO
  // 등) to preserve tail candles where legitimate pumps produce large ratios; the
  // `maxPeakMultiplier` HWM guard inside the state machine catches bad-fills.
  for await (const candle of candles) {
    totalCount++;
    if (!isReplayable(candle)) {
      droppedCount++;
      continue;
    }
    processCandle(candle, runtime);
  }
  finalize(runtime);
  return buildResult(runtime, {
    candleCount: totalCount,
    keptCandleCount: totalCount - droppedCount,
    droppedCount,
  } as { candleCount: number; keptCandleCount: number; droppedCount?: number; droppedCandleCount?: number } as {
    candleCount: number; keptCandleCount: number; droppedCandleCount: number;
  });
}

// ─── Runtime ───

interface PureWsRuntime {
  config: PureWsReplayConfig;
  primaryIntervalSec: number;
  builder: MicroCandleBuilder;
  trigger: VolumeMcapSpikeTrigger;
  positions: PureWsReplayPosition[];
  completedTrades: PureWsTradeResult[];
  totalSignals: number;
  gateRejects: number;
  maxConcurrentUsed: number;
  lastPrices: Map<string, number>;
  lastTimeSec: number;
  gateConfig?: CupseySignalGateConfig;
}

function createRuntime(options: PureWsReplayOptions): PureWsRuntime {
  const primaryIntervalSec = options.bootstrapTriggerConfig.primaryIntervalSec;
  return {
    config: options.pureWsConfig,
    primaryIntervalSec,
    builder: new MicroCandleBuilder({
      intervals: [5, primaryIntervalSec],
      maxHistory: 512,
    }),
    trigger: new VolumeMcapSpikeTrigger(options.bootstrapTriggerConfig),
    positions: [],
    completedTrades: [],
    totalSignals: 0,
    gateRejects: 0,
    maxConcurrentUsed: 0,
    lastPrices: new Map(),
    lastTimeSec: 0,
    gateConfig: options.gateConfig,
  };
}

function processCandle(candle: Candle, rt: PureWsRuntime): void {
  rt.builder.ingestClosedCandle(candle, false);

  const timeSec = Math.floor(candle.timestamp.getTime() / 1000);
  rt.lastTimeSec = Math.max(rt.lastTimeSec, timeSec);

  if (candle.close > 0) {
    rt.lastPrices.set(candle.pairAddress, candle.close);
    tickPureWsPositions(
      rt.positions,
      candle.pairAddress,
      candle.close,
      timeSec,
      rt.config,
      rt.completedTrades
    );
  }

  if (candle.intervalSec === rt.primaryIntervalSec) {
    const signal = rt.trigger.onCandle(candle, rt.builder);
    if (signal) {
      rt.totalSignals++;

      if (rt.gateConfig && rt.gateConfig.enabled) {
        const recent = rt.builder.getRecentCandles(
          signal.pairAddress,
          rt.primaryIntervalSec,
          rt.gateConfig.lookbackBars
        );
        const gateResult = evaluateCupseySignalGate(recent, rt.gateConfig);
        if (!gateResult.pass) {
          rt.gateRejects++;
          return;
        }
      }

      tryOpenPureWsPosition(
        rt.positions,
        { pairAddress: signal.pairAddress, price: signal.price },
        timeSec,
        rt.config
      );
      rt.maxConcurrentUsed = Math.max(rt.maxConcurrentUsed, rt.positions.length);
    }
  }
}

function finalize(rt: PureWsRuntime): void {
  if (rt.positions.length > 0) {
    const closingTime = rt.lastTimeSec > 0 ? rt.lastTimeSec : Math.floor(Date.now() / 1000);
    forcePureWsCloseAll(rt.positions, rt.lastPrices, closingTime, rt.config, rt.completedTrades);
  }
}

function buildResult(
  rt: PureWsRuntime,
  dataset: { candleCount: number; keptCandleCount: number; droppedCandleCount: number }
): PureWsReplayResult {
  return {
    trades: rt.completedTrades,
    summary: buildPureWsSummary(
      rt.completedTrades,
      rt.totalSignals,
      rt.gateRejects,
      rt.maxConcurrentUsed
    ),
    dataset: { inputMode: 'candles', ...dataset },
    rejectStats: rt.trigger.getRejectStats() as BootstrapRejectStats,
  };
}

// ─── Summary Builder ───

export function buildPureWsSummary(
  trades: PureWsTradeResult[],
  totalSignals: number,
  gateRejects: number,
  maxConcurrentUsed: number
): PureWsReplaySummary {
  const entries = trades.length;
  const exitBreakdown: Record<string, number> = {};
  const closeStateBreakdown: Record<string, number> = {};
  let wins = 0;
  let totalNet = 0;
  let totalMfe = 0;
  let totalMae = 0;
  let totalHold = 0;
  let maxMfe = 0;
  let maxNet = -Infinity;
  let winners2x = 0;
  let winners5x = 0;
  let winners10x = 0;
  let t1Visits = 0;
  let t2Visits = 0;
  let t3Visits = 0;

  for (const t of trades) {
    exitBreakdown[t.exitReason] = (exitBreakdown[t.exitReason] ?? 0) + 1;
    closeStateBreakdown[t.closeState] = (closeStateBreakdown[t.closeState] ?? 0) + 1;
    totalNet += t.netPnlPct;
    totalMfe += t.mfePct;
    totalMae += t.maePct;
    totalHold += t.holdSec;
    if (t.netPnlPct > 0) wins++;
    if (t.netPnlPct >= 1.0) winners2x++;
    if (t.netPnlPct >= 4.0) winners5x++;
    if (t.netPnlPct >= 9.0) winners10x++;
    if (t.mfePct > maxMfe) maxMfe = t.mfePct;
    if (t.netPnlPct > maxNet) maxNet = t.netPnlPct;
    if (t.t1VisitAtSec != null) t1Visits++;
    if (t.t2VisitAtSec != null) t2Visits++;
    if (t.t3VisitAtSec != null) t3Visits++;
  }

  return {
    totalSignals,
    gateRejects,
    gatePassRate: totalSignals > 0 ? (totalSignals - gateRejects) / totalSignals : 1,
    entries,
    probeHardCuts: exitBreakdown['PROBE_HARD_CUT'] ?? 0,
    probeRejectTimeouts: exitBreakdown['PROBE_REJECT_TIMEOUT'] ?? 0,
    probeFlatCuts: exitBreakdown['PROBE_FLAT_CUT'] ?? 0,
    probeTrails: exitBreakdown['PROBE_TRAIL'] ?? 0,
    t1Visits,
    t2Visits,
    t3Visits,
    t1TrailExits: exitBreakdown['T1_TRAIL'] ?? 0,
    t2TrailExits: exitBreakdown['T2_TRAIL'] ?? 0,
    t3TrailExits: exitBreakdown['T3_TRAIL'] ?? 0,
    dataEndOpen: exitBreakdown['DATA_END'] ?? 0,
    winRate: entries > 0 ? wins / entries : 0,
    totalNetPnlPct: totalNet,
    avgNetPnlPct: entries > 0 ? totalNet / entries : 0,
    avgHoldSec: entries > 0 ? totalHold / entries : 0,
    avgMfePct: entries > 0 ? totalMfe / entries : 0,
    avgMaePct: entries > 0 ? totalMae / entries : 0,
    maxMfePct: maxMfe,
    maxNetPnlPct: maxNet === -Infinity ? 0 : maxNet,
    winners2xNet: winners2x,
    winners5xNet: winners5x,
    winners10xNet: winners10x,
    exitReasonBreakdown: exitBreakdown,
    closeStateBreakdown,
    maxConcurrentUsed,
  };
}

// ─── Candle Sanitization (sync array path) ───

function sanitizeAndFillCandles(candles: Candle[]): {
  candles: Candle[];
  keptCount: number;
  droppedCount: number;
} {
  const filtered = candles.filter(isReplayable);
  filtered.sort(
    (a, b) =>
      a.timestamp.getTime() - b.timestamp.getTime() ||
      a.intervalSec - b.intervalSec ||
      a.pairAddress.localeCompare(b.pairAddress)
  );
  const filled = fillCandleGaps(filtered);
  return {
    candles: filled,
    keptCount: filtered.length,
    droppedCount: candles.length - filtered.length,
  };
}

function isReplayable(candle: Candle): boolean {
  return (
    Boolean(candle.pairAddress) &&
    candle.timestamp instanceof Date &&
    Number.isFinite(candle.timestamp.getTime()) &&
    Number.isFinite(candle.intervalSec) &&
    candle.intervalSec > 0 &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.volume) &&
    Number.isFinite(candle.buyVolume) &&
    Number.isFinite(candle.sellVolume) &&
    Number.isFinite(candle.tradeCount)
  );
}
