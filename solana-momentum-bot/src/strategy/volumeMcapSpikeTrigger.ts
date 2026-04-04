import { Candle, Signal } from '../utils/types';
import { calcATR, calcAvgVolume } from './indicators';
import { calcBuyRatio } from './breakoutScore';
import { MicroCandleBuilder } from '../realtime';
import { createModuleLogger } from '../utils/logger';

export interface VolumeMcapSpikeTriggerConfig {
  primaryIntervalSec: number;
  volumeSurgeLookback: number;
  volumeSurgeMultiplier: number;
  cooldownSec: number;
  minBuyRatio: number;
  atrPeriod: number;
  volumeMcapBoostThreshold?: number;  // default 0.01 (1%)
  volumeMcapBoostMultiplier?: number; // default 1.5
}

export interface BootstrapRejectStats {
  evaluations: number;
  signals: number;
  insufficientCandles: number;
  volumeInsufficient: number;
  lowBuyRatio: number;
  cooldown: number;
  volumeMcapBoosted: number;
}

const log = createModuleLogger('VolumeMcapSpike');
const STATS_LOG_INTERVAL_MS = 5 * 60 * 1000;

export class VolumeMcapSpikeTrigger {
  private readonly config: VolumeMcapSpikeTriggerConfig;
  private readonly lastSignalAt = new Map<string, number>();
  private readonly poolContext = new Map<string, { marketCap?: number }>();
  private readonly rejectStats: BootstrapRejectStats = {
    evaluations: 0,
    signals: 0,
    insufficientCandles: 0,
    volumeInsufficient: 0,
    lowBuyRatio: 0,
    cooldown: 0,
    volumeMcapBoosted: 0,
  };
  private lastStatsLogAt = 0;

  constructor(
    config: VolumeMcapSpikeTriggerConfig,
    private readonly onStatsFlush?: (stats: BootstrapRejectStats) => void,
  ) {
    this.config = config;
  }

  setPoolContext(pairAddress: string, ctx: { marketCap?: number }): void {
    this.poolContext.set(pairAddress, ctx);
  }

  clearPoolContext(pairAddress: string): void {
    this.poolContext.delete(pairAddress);
  }

  getRejectStats(): Readonly<BootstrapRejectStats> {
    return { ...this.rejectStats };
  }

  onCandle(candle: Candle, candleBuilder: MicroCandleBuilder): Signal | null {
    if (candle.intervalSec !== this.config.primaryIntervalSec) {
      return null;
    }

    const lookback = this.config.volumeSurgeLookback;
    const candles = candleBuilder.getRecentCandles(candle.pairAddress, candle.intervalSec, lookback + 1);
    if (candles.length < lookback + 1) {
      this.rejectStats.insufficientCandles++;
      this.maybeLogStats();
      return null;
    }

    this.rejectStats.evaluations++;

    const current = candles[candles.length - 1];
    const previous = candles.slice(0, -1);

    // HARD gate: volume acceleration (동적 threshold — 저시총 고회전 밈코인 포착)
    const avgVolume = calcAvgVolume(previous, lookback);
    const volumeRatio = avgVolume > 0 ? current.volume / avgVolume : 0;

    let effectiveMultiplier = this.config.volumeSurgeMultiplier;
    const ctx = this.poolContext.get(candle.pairAddress);
    const boostThreshold = this.config.volumeMcapBoostThreshold ?? 0.01;
    const boostMultiplier = this.config.volumeMcapBoostMultiplier ?? 1.5;

    if (ctx?.marketCap && ctx.marketCap > 0) {
      const volumeMcapRatio = current.volume / ctx.marketCap;
      if (volumeMcapRatio >= boostThreshold) {
        effectiveMultiplier = boostMultiplier;
      }
    }

    if (volumeRatio < effectiveMultiplier) {
      this.rejectStats.volumeInsufficient++;
      this.maybeLogStats();
      return null;
    }

    const boosted = effectiveMultiplier < this.config.volumeSurgeMultiplier;
    if (boosted) {
      this.rejectStats.volumeMcapBoosted++;
    }

    // SOFT gate: buy ratio
    const buyRatio = calcBuyRatio(current);
    if (buyRatio < this.config.minBuyRatio) {
      this.rejectStats.lowBuyRatio++;
      this.maybeLogStats();
      return null;
    }

    // Cooldown
    const timestampSec = Math.floor(current.timestamp.getTime() / 1000);
    if (!this.isCooldownReady(candle.pairAddress, timestampSec)) {
      this.rejectStats.cooldown++;
      this.maybeLogStats();
      return null;
    }

    const atr = calcATR(candles, Math.min(this.config.atrPeriod, candles.length - 1));
    const closeTimestampSec = timestampSec + current.intervalSec;
    this.lastSignalAt.set(candle.pairAddress, timestampSec);
    this.rejectStats.signals++;

    // mcap enrichment
    const volumeMcapPct = ctx?.marketCap && ctx.marketCap > 0
      ? current.volume / ctx.marketCap
      : undefined;

    return {
      action: 'BUY',
      strategy: 'bootstrap_10s',
      pairAddress: candle.pairAddress,
      price: current.close,
      timestamp: new Date(closeTimestampSec * 1000),
      sourceLabel: 'trigger_volume_mcap_spike',
      meta: {
        realtimeSignal: 1,
        triggerMode: 1,
        primaryIntervalSec: this.config.primaryIntervalSec,
        primaryCandleStartSec: timestampSec,
        primaryCandleCloseSec: closeTimestampSec,
        volumeRatio,
        avgVolume,
        currentVolume: current.volume,
        buyRatio,
        atr,
        ...(volumeMcapPct !== undefined ? { volumeMcapPct } : {}),
        ...(boosted ? { volumeMcapBoosted: 1, effectiveMultiplier } : {}),
      },
    };
  }

  private isCooldownReady(pairAddress: string, timestampSec: number): boolean {
    const previousSignalAt = this.lastSignalAt.get(pairAddress);
    if (!previousSignalAt) return true;
    return timestampSec - previousSignalAt >= this.config.cooldownSec;
  }

  private maybeLogStats(): void {
    const now = Date.now();
    if (now - this.lastStatsLogAt < STATS_LOG_INTERVAL_MS) return;
    this.lastStatsLogAt = now;
    const s = this.rejectStats;
    log.info(
      `[RejectStats] evals=${s.evaluations} signals=${s.signals}(boosted=${s.volumeMcapBoosted}) | ` +
      `insuffCandles=${s.insufficientCandles} volInsuf=${s.volumeInsufficient} ` +
      `lowBuyRatio=${s.lowBuyRatio} cooldown=${s.cooldown}`
    );
    if (this.onStatsFlush) {
      this.onStatsFlush({ ...this.rejectStats });
    }
  }
}
