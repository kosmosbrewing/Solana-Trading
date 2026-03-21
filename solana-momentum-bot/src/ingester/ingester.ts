import { EventEmitter } from 'events';
import { GeckoTerminalClient } from './geckoTerminalClient';
import { CandleStore } from '../candle/candleStore';
import { createModuleLogger } from '../utils/logger';
import { CandleInterval } from '../utils/types';

const log = createModuleLogger('Ingester');

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
    const twoHoursAgo = now - 7200;

    // 429 재시도: 최대 2회, exponential backoff
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const candles = await this.fetchCandles(cfg, twoHoursAgo, now);

        if (candles.length > 0) {
          await this.candleStore.insertCandles(candles);
          this.lastFetchTime.set(cfg.pairAddress, now);
          log.info(`Backfilled ${candles.length} candles for ${cfg.pairAddress}`);
          // Backfill 후 마지막 캔들로 전략 평가 트리거
          this.emit('candles', candles);
        }
        return; // 성공 시 종료
      } catch (error: unknown) {
        const is429 = error instanceof Error && error.message.includes('429');
        if (is429 && attempt < 2) {
          const delay = Math.pow(2, attempt + 1) * 2000;
          log.warn(`Backfill 429 for ${cfg.pairAddress}, retrying in ${delay}ms (${attempt + 1}/2)`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        log.error(`Backfill failed for ${cfg.pairAddress}: ${error}`);
        this.emit('error', { pairAddress: cfg.pairAddress, error });
      }
    }
  }

  private async poll(cfg: IngesterConfig): Promise<void> {
    if (!this.running) return;

    const now = Math.floor(Date.now() / 1000);
    const lastTime = this.lastFetchTime.get(cfg.pairAddress) || (now - 600);

    try {
      const candles = await this.fetchCandles(cfg, lastTime, now);

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
}
