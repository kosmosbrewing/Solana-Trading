/**
 * KOL Candle Coverage Telemetry (2026-06-10, edge-audit 07 root cause fix)
 *
 * Why: 2026-05-18 subscribe-on-candidate 도입 후에도 coverage 가 2.4% 에 머문
 * root cause 분해 (resolution miss 70% / window misalign 15% / zero-candle 13%) 가
 * grep 기반 사후 분석으로만 가능했다. 다음 run 에서 검증할 수 있게 일별 funnel
 * counter (requested → resolved → subscribed → evicted/expired) 를 JSONL 로 남긴다.
 *
 * 설계: 관측 전용 — append 실패해도 trading 경로 차단 금지 (fail-open).
 * 출력: `${realtimeDataDir}/kol-candle-coverage-telemetry.jsonl`
 *   - kind='interval' (default 60분): 당일 진행 중 snapshot (재시작/당일 검증용)
 *   - kind='day_final': UTC day rollover 시 확정치 기록 후 counter reset
 */
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('KolCandleCoverageTelemetry');

export type KolCandleCoverageRemovalCause = 'capacity_evict' | 'ttl_expire' | 'replaced';

export interface KolCandleCoverageTelemetryCounters {
  requested: number;
  resolveMiss: Record<string, number>;
  subscribedNew: number;
  refreshed: number;
  seedSwaps: number;
  capacityEvicted: number;
  ttlExpired: number;
  replaced: number;
}

export interface KolCandleCoverageTelemetrySnapshot extends KolCandleCoverageTelemetryCounters {
  kind: 'interval' | 'day_final';
  day: string;
  recordedAt: string;
}

function emptyCounters(): KolCandleCoverageTelemetryCounters {
  return {
    requested: 0,
    resolveMiss: {},
    subscribedNew: 0,
    refreshed: 0,
    seedSwaps: 0,
    capacityEvicted: 0,
    ttlExpired: 0,
    replaced: 0,
  };
}

function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class KolCandleCoverageTelemetry {
  private counters = emptyCounters();
  private day: string;
  private dirEnsured = false;
  private readonly filePath: string;
  private readonly now: () => number;
  private flushTimer?: NodeJS.Timeout;

  constructor(options: {
    filePath: string;
    now?: () => number;
    flushIntervalMs?: number;
  }) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.day = utcDayOf(this.now());
    const flushIntervalMs = options.flushIntervalMs ?? 60 * 60 * 1000;
    if (flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        void this.flush('interval');
      }, flushIntervalMs);
      // Why: 관측 전용 timer 가 프로세스 종료를 붙잡으면 안 됨
      this.flushTimer.unref?.();
    }
  }

  recordRequested(): void {
    this.maybeRollover();
    this.counters.requested += 1;
  }

  recordResolveMiss(reason: string): void {
    this.maybeRollover();
    const key = reason || 'no_context';
    this.counters.resolveMiss[key] = (this.counters.resolveMiss[key] ?? 0) + 1;
  }

  recordSubscribed(alreadyTracking: boolean): void {
    this.maybeRollover();
    if (alreadyTracking) this.counters.refreshed += 1;
    else this.counters.subscribedNew += 1;
  }

  recordSeedSwaps(count: number): void {
    this.maybeRollover();
    if (Number.isFinite(count) && count > 0) this.counters.seedSwaps += count;
  }

  recordRemoved(cause: KolCandleCoverageRemovalCause): void {
    this.maybeRollover();
    if (cause === 'capacity_evict') this.counters.capacityEvicted += 1;
    else if (cause === 'ttl_expire') this.counters.ttlExpired += 1;
    else this.counters.replaced += 1;
  }

  getSnapshot(kind: 'interval' | 'day_final' = 'interval'): KolCandleCoverageTelemetrySnapshot {
    return {
      kind,
      day: this.day,
      recordedAt: new Date(this.now()).toISOString(),
      ...this.counters,
      resolveMiss: { ...this.counters.resolveMiss },
    };
  }

  async flush(kind: 'interval' | 'day_final' = 'interval'): Promise<void> {
    // record* 없이 day 가 넘어간 경우에도 직전 날 day_final 을 놓치지 않도록 먼저 rollover.
    this.maybeRollover();
    const snapshot = this.getSnapshot(kind);
    if (kind === 'interval' && snapshot.requested === 0) return; // idle day noise 방지
    await this.append(snapshot);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /** UTC day 가 바뀌면 직전 날을 day_final 로 확정 기록하고 counter reset. */
  private maybeRollover(): void {
    const currentDay = utcDayOf(this.now());
    if (currentDay === this.day) return;
    const finalized = this.getSnapshot('day_final');
    this.counters = emptyCounters();
    this.day = currentDay;
    if (finalized.requested > 0) {
      log.info(
        `[KOL_CANDLE_COVERAGE_TELEMETRY] day_final ${finalized.day} ` +
        `requested=${finalized.requested} subscribedNew=${finalized.subscribedNew} ` +
        `refreshed=${finalized.refreshed} capacityEvicted=${finalized.capacityEvicted} ` +
        `ttlExpired=${finalized.ttlExpired} resolveMiss=${JSON.stringify(finalized.resolveMiss)}`
      );
      void this.append(finalized);
    }
  }

  private async append(snapshot: KolCandleCoverageTelemetrySnapshot): Promise<void> {
    try {
      if (!this.dirEnsured) {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        this.dirEnsured = true;
      }
      await appendFile(this.filePath, JSON.stringify(snapshot) + '\n', 'utf8');
    } catch (error) {
      log.debug(`[KOL_CANDLE_COVERAGE_TELEMETRY] append failed (non-fatal): ${error}`);
    }
  }
}
