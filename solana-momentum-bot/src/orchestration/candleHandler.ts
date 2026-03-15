import {
  evaluateVolumeSpikeBreakout,
  evaluateFibPullback,
} from '../strategy';
import { evaluateGates } from '../gate';
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

  // Strategy A: Volume Spike Breakout (5분봉)
  if (candle.intervalSec === 300) {
    const signal = evaluateVolumeSpikeBreakout(candles, {
      lookback: config.volumeSpikeLookback,
      volumeMultiplier: config.volumeSpikeMultiplier,
    });

    if (signal.action === 'BUY') {
      const prevTvl = ctx.previousTvl.get(candle.pairAddress) || poolTvl;
      const gateResult = evaluateGates(buildLiveGateInput({
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
      }));

      signal.breakoutScore = gateResult.breakoutScore;
      signal.poolTvl = poolTvl;
      signal.spreadPct = poolInfo.spreadPct;
      if (poolInfo.ammFeePct !== undefined) signal.meta.ammFeePct = poolInfo.ammFeePct;
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
        const prevTvl = ctx.previousTvl.get(candle.pairAddress) || poolTvl;
        const gateResult = evaluateGates(buildLiveGateInput({
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
        }));

        fibSignal.poolTvl = poolTvl;
        fibSignal.breakoutScore = gateResult.breakoutScore;
        fibSignal.spreadPct = poolInfo.spreadPct;
        if (poolInfo.ammFeePct !== undefined) fibSignal.meta.ammFeePct = poolInfo.ammFeePct;
        if (poolInfo.mevMarginPct !== undefined) fibSignal.meta.mevMarginPct = poolInfo.mevMarginPct;

        await processSignal(fibSignal, fibCandles, ctx, gateResult);
      }
    }
  }

  ctx.previousTvl.set(candle.pairAddress, poolTvl);
}
