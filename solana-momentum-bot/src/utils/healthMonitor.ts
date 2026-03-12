import { createModuleLogger } from './logger';
import { HealthStatus } from './types';

const log = createModuleLogger('HealthMonitor');

export class HealthMonitor {
  private startTime: number;
  private lastCandleAt?: Date;
  private lastTradeAt?: Date;
  private dbConnected = false;
  private wsConnected = false;
  private openPositions = 0;
  private dailyPnl = 0;
  private checkInterval?: NodeJS.Timeout;

  constructor() {
    this.startTime = Date.now();
  }

  start(intervalMs = 60000): void {
    this.checkInterval = setInterval(() => this.logStatus(), intervalMs);
    log.info('Health monitor started');
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }

  updateCandleTime(): void {
    this.lastCandleAt = new Date();
  }

  updateTradeTime(): void {
    this.lastTradeAt = new Date();
  }

  setDbConnected(connected: boolean): void {
    this.dbConnected = connected;
  }

  setWsConnected(connected: boolean): void {
    this.wsConnected = connected;
  }

  updatePositions(count: number): void {
    this.openPositions = count;
  }

  updateDailyPnl(pnl: number): void {
    this.dailyPnl = pnl;
  }

  getStatus(): HealthStatus {
    return {
      uptime: Date.now() - this.startTime,
      lastCandleAt: this.lastCandleAt,
      lastTradeAt: this.lastTradeAt,
      dbConnected: this.dbConnected,
      wsConnected: this.wsConnected,
      openPositions: this.openPositions,
      dailyPnl: this.dailyPnl,
    };
  }

  private logStatus(): void {
    const status = this.getStatus();
    const uptimeMin = Math.floor(status.uptime / 60000);

    log.info(
      `Uptime: ${uptimeMin}m | DB: ${status.dbConnected ? 'OK' : 'DOWN'} | ` +
      `Positions: ${status.openPositions} | Daily PnL: ${status.dailyPnl.toFixed(4)} SOL | ` +
      `Last candle: ${status.lastCandleAt?.toISOString() || 'never'}`
    );

    // 캔들 수집 중단 감지 — 10분 이상 새 캔들 없으면 경고
    if (this.lastCandleAt) {
      const gap = Date.now() - this.lastCandleAt.getTime();
      if (gap > 10 * 60 * 1000) {
        log.warn(`No candle received for ${Math.floor(gap / 60000)} minutes!`);
      }
    }
  }
}
