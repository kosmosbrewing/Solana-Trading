import { EventEmitter } from 'events';

export interface RealtimeAdmissionStats {
  observedNotifications: number;
  logParsed: number;
  fallbackParsed: number;
  fallbackSkipped: number;
  parseRatePct: number;
  skippedRatePct: number;
}

export interface RealtimeAdmissionSnapshotEntry {
  pool: string;
  observedNotifications: number;
  logParsed: number;
  fallbackParsed: number;
  fallbackSkipped: number;
  blocked: boolean;
}

interface RealtimeAdmissionConfig {
  minObservedNotifications: number;
  minParseRatePct: number;
  minSkippedRatePct: number;
}

interface MutableStats {
  observedNotifications: number;
  logParsed: number;
  fallbackParsed: number;
  fallbackSkipped: number;
  blocked: boolean;
}

export class RealtimeAdmissionTracker extends EventEmitter {
  private readonly stats = new Map<string, MutableStats>();

  constructor(private readonly config: RealtimeAdmissionConfig) {
    super();
  }

  recordLogParsed(pool: string): void {
    const stats = this.getOrCreate(pool);
    stats.observedNotifications += 1;
    stats.logParsed += 1;
    this.evaluate(pool, stats);
  }

  recordFallbackParsed(pool: string): void {
    const stats = this.getOrCreate(pool);
    stats.observedNotifications += 1;
    stats.fallbackParsed += 1;
    this.evaluate(pool, stats);
  }

  recordParseMiss(pool: string): void {
    const stats = this.getOrCreate(pool);
    stats.observedNotifications += 1;
    this.evaluate(pool, stats);
  }

  recordFallbackSkipped(pool: string): void {
    const stats = this.getOrCreate(pool);
    stats.fallbackSkipped += 1;
    this.evaluate(pool, stats);
  }

  isBlocked(pool: string): boolean {
    return this.stats.get(pool)?.blocked ?? false;
  }

  getStats(pool: string): RealtimeAdmissionStats | null {
    const stats = this.stats.get(pool);
    return stats ? this.toPublicStats(stats) : null;
  }

  exportSnapshot(): RealtimeAdmissionSnapshotEntry[] {
    return [...this.stats.entries()].map(([pool, stats]) => ({
      pool,
      observedNotifications: stats.observedNotifications,
      logParsed: stats.logParsed,
      fallbackParsed: stats.fallbackParsed,
      fallbackSkipped: stats.fallbackSkipped,
      blocked: stats.blocked,
    }));
  }

  importSnapshot(entries: RealtimeAdmissionSnapshotEntry[]): void {
    for (const entry of entries) {
      this.stats.set(entry.pool, {
        observedNotifications: entry.observedNotifications,
        logParsed: entry.logParsed,
        fallbackParsed: entry.fallbackParsed ?? 0,
        fallbackSkipped: entry.fallbackSkipped,
        blocked: entry.blocked,
      });
    }
  }

  private getOrCreate(pool: string): MutableStats {
    const existing = this.stats.get(pool);
    if (existing) return existing;

    const created: MutableStats = {
      observedNotifications: 0,
      logParsed: 0,
      fallbackParsed: 0,
      fallbackSkipped: 0,
      blocked: false,
    };
    this.stats.set(pool, created);
    return created;
  }

  private evaluate(pool: string, stats: MutableStats): void {
    if (stats.blocked) return;
    if (stats.observedNotifications < this.config.minObservedNotifications) return;

    const publicStats = this.toPublicStats(stats);
    if (
      publicStats.parseRatePct < this.config.minParseRatePct &&
      publicStats.skippedRatePct >= this.config.minSkippedRatePct
    ) {
      stats.blocked = true;
      this.emit('blocked', { pool, stats: publicStats });
    }
  }

  private toPublicStats(stats: MutableStats): RealtimeAdmissionStats {
    const parseRatePct = stats.observedNotifications > 0
      ? ((stats.logParsed + stats.fallbackParsed) / stats.observedNotifications) * 100
      : 0;
    const skippedRatePct = stats.observedNotifications > 0
      ? (stats.fallbackSkipped / stats.observedNotifications) * 100
      : 0;
    return {
      observedNotifications: stats.observedNotifications,
      logParsed: stats.logParsed,
      fallbackParsed: stats.fallbackParsed,
      fallbackSkipped: stats.fallbackSkipped,
      parseRatePct: Number(parseRatePct.toFixed(2)),
      skippedRatePct: Number(skippedRatePct.toFixed(2)),
    };
  }
}
