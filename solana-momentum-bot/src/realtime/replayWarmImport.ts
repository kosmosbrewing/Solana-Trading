import { CandleStore } from '../candle';
import { createModuleLogger } from '../utils/logger';
import { RealtimeReplayStore, StoredMicroCandle } from './replayStore';

const log = createModuleLogger('ReplayWarmImport');
const DEFAULT_BATCH_SIZE = 500;

export interface WarmReplayImportResult {
  inserted: number;
  lastImportedAt?: Date;
}

export async function warmReplayCandlesIntoStore(
  replayStore: RealtimeReplayStore,
  candleStore: CandleStore,
  options: { batchSize?: number; minTimestamp?: Date } = {}
): Promise<WarmReplayImportResult> {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const minTimestampMs = options.minTimestamp?.getTime();
  const batch: StoredMicroCandle[] = [];
  let inserted = 0;
  let lastImportedAt: Date | undefined;

  for await (const candle of replayStore.streamCandles()) {
    if (minTimestampMs != null && candle.timestamp.getTime() < minTimestampMs) {
      continue;
    }
    batch.push(candle);
    lastImportedAt = candle.timestamp;
    if (batch.length >= batchSize) {
      await candleStore.insertCandles([...batch]);
      inserted += batch.length;
      batch.length = 0;
    }
  }

  if (batch.length > 0) {
    await candleStore.insertCandles([...batch]);
    inserted += batch.length;
  }

  if (inserted > 0) {
    log.info(`Warm-imported ${inserted} replay candles into CandleStore`);
  }

  return {
    inserted,
    lastImportedAt,
  };
}

export class ReplayWarmSync {
  private timer?: NodeJS.Timeout;
  private lastImportedAt?: Date;
  private syncing = false;

  constructor(
    private readonly replayStore: RealtimeReplayStore,
    private readonly candleStore: CandleStore,
    private readonly intervalMs: number
  ) {}

  async start(): Promise<void> {
    await this.syncOnce();
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.syncOnce();
      }, this.intervalMs);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async syncOnce(): Promise<WarmReplayImportResult> {
    if (this.syncing) {
      return {
        inserted: 0,
        lastImportedAt: this.lastImportedAt,
      };
    }
    this.syncing = true;
    try {
      const result = await warmReplayCandlesIntoStore(this.replayStore, this.candleStore, {
        minTimestamp: this.lastImportedAt ? new Date(this.lastImportedAt.getTime() + 1) : undefined,
      });
      if (result.lastImportedAt) {
        this.lastImportedAt = result.lastImportedAt;
      }
      return result;
    } finally {
      this.syncing = false;
    }
  }
}
