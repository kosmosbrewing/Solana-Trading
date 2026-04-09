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

const log = createModuleLogger('MonitoringLoops');

const REGIME_UPDATE_INTERVAL_MS = 15 * 60 * 1000;

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

  return { positionCheckInterval, regimeInterval, pruneInterval };
}
