import { evaluateGates, evaluateGatesAsync } from '../gate';
import { buildLiveGateInput } from '../gate/liveGateInput';
import { MicroCandleBuilder } from '../realtime';
import { buildMomentumTriggerOrder } from '../strategy';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { Signal } from '../utils/types';
import { resolveRealtimeDiscoveryTelemetry } from './realtimeDiscoveryTelemetry';
import { processSignal } from './signalProcessor';
import { BotContext } from './types';
import { isEntryHaltActive } from './entryIntegrity';

const log = createModuleLogger('RealtimeHandler');

export async function handleRealtimeSignal(
  signal: Signal,
  candleBuilder: MicroCandleBuilder,
  ctx: BotContext
): Promise<void> {
  // 2026-04-17 Block 1.5-2: main-lane entry halt check. insertTrade 실패 누적 방지.
  // `resetEntryHalt('main')` 후에만 신규 entry 재개.
  if (isEntryHaltActive('main')) {
    log.warn(`[MAIN_ENTRY_HALT] signal ignored — entry halt active. Call resetEntryHalt('main') after reconciliation. pair=${signal.pairAddress.slice(0,12)}`);
    return;
  }
  const gateStartedAt = new Date();
  const watchlist = ctx.universeEngine.getWatchlist();
  const poolInfo = watchlist.find((pool) => pool.pairAddress === signal.pairAddress);
  const candles = candleBuilder.getRecentCandles(
    signal.pairAddress,
    config.realtimePrimaryIntervalSec,
    30
  );
  if (candles.length < 21) {
    log.debug(`Skipping realtime signal for ${signal.pairAddress}: not enough candles`);
    await trackRealtimeShadowSignal({
      signal,
      candleBuilder,
      ctx,
      poolInfo,
      gateStartedAt,
      filterReason: 'insufficient_primary_candles',
    });
    return;
  }

  if (!poolInfo) {
    log.info(`Skipping realtime signal for ${signal.pairAddress}: not in watchlist`);
    const recentlyEvicted = ctx.isInGracePeriod?.(signal.pairAddress) ?? false;
    // Phase 1: cohort 는 scanner 가 여전히 들고 있을 때만 파악 가능 — 그 외엔 'unknown'.
    // Watchlist 는 tokenMint 로 키잉되므로 pair-side lookup 사용.
    const fallbackCohort = ctx.scanner?.getEntryByPairAddress(signal.pairAddress)?.cohort;
    ctx.runtimeDiagnosticsTracker?.recordSignalNotInWatchlist(
      signal.pairAddress,
      recentlyEvicted ? 'recently_evicted' : undefined,
      fallbackCohort
    );
    await trackRealtimeShadowSignal({
      signal,
      candleBuilder,
      ctx,
      gateStartedAt,
      filterReason: recentlyEvicted ? 'not_in_watchlist_recently_evicted' : 'not_in_watchlist',
    });
    return;
  }

  if (
    config.operatorTokenBlacklist.includes(poolInfo.tokenMint) ||
    config.operatorTokenBlacklist.includes(signal.pairAddress)
  ) {
    log.info(`Skipping realtime signal for ${signal.pairAddress}: operator blacklist`);
    await trackRealtimeShadowSignal({
      signal,
      candleBuilder,
      ctx,
      gateStartedAt,
      poolInfo,
      filterReason: 'operator_blacklist',
    });
    return;
  }

  const scoresByMint = ctx.eventMonitor.getScoresByMint();
  const attentionScore = scoresByMint.get(poolInfo.tokenMint);
  const discoveryTelemetry = resolveRealtimeDiscoveryTelemetry(
    ctx,
    poolInfo.tokenMint,
    signal.timestamp.toISOString()
  );
  const poolTvl = poolInfo.tvl;
  const lastClose = candles[candles.length - 1].close;
  const lastLow = candles[candles.length - 1].low;
  const stopDistancePct = lastClose > 0 ? Math.abs(lastClose - lastLow) / lastClose : 0;
  const estimatedPositionSol = stopDistancePct > 0.001
    ? (config.maxRiskPerTrade * 10) / stopDistancePct
    : 1;
  const useAsyncGates = config.securityGateEnabled || config.quoteGateEnabled;

  let tokenSecurityData = undefined;
  let exitLiquidityData = undefined;

  // Gate cache: tick mode에서 동일 토큰 반복 fetch 방지
  // Why: security/exit liquidity만 cache — spread/sellImpact은 quote 기반이라 매번 측정
  const cached = ctx.gateCache?.get(poolInfo.tokenMint);
  if (cached) {
    tokenSecurityData = cached.tokenSecurityData;
    exitLiquidityData = cached.exitLiquidityData;
  } else if (config.securityGateEnabled && ctx.onchainSecurityClient) {
    try {
      const [secData, exitData] = await Promise.all([
        ctx.onchainSecurityClient.getTokenSecurityDetailed(poolInfo.tokenMint),
        ctx.onchainSecurityClient.getExitLiquidity(poolInfo.tokenMint),
      ]);
      tokenSecurityData = secData;
      exitLiquidityData = exitData;
      // P2-3: Token-2022 감지 시 로그
      if (secData?.tokenProgram === 'spl-token-2022') {
        log.info(`Token-2022 detected: ${poolInfo.tokenMint} extensions=[${secData.extensions?.join(',') ?? ''}]`);
      }
      // cache에 저장 (다음 signal에서 재사용)
      if (ctx.gateCache) {
        ctx.gateCache.set(poolInfo.tokenMint, { tokenSecurityData: secData, exitLiquidityData: exitData });
      }
    } catch (error) {
      log.warn(`Realtime security data fetch failed for ${poolInfo.tokenMint}: ${error}`);
      tokenSecurityData = null;
      exitLiquidityData = null;
    }
  } else if (config.securityGateEnabled) {
    log.warn(`Realtime security gate enabled without onchain client for ${poolInfo.tokenMint}`);
    tokenSecurityData = null;
    exitLiquidityData = null;
  }

  let measuredSpreadPct: number | undefined;
  let measuredFeePct: number | undefined;
  if (ctx.spreadMeasurer) {
    const measurement = await ctx.spreadMeasurer.measure(poolInfo.tokenMint);
    if (measurement) {
      measuredSpreadPct = measurement.spreadPct;
      measuredFeePct = measurement.effectiveFeePct;
    }
  }

  signal.meta.currentVolume24hUsd = poolInfo.dailyVolume;
  signal.tokenSymbol = poolInfo.symbol;
  signal.discoverySource = poolInfo.discoverySource;
  if (poolInfo.marketCap !== undefined) signal.meta.marketCapUsd = poolInfo.marketCap;
  if (poolInfo.marketCap && poolInfo.marketCap > 0 && poolInfo.dailyVolume > 0) {
    signal.meta.volumeMcapRatio = poolInfo.dailyVolume / poolInfo.marketCap;
  }
  const gateInput = buildLiveGateInput({
    signal,
    candles,
    poolInfo,
    previousTvl: ctx.previousTvl.get(signal.pairAddress) || poolTvl,
    attentionScore,
    estimatedPositionSol,
    executionRrReject: config.executionRrReject,
    executionRrPass: config.executionRrPass,
    executionRrBasis: config.executionRrBasis as 'tp1' | 'tp2',
    realtimeOrderParams: {
      slMode: config.realtimeSlMode as 'atr' | 'swing_low' | 'candle_low',
      slAtrMultiplier: config.realtimeSlAtrMultiplier,
      slSwingLookback: config.realtimeSlSwingLookback,
      timeStopMinutes: config.realtimeTimeStopMinutes,
      atrPeriod: 14,
      tp1Multiplier: config.tp1Multiplier,
      tp2Multiplier: config.tp2Multiplier,
      atrFloorPct: config.atrFloorPct,   // Option β 2026-04-10
    },
    fibConfig: {
      impulseMinPct: config.fibImpulseMinPct,
      volumeClimaxMultiplier: config.fibVolumeClimaxMultiplier,
      minWickRatio: config.fibMinWickRatio,
    },
    thresholds: {
      minBuyRatio: config.minBuyRatio,
      minBreakoutScore: config.minBreakoutScore,
    },
  });

  gateInput.tokenSecurityData = tokenSecurityData;
  gateInput.exitLiquidityData = exitLiquidityData;
  gateInput.quoteGateConfig = config.quoteGateEnabled ? {
    jupiterApiUrl: config.jupiterApiUrl,
    jupiterApiKey: config.jupiterApiKey || undefined,
    maxPriceImpact: config.maxPoolImpact,
  } : undefined;
  gateInput.enableSecurityGate = config.securityGateEnabled;
  gateInput.enableQuoteGate = config.quoteGateEnabled;
  if (ctx.spreadMeasurer) {
    gateInput.sellImpactPct = await ctx.spreadMeasurer.measureSellImpact(
      poolInfo.tokenMint,
      estimatedPositionSol
    ) ?? undefined;
  }
  gateInput.maxSellImpact = config.maxSellImpact;
  gateInput.sellImpactSizingThreshold = config.sellImpactSizingThreshold;

  const gateResult = useAsyncGates
    ? await evaluateGatesAsync(gateInput)
    : evaluateGates(gateInput);
  const gateEndedAt = new Date();

  signal.breakoutScore = gateResult.breakoutScore;
  signal.poolTvl = poolTvl;
  signal.spreadPct = measuredSpreadPct ?? poolInfo.spreadPct;
  const resolvedFee = measuredFeePct ?? poolInfo.ammFeePct;
  if (resolvedFee !== undefined) signal.meta.ammFeePct = resolvedFee;
  if (poolInfo.mevMarginPct !== undefined) signal.meta.mevMarginPct = poolInfo.mevMarginPct;

  const previewOrder = buildMomentumTriggerOrder(signal, candles, 1, {
    slMode: (config.realtimeSlMode as 'atr' | 'swing_low' | 'candle_low'),
    slAtrMultiplier: config.realtimeSlAtrMultiplier,
    slSwingLookback: config.realtimeSlSwingLookback,
    timeStopMinutes: config.realtimeTimeStopMinutes,
    atrPeriod: 14,
    tp1Multiplier: config.tp1Multiplier,
    tp2Multiplier: config.tp2Multiplier,
    atrFloorPct: config.atrFloorPct,   // Option β 2026-04-10
  });
  const processingStartedAt = new Date();
  const processResult = await processSignal(signal, candles, ctx, gateResult);
  const processingEndedAt = new Date();

  if (ctx.realtimeOutcomeTracker) {
    const estimatedCostPct =
      (signal.spreadPct ?? 0) +
      (signal.meta.ammFeePct ?? 0) +
      (signal.meta.mevMarginPct ?? 0);
    const recentObservationCandles = candleBuilder.getRecentCandles(
      signal.pairAddress,
      5,
      ctx.realtimeOutcomeTracker.getRequiredHistoryCount()
    );
    // Phase 1: cohort attached from scanner watchlist at signal time (pair-keyed lookup)
    const signalCohort = ctx.scanner?.getEntryByPairAddress(signal.pairAddress)?.cohort;
    ctx.realtimeOutcomeTracker.track({
      version: 1,
      id: `${signal.strategy}:${signal.pairAddress}:${signal.timestamp.toISOString()}`,
      source: 'runtime',
      strategy: signal.strategy,
      pairAddress: signal.pairAddress,
      poolAddress: poolInfo.pairAddress,
      tokenMint: poolInfo.tokenMint,
      cohort: signalCohort,
      referencePrice: signal.price,
      signalTimestamp: signal.timestamp.toISOString(),
      estimatedCostPct,
      tokenSymbol: poolInfo.symbol,
      trigger: {
        primaryIntervalSec: signal.meta.primaryIntervalSec ?? config.realtimePrimaryIntervalSec,
        confirmIntervalSec: signal.meta.confirmIntervalSec ?? config.realtimeConfirmIntervalSec,
        primaryCandleStartSec: signal.meta.primaryCandleStartSec,
        primaryCandleCloseSec: signal.meta.primaryCandleCloseSec,
        volumeRatio: signal.meta.volumeRatio,
        avgVolume: signal.meta.avgVolume,
        currentVolume: signal.meta.currentVolume,
        breakoutHigh: signal.meta.highestHigh,
        confirmPriceChangePct: signal.meta.confirmPriceChangePct,
        confirmBullishBars: signal.meta.confirmBullishBars,
        atr: signal.meta.atr,
        triggerMode: signal.meta.triggerMode,
        buyRatio: signal.meta.buyRatio,
        breakoutScore: gateResult.breakoutScore.totalScore,
        breakoutGrade: gateResult.breakoutScore.grade,
      },
      orderPreview: {
        stopLoss: previewOrder.stopLoss,
        takeProfit1: previewOrder.takeProfit1,
        takeProfit2: previewOrder.takeProfit2,
        trailingStop: previewOrder.trailingStop,
        plannedRiskPct: signal.price > 0
          ? Math.abs(signal.price - previewOrder.stopLoss) / signal.price
          : undefined,
      },
      gate: {
        startedAt: gateStartedAt.toISOString(),
        endedAt: gateEndedAt.toISOString(),
        latencyMs: Math.max(0, gateEndedAt.getTime() - gateStartedAt.getTime()),
        rejected: gateResult.rejected,
        filterReason: gateResult.filterReason,
        breakoutScore: gateResult.breakoutScore.totalScore,
        breakoutGrade: gateResult.breakoutScore.grade,
      },
      processing: {
        startedAt: processingStartedAt.toISOString(),
        endedAt: processingEndedAt.toISOString(),
        latencyMs: Math.max(0, processingEndedAt.getTime() - processingStartedAt.getTime()),
        status: processResult.status,
        filterReason: processResult.filterReason,
        tradeId: processResult.tradeId,
        txSignature: processResult.txSignature,
      },
      context: {
        poolTvl,
        attentionScore: attentionScore?.attentionScore,
        spreadPct: signal.spreadPct,
        ammFeePct: signal.meta.ammFeePct,
        mevMarginPct: signal.meta.mevMarginPct,
        currentVolume24hUsd: signal.meta.currentVolume24hUsd,
        discoveryTimestamp: discoveryTelemetry?.discoveryTimestamp,
        triggerWarmupLatencyMs: discoveryTelemetry?.triggerWarmupLatencyMs,
        marketCapUsd: signal.meta.marketCapUsd,
        volumeMcapRatio: signal.meta.volumeMcapRatio,
      },
    }, recentObservationCandles);
  }

  ctx.previousTvl.set(signal.pairAddress, poolTvl);
}

async function trackRealtimeShadowSignal({
  signal,
  candleBuilder,
  ctx,
  gateStartedAt,
  filterReason,
  poolInfo,
}: {
  signal: Signal;
  candleBuilder: MicroCandleBuilder;
  ctx: BotContext;
  gateStartedAt: Date;
  filterReason: string;
  poolInfo?: {
    pairAddress: string;
    tokenMint: string;
    tvl: number;
    dailyVolume: number;
    spreadPct?: number;
    ammFeePct?: number;
    mevMarginPct?: number;
    symbol?: string;
    marketCap?: number;
  };
}): Promise<void> {
  if (!ctx.realtimeOutcomeTracker) return;

  const completedAt = new Date();
  const recentObservationCandles = candleBuilder.getRecentCandles(
    signal.pairAddress,
    5,
    ctx.realtimeOutcomeTracker.getRequiredHistoryCount()
  );
  const estimatedCostPct =
    (signal.spreadPct ?? poolInfo?.spreadPct ?? 0) +
    (signal.meta.ammFeePct ?? poolInfo?.ammFeePct ?? 0) +
    (signal.meta.mevMarginPct ?? poolInfo?.mevMarginPct ?? 0);
  const discoveryTelemetry = resolveRealtimeDiscoveryTelemetry(
    ctx,
    poolInfo?.tokenMint,
    signal.timestamp.toISOString()
  );

  // Phase 1: cohort attached from scanner watchlist at shadow-track time (pair-keyed lookup)
  const shadowCohort = ctx.scanner?.getEntryByPairAddress(signal.pairAddress)?.cohort;
  ctx.realtimeOutcomeTracker.track({
    version: 1,
    id: `${signal.strategy}:${signal.pairAddress}:${signal.timestamp.toISOString()}`,
    source: 'runtime',
    strategy: signal.strategy,
    pairAddress: signal.pairAddress,
    poolAddress: poolInfo?.pairAddress,
    tokenMint: poolInfo?.tokenMint,
    tokenSymbol: poolInfo?.symbol,
    cohort: shadowCohort,
    signalTimestamp: signal.timestamp.toISOString(),
    referencePrice: signal.price,
    estimatedCostPct,
    trigger: {
      primaryIntervalSec: signal.meta.primaryIntervalSec ?? config.realtimePrimaryIntervalSec,
      confirmIntervalSec: signal.meta.confirmIntervalSec ?? config.realtimeConfirmIntervalSec,
      primaryCandleStartSec: signal.meta.primaryCandleStartSec,
      primaryCandleCloseSec: signal.meta.primaryCandleCloseSec,
      volumeRatio: signal.meta.volumeRatio,
      avgVolume: signal.meta.avgVolume,
      currentVolume: signal.meta.currentVolume,
      breakoutHigh: signal.meta.highestHigh,
      confirmPriceChangePct: signal.meta.confirmPriceChangePct,
      confirmBullishBars: signal.meta.confirmBullishBars,
      atr: signal.meta.atr,
      triggerMode: signal.meta.triggerMode,
      buyRatio: signal.meta.buyRatio,
    },
    gate: {
      startedAt: gateStartedAt.toISOString(),
      endedAt: completedAt.toISOString(),
      latencyMs: Math.max(0, completedAt.getTime() - gateStartedAt.getTime()),
      rejected: true,
      filterReason,
    },
    processing: {
      startedAt: completedAt.toISOString(),
      endedAt: completedAt.toISOString(),
      latencyMs: 0,
      status: 'gate_rejected',
      filterReason,
    },
    context: poolInfo ? {
      poolTvl: poolInfo.tvl,
      spreadPct: signal.spreadPct ?? poolInfo.spreadPct,
      ammFeePct: signal.meta.ammFeePct ?? poolInfo.ammFeePct,
      mevMarginPct: signal.meta.mevMarginPct ?? poolInfo.mevMarginPct,
      currentVolume24hUsd: poolInfo.dailyVolume,
      discoveryTimestamp: discoveryTelemetry?.discoveryTimestamp,
      triggerWarmupLatencyMs: discoveryTelemetry?.triggerWarmupLatencyMs,
      marketCapUsd: poolInfo.marketCap,
      volumeMcapRatio: poolInfo.marketCap && poolInfo.marketCap > 0 && poolInfo.dailyVolume > 0
        ? poolInfo.dailyVolume / poolInfo.marketCap : undefined,
    } : undefined,
  }, recentObservationCandles);
}
