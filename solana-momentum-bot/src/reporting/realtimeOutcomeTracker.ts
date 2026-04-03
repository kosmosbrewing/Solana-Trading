import { Candle } from '../utils/types';
import { RealtimeSignalSink } from './realtimeSignalLogger';
import {
  RealtimeSignalHorizonOutcome,
  RealtimeSignalRecord,
} from './realtimeMeasurement';

// Why: 밈코인이라도 5분 관찰 구간에서 +900% / -99% 이상은 비현실적.
// close 기반 전환 후에도 마지막 swap이 이상치일 수 있으므로 안전장치.
const MAX_MFE_PCT = 9.0;    // +900%
const MAX_MAE_PCT = -0.99;  // -99%

interface PendingSignal {
  record: Omit<RealtimeSignalRecord, 'horizons' | 'summary'>;
  signalTimeSec: number;
  maxClose: number;
  minClose: number;
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
      maxClose: record.referencePrice,
      minClose: record.referencePrice,
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

    // Why: candle.high/low는 단일 이상치 swap에 오염됨. close는 봉의 마지막 체결가로 안정적.
    pending.maxClose = Math.max(pending.maxClose, candle.close);
    pending.minClose = Math.min(pending.minClose, candle.close);

    for (const horizonSec of this.horizonsSec) {
      if (pending.horizons.has(horizonSec)) continue;
      if (candleCloseSec < pending.signalTimeSec + horizonSec) continue;

      const returnPct = pending.record.referencePrice > 0
        ? (candle.close - pending.record.referencePrice) / pending.record.referencePrice
        : 0;
      const adjustedReturnPct = returnPct - pending.record.estimatedCostPct;
      const rawMfePct = pending.record.referencePrice > 0
        ? (pending.maxClose - pending.record.referencePrice) / pending.record.referencePrice
        : 0;
      const rawMaePct = pending.record.referencePrice > 0
        ? (pending.minClose - pending.record.referencePrice) / pending.record.referencePrice
        : 0;

      pending.horizons.set(horizonSec, {
        horizonSec,
        observedAt: new Date(candleCloseSec * 1000).toISOString(),
        price: candle.close,
        returnPct,
        adjustedReturnPct,
        mfePct: Math.min(rawMfePct, MAX_MFE_PCT),
        maePct: Math.max(rawMaePct, MAX_MAE_PCT),
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
