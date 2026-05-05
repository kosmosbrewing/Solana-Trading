import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { checkOpenPositions } from '../orchestration/tradeExecution';
import { Notifier } from '../notifier';
import { BotContext } from '../orchestration/types';
import { RegimeFilter } from '../risk';
import { type PaperMetricsSummary } from '../reporting/paperMetrics';
import { EventScoreStore } from '../event';
import { SOL_MINT } from '../utils/constants';
import { Candle, CandleInterval } from '../utils/types';
import { flushKolHourlyDigest } from '../orchestration/kolPaperNotifier';
import { flushPureWsPaperDigest } from '../orchestration/pureWs/paperDigest';
import { flushRotationPaperDigest } from '../orchestration/rotationPaperDigest';

const log = createModuleLogger('MonitoringLoops');

const REGIME_UPDATE_INTERVAL_MS = 15 * 60 * 1000;
const DIGEST_SCHEDULER_POLL_MS = 30_000;
const STARTUP_DIGEST_ALIGNED_SUPPRESS_MS = 120_000;
// 2026-04-29 (Tier 1 noise reduction): 1h → 2h.
// Why: 매 시간 발사 = 24 msg/day. heartbeat (KST 짝수 hour) 와 동기 시 12 msg/day.
//   reporting.ts 의 hourly batch (heartbeat 시 시간별 1줄 요약) 와 정보 중복도 감소.
//   `KOL_HOURLY_DIGEST_INTERVAL_MS` env override 로 운영자 조정 가능.
const KOL_HOURLY_DIGEST_INTERVAL_MS = Number(process.env.KOL_HOURLY_DIGEST_INTERVAL_MS ?? '7200000');

function kstHourOf(date: Date): number {
  return (date.getUTCHours() + 9) % 24;
}

function startDigestLoop(
  label: string,
  intervalMs: number,
  flush: (options?: { force?: boolean }) => Promise<void>,
  options: { startupDelayMs?: number } = {}
): ReturnType<typeof setInterval> {
  const safeIntervalMs = Math.max(60_000, intervalMs);
  const intervalHours = safeIntervalMs % 3_600_000 === 0 ? safeIntervalMs / 3_600_000 : 0;
  let lastStartupForcedAtMs = 0;
  if (options.startupDelayMs != null) {
    const startupTimer = setTimeout(() => {
      lastStartupForcedAtMs = Date.now();
      void flush({ force: true }).catch((error) => {
        log.warn(`${label} startup flush failed: ${error}`);
      });
    }, Math.max(0, options.startupDelayMs));
    startupTimer.unref?.();
  }

  if (intervalHours >= 1) {
    let lastFiredUtcHour = -1;
    const handle = setInterval(async () => {
      const now = new Date();
      const utcHour = Math.floor(now.getTime() / 3_600_000);
      if (utcHour === lastFiredUtcHour) return;
      if (lastStartupForcedAtMs > 0 && now.getTime() - lastStartupForcedAtMs < STARTUP_DIGEST_ALIGNED_SUPPRESS_MS) {
        lastFiredUtcHour = utcHour;
        return;
      }

      const kstHour = kstHourOf(now);
      if (kstHour % intervalHours !== 0) return;

      lastFiredUtcHour = utcHour;
      try {
        await flush();
      } catch (error) {
        log.warn(`${label} failed: ${error}`);
      }
    }, DIGEST_SCHEDULER_POLL_MS);
    log.info(`${label} scheduled — interval=${safeIntervalMs / 60000}min, KST-hour aligned`);
    return handle;
  }

  const handle = setInterval(async () => {
    try {
      await flush();
    } catch (error) {
      log.warn(`${label} failed: ${error}`);
    }
  }, safeIntervalMs);
  log.info(`${label} scheduled — interval=${safeIntervalMs / 60000}min`);
  return handle;
}

export interface MonitoringDeps {
  ctx: BotContext;
  notifier: Notifier;
  regimeFilter: RegimeFilter;
  eventScoreStore: EventScoreStore;
  tokenPairResolver: { getBestPoolAddress: (mint: string) => Promise<string | null> };
  internalCandleSource: {
    getCandlesInRange: (pair: string, interval: number, from: Date, to: Date) =>
      Promise<Candle[]>;
  };
  geckoClient: {
    getOHLCV: (pair: string, tf: CandleInterval, from: number, to: number) =>
      Promise<Candle[]>;
  };
  paperMetrics: { getSummary: (hours: number) => PaperMetricsSummary };
  regimeSolCacheTtlMs: number;
}

export interface MonitoringHandles {
  positionCheckInterval: ReturnType<typeof setInterval>;
  regimeInterval: ReturnType<typeof setInterval>;
  pruneInterval: ReturnType<typeof setInterval>;
  kolHourlyDigestInterval: ReturnType<typeof setInterval> | null;
  pureWsPaperDigestInterval: ReturnType<typeof setInterval> | null;
  rotationPaperDigestInterval: ReturnType<typeof setInterval> | null;
  // 2026-04-27: shutdown 시 cleanup 위해 main() 에서 startMonitoringLoops 호출 후 직접 set.
  dailySummaryInterval?: ReturnType<typeof setInterval>;
  pureWsV2TelemetryInterval?: ReturnType<typeof setInterval>;
  canaryAutoResetInterval?: ReturnType<typeof setInterval>;
}

// Phase E1 (2026-04-08): exit mechanism mode 별 position check 주기.
// - legacy: 5s (기존 동작)
// - hybrid_c5: 1s — C1 part. swap latency 자체는 줄지 않으나 monitor observation lag 축소
// 자세한 lifecycle 은 docs/exec-plans/active/exit-execution-mechanism-2026-04-08.md
const POSITION_CHECK_INTERVAL_MS_LEGACY = 5000;
const POSITION_CHECK_INTERVAL_MS_HYBRID = 1000;

/**
 * 모니터링 루프 시작: position check, regime update, EventScore pruning
 */
export async function startMonitoringLoops(deps: MonitoringDeps): Promise<MonitoringHandles> {
  // ─── Position monitor (SL/TP/Time Stop/Exhaustion)
  const positionCheckIntervalMs = config.exitMechanismMode === 'hybrid_c5'
    ? POSITION_CHECK_INTERVAL_MS_HYBRID
    : POSITION_CHECK_INTERVAL_MS_LEGACY;
  log.info(
    `Position check interval: ${positionCheckIntervalMs}ms ` +
    `(exitMechanismMode=${config.exitMechanismMode})`
  );
  const positionCheckInterval = setInterval(async () => {
    try {
      await checkOpenPositions(deps.ctx);
    } catch (error) {
      log.error(`Position check error: ${error}`);
      await deps.notifier.sendError('position_check', error).catch(() => {});
    }
  }, positionCheckIntervalMs);

  // ─── Regime Filter periodic update
  let solPoolAddress: string | null = null;
  let cachedSol4hCandles: {
    bucketStartMs: number;
    fetchedAtMs: number;
    closes: { close: number; timestamp: number }[];
  } | null = null;

  const updateRegime = async () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const tenDaysAgo = now - 60 * 4 * 3600;

      if (!solPoolAddress) {
        solPoolAddress = await deps.tokenPairResolver.getBestPoolAddress(SOL_MINT);
      }

      if (solPoolAddress) {
        const nowMs = Date.now();
        const currentBucketStartMs = Math.floor(nowMs / (4 * 3600_000)) * (4 * 3600_000);
        const useCachedCandles = cachedSol4hCandles
          && cachedSol4hCandles.bucketStartMs === currentBucketStartMs
          && (nowMs - cachedSol4hCandles.fetchedAtMs) < deps.regimeSolCacheTtlMs;

        if (!useCachedCandles) {
          const internalSol4hCandles = await deps.internalCandleSource.getCandlesInRange(
            solPoolAddress,
            4 * 3600,
            new Date(tenDaysAgo * 1000),
            new Date(now * 1000)
          );
          const sol4hCandles = internalSol4hCandles.length > 0
            ? internalSol4hCandles
            : await deps.geckoClient.getOHLCV(solPoolAddress, '4H', tenDaysAgo, now);
          cachedSol4hCandles = {
            bucketStartMs: currentBucketStartMs,
            fetchedAtMs: nowMs,
            closes: sol4hCandles.map(c => ({
              close: c.close,
              timestamp: Math.floor(c.timestamp.getTime() / 1000),
            })),
          };
        }

        if ((cachedSol4hCandles?.closes.length ?? 0) >= 50) {
          deps.regimeFilter.updateSolTrend(cachedSol4hCandles!.closes);
        }
      }

      const summary = deps.paperMetrics.getSummary(48);
      if (summary.totalTrades > 0) {
        deps.regimeFilter.updateBreadth(summary.wins, summary.totalTrades);
        const tp1Hits = Math.round(summary.tp1HitRate * summary.totalTrades);
        deps.regimeFilter.updateFollowThrough(tp1Hits, summary.totalTrades);
      }

      const state = deps.regimeFilter.getState();
      log.info(
        `Regime: ${state.regime} (size=${state.sizeMultiplier}x) ` +
        `SOL=${state.solTrendBullish ? 'bull' : 'bear'} ` +
        `breadth=${(state.breadthPct * 100).toFixed(0)}% ` +
        `follow=${(state.followThroughPct * 100).toFixed(0)}%`
      );
    } catch (error) {
      log.warn(`Regime update failed: ${error}`);
    }
  };

  await updateRegime();
  const regimeInterval = setInterval(updateRegime, REGIME_UPDATE_INTERVAL_MS);

  // ─── Daily EventScore pruning
  const pruneInterval = setInterval(async () => {
    try {
      await deps.eventScoreStore.pruneOlderThan(config.eventScoreRetentionDays);
    } catch (error) {
      log.warn(`EventScore pruning failed: ${error}`);
    }
  }, 24 * 3600_000);

  // ─── KOL paper hourly digest (L1) — kol_hunter 켜져 있을 때만
  let kolHourlyDigestInterval: ReturnType<typeof setInterval> | null = null;
  if (config.kolHunterEnabled) {
    kolHourlyDigestInterval = startDigestLoop(
      'KOL hourly digest',
      KOL_HOURLY_DIGEST_INTERVAL_MS,
      () => flushKolHourlyDigest(deps.notifier)
    );
  }
  let pureWsPaperDigestInterval: ReturnType<typeof setInterval> | null = null;
  if (config.pureWsLaneEnabled && config.pureWsPaperNotifyEnabled && config.pureWsPaperDigestEnabled) {
    pureWsPaperDigestInterval = startDigestLoop(
      'pure_ws paper digest',
      config.pureWsPaperDigestIntervalMs,
      (options) => flushPureWsPaperDigest(deps.notifier, options),
      { startupDelayMs: 20_000 }
    );
  }
  let rotationPaperDigestInterval: ReturnType<typeof setInterval> | null = null;
  if (
    config.kolHunterEnabled &&
    config.kolHunterRotationV1Enabled &&
    config.kolHunterRotationPaperNotifyEnabled &&
    config.kolHunterRotationPaperDigestEnabled
  ) {
    rotationPaperDigestInterval = startDigestLoop(
      'rotation paper digest',
      config.kolHunterRotationPaperDigestIntervalMs,
      (options) => flushRotationPaperDigest(deps.notifier, options),
      { startupDelayMs: 25_000 }
    );
  }

  return {
    positionCheckInterval,
    regimeInterval,
    pruneInterval,
    kolHourlyDigestInterval,
    pureWsPaperDigestInterval,
    rotationPaperDigestInterval,
  };
}
