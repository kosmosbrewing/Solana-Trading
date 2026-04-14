/**
 * Cupsey Replay Engine — candle replay + state machine orchestration
 *
 * Why: micro-backtest 의 horizon-based outcome 대신 cupsey state machine 을
 * 실제 tick-by-tick 으로 replay 하여 STALK→PROBE→WINNER 경로별 PnL 측정.
 * 기존 microReplayEngine.ts 유틸 (sanitize, fillGap, MicroCandleBuilder) 재사용.
 */

import { VolumeMcapSpikeTriggerConfig, VolumeMcapSpikeTrigger, BootstrapRejectStats } from '../strategy';
import { evaluateCupseySignalGate, CupseySignalGateConfig } from '../strategy/cupseySignalGate';
import { initCusumState, updateCusum, CusumConfig, CusumState } from '../strategy/cusumDetector';
import { MicroCandleBuilder } from '../realtime';
import { Candle } from '../utils/types';
import { fillCandleGaps } from './microReplayEngine';
import {
  CupseyReplayConfig,
  CupseyReplayPosition,
  CupseyTradeResult,
  tryOpenCupseyPosition,
  tickCupseyPositions,
  forceCloseAll,
} from './cupseyStateMachine';

// ─── Options / Summary ───

export interface CupseyReplayOptions {
  bootstrapTriggerConfig: VolumeMcapSpikeTriggerConfig;
  cupseyConfig: CupseyReplayConfig;
  gateConfig?: CupseySignalGateConfig;
  cusumConfig?: CusumConfig;
}

export interface CupseyReplaySummary {
  totalSignals: number;
  stalkEntries: number;
  stalkSkips: number;
  stalkSuccessRate: number;
  probeWinners: number;
  probeRejects: number;
  probeToWinnerRate: number;
  winRate: number;
  avgNetPnlPct: number;
  totalNetPnlPct: number;
  avgHoldSec: number;
  avgMfePct: number;
  avgMaePct: number;
  exitReasonBreakdown: Record<string, number>;
  maxConcurrentUsed: number;
  gateRejects: number;
  gatePassRate: number;
  avgCusumStrengthAtEntry: number;
  cusumSignalCount: number;
}

export interface CupseyReplayResult {
  trades: CupseyTradeResult[];
  summary: CupseyReplaySummary;
  dataset: {
    inputMode: 'candles';
    candleCount: number;
    keptCandleCount: number;
    droppedCandleCount: number;
  };
  rejectStats: BootstrapRejectStats;
}

// ─── Candle Replay (sync array) ───

export function replayCupseyCandles(
  candles: Candle[],
  options: CupseyReplayOptions
): CupseyReplayResult {
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

// ─── Candle Replay (async stream) ───

export async function replayCupseyStream(
  candles: AsyncIterable<Candle>,
  options: CupseyReplayOptions
): Promise<CupseyReplayResult> {
  const runtime = createRuntime(options);
  let totalCount = 0;
  const sanitizer = createStreamSanitizer();
  const gapFiller = new StreamCandleGapFiller();

  for await (const candle of candles) {
    totalCount++;
    if (!isReplayable(candle)) {
      sanitizer.droppedCount++;
      continue;
    }
    // Why: outlier candle 필터 (intra-candle range, sequential close ratio 등)
    if (!acceptStreamCandle(candle, sanitizer)) {
      continue;
    }
    // Why: zero-volume gap 을 synthetic candle 로 채워서 tick 연속성 보장
    const filled = gapFiller.fill(candle);
    for (const c of filled) {
      processCandle(c, runtime);
    }
  }
  finalize(runtime);

  const keptCount = totalCount - sanitizer.droppedCount;
  return buildResult(runtime, {
    candleCount: totalCount,
    keptCandleCount: keptCount,
    droppedCandleCount: sanitizer.droppedCount,
  });
}

// ─── Internal Runtime ───

interface CupseyRuntime {
  config: CupseyReplayConfig;
  primaryIntervalSec: number;
  builder: MicroCandleBuilder;
  trigger: VolumeMcapSpikeTrigger;
  positions: CupseyReplayPosition[];
  completedTrades: CupseyTradeResult[];
  totalSignals: number;
  maxConcurrentUsed: number;
  lastPrices: Map<string, number>;
  lastTimeSec: number;
  gateConfig?: CupseySignalGateConfig;
  gateRejects: number;
  cusumConfig?: CusumConfig;
  cusumStates: Map<string, CusumState>;
  cusumStrengthSum: number;    // sum of CUSUM strength at signal time
  cusumStrengthCount: number;  // number of signals where CUSUM was computed
  cusumSignalCount: number;    // number of CUSUM threshold breaches
}

function createRuntime(options: CupseyReplayOptions): CupseyRuntime {
  const primaryIntervalSec = options.bootstrapTriggerConfig.primaryIntervalSec;
  return {
    config: options.cupseyConfig,
    primaryIntervalSec,
    builder: new MicroCandleBuilder({
      intervals: [5, primaryIntervalSec],
      maxHistory: 512,
    }),
    trigger: new VolumeMcapSpikeTrigger(options.bootstrapTriggerConfig),
    positions: [],
    completedTrades: [],
    totalSignals: 0,
    maxConcurrentUsed: 0,
    lastPrices: new Map(),
    lastTimeSec: 0,
    gateConfig: options.gateConfig,
    gateRejects: 0,
    cusumConfig: options.cusumConfig,
    cusumStates: new Map(),
    cusumStrengthSum: 0,
    cusumStrengthCount: 0,
    cusumSignalCount: 0,
  };
}

function processCandle(candle: Candle, rt: CupseyRuntime): void {
  rt.builder.ingestClosedCandle(candle, false);

  const timeSec = Math.floor(candle.timestamp.getTime() / 1000);
  rt.lastTimeSec = Math.max(rt.lastTimeSec, timeSec);

  // Why: 모든 캔들에서 해당 pair 의 position 을 tick (5s resolution)
  if (candle.close > 0) {
    rt.lastPrices.set(candle.pairAddress, candle.close);
    tickCupseyPositions(
      rt.positions,
      candle.pairAddress,
      candle.close,
      timeSec,
      rt.config,
      rt.completedTrades
    );
  }

  // Primary interval 캔들에서만 trigger 평가 + CUSUM update
  if (candle.intervalSec === rt.primaryIntervalSec) {
    // CUSUM per-pair update (observation-only: strength 기록만)
    if (rt.cusumConfig) {
      let cusumState = rt.cusumStates.get(candle.pairAddress) ?? initCusumState();
      const cusumResult = updateCusum(cusumState, candle.volume, rt.cusumConfig);
      cusumState = cusumResult.state;
      rt.cusumStates.set(candle.pairAddress, cusumState);
      if (cusumResult.signal) {
        rt.cusumSignalCount++;
      }
    }

    const signal = rt.trigger.onCandle(candle, rt.builder);
    if (signal) {
      rt.totalSignals++;

      // CUSUM strength at signal time (for correlation analysis)
      if (rt.cusumConfig) {
        const cusumState = rt.cusumStates.get(signal.pairAddress);
        if (cusumState && cusumState.sampleCount >= rt.cusumConfig.warmupPeriods) {
          const variance = cusumState.logM2 / (cusumState.sampleCount - 1);
          const sigma = Math.sqrt(Math.max(variance, 1e-12));
          const threshold = rt.cusumConfig.hMultiplier * sigma;
          const strength = threshold > 0 ? cusumState.cumSum / threshold : 0;
          rt.cusumStrengthSum += strength;
          rt.cusumStrengthCount++;
        }
      }

      // Signal Quality Gate: multi-bar momentum 사전 검증
      if (rt.gateConfig && rt.gateConfig.enabled) {
        const recentCandles = rt.builder.getRecentCandles(
          signal.pairAddress,
          rt.primaryIntervalSec,
          rt.gateConfig.lookbackBars
        );
        const gateResult = evaluateCupseySignalGate(recentCandles, rt.gateConfig);
        if (!gateResult.pass) {
          rt.gateRejects++;
          return;
        }
      }

      tryOpenCupseyPosition(
        rt.positions,
        { pairAddress: signal.pairAddress, price: signal.price },
        timeSec,
        rt.config
      );
      rt.maxConcurrentUsed = Math.max(rt.maxConcurrentUsed, rt.positions.length);
    }
  }
}

function finalize(rt: CupseyRuntime): void {
  if (rt.positions.length > 0) {
    const closingTime = rt.lastTimeSec > 0 ? rt.lastTimeSec : Math.floor(Date.now() / 1000);
    forceCloseAll(rt.positions, rt.lastPrices, closingTime, rt.completedTrades);
  }
}

function buildResult(
  rt: CupseyRuntime,
  dataset: { candleCount: number; keptCandleCount: number; droppedCandleCount: number }
): CupseyReplayResult {
  return {
    trades: rt.completedTrades,
    summary: buildCupseyReplaySummary(
      rt.completedTrades, rt.totalSignals, rt.maxConcurrentUsed, rt.gateRejects,
      rt.cusumStrengthCount > 0 ? rt.cusumStrengthSum / rt.cusumStrengthCount : 0,
      rt.cusumSignalCount
    ),
    dataset: { inputMode: 'candles', ...dataset },
    rejectStats: rt.trigger.getRejectStats() as BootstrapRejectStats,
  };
}

// ─── Summary Builder ───

export function buildCupseyReplaySummary(
  trades: CupseyTradeResult[],
  totalSignals: number,
  maxConcurrentUsed: number,
  gateRejects: number = 0,
  avgCusumStrengthAtEntry: number = 0,
  cusumSignalCount: number = 0
): CupseyReplaySummary {
  const stalkSkips = trades.filter(t => t.stalkSkip);
  const entered = trades.filter(t => !t.stalkSkip);
  const stalkEntries = entered.length;

  const probeRejects = entered.filter(t =>
    t.exitReason === 'REJECT_HARD_CUT' || t.exitReason === 'REJECT_TIMEOUT'
  );
  // Why: DATA_END 는 PROBE 잔여일 수 있으므로 WINNER_ prefix 만 winner 로 집계
  const probeWinners = entered.filter(t => t.exitReason.startsWith('WINNER_'));

  const winners = entered.filter(t => t.netPnlPct > 0);
  const totalNetPnlPct = entered.reduce((sum, t) => sum + t.netPnlPct, 0);
  const avgNetPnlPct = stalkEntries > 0 ? totalNetPnlPct / stalkEntries : 0;
  const avgHoldSec = stalkEntries > 0
    ? entered.reduce((sum, t) => sum + t.holdSec, 0) / stalkEntries
    : 0;
  const avgMfePct = stalkEntries > 0
    ? entered.reduce((sum, t) => sum + t.mfePct, 0) / stalkEntries
    : 0;
  const avgMaePct = stalkEntries > 0
    ? entered.reduce((sum, t) => sum + t.maePct, 0) / stalkEntries
    : 0;

  const exitReasonBreakdown: Record<string, number> = {};
  for (const t of trades) {
    exitReasonBreakdown[t.exitReason] = (exitReasonBreakdown[t.exitReason] ?? 0) + 1;
  }

  return {
    totalSignals,
    stalkEntries,
    stalkSkips: stalkSkips.length,
    stalkSuccessRate: totalSignals > 0 ? stalkEntries / totalSignals : 0,
    probeWinners: probeWinners.length,
    probeRejects: probeRejects.length,
    probeToWinnerRate: stalkEntries > 0 ? probeWinners.length / stalkEntries : 0,
    winRate: stalkEntries > 0 ? winners.length / stalkEntries : 0,
    avgNetPnlPct,
    totalNetPnlPct,
    avgHoldSec,
    avgMfePct,
    avgMaePct,
    exitReasonBreakdown,
    maxConcurrentUsed,
    gateRejects,
    gatePassRate: totalSignals > 0 ? (totalSignals - gateRejects) / totalSignals : 1,
    avgCusumStrengthAtEntry,
    cusumSignalCount,
  };
}

// ─── Stream Candle Sanitization ───

const MAX_INTRA_CANDLE_RANGE_RATIO = 100;
const MAX_SEQUENTIAL_CLOSE_RATIO = 100;
const MAX_ROLLING_MEDIAN_CLOSE_RATIO = 20;
const ROLLING_CLOSE_WINDOW = 5;

interface StreamSanitizer {
  recentClosesBySeries: Map<string, number[]>;
  droppedCount: number;
}

function createStreamSanitizer(): StreamSanitizer {
  return { recentClosesBySeries: new Map(), droppedCount: 0 };
}

// Why: microReplayEngine.ts 의 acceptReplayCandle 과 동일한 outlier 필터
function acceptStreamCandle(candle: Candle, sanitizer: StreamSanitizer): boolean {
  const prices = [candle.open, candle.high, candle.low, candle.close];
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  if (minPrice <= 0 || maxPrice / minPrice > MAX_INTRA_CANDLE_RANGE_RATIO) {
    sanitizer.droppedCount++;
    return false;
  }

  const seriesKey = `${candle.pairAddress}:${candle.intervalSec}`;
  const recentCloses = sanitizer.recentClosesBySeries.get(seriesKey) ?? [];
  const previousClose = recentCloses[recentCloses.length - 1];
  if (previousClose && previousClose > 0) {
    const closeRatio = Math.max(previousClose, candle.close) / Math.min(previousClose, candle.close);
    if (closeRatio > MAX_SEQUENTIAL_CLOSE_RATIO) {
      sanitizer.droppedCount++;
      return false;
    }
  }

  if (recentCloses.length >= 3) {
    const sorted = [...recentCloses].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianClose = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    if (medianClose > 0) {
      const medianRatio = Math.max(medianClose, candle.close) / Math.min(medianClose, candle.close);
      if (medianRatio > MAX_ROLLING_MEDIAN_CLOSE_RATIO) {
        sanitizer.droppedCount++;
        return false;
      }
    }
  }

  const nextHistory = [...recentCloses.slice(-(ROLLING_CLOSE_WINDOW - 1)), candle.close];
  sanitizer.recentClosesBySeries.set(seriesKey, nextHistory);
  return true;
}

// Why: microReplayEngine.ts StreamCandleGapFiller 과 동일 — zero-volume gap fill
class StreamCandleGapFiller {
  private readonly lastCandleBySeries = new Map<string, Candle>();

  fill(candle: Candle): Candle[] {
    const key = `${candle.pairAddress}:${candle.intervalSec}`;
    const prev = this.lastCandleBySeries.get(key);
    this.lastCandleBySeries.set(key, candle);

    if (!prev) return [candle];

    const expectedNextMs = prev.timestamp.getTime() + prev.intervalSec * 1000;
    let gapMs = candle.timestamp.getTime() - expectedNextMs;
    if (gapMs < candle.intervalSec * 1000) return [candle];

    const result: Candle[] = [];
    let fillTimestampMs = expectedNextMs;
    const maxFillCount = 200;
    let fillCount = 0;
    while (gapMs >= candle.intervalSec * 1000 && fillCount < maxFillCount) {
      result.push({
        pairAddress: candle.pairAddress,
        timestamp: new Date(fillTimestampMs),
        intervalSec: candle.intervalSec,
        open: prev.close,
        high: prev.close,
        low: prev.close,
        close: prev.close,
        volume: 0,
        buyVolume: 0,
        sellVolume: 0,
        tradeCount: 0,
      });
      fillTimestampMs += candle.intervalSec * 1000;
      gapMs -= candle.intervalSec * 1000;
      fillCount++;
    }
    result.push(candle);
    return result;
  }
}

// ─── Candle Sanitization (sync array path) ───

function sanitizeAndFillCandles(candles: Candle[]): {
  candles: Candle[];
  keptCount: number;
  droppedCount: number;
} {
  const filtered = candles.filter(isReplayable);
  filtered.sort((a, b) =>
    a.timestamp.getTime() - b.timestamp.getTime()
    || a.intervalSec - b.intervalSec
    || a.pairAddress.localeCompare(b.pairAddress)
  );
  const filled = fillCandleGaps(filtered);
  return {
    candles: filled,
    keptCount: filtered.length,
    droppedCount: candles.length - filtered.length,
  };
}

function isReplayable(candle: Candle): boolean {
  return Boolean(candle.pairAddress)
    && candle.timestamp instanceof Date
    && Number.isFinite(candle.timestamp.getTime())
    && Number.isFinite(candle.intervalSec)
    && candle.intervalSec > 0
    && Number.isFinite(candle.open)
    && Number.isFinite(candle.high)
    && Number.isFinite(candle.low)
    && Number.isFinite(candle.close)
    && Number.isFinite(candle.volume)
    && Number.isFinite(candle.buyVolume)
    && Number.isFinite(candle.sellVolume)
    && Number.isFinite(candle.tradeCount);
}
