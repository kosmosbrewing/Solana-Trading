// pure_ws_breakout 진입 pipeline. signal → guards → gate → survival → viability → entry drift →
// sell quote probe → live buy (or paper) → DB persist → notifier → activePositions 등록.
//
// 모든 reject path 는 missedAlpha 로 reject reason 을 비동기 기록하여 사후 분석 가능.
// 모든 exit path (정상/실패/early return) 는 finally 절에서 inflight mutex 해제.

import { config } from '../../utils/config';
import { Order, PartialFillDataReason, Signal } from '../../utils/types';
import type { MicroCandleBuilder } from '../../realtime';
import { evaluateCupseySignalGate, CupseySignalGateConfig } from '../../strategy/cupseySignalGate';
import { checkProbeViabilityFloor } from '../../gate/probeViabilityFloor';
import { evaluateEntryDriftGuard } from '../../gate/entryDriftGuard';
import { evaluateSellQuoteProbe } from '../../gate/sellQuoteProbe';
import { remainingDailyBudget } from '../../risk/dailyBleedBudget';
import { isWalletStopActive, getWalletStopGuardState } from '../../risk/walletStopGuard';
import { acquireCanarySlot, releaseCanarySlot } from '../../risk/canaryConcurrencyGuard';
import {
  recordDriftReject as pairQuarantineRecordDriftReject,
  recordFavorableDrift as pairQuarantineRecordFavorableDrift,
  isQuarantined as pairQuarantineIsQuarantined,
} from '../../risk/pairQuarantineTracker';
import { uiAmountToRaw } from '../../utils/units';
import { escapeHtml, shortenAddress } from '../../notifier/formatting';
import {
  recordEntry as recordTokenSessionEntry,
  evaluateContinuation as evaluateTokenSessionContinuation,
  hasOpenPosition as tokenSessionHasOpenPosition,
} from '../tokenSessionTracker';
import { persistOpenTradeWithIntegrity, isEntryHaltActive } from '../entryIntegrity';
import { resolveActualEntryMetrics } from '../signalProcessor';
import { resolveTokenSymbol, lookupCachedSymbol } from '../../ingester/tokenSymbolResolver';
import type { BotContext } from '../types';
import { LANE_STRATEGY, log } from './constants';
import { activePositions, funnelStats } from './positionState';
import { getPureWsExecutor, resolvePureWsWalletLabel } from './wallet';
import { getPureWsPairOutcomeCooldown, v1LastEntrySecByPair } from './cooldowns';
import { inflightEntryByPair } from './inflight';
import { getOrInitLivePriceTracker } from './livePriceTracker';
import { ensurePairQuarantineConfigured, appendPairQuarantineLedger } from './pairQuarantine';
import { ensureTokenSessionConfigured } from './tokenSession';
import { trackPureWsReject } from './missedAlpha';
import { checkPureWsSurvival } from './survivalCheck';
import { openPureWsPaperParamArms } from './paperParamArms';
import { openSwingV2Arm } from './swingV2Entry';
import type { PureWsPosition } from './types';
import { trackPureWsPaperMarkout } from './markout';
import {
  describePureWsSource,
  isPureWsNewPairSignal,
} from './sourceGate';

function isPureWsV2Signal(signal: Signal): boolean {
  return (signal.sourceLabel ?? '').startsWith('ws_burst_v2');
}

function rejectByPairOutcomeCooldown(signal: Signal, nowSec: number): boolean {
  const outcomeCooldown = getPureWsPairOutcomeCooldown(signal.pairAddress, nowSec);
  if (!outcomeCooldown) return false;
  const remaining = outcomeCooldown.untilSec - nowSec;
  log.info(
    `[PUREWS_PAIR_OUTCOME_COOLDOWN] ${signal.pairAddress.slice(0, 12)} ` +
    `active (${remaining}s remaining, reason=${outcomeCooldown.reason}, ` +
    `net=${(outcomeCooldown.netPct * 100).toFixed(2)}%, mfe=${(outcomeCooldown.mfePct * 100).toFixed(2)}%)`
  );
  trackPureWsReject({
    rejectCategory: 'pair_outcome_cooldown',
    rejectReason: outcomeCooldown.reason,
    tokenMint: signal.pairAddress,
    signalPrice: signal.price,
    probeSolAmount: config.pureWsLaneTicketSol,
    signalSource: signal.sourceLabel,
    extras: {
      remainingSec: remaining,
      netPct: outcomeCooldown.netPct,
      mfePct: outcomeCooldown.mfePct,
    },
  });
  return true;
}

export async function handlePureWsSignal(
  signal: Signal,
  candleBuilder: MicroCandleBuilder,
  ctx: BotContext
): Promise<void> {
  if (!config.pureWsLaneEnabled) return;

  funnelStats.signalsReceived++;
  if (config.pureWsNewPairSourceGateEnabled && !isPureWsNewPairSignal(signal)) {
    log.info(
      `[PUREWS_SOURCE_REJECT] ${signal.pairAddress.slice(0, 12)} non_new_pair_source ` +
      describePureWsSource(signal)
    );
    trackPureWsReject({
      rejectCategory: 'other',
      rejectReason: 'non_new_pair_source',
      tokenMint: signal.pairAddress,
      signalPrice: signal.price,
      probeSolAmount: config.pureWsLaneTicketSol,
      signalSource: signal.sourceLabel,
      extras: {
        sourceGate: 'new_pair_only',
        discoverySource: signal.discoverySource ?? null,
        sourceLabel: signal.sourceLabel ?? null,
      },
    });
    return;
  }
  const livePrimaryPaperMode =
    ctx.tradingMode === 'live' &&
    !config.pureWsLiveCanaryEnabled &&
    config.pureWsPaperShadowEnabled;

  // 2026-04-29: token symbol prefetch (Helius DAS + pump.fun, 24h cache).
  // F3 fix: cache hit 시 함수 진입 skip.
  if (!signal.tokenSymbol && !lookupCachedSymbol(signal.pairAddress)) {
    void resolveTokenSymbol(signal.pairAddress).catch(() => {});
  }

  // Hard guards
  if (isEntryHaltActive(LANE_STRATEGY) && !livePrimaryPaperMode) {
    log.warn('[PUREWS_ENTRY_HALT] signal ignored — integrity halt active');
    return;
  }
  if (isWalletStopActive()) {
    log.debug('[PUREWS_WALLET_STOP] signal ignored — wallet balance below threshold');
    return;
  }

  // Duplicate guard (same pair already held by **primary** arm).
  // 2026-04-26: arm-aware — primary (pure_ws_breakout) 가 이미 보유 중이면 entire signal 차단.
  // swing-v2 (paper shadow / live canary) 는 별도 arm 이므로 primary 와 같은 pair 동시 보유 가능.
  // 단 swing-v2 자체가 같은 pair 에 active 면 swingV2Entry.ts 의 자체 dedup guard 가 차단.
  for (const pos of activePositions.values()) {
    if (
      pos.pairAddress === signal.pairAddress &&
      pos.state !== 'CLOSED' &&
      (config.pureWsBlockParentWhileAnyArmOpen || pos.isShadowArm !== true)
    ) {
      log.debug(
        `[PUREWS_SKIP] already holding ${signal.pairAddress.slice(0, 12)} ` +
        `arm=${pos.armName ?? 'unknown'} blockAnyArm=${config.pureWsBlockParentWhileAnyArmOpen}`
      );
      return;
    }
  }

  // 2026-04-25 Phase 1 P0-1: in-flight mutex.
  // 동일 pair 의 두 번째 signal 이 첫 signal 의 async Jupiter quote 사이에 통과하지 못하도록
  // sync 단계에서 차단. 모든 exit path 는 finally 절에서 해제.
  if (inflightEntryByPair.has(signal.pairAddress)) {
    log.debug(
      `[PUREWS_INFLIGHT_DEDUP] ${signal.pairAddress.slice(0, 12)} entry in-flight — second signal dropped`
    );
    return;
  }
  inflightEntryByPair.add(signal.pairAddress);

  // 2026-04-25 Phase 3 P1-7: open DB row 가 같은 pair 에 있으면 신규 entry 차단.
  // tracker singleton 의 openTradeId 도 같이 본다 (in-memory + jsonl ledger 동기화).
  let continuationDecision: ReturnType<typeof evaluateTokenSessionContinuation> | null = null;
  if (config.tokenSessionTrackerEnabled) {
    ensureTokenSessionConfigured();
    // Phase 3 P1-7: tokenSession openTradeId + activePositions 둘 다 검증해야 false halt 방지.
    if (config.tokenSessionBlockOpenPositionEntries && tokenSessionHasOpenPosition(signal.pairAddress)) {
      const liveOpen = [...activePositions.values()].some(
        (p) => p.pairAddress === signal.pairAddress && p.state !== 'CLOSED'
      );
      if (liveOpen) {
        log.info(
          `[PUREWS_OPEN_POSITION_GUARD] ${signal.pairAddress.slice(0, 12)} ` +
          `existing open position in token session — entry blocked`
        );
        inflightEntryByPair.delete(signal.pairAddress);
        return;
      }
    }
    // Phase 3 P1-6: continuation evaluation — 직전 winner 가 lookback 내면 분기.
    continuationDecision = evaluateTokenSessionContinuation(signal.pairAddress);
    if (continuationDecision.isContinuation) {
      log.info(
        `[PUREWS_CONTINUATION] ${signal.pairAddress.slice(0, 12)} ${continuationDecision.reason} ` +
        `→ probe window ${config.tokenSessionContinuationProbeWindowSec}s, T1 +${(config.tokenSessionContinuationT1Pct * 100).toFixed(0)}%`
      );
    }
  }

  try {

  // 2026-04-21 P1: v1 (bootstrap) 경로 per-pair cooldown.
  // v2 sourced signal (ws_burst_v2) 은 scanner 가 cooldown 관리하므로 여기선 v1 만 적용.
  const nowSecForCooldown = Math.floor(Date.now() / 1000);
  if (rejectByPairOutcomeCooldown(signal, nowSecForCooldown)) {
    return;
  }
  if (!isPureWsV2Signal(signal)) {
    const lastEntrySec = v1LastEntrySecByPair.get(signal.pairAddress) ?? 0;
    const cooldown = config.pureWsV1PerPairCooldownSec;
    if (nowSecForCooldown - lastEntrySec < cooldown) {
      const remaining = cooldown - (nowSecForCooldown - lastEntrySec);
      log.debug(
        `[PUREWS_V1_COOLDOWN] ${signal.pairAddress.slice(0, 12)} active ` +
        `(${remaining}s remaining, cooldown=${cooldown}s)`
      );
      return;
    }
  }

  // Concurrency cap — lane-level
  const activeCount = [...activePositions.values()].filter((p) => p.state !== 'CLOSED' && p.isShadowArm !== true).length;
  if (activeCount >= config.pureWsMaxConcurrent) {
    log.debug(`[PUREWS_SKIP] lane max concurrent (${activeCount})`);
    return;
  }

  // V2 detector-sourced signal 은 v1 gate 재평가 skip (factor set 다름 → double-reject 방지).
  const skipV1Gate = isPureWsV2Signal(signal);

  // Loose signal gate (factor set reuse, threshold 완화)
  if (config.pureWsGateEnabled && !skipV1Gate) {
    const recentCandles = candleBuilder.getRecentCandles(
      signal.pairAddress,
      config.realtimePrimaryIntervalSec,
      config.pureWsGateLookbackBars
    );
    const gateCfg: CupseySignalGateConfig = {
      enabled: true,
      minVolumeAccelRatio: config.pureWsGateMinVolumeAccelRatio,
      minPriceChangePct: config.pureWsGateMinPriceChangePct,
      minAvgBuyRatio: config.pureWsGateMinAvgBuyRatio,
      minTradeCountRatio: config.pureWsGateMinTradeCountRatio,
      lookbackBars: config.pureWsGateLookbackBars,
      recentBars: config.pureWsGateRecentBars,
    };
    const gateResult = evaluateCupseySignalGate(recentCandles, gateCfg);
    if (!gateResult.pass) {
      log.debug(
        `[PUREWS_GATE_REJECT] ${signal.pairAddress.slice(0, 12)} ` +
        `reason=${gateResult.rejectReason} score=${gateResult.score}`
      );
      return;
    }
    funnelStats.gatePass++;
  }

  const ticketSol = config.pureWsLaneTicketSol;
  const originalSignalPrice = signal.price;
  let entrySignalPrice = originalSignalPrice;
  let quantity = entrySignalPrice > 0 ? ticketSol / entrySignalPrice : 0;
  if (quantity <= 0) return;
  let entryTokenDecimals: number | undefined;
  const paperObserveReasons: string[] = [];

  // 2026-04-21 Survival Layer (P0 mission-refinement): rug / honeypot / Token-2022 dangerous ext /
  // top-holder / exit liquidity 검사. paper 모드도 동일하게 체크 (관측 data 정합성 유지).
  if (config.pureWsSurvivalCheckEnabled) {
    const survival = await checkPureWsSurvival(signal.pairAddress, ctx);
    if (!survival.approved) {
      if (
        livePrimaryPaperMode &&
        survival.reason === 'security_data_unavailable' &&
        survival.flags.includes('NO_SECURITY_DATA')
      ) {
        paperObserveReasons.push('security_data_unavailable_observe');
        log.info(
          `[PUREWS_SURVIVAL_PAPER_OBSERVE] ${signal.pairAddress.slice(0, 12)} ` +
          `NO_SECURITY_DATA — paper-only observation continues, live remains blocked`
        );
      } else {
        log.info(
          `[PUREWS_SURVIVAL_REJECT] ${signal.pairAddress.slice(0, 12)} ` +
          `reason=${survival.reason ?? 'unknown'} flags=[${survival.flags.join(',')}]`
        );
        trackPureWsReject({
          rejectCategory: 'survival',
          rejectReason: survival.reason ?? 'unknown',
          tokenMint: signal.pairAddress,
          signalPrice: signal.price,
          probeSolAmount: ticketSol,
          signalSource: signal.sourceLabel,
          extras: { flags: survival.flags },
        });
        return;
      }
    }
    if (survival.flags.length > 0) {
      log.debug(
        `[PUREWS_SURVIVAL_PASS] ${signal.pairAddress.slice(0, 12)} flags=[${survival.flags.join(',')}]`
      );
    }
  }

  // DEX_TRADE Phase 2: Probe Viability Floor + Daily Bleed Budget
  if (config.probeViabilityFloorEnabled) {
    const walletState = getWalletStopGuardState();
    const walletBaselineSol = walletState.lastBalanceSol > 0 && Number.isFinite(walletState.lastBalanceSol)
      ? walletState.lastBalanceSol
      : config.walletStopMinSol;  // 2026-04-26 fix: floor 자체를 baseline 으로 (보수적, daily budget 작아짐)
    const budgetCfg = {
      alpha: config.dailyBleedAlpha,
      minCapSol: config.dailyBleedMinCapSol,
      maxCapSol: config.dailyBleedMaxCapSol,
    };
    const remainingBudget = config.dailyBleedBudgetEnabled
      ? remainingDailyBudget(walletBaselineSol, budgetCfg)
      : Number.POSITIVE_INFINITY;
    const viability = checkProbeViabilityFloor(
      {
        venue: undefined,  // Phase 2 초기 — venue resolver 미구현, unknown fallback 사용
        ticketSol,
      },
      {
        minTicketSol: config.probeViabilityMinTicketSol,
        maxBleedPct: config.probeViabilityMaxBleedPct,
        maxSellImpactPct: config.probeViabilityMaxSellImpactPct,
        remainingDailyBudgetSol: remainingBudget,
      }
    );
    if (!viability.allow) {
      log.info(
        `[PUREWS_VIABILITY_REJECT] ${signal.pairAddress.slice(0, 12)} reason=${viability.reason} ` +
        `bleed=${viability.bleed.totalSol.toFixed(6)}SOL (${(viability.bleed.totalPct * 100).toFixed(2)}%) ` +
        `budget=${remainingBudget.toFixed(6)}SOL`
      );
      trackPureWsReject({
        rejectCategory: 'viability',
        rejectReason: viability.reason ?? 'viability',
        tokenMint: signal.pairAddress,
        signalPrice: signal.price,
        probeSolAmount: ticketSol,
        signalSource: signal.sourceLabel,
        extras: {
          bleedSol: viability.bleed.totalSol,
          bleedPct: viability.bleed.totalPct,
          remainingBudgetSol: remainingBudget,
        },
      });
      return;
    }
  }

  // 2026-04-19: Entry drift guard — Jupiter probe quote 로 expected fill price 를
  // 미리 계산, signal price 와 drift 가 maxEntryDriftPct 초과면 entry 차단.
  // Why: 2026-04-18 관측 4 trades 전부 +20~51% fill drift → 체결 즉시 MAE −20% → hard cut → canary halt.
  // 2026-04-19 (QA Q1): Jupiter API response 에 outputDecimals 없음 → executor.getMintDecimals
  // 로 사전 해결해서 hint 전달해야 guard 가 실질 동작. cache 내부 적용 — 반복 호출 시 0 RPC.
  if (config.pureWsEntryDriftGuardEnabled && ctx.tradingMode === 'live') {
    const probeSolAmount = ticketSol;
    try {
      const buyExecutor = getPureWsExecutor(ctx);
      entryTokenDecimals = await buyExecutor.getMintDecimals(signal.pairAddress);
    } catch (err) {
      // 2026-04-26 quality fix: debug → warn. decimals 부재 시 sell quote probe 의
      // probeTokenAmountRaw 계산이 부정확 (decimals 6 가정 fallback). 운영자가 빈도 추적 가능.
      log.warn(`[PUREWS_DECIMALS_RESOLVE_FAIL] ${signal.pairAddress.slice(0, 12)} decimals resolve failed: ${err}`);
    }
    // Phase 4 P2-1: pair quarantine pre-check — 이미 quarantine 된 pair 면 Jupiter quote skip.
    ensurePairQuarantineConfigured();
    if (config.pairQuarantineEnabled && pairQuarantineIsQuarantined(signal.pairAddress)) {
      log.info(
        `[PUREWS_PAIR_QUARANTINED] ${signal.pairAddress.slice(0, 12)} ` +
        `entry skipped — pair quarantined by drift_reject burst`
      );
      return;
    }
    const driftResult = await evaluateEntryDriftGuard(
      {
        tokenMint: signal.pairAddress,
        signalPrice: signal.price,
        probeSolAmount,
        tokenDecimals: entryTokenDecimals,
      },
      {
        jupiterApiUrl: config.jupiterApiUrl,
        jupiterApiKey: config.jupiterApiKey,
        maxDriftPct: config.pureWsMaxEntryDriftPct,
        maxFavorableDriftPct: config.pureWsMaxFavorableDriftPct,
      }
    );
    if (driftResult.routeFound && !driftResult.quoteFailed) {
      log.info(
        `[PUREWS_ENTRY_DRIFT] ${signal.pairAddress.slice(0, 12)} ` +
        `signal=${driftResult.signalPrice.toFixed(8)} ` +
        `expectedFill=${(driftResult.expectedFillPrice ?? 0).toFixed(8)} ` +
        `drift=${(driftResult.observedDriftPct * 100).toFixed(2)}%`
      );
    }
    if (!driftResult.approved) {
      const repairPrice = driftResult.expectedFillPrice;
      if (
        livePrimaryPaperMode &&
        driftResult.routeFound &&
        !driftResult.quoteFailed &&
        repairPrice != null &&
        Number.isFinite(repairPrice) &&
        repairPrice > 0
      ) {
        entrySignalPrice = repairPrice;
        quantity = ticketSol / entrySignalPrice;
        if (!Number.isFinite(quantity) || quantity <= 0) return;
        paperObserveReasons.push('entry_drift_quote_repriced');
        log.info(
          `[PUREWS_ENTRY_DRIFT_PAPER_REPRICE] ${signal.pairAddress.slice(0, 12)} ` +
          `${driftResult.reason ?? 'drift'} — paper entry repriced ` +
          `${originalSignalPrice.toFixed(8)} → ${entrySignalPrice.toFixed(8)}`
        );
      } else {
        log.info(
          `[PUREWS_ENTRY_DRIFT_REJECT] ${signal.pairAddress.slice(0, 12)} ${driftResult.reason ?? 'drift'}`
        );
        // Phase 4 P2-1: drift reject burst counter — threshold 도달 시 60분 quarantine.
        if (config.pairQuarantineEnabled) {
          const isFavorable = (driftResult.reason ?? '').includes('favorable');
          const result = isFavorable
            ? pairQuarantineRecordFavorableDrift({ pair: signal.pairAddress })
            : pairQuarantineRecordDriftReject({ pair: signal.pairAddress });
          if (result.triggered) {
            log.warn(
              `[PUREWS_PAIR_QUARANTINE_FIRED] ${signal.pairAddress.slice(0, 12)} ` +
              `→ quarantined for ${Math.round((result.quarantinedUntilMs - Date.now()) / 60_000)}min ` +
              `(reason=${isFavorable ? 'favorable_drift' : 'drift_reject'} burst)`
            );
            // Phase 4 P2-4: telemetry append (best-effort, fire-and-forget).
            appendPairQuarantineLedger({
              firedAt: new Date().toISOString(),
              pair: signal.pairAddress,
              reason: isFavorable ? 'favorable_drift_burst' : 'drift_reject_burst',
              quarantinedUntilMs: result.quarantinedUntilMs,
              durationMin: config.pairQuarantineDurationMin,
              triggerReason: driftResult.reason ?? null,
              observedDriftPct: driftResult.observedDriftPct ?? null,
            }).catch(() => {});
          }
        }
        trackPureWsReject({
          rejectCategory: 'entry_drift',
          rejectReason: driftResult.reason ?? 'drift',
          tokenMint: signal.pairAddress,
          signalPrice: signal.price,
          probeSolAmount,
          tokenDecimals: entryTokenDecimals,
          signalSource: signal.sourceLabel,
          extras: {
            expectedFillPrice: driftResult.expectedFillPrice,
            observedDriftPct: driftResult.observedDriftPct,
            routeFound: driftResult.routeFound,
          },
        });
        return;
      }
    }
  }

  // 2026-04-21 Survival Layer Tier B-1: Active Sell Quote Probe (exitability).
  // Jupiter 에 tokenMint→SOL quote 요청 → "팔릴 수 있는가" 직접 검증.
  // securityGate 는 static properties 만, entryDriftGuard 는 buy fill 정합성만 본다.
  // "honeypot by liquidity" (route 없음 / sell impact 폭증) 는 오직 sell quote 로만 드러남.
  if (config.pureWsSellQuoteProbeEnabled && ctx.tradingMode === 'live') {
    try {
      const buyExecutor = getPureWsExecutor(ctx);
      const tokenDecimals = await buyExecutor.getMintDecimals(signal.pairAddress);
      if (tokenDecimals != null && tokenDecimals >= 0 && tokenDecimals <= 18) {
        entryTokenDecimals = tokenDecimals;
        // probeTokenAmountRaw = 예상 받을 토큰 수 (raw).
        // 2026-04-21 (QA L2): JS number 정밀도 edge 방어.
        // `quantity × 10^decimals` 이 Number.MAX_SAFE_INTEGER(2^53) 초과하면 정밀도 손실.
        // Fix: integer 정수부와 소수부를 분리해 정수부는 BigInt 로 계산, 소수부는 정수에 병합.
        const probeTokenAmountRaw = uiAmountToRaw(quantity, tokenDecimals);
        if (probeTokenAmountRaw > 0n) {
          const sellProbe = await evaluateSellQuoteProbe(
            {
              tokenMint: signal.pairAddress,
              probeTokenAmountRaw,
              expectedSolReceive: ticketSol,
              tokenDecimals,
            },
            {
              jupiterApiUrl: config.jupiterApiUrl,
              jupiterApiKey: config.jupiterApiKey,
              maxImpactPct: config.pureWsSellQuoteMaxImpactPct,
              minRoundTripPct: config.pureWsSellQuoteMinRoundTripPct,
            }
          );
          if (sellProbe.routeFound && !sellProbe.quoteFailed) {
            log.info(
              `[PUREWS_SELL_PROBE] ${signal.pairAddress.slice(0, 12)} ` +
              `outSol=${sellProbe.observedOutSol.toFixed(6)} ` +
              `impact=${(sellProbe.observedImpactPct * 100).toFixed(2)}% ` +
              `roundTrip=${isFinite(sellProbe.roundTripPct) ? (sellProbe.roundTripPct * 100).toFixed(1) + '%' : 'n/a'}`
            );
          }
          if (!sellProbe.approved) {
            log.info(
              `[PUREWS_SELL_PROBE_REJECT] ${signal.pairAddress.slice(0, 12)} ${sellProbe.reason ?? 'sell_probe'}`
            );
            trackPureWsReject({
              rejectCategory: 'sell_quote_probe',
              rejectReason: sellProbe.reason ?? 'sell_probe',
              tokenMint: signal.pairAddress,
              signalPrice: signal.price,
              probeSolAmount: ticketSol,
              tokenDecimals,
              signalSource: signal.sourceLabel,
              extras: {
                observedOutSol: sellProbe.observedOutSol,
                observedImpactPct: sellProbe.observedImpactPct,
                roundTripPct: sellProbe.roundTripPct,
                routeFound: sellProbe.routeFound,
              },
            });
            return;
          }
        }
      }
    } catch (err) {
      // 2026-04-26 quality fix: 이전 debug only → warn 으로 상향.
      // probe 실패 (네트워크 / Jupiter 429 / 토큰 위험) 는 sell-side liquidity 미검증 상태로 진입 의미.
      // 운영자가 빈도 추세를 감지할 수 있게 warn level. 단 진입 자체 차단은 아님 (observability only).
      log.warn(`[PUREWS_SELL_PROBE_FAIL] ${signal.pairAddress.slice(0, 12)} probe error (skipped): ${err}`);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const positionId = `purews-${signal.pairAddress.slice(0, 8)}-${nowSec}`;

  // ─── Immediate PROBE entry (NO STALK) ───
  let actualEntryPrice = entrySignalPrice;
  let actualQuantity = quantity;
  let actualNotionalSol = entrySignalPrice * quantity;  // 2026-04-29: RPC 측정 wallet delta 전파용
  let entryTxSignature = 'PAPER_TRADE';
  let entrySlippageBps = 0;
  // Phase 1 P0-3 (2026-04-25): true 면 actualIn/actualOut 한쪽만 가용 → planned 강제 복원됨.
  let partialFillDataMissing = false;
  let partialFillDataReason: PartialFillDataReason | undefined;
  let primaryPaperOnly = false;
  let canarySlotAcquired = false;

  if (ctx.tradingMode === 'live') {
    // Block 3 paper-first enforcement (2026-04-18 QA fix):
    // PUREWS_LANE_ENABLED=true + TRADING_MODE=live 만으로는 live buy 금지.
    // 운영자가 paper 관측 후 PUREWS_LIVE_CANARY_ENABLED=true 로 명시 opt-in 해야 함.
    //
    // 2026-05-02: live 운영 중 pure_ws paper 검증을 기본값으로 유지.
    // PUREWS_PAPER_SHADOW_ENABLED=true 이면 swing-v2 live flag 가 켜져 있어도 하위 arm 도 paper shadow.
    // legacy swing-only live canary 는 PUREWS_PAPER_SHADOW_ENABLED=false 를 명시한 경우만 허용.
    if (!config.pureWsLiveCanaryEnabled) {
      const swingOnlyLive =
        config.pureWsSwingV2Enabled && config.pureWsSwingV2LiveCanaryEnabled;
      const swingLiveMayEnter = swingOnlyLive && !config.pureWsPaperShadowEnabled;
      if (!config.pureWsPaperShadowEnabled && !swingOnlyLive) {
        log.info(
          `[PUREWS_PAPER_FIRST] ${positionId} live buy suppressed — PUREWS_LIVE_CANARY_ENABLED=false. ` +
          `signal observed, no tx submitted. signal_price=${entrySignalPrice.toFixed(8)}`
        );
        return;
      }
      primaryPaperOnly = true;
      log.info(
        `[PUREWS_PAPER_OPEN] ${positionId} live buy suppressed — ` +
        `primary paper-only position opened (PUREWS_LIVE_CANARY_ENABLED=false). ` +
        `signal_price=${entrySignalPrice.toFixed(8)}` +
        (swingLiveMayEnter ? ' swing-v2 live canary may still enter.' : '')
      );
      if (config.pureWsPaperNotifyEnabled && config.pureWsPaperNotifyIndividualEnabled) {
        const symbol = signal.tokenSymbol ?? shortenAddress(signal.pairAddress);
        void ctx.notifier.sendMessage([
          `🟣 <b>pure_ws paper 진입</b> <b>${escapeHtml(symbol)}</b> <code>${escapeHtml(positionId.slice(0, 12))}</code>`,
          `${actualNotionalSol.toFixed(4)} SOL @ ${entrySignalPrice.toFixed(8)} · live buy suppressed`,
          `<code>${escapeHtml(signal.pairAddress)}</code>`,
        ].join('\n')).catch((err) => {
          log.warn(`[PUREWS_PAPER_NOTIFY_OPEN_FAIL] ${positionId} ${err}`);
        });
      }
    }
  }

  // Block 4 QA fix: wallet-level 전역 canary concurrency guard (opt-in).
  // lane 별 cap 보다 엄격할 수 있음 — gate + paper-first pass 이후 시점에서 acquire.
  // 어느 실패 경로에서도 누수 방지를 위해 release 를 반드시 대응하여 호출한다.
  if (!primaryPaperOnly) {
    if (!acquireCanarySlot(LANE_STRATEGY)) {
      log.debug(`[PUREWS_SKIP] global canary slot full`);
      return;
    }
    canarySlotAcquired = true;
  }

  // 2026-04-26: primary live executeBuy 는 PUREWS_LIVE_CANARY_ENABLED=true 일 때만.
  // swing-v2 only live mode 는 primary paper-first 로 우회 (executeBuy 호출 안 함).
  if (ctx.tradingMode === 'live' && config.pureWsLiveCanaryEnabled && !primaryPaperOnly) {
    try {
      const buyExecutor = getPureWsExecutor(ctx);
      const order: Order = {
        pairAddress: signal.pairAddress,
        strategy: LANE_STRATEGY,
        side: 'BUY',
        price: entrySignalPrice,
        quantity,
        stopLoss: entrySignalPrice * (1 - config.pureWsProbeHardCutPct),
        takeProfit1: entrySignalPrice * (1 + config.pureWsT1MfeThreshold),
        takeProfit2: entrySignalPrice * (1 + config.pureWsT2MfeThreshold),
        timeStopMinutes: Math.ceil(config.pureWsProbeWindowSec / 60),
      };
      const buyResult = await buyExecutor.executeBuy(order);
      // 2026-04-18 drift fix: all-or-nothing guard (same root cause as cupsey/migration).
      const metrics = resolveActualEntryMetrics(order, buyResult);
      actualEntryPrice = metrics.entryPrice;
      actualQuantity = metrics.quantity;
      actualNotionalSol = metrics.actualEntryNotionalSol;
      entryTxSignature = buyResult.txSignature;
      entrySlippageBps = buyResult.slippageBps;
      // Phase 1 P0-3: partial fill data missing flag for downstream ledger.
      partialFillDataMissing = metrics.partialFillDataMissing;
      partialFillDataReason = metrics.partialFillDataReason;
      log.info(
        `[PUREWS_LIVE_BUY] ${positionId} immediate PROBE sig=${entryTxSignature.slice(0, 12)} ` +
        `slip=${entrySlippageBps}bps`
      );
      funnelStats.txSuccess++;
    } catch (buyErr) {
      log.warn(`[PUREWS_LIVE_BUY] ${positionId} buy failed: ${buyErr}`);
      if (canarySlotAcquired) releaseCanarySlot(LANE_STRATEGY); // QA fix — 누수 방지
      return;
    }
  }

  funnelStats.entry++;

  // DB persist with integrity halt protection
  const persistResult = primaryPaperOnly
    ? { dbTradeId: null }
    : await persistOpenTradeWithIntegrity({
      ctx,
      lane: LANE_STRATEGY,
      tradeData: {
        pairAddress: signal.pairAddress,
        strategy: LANE_STRATEGY,
        side: 'BUY',
        tokenSymbol: signal.tokenSymbol,
        sourceLabel: signal.sourceLabel,
        discoverySource: signal.discoverySource,
        entryPrice: actualEntryPrice,
        plannedEntryPrice: entrySignalPrice,
        quantity: actualQuantity,
        stopLoss: actualEntryPrice * (1 - config.pureWsProbeHardCutPct),
        takeProfit1: actualEntryPrice * (1 + config.pureWsT1MfeThreshold),
        takeProfit2: actualEntryPrice * (1 + config.pureWsT2MfeThreshold),
        trailingStop: undefined,
        highWaterMark: actualEntryPrice,
        timeStopAt: new Date((nowSec + config.pureWsProbeWindowSec) * 1000),
        status: 'OPEN',
        txSignature: entryTxSignature,
        createdAt: new Date(nowSec * 1000),
        entrySlippageBps,
      },
      ledgerEntry: {
        signalId: positionId,
        positionId,
        txSignature: entryTxSignature,
        strategy: LANE_STRATEGY,
        wallet: resolvePureWsWalletLabel(ctx), // Block 1 QA fix: wallet-aware comparator
        pairAddress: signal.pairAddress,
        tokenSymbol: signal.tokenSymbol,
        plannedEntryPrice: entrySignalPrice,
        actualEntryPrice,
        actualQuantity,
        slippageBps: entrySlippageBps,
        signalTimeSec: nowSec,
        signalPrice: entrySignalPrice,
        // Phase 1 P0-3: 데이터 품질 flag 를 ledger 까지 전파.
        partialFillDataMissing,
        partialFillDataReason,
      },
      notifierKey: 'purews_open_persist',
      buildNotifierMessage: (err) =>
        `${positionId} buy persisted FAILED after tx=${entryTxSignature}: ${err} — NEW POSITIONS HALTED.`,
    });

  // Phase 3: entry 시점 microstructure snapshot (quickReject/holdPhase 기준점)
  const entryCandles = candleBuilder.getRecentCandles(
    signal.pairAddress,
    config.realtimePrimaryIntervalSec,
    1
  );
  const entryCandle = entryCandles[entryCandles.length - 1];
  const entryBuyRatio = entryCandle
    ? (entryCandle.buyVolume + entryCandle.sellVolume > 0
      ? entryCandle.buyVolume / (entryCandle.buyVolume + entryCandle.sellVolume)
      : 0.5)
    : 0.5;
  const entryTxCount = entryCandle?.tradeCount ?? 0;

  // 2026-04-19: market reference = signal price (MAE/MFE hard-cut 기준).
  // peakPrice/troughPrice 도 signal price 로 초기화 — 첫 tick 에서 신호 가격 대비
  // 이동만 반영 (bad fill 의 entry-to-fill gap 은 배제).
  const marketReferencePrice = config.pureWsUseMarketReferencePrice
    ? entrySignalPrice
    : actualEntryPrice;

  const position: PureWsPosition = {
    tradeId: positionId,
    dbTradeId: persistResult.dbTradeId ?? undefined,
    pairAddress: signal.pairAddress,
    entryPrice: actualEntryPrice,
    marketReferencePrice,
    entryTimeSec: nowSec,
    quantity: actualQuantity,
    tokenDecimals: entryTokenDecimals ?? null,
    state: 'PROBE',
    peakPrice: marketReferencePrice,
    troughPrice: marketReferencePrice,
    tokenSymbol: signal.tokenSymbol,
    sourceLabel: signal.sourceLabel,
    discoverySource: signal.discoverySource,
    plannedEntryPrice: entrySignalPrice,
    entryTxSignature,
    entrySlippageBps,
    buyRatioAtEntry: entryBuyRatio,
    txCountAtEntry: entryTxCount,
    // Phase 3 P1-6: continuation override — winner 직후 재진입은 더 길게 보고, T1 낮춰서 잡는다.
    continuationMode: continuationDecision?.isContinuation === true,
    continuationT1Threshold: continuationDecision?.isContinuation
      ? config.tokenSessionContinuationT1Pct
      : undefined,
    continuationProbeWindowSec: continuationDecision?.isContinuation
      ? config.tokenSessionContinuationProbeWindowSec
      : undefined,
    executionMode: primaryPaperOnly || ctx.tradingMode === 'paper' ? 'paper' : 'live',
    paperOnlyReason: primaryPaperOnly
      ? (paperObserveReasons.length > 0
        ? paperObserveReasons.join('+')
        : (ctx.tradingMode === 'live' ? 'live_canary_disabled' : 'trading_mode_paper'))
      : undefined,
    canarySlotAcquired,
  };

  if (persistResult.dbTradeId && !primaryPaperOnly) {
    funnelStats.dbPersisted++;
    // 2026-04-28 P0-B fix: notifier fire-and-forget. Telegram 429 entry path blocking 차단.
    void ctx.notifier.sendTradeOpen({
      tradeId: persistResult.dbTradeId,
      pairAddress: position.pairAddress,
      strategy: LANE_STRATEGY,
      side: 'BUY',
      // 2026-04-29: signal upstream → resolver cache → undefined fallback.
      tokenSymbol: position.tokenSymbol ?? lookupCachedSymbol(position.pairAddress) ?? undefined,
      price: actualEntryPrice,
      plannedEntryPrice: entrySignalPrice,
      quantity: actualQuantity,
      sourceLabel: position.sourceLabel,
      discoverySource: position.discoverySource,
      stopLoss: actualEntryPrice * (1 - config.pureWsProbeHardCutPct),
      takeProfit1: actualEntryPrice * (1 + config.pureWsT1MfeThreshold),
      takeProfit2: actualEntryPrice * (1 + config.pureWsT2MfeThreshold),
      timeStopMinutes: Math.ceil(config.pureWsProbeWindowSec / 60),
      // 2026-04-29: RPC 측정 wallet delta + partial-fill flag.
      actualNotionalSol,
      partialFillDataMissing,
      partialFillDataReason,
    }, entryTxSignature).then(() => {
      funnelStats.notifierOpenSent++;
    }).catch((err) => {
      log.warn(`[PUREWS_NOTIFY_OPEN_FAIL] ${positionId} ${err}`);
    });
  }

  // 2026-04-26: pure_ws v1 primary 에 명시적 라벨 (paper-arm-report 의 sub-arm 분리용).
  position.parameterVersion = 'pure-ws-v1.0.0';
  position.armName = 'pure_ws_breakout';
  position.isShadowArm = false;

  activePositions.set(positionId, position);
  if (position.executionMode === 'paper') {
    trackPureWsPaperMarkout(
      position,
      'buy',
      position.entryPrice,
      Math.max(0.000001, position.entryPrice * position.quantity),
      position.entryTimeSec * 1000,
      {
        buyRatioAtEntry: position.buyRatioAtEntry ?? null,
        txCountAtEntry: position.txCountAtEntry ?? null,
      }
    );
  }

  // 2026-04-26: pure_ws swing-v2 paper shadow 생성 (KOL swing-v2 와 동일 패턴).
  // 같은 V2 PASS / bootstrap signal 로 long-hold 손익비 정책의 측정용 shadow.
  // 강제 paper-only: DB persist X, live exec X, canary slot 미소비, wallet 영향 0.
  //
  // 자격 검증: V2 PASS 의 폭발적 빈도 (KMnDBXcP wash-trade 시간당 ~750) 는 entry path 상단의
  // duplicate guard (`for ... if (pos.pairAddress === signal.pairAddress && state !== CLOSED)
  // return`) 가 자동 차단. primary 가 막히면 shadow 도 자연 차단됨. 즉 shadow 가 만들어지는
  // 시점은 동일 pair 에 active position 0 인 정상 진입 직후 — KOL swing-v2 의 multi-KOL 자격과
  // 동일 효과 (모든 quality 신호만 측정).
  if (config.pureWsSwingV2Enabled) {
    await openSwingV2Arm({
      signal,
      ctx,
      primaryPositionId: positionId,
      primaryEntryPrice: actualEntryPrice,
      primaryQuantity: actualQuantity,
      marketReferencePrice,
      buyRatioAtEntry: entryBuyRatio,
      txCountAtEntry: entryTxCount,
      nowSec,
      tokenDecimals: entryTokenDecimals ?? null,
    });
  }
  openPureWsPaperParamArms({
    signal,
    primaryPositionId: positionId,
    primaryEntryPrice: actualEntryPrice,
    primaryQuantity: actualQuantity,
    marketReferencePrice,
    buyRatioAtEntry: entryBuyRatio,
    txCountAtEntry: entryTxCount,
    nowSec,
    tokenDecimals: entryTokenDecimals ?? null,
  });

  // Phase 3 P1-5: token session entry 기록.
  if (config.tokenSessionTrackerEnabled) {
    recordTokenSessionEntry({ tokenMint: signal.pairAddress, tradeId: positionId });
  }
  // 2026-04-21 P1: v1 (bootstrap) 경로 entry 성공 시 pair cooldown 기록.
  // v2 sourced signal 은 scanner 가 cooldown 관리하므로 제외.
  if (!isPureWsV2Signal(signal)) {
    v1LastEntrySecByPair.set(signal.pairAddress, Math.floor(Date.now() / 1000));
  }
  // Phase 2 P1-1/P1-2: live 모드에서 reverse-quote tracker subscribe — quote-based MFE 측정.
  // tracker 는 lazy init (config 가 켜져 있을 때만). Decimals 는 RPC fetch (실패 시 fallback 6).
  if (config.pureWsLivePriceTrackerEnabled && ctx.tradingMode === 'live' && !primaryPaperOnly) {
    try {
      let decimals: number | null = null;
      if (ctx.onchainSecurityClient && typeof ctx.onchainSecurityClient.getMintDecimals === 'function') {
        decimals = await ctx.onchainSecurityClient.getMintDecimals(signal.pairAddress);
      }
      const tracker = getOrInitLivePriceTracker();
      tracker.subscribe({
        tokenMint: signal.pairAddress,
        quantityUi: actualQuantity,
        decimals: decimals ?? 6,
        entryNotionalSol: actualEntryPrice * actualQuantity,
      });
    } catch (err) {
      log.debug(`[PUREWS_LIVE_TRACKER] subscribe failed ${signal.pairAddress.slice(0, 12)}: ${err}`);
    }
  }
  log.info(
    `[PUREWS_PROBE_OPEN] ${positionId} ${signal.pairAddress.slice(0, 12)} ` +
    `entry=${actualEntryPrice.toFixed(8)} qty=${actualQuantity.toFixed(4)}`
  );
  } finally {
    // 2026-04-25 Phase 1 P0-1: in-flight mutex 해제 — 모든 exit path 에서 보장.
    inflightEntryByPair.delete(signal.pairAddress);
  }
}
