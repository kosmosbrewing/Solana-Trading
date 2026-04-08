import { GateEvaluationResult } from '../gate';
import { config } from '../utils/config';
import { FAKE_FILL_SLIPPAGE_BPS_THRESHOLD } from '../utils/constants';
import { createModuleLogger } from '../utils/logger';
import { Candle, CloseReason, Order, Signal, Trade } from '../utils/types';
import { bpsToDecimal, decimalToBps } from '../utils/units';
import { calcATR, calcAdaptiveTrailingStop, checkExhaustion } from '../strategy';
import { PositionStore } from '../state';
import { RiskManager } from '../risk';
import { BotContext } from './types';
import { buildGateTraceSnapshot } from './signalTrace';
import { summarizeTradeObservation } from './tradeMonitoring';

const log = createModuleLogger('TradeExecution');

// Why: CRITICAL_LIVE P0-C — alignOrderToExecutedEntry가 actual/planned ratio를
// 그대로 TP/SL에 곱하기 때문에, ratio가 30% 이상 벌어지면 광적인 TP/SL이 ledger에
// 저장되어 "currentPrice가 즉시 TP를 상회하는 것처럼 보이는" 망상이 발생한다.
// A3 clamp는 이 band 바깥에서 trade를 OPEN 상태로 기록하는 것을 차단한다.
const ENTRY_ALIGN_RATIO_MIN = 0.7;
const ENTRY_ALIGN_RATIO_MAX = 1.3;

// Why: CRITICAL_LIVE P0-D — exitPrice가 entryPrice와 단위가 어긋나면 pnl이 터무니없이
// 커지거나 -95% 이하로 폭락한다. 아래 밴드 바깥이면 close 메시지/로그에 [ANOMALY] 표식.
const EXIT_RATIO_MIN = -0.95; // 95% 손실보다 더 크면 비현실
const EXIT_RATIO_MAX = 10; // +1000% 초과면 비현실

// Why: decision price와 실제 fill이 50% 이상 벌어지면 price axis mismatch 의심
// (planned=0.815 → fill=0.00000122 같은 -100% gap 케이스를 잡기 위함)
const DECISION_FILL_GAP_ALERT_PCT = 0.5;

// Why: 2026-04-07 fake-fill detection — Jupiter Ultra outputAmountResult="0" 케이스에서
// receivedSol <= 0이면 currentPrice로 fallback하는 기존 패턴이 "승리한 것처럼" 마스킹했다.
// 임계값(9000bps)은 src/utils/constants.ts에 공유 상수로 존재.
// Phase A4 재사용 — 같은 임계를 쓴다.
const SLIPPAGE_SATURATED_BPS = FAKE_FILL_SLIPPAGE_BPS_THRESHOLD;

interface FakeFillDetection {
  isFake: boolean;
  reasons: string[];
}

/**
 * Jupiter Ultra saturated swap 감지.
 * exit path에서 receivedSol <= 0이거나 slippageBps >= 9000이면 fake-fill로 판정.
 * 반환된 reason은 exit_anomaly_reason 컬럼에 콤마 조인으로 저장된다.
 */
function detectFakeFill(
  receivedSol: number,
  slippageBps: number,
  exitPath: string,
): FakeFillDetection {
  const reasons: string[] = [];
  if (receivedSol <= 0) reasons.push(`fake_fill_no_received(${exitPath})`);
  if (slippageBps >= FAKE_FILL_SLIPPAGE_BPS_THRESHOLD) {
    reasons.push(`slippage_saturated=${slippageBps}bps`);
  }
  return { isFake: reasons.length > 0, reasons };
}

/**
 * 4개 exit path 공통 패턴 — Jupiter live sell 응답을 exitPrice/anomalyReason으로 해석.
 *
 * Why: closeTrade / handleDegradedExitPhase1 / handleTakeProfit1Partial /
 * handleRunnerGradeBPartial 4곳이 같은 `received > 0 ? received/qty : fallback` 패턴과
 * saturated-slippage 보조 검사를 반복 구현해 왔다. 단일 helper로 drift를 차단한다.
 *
 * 입력:
 *   - `fallbackPrice`: receivedSol <= 0일 때 사용할 사전 계산된 가격.
 *     closeTrade는 decisionPrice ?? entryPrice, 나머지 3경로는 currentPrice.
 *     이 값이 실제로 DB exitPrice에 기록되는 가격이므로 log 메시지에도 동일 값을 출력한다.
 *   - `soldQuantity`: 부분 청산 시 sold 분량. closeTrade는 trade.quantity.
 *
 * 출력: `exitPrice`, `executionSlippage`(소수), `anomalyReason`(comma-joined reason).
 */
function resolveExitFillOrFakeFill(params: {
  tradeId: string;
  exitPath: string;
  receivedSol: number;
  soldQuantity: number;
  slippageBps: number;
  fallbackPrice: number;
}): {
  exitPrice: number;
  executionSlippage: number;
  anomalyReason: string | undefined;
} {
  const { tradeId, exitPath, receivedSol, soldQuantity, slippageBps, fallbackPrice } = params;
  const executionSlippage = bpsToDecimal(slippageBps);

  // Happy path: received/quantity 계산. 실패 시 sanitized fallback 으로 대체한다.
  const hasValidFill = receivedSol > 0 && soldQuantity > 0;
  const exitPrice = hasValidFill ? receivedSol / soldQuantity : fallbackPrice;

  // detectFakeFill 이 두 가지 상호 배타적 원인(`fake_fill_no_received`, `slippage_saturated=*`)을
  // 한 번에 수집하므로 호출은 한 번이면 충분하다. fallback 여부와 무관하게 동일 helper 를 쓴다.
  const detection = detectFakeFill(receivedSol, slippageBps, exitPath);
  if (!detection.isFake) {
    return { exitPrice, executionSlippage, anomalyReason: undefined };
  }

  // log 의 trigger 문구는 원인에 맞춰 다르게 출력하여 운영 디버깅을 돕는다.
  const trigger = hasValidFill
    ? 'saturated slippage'
    : `fallback to ${exitPrice.toFixed(8)}`;
  log.error(
    `[FAKE_FILL] Trade ${tradeId} ${trigger} (${exitPath}): ` +
    `received=${receivedSol.toFixed(6)} slip=${slippageBps}bps`,
  );
  return {
    exitPrice,
    executionSlippage,
    anomalyReason: detection.reasons.join(','),
  };
}

function formatTokenQuantity(quantity: number, tokenSymbol?: string): string {
  return `${quantity.toFixed(6)} ${tokenSymbol?.trim() || 'tokens'}`;
}

/**
 * Fake-fill detection reason과 Phase A4 anomaly reasons를 단일 문자열로 병합.
 * 중복 토큰은 제거한다 (slippage_saturated가 양쪽에서 모두 push될 수 있음).
 */
function mergeAnomalyReasons(
  fakeFillReason: string | undefined,
  phaseA4Reasons: string[],
): string | undefined {
  const all: string[] = [];
  if (fakeFillReason) all.push(...fakeFillReason.split(','));
  if (phaseA4Reasons.length > 0) all.push(...phaseA4Reasons);
  const deduped = Array.from(new Set(all.map((s) => s.trim()).filter((s) => s.length > 0)));
  return deduped.length > 0 ? deduped.join(',') : undefined;
}

/**
 * Phase A3 — recordOpenedTrade에서 ratio clamp 위반 시 throw.
 * signalProcessor catch 블록이 ORDER_FAILED 상태 전이 + execution_failed 반환을 처리하므로
 * 여기서는 loud error + emergency dump만 책임진다.
 */
export class PriceAnomalyError extends Error {
  constructor(message: string, public readonly context: Record<string, unknown>) {
    super(message);
    this.name = 'PriceAnomalyError';
  }
}

// ─── v2: Degraded Exit State (in-memory, DB 변경 불필요) ───

interface DegradedState {
  /** 첫 partial 매도 시각 (phase 2 타이머 기준) */
  partialSoldAt: Date;
  /** 원본 trade의 pairAddress (잔여분 새 trade 매칭용) */
  pairAddress: string;
}

export interface EntryExecutionSummary {
  entryPrice: number;
  quantity: number;
  plannedEntryPrice: number;
  plannedQuantity: number;
  actualEntryNotionalSol: number;
  entrySlippageBps: number;
  entrySlippagePct: number;
  expectedInAmount?: string;
  actualInputAmount?: string;
  actualInputUiAmount?: number;
  inputDecimals?: number;
  expectedOutAmount?: string;
  actualOutAmount?: string;
  outputDecimals?: number;
  effectiveRR: number;
  roundTripCost: number;
}

/** trade.id → DegradedState (실제 트리거된 거래만 포함) */
export const degradedStateMap = new Map<string, DegradedState>();

/** trade.id → quote 연속 실패 카운트 (degraded 판정 전 추적용) */
export const quoteFailCountMap = new Map<string, number>();

export function isDegraded(tradeId: string): boolean {
  return degradedStateMap.has(tradeId);
}

function applyPaperExitProceeds(ctx: BotContext, quantity: number, exitPrice: number): void {
  if (ctx.tradingMode !== 'paper' || ctx.paperBalance == null) return;
  ctx.paperBalance = Math.max(0, ctx.paperBalance + (quantity * exitPrice));
}

/**
 * v2: Degraded Exit 판정
 * 조건: sellImpact > threshold OR quote 연속 실패 >= limit
 * degradedStateMap에는 조건 충족 시에만 추가 (C-1 fix)
 */
export function checkDegradedCondition(
  tradeId: string,
  sellImpact: number | null,
  quoteSuccess: boolean
): boolean {
  if (!config.degradedExitEnabled) return false;

  // Quote 실패 카운트 (별도 Map — degraded 여부와 분리)
  if (!quoteSuccess) {
    const count = (quoteFailCountMap.get(tradeId) ?? 0) + 1;
    quoteFailCountMap.set(tradeId, count);
  } else {
    quoteFailCountMap.set(tradeId, 0);
  }

  // 이미 degraded면 중복 처리 불필요
  if (degradedStateMap.has(tradeId)) return true;

  // 조건 판정
  const impactTriggered = sellImpact !== null && sellImpact > config.degradedSellImpactThreshold;
  const quoteFailTriggered = (quoteFailCountMap.get(tradeId) ?? 0) >= config.degradedQuoteFailLimit;

  return impactTriggered || quoteFailTriggered;
}

/**
 * v2: Degraded Exit phase 1 실행 — TP1 partial 패턴 따라 부분 청산 + 잔여분 새 trade 생성
 * (C-2 fix: closeTrade가 trade를 CLOSED 처리하므로 잔여분은 새 trade로 생성)
 */
export async function handleDegradedExitPhase1(
  trade: Trade,
  currentPrice: number,
  ctx: BotContext
): Promise<void> {
  const partialPct = config.degradedPartialPct;
  const soldQuantity = trade.quantity * partialPct;
  const remainingQuantity = trade.quantity - soldQuantity;

  if (remainingQuantity <= 0 || soldQuantity <= 0) {
    log.warn(`Invalid degraded split for trade ${trade.id}; closing full position`);
    degradedStateMap.delete(trade.id);
    quoteFailCountMap.delete(trade.id);
    await closeTrade(trade, 'DEGRADED_EXIT', ctx, currentPrice);
    return;
  }

  log.warn(
    `DEGRADED_EXIT phase 1: selling ${(partialPct * 100).toFixed(0)}% ` +
    `of trade ${trade.id} (${formatTokenQuantity(soldQuantity, trade.tokenSymbol)})`
  );

  // TP1 partial 패턴: 부분 청산
  let exitPrice = currentPrice;
  let executionSlippage = 0;
  let degradedAnomalyReason: string | undefined;

  if (ctx.tradingMode === 'live') {
    const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);
    const partialTokenAmount = BigInt(Math.floor(Number(tokenBalance) * partialPct));

    if (partialTokenAmount > 0n) {
      const solBefore = await ctx.executor.getBalance();
      const sellResult = await ctx.executor.executeSell(trade.pairAddress, partialTokenAmount);
      const solAfter = await ctx.executor.getBalance();
      const receivedSol = solAfter - solBefore;

      const resolved = resolveExitFillOrFakeFill({
        tradeId: trade.id,
        exitPath: 'degraded_phase1',
        receivedSol,
        soldQuantity,
        slippageBps: sellResult.slippageBps,
        fallbackPrice: currentPrice,
      });
      exitPrice = resolved.exitPrice;
      executionSlippage = resolved.executionSlippage;
      degradedAnomalyReason = resolved.anomalyReason;
    }
  }

  const realizedPnl = (exitPrice - trade.entryPrice) * soldQuantity;
  const degradedExitSlippageBps = ctx.tradingMode === 'live' ? decimalToBps(executionSlippage) : undefined;
  applyPaperExitProceeds(ctx, soldQuantity, exitPrice);

  // P1-4: degraded exit trigger reason 판정
  const failCount = quoteFailCountMap.get(trade.id) ?? 0;
  const triggerReason: 'sell_impact' | 'quote_fail' =
    failCount >= config.degradedQuoteFailLimit ? 'quote_fail' : 'sell_impact';

  await ctx.tradeStore.closeTrade({
    id: trade.id,
    exitPrice,
    pnl: realizedPnl,
    slippage: executionSlippage,
    exitReason: 'DEGRADED_EXIT',
    quantity: soldQuantity,
    exitSlippageBps: degradedExitSlippageBps,
    degradedTriggerReason: triggerReason,
    degradedQuoteFailCount: failCount > 0 ? failCount : undefined,
    decisionPrice: currentPrice, // degraded trigger price
    exitAnomalyReason: degradedAnomalyReason,
  });

  // 잔여분 새 trade 생성 (phase 2에서 청산)
  const remainingTrade: Omit<Trade, 'id'> = {
    ...trade,
    quantity: remainingQuantity,
    parentTradeId: trade.id,
    status: 'OPEN',
    createdAt: new Date(),
    closedAt: undefined,
    exitPrice: undefined,
    pnl: undefined,
    slippage: undefined,
    exitReason: undefined,
  };
  await ctx.tradeStore.insertTrade(remainingTrade);

  // degraded 상태 기록 (phase 2 타이머 시작)
  degradedStateMap.set(trade.id, { partialSoldAt: new Date(), pairAddress: trade.pairAddress });

  const partialTrade: Trade = {
    ...trade,
    quantity: soldQuantity,
    exitPrice,
    decisionPrice: currentPrice,
    exitSlippageBps: degradedExitSlippageBps,
    pnl: realizedPnl,
    slippage: executionSlippage,
    status: 'CLOSED',
    exitReason: 'DEGRADED_EXIT',
    closedAt: new Date(),
  };
  await ctx.notifier.sendTradeClose(partialTrade);
  await ctx.notifier.sendTradeAlert(
    `DEGRADED_EXIT phase 1: ${trade.strategy} sold ${(partialPct * 100).toFixed(0)}%, ` +
    `remaining ${formatTokenQuantity(remainingQuantity, trade.tokenSymbol)} ` +
    `— phase 2 in ${(config.degradedDelayMs / 60_000).toFixed(0)}min`
  );
  ctx.healthMonitor.updateTradeTime();
}

/**
 * v2: Degraded Exit 모니터링 — 이미 degraded인 거래의 phase 2 대기/실행
 * openTrades에서 잔여분이 새 trade.id로 나타남 → pairAddress 기반 매칭
 */
async function handleDegradedExit(
  trade: Trade,
  currentPrice: number,
  ctx: BotContext
): Promise<void> {
  // phase 1의 원본 trade.id로 degradedState를 찾음
  // 잔여분은 새 trade.id이므로, pairAddress로 기존 degraded 상태 검색
  let degradedEntry: [string, DegradedState] | undefined;
  for (const [id, state] of degradedStateMap) {
    if (id === trade.id || state.pairAddress === trade.pairAddress) {
      degradedEntry = [id, state];
      break;
    }
  }
  if (!degradedEntry) return;

  const [originalId, state] = degradedEntry;
  const elapsed = Date.now() - state.partialSoldAt.getTime();

  if (elapsed >= config.degradedDelayMs) {
    log.warn(
      `DEGRADED_EXIT phase 2: closing remaining ${formatTokenQuantity(trade.quantity, trade.tokenSymbol)} ` +
      `of trade ${trade.id} (original: ${originalId})`
    );
    degradedStateMap.delete(originalId);
    quoteFailCountMap.delete(originalId);
    await closeTrade(trade, 'DEGRADED_EXIT', ctx, currentPrice);
  }
  // delay 미경과 시 다음 사이클까지 대기
}

// ─── v2: Runner Extension State ───

/** trade.id → runner mode 활성화 여부 */
export const runnerStateMap = new Map<string, boolean>();

/** v3: Runner 활성화 결과 — Grade별 사이징 분기 */
export interface RunnerActivation {
  activate: boolean;
  sizeMultiplier: number;
}

/**
 * v3: Runner 조건 체크 — TP2 도달 시 trailing-only 전환 여부 결정
 * Grade A: full trailing (sizeMultiplier 1.0)
 * Grade B + flag on: 50% TP2 매도 + 50% trailing (sizeMultiplier 0.5)
 */
export function shouldActivateRunner(
  trade: Trade,
  ctx: BotContext
): RunnerActivation {
  if (!config.runnerEnabled) return { activate: false, sizeMultiplier: 0 };
  if (isDegraded(trade.id)) return { activate: false, sizeMultiplier: 0 };
  if (ctx.tradingHaltedReason) return { activate: false, sizeMultiplier: 0 };

  if (trade.breakoutGrade === 'A') {
    return { activate: true, sizeMultiplier: 1.0 };
  }
  if (trade.breakoutGrade === 'B' && config.runnerGradeBEnabled) {
    return { activate: true, sizeMultiplier: 0.5 };
  }
  return { activate: false, sizeMultiplier: 0 };
}

async function loadTradeMonitoringSnapshot(
  trade: Trade,
  ctx: BotContext
): Promise<{ trade: Trade; recentCandles: Candle[]; currentPrice: number } | undefined> {
  const recentCandles = ctx.internalCandleSource
    ? await ctx.internalCandleSource.getRecentCandles(trade.pairAddress, 300, 10)
    : await ctx.candleStore.getRecentCandles(trade.pairAddress, 300, 10);
  const realtimePrice = ctx.realtimeCandleBuilder?.getCurrentPrice(trade.pairAddress) ?? null;
  const candlePrice = recentCandles[recentCandles.length - 1]?.close;
  const currentPrice = realtimePrice ?? candlePrice;

  if (currentPrice == null) {
    return undefined;
  }

  return {
    trade,
    recentCandles,
    currentPrice,
  };
}

export async function checkOpenPositions(ctx: BotContext): Promise<void> {
  const balanceSol = ctx.tradingMode === 'paper' && ctx.paperBalance != null
    ? ctx.paperBalance
    : await ctx.executor.getBalance();
  const portfolio = await ctx.riskManager.getPortfolioState(balanceSol);
  const openTrades = portfolio.openTrades;
  ctx.healthMonitor.updatePositions(openTrades.length);
  ctx.healthMonitor.updateDailyPnl(portfolio.dailyPnl);

  if (openTrades.length === 0) {
    await syncTradingHalts(ctx, portfolio);
    return;
  }

  const monitoredTrades = await Promise.all(
    openTrades.map((trade) => loadTradeMonitoringSnapshot(trade, ctx))
  );
  const activeTrades = monitoredTrades.filter((item): item is NonNullable<typeof item> => !!item);
  const portfolioWithUnrealized = ctx.riskManager.applyUnrealizedDrawdown(
    portfolio,
    activeTrades.map(item => ({
      quantity: item.trade.quantity,
      currentPrice: item.currentPrice,
    }))
  );
  await syncTradingHalts(ctx, portfolioWithUnrealized);

  for (const { trade, recentCandles, currentPrice } of activeTrades) {
    // Phase 1B: Update MAE/MFE excursions
    if (ctx.paperMetrics) {
      ctx.paperMetrics.updateExcursion(trade.id, currentPrice);
    }

    const now = new Date();

    // v2 Priority 0: Degraded Exit — phase 2 대기 중인 거래 처리
    if (config.degradedExitEnabled) {
      // 이미 degraded 상태(phase 1 완료)인 거래는 phase 2 진행
      if (isDegraded(trade.id)) {
        await handleDegradedExit(trade, currentPrice, ctx);
        continue;
      }
      // 같은 pairAddress의 degraded 잔여분인지 확인 (phase 1에서 새 trade로 생성됨)
      let isRemainder = false;
      for (const [, state] of degradedStateMap) {
        if (state.pairAddress === trade.pairAddress) {
          isRemainder = true;
          break;
        }
      }
      if (isRemainder) {
        await handleDegradedExit(trade, currentPrice, ctx);
        continue;
      }
    }

    const observation = summarizeTradeObservation(trade, recentCandles, currentPrice);
    if (!trade.highWaterMark || observation.peakPrice > trade.highWaterMark) {
      await ctx.tradeStore.updateHighWaterMark(trade.id, observation.peakPrice);
      trade.highWaterMark = observation.peakPrice;
    }

    if (now >= trade.timeStopAt) {
      log.info(`Time stop triggered for trade ${trade.id}`);
      await closeTrade(trade, 'TIME_STOP', ctx, currentPrice);
      continue;
    }

    if (observation.observedLow <= trade.stopLoss) {
      const stopLossPrice = currentPrice <= trade.stopLoss ? currentPrice : trade.stopLoss;
      const penetrationPct = ((trade.stopLoss - observation.observedLow) / trade.stopLoss) * 100;
      if (penetrationPct > 1) {
        log.warn(
          `SL penetration warning: low ${observation.observedLow} is ${penetrationPct.toFixed(1)}% below SL ${trade.stopLoss}. ` +
          `Actual exit slippage may be significant.`
        );
      }
      log.info(`Stop loss triggered for trade ${trade.id} at ${stopLossPrice}`);
      await closeTrade(trade, 'STOP_LOSS', ctx, stopLossPrice);
      continue;
    }

    if (observation.observedHigh >= trade.takeProfit2) {
      // v3: Runner Extension — Grade A(full) / Grade B(50% partial) runner 분기
      const runnerResult = shouldActivateRunner(trade, ctx);
      if (runnerResult.activate && !runnerStateMap.has(trade.id)) {
        if (runnerResult.sizeMultiplier >= 1.0 && currentPrice >= trade.takeProfit2) {
          // Grade A: 전량 trailing-only
          runnerStateMap.set(trade.id, true);
          const newStopLoss = trade.takeProfit1;
          await ctx.tradeStore.updateHighWaterMark(trade.id, currentPrice);
          trade.highWaterMark = currentPrice;
          trade.stopLoss = newStopLoss;
          trade.trailingStop = trade.trailingStop ?? currentPrice * 0.9;
          await updatePositionsForPair(ctx, trade.pairAddress, 'MONITORING', {
            stopLoss: newStopLoss,
          });
          log.info(
            `Runner activated (Grade A) for trade ${trade.id}: SL→${newStopLoss.toFixed(8)}, ` +
            `trailing-only from ${currentPrice.toFixed(8)}`
          );
          await ctx.notifier.sendTradeAlert(
            `Runner activated (A): ${trade.strategy} ${trade.id}, trailing from TP2`
          );
          continue;
        }
        if (runnerResult.sizeMultiplier < 1.0) {
          // Grade B: 50% TP2 매도 + 50% trailing (TP1 partial 패턴)
          await handleRunnerGradeBPartial(trade, currentPrice, ctx);
          continue;
        }
      }
      const takeProfit2Price = currentPrice >= trade.takeProfit2 ? currentPrice : trade.takeProfit2;
      log.info(`Take profit 2 triggered for trade ${trade.id} at ${takeProfit2Price}`);
      await closeTrade(trade, 'TAKE_PROFIT_2', ctx, takeProfit2Price);
      continue;
    }

    if (observation.observedHigh >= trade.takeProfit1) {
      const takeProfit1Price = currentPrice >= trade.takeProfit1 ? currentPrice : trade.takeProfit1;
      log.info(`Take profit 1 triggered for trade ${trade.id} at ${takeProfit1Price}`);
      await handleTakeProfit1Partial(trade, takeProfit1Price, ctx);
      continue;
    }

    // Exhaustion Exit — 최소 10분(2봉) 보유 후 적용
    // Why: 진입 봉(volume spike)→직후 1봉은 자연스럽게 volume/body 감소. 1봉 exhaustion 오탐만 스킵
    const minExhaustionMs = 10 * 60 * 1000;
    const holdDuration = Date.now() - trade.createdAt.getTime();
    if (holdDuration >= minExhaustionMs && recentCandles.length >= 2) {
      const { exhausted, indicators } = checkExhaustion(recentCandles, config.exhaustionThreshold);
      if (exhausted && currentPrice > trade.entryPrice) {
        log.info(`Exhaustion exit for trade ${trade.id}: ${indicators.join(', ')}`);
        await closeTrade(trade, 'EXHAUSTION', ctx, currentPrice);
        continue;
      }
    }

    if (trade.trailingStop && recentCandles.length >= 8) {
      // v5: trailingAfterTp1Only=true이면 TP1 이후에만 trailing 활성화
      // TP1 후 잔여 trade는 SL이 entryPrice 이상으로 올라감 → tp1Hit 근사 판별
      const tp1Hit = trade.stopLoss >= trade.entryPrice;
      if (config.trailingAfterTp1Only && !tp1Hit) continue;

      // Why: backtest와 동일하게 최소 2봉 보유 후 trailing 활성화
      const minTrailingHoldMs = config.defaultTimeframe * 1000 * 2;
      const trailingHoldDuration = Date.now() - trade.createdAt.getTime();
      if (trailingHoldDuration < minTrailingHoldMs) continue;

      const atr = calcATR(recentCandles, 7);
      const adaptiveStop = calcAdaptiveTrailingStop(
        recentCandles,
        atr,
        trade.entryPrice,
        observation.peakPrice,
        trade.stopLoss,
        tp1Hit
      );

      if (observation.observedLow <= adaptiveStop && observation.observedLow > trade.stopLoss) {
        const trailingPrice = currentPrice <= adaptiveStop ? currentPrice : adaptiveStop;
        log.info(`Adaptive trailing stop triggered for trade ${trade.id} at ${trailingPrice}`);
        await closeTrade(trade, 'TRAILING_STOP', ctx, trailingPrice);
      }
    }
  }
}

export async function syncTradingHalts(
  ctx: BotContext,
  portfolio: Awaited<ReturnType<RiskManager['getPortfolioState']>>
): Promise<void> {
  const activeHalt = ctx.riskManager.getActiveHalt(portfolio);

  if (!activeHalt && ctx.tradingHaltedReason) {
    log.info(`Trading resumed: ${ctx.tradingHaltedReason}`);
    await ctx.notifier.sendInfo('Trading resumed — risk halt cleared', 'risk');
    ctx.tradingHaltedReason = undefined;
    return;
  }

  if (!activeHalt || ctx.tradingHaltedReason === activeHalt.reason) {
    return;
  }

  ctx.tradingHaltedReason = activeHalt.reason;
  log.error(activeHalt.reason);
  await ctx.notifier.sendCritical(
    activeHalt.kind === 'drawdown' ? 'Drawdown Guard' : 'Daily Loss',
    activeHalt.reason
  );
}

export async function closeTrade(
  trade: Trade,
  reason: CloseReason,
  ctx: BotContext,
  paperExitPrice?: number
): Promise<void> {
  try {
    let txSignature: string | undefined;
    let exitPrice = paperExitPrice ?? trade.entryPrice;
    let executionSlippage = 0;
    // 2026-04-07: fake-fill/slippage saturation 감지 시 사유를 collected — closeTrade DB에 기록
    let fakeFillAnomalyReason: string | undefined;

    if (ctx.tradingMode === 'paper') {
      txSignature = 'PAPER_TRADE';
    } else {
      await updatePositionsForPair(ctx, trade.pairAddress, 'EXIT_TRIGGERED', { exitReason: reason });
      const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);

      if (tokenBalance > 0n) {
        const solBefore = await ctx.executor.getBalance();
        const sellResult = await ctx.executor.executeSell(trade.pairAddress, tokenBalance);
        txSignature = sellResult.txSignature;

        const solAfter = await ctx.executor.getBalance();
        const receivedSol = solAfter - solBefore;

        const resolved = resolveExitFillOrFakeFill({
          tradeId: trade.id,
          exitPath: 'closeTrade',
          receivedSol,
          soldQuantity: trade.quantity,
          slippageBps: sellResult.slippageBps,
          fallbackPrice: exitPrice, // paperExitPrice(decisionPrice) ?? entryPrice
        });
        exitPrice = resolved.exitPrice;
        executionSlippage = resolved.executionSlippage;
        fakeFillAnomalyReason = resolved.anomalyReason;

        log.info(
          `Sell executed: received=${receivedSol.toFixed(6)} SOL, ` +
          `exitPrice=${exitPrice.toFixed(8)}, slippage=${sellResult.slippageBps}bps`
        );
      } else {
        log.warn(`No token balance for trade ${trade.id} — closing with entry price`);
      }
    }

    // Why: paperExitPrice = decision price (trigger 판정가), exitPrice = 실제 fill 가격
    const decisionPrice = paperExitPrice;
    const pnl = (exitPrice - trade.entryPrice) * trade.quantity;
    const exitSlippageBps = ctx.tradingMode === 'live' ? decimalToBps(executionSlippage) : undefined;
    applyPaperExitProceeds(ctx, trade.quantity, exitPrice);

    // Phase A4: exitPrice/entryPrice 단위 정합성 cross-check.
    // ratio < -95% 또는 > +1000%면 단위 오염 또는 fill 이상 → loud error + anomaly 플래그.
    let exitAnomaly = false;
    let exitAnomalyReasons: string[] = [];
    if (trade.entryPrice > 0 && exitPrice > 0) {
      const ratio = (exitPrice - trade.entryPrice) / trade.entryPrice;
      if (ratio < EXIT_RATIO_MIN || ratio > EXIT_RATIO_MAX) {
        exitAnomaly = true;
        exitAnomalyReasons.push(`exit_ratio=${ratio.toFixed(4)}`);
        log.error(
          `[EXIT_ANOMALY] Trade ${trade.id} exit ratio ${ratio.toFixed(4)} outside ` +
          `[${EXIT_RATIO_MIN}, ${EXIT_RATIO_MAX}]: entry=${trade.entryPrice.toFixed(8)} ` +
          `exit=${exitPrice.toFixed(8)} pair=${trade.pairAddress} reason=${reason}`
        );
      }
    }

    if (decisionPrice != null && decisionPrice > 0 && exitPrice > 0) {
      const gapPct = ((exitPrice - decisionPrice) / decisionPrice) * 100;
      const gapAbs = Math.abs((exitPrice - decisionPrice) / decisionPrice);
      const baseLog =
        `Close trade ${trade.id}: reason=${reason} decision=${decisionPrice.toFixed(8)} ` +
        `fill=${exitPrice.toFixed(8)} gap=${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}%`;
      if (gapAbs >= DECISION_FILL_GAP_ALERT_PCT) {
        exitAnomaly = true;
        exitAnomalyReasons.push(`decision_fill_gap=${gapPct.toFixed(2)}%`);
        log.error(`[EXIT_ANOMALY] ${baseLog}`);
      } else {
        log.info(baseLog);
      }
    }

    // 2026-04-07 Phase A4 보강 — saturated slippage는 정상 ratio/gap bound 안에도 존재할 수 있다.
    // P0 fake-fill helper와 동일 임계(9000bps) 사용. live 모드에만 의미가 있다.
    if (ctx.tradingMode === 'live') {
      const slippageBpsCheck = decimalToBps(executionSlippage);
      if (slippageBpsCheck >= SLIPPAGE_SATURATED_BPS) {
        exitAnomaly = true;
        exitAnomalyReasons.push(`slippage_saturated=${slippageBpsCheck}bps`);
        log.error(
          `[EXIT_ANOMALY] Trade ${trade.id} slippage saturated: ${slippageBpsCheck}bps ` +
          `(likely fake fill — verify Jupiter Ultra outputAmountResult)`
        );
      }
    }

    if (exitAnomaly) {
      // best-effort: 메시지 상단에 [ANOMALY] 표식이 찍히도록 notifier에 추가 컨텍스트.
      // 실제 formatter 수정은 별도 작업 — 우선 log + sendError로 Critical 알림.
      const anomalyMsg =
        `[EXIT_ANOMALY] trade=${trade.id} pair=${trade.pairAddress} reason=${reason} ` +
        `entry=${trade.entryPrice.toFixed(8)} exit=${exitPrice.toFixed(8)} ` +
        `decision=${decisionPrice ?? 'n/a'} pnl=${pnl.toFixed(6)} SOL ` +
        `reasons=[${exitAnomalyReasons.join(', ')}]`;
      await ctx.notifier.sendCritical('exit_anomaly', anomalyMsg).catch(() => {});
    }

    // P0 fake-fill reason + P3 Phase A4 reasons → 동일 컬럼(exit_anomaly_reason)에 병합
    const mergedAnomalyReason = mergeAnomalyReasons(fakeFillAnomalyReason, exitAnomalyReasons);

    await ctx.tradeStore.closeTrade({
      id: trade.id,
      exitPrice,
      pnl,
      slippage: executionSlippage,
      exitReason: reason,
      exitSlippageBps,
      decisionPrice,
      exitAnomalyReason: mergedAnomalyReason,
    });

    const closedTrade = {
      ...trade,
      exitPrice,
      decisionPrice,
      exitSlippageBps,
      pnl,
      slippage: executionSlippage,
      txSignature,
      status: 'CLOSED' as const,
      exitReason: reason,
      exitAnomalyReason: mergedAnomalyReason,
    };
    await ctx.notifier.sendTradeClose(closedTrade);
    await updatePositionsForPair(ctx, trade.pairAddress, 'EXIT_CONFIRMED', {
      txExit: txSignature,
      exitReason: reason,
      pnl,
    });

    // Phase 1B: Record paper metrics exit
    if (ctx.paperMetrics) {
      ctx.paperMetrics.recordExit(trade.id, exitPrice, reason);
    }

    // Phase 3: WalletManager PnL 기록 (H-01)
    if (ctx.walletManager) {
      const walletName = trade.strategy === 'new_lp_sniper' ? 'sandbox' : 'main';
      ctx.walletManager.recordPnl(walletName, pnl);
    }

    // M-2 fix: state map cleanup (메모리 누수 방지)
    degradedStateMap.delete(trade.id);
    quoteFailCountMap.delete(trade.id);
    runnerStateMap.delete(trade.id);

    ctx.healthMonitor.updateTradeTime();
    log.info(`Trade ${trade.id} closed (${reason}). PnL: ${pnl.toFixed(6)} SOL, exitSlipBps=${exitSlippageBps ?? 'paper'}`);
  } catch (error) {
    log.error(`Failed to close trade ${trade.id}: ${error}`);
    await ctx.tradeStore.failTrade(trade.id, `Close failed: ${error}`);
    await ctx.notifier.sendError('trade_close', error).catch(() => {});
  }
}

export async function recordOpenedTrade(
  ctx: BotContext,
  positionId: string,
  signal: Signal,
  lastCandle: Candle,
  gateResult: GateEvaluationResult,
  order: Order,
  totalScore: number,
  sizeConstraint: Trade['sizeConstraint'],
  txSignature: string,
  executionSummary: EntryExecutionSummary,
  postSizeExecution?: GateEvaluationResult['executionViability']
): Promise<void> {
  // Phase A3: alignment 적용 전 ratio clamp 검증. 위반 시 DB write 금지 + 토큰 긴급 청산.
  await assertEntryAlignmentSafe(ctx, order, executionSummary, signal, positionId);

  const openedOrder = alignOrderToExecutedEntry({
    ...order,
    price: executionSummary.entryPrice,
    quantity: executionSummary.quantity,
  }, executionSummary);
  logOpenedOrderAlignment(signal, order, openedOrder, executionSummary);
  await ctx.positionStore.updateState(positionId, 'ENTRY_CONFIRMED', {
    signalData: {
      execution: {
        plannedEntryPrice: executionSummary.plannedEntryPrice,
        plannedQuantity: executionSummary.plannedQuantity,
        actualEntryNotionalSol: executionSummary.actualEntryNotionalSol,
        entryPrice: executionSummary.entryPrice,
        quantity: executionSummary.quantity,
        entrySlippageBps: executionSummary.entrySlippageBps,
        entrySlippagePct: executionSummary.entrySlippagePct,
        expectedInAmount: executionSummary.expectedInAmount,
        actualInputAmount: executionSummary.actualInputAmount,
        actualInputUiAmount: executionSummary.actualInputUiAmount,
        inputDecimals: executionSummary.inputDecimals,
        expectedOutAmount: executionSummary.expectedOutAmount,
        actualOutAmount: executionSummary.actualOutAmount,
        outputDecimals: executionSummary.outputDecimals,
        effectiveRR: executionSummary.effectiveRR,
        roundTripCost: executionSummary.roundTripCost,
      },
    },
    entryPrice: openedOrder.price,
    quantity: openedOrder.quantity,
    stopLoss: openedOrder.stopLoss,
    takeProfit1: openedOrder.takeProfit1,
    takeProfit2: openedOrder.takeProfit2,
    trailingStop: openedOrder.trailingStop,
    txEntry: txSignature,
  });

  const timeStopAt = new Date(Date.now() + openedOrder.timeStopMinutes * 60 * 1000);
  const tradeId = await ctx.tradeStore.insertTrade({
    pairAddress: openedOrder.pairAddress,
    strategy: openedOrder.strategy,
    side: openedOrder.side,
    tokenSymbol: openedOrder.tokenSymbol,
    sourceLabel: signal.sourceLabel,
    discoverySource: signal.discoverySource,
    entryPrice: openedOrder.price,
    plannedEntryPrice: executionSummary.plannedEntryPrice,
    quantity: openedOrder.quantity,
    stopLoss: openedOrder.stopLoss,
    takeProfit1: openedOrder.takeProfit1,
    takeProfit2: openedOrder.takeProfit2,
    trailingStop: openedOrder.trailingStop,
    highWaterMark: openedOrder.price,
    timeStopAt,
    status: 'OPEN',
    txSignature,
    createdAt: new Date(),
    breakoutScore: totalScore,
    breakoutGrade: order.breakoutGrade,
    sizeConstraint,
    entrySlippageBps: executionSummary.entrySlippageBps,
    entryPriceImpactPct: postSizeExecution?.entryPriceImpactPct,
    roundTripCostPct: executionSummary.roundTripCost,
    effectiveRR: executionSummary.effectiveRR,
  });

  await ctx.positionStore.updateState(positionId, 'MONITORING');
  ctx.healthMonitor.updateTradeTime();
  await ctx.notifier.sendTradeOpen({
    ...openedOrder,
    tradeId,
    plannedEntryPrice: executionSummary.plannedEntryPrice,
  }, txSignature);
  await ctx.auditLogger.logSignal({
    ...buildSignalAuditBase(signal, lastCandle, gateResult, postSizeExecution),
    action: 'EXECUTED',
    positionSize: executionSummary.quantity,
    sizeConstraint,
    effectiveRR: executionSummary.effectiveRR,
    roundTripCost: executionSummary.roundTripCost,
  });
}

/**
 * Phase A3 — ratio clamp.
 * actualEntryPrice/plannedEntryPrice가 [0.7, 1.3] 바깥이면:
 *   1) loud log.error
 *   2) live 모드 + 실제 raw 수량이 있으면 보유 토큰 긴급 청산 시도 (best-effort)
 *   3) notifier.sendCritical 알림
 *   4) PriceAnomalyError throw → signalProcessor 상위 catch가 ORDER_FAILED 전이 처리
 *
 * 이 함수는 어떠한 DB write도 일어나기 전에 호출되어야 한다.
 */
async function assertEntryAlignmentSafe(
  ctx: BotContext,
  order: Order,
  executionSummary: EntryExecutionSummary,
  signal: Signal,
  positionId: string
): Promise<void> {
  const plannedEntryPrice = executionSummary.plannedEntryPrice;
  const actualEntryPrice = executionSummary.entryPrice;

  if (
    !Number.isFinite(plannedEntryPrice) || plannedEntryPrice <= 0 ||
    !Number.isFinite(actualEntryPrice) || actualEntryPrice <= 0
  ) {
    // 유효하지 않은 가격이면 alignment 자체를 적용 못 함 → 보수적으로 차단.
    const msg =
      `[PRICE_ANOMALY_BLOCK] Invalid entry prices for ${order.pairAddress}: ` +
      `planned=${plannedEntryPrice} actual=${actualEntryPrice}`;
    log.error(msg);
    await emergencyDumpPosition(ctx, order, executionSummary, msg);
    await ctx.notifier.sendCritical('price_anomaly', msg).catch(() => {});
    throw new PriceAnomalyError(msg, { positionId, pair: order.pairAddress });
  }

  const ratio = actualEntryPrice / plannedEntryPrice;
  if (ratio < ENTRY_ALIGN_RATIO_MIN || ratio > ENTRY_ALIGN_RATIO_MAX) {
    const msg =
      `[PRICE_ANOMALY_BLOCK] Entry ratio ${ratio.toFixed(6)} outside ` +
      `[${ENTRY_ALIGN_RATIO_MIN}, ${ENTRY_ALIGN_RATIO_MAX}] — refusing to open trade: ` +
      `pair=${order.pairAddress} strategy=${signal.strategy} ` +
      `planned=${plannedEntryPrice.toFixed(8)} actual=${actualEntryPrice.toFixed(8)} ` +
      `actualInputUiAmount=${executionSummary.actualInputUiAmount ?? 'n/a'} ` +
      `outputDecimals=${executionSummary.outputDecimals ?? 'n/a'}`;
    log.error(msg);
    await emergencyDumpPosition(ctx, order, executionSummary, msg);
    await ctx.notifier.sendCritical('price_anomaly', msg).catch(() => {});
    throw new PriceAnomalyError(msg, {
      positionId,
      pair: order.pairAddress,
      ratio,
      plannedEntryPrice,
      actualEntryPrice,
    });
  }
}

/**
 * Phase A3 — 이상 감지 직후 live 모드면 보유 토큰을 즉시 SOL로 청산.
 * paper 모드면 no-op. best-effort이며 실패해도 throw는 위에서 수행.
 *
 * Why (on-chain balance 우선): buy tx 직후 race condition/RPC lag 상황에서
 * executionSummary.actualOutAmount가 실제 지갑 잔액과 어긋날 수 있다.
 * closeTrade와 동일하게 getTokenBalance를 1차로 쓰고, 실패 시에만 summary 값을 fallback.
 */
async function emergencyDumpPosition(
  ctx: BotContext,
  order: Order,
  executionSummary: EntryExecutionSummary,
  reason: string
): Promise<void> {
  if (ctx.tradingMode !== 'live') return;

  let amountRaw = 0n;
  let source: 'onchain' | 'summary' = 'onchain';

  try {
    amountRaw = await ctx.executor.getTokenBalance(order.pairAddress);
  } catch (balanceError) {
    log.warn(
      `[PRICE_ANOMALY_DUMP] getTokenBalance failed for ${order.pairAddress}: ${balanceError} ` +
      `— falling back to executionSummary.actualOutAmount`
    );
  }

  if (amountRaw <= 0n) {
    const rawOut = executionSummary.actualOutAmount;
    if (rawOut != null) {
      try {
        amountRaw = BigInt(rawOut);
        source = 'summary';
      } catch {
        log.warn(`[PRICE_ANOMALY_DUMP] actualOutAmount not a valid bigint (${rawOut}) — skipping dump`);
        return;
      }
    }
  }

  if (amountRaw <= 0n) {
    log.warn(
      `[PRICE_ANOMALY_DUMP] No dumpable balance for ${order.pairAddress} ` +
      `(on-chain=0, summary=${executionSummary.actualOutAmount ?? 'null'}) — skipping dump`
    );
    return;
  }

  try {
    log.error(
      `[PRICE_ANOMALY_DUMP] Attempting emergency sell of ${amountRaw} raw units ` +
      `(source=${source}) for ${order.pairAddress} — ${reason}`
    );
    const sellResult = await ctx.executor.executeSell(order.pairAddress, amountRaw);
    log.error(`[PRICE_ANOMALY_DUMP] Emergency dump complete: sig=${sellResult.txSignature}`);
  } catch (dumpError) {
    log.error(
      `[PRICE_ANOMALY_DUMP] Emergency dump FAILED for ${order.pairAddress}: ${dumpError}. ` +
      `Manual intervention required to liquidate position.`
    );
    // 실패하더라도 위쪽에서 throw가 일어나 trade 기록은 막힌다 — 단 토큰은 지갑에 남는다.
  }
}

function alignOrderToExecutedEntry(order: Order, executionSummary: EntryExecutionSummary): Order {
  const plannedEntryPrice = executionSummary.plannedEntryPrice;
  const actualEntryPrice = executionSummary.entryPrice;

  if (
    !Number.isFinite(plannedEntryPrice) || plannedEntryPrice <= 0 ||
    !Number.isFinite(actualEntryPrice) || actualEntryPrice <= 0
  ) {
    return order;
  }

  return {
    ...order,
    stopLoss: scaleExecutionLevel(order.stopLoss, plannedEntryPrice, actualEntryPrice),
    takeProfit1: scaleExecutionLevel(order.takeProfit1, plannedEntryPrice, actualEntryPrice),
    takeProfit2: scaleExecutionLevel(order.takeProfit2, plannedEntryPrice, actualEntryPrice),
    trailingStop: order.trailingStop != null && Number.isFinite(order.trailingStop)
      ? order.trailingStop * (actualEntryPrice / plannedEntryPrice)
      : order.trailingStop,
  };
}

function scaleExecutionLevel(
  plannedLevel: number,
  plannedEntryPrice: number,
  actualEntryPrice: number
): number {
  if (!Number.isFinite(plannedLevel) || plannedLevel <= 0) return plannedLevel;
  const levelOffsetPct = (plannedLevel - plannedEntryPrice) / plannedEntryPrice;
  return actualEntryPrice * (1 + levelOffsetPct);
}

function logOpenedOrderAlignment(
  signal: Signal,
  plannedOrder: Order,
  openedOrder: Order,
  executionSummary: EntryExecutionSummary
): void {
  const stopOffsetPct = executionSummary.entryPrice > 0
    ? ((openedOrder.stopLoss - executionSummary.entryPrice) / executionSummary.entryPrice) * 100
    : 0;
  const tp1OffsetPct = executionSummary.entryPrice > 0
    ? ((openedOrder.takeProfit1 - executionSummary.entryPrice) / executionSummary.entryPrice) * 100
    : 0;
  const tp2OffsetPct = executionSummary.entryPrice > 0
    ? ((openedOrder.takeProfit2 - executionSummary.entryPrice) / executionSummary.entryPrice) * 100
    : 0;
  const message =
    `Opened order aligned to fill: pair=${signal.pairAddress} source=${signal.sourceLabel ?? 'unknown'} ` +
    `plannedEntry=${plannedOrder.price.toFixed(8)} actualEntry=${openedOrder.price.toFixed(8)} ` +
    `stop=${openedOrder.stopLoss.toFixed(8)} (${stopOffsetPct.toFixed(2)}%) ` +
    `tp1=${openedOrder.takeProfit1.toFixed(8)} (+${tp1OffsetPct.toFixed(2)}%) ` +
    `tp2=${openedOrder.takeProfit2.toFixed(8)} (+${tp2OffsetPct.toFixed(2)}%)`;
  if (Math.abs(executionSummary.entrySlippagePct) >= 0.2) {
    log.warn(message);
    return;
  }
  log.info(message);
}

export function buildSignalAuditBase(
  signal: Signal,
  candle: Candle,
  gateResult: GateEvaluationResult,
  postSizeExecution?: GateEvaluationResult['executionViability']
) {
  const persistedExecution = postSizeExecution ?? gateResult.executionViability;
  return {
    pairAddress: signal.pairAddress,
    strategy: signal.strategy,
    sourceLabel: signal.sourceLabel,
    discoverySource: signal.discoverySource,
    attentionScore: gateResult.attentionScore?.attentionScore,
    attentionConfidence: gateResult.attentionScore?.confidence,
    ...signal.breakoutScore!,
    candleClose: signal.price,
    volume: candle.volume,
    buyVolume: candle.buyVolume,
    sellVolume: candle.sellVolume,
    poolTvl: signal.poolTvl || 0,
    spreadPct: signal.spreadPct,
    effectiveRR: persistedExecution.effectiveRR,
    roundTripCost: persistedExecution.roundTripCost,
    gateTrace: buildGateTraceSnapshot(gateResult, { postSizeExecution }),
  };
}

async function handleTakeProfit1Partial(
  trade: Trade,
  currentPrice: number,
  ctx: BotContext
): Promise<void> {
  try {
    // v5: TP1 부분 청산 비율 — config.tp1PartialPct (기존 0.5 → 0.3)
    const tp1PartialPct = config.tp1PartialPct;
    const soldQuantity = trade.quantity * tp1PartialPct;
    const remainingQuantity = trade.quantity - soldQuantity;

    if (remainingQuantity <= 0 || soldQuantity <= 0) {
      log.warn(`Invalid TP1 split for trade ${trade.id}; closing full position instead`);
      await closeTrade(trade, 'TAKE_PROFIT_1', ctx, currentPrice);
      return;
    }

    let exitPrice = currentPrice;
    let executionSlippage = 0;
    let tp1AnomalyReason: string | undefined;

    if (ctx.tradingMode === 'live') {
      const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);
      const partialTokenAmount = BigInt(Math.floor(Number(tokenBalance) * tp1PartialPct));

      if (partialTokenAmount <= 0n || trade.quantity <= 0) {
        log.warn(`Partial TP1 unavailable for trade ${trade.id}; closing full position instead`);
        await closeTrade(trade, 'TAKE_PROFIT_1', ctx, currentPrice);
        return;
      }

      const solBefore = await ctx.executor.getBalance();
      const sellResult = await ctx.executor.executeSell(trade.pairAddress, partialTokenAmount);
      const solAfter = await ctx.executor.getBalance();
      const receivedSol = solAfter - solBefore;

      const resolved = resolveExitFillOrFakeFill({
        tradeId: trade.id,
        exitPath: 'tp1_partial',
        receivedSol,
        soldQuantity,
        slippageBps: sellResult.slippageBps,
        fallbackPrice: currentPrice,
      });
      exitPrice = resolved.exitPrice;
      executionSlippage = resolved.executionSlippage;
      tp1AnomalyReason = resolved.anomalyReason;
    }

    const realizedPnl = (exitPrice - trade.entryPrice) * soldQuantity;
    const tp1ExitSlippageBps = ctx.tradingMode === 'live' ? decimalToBps(executionSlippage) : undefined;
    applyPaperExitProceeds(ctx, soldQuantity, exitPrice);

    await ctx.tradeStore.closeTrade({
      id: trade.id,
      exitPrice,
      pnl: realizedPnl,
      slippage: executionSlippage,
      exitReason: 'TAKE_PROFIT_1',
      quantity: soldQuantity,
      exitSlippageBps: tp1ExitSlippageBps,
      decisionPrice: currentPrice, // TP1 trigger price
      exitAnomalyReason: tp1AnomalyReason,
    });

    // v3: TP1 후 잔여 trade에 time stop 연장 — Runner 활성화 시간 확보
    const extendedTimeStopAt = new Date(Date.now() + config.tp1TimeExtensionMinutes * 60_000);

    const remainingTrade: Omit<Trade, 'id'> = {
      ...trade,
      quantity: remainingQuantity,
      parentTradeId: trade.id,
      stopLoss: trade.entryPrice,
      takeProfit1: trade.takeProfit2,
      takeProfit2: trade.takeProfit2,
      highWaterMark: Math.max(trade.highWaterMark ?? trade.entryPrice, currentPrice),
      timeStopAt: extendedTimeStopAt,
      status: 'OPEN',
      createdAt: new Date(),
      closedAt: undefined,
      exitPrice: undefined,
      pnl: undefined,
      slippage: undefined,
      exitReason: undefined,
    };

    await ctx.tradeStore.insertTrade(remainingTrade);

    const partialTrade: Trade = {
      ...trade,
      quantity: soldQuantity,
      exitPrice,
      decisionPrice: currentPrice,
      exitSlippageBps: tp1ExitSlippageBps,
      pnl: realizedPnl,
      slippage: executionSlippage,
      status: 'CLOSED',
      exitReason: 'TAKE_PROFIT_1',
      closedAt: new Date(),
    };
    await ctx.notifier.sendTradeClose(partialTrade);
    await ctx.notifier.sendTradeAlert(
      `TP1 partial exit: ${trade.strategy} remaining ${formatTokenQuantity(remainingQuantity, trade.tokenSymbol)}, ` +
      `SL moved to breakeven ${trade.entryPrice.toFixed(8)}`
    );

    await updatePositionsForPair(ctx, trade.pairAddress, 'MONITORING', {
      quantity: remainingQuantity,
      stopLoss: trade.entryPrice,
      takeProfit1: trade.takeProfit2,
      takeProfit2: trade.takeProfit2,
      trailingStop: trade.trailingStop,
    });

    ctx.healthMonitor.updateTradeTime();
    log.info(
      `Trade ${trade.id} partially closed at TP1. Realized=${realizedPnl.toFixed(6)} SOL, ` +
      `remaining=${remainingQuantity.toFixed(6)}`
    );
  } catch (error) {
    log.error(`Failed to partially close trade ${trade.id}: ${error}`);
    await ctx.notifier.sendError('trade_partial_close', error).catch(() => {});
  }
}

/**
 * v3: Grade B Runner — 50% TP2 매도 + 50% trailing-only
 * TP1 partial 패턴과 동일하게 부분 청산 + 잔여 trade 생성
 */
async function handleRunnerGradeBPartial(
  trade: Trade,
  currentPrice: number,
  ctx: BotContext
): Promise<void> {
  try {
    const soldQuantity = trade.quantity * 0.5;
    const remainingQuantity = trade.quantity - soldQuantity;

    if (remainingQuantity <= 0 || soldQuantity <= 0) {
      log.warn(`Invalid Grade B runner split for trade ${trade.id}; closing full at TP2`);
      await closeTrade(trade, 'TAKE_PROFIT_2', ctx, currentPrice);
      return;
    }

    let exitPrice = currentPrice;
    let executionSlippage = 0;
    let runnerBAnomalyReason: string | undefined;

    if (ctx.tradingMode === 'live') {
      const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);
      const partialTokenAmount = tokenBalance / 2n;

      if (partialTokenAmount <= 0n) {
        log.warn(`Grade B runner partial unavailable for trade ${trade.id}; closing full at TP2`);
        await closeTrade(trade, 'TAKE_PROFIT_2', ctx, currentPrice);
        return;
      }

      const solBefore = await ctx.executor.getBalance();
      const sellResult = await ctx.executor.executeSell(trade.pairAddress, partialTokenAmount);
      const solAfter = await ctx.executor.getBalance();
      const receivedSol = solAfter - solBefore;

      const resolved = resolveExitFillOrFakeFill({
        tradeId: trade.id,
        exitPath: 'runner_b_partial',
        receivedSol,
        soldQuantity,
        slippageBps: sellResult.slippageBps,
        fallbackPrice: currentPrice,
      });
      exitPrice = resolved.exitPrice;
      executionSlippage = resolved.executionSlippage;
      runnerBAnomalyReason = resolved.anomalyReason;
    }

    const realizedPnl = (exitPrice - trade.entryPrice) * soldQuantity;
    const tp2ExitSlippageBps = ctx.tradingMode === 'live' ? decimalToBps(executionSlippage) : undefined;
    applyPaperExitProceeds(ctx, soldQuantity, exitPrice);
    await ctx.tradeStore.closeTrade({
      id: trade.id,
      exitPrice,
      pnl: realizedPnl,
      slippage: executionSlippage,
      exitReason: 'TAKE_PROFIT_2',
      quantity: soldQuantity,
      exitSlippageBps: tp2ExitSlippageBps,
      decisionPrice: currentPrice, // TP2 trigger price
      exitAnomalyReason: runnerBAnomalyReason,
    });

    // 원본 trade state map 정리 (closeTrade 경유하지 않으므로 수동 정리)
    degradedStateMap.delete(trade.id);
    quoteFailCountMap.delete(trade.id);
    runnerStateMap.delete(trade.id);

    // 잔여분: trailing-only runner로 전환
    const newStopLoss = trade.takeProfit1;
    const extendedTimeStopAt = new Date(Date.now() + config.tp1TimeExtensionMinutes * 60_000);

    const remainingTrade: Omit<Trade, 'id'> = {
      ...trade,
      quantity: remainingQuantity,
      parentTradeId: trade.id,
      stopLoss: newStopLoss,
      takeProfit1: trade.takeProfit2,
      takeProfit2: trade.takeProfit2 * 2, // Grade B runner: 상향된 TP2
      highWaterMark: Math.max(trade.highWaterMark ?? trade.entryPrice, currentPrice),
      trailingStop: trade.trailingStop ?? currentPrice * 0.9,
      timeStopAt: extendedTimeStopAt,
      status: 'OPEN',
      createdAt: new Date(),
      closedAt: undefined,
      exitPrice: undefined,
      pnl: undefined,
      slippage: undefined,
      exitReason: undefined,
    };
    const insertedId = await ctx.tradeStore.insertTrade(remainingTrade);

    // 잔여분을 runner로 등록
    if (insertedId) {
      runnerStateMap.set(insertedId, true);
    }

    const partialTrade: Trade = {
      ...trade,
      quantity: soldQuantity,
      exitPrice,
      decisionPrice: currentPrice,
      exitSlippageBps: tp2ExitSlippageBps,
      pnl: realizedPnl,
      slippage: executionSlippage,
      status: 'CLOSED',
      exitReason: 'TAKE_PROFIT_2',
      closedAt: new Date(),
    };
    await ctx.notifier.sendTradeClose(partialTrade);

    // Phase 1B: Paper metrics (closeTrade 우회하므로 수동 기록)
    if (ctx.paperMetrics) {
      ctx.paperMetrics.recordExit(trade.id, exitPrice, 'TAKE_PROFIT_2');
    }
    // Phase 3: WalletManager PnL 기록
    if (ctx.walletManager) {
      const walletName = trade.strategy === 'new_lp_sniper' ? 'sandbox' : 'main';
      ctx.walletManager.recordPnl(walletName, realizedPnl);
    }

    await ctx.notifier.sendTradeAlert(
      `Runner activated (B, 0.5x): ${trade.strategy} ${trade.id}, ` +
      `sold 50% at TP2, remaining ${formatTokenQuantity(remainingQuantity, trade.tokenSymbol)} trailing`
    );

    await updatePositionsForPair(ctx, trade.pairAddress, 'MONITORING', {
      quantity: remainingQuantity,
      stopLoss: newStopLoss,
      trailingStop: trade.trailingStop,
    });

    ctx.healthMonitor.updateTradeTime();
    log.info(
      `Grade B runner: trade ${trade.id} partial TP2. Realized=${realizedPnl.toFixed(6)} SOL, ` +
      `remaining=${remainingQuantity.toFixed(6)} trailing from ${currentPrice.toFixed(8)}`
    );
  } catch (error) {
    log.error(`Failed Grade B runner partial for trade ${trade.id}: ${error}`);
    await ctx.notifier.sendError('runner_grade_b_partial', error).catch(() => {});
  }
}

async function updatePositionsForPair(
  ctx: BotContext,
  pairAddress: string,
  state: Parameters<PositionStore['updateState']>[1],
  updates: Parameters<PositionStore['updateState']>[2] = {}
): Promise<void> {
  const openPositions = await ctx.positionStore.getOpenPositions();
  for (const pos of openPositions) {
    if (pos.pairAddress === pairAddress) {
      await ctx.positionStore.updateState(pos.id, state, updates);
    }
  }
}
