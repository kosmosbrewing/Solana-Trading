import { EventEmitter } from 'events';
import { BirdeyeClient } from './birdeyeClient';
import { CandleStore } from '../candle/candleStore';
import { createModuleLogger } from '../utils/logger';
import { Candle } from '../utils/types';

const log = createModuleLogger('Ingester');

export interface IngesterConfig {
  pairAddress: string;
  intervalType: string;    // '1m' | '5m'
  pollIntervalMs: number;  // 폴링 주기 (ms)
}

/**
 * Data Ingester — Birdeye API 폴링 기반 캔들 수집
 *
 * P0~P2: Birdeye API 폴링
 * P3~: Helius WebSocket 기반 자체 캔들 집계로 전환
 */
export class Ingester extends EventEmitter {
  private birdeyeClient: BirdeyeClient;
  private candleStore: CandleStore;
  private configs: IngesterConfig[];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private lastFetchTime: Map<string, number> = new Map();
  private running = false;

  constructor(
    birdeyeClient: BirdeyeClient,
    candleStore: CandleStore,
    configs: IngesterConfig[]
  ) {
    super();
    this.birdeyeClient = birdeyeClient;
    this.candleStore = candleStore;
    this.configs = configs;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info(`Starting Ingester for ${this.configs.length} pair(s)`);

    for (const cfg of this.configs) {
      // 초기 백필: 최근 2시간 데이터
      await this.backfill(cfg);

      // 주기적 폴링 시작
      const timer = setInterval(() => this.poll(cfg), cfg.pollIntervalMs);
      this.timers.set(cfg.pairAddress, timer);
      log.info(`Polling started: ${cfg.pairAddress} every ${cfg.pollIntervalMs}ms`);
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

  private async backfill(cfg: IngesterConfig): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const twoHoursAgo = now - 7200;

    try {
      const candles = await this.birdeyeClient.getOHLCV(
        cfg.pairAddress,
        cfg.intervalType,
        twoHoursAgo,
        now
      );

      if (candles.length > 0) {
        await this.candleStore.insertCandles(candles);
        this.lastFetchTime.set(cfg.pairAddress, now);
        log.info(`Backfilled ${candles.length} candles for ${cfg.pairAddress}`);
      }
    } catch (error) {
      log.error(`Backfill failed for ${cfg.pairAddress}: ${error}`);
    }
  }

  private async poll(cfg: IngesterConfig): Promise<void> {
    if (!this.running) return;

    const now = Math.floor(Date.now() / 1000);
    const lastTime = this.lastFetchTime.get(cfg.pairAddress) || (now - 600);

    try {
      const candles = await this.birdeyeClient.getOHLCV(
        cfg.pairAddress,
        cfg.intervalType,
        lastTime,
        now
      );

      if (candles.length > 0) {
        await this.candleStore.insertCandles(candles);
        this.lastFetchTime.set(cfg.pairAddress, now);

        // 새 캔들 이벤트 발행 → Strategy Engine 트리거
        for (const candle of candles) {
          this.emit('newCandle', candle);
        }

        log.debug(`Polled ${candles.length} candle(s) for ${cfg.pairAddress}`);
      }
    } catch (error) {
      log.error(`Poll failed for ${cfg.pairAddress}: ${error}`);
      this.emit('error', { pairAddress: cfg.pairAddress, error });
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
