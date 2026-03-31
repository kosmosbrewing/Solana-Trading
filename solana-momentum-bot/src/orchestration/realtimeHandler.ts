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

const log = createModuleLogger('RealtimeHandler');

export async function handleRealtimeSignal(
  signal: Signal,
  candleBuilder: MicroCandleBuilder,
  ctx: BotContext
): Promise<void> {
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
    await trackRealtimeShadowSignal({
      signal,
      candleBuilder,
      ctx,
      gateStartedAt,
      filterReason: 'not_in_watchlist',
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
  if (config.securityGateEnabled && ctx.onchainSecurityClient) {
    try {
      const [secData, exitData] = await Promise.all([
        ctx.onchainSecurityClient.getTokenSecurityDetailed(poolInfo.tokenMint),
        ctx.onchainSecurityClient.getExitLiquidity(poolInfo.tokenMint),
      ]);
      tokenSecurityData = secData;
      exitLiquidityData = exitData;
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
      slAtrMultiplier: config.slAtrMultiplier,
      slSwingLookback: config.realtimeSlSwingLookback,
      timeStopMinutes: config.timeStopMinutes,
      atrPeriod: 14,
      tp1Multiplier: config.tp1Multiplier,
      tp2Multiplier: config.tp2Multiplier,
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
    slAtrMultiplier: config.slAtrMultiplier,
    slSwingLookback: config.realtimeSlSwingLookback,
    timeStopMinutes: config.timeStopMinutes,
    atrPeriod: 14,
    tp1Multiplier: config.tp1Multiplier,
    tp2Multiplier: config.tp2Multiplier,
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
    ctx.realtimeOutcomeTracker.track({
      version: 1,
      id: `${signal.strategy}:${signal.pairAddress}:${signal.timestamp.toISOString()}`,
      source: 'runtime',
      strategy: signal.strategy,
      pairAddress: signal.pairAddress,
      poolAddress: poolInfo.pairAddress,
      tokenMint: poolInfo.tokenMint,
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

  ctx.realtimeOutcomeTracker.track({
    version: 1,
    id: `${signal.strategy}:${signal.pairAddress}:${signal.timestamp.toISOString()}`,
    source: 'runtime',
    strategy: signal.strategy,
    pairAddress: signal.pairAddress,
    poolAddress: poolInfo?.pairAddress,
    tokenMint: poolInfo?.tokenMint,
    tokenSymbol: poolInfo?.symbol,
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
    } : undefined,
  }, recentObservationCandles);
}
