import { GateEvaluationResult, evaluateExecutionViabilityForOrder } from '../gate';
import type { SwapResult } from '../executor';
import { buildFibPullbackOrder, buildMomentumTriggerOrder, buildVolumeSpikeOrder } from '../strategy';
import { checkStaleSignal } from '../state';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { Candle, Order, Signal, isVolumeSpikeFamilyStrategy } from '../utils/types';
import {
  buildSignalAuditBase,
  EntryExecutionSummary,
  recordOpenedTrade,
  runnerStateMap,
  syncTradingHalts,
} from './tradeExecution';
import { buildPositionSignalData } from './signalTrace';
import { BotContext } from './types';

const log = createModuleLogger('SignalProcessor');

export interface SignalProcessingResult {
  status:
    | 'executed_paper'
    | 'executed_live'
    | 'execution_failed'
    | 'gate_rejected'
    | 'trading_halted'
    | 'execution_lock'
    | 'stale'
    | 'risk_rejected'
    | 'regime_blocked'
    | 'wallet_limit'
    | 'execution_viability_rejected';
  filterReason?: string;
  tradeId?: string;
  txSignature?: string;
}

export async function processSignal(
  signal: Signal,
  candles: Candle[],
  ctx: BotContext,
  gateResult: GateEvaluationResult
): Promise<SignalProcessingResult> {
  const grade = gateResult.breakoutScore.grade;
  const totalScore = gateResult.breakoutScore.totalScore;

  const attentionInfo = gateResult.attentionScore
    ? `Attention: ${gateResult.attentionScore.attentionScore} (${gateResult.attentionScore.confidence})`
    : 'Attention: none';
  log.info(`Signal: ${signal.action} from ${signal.strategy} at ${signal.price} (Score: ${totalScore}, Grade: ${grade}, ${attentionInfo})`);

  // Why: Paper 모드에서 온체인 잔고는 0 → 시뮬레이션 잔고 사용
  const balanceSol = ctx.tradingMode === 'paper' && ctx.paperBalance != null
    ? ctx.paperBalance
    : await ctx.executor.getBalance();
  const portfolio = await ctx.riskManager.getPortfolioState(balanceSol);

  // v3: Runner trade ID를 portfolio에 주입 — concurrent 판정에 사용
  const runnerIds = new Set<string>();
  for (const [tradeId, isRunner] of runnerStateMap) {
    if (isRunner) runnerIds.add(tradeId);
  }
  if (runnerIds.size > 0) {
    portfolio.runnerTradeIds = runnerIds;
  }

  await syncTradingHalts(ctx, portfolio);

  if (ctx.tradingHaltedReason) {
    log.warn(`Signal filtered: trading halted (${ctx.tradingHaltedReason})`);
      await ctx.auditLogger.logSignal({
        ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
        action: 'FILTERED',
        filterReason: ctx.tradingHaltedReason,
      });
      return {
        status: 'trading_halted',
        filterReason: ctx.tradingHaltedReason,
      };
    }

  if (gateResult.rejected) {
    const filterReason = gateResult.filterReason || `Score ${totalScore} rejected by gate threshold`;
    logExecutionViabilityTelemetry('Pre-gate execution reject', gateResult.executionViability);
    log.info(`Signal filtered: ${filterReason}`);
      await ctx.auditLogger.logSignal({
        ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
        action: 'FILTERED',
        filterReason,
      });
      return {
        status: 'gate_rejected',
        filterReason,
      };
    }

  if (!ctx.executionLock.acquire()) {
    log.info('Signal skipped — execution lock held');
      await ctx.auditLogger.logSignal({
        ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
        action: 'FILTERED',
        filterReason: 'Execution lock held',
      });
      return {
        status: 'execution_lock',
        filterReason: 'Execution lock held',
      };
    }

  try {
    const candleAgeMs = Date.now() - candles[candles.length - 1].timestamp.getTime();
    const staleResult = checkStaleSignal({
      signal,
      currentPrice: candles[candles.length - 1].close,
      currentTvl: signal.poolTvl,
      dataLatencyMs: Math.min(candleAgeMs, 30_000),
    });

    if (staleResult.isStale) {
      log.info(`Stale signal: ${staleResult.reason}`);
        await ctx.auditLogger.logSignal({
          ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
          action: 'STALE',
          filterReason: staleResult.reason,
        });
        return {
          status: 'stale',
          filterReason: staleResult.reason,
        };
      }

    // Why: ATR-based SL로 리스크 사이징 — candle.low 사용 시 실제 주문 SL과 불일치
    const probeSL = (() => {
      if (signal.strategy === 'fib_pullback') {
        return buildFibPullbackOrder(signal, candles, 1, { timeStopMinutes: config.fibTimeStopMinutes }).stopLoss;
      }
      if (signal.meta.realtimeSignal === 1) {
        return buildMomentumTriggerOrder(signal, candles, 1, {
          slMode: config.realtimeSlMode as 'atr' | 'swing_low' | 'candle_low',
          slAtrMultiplier: config.realtimeSlAtrMultiplier,
          slSwingLookback: config.realtimeSlSwingLookback,
          timeStopMinutes: config.realtimeTimeStopMinutes,
          atrPeriod: 14,
          tp1Multiplier: config.tp1Multiplier,
          tp2Multiplier: config.tp2Multiplier,
          atrFloorPct: config.atrFloorPct,   // Option β 2026-04-10
        }).stopLoss;
      }
      return buildVolumeSpikeOrder(signal, candles, 1, {
        tp1Multiplier: config.tp1Multiplier,
        tp2Multiplier: config.tp2Multiplier,
        slAtrMultiplier: config.slAtrMultiplier,
        timeStopMinutes: config.timeStopMinutes,
      }).stopLoss;
    })();

    // Phase 1 fresh-cohort instrumentation — risk_rejection 이벤트에 cohort 태깅.
    // Watchlist 는 tokenMint 로 키잉되므로 pair-side lookup 사용.
    const orderCohort = ctx.scanner?.getEntryByPairAddress(signal.pairAddress)?.cohort;
    const riskResult = await ctx.riskManager.checkOrder(
      {
        pairAddress: signal.pairAddress,
        strategy: signal.strategy,
        side: 'BUY',
        price: signal.price,
        stopLoss: probeSL,
        breakoutGrade: grade,
        poolTvl: signal.poolTvl,
        cohort: orderCohort,
      },
      portfolio,
      gateResult.tokenSafety
    );

    if (!riskResult.approved) {
      log.warn(`Order rejected by risk manager: ${riskResult.reason}`);
        await ctx.auditLogger.logSignal({
          ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
          action: 'RISK_REJECTED',
          filterReason: riskResult.reason,
        });
        return {
          status: 'risk_rejected',
          filterReason: riskResult.reason,
        };
      }

    if (riskResult.appliedAdjustments && riskResult.appliedAdjustments.length > 0) {
      log.warn(
        `Risk adjustments applied to ${signal.pairAddress}: ${riskResult.appliedAdjustments.join(', ')}`
      );
    }

    let quantity = (riskResult.adjustedQuantity || 0) * gateResult.gradeSizeMultiplier;
    if (gateResult.gradeSizeMultiplier < 1) {
      log.info(
        `Gate sizing multiplier applied: ${gateResult.gradeSizeMultiplier.toFixed(2)} ` +
        `effectiveRR=${gateResult.executionViability.effectiveRR.toFixed(2)}`
      );
    }

    // Phase 1B: Apply regime filter sizing
    if (ctx.regimeFilter) {
      const regimeMult = ctx.regimeFilter.getSizeMultiplier();
      if (regimeMult <= 0) {
        const regime = ctx.regimeFilter.getRegime();
        log.info(`Signal blocked by regime filter: ${regime} (sizeMultiplier=0)`);
        await ctx.auditLogger.logSignal({
          ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
          action: 'FILTERED',
          filterReason: `Regime ${regime} — no new entries`,
        });
        return {
          status: 'regime_blocked',
          filterReason: `Regime ${regime} — no new entries`,
        };
      }
      if (regimeMult < 1) {
        quantity *= regimeMult;
        log.info(`Regime sizing: ${ctx.regimeFilter.getRegime()} x${regimeMult.toFixed(2)}`);
      }
    }
    // H-01: WalletManager pre-trade 체크 (일일 손실 한도 + 포지션 한도)
    if (ctx.walletManager) {
      const positionSol = quantity * signal.price;
      const walletLimit = ctx.walletManager.checkTradeLimits(signal.strategy, positionSol);
      if (!walletLimit.allowed) {
        log.warn(`Signal filtered: ${walletLimit.reason}`);
        await ctx.auditLogger.logSignal({
          ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult),
          action: 'RISK_REJECTED',
          filterReason: walletLimit.filterReason,
        });
        return {
          status: 'wallet_limit',
          filterReason: walletLimit.filterReason,
        };
      }
    }

    let order: Order;
    if (isVolumeSpikeFamilyStrategy(signal.strategy)) {
      order = signal.meta.realtimeSignal === 1
        ? buildMomentumTriggerOrder(signal, candles, quantity, {
          slMode: (config.realtimeSlMode as 'atr' | 'swing_low' | 'candle_low'),
          slAtrMultiplier: config.realtimeSlAtrMultiplier,
          slSwingLookback: config.realtimeSlSwingLookback,
          timeStopMinutes: config.realtimeTimeStopMinutes,
          atrPeriod: 14,
          tp1Multiplier: config.tp1Multiplier,
          tp2Multiplier: config.tp2Multiplier,
          atrFloorPct: config.atrFloorPct,   // Option β 2026-04-10
        })
        : buildVolumeSpikeOrder(signal, candles, quantity, {
          tp1Multiplier: config.tp1Multiplier,
          tp2Multiplier: config.tp2Multiplier,
          slAtrMultiplier: config.slAtrMultiplier,
          timeStopMinutes: config.timeStopMinutes,
        });
    } else if (signal.strategy === 'fib_pullback') {
      order = buildFibPullbackOrder(signal, candles, quantity, {
        timeStopMinutes: config.fibTimeStopMinutes,
      });
    } else {
      throw new Error(`Unsupported live strategy: ${signal.strategy}`);
    }

    order.breakoutScore = totalScore;
    order.breakoutGrade = grade;
    order.sizeConstraint = riskResult.sizeConstraint;
    order.tokenSymbol = signal.tokenSymbol;
    // Phase 1: cohort propagation through Order → Trade (instrumentation only, not persisted)
    order.cohort = orderCohort;

    const rrThresholds = {
      rrReject: config.executionRrReject,
      rrPass: config.executionRrPass,
      rrBasis: config.executionRrBasis as 'tp1' | 'tp2',
    };
    const sizeAwareExecution = evaluateExecutionViabilityForOrder(order, signal.poolTvl || 0, {
      ammFeePct: signal.meta.ammFeePct,
      mevMarginPct: signal.meta.mevMarginPct,
    }, rrThresholds);
    let postSizeExecution = sizeAwareExecution;
    if (sizeAwareExecution.sizeMultiplier < 1 && !sizeAwareExecution.rejected) {
      order.quantity *= sizeAwareExecution.sizeMultiplier;
      quantity = order.quantity;
      postSizeExecution = evaluateExecutionViabilityForOrder(order, signal.poolTvl || 0, {
        ammFeePct: signal.meta.ammFeePct,
        mevMarginPct: signal.meta.mevMarginPct,
      }, rrThresholds);
    }
    logExecutionViabilityComparison(gateResult.executionViability, postSizeExecution);
      if (postSizeExecution.rejected) {
        log.warn(`Signal filtered after size-aware execution check: ${postSizeExecution.filterReason}`);
        await ctx.auditLogger.logSignal({
          ...buildSignalAuditBase(signal, candles[candles.length - 1], gateResult, postSizeExecution),
          action: 'FILTERED',
          filterReason: postSizeExecution.filterReason,
          effectiveRR: postSizeExecution.effectiveRR,
          roundTripCost: postSizeExecution.roundTripCost,
        });
        return {
          status: 'execution_viability_rejected',
          filterReason: postSizeExecution.filterReason,
        };
      }
    if (sizeAwareExecution.sizeMultiplier < 1) {
      log.info(
        `Actual-size execution haircut applied: x${sizeAwareExecution.sizeMultiplier.toFixed(2)} ` +
        `effectiveRR=${postSizeExecution.effectiveRR.toFixed(2)}`
      );
    }

    await ctx.notifier.sendSignal(signal);

    const positionId = await ctx.positionStore.createPosition(
      signal.pairAddress,
      buildPositionSignalData(signal, gateResult, totalScore, grade, postSizeExecution)
    );

      try {
        let txSignature = 'PAPER_TRADE';
        let buyResult: SwapResult | undefined;

        if (ctx.tradingMode === 'paper') {
          log.info(`[PAPER] Simulating execution: ${JSON.stringify(order)}`);
        } else {
          await ctx.positionStore.updateState(positionId, 'ORDER_SUBMITTED');
          buyResult = await ctx.executor.executeBuy(order);
          txSignature = buyResult.txSignature;

          if (buyResult.slippageBps > 0) {
            log.info(`Entry slippage: ${buyResult.slippageBps}bps`);
          }
        }
        const executionSummary = buildEntryExecutionSummary(order, postSizeExecution, buyResult);
        logEntryExecutionSummary(signal, order, executionSummary);

        await recordOpenedTrade(
          ctx,
          positionId,
          signal,
          candles[candles.length - 1],
          gateResult,
          order,
          totalScore,
          riskResult.sizeConstraint,
          txSignature,
          executionSummary,
          postSizeExecution
        );

      if (ctx.tradingMode === 'paper' && ctx.paperBalance != null) {
        const entryNotionalSol = order.quantity * order.price;
        ctx.paperBalance = Math.max(0, ctx.paperBalance - entryNotionalSol);
      }

      // Phase 1B: Record paper metrics entry
      if (ctx.paperMetrics) {
        ctx.paperMetrics.recordEntry({
          id: positionId,
          pairAddress: signal.pairAddress,
          strategy: signal.strategy,
          sourceLabel: signal.sourceLabel,
          entryPrice: order.price,
          quantity: order.quantity,
          entryTime: new Date(),
          entryPriceImpactPct: gateResult.quoteGate?.priceImpactPct,
          regimeAtEntry: ctx.regimeFilter?.getRegime(),
          securityFlags: gateResult.securityGate?.flags,
        });
      }

      log.info(`Trade opened: ${txSignature}`);
        return {
          status: ctx.tradingMode === 'paper' ? 'executed_paper' : 'executed_live',
          tradeId: positionId,
          txSignature,
        };
      } catch (error) {
        log.error(`Trade execution failed: ${error}`);
        await ctx.positionStore.updateState(positionId, 'ORDER_FAILED');
        const executionError = error instanceof Error
          ? new Error(`${signal.strategy} ${signal.pairAddress}: ${error.message}`)
          : new Error(`${signal.strategy} ${signal.pairAddress}: ${String(error)}`);
        await ctx.notifier.sendError('trade_execution', executionError).catch(() => {});
        return {
          status: 'execution_failed',
          filterReason: error instanceof Error ? error.message : String(error),
          tradeId: positionId,
        };
      }
  } finally {
    ctx.executionLock.release();
  }
}

// Why: CRITICAL_LIVE P0-A/B — entry price 생성 경로 오염 감지용 감시 임계.
// A2는 [0.5, 2.0] 바깥에서 loud warn, A3의 alignment clamp는 [0.7, 1.3]에서 즉시 차단.
const ENTRY_PRICE_SAFE_RATIO_MIN = 0.5;
const ENTRY_PRICE_SAFE_RATIO_MAX = 2.0;

/**
 * buildEntryExecutionSummary 의 핵심 (entry price + notional) consistency guard 를
 * lane handler (cupsey/migration/pure_ws) 에서도 그대로 쓸 수 있도록 분리.
 *
 * Why (2026-04-18 drift fix): 세 lane handler 가 `actualOutUiAmount` 만 있고
 * `actualInputUiAmount` 가 없을 때 actualEntryPrice 를 signal.price (planned) 로
 * 유지하는 버그 때문에 `entryPrice × quantity` 로 역산한 entry cost 가 실제 지출
 * 과 10x 이상 어긋났음 (wallet_delta_warn `drift=+0.0799 SOL` 의 root cause).
 * Fix: one-shot all-or-nothing guard — 한쪽만 가용하면 둘 다 planned 로 복원.
 */
export function resolveActualEntryMetrics(
  order: Order,
  buyResult?: SwapResult
): { entryPrice: number; quantity: number; actualEntryNotionalSol: number; partialFillDataMissing: boolean } {
  const plannedEntryNotionalSol = order.quantity * order.price;
  const hasActualOut =
    buyResult?.actualOutUiAmount != null && buyResult.actualOutUiAmount > 0;
  const hasActualIn =
    buyResult?.actualInputUiAmount != null && buyResult.actualInputUiAmount > 0;

  const OUTPUT_SANITY_MULTIPLIER = 5;
  let quantity: number;
  let actualEntryNotionalSol: number;
  // 2026-04-25 Phase 1 P0-3 — partial fill data missing flag.
  // 한쪽만 가용한 swap 결과를 planned 로 강제 복원했음을 ledger 에 명시한다.
  let partialFillDataMissing = false;
  if (hasActualIn && hasActualOut) {
    const expectedQty = order.price > 0 ? buyResult!.actualInputUiAmount! / order.price : 0;
    if (expectedQty > 0 && buyResult!.actualOutUiAmount! > expectedQty * OUTPUT_SANITY_MULTIPLIER) {
      log.error(
        `[MULTI_ACCOUNT_RISK] actualOut ${buyResult!.actualOutUiAmount!.toFixed(4)} >> ` +
        `expected ${expectedQty.toFixed(4)} (${(buyResult!.actualOutUiAmount! / expectedQty).toFixed(1)}x) ` +
        `pair=${order.pairAddress} — forcing planned to avoid ratio distortion`
      );
      quantity = order.quantity;
      actualEntryNotionalSol = plannedEntryNotionalSol;
      partialFillDataMissing = true; // sanity reject 도 데이터 품질 이슈
    } else {
      quantity = buyResult!.actualOutUiAmount!;
      actualEntryNotionalSol = buyResult!.actualInputUiAmount!;
    }
  } else {
    if (buyResult && (hasActualIn || hasActualOut)) {
      log.error(
        `[PRICE_ANOMALY] Partial fill metrics for ${order.pairAddress}: ` +
        `actualIn=${buyResult.actualInputUiAmount ?? 'null'} ` +
        `actualOut=${buyResult.actualOutUiAmount ?? 'null'} ` +
        `outputDecimals=${buyResult.outputDecimals ?? 'null'} — ` +
        `forcing both to planned to avoid ratio distortion`
      );
      partialFillDataMissing = true;
    }
    quantity = order.quantity;
    actualEntryNotionalSol = plannedEntryNotionalSol;
  }

  const entryPrice = quantity > 0 ? actualEntryNotionalSol / quantity : order.price;
  return { entryPrice, quantity, actualEntryNotionalSol, partialFillDataMissing };
}

export function buildEntryExecutionSummary(
  order: Order,
  actualExecution: { effectiveRR: number; roundTripCost: number },
  buyResult?: SwapResult
): EntryExecutionSummary {
  // Why: 한쪽만 fallback 되면 entryPrice가 ratio 왜곡된다 (CRITICAL_LIVE P0-A).
  // 둘 다 실측 또는 둘 다 planned로 강제한다 — 공통 helper 로 분리 (2026-04-18).
  //
  // 2026-04-10 P1-D2 fix: output quantity sanity guard.
  // getTokenBalance() 가 wallet 의 모든 SPL token account 를 합산하므로, 이전 거래의 잔여분이
  // 남아있으면 balance delta 에 이전 잔고가 포함된다 (RPC timing race 시 before=0 / after=old+new).
  // GRIFFAIN 사례: 682 tokens received vs expected 27.25 = 25x 초과 → entryPrice 25x 왜곡
  // → Phase A3 ratio 0.04 → PRICE_ANOMALY_BLOCK (per-token 80% 차단의 주요 원인 — TD-16).
  // Fix: actualOut 이 expected 의 5x 를 초과하면 force-to-planned 으로 전환.
  const { entryPrice, quantity: actualQuantity, actualEntryNotionalSol, partialFillDataMissing } =
    resolveActualEntryMetrics(order, buyResult);
  const hasActualOut =
    buyResult?.actualOutUiAmount != null && buyResult.actualOutUiAmount > 0;
  const hasActualIn =
    buyResult?.actualInputUiAmount != null && buyResult.actualInputUiAmount > 0;
  const entrySlippagePct =
    order.price > 0 ? (entryPrice - order.price) / order.price : 0;

  // Why: ratio가 [0.5, 2.0] 바깥이면 단위/decimals 오염 가능성이 매우 높다 (BTW 1.5e-6 사례).
  // 여기서는 경고만 찍고, A3의 alignOrderToExecutedEntry에서 [0.7, 1.3] clamp로 차단한다.
  if (order.price > 0 && entryPrice > 0) {
    const ratio = entryPrice / order.price;
    if (ratio < ENTRY_PRICE_SAFE_RATIO_MIN || ratio > ENTRY_PRICE_SAFE_RATIO_MAX) {
      // 2026-04-08 P1-D2: PRICE_ANOMALY_BLOCK 이 signal 의 80%+ 를 차지하는 상태에서
      // root cause 분해가 불가능해 입력 원본을 그대로 덤프한다. 특히 buyResult 의 raw
      // fields (expectedInAmount, actualInputAmount, expectedOutAmount, actualOutAmount,
      // inputDecimals, outputDecimals) 를 bits-level 로 남겨 decimals mismatch vs
      // partial-fill vs fee-inclusion 을 사후 분류한다.
      log.error(
        `[PRICE_ANOMALY] Entry price ratio ${ratio.toFixed(6)} outside ` +
        `[${ENTRY_PRICE_SAFE_RATIO_MIN}, ${ENTRY_PRICE_SAFE_RATIO_MAX}]: ` +
        `pair=${order.pairAddress} planned=${order.price.toFixed(8)} ` +
        `actual=${entryPrice.toFixed(8)} hasActualIn=${hasActualIn} ` +
        `hasActualOut=${hasActualOut} ` +
        `expectedIn=${buyResult?.expectedInAmount?.toString() ?? 'null'} ` +
        `actualIn=${buyResult?.actualInputAmount?.toString() ?? 'null'} ` +
        `actualInUi=${buyResult?.actualInputUiAmount ?? 'null'} ` +
        `inputDec=${buyResult?.inputDecimals ?? 'null'} ` +
        `expectedOut=${buyResult?.expectedOutAmount?.toString() ?? 'null'} ` +
        `actualOut=${buyResult?.actualOutAmount?.toString() ?? 'null'} ` +
        `actualOutUi=${buyResult?.actualOutUiAmount ?? 'null'} ` +
        `outputDec=${buyResult?.outputDecimals ?? 'null'} ` +
        `slipBps=${buyResult?.slippageBps ?? 'null'} ` +
        `plannedQty=${order.quantity} actualQty=${actualQuantity}`
      );
    }
  }

  return {
    entryPrice,
    quantity: actualQuantity,
    plannedEntryPrice: order.price,
    plannedQuantity: order.quantity,
    actualEntryNotionalSol,
    entrySlippageBps: buyResult?.slippageBps ?? 0,
    entrySlippagePct,
    expectedInAmount: buyResult?.expectedInAmount?.toString(),
    actualInputAmount: buyResult?.actualInputAmount?.toString(),
    actualInputUiAmount: buyResult?.actualInputUiAmount,
    inputDecimals: buyResult?.inputDecimals,
    expectedOutAmount: buyResult?.expectedOutAmount?.toString(),
    actualOutAmount: buyResult?.actualOutAmount?.toString(),
    outputDecimals: buyResult?.outputDecimals,
    effectiveRR: actualExecution.effectiveRR,
    roundTripCost: actualExecution.roundTripCost,
    partialFillDataMissing,
  };
}

function logEntryExecutionSummary(
  signal: Signal,
  order: Order,
  executionSummary: EntryExecutionSummary
): void {
  const entryDriftPct = executionSummary.entrySlippagePct * 100;
  const quantityDriftPct = executionSummary.plannedQuantity > 0
    ? ((executionSummary.quantity - executionSummary.plannedQuantity) / executionSummary.plannedQuantity) * 100
    : 0;
  const entryNotionalSol = executionSummary.entryPrice * executionSummary.quantity;
  const driftLabel = Math.abs(entryDriftPct) >= 20 ? 'warn' : 'info';
  const message =
    `Entry execution summary: pair=${signal.pairAddress} source=${signal.sourceLabel ?? 'unknown'} ` +
    `signal=${signal.price.toFixed(8)} planned=${executionSummary.plannedEntryPrice.toFixed(8)} ` +
    `actual=${executionSummary.entryPrice.toFixed(8)} drift=${entryDriftPct.toFixed(2)}% ` +
    `qty=${executionSummary.quantity.toFixed(6)} plannedQty=${executionSummary.plannedQuantity.toFixed(6)} ` +
    `qtyDrift=${quantityDriftPct.toFixed(2)}% notional=${entryNotionalSol.toFixed(6)}SOL ` +
    `effectiveRR=${executionSummary.effectiveRR.toFixed(2)} ` +
    `roundTrip=${(executionSummary.roundTripCost * 100).toFixed(2)}%`;
  if (driftLabel === 'warn') {
    log.warn(message);
    return;
  }
  log.info(message);
}

function logExecutionViabilityTelemetry(
  prefix: string,
  execution: GateEvaluationResult['executionViability']
): void {
  if (!execution.filterReason?.startsWith('poor_execution_viability')) return;
  log.warn(
    `${prefix}: effectiveRR=${execution.effectiveRR.toFixed(2)} ` +
    `risk=${formatPct(execution.riskPct)} reward=${formatPct(execution.rewardPct)} ` +
    `entryImpact=${formatPct(execution.entryPriceImpactPct)} exitImpact=${formatPct(execution.exitPriceImpactPct)} ` +
    `roundTrip=${formatPct(execution.roundTripCost)} ` +
    `probeNotional=${formatMaybe(execution.notionalSol, 4)}SOL ` +
    `probeQty=${formatMaybe(execution.quantity, 6)}`
  );
}

function logExecutionViabilityComparison(
  preGate: GateEvaluationResult['executionViability'],
  postSize: ReturnType<typeof evaluateExecutionViabilityForOrder>
): void {
  log.info(
    `Execution viability compare: preGateRR=${preGate.effectiveRR.toFixed(2)} ` +
    `postSizeRR=${postSize.effectiveRR.toFixed(2)} ` +
    `preGateNotional=${formatMaybe(preGate.notionalSol, 4)}SOL ` +
    `postSizeNotional=${formatMaybe(postSize.notionalSol, 4)}SOL ` +
    `preGateQty=${formatMaybe(preGate.quantity, 6)} ` +
    `postSizeQty=${formatMaybe(postSize.quantity, 6)}`
  );
}

function formatPct(value?: number): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

function formatMaybe(value?: number, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}
