import { EventEmitter } from 'events';
import { GeckoTerminalClient } from './geckoTerminalClient';
import { CandleStore } from '../candle/candleStore';
import { createModuleLogger } from '../utils/logger';
import { Candle, CandleInterval } from '../utils/types';

const log = createModuleLogger('Ingester');
const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '5s': 5,
  '15s': 15,
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1H': 3600,
  '4H': 14_400,
};

export interface IngesterConfig {
  pairAddress: string;
  intervalType: CandleInterval;
  pollIntervalMs: number;
  /** true = token mint 주소 (Scanner 모드), false = pair/pool 주소 (Legacy 모드) */
  isTokenMint?: boolean;
  /** GeckoTerminal용 pool address (token mint와 다를 수 있음) */
  poolAddress?: string;
}

/**
 * Data Ingester — GeckoTerminal API 폴링 기반 캔들 수집
 *
 * Events:
 * - 'candles' (Candle[]) — 새 캔들 배치 (1개 이상)
 * - 'error' ({ pairAddress: string, error: unknown })
 */
export class Ingester extends EventEmitter {
  private geckoClient: GeckoTerminalClient;
  private candleStore: CandleStore;
  private configs: IngesterConfig[];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private lastFetchTime: Map<string, number> = new Map();
  private running = false;

  constructor(
    geckoClient: GeckoTerminalClient,
    candleStore: CandleStore,
    configs: IngesterConfig[]
  ) {
    super();
    this.geckoClient = geckoClient;
    this.candleStore = candleStore;
    this.configs = configs;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info(`Starting Ingester for ${this.configs.length} pair(s)`);

    for (let i = 0; i < this.configs.length; i++) {
      const cfg = this.configs[i];
      // API rate limit 방지: pair 간 3초 간격 backfill
      if (i > 0) await new Promise(r => setTimeout(r, 3000));
      await this.backfill(cfg);

      const initialDelayMs = cfg.pollIntervalMs + (i * 10_000) + this.getStablePollOffsetMs(cfg);
      this.schedulePoll(cfg, initialDelayMs);
      log.info(`Polling scheduled: ${cfg.pairAddress} every ${cfg.pollIntervalMs}ms (first poll in ${initialDelayMs}ms)`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const [pair, timer] of this.timers) {
      clearInterval(timer);
      log.info(`Polling stopped: ${pair}`);
    }
    this.timers.clear();
  }

  /** OHLCV 가져오기 — GeckoTerminal pool address 기반 */
  private async fetchCandles(cfg: IngesterConfig, timeFrom: number, timeTo: number) {
    // Why: GeckoTerminal은 pool address 기반. poolAddress가 있으면 사용, 없으면 pairAddress 사용.
    const address = cfg.poolAddress || cfg.pairAddress;
    const candles = await this.geckoClient.getOHLCV(
      address,
      cfg.intervalType,
      timeFrom,
      timeTo
    );
    // Why: pairAddress를 원본(token mint)으로 유지해야 CandleHandler에서 watchlist 매칭됨
    return candles.map(c => ({ ...c, pairAddress: cfg.pairAddress }));
  }

  private async backfill(cfg: IngesterConfig): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const intervalSec = INTERVAL_SECONDS[cfg.intervalType];
    const timeFrom = await this.resolveBackfillStartTime(cfg, now);
    if (timeFrom == null) {
      log.info(`Backfill skipped for ${cfg.pairAddress}: recent internal candles already present`);
      const warmupCandles = await this.loadRecentStoredCandles(cfg, intervalSec, 30);
      if (warmupCandles.length > 0) {
        this.emit('candles', warmupCandles);
      }
      return;
    }

    try {
      const candles = await this.fetchCandlesWithRetry(cfg, timeFrom, now, 'backfill');

      if (candles.length > 0) {
        await this.candleStore.insertCandles(candles);
        this.lastFetchTime.set(cfg.pairAddress, now);
        log.info(`Backfilled ${candles.length} candles for ${cfg.pairAddress}`);
        // Backfill 후 마지막 캔들로 전략 평가 트리거
        this.emit('candles', candles);
      }
    } catch (error) {
      log.error(`Backfill failed for ${cfg.pairAddress}: ${error}`);
      this.emit('error', { pairAddress: cfg.pairAddress, error });
    }
  }

  private async poll(cfg: IngesterConfig): Promise<void> {
    if (!this.running) return;

    const now = Math.floor(Date.now() / 1000);
    const intervalSec = INTERVAL_SECONDS[cfg.intervalType];
    const latestStoredCandle = await this.loadLatestStoredCandle(cfg, intervalSec);
    if (latestStoredCandle && this.hasFreshClosedCandle(latestStoredCandle, now, intervalSec)) {
      const latestStoredSec = Math.floor(latestStoredCandle.timestamp.getTime() / 1000);
      this.lastFetchTime.set(cfg.pairAddress, latestStoredSec);
      log.debug(`Poll skipped for ${cfg.pairAddress}: latest internal candle is still current`);
      return;
    }

    const lastTime = await this.resolvePollStartTime(cfg, now);

    try {
      const candles = await this.fetchCandlesWithRetry(cfg, lastTime, now, 'poll');

      if (candles.length > 0) {
        await this.candleStore.insertCandles(candles);
        this.lastFetchTime.set(cfg.pairAddress, now);

        // 배치 이벤트: 마지막 캔들만 전략 트리거 (중복 DB 읽기 방지)
        this.emit('candles', candles);

        log.debug(`Polled ${candles.length} candle(s) for ${cfg.pairAddress}`);
      }
    } catch (error) {
      log.error(`Poll failed for ${cfg.pairAddress}: ${error}`);
      this.emit('error', { pairAddress: cfg.pairAddress, error });
    }
  }

  /** 동적으로 새 pair 추가 (Scanner 발견 시 호출) */
  async addPair(cfg: IngesterConfig): Promise<void> {
    if (this.timers.has(cfg.pairAddress)) {
      log.debug(`Pair ${cfg.pairAddress} already being polled`);
      return;
    }
    this.configs.push(cfg);

    if (this.running) {
      await this.backfill(cfg);
      const initialDelayMs = cfg.pollIntervalMs + this.getStablePollOffsetMs(cfg);
      this.schedulePoll(cfg, initialDelayMs);
      log.info(`Dynamic pair added: ${cfg.pairAddress} (poll every ${cfg.pollIntervalMs}ms, first poll in ${initialDelayMs}ms)`);
    }
  }

  /** 동적으로 pair 제거 (Scanner eviction 시 호출) */
  removePair(pairAddress: string): void {
    const timer = this.timers.get(pairAddress);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(pairAddress);
      this.configs = this.configs.filter(c => c.pairAddress !== pairAddress);
      this.lastFetchTime.delete(pairAddress);
      log.info(`Dynamic pair removed: ${pairAddress}`);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private schedulePoll(cfg: IngesterConfig, delayMs: number): void {
    const timer = setTimeout(async () => {
      if (!this.running) return;
      await this.poll(cfg);
      if (!this.running || !this.timers.has(cfg.pairAddress)) return;
      this.schedulePoll(cfg, cfg.pollIntervalMs);
    }, delayMs);
    this.timers.set(cfg.pairAddress, timer);
  }

  private getStablePollOffsetMs(cfg: IngesterConfig): number {
    const maxOffsetMs = Math.min(60_000, Math.floor(cfg.pollIntervalMs / 5));
    if (maxOffsetMs <= 0) return 0;

    let hash = 0;
    for (const ch of cfg.pairAddress) {
      hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    }
    return hash % (maxOffsetMs + 1);
  }

  private async fetchCandlesWithRetry(
    cfg: IngesterConfig,
    timeFrom: number,
    timeTo: number,
    phase: 'backfill' | 'poll'
  ) {
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.fetchCandles(cfg, timeFrom, timeTo);
      } catch (error) {
        const retryable = this.isRetryableFetchError(error);
        if (!retryable || attempt >= maxRetries || !this.running) {
          throw error;
        }

        const delayMs = this.getRetryDelayMs(error, attempt);
        const reason = this.describeRetryableError(error);
        log.warn(
          `${phase} retryable error for ${cfg.pairAddress}: ${reason}. ` +
          `Retrying in ${delayMs}ms (${attempt + 1}/${maxRetries})`
        );
        await sleep(delayMs);
      }
    }

    return [];
  }

  private isRetryableFetchError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 429 || (status !== undefined && status >= 500)) {
      return true;
    }

    const message = this.getErrorMessage(error).toLowerCase();
    return [
      '429',
      'rate limit',
      'fetch failed',
      'timeout',
      'timed out',
      'socket hang up',
      'econnreset',
      'econnrefused',
      'eai_again',
      'enotfound',
      'network error',
    ].some((token) => message.includes(token));
  }

  private getRetryDelayMs(error: unknown, attempt: number): number {
    const status = this.extractStatusCode(error);
    const retryAfterMs = this.extractRetryAfterMs(error);
    if (retryAfterMs !== undefined) {
      return retryAfterMs;
    }
    if (status === 429) {
      return 2_000 * (2 ** (attempt + 1));
    }
    return 1_000 * (attempt + 1);
  }

  private extractRetryAfterMs(error: unknown): number | undefined {
    const retryAfter = (error as {
      response?: { headers?: Record<string, string | string[] | undefined> };
    })?.response?.headers?.['retry-after'];
    const value = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  }

  private extractStatusCode(error: unknown): number | undefined {
    const status = (error as { response?: { status?: number } })?.response?.status;
    return typeof status === 'number' ? status : undefined;
  }

  private describeRetryableError(error: unknown): string {
    const status = this.extractStatusCode(error);
    if (status !== undefined) {
      return `status=${status}`;
    }
    return this.getErrorMessage(error);
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async resolveBackfillStartTime(
    cfg: IngesterConfig,
    nowSec: number
  ): Promise<number | null> {
    const intervalSec = INTERVAL_SECONDS[cfg.intervalType];
    const latestStoredCandle = await this.loadLatestStoredCandle(cfg, intervalSec);
    const latestStoredSec = latestStoredCandle
      ? Math.floor(latestStoredCandle.timestamp.getTime() / 1000)
      : null;

    if (latestStoredSec != null) {
      this.lastFetchTime.set(cfg.pairAddress, latestStoredSec);
      if (latestStoredSec >= nowSec - intervalSec * 2) {
        return null;
      }
      return Math.max(nowSec - 7200, latestStoredSec + intervalSec);
    }

    return nowSec - 7200;
  }

  private async resolvePollStartTime(
    cfg: IngesterConfig,
    nowSec: number
  ): Promise<number> {
    const existing = this.lastFetchTime.get(cfg.pairAddress);
    if (existing != null) {
      return existing;
    }

    const intervalSec = INTERVAL_SECONDS[cfg.intervalType];
    const latestStoredCandle = await this.loadLatestStoredCandle(cfg, intervalSec);
    if (latestStoredCandle) {
      const latestStoredSec = Math.floor(latestStoredCandle.timestamp.getTime() / 1000);
      this.lastFetchTime.set(cfg.pairAddress, latestStoredSec);
      return latestStoredSec + intervalSec;
    }

    return nowSec - Math.max(intervalSec * 2, 600);
  }

  private async loadLatestStoredCandle(
    cfg: IngesterConfig,
    intervalSec: number
  ): Promise<Candle | null> {
    const candles = await this.candleStore.getRecentCandles(cfg.pairAddress, intervalSec, 1);
    return candles[0] ?? null;
  }

  private async loadRecentStoredCandles(
    cfg: IngesterConfig,
    intervalSec: number,
    limit: number
  ): Promise<Candle[]> {
    return this.candleStore.getRecentCandles(cfg.pairAddress, intervalSec, limit);
  }

  private hasFreshClosedCandle(
    candle: Candle,
    nowSec: number,
    intervalSec: number
  ): boolean {
    const latestStoredSec = Math.floor(candle.timestamp.getTime() / 1000);
    const currentBucketStartSec = Math.floor(nowSec / intervalSec) * intervalSec;
    const latestClosedBucketStartSec = currentBucketStartSec - intervalSec;
    return latestStoredSec >= latestClosedBucketStartSec;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
