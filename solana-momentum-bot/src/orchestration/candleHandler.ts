import {
  evaluateVolumeSpikeBreakout,
  evaluateFibPullback,
} from '../strategy';
import { evaluateGates, evaluateGatesAsync } from '../gate';
import { buildLiveGateInput } from '../gate/liveGateInput';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { Candle } from '../utils/types';
import { processSignal } from './signalProcessor';
import { BotContext } from './types';

const log = createModuleLogger('CandleHandler');

export async function handleNewCandle(candle: Candle, ctx: BotContext): Promise<void> {
  const candles = await ctx.candleStore.getRecentCandles(
    candle.pairAddress,
    candle.intervalSec,
    30
  );

  if (candles.length < 21) {
    log.debug('Not enough candles for strategy evaluation');
    return;
  }

  // Get pool info for breakout score
  const watchlist = ctx.universeEngine.getWatchlist();
  const poolInfo = watchlist.find(p => p.pairAddress === candle.pairAddress);
  if (!poolInfo) {
    log.info(`Skipping ${candle.pairAddress} — pair is not in active watchlist`);
    return;
  }
  const poolTvl = poolInfo.tvl;

  // Gate 0: AttentionScore 조회 (트렌딩 화이트리스트 필터)
  const scoresByMint = ctx.eventMonitor.getScoresByMint();
  const attentionScore = scoresByMint.get(poolInfo.tokenMint);

  // 예상 포지션 사이즈 (early probe용): maxRiskPerTrade 기준
  const lastClose = candles[candles.length - 1].close;
  const lastLow = candles[candles.length - 1].low;
  const stopDistancePct = lastClose > 0 ? Math.abs(lastClose - lastLow) / lastClose : 0;
  const estimatedPositionSol = stopDistancePct > 0.001
    ? (config.maxRiskPerTrade * 10) / stopDistancePct
    : 1;

  // Phase 1A: Security + Quote Gate data (fetched once per candle, shared across strategies)
  const useAsyncGates = config.securityGateEnabled || config.quoteGateEnabled;
  let tokenSecurityData = undefined;
  let exitLiquidityData = undefined;

  if (useAsyncGates && ctx.birdeyeClient) {
    try {
      const [secData, exitData] = await Promise.all([
        config.securityGateEnabled
          ? ctx.birdeyeClient.getTokenSecurityDetailed(poolInfo.tokenMint)
          : Promise.resolve(undefined),
        config.securityGateEnabled
          ? ctx.birdeyeClient.getExitLiquidity(poolInfo.tokenMint)
          : Promise.resolve(undefined),
      ]);
      tokenSecurityData = secData;
      exitLiquidityData = exitData;
    } catch (error) {
      log.warn(`Security data fetch failed for ${poolInfo.tokenMint}: ${error}`);
    }
  }

  const quoteGateConfig = config.quoteGateEnabled ? {
    jupiterApiUrl: config.jupiterApiUrl,
    jupiterApiKey: config.jupiterApiKey || undefined,
    maxPriceImpact: config.maxPoolImpact,
  } : undefined;

  // Phase 2: Jupiter quote-based spread/fee measurement (H-2/H-3)
  // Why: spread/fee는 매 캔들 측정 (cached, 0.1 SOL probe)
  //       sell impact는 시그널 발생 시에만 position-sized probe로 별도 측정
  let measuredSpreadPct: number | undefined;
  let measuredFeePct: number | undefined;
  if (ctx.spreadMeasurer) {
    const measurement = await ctx.spreadMeasurer.measure(poolInfo.tokenMint);
    if (measurement) {
      measuredSpreadPct = measurement.spreadPct;
      measuredFeePct = measurement.effectiveFeePct;
    }
  }

  // Strategy A: Volume Spike Breakout (5분봉)
  if (candle.intervalSec === 300) {
    const signal = evaluateVolumeSpikeBreakout(candles, {
      lookback: config.volumeSpikeLookback,
      volumeMultiplier: config.volumeSpikeMultiplier,
    });

    if (signal.action === 'BUY') {
      signal.meta.currentVolume24hUsd = poolInfo.dailyVolume;
      const prevTvl = ctx.previousTvl.get(candle.pairAddress) || poolTvl;
      const gateInput = buildLiveGateInput({
        signal,
        candles,
        poolInfo,
        previousTvl: prevTvl,
        attentionScore,
        estimatedPositionSol,
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

      // Phase 1A: inject security/quote gate params
      gateInput.tokenSecurityData = tokenSecurityData;
      gateInput.exitLiquidityData = exitLiquidityData;
      gateInput.quoteGateConfig = quoteGateConfig;
      gateInput.enableSecurityGate = config.securityGateEnabled;
      gateInput.enableQuoteGate = config.quoteGateEnabled;
      // Exit gate: position-sized sell impact (시그널 발생 시에만 측정)
      if (ctx.spreadMeasurer) {
        gateInput.sellImpactPct = await ctx.spreadMeasurer.measureSellImpact(
          poolInfo.tokenMint, estimatedPositionSol
        ) ?? undefined;
      }
      gateInput.maxSellImpact = config.maxSellImpact;
      gateInput.sellImpactSizingThreshold = config.sellImpactSizingThreshold;

      const gateResult = useAsyncGates
        ? await evaluateGatesAsync(gateInput)
        : evaluateGates(gateInput);

      signal.breakoutScore = gateResult.breakoutScore;
      signal.poolTvl = poolTvl;
      signal.spreadPct = measuredSpreadPct ?? poolInfo.spreadPct;
      const resolvedFee = measuredFeePct ?? poolInfo.ammFeePct;
      if (resolvedFee !== undefined) signal.meta.ammFeePct = resolvedFee;
      if (poolInfo.mevMarginPct !== undefined) signal.meta.mevMarginPct = poolInfo.mevMarginPct;

      await processSignal(signal, candles, ctx, gateResult);
    }
  }

  // Strategy C: Fib Pullback (5분봉) — 임펄스 후 되돌림 매수
  if (candle.intervalSec === 300) {
    const fibCandles = await ctx.candleStore.getRecentCandles(
      candle.pairAddress,
      candle.intervalSec,
      Math.max(config.fibImpulseWindowBars + 10, 30)
    );

    if (fibCandles.length >= config.fibImpulseWindowBars + 5) {
      const fibSignal = evaluateFibPullback(fibCandles, {
        impulseWindowBars: config.fibImpulseWindowBars,
        impulseMinPct: config.fibImpulseMinPct,
        fibEntryLow: config.fibEntryLow,
        fibEntryHigh: config.fibEntryHigh,
        fibInvalidation: config.fibInvalidation,
        volumeClimaxMultiplier: config.fibVolumeClimaxMultiplier,
        minWickRatio: config.fibMinWickRatio,
        timeStopMinutes: config.fibTimeStopMinutes,
      });

      if (fibSignal.action === 'BUY') {
        fibSignal.meta.currentVolume24hUsd = poolInfo.dailyVolume;
        const prevTvl = ctx.previousTvl.get(candle.pairAddress) || poolTvl;
        const gateInput = buildLiveGateInput({
          signal: fibSignal,
          candles: fibCandles,
          poolInfo,
          previousTvl: prevTvl,
          attentionScore,
          estimatedPositionSol,
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

        // Phase 1A: inject security/quote gate params
        gateInput.tokenSecurityData = tokenSecurityData;
        gateInput.exitLiquidityData = exitLiquidityData;
        gateInput.quoteGateConfig = quoteGateConfig;
        gateInput.enableSecurityGate = config.securityGateEnabled;
        gateInput.enableQuoteGate = config.quoteGateEnabled;
        // Exit gate: position-sized sell impact (시그널 발생 시에만 측정)
        if (ctx.spreadMeasurer) {
          gateInput.sellImpactPct = await ctx.spreadMeasurer.measureSellImpact(
            poolInfo.tokenMint, estimatedPositionSol
          ) ?? undefined;
        }
        gateInput.maxSellImpact = config.maxSellImpact;
        gateInput.sellImpactSizingThreshold = config.sellImpactSizingThreshold;

        const gateResult = useAsyncGates
          ? await evaluateGatesAsync(gateInput)
          : evaluateGates(gateInput);

        fibSignal.poolTvl = poolTvl;
        fibSignal.breakoutScore = gateResult.breakoutScore;
        fibSignal.spreadPct = measuredSpreadPct ?? poolInfo.spreadPct;
        const fibResolvedFee = measuredFeePct ?? poolInfo.ammFeePct;
        if (fibResolvedFee !== undefined) fibSignal.meta.ammFeePct = fibResolvedFee;
        if (poolInfo.mevMarginPct !== undefined) fibSignal.meta.mevMarginPct = poolInfo.mevMarginPct;

        await processSignal(fibSignal, fibCandles, ctx, gateResult);
      }
    }
  }

  ctx.previousTvl.set(candle.pairAddress, poolTvl);
}
