/**
 * Cupsey-Inspired Lane Handler (Path A — 2026-04-11)
 *
 * Why: bootstrap_10s trigger 의 entry timing 이 lagging (spike 꼭대기 매수) 이므로,
 * post-entry 30-45초 판정으로 winner/loser 를 빠르게 분류한다.
 * cupsey 의 실전 패턴: 25s p50 hold + quick reject + 2-6min winner hold.
 *
 * State machine:
 *   [PROBE]  0-45s → MFE / MAE 관찰
 *   [REJECT] 즉시 매도 (작은 loss)
 *   [WINNER] trailing hold (2-5min)
 *
 * 기존 core (bootstrap_10s + Option β) 와 완전 격리.
 * sandbox wallet + fixed ticket sizing.
 */

import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { Signal, Order, Trade, CloseReason } from '../utils/types';
import { config } from '../utils/config';
import { MicroCandleBuilder } from '../realtime';
import { evaluateCupseySignalGate, CupseySignalGateConfig, CupseySignalGateResult } from '../strategy/cupseySignalGate';
import { initCusumState, updateCusum, CusumState, CusumConfig } from '../strategy/cusumDetector';
import { BotContext } from './types';
import { bpsToDecimal } from '../utils/units';

const log = createModuleLogger('CupseyLane');

// ─── Gate Log Persistence (Phase 0 measurement) ───
// Why: gate score + factors 를 JSONL 로 persist 하여 Phase 1 score-outcome 상관 분석에 사용.
// pass + reject 모두 기록. 거래 파라미터는 건드리지 않음.

let gateLogDirEnsured = false;
let executedLedgerDirEnsured = false;
const executedLedgerDedupTimestamps = new Map<string, number>();

// ─── P0-3: Integrity Halt ───
// Why: live buy tx 성공 후 insertTrade 실패 시 DB와 온체인이 어긋남 → 신규 포지션 중단.
// resetCupseyIntegrityHalt() 으로 수동 복구.
let integrityHaltActive = false;
export function resetCupseyIntegrityHalt(): void {
  integrityHaltActive = false;
  log.info('[CUPSEY_INTEGRITY_HALT] cleared by operator');
}

// ─── P1: Execution Funnel Stats ───
// Why: "왜 한 번밖에 못 샀는가"를 수치로 즉시 답할 수 있게 함.
interface CupseyFunnelStats {
  signalsReceived: number;
  gatePass: number;
  stalkCreated: number;
  stalkEntry: number;
  txSuccess: number;
  dbPersisted: number;
  notifierOpenSent: number;
  closedTrades: number;
  sessionStartAt: Date;
}
const funnelStats: CupseyFunnelStats = {
  signalsReceived: 0, gatePass: 0, stalkCreated: 0,
  stalkEntry: 0, txSuccess: 0, dbPersisted: 0,
  notifierOpenSent: 0, closedTrades: 0,
  sessionStartAt: new Date(),
};
export function getCupseyFunnelStats(): Readonly<CupseyFunnelStats> {
  return funnelStats;
}

function buildCupseyFunnelDetail(): string {
  return [
    `signals=${funnelStats.signalsReceived}`,
    `gate_pass=${funnelStats.gatePass}`,
    `stalk=${funnelStats.stalkCreated}`,
    `entry=${funnelStats.stalkEntry}`,
    `tx_ok=${funnelStats.txSuccess}`,
    `db_ok=${funnelStats.dbPersisted}`,
    `notif_ok=${funnelStats.notifierOpenSent}`,
    `closed=${funnelStats.closedTrades}`,
  ].join(' ');
}

function recordCupseyFunnelSnapshot(ctx?: BotContext): void {
  ctx?.runtimeDiagnosticsTracker?.recordCupseyFunnel(buildCupseyFunnelDetail());
}

export function logCupseyFunnelStats(): void {
  const elapsedH = ((Date.now() - funnelStats.sessionStartAt.getTime()) / 3_600_000).toFixed(1);
  log.info(
    `[CUPSEY_FUNNEL] ${elapsedH}h | ` +
    buildCupseyFunnelDetail()
  );
}

// ─── Executed-Trades Fallback Ledger (P0-2: crash-safe) ───
// Why: DB insert 실패 시 on-chain buy/sell 사실이 사라지는 것을 방지.
// executeBuy/Sell 성공 직후 append-only JSONL 기록 → DB 없이도 역추적 가능.
async function appendExecutedLedger(
  type: 'buy' | 'sell',
  entry: Record<string, unknown>
): Promise<void> {
  try {
    const txSignature = typeof entry.txSignature === 'string' ? entry.txSignature : '';
    if (txSignature) {
      const dedupeKey = `${type}:${txSignature}`;
      const nowMs = Date.now();
      const pruneBeforeMs = nowMs - 86_400_000;
      for (const [key, timestampMs] of executedLedgerDedupTimestamps) {
        if (timestampMs < pruneBeforeMs) {
          executedLedgerDedupTimestamps.delete(key);
        }
      }
      if (executedLedgerDedupTimestamps.has(dedupeKey)) {
        return;
      }
      executedLedgerDedupTimestamps.set(dedupeKey, nowMs);
    }
    const logDir = config.realtimeDataDir;
    if (!executedLedgerDirEnsured) {
      await mkdir(logDir, { recursive: true });
      executedLedgerDirEnsured = true;
    }
    await appendFile(
      path.join(logDir, `executed-${type}s.jsonl`),
      JSON.stringify({ ...entry, recordedAt: new Date().toISOString() }) + '\n',
      'utf8'
    );
  } catch {
    // Why: 파일 기록 실패는 치명적이지 않음 — 로그에서 복구 가능
  }
}

export async function appendExecutedLedgerForTests(
  type: 'buy' | 'sell',
  entry: Record<string, unknown>
): Promise<void> {
  await appendExecutedLedger(type, entry);
}

// ─── CUSUM Per-Pair State (Phase 0: observation-only) ───
const cusumStates = new Map<string, CusumState>();
const cusumLastProcessedBucketSec = new Map<string, number>();

export function getCupseyCusumState(pairAddress: string): Readonly<CusumState> | undefined {
  return cusumStates.get(pairAddress);
}

// 테스트에서 runtime singleton 상태를 초기화할 때 사용.
export function resetCupseyLaneStateForTests(): void {
  activePositions.clear();
  cusumStates.clear();
  cusumLastProcessedBucketSec.clear();
  executedLedgerDedupTimestamps.clear();
  integrityHaltActive = false;
  funnelStats.signalsReceived = 0;
  funnelStats.gatePass = 0;
  funnelStats.stalkCreated = 0;
  funnelStats.stalkEntry = 0;
  funnelStats.txSuccess = 0;
  funnelStats.dbPersisted = 0;
  funnelStats.notifierOpenSent = 0;
  funnelStats.closedTrades = 0;
  funnelStats.sessionStartAt = new Date();
}

async function persistCupseyGateLog(
  pairAddress: string,
  signalPrice: number,
  gateResult: CupseySignalGateResult,
  tokenSymbol?: string,
  cusumStrength?: number
): Promise<void> {
  try {
    const logDir = config.realtimeDataDir;
    if (!gateLogDirEnsured) {
      await mkdir(logDir, { recursive: true });
      gateLogDirEnsured = true;
    }
    const entry = {
      t: new Date().toISOString(),
      pair: pairAddress,
      sym: tokenSymbol,
      price: signalPrice,
      pass: gateResult.pass,
      score: gateResult.score,
      f: gateResult.factors,
      reason: gateResult.rejectReason ?? null,
      cusum: cusumStrength ?? null,  // Phase 0: observation-only. Phase 1 상관 분석용
    };
    await appendFile(
      path.join(logDir, 'cupsey-gate-log.jsonl'),
      JSON.stringify(entry) + '\n',
      'utf8'
    );
  } catch {
    // Why: persist 실패해도 trading path 차단하지 않음
  }
}

// ─── State Machine Types ───
//
// STALK → PROBE → WINNER → CLOSED
//                → REJECT → CLOSED
//
// STALK (신규): signal 직후 즉시 매수하지 않고 pullback 대기.
// spike 꼭대기 매수 방지. pullback 오면 entry, 안 오면 skip.

type CupseyTradeState = 'STALK' | 'PROBE' | 'WINNER' | 'REJECT' | 'CLOSED';

interface CupseyPosition {
  /** in-memory lane position id (DB trade id 아님) */
  tradeId: string;
  dbTradeId?: string;
  pairAddress: string;
  /** STALK 시: signal price (아직 미매수). PROBE/WINNER 시: actual entry price */
  entryPrice: number;
  /** signal 발화 시각 (STALK 시작) */
  signalTimeSec: number;
  /** 실제 매수 시각 (STALK → PROBE 전환 시) */
  entryTimeSec: number;
  quantity: number;
  state: CupseyTradeState;
  /** STALK 시: signal price (pullback 기준). PROBE/WINNER 시: entry 이후 peak */
  signalPrice: number;
  peakPrice: number;
  troughPrice: number;
  tokenSymbol?: string;
  sourceLabel?: string;
  discoverySource?: string;
  plannedEntryPrice?: number;
  entryTxSignature?: string;
  entrySlippageBps?: number;
  lastCloseFailureAtSec?: number;
  /**
   * Reentrancy guard for STALK → PROBE transition.
   * Why: updateCupseyPositions는 index.ts:1339에서 fire-and-forget으로 호출되므로,
   * 같은 초에 swap 이벤트가 N개 들어오면 N번 동시 실행되어 같은 STALK 포지션이
   * 각각 executeBuy → insertTrade를 수행해 DB duplicate row를 생성한다.
   * 실측: 187 unique buy_tx 중 45개(24%)가 duplicate. 이 플래그로 한 번만 진행.
   */
  enteringLock?: boolean;
}

// ─── Active Positions ───

const activePositions = new Map<string, CupseyPosition>();

export function getActiveCupseyPositions(): ReadonlyMap<string, CupseyPosition> {
  return activePositions;
}

function getCupseyExecutor(ctx: BotContext) {
  return ctx.sandboxExecutor ?? ctx.executor;
}

function inferRecoveredCupseyState(trade: Trade): CupseyTradeState {
  const highWaterMark = trade.highWaterMark ?? trade.entryPrice;
  if (
    trade.trailingStop != null ||
    highWaterMark >= trade.entryPrice * (1 + config.cupseyProbeMfeThreshold)
  ) {
    return 'WINNER';
  }
  return 'PROBE';
}

export async function recoverCupseyOpenPositions(ctx: BotContext): Promise<number> {
  if (!config.cupseyLaneEnabled) return 0;

  const openTrades = await ctx.tradeStore.getOpenTrades();
  const cupseyOpenTrades = openTrades.filter((trade) => trade.strategy === 'cupsey_flip_10s');
  let recovered = 0;

  for (const trade of cupseyOpenTrades) {
    const alreadyTracked = [...activePositions.values()].some(
      (position) =>
        position.dbTradeId === trade.id ||
        (position.pairAddress === trade.pairAddress && position.state !== 'CLOSED')
    );
    if (alreadyTracked) continue;

    const entryTimeSec = Math.floor(trade.createdAt.getTime() / 1000);
    const positionId = `cupsey-recovered-${trade.id}`; // full id — slice(0,8)은 테스트 ID에서 충돌 가능
    const recoveredState = inferRecoveredCupseyState(trade);
    activePositions.set(positionId, {
      tradeId: positionId,
      dbTradeId: trade.id,
      pairAddress: trade.pairAddress,
      entryPrice: trade.entryPrice,
      signalTimeSec: entryTimeSec,
      entryTimeSec,
      quantity: trade.quantity,
      state: recoveredState,
      signalPrice: trade.plannedEntryPrice ?? trade.entryPrice,
      peakPrice: Math.max(trade.highWaterMark ?? trade.entryPrice, trade.entryPrice),
      troughPrice: trade.entryPrice,
      tokenSymbol: trade.tokenSymbol,
      sourceLabel: trade.sourceLabel,
      discoverySource: trade.discoverySource,
      plannedEntryPrice: trade.plannedEntryPrice,
      entryTxSignature: trade.txSignature,
      entrySlippageBps: trade.entrySlippageBps,
    });
    recovered++;
    log.info(
      `[CUPSEY_RECOVERED] ${positionId} trade=${trade.id.slice(0, 8)} ` +
      `state=${recoveredState} pair=${trade.pairAddress.slice(0, 12)}`
    );
  }

  return recovered;
}

// ─── Signal Handler ───

/**
 * bootstrap_10s signal 을 cupsey lane 으로 처리.
 * 기존 handleRealtimeSignal 과 병렬 호출.
 */
export async function handleCupseyLaneSignal(
  signal: Signal,
  candleBuilder: MicroCandleBuilder,
  ctx: BotContext
): Promise<void> {
  // Guard: lane disabled
  if (!config.cupseyLaneEnabled) return;

  funnelStats.signalsReceived++;
  recordCupseyFunnelSnapshot(ctx);

  // Guard: integrity halt (live buy 성공 후 DB persist 실패 시 설정됨)
  if (integrityHaltActive) {
    log.warn('[CUPSEY_INTEGRITY_HALT] signal ignored — ledger integrity issue, call resetCupseyIntegrityHalt() after reconciliation');
    return;
  }

  // Guard: 이미 같은 pair 에 cupsey position 있음
  for (const pos of activePositions.values()) {
    if (pos.pairAddress === signal.pairAddress && pos.state !== 'CLOSED') {
      log.debug(`Cupsey lane skip: already holding ${signal.pairAddress}`);
      return;
    }
  }

  // Guard: max concurrent cupsey positions (sandbox 보호)
  const activeCount = [...activePositions.values()].filter(p => p.state !== 'CLOSED').length;
  if (activeCount >= config.cupseyMaxConcurrent) {
    log.debug(`Cupsey lane skip: max concurrent (${activeCount})`);
    return;
  }

  // ─── CUSUM Volume Regime Change Detection (Phase 0: observation-only) ───
  // Why: CUSUM strength 를 gate log 에 기록하여 Phase 1 상관 분석에 사용.
  // trade 결정에는 영향 없음. bootstrap trigger 가 이미 fire 한 signal 에 대해서만 적용.
  let cusumStrength = 0;
  {
    const cusumCfg: CusumConfig = {
      kMultiplier: config.cusumKMultiplier,
      hMultiplier: config.cusumHMultiplier,
      warmupPeriods: config.cusumWarmupPeriods,
    };
    let state = cusumStates.get(signal.pairAddress) ?? initCusumState();
    const lastProcessedBucketSec = cusumLastProcessedBucketSec.get(signal.pairAddress) ?? -1;
    const recentCandles = candleBuilder.getRecentCandles(
      signal.pairAddress,
      config.realtimePrimaryIntervalSec,
      30
    );
    const unseenCandles = recentCandles.filter((candle) => {
      const bucketSec = Math.floor(candle.timestamp.getTime() / 1000);
      return bucketSec > lastProcessedBucketSec;
    });

    let nextProcessedBucketSec = lastProcessedBucketSec;
    for (const candle of unseenCandles) {
      const result = updateCusum(state, candle.volume, cusumCfg);
      state = result.state;
      cusumStrength = result.strength;
      nextProcessedBucketSec = Math.floor(candle.timestamp.getTime() / 1000);
    }

    if (nextProcessedBucketSec >= 0) {
      cusumLastProcessedBucketSec.set(signal.pairAddress, nextProcessedBucketSec);
    }
    cusumStates.set(signal.pairAddress, state);
  }

  // ─── Signal Quality Gate ───
  if (config.cupseyGateEnabled) {
    const recentCandles = candleBuilder.getRecentCandles(
      signal.pairAddress,
      config.realtimePrimaryIntervalSec,
      config.cupseyGateLookbackBars
    );
    const gateConfig: CupseySignalGateConfig = {
      enabled: true,
      minVolumeAccelRatio: config.cupseyGateMinVolumeAccelRatio,
      minPriceChangePct: config.cupseyGateMinPriceChangePct,
      minAvgBuyRatio: config.cupseyGateMinAvgBuyRatio,
      minTradeCountRatio: config.cupseyGateMinTradeCountRatio,
      lookbackBars: config.cupseyGateLookbackBars,
      recentBars: config.cupseyGateRecentBars,
    };
    const gateResult = evaluateCupseySignalGate(recentCandles, gateConfig);
    // Why: Phase 0 measurement — pass/reject 모두 persist하여 score-outcome 상관 분석 가능
    persistCupseyGateLog(signal.pairAddress, signal.price, gateResult, signal.tokenSymbol, cusumStrength);
    if (!gateResult.pass) {
      log.debug(
        `[CUPSEY_GATE_REJECT] ${signal.pairAddress.slice(0, 12)} ` +
        `reason=${gateResult.rejectReason} score=${gateResult.score} cusum=${cusumStrength.toFixed(3)}`
      );
      return;
    }
    log.info(
      `[CUPSEY_GATE_PASS] ${signal.pairAddress.slice(0, 12)} ` +
      `score=${gateResult.score} vol=${gateResult.factors.volumeAccelRatio.toFixed(2)} ` +
      `price=${(gateResult.factors.priceChangePct * 100).toFixed(3)}% ` +
      `buy=${gateResult.factors.avgBuyRatio.toFixed(3)} cusum=${cusumStrength.toFixed(3)}`
    );
    funnelStats.gatePass++;
    recordCupseyFunnelSnapshot(ctx);
  }

  const ticketSol = config.cupseyLaneTicketSol;
  const quantity = signal.price > 0 ? ticketSol / signal.price : 0;
  if (quantity <= 0) return;

  const now = Math.floor(Date.now() / 1000);
  const positionId = `cupsey-${signal.pairAddress.slice(0, 8)}-${now}`;

  // STALK state: 즉시 매수하지 않고 pullback 대기 (spike 꼭대기 매수 방지).
  // signal price 에서 -0.3% 떨어지면 entry, 20s 안에 안 떨어지면 skip.
  const position: CupseyPosition = {
    tradeId: positionId,
    pairAddress: signal.pairAddress,
    signalPrice: signal.price,
    entryPrice: signal.price,   // STALK 동안은 signal price (실제 entry 시 갱신)
    signalTimeSec: now,
    entryTimeSec: now,          // STALK → PROBE 전환 시 갱신
    quantity,
    state: 'STALK',
    peakPrice: signal.price,
    troughPrice: signal.price,
    tokenSymbol: signal.tokenSymbol,
    sourceLabel: signal.sourceLabel,
    discoverySource: signal.discoverySource,
  };
  activePositions.set(positionId, position);
  funnelStats.stalkCreated++;
  recordCupseyFunnelSnapshot(ctx);
  log.info(
    `[CUPSEY_STALK] ${positionId} ${signal.pairAddress.slice(0, 12)} ` +
    `signalPrice=${signal.price.toFixed(8)} waiting for -${(config.cupseyStalkDropPct * 100).toFixed(1)}% pullback`
  );
}

// ─── Tick Monitor (MicroCandleBuilder.on('tick') 에서 호출) ───

/**
 * 매 tick 마다 활성 cupsey position 의 state machine 진행.
 * MicroCandleBuilder.on('tick', ...) 또는 checkOpenPositions 주기에서 호출.
 */
export async function updateCupseyPositions(
  ctx: BotContext,
  candleBuilder: MicroCandleBuilder
): Promise<void> {
  if (!config.cupseyLaneEnabled) return;

  const now = Math.floor(Date.now() / 1000);

  for (const [id, pos] of activePositions) {
    if (pos.state === 'CLOSED') continue;

    const currentPrice = candleBuilder.getCurrentPrice(pos.pairAddress);
    if (currentPrice == null || currentPrice <= 0) continue;

    // ─── STALK state: pullback 대기 (매수 전) ───
    if (pos.state === 'STALK') {
      const stalkElapsed = now - pos.signalTimeSec;
      const dropFromSignal = (currentPrice - pos.signalPrice) / pos.signalPrice;

      // STALK → SKIP: 시간 초과 (pullback 안 옴)
      if (stalkElapsed >= config.cupseyStalKWindowSec) {
        log.info(
          `[CUPSEY_STALK_SKIP] ${id} no pullback in ${stalkElapsed}s ` +
          `drop=${(dropFromSignal * 100).toFixed(2)}%`
        );
        activePositions.delete(id);
        continue;
      }

      // STALK → SKIP: 너무 많이 떨어짐 (crash, not pullback)
      if (dropFromSignal <= -config.cupseyStalkMaxDropPct) {
        log.info(
          `[CUPSEY_STALK_CRASH] ${id} drop ${(dropFromSignal * 100).toFixed(2)}% > ` +
          `max ${(config.cupseyStalkMaxDropPct * 100).toFixed(1)}% — skipping`
        );
        activePositions.delete(id);
        continue;
      }

      // STALK → PROBE: pullback 확인 → 실제 매수!
      if (dropFromSignal <= -config.cupseyStalkDropPct) {
        // Reentrancy guard: updateCupseyPositions가 fire-and-forget으로 호출될 때
        // 같은 STALK 포지션에 대한 executeBuy + insertTrade 중복 실행을 차단.
        // lock은 성공 경로에서 state='PROBE' 전환 후 해제되고, 실패 경로에서는
        // activePositions.delete()로 position 자체가 사라지므로 별도 cleanup 불필요.
        if (pos.enteringLock) {
          log.debug(`[CUPSEY_STALK_REENTRY_BLOCKED] ${id} entering in progress — skip`);
          continue;
        }
        pos.enteringLock = true;

        log.info(
          `[CUPSEY_STALK_ENTRY] ${id} pullback confirmed ` +
          `signal=${pos.signalPrice.toFixed(8)} → current=${currentPrice.toFixed(8)} ` +
          `drop=${(dropFromSignal * 100).toFixed(2)}% — entering PROBE`
        );

        // 실제 매수 실행
        funnelStats.stalkEntry++;
        recordCupseyFunnelSnapshot(ctx);
        const ticketSol = config.cupseyLaneTicketSol;
        let actualEntryPrice = currentPrice;
        let actualQuantity = pos.quantity;
        let entryTxSignature = 'PAPER_TRADE';
        let entrySlippageBps = 0;

        if (ctx.tradingMode === 'live') {
          try {
            const buyExecutor = getCupseyExecutor(ctx);
            const order: Order = {
              pairAddress: pos.pairAddress,
              strategy: 'cupsey_flip_10s',
              side: 'BUY',
              price: currentPrice,
              quantity: pos.quantity,
              stopLoss: currentPrice * (1 - config.cupseyProbeHardCutPct),
              takeProfit1: currentPrice * (1 + config.cupseyProbeMfeThreshold),
              takeProfit2: currentPrice * (1 + config.cupseyWinnerTrailingPct * 2),
              timeStopMinutes: Math.ceil(config.cupseyWinnerMaxHoldSec / 60),
            };
            const buyResult = await buyExecutor.executeBuy(order);
            if (buyResult.actualOutUiAmount && buyResult.actualOutUiAmount > 0) {
              actualQuantity = buyResult.actualOutUiAmount;
            }
            if (buyResult.actualInputUiAmount && buyResult.actualInputUiAmount > 0 && actualQuantity > 0) {
              actualEntryPrice = buyResult.actualInputUiAmount / actualQuantity;
            }
            entryTxSignature = buyResult.txSignature;
            entrySlippageBps = buyResult.slippageBps;
            log.info(
              `[CUPSEY_LIVE_BUY] ${id} pullback entry sig=${entryTxSignature.slice(0, 12)} ` +
              `slip=${entrySlippageBps}bps`
            );
            funnelStats.txSuccess++;
            recordCupseyFunnelSnapshot(ctx);
            // P0-2 + P0-4: tx 성공 직후 fallback ledger 기록 (DB insert 실패 대비)
            // signalId = positionId (1:1 관계 — 각 포지션은 정확히 하나의 signal에서 발생)
            appendExecutedLedger('buy', {
              signalId: id,
              positionId: id,
              txSignature: entryTxSignature,
              strategy: 'cupsey_flip_10s',
              pairAddress: pos.pairAddress,
              tokenSymbol: pos.tokenSymbol,
              plannedEntryPrice: currentPrice,
              actualEntryPrice,
              actualQuantity,
              slippageBps: entrySlippageBps,
              signalTimeSec: pos.signalTimeSec,
              signalPrice: pos.signalPrice,
            });
          } catch (buyErr) {
            log.warn(`[CUPSEY_LIVE_BUY] ${id} pullback buy failed: ${buyErr}`);
            activePositions.delete(id);
            continue;
          }
        }

        // STALK → PROBE 전환
        pos.state = 'PROBE';
        pos.entryPrice = actualEntryPrice;
        pos.entryTimeSec = now;
        pos.quantity = actualQuantity;
        pos.peakPrice = actualEntryPrice;
        pos.troughPrice = actualEntryPrice;
        pos.plannedEntryPrice = currentPrice;
        pos.entryTxSignature = entryTxSignature;
        pos.entrySlippageBps = entrySlippageBps;
        try {
          const dbTradeId = await ctx.tradeStore.insertTrade({
            pairAddress: pos.pairAddress,
            strategy: 'cupsey_flip_10s',
            side: 'BUY',
            tokenSymbol: pos.tokenSymbol,
            sourceLabel: pos.sourceLabel,
            discoverySource: pos.discoverySource,
            entryPrice: actualEntryPrice,
            plannedEntryPrice: currentPrice,
            quantity: actualQuantity,
            stopLoss: actualEntryPrice * (1 - config.cupseyProbeHardCutPct),
            takeProfit1: actualEntryPrice * (1 + config.cupseyProbeMfeThreshold),
            takeProfit2: actualEntryPrice * (1 + config.cupseyWinnerTrailingPct * 2),
            trailingStop: undefined,
            highWaterMark: actualEntryPrice,
            timeStopAt: new Date((now + config.cupseyWinnerMaxHoldSec) * 1000),
            status: 'OPEN',
            txSignature: entryTxSignature,
            createdAt: new Date(now * 1000),
            entrySlippageBps,
          });
          pos.dbTradeId = dbTradeId;
          funnelStats.dbPersisted++;
          recordCupseyFunnelSnapshot(ctx);
          await ctx.notifier.sendTradeOpen({
            tradeId: dbTradeId,
            pairAddress: pos.pairAddress,
            strategy: 'cupsey_flip_10s',
            side: 'BUY',
            tokenSymbol: pos.tokenSymbol,
            price: actualEntryPrice,
            plannedEntryPrice: currentPrice,
            quantity: actualQuantity,
            sourceLabel: pos.sourceLabel,
            discoverySource: pos.discoverySource,
            stopLoss: actualEntryPrice * (1 - config.cupseyProbeHardCutPct),
            takeProfit1: actualEntryPrice * (1 + config.cupseyProbeMfeThreshold),
            takeProfit2: actualEntryPrice * (1 + config.cupseyWinnerTrailingPct * 2),
            timeStopMinutes: Math.ceil(config.cupseyWinnerMaxHoldSec / 60),
          }, entryTxSignature);
          funnelStats.notifierOpenSent++;
          recordCupseyFunnelSnapshot(ctx);
        } catch (persistErr) {
          log.error(`[CUPSEY_PERSIST_OPEN_FAIL] ${id} ${persistErr}`);
          // P0-3: live tx 성공 후 DB 실패 → 신규 포지션 halt (integrity 불일치 방지)
          if (ctx.tradingMode === 'live') {
            integrityHaltActive = true;
          }
          await ctx.notifier.sendCritical(
            'cupsey_open_persist',
            `${id} buy persisted FAILED after tx=${entryTxSignature} — NEW POSITIONS HALTED. Call resetCupseyIntegrityHalt() after reconciliation.`
          ).catch(() => {});
        }
        continue;
      }

      // STALK 진행 중 — 대기
      continue;
    }

    // ─── PROBE / WINNER states (매수 후) ───

    // Update MFE / MAE
    const previousPeakPrice = pos.peakPrice;
    pos.peakPrice = Math.max(pos.peakPrice, currentPrice);
    pos.troughPrice = Math.min(pos.troughPrice, currentPrice);
    if (pos.dbTradeId && pos.peakPrice > previousPeakPrice) {
      void ctx.tradeStore.updateHighWaterMark(pos.dbTradeId, pos.peakPrice).catch((error) => {
        log.warn(`[CUPSEY_HWM_PERSIST_FAIL] ${id} ${error}`);
      });
    }

    const elapsed = now - pos.entryTimeSec;
    const mfePct = (pos.peakPrice - pos.entryPrice) / pos.entryPrice;
    const maePct = (pos.troughPrice - pos.entryPrice) / pos.entryPrice;
    const currentPct = (currentPrice - pos.entryPrice) / pos.entryPrice;

    if (pos.state === 'PROBE') {
      // PROBE → REJECT: hard cut on MAE
      if (maePct <= -config.cupseyProbeHardCutPct) {
        log.info(
          `[CUPSEY_REJECT] ${id} hard cut MAE=${(maePct * 100).toFixed(2)}% ` +
          `elapsed=${elapsed}s`
        );
        await closeCupseyPosition(id, pos, currentPrice, 'REJECT_HARD_CUT', ctx);
        continue;
      }

      // PROBE → WINNER: MFE threshold reached
      if (mfePct >= config.cupseyProbeMfeThreshold) {
        pos.state = 'WINNER';
        log.info(
          `[CUPSEY_WINNER] ${id} promoted to WINNER MFE=${(mfePct * 100).toFixed(2)}% ` +
          `elapsed=${elapsed}s`
        );
        continue;
      }

      // PROBE → REJECT: time expired without momentum
      if (elapsed >= config.cupseyProbeWindowSec) {
        log.info(
          `[CUPSEY_REJECT] ${id} probe timeout MFE=${(mfePct * 100).toFixed(2)}% ` +
          `MAE=${(maePct * 100).toFixed(2)}% elapsed=${elapsed}s`
        );
        await closeCupseyPosition(id, pos, currentPrice, 'REJECT_TIMEOUT', ctx);
        continue;
      }
    }

    if (pos.state === 'WINNER') {
      const trailingStop = pos.peakPrice * (1 - config.cupseyWinnerTrailingPct);
      if (pos.dbTradeId) {
        void ctx.tradeStore.updateTrailingStop(pos.dbTradeId, trailingStop).catch((error) => {
          log.warn(`[CUPSEY_TRAIL_PERSIST_FAIL] ${id} ${error}`);
        });
      }

      // WINNER → CLOSE: hard time stop
      if (elapsed >= config.cupseyWinnerMaxHoldSec) {
        log.info(
          `[CUPSEY_TIME_STOP] ${id} winner time stop ` +
          `pnl=${(currentPct * 100).toFixed(2)}% elapsed=${elapsed}s`
        );
        await closeCupseyPosition(id, pos, currentPrice, 'WINNER_TIME_STOP', ctx);
        continue;
      }

      // WINNER → CLOSE: trailing stop
      if (currentPrice <= trailingStop) {
        log.info(
          `[CUPSEY_TRAILING] ${id} trailing stop peak=${pos.peakPrice.toFixed(8)} ` +
          `trail=${trailingStop.toFixed(8)} current=${currentPrice.toFixed(8)} ` +
          `pnl=${(currentPct * 100).toFixed(2)}%`
        );
        await closeCupseyPosition(id, pos, currentPrice, 'WINNER_TRAILING', ctx);
        continue;
      }

      // WINNER → CLOSE: breakeven stop (SL = entry + small buffer)
      const breakevenStop = pos.entryPrice * (1 + config.cupseyWinnerBreakevenPct);
      if (currentPrice <= breakevenStop && mfePct > config.cupseyProbeMfeThreshold * 2) {
        // 이미 MFE 를 상당히 찍었다가 entry 근처로 돌아왔으면 close
        log.info(
          `[CUPSEY_BREAKEVEN] ${id} breakeven stop ` +
          `pnl=${(currentPct * 100).toFixed(2)}%`
        );
        await closeCupseyPosition(id, pos, currentPrice, 'WINNER_BREAKEVEN', ctx);
        continue;
      }
    }
  }
}

// ─── Close Position ───

async function closeCupseyPosition(
  id: string,
  pos: CupseyPosition,
  exitPrice: number,
  reason: CloseReason,
  ctx: BotContext
): Promise<void> {
  let actualExitPrice = exitPrice;
  let executionSlippage = 0;
  let exitTxSignature = pos.entryTxSignature;
  const holdSec = Math.floor(Date.now() / 1000) - pos.entryTimeSec;
  const previousState = pos.state;
  let sellCompleted = ctx.tradingMode !== 'live';
  let dbCloseSucceeded = false;

  // Live exit: Jupiter sell
  if (ctx.tradingMode === 'live') {
    try {
      const sellExecutor = getCupseyExecutor(ctx);
      const tokenBalance = await sellExecutor.getTokenBalance(pos.pairAddress);
      if (tokenBalance > 0n) {
        const solBefore = await sellExecutor.getBalance();
        const sellResult = await sellExecutor.executeSell(pos.pairAddress, tokenBalance);
        const solAfter = await sellExecutor.getBalance();
        const receivedSol = solAfter - solBefore;
        if (receivedSol > 0 && pos.quantity > 0) {
          actualExitPrice = receivedSol / pos.quantity;
        }
        executionSlippage = bpsToDecimal(sellResult.slippageBps);
        exitTxSignature = sellResult.txSignature;
        sellCompleted = true;
        log.info(
          `[CUPSEY_LIVE_SELL] ${id} sig=${sellResult.txSignature.slice(0, 12)} ` +
          `received=${receivedSol.toFixed(6)} SOL slip=${sellResult.slippageBps}bps`
        );
        // P0-2: sell tx 성공 직후 fallback ledger 기록
        appendExecutedLedger('sell', {
          positionId: id,
          dbTradeId: pos.dbTradeId,
          txSignature: exitTxSignature,
          entryTxSignature: pos.entryTxSignature,
          strategy: 'cupsey_flip_10s',
          pairAddress: pos.pairAddress,
          tokenSymbol: pos.tokenSymbol,
          exitReason: reason,
          receivedSol,
          actualExitPrice,
          slippageBps: sellResult.slippageBps,
          entryPrice: pos.entryPrice,
          holdSec,
        });
      } else {
        throw new Error('no token balance for cupsey close');
      }
    } catch (sellErr) {
      log.warn(`[CUPSEY_LIVE_SELL] ${id} sell failed: ${sellErr}`);
      pos.state = previousState;
      const nowSec = Math.floor(Date.now() / 1000);
      if (!pos.lastCloseFailureAtSec || nowSec - pos.lastCloseFailureAtSec >= 60) {
        pos.lastCloseFailureAtSec = nowSec;
        await ctx.notifier.sendCritical(
          'cupsey_close_failed',
          `${id} ${pos.pairAddress} reason=${reason} sell failed — OPEN 유지`
        ).catch(() => {});
      }
      return;
    }
  }
  pos.state = 'CLOSED';

  const rawPnl = (actualExitPrice - pos.entryPrice) * pos.quantity;
  // Why: paper 모드는 wallet delta 없이 시장가로 PnL 계산 → AMM/MEV 비용 누락
  const paperCost = ctx.tradingMode === 'paper'
    ? pos.entryPrice * pos.quantity * (config.defaultAmmFeePct + config.defaultMevMarginPct)
    : 0;
  const pnl = rawPnl - paperCost;
  const pnlPct = pos.entryPrice > 0 ? ((actualExitPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
  const exitSlippageBps = ctx.tradingMode === 'live' ? Math.round(executionSlippage * 10_000) : undefined;

  // DB record: 매수 시점 OPEN row 가 있으면 그 row 를 닫고, 없으면 fallback insert 후 close.
  let tradeId = pos.dbTradeId;
  try {
    if (!tradeId) {
      tradeId = await ctx.tradeStore.insertTrade({
        pairAddress: pos.pairAddress,
        strategy: 'cupsey_flip_10s',
        side: 'BUY',
        tokenSymbol: pos.tokenSymbol,
        sourceLabel: pos.sourceLabel,
        discoverySource: pos.discoverySource,
        entryPrice: pos.entryPrice,
        plannedEntryPrice: pos.plannedEntryPrice,
        quantity: pos.quantity,
        stopLoss: pos.entryPrice * (1 - config.cupseyProbeHardCutPct),
        takeProfit1: pos.entryPrice * (1 + config.cupseyProbeMfeThreshold),
        takeProfit2: pos.entryPrice * (1 + config.cupseyWinnerTrailingPct * 2),
        trailingStop: undefined,
        highWaterMark: pos.peakPrice,
        timeStopAt: new Date((pos.entryTimeSec + config.cupseyWinnerMaxHoldSec) * 1000),
        status: 'OPEN',
        txSignature: pos.entryTxSignature,
        createdAt: new Date(pos.entryTimeSec * 1000),
        entrySlippageBps: pos.entrySlippageBps,
      });
    }
    if (!sellCompleted) {
      throw new Error(`cupsey close reached DB close without completed sell: ${id}`);
    }
    await ctx.tradeStore.closeTrade({
      id: tradeId,
      exitPrice: actualExitPrice,
      pnl,
      slippage: executionSlippage,
      exitReason: reason,
      exitSlippageBps,
      decisionPrice: exitPrice,
    });
    dbCloseSucceeded = true;
  } catch (error) {
    log.warn(`Failed to record cupsey trade ${id}: ${error}`);
    await ctx.notifier.sendCritical(
      'cupsey_close_persist',
      `${id} ${pos.pairAddress} reason=${reason} sell ok but DB close failed`
    ).catch(() => {});
  }

  const sym = pos.tokenSymbol || pos.pairAddress.slice(0, 8);
  log.info(
    `[CUPSEY_CLOSED] ${id} ${sym} reason=${reason} ` +
    `pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) ` +
    `hold=${holdSec}s peak=${((pos.peakPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)}%`
  );

  if (tradeId && dbCloseSucceeded) {
    const closedTrade: Trade = {
      id: tradeId,
      pairAddress: pos.pairAddress,
      strategy: 'cupsey_flip_10s',
      side: 'BUY',
      tokenSymbol: pos.tokenSymbol,
      sourceLabel: pos.sourceLabel,
      discoverySource: pos.discoverySource,
      entryPrice: pos.entryPrice,
      plannedEntryPrice: pos.plannedEntryPrice,
      exitPrice: actualExitPrice,
      quantity: pos.quantity,
      pnl,
      slippage: executionSlippage,
      txSignature: exitTxSignature,
      status: 'CLOSED',
      createdAt: new Date(pos.entryTimeSec * 1000),
      closedAt: new Date(),
      stopLoss: pos.entryPrice * (1 - config.cupseyProbeHardCutPct),
      takeProfit1: pos.entryPrice * (1 + config.cupseyProbeMfeThreshold),
      takeProfit2: pos.entryPrice * (1 + config.cupseyWinnerTrailingPct * 2),
      highWaterMark: pos.peakPrice,
      timeStopAt: new Date((pos.entryTimeSec + config.cupseyWinnerMaxHoldSec) * 1000),
      entrySlippageBps: pos.entrySlippageBps,
      exitSlippageBps,
      exitReason: reason,
      decisionPrice: exitPrice,
    };
    await ctx.notifier.sendTradeClose(closedTrade).catch(() => {});
  } else if (dbCloseSucceeded) {
    await ctx.notifier.sendInfo(
      `[Cupsey Lane] ${sym} ${reason}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${holdSec}s hold)`,
      'trade'
    ).catch(() => {});
  }

  // Funnel: closed trade count + 10 trades 마다 자동 로그
  funnelStats.closedTrades++;
  recordCupseyFunnelSnapshot(ctx);
  if (funnelStats.closedTrades % 10 === 0) {
    logCupseyFunnelStats();
  }

  // Cleanup
  activePositions.delete(id);
}

// ─── Cleanup ───

export function cleanupClosedCupseyPositions(): void {
  for (const [id, pos] of activePositions) {
    if (pos.state === 'CLOSED') {
      activePositions.delete(id);
    }
  }
}
