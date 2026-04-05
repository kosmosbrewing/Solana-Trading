import { Candle, Signal } from '../utils/types';
import { calcATR, calcAvgVolume, calcSparseAvgVolume } from './indicators';
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
  /** Why: DEX sparse trading 대응 — avgVol=0일 때 wider window에서 non-zero candle 평균 사용 */
  sparseVolumeLookback?: number;      // default 120 (120 × 10s = 20min)
  minActiveCandles?: number;          // default 3
}

export interface BootstrapRejectStats {
  evaluations: number;
  signals: number;
  insufficientCandles: number;
  volumeInsufficient: number;
  lowBuyRatio: number;
  cooldown: number;
  volumeMcapBoosted: number;
  sparseDataInsufficient: number;
  sparseSignals: number;
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
    sparseDataInsufficient: 0,
    sparseSignals: 0,
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
    const sparseLookback = this.config.sparseVolumeLookback ?? 120;
    const minActive = this.config.minActiveCandles ?? 3;
    const totalLookback = Math.max(sparseLookback, lookback);

    const candles = candleBuilder.getRecentCandles(candle.pairAddress, candle.intervalSec, totalLookback + 1);
    if (candles.length < lookback + 1) {
      this.rejectStats.insufficientCandles++;
      this.maybeLogStats();
      return null;
    }

    this.rejectStats.evaluations++;

    const current = candles[candles.length - 1];
    // Why: dense mode는 최근 lookback개만, sparse mode는 전체 window 사용
    const densePrev = candles.slice(-(lookback + 1), -1);

    // Dense path: 최근 N개 candle 단순 평균
    const avgVolume = calcAvgVolume(densePrev, lookback);
    let volumeRatio: number;
    let sparse = false;
    let sparseAvg = 0;

    if (avgVolume > 0) {
      volumeRatio = current.volume / avgVolume;
    } else {
      // Sparse path: wider window에서 non-zero candle만 평균
      sparse = true;
      const allPrev = candles.slice(0, -1);
      sparseAvg = calcSparseAvgVolume(allPrev, minActive);
      if (sparseAvg <= 0) {
        this.rejectStats.sparseDataInsufficient++;
        this.maybeLogStats();
        return null;
      }
      volumeRatio = current.volume > 0 ? current.volume / sparseAvg : 0;
    }

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

    const atr = calcATR(candles.slice(-lookback - 1), Math.min(this.config.atrPeriod, lookback));
    const closeTimestampSec = timestampSec + current.intervalSec;
    this.lastSignalAt.set(candle.pairAddress, timestampSec);
    this.rejectStats.signals++;
    if (sparse) this.rejectStats.sparseSignals++;

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
        avgVolume: sparse ? sparseAvg : avgVolume,
        currentVolume: current.volume,
        buyRatio,
        atr,
        ...(sparse ? { sparseMode: 1 } : {}),
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
      `[RejectStats] evals=${s.evaluations} signals=${s.signals}(sparse=${s.sparseSignals} boosted=${s.volumeMcapBoosted}) | ` +
      `insuffCandles=${s.insufficientCandles} volInsuf=${s.volumeInsufficient} ` +
      `sparseInsuf=${s.sparseDataInsufficient} lowBuyRatio=${s.lowBuyRatio} cooldown=${s.cooldown}`
    );
    if (this.onStatsFlush) {
      this.onStatsFlush({ ...this.rejectStats });
    }
  }
}
