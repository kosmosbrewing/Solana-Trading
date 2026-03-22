import { Candle } from '../utils/types';
import { RealtimeSignalSink } from './realtimeSignalLogger';
import {
  RealtimeSignalHorizonOutcome,
  RealtimeSignalRecord,
} from './realtimeMeasurement';

interface PendingSignal {
  record: Omit<RealtimeSignalRecord, 'horizons' | 'summary'>;
  signalTimeSec: number;
  maxHigh: number;
  minLow: number;
  horizons: Map<number, RealtimeSignalHorizonOutcome>;
}

export interface RealtimeOutcomeTrackerConfig {
  horizonsSec: number[];
  observationIntervalSec: number;
}

export class RealtimeOutcomeTracker {
  private readonly horizonsSec: number[];
  private readonly observationIntervalSec: number;
  private readonly pending = new Map<string, PendingSignal>();

  constructor(
    config: RealtimeOutcomeTrackerConfig,
    private readonly logger: RealtimeSignalSink
  ) {
    this.horizonsSec = [...new Set(config.horizonsSec)].filter((value) => value > 0).sort((a, b) => a - b);
    this.observationIntervalSec = config.observationIntervalSec;
  }

  getRequiredHistoryCount(): number {
    const maxHorizon = this.horizonsSec[this.horizonsSec.length - 1] ?? 0;
    return Math.max(1, Math.ceil(maxHorizon / this.observationIntervalSec) + 4);
  }

  track(
    record: Omit<RealtimeSignalRecord, 'horizons' | 'summary'>,
    recentCandles: Candle[] = []
  ): void {
    const signalTimeSec = resolveSignalTimeSec(record);
    const pending: PendingSignal = {
      record,
      signalTimeSec,
      maxHigh: record.referencePrice,
      minLow: record.referencePrice,
      horizons: new Map(),
    };
    this.pending.set(record.id, pending);

    for (const candle of recentCandles) {
      void this.applyCandleToPending(pending, candle);
    }
  }

  async onCandle(candle: Candle): Promise<void> {
    if (candle.intervalSec !== this.observationIntervalSec) return;

    const relevant = [...this.pending.values()].filter((entry) => entry.record.pairAddress === candle.pairAddress);
    for (const pending of relevant) {
      await this.applyCandleToPending(pending, candle);
    }
  }

  private async applyCandleToPending(pending: PendingSignal, candle: Candle): Promise<void> {
    const candleCloseSec = Math.floor(candle.timestamp.getTime() / 1000) + candle.intervalSec;
    if (candleCloseSec < pending.signalTimeSec) return;

    pending.maxHigh = Math.max(pending.maxHigh, candle.high);
    pending.minLow = Math.min(pending.minLow, candle.low);

    for (const horizonSec of this.horizonsSec) {
      if (pending.horizons.has(horizonSec)) continue;
      if (candleCloseSec < pending.signalTimeSec + horizonSec) continue;

      const returnPct = pending.record.referencePrice > 0
        ? (candle.close - pending.record.referencePrice) / pending.record.referencePrice
        : 0;
      const adjustedReturnPct = returnPct - pending.record.estimatedCostPct;
      pending.horizons.set(horizonSec, {
        horizonSec,
        observedAt: new Date(candleCloseSec * 1000).toISOString(),
        price: candle.close,
        returnPct,
        adjustedReturnPct,
        mfePct: pending.record.referencePrice > 0
          ? (pending.maxHigh - pending.record.referencePrice) / pending.record.referencePrice
          : 0,
        maePct: pending.record.referencePrice > 0
          ? (pending.minLow - pending.record.referencePrice) / pending.record.referencePrice
          : 0,
      });
    }

    if (pending.horizons.size !== this.horizonsSec.length) return;

    const outcomes = [...pending.horizons.values()].sort((left, right) => left.horizonSec - right.horizonSec);
    const record: RealtimeSignalRecord = {
      ...pending.record,
      horizons: outcomes,
      summary: {
        completedAt: outcomes[outcomes.length - 1].observedAt,
        maxObservedSec: outcomes[outcomes.length - 1].horizonSec,
        mfePct: Math.max(...outcomes.map((outcome) => outcome.mfePct)),
        maePct: Math.min(...outcomes.map((outcome) => outcome.maePct)),
      },
    };

    this.pending.delete(pending.record.id);
    await this.logger.log(record);
  }
}

function resolveSignalTimeSec(record: Omit<RealtimeSignalRecord, 'horizons' | 'summary'>): number {
  const closeSec = record.trigger.primaryCandleCloseSec;
  if (typeof closeSec === 'number' && Number.isFinite(closeSec)) {
    return closeSec;
  }
  return Math.floor(Date.parse(record.signalTimestamp) / 1000);
}
