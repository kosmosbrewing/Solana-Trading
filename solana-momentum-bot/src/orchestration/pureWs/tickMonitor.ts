// Tick-driven state machine — PROBE → T1 → T2 → T3 promotion + trail/hardcut/timeout exits.
// MAE/MFE 는 marketReferencePrice (signal price) 기준. Pnl 은 close.ts 에서 fill price 기준.
//
// 호출 빈도: candle close listener 또는 polling tick — index.ts 에서 결정.
// 모든 close path 는 closePureWsPosition 으로 위임 (serialize + ledger + notifier).

import { config } from '../../utils/config';
import type { MicroCandleBuilder } from '../../realtime';
import { evaluateQuickReject } from '../../risk/quickRejectClassifier';
import { evaluateHoldPhaseSentinel } from '../../risk/holdPhaseSentinel';
import type { BotContext } from '../types';
import { log } from './constants';
import { activePositions, funnelStats } from './positionState';
import { getPureWsLivePriceTracker } from './livePriceTracker';
import { trackPureWsClose } from './missedAlpha';
import { closePureWsPosition } from './close';
import type { PureWsPosition } from './types';

export async function updatePureWsPositions(
  ctx: BotContext,
  candleBuilder: MicroCandleBuilder
): Promise<void> {
  if (!config.pureWsLaneEnabled) return;

  const nowSec = Math.floor(Date.now() / 1000);

  for (const [id, pos] of activePositions) {
    if (pos.state === 'CLOSED') continue;

    const currentPrice = candleBuilder.getCurrentPrice(pos.pairAddress);
    if (currentPrice == null || currentPrice <= 0) continue;

    // HWM peak sanity (Patch B2 동일 원칙) — max 기준은 market reference price.
    const referencePrice = pos.marketReferencePrice;
    const maxPeak = referencePrice * config.pureWsMaxPeakMultiplier;
    const elapsedForPeak = nowSec - pos.entryTimeSec;
    // 2026-04-19 (QA Q2): Peak warmup — 진입 직후 pureWsPeakWarmupSec 동안은 봇 자신의
    // BUY tx 가 pool price 를 띄운 영향이 candleBuilder currentPrice 에 반영될 수 있음.
    // 따라서 market ref 대비 peakWarmupMaxDeviationPct 이내만 peak 로 인정.
    const peakCeilingInWarmup =
      elapsedForPeak < config.pureWsPeakWarmupSec
        ? referencePrice * (1 + config.pureWsPeakWarmupMaxDeviationPct)
        : maxPeak;
    if (currentPrice > pos.peakPrice && currentPrice <= peakCeilingInWarmup) {
      pos.peakPrice = currentPrice;
    }
    if (currentPrice < pos.troughPrice) {
      pos.troughPrice = currentPrice;
    }

    // 2026-04-19: MAE/MFE/currentPct 는 market reference (signal price) 기준.
    // Jupiter bad-fill 의 entry-to-fill gap 이 시장 이동으로 잡히지 않도록 분리.
    // Pnl 계산은 closePureWsPosition 에서 entryPrice (Jupiter fill) 기준 유지.
    const mfePct = (pos.peakPrice - referencePrice) / referencePrice;
    const maePct = (pos.troughPrice - referencePrice) / referencePrice;
    const currentPct = (currentPrice - referencePrice) / referencePrice;
    const elapsedSec = nowSec - pos.entryTimeSec;

    // 2026-04-26: shadow arm override resolution.
    // primary 는 모든 override 가 undefined → 기존 config 그대로. swing-v2 shadow 만 override 적용.
    const effProbeWindowSec =
      pos.probeWindowSecOverride ?? pos.continuationProbeWindowSec ?? config.pureWsProbeWindowSec;
    const effProbeHardCutPct = pos.probeHardCutPctOverride ?? config.pureWsProbeHardCutPct;
    const effT1TrailPct = pos.t1TrailPctOverride ?? config.pureWsT1TrailingPct;
    const effT1ProfitFloor = pos.t1ProfitFloorMultOverride;

    switch (pos.state) {
      case 'PROBE': {
        // Hard cut (loser quick cut)
        if (maePct <= -effProbeHardCutPct) {
          log.info(
            `[PUREWS_LOSER_HARDCUT] ${id} MAE=${(maePct * 100).toFixed(2)}% elapsed=${elapsedSec}s`
          );
          trackPureWsClose(pos, 'probe_hard_cut', 'REJECT_HARD_CUT', nowSec, mfePct, maePct, currentPrice);
          await closePureWsPosition(id, pos, currentPrice, 'REJECT_HARD_CUT', ctx);
          continue;
        }

        // DEX_TRADE Phase 3: Quick Reject Classifier (microstructure-based)
        // Why: price-only cut 금지. time-box + buy ratio decay + tx density drop 조합 판정.
        if (config.quickRejectClassifierEnabled && elapsedSec <= config.quickRejectWindowSec) {
          const recentCandles = candleBuilder.getRecentCandles(
            pos.pairAddress,
            config.realtimePrimaryIntervalSec,
            3
          );
          const qr = evaluateQuickReject(
            {
              elapsedSec,
              mfePct,
              buyRatioAtEntry: pos.buyRatioAtEntry ?? 0.5,
              txCountAtEntry: pos.txCountAtEntry ?? 0,
              recentCandles,
            },
            {
              enabled: true,
              windowSec: config.quickRejectWindowSec,
              minMfePct: config.quickRejectMinMfePct,
              buyRatioDecayThreshold: config.quickRejectBuyRatioDecay,
              txDensityDropThreshold: config.quickRejectTxDensityDrop,
              degradeCountForExit: config.quickRejectDegradeCountForExit,
            }
          );
          if (qr.action === 'exit') {
            log.info(
              `[PUREWS_QUICK_REJECT] ${id} microstructure degraded — factors=${qr.degradeFactors.join(',')} ` +
              `mfe=${(mfePct * 100).toFixed(2)}% elapsed=${elapsedSec}s`
            );
            trackPureWsClose(pos, 'quick_reject_classifier_exit', `quick_reject:${qr.degradeFactors.join(',')}`, nowSec, mfePct, maePct, currentPrice);
            await closePureWsPosition(id, pos, currentPrice, 'REJECT_TIMEOUT', ctx);
            continue;
          }
          // 'reduce' action 은 Phase 3 초기 — 로그만 남김 (partial exit 는 Phase 4 후보)
          if (qr.action === 'reduce') {
            log.debug(
              `[PUREWS_QUICK_REJECT_WARN] ${id} reduce candidate — factors=${qr.degradeFactors.join(',')} ` +
              `elapsed=${elapsedSec}s`
            );
          }
        }

        // Flat timeout — Phase 3 P1-6: continuation mode 시 더 긴 window 사용.
        // 2026-04-26: swing-v2 shadow 는 probeWindowSecOverride 사용 (effProbeWindowSec 으로 통합).
        if (elapsedSec >= effProbeWindowSec) {
          const inFlatBand = Math.abs(currentPct) <= config.pureWsProbeFlatBandPct;
          if (inFlatBand) {
            log.info(
              `[PUREWS_LOSER_TIMEOUT] ${id} flat band currentPct=${(currentPct * 100).toFixed(2)}% ` +
              `MFE=${(mfePct * 100).toFixed(2)}%`
            );
            trackPureWsClose(pos, 'probe_reject_timeout', `flat_timeout@${elapsedSec}s`, nowSec, mfePct, maePct, currentPrice);
            await closePureWsPosition(id, pos, currentPrice, 'REJECT_TIMEOUT', ctx);
            continue;
          }
          // 창 넘겼지만 flat 아님 → 추가 관찰 (trailing 로직으로 처리)
        }
        // PROBE trail (flat band 벗어난 후 peak 에서 pullback → trail stop 발동)
        if (pos.peakPrice > pos.entryPrice) {
          const trailStop = pos.peakPrice * (1 - config.pureWsProbeTrailingPct);
          if (currentPrice <= trailStop) {
            log.info(
              `[PUREWS_PROBE_TRAIL] ${id} peak=${pos.peakPrice.toFixed(8)} ` +
              `trail=${trailStop.toFixed(8)} currentPct=${(currentPct * 100).toFixed(2)}%`
            );
            trackPureWsClose(pos, 'probe_flat_cut', `probe_trail_stop@${elapsedSec}s`, nowSec, mfePct, maePct, currentPrice);
            await closePureWsPosition(id, pos, currentPrice, 'WINNER_TRAILING', ctx);
            continue;
          }
        }
        // Promote to T1 — candle MFE 기준 (Phase 3 P1-6 continuation 시 낮춘 threshold).
        const t1Threshold = pos.continuationT1Threshold ?? config.pureWsT1MfeThreshold;
        if (mfePct >= t1Threshold) {
          pos.state = 'RUNNER_T1';
          pos.t1VisitAtSec = nowSec;
          pos.t1ViaQuote = false;
          // 2026-04-26 QA: shadow arm (swing-v2 paper) 의 promotion 은 funnel stats 에 집계 X.
          // funnelStats 는 primary (live) lane 측정값 — shadow 가 섞이면 winner ratio 왜곡.
          if (!pos.isShadowArm) funnelStats.winnersT1++;
          log.info(
            `[PUREWS_T1] ${id} promoted RUNNER_T1 MFE=${(mfePct * 100).toFixed(2)}% ` +
            `threshold=${(t1Threshold * 100).toFixed(0)}%${pos.continuationMode ? ' (continuation)' : ''}`
          );
          break;
        }
        // Phase 2 P1-2: quote-based T1 promotion 보강.
        // candle MFE 가 아직 threshold 미만이지만 Jupiter reverse-quote MFE 가 threshold 이상이면
        // 같은 효과로 RUNNER_T1 승격. CATCOIN +99.91% peak=0% 케이스를 잡기 위함.
        const livePriceTracker = getPureWsLivePriceTracker();
        if (
          config.pureWsT1PromoteByQuote &&
          ctx.tradingMode === 'live' &&
          livePriceTracker
        ) {
          const tick = livePriceTracker.getLastTick(pos.pairAddress);
          // 2026-04-26 fix: continuationT1Threshold 가 있으면 candle 경로와 동일한 threshold 사용.
          // 이전 버그: quote 경로가 항상 default config.pureWsT1MfeThreshold 만 봐서
          // continuation 모드의 낮춘 T1 (예: 30%) 가 적용 안 됨.
          if (tick && tick.mfeVsEntry >= t1Threshold) {
            pos.state = 'RUNNER_T1';
            pos.t1VisitAtSec = nowSec;
            pos.t1ViaQuote = true;
            if (!pos.isShadowArm) funnelStats.winnersT1++;  // QA: shadow exclude
            log.info(
              `[PUREWS_T1_VIA_QUOTE] ${id} promoted RUNNER_T1 candleMFE=${(mfePct * 100).toFixed(2)}% ` +
              `quoteMFE=${(tick.mfeVsEntry * 100).toFixed(2)}% threshold=${(t1Threshold * 100).toFixed(0)}%` +
              `${pos.continuationMode ? ' (continuation)' : ''} solOut=${tick.solOut.toFixed(6)}`
            );
          }
        }
        break;
      }

      case 'RUNNER_T1': {
        if (mfePct >= config.pureWsT2MfeThreshold) {
          pos.state = 'RUNNER_T2';
          pos.t2VisitAtSec = nowSec;
          // 2026-04-19: T2 breakeven lock 는 peakPrice/trailStop 과 같은 domain 이어야
          // 한다 (market reference 기반). Pnl break-even 은 closePureWsPosition 에서
          // entry (Jupiter fill) 기준으로 별도 계산.
          pos.t2BreakevenLockPrice = referencePrice * config.pureWsT2BreakevenLockMultiplier;
          if (!pos.isShadowArm) funnelStats.winnersT2++;  // QA: shadow exclude
          log.info(
            `[PUREWS_T2] ${id} promoted RUNNER_T2 MFE=${(mfePct * 100).toFixed(2)}% ` +
            `lock=${pos.t2BreakevenLockPrice.toFixed(8)}`
          );
          break;
        }
        // Phase 3: hold-phase sentinel — degraded 시 즉시 degraded exit
        if (await checkHoldPhaseDegraded(id, pos, currentPrice, candleBuilder, ctx)) continue;
        // 2026-04-26: swing-v2 shadow 는 effT1TrailPct (예: 25%) + 선택적 profit floor (entry × 1.10).
        // primary 는 effT1TrailPct = config.pureWsT1TrailingPct (15%) + floor undefined 로 기존 동작 유지.
        const rawTrail = pos.peakPrice * (1 - effT1TrailPct);
        const profitFloor = effT1ProfitFloor != null ? pos.entryPrice * effT1ProfitFloor : 0;
        const trailStop = Math.max(rawTrail, profitFloor);
        if (currentPrice <= trailStop) {
          log.info(
            `[PUREWS_T1_TRAIL] ${id} peak=${pos.peakPrice.toFixed(8)} ` +
            `trail=${trailStop.toFixed(8)} currentPct=${(currentPct * 100).toFixed(2)}%` +
            (effT1ProfitFloor != null ? ` floor=${profitFloor.toFixed(8)}` : '')
          );
          await closePureWsPosition(id, pos, currentPrice, 'WINNER_TRAILING', ctx);
          continue;
        }
        break;
      }

      case 'RUNNER_T2': {
        if (mfePct >= config.pureWsT3MfeThreshold) {
          pos.state = 'RUNNER_T3';
          pos.t3VisitAtSec = nowSec;
          if (!pos.isShadowArm) funnelStats.winnersT3++;  // QA: shadow exclude
          log.info(
            `[PUREWS_T3] ${id} promoted RUNNER_T3 MFE=${(mfePct * 100).toFixed(2)}%`
          );
          break;
        }
        if (await checkHoldPhaseDegraded(id, pos, currentPrice, candleBuilder, ctx)) continue;
        const trailStop = Math.max(
          pos.peakPrice * (1 - config.pureWsT2TrailingPct),
          pos.t2BreakevenLockPrice ?? referencePrice * config.pureWsT2BreakevenLockMultiplier
        );
        if (currentPrice <= trailStop) {
          log.info(
            `[PUREWS_T2_TRAIL] ${id} peak=${pos.peakPrice.toFixed(8)} ` +
            `trail=${trailStop.toFixed(8)} (lock=${(pos.t2BreakevenLockPrice ?? 0).toFixed(8)}) ` +
            `currentPct=${(currentPct * 100).toFixed(2)}%`
          );
          await closePureWsPosition(id, pos, currentPrice, 'WINNER_TRAILING', ctx);
          continue;
        }
        break;
      }

      case 'RUNNER_T3': {
        if (await checkHoldPhaseDegraded(id, pos, currentPrice, candleBuilder, ctx)) continue;
        // No time stop — runner mode. 단일 exit = trail 25%.
        const trailStop = Math.max(
          pos.peakPrice * (1 - config.pureWsT3TrailingPct),
          pos.t2BreakevenLockPrice ?? referencePrice * config.pureWsT2BreakevenLockMultiplier
        );
        if (currentPrice <= trailStop) {
          log.info(
            `[PUREWS_T3_TRAIL] ${id} peak=${pos.peakPrice.toFixed(8)} ` +
            `trail=${trailStop.toFixed(8)} currentPct=${(currentPct * 100).toFixed(2)}%`
          );
          await closePureWsPosition(id, pos, currentPrice, 'WINNER_TRAILING', ctx);
          continue;
        }
        break;
      }
    }
  }
}

/**
 * Phase 3 helper: hold-phase sentinel 평가 + degraded 시 DEGRADED_EXIT 로 close.
 * @returns true 면 close 수행됨 (caller 는 continue)
 */
async function checkHoldPhaseDegraded(
  id: string,
  pos: PureWsPosition,
  currentPrice: number,
  candleBuilder: MicroCandleBuilder,
  ctx: BotContext
): Promise<boolean> {
  if (!config.holdPhaseSentinelEnabled) return false;
  const recentCandles = candleBuilder.getRecentCandles(
    pos.pairAddress,
    config.realtimePrimaryIntervalSec,
    3
  );
  const result = evaluateHoldPhaseSentinel(
    {
      buyRatioAtEntry: pos.buyRatioAtEntry ?? 0.5,
      txCountAtEntry: pos.txCountAtEntry ?? 0,
      peakPrice: pos.peakPrice,
      currentPrice,
      recentCandles,
    },
    {
      enabled: true,
      buyRatioCollapseThreshold: config.holdPhaseBuyRatioCollapse,
      txDensityDropThreshold: config.holdPhaseTxDensityDrop,
      peakDriftThreshold: config.holdPhasePeakDrift,
      degradedFactorCount: config.holdPhaseDegradedFactorCount,
    }
  );
  if (result.status === 'degraded') {
    log.warn(
      `[PUREWS_HOLD_DEGRADED] ${id} state=${pos.state} factors=${result.warnFactors.join(',')} ` +
      `peakDrift=${(result.peakDriftPct * 100).toFixed(2)}% buyR=${result.recentBuyRatio.toFixed(2)} tx=${result.recentTxCount.toFixed(1)}`
    );
    // Observer: hold-phase sentinel 에 의한 cut — post-close trajectory 관측 (Phase 3 miss 정량 평가)
    const nowSecHold = Math.floor(Date.now() / 1000);
    const refPrice = pos.marketReferencePrice;
    const mfePctHold = (pos.peakPrice - refPrice) / refPrice;
    const maePctHold = (pos.troughPrice - refPrice) / refPrice;
    trackPureWsClose(
      pos,
      'hold_phase_sentinel_degraded_exit',
      `hold_degraded:${result.warnFactors.join(',')}`,
      nowSecHold,
      mfePctHold,
      maePctHold,
      currentPrice
    );
    await closePureWsPosition(id, pos, currentPrice, 'DEGRADED_EXIT', ctx);
    return true;
  }
  if (result.status === 'warn') {
    log.debug(
      `[PUREWS_HOLD_WARN] ${id} state=${pos.state} factors=${result.warnFactors.join(',')}`
    );
  }
  return false;
}
