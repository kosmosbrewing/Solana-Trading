// 2026-04-26: pure_ws swing-v2 entry — paper shadow OR live canary mode 분기.
//
// Paper shadow (default): primary 와 동일 entry price/quantity 로 in-memory shadow position 생성.
//   - DB persist X, live exec X, canary slot 미소비, paper close ledger 만 기록.
//
// Live canary (Stage 4 SCALE 후 opt-in, `PUREWS_SWING_V2_LIVE_CANARY_ENABLED=true`):
//   - 별도 lane 'pure_ws_swing_v2' 으로 canary slot acquire (primary 와 무관)
//   - swing-v2 ticket (default 0.01 SOL) 로 live executor 호출
//   - DB persist + auto-halt feed + bleed budget 모두 별도 lane 으로 분리
//   - max concurrent / max consec losers / max budget 별도 cap
//   - Real Asset Guard 정합 (ticket policy lock, drift halt 영향)
//
// 사명 §3 phase gate (mission-refinement-2026-04-21 §5):
//   - paper trades ≥ 200 + 5x+ winner ≥ 1건 입증
//   - 별도 ADR 작성 (`docs/design-docs/pure-ws-swing-v2-live-canary-YYYY-MM-DD.md`)
//   - Telegram critical ack
//
// 코드 default = false. 위반 시 운영자 수동 책임.

import { config } from '../../utils/config';
import type { Order, PartialFillDataReason, Signal } from '../../utils/types';
import type { BotContext } from '../types';
import { acquireCanarySlot, releaseCanarySlot } from '../../risk/canaryConcurrencyGuard';
import { isEntryHaltActive } from '../entryIntegrity';
import { persistOpenTradeWithIntegrity } from '../entryIntegrity';
import { resolveActualEntryMetrics } from '../signalProcessor';
import { log } from './constants';
import { activePositions } from './positionState';
import { getPureWsExecutor, resolvePureWsWalletLabel } from './wallet';
import type { PureWsPosition } from './types';
import { lookupCachedSymbol } from '../../ingester/tokenSymbolResolver';

const SWING_V2_LANE = 'pure_ws_swing_v2' as const;

interface OpenSwingV2Input {
  signal: Signal;
  ctx: BotContext;
  primaryPositionId: string;
  primaryEntryPrice: number;
  primaryQuantity: number;
  marketReferencePrice: number;
  buyRatioAtEntry: number;
  txCountAtEntry: number;
  nowSec: number;
}

export async function openSwingV2Arm(input: OpenSwingV2Input): Promise<void> {
  const { signal, ctx, primaryPositionId, primaryEntryPrice, primaryQuantity,
    marketReferencePrice, buyRatioAtEntry, txCountAtEntry, nowSec } = input;

  // Live canary mode 결정 (paper-first 강제 — 명시 opt-in 만 허용)
  const liveCanary =
    config.pureWsSwingV2LiveCanaryEnabled &&
    ctx.tradingMode === 'live';

  if (liveCanary) {
    await openSwingV2Live(input);
  } else {
    openSwingV2Shadow({
      signal, primaryPositionId, primaryEntryPrice, primaryQuantity,
      marketReferencePrice, buyRatioAtEntry, txCountAtEntry, nowSec,
    });
  }
}

// ─── Paper shadow path (current default behavior) ─────────────────────

interface ShadowInput extends Omit<OpenSwingV2Input, 'ctx'> {}

function openSwingV2Shadow(input: ShadowInput): void {
  const { signal, primaryPositionId, primaryEntryPrice, primaryQuantity,
    marketReferencePrice, buyRatioAtEntry, txCountAtEntry, nowSec } = input;

  const shadowId = `${primaryPositionId}-swing-v2`;
  const shadow: PureWsPosition = {
    tradeId: shadowId,
    pairAddress: signal.pairAddress,
    entryPrice: primaryEntryPrice,
    marketReferencePrice,
    entryTimeSec: nowSec,
    quantity: primaryQuantity,
    state: 'PROBE',
    peakPrice: marketReferencePrice,
    troughPrice: marketReferencePrice,
    tokenSymbol: signal.tokenSymbol,
    sourceLabel: signal.sourceLabel,
    discoverySource: signal.discoverySource,
    plannedEntryPrice: signal.price,
    buyRatioAtEntry,
    txCountAtEntry,
    parameterVersion: config.pureWsSwingV2ParameterVersion,
    armName: 'pure_ws_swing_v2',
    isShadowArm: true,
    parentPositionId: primaryPositionId,
    probeWindowSecOverride: config.pureWsSwingV2ProbeWindowSec,
    probeHardCutPctOverride: config.pureWsSwingV2ProbeHardCutPct,
    t1TrailPctOverride: config.pureWsSwingV2T1TrailPct,
    t1ProfitFloorMultOverride: config.pureWsSwingV2T1ProfitFloorMult,
  };
  activePositions.set(shadowId, shadow);
  log.info(
    `[PUREWS_SWING_V2] ${shadowId} ${signal.pairAddress.slice(0, 12)} ` +
    `parent=${primaryPositionId} mode=paper_shadow probe=${config.pureWsSwingV2ProbeWindowSec}s ` +
    `trail=${(config.pureWsSwingV2T1TrailPct * 100).toFixed(0)}% ` +
    `floor=${config.pureWsSwingV2T1ProfitFloorMult}x ` +
    `hardcut=${(config.pureWsSwingV2ProbeHardCutPct * 100).toFixed(0)}%`
  );
}

// ─── Live canary path (Stage 4 SCALE 후 opt-in) ───────────────────────

async function openSwingV2Live(input: OpenSwingV2Input): Promise<void> {
  const { signal, ctx, primaryPositionId, marketReferencePrice,
    buyRatioAtEntry, txCountAtEntry, nowSec } = input;

  // ─── Real Asset Guard 가드 ───
  if (isEntryHaltActive(SWING_V2_LANE)) {
    log.warn(
      `[PUREWS_SWING_V2_LIVE_HALT] entry halt active for swing-v2 lane — signal ignored`
    );
    return;
  }

  // 같은 pair 의 swing-v2 live 가 이미 active 면 차단 (self-dedup, primary 와 별도)
  for (const pos of activePositions.values()) {
    if (
      pos.armName === 'pure_ws_swing_v2' &&
      pos.isShadowArm === false &&
      pos.pairAddress === signal.pairAddress &&
      pos.state !== 'CLOSED'
    ) {
      log.debug(
        `[PUREWS_SWING_V2_LIVE_SKIP] already holding swing-v2 live ${signal.pairAddress.slice(0, 12)}`
      );
      return;
    }
  }

  // Max concurrent (별도 lane cap, primary 와 무관)
  const swingActive = [...activePositions.values()].filter(
    (p) => p.armName === 'pure_ws_swing_v2' && p.isShadowArm === false && p.state !== 'CLOSED'
  ).length;
  if (swingActive >= config.pureWsSwingV2MaxConcurrent) {
    log.info(
      `[PUREWS_SWING_V2_LIVE_SKIP] max concurrent (${swingActive}/${config.pureWsSwingV2MaxConcurrent})`
    );
    return;
  }

  // Canary slot — 'pure_ws_swing_v2' lane (primary 와 별도 budget)
  if (!acquireCanarySlot(SWING_V2_LANE)) {
    log.debug(`[PUREWS_SWING_V2_LIVE_SKIP] global canary slot full`);
    return;
  }

  // ─── Ticket size lock (Real Asset Guard 정합) ───
  const ticketSol = config.pureWsSwingV2TicketSol;
  const probeQuantity = signal.price > 0 ? ticketSol / signal.price : 0;
  if (probeQuantity <= 0) {
    log.warn(`[PUREWS_SWING_V2_LIVE_SKIP] invalid quantity ticket=${ticketSol} signalPrice=${signal.price}`);
    releaseCanarySlot(SWING_V2_LANE);
    return;
  }

  // ─── Live executor 호출 (별도 ticket / quantity 로) ───
  let actualEntryPrice = signal.price;
  let actualQuantity = probeQuantity;
  let actualNotionalSol = signal.price * probeQuantity;  // 2026-04-29: RPC 측정 wallet delta 전파용
  let partialFillDataMissing = false;
  let partialFillDataReason: PartialFillDataReason | undefined;
  let entryTxSignature = 'PAPER_TRADE';
  let entrySlippageBps = 0;
  try {
    const buyExecutor = getPureWsExecutor(ctx);
    const order: Order = {
      pairAddress: signal.pairAddress,
      strategy: SWING_V2_LANE,
      side: 'BUY',
      price: signal.price,
      quantity: probeQuantity,
      stopLoss: signal.price * (1 - config.pureWsSwingV2ProbeHardCutPct),
      takeProfit1: signal.price * (1 + config.pureWsT1MfeThreshold),
      takeProfit2: signal.price * (1 + config.pureWsT2MfeThreshold),
      timeStopMinutes: Math.ceil(config.pureWsSwingV2ProbeWindowSec / 60),
    };
    const buyResult = await buyExecutor.executeBuy(order);
    const metrics = resolveActualEntryMetrics(order, buyResult);
    actualEntryPrice = metrics.entryPrice;
    actualQuantity = metrics.quantity;
    actualNotionalSol = metrics.actualEntryNotionalSol;
    partialFillDataMissing = metrics.partialFillDataMissing;
    partialFillDataReason = metrics.partialFillDataReason;
    entryTxSignature = buyResult.txSignature;
    entrySlippageBps = buyResult.slippageBps;
    log.info(
      `[PUREWS_SWING_V2_LIVE_BUY] swing-v2 PROBE sig=${entryTxSignature.slice(0, 12)} ` +
      `slip=${entrySlippageBps}bps qty=${actualQuantity.toFixed(4)}`
    );
  } catch (buyErr) {
    log.warn(`[PUREWS_SWING_V2_LIVE_BUY] buy failed: ${buyErr}`);
    releaseCanarySlot(SWING_V2_LANE);
    return;
  }

  // ─── DB persist with integrity halt protection ───
  const livePositionId = `purews-swingv2-${signal.pairAddress.slice(0, 8)}-${nowSec}`;
  const persistResult = await persistOpenTradeWithIntegrity({
    ctx,
    lane: SWING_V2_LANE,
    tradeData: {
      pairAddress: signal.pairAddress,
      strategy: SWING_V2_LANE,
      side: 'BUY',
      tokenSymbol: signal.tokenSymbol,
      sourceLabel: signal.sourceLabel,
      discoverySource: signal.discoverySource,
      entryPrice: actualEntryPrice,
      plannedEntryPrice: signal.price,
      quantity: actualQuantity,
      stopLoss: actualEntryPrice * (1 - config.pureWsSwingV2ProbeHardCutPct),
      takeProfit1: actualEntryPrice * (1 + config.pureWsT1MfeThreshold),
      takeProfit2: actualEntryPrice * (1 + config.pureWsT2MfeThreshold),
      trailingStop: undefined,
      highWaterMark: actualEntryPrice,
      timeStopAt: new Date((nowSec + config.pureWsSwingV2ProbeWindowSec) * 1000),
      status: 'OPEN',
      txSignature: entryTxSignature,
      createdAt: new Date(nowSec * 1000),
      entrySlippageBps,
    },
    ledgerEntry: {
      signalId: livePositionId,
      positionId: livePositionId,
      txSignature: entryTxSignature,
      strategy: SWING_V2_LANE,
      wallet: resolvePureWsWalletLabel(ctx),
      pairAddress: signal.pairAddress,
      tokenSymbol: signal.tokenSymbol,
      plannedEntryPrice: signal.price,
      actualEntryPrice,
      actualQuantity,
      slippageBps: entrySlippageBps,
      signalTimeSec: nowSec,
      signalPrice: signal.price,
      armName: 'pure_ws_swing_v2',
      parameterVersion: config.pureWsSwingV2ParameterVersion,
      parentPositionId: primaryPositionId,
      partialFillDataMissing,
      partialFillDataReason,
    },
    notifierKey: 'purews_swingv2_open_persist',
    buildNotifierMessage: (err) =>
      `${livePositionId} swing-v2 live buy persisted FAILED after tx=${entryTxSignature}: ${err}`,
  });

  // ─── In-memory position 등록 ───
  // isShadowArm=false — 정상 closePureWsPositionSerialized path 통과 (live sell + DB close + notifier).
  // armName / parameterVersion / override 는 그대로 — sub-arm 통계용.
  const livePos: PureWsPosition = {
    tradeId: livePositionId,
    dbTradeId: persistResult.dbTradeId ?? undefined,
    pairAddress: signal.pairAddress,
    entryPrice: actualEntryPrice,
    marketReferencePrice,
    entryTimeSec: nowSec,
    quantity: actualQuantity,
    state: 'PROBE',
    peakPrice: marketReferencePrice,
    troughPrice: marketReferencePrice,
    tokenSymbol: signal.tokenSymbol,
    sourceLabel: signal.sourceLabel,
    discoverySource: signal.discoverySource,
    plannedEntryPrice: signal.price,
    entryTxSignature,
    entrySlippageBps,
    buyRatioAtEntry,
    txCountAtEntry,
    parameterVersion: config.pureWsSwingV2ParameterVersion,
    armName: 'pure_ws_swing_v2',
    isShadowArm: false,        // ← live canary 라 shadow 아님. 정상 close path.
    parentPositionId: primaryPositionId,
    probeWindowSecOverride: config.pureWsSwingV2ProbeWindowSec,
    probeHardCutPctOverride: config.pureWsSwingV2ProbeHardCutPct,
    t1TrailPctOverride: config.pureWsSwingV2T1TrailPct,
    t1ProfitFloorMultOverride: config.pureWsSwingV2T1ProfitFloorMult,
  };

  if (persistResult.dbTradeId) {
    // 2026-04-28 P0-B fix: notifier fire-and-forget.
    void ctx.notifier.sendTradeOpen({
      tradeId: persistResult.dbTradeId,
      pairAddress: livePos.pairAddress,
      strategy: SWING_V2_LANE,
      side: 'BUY',
      // 2026-04-29: prefetch 된 cache fallback (entryFlow 에서 이미 resolveTokenSymbol 호출).
      tokenSymbol: livePos.tokenSymbol ?? lookupCachedSymbol(livePos.pairAddress) ?? undefined,
      price: actualEntryPrice,
      plannedEntryPrice: signal.price,
      quantity: actualQuantity,
      sourceLabel: livePos.sourceLabel,
      discoverySource: livePos.discoverySource,
      stopLoss: actualEntryPrice * (1 - config.pureWsSwingV2ProbeHardCutPct),
      takeProfit1: actualEntryPrice * (1 + config.pureWsT1MfeThreshold),
      takeProfit2: actualEntryPrice * (1 + config.pureWsT2MfeThreshold),
      timeStopMinutes: Math.ceil(config.pureWsSwingV2ProbeWindowSec / 60),
      // 2026-04-29: RPC 측정 wallet delta + partial-fill flag.
      actualNotionalSol,
      partialFillDataMissing,
      partialFillDataReason,
    }, entryTxSignature).catch((err) => {
      log.warn(`[PUREWS_SWING_V2_NOTIFY_OPEN_FAIL] ${livePositionId} ${err}`);
    });
  }

  activePositions.set(livePositionId, livePos);
  log.info(
    `[PUREWS_SWING_V2_LIVE_PROBE_OPEN] ${livePositionId} ${signal.pairAddress.slice(0, 12)} ` +
    `mode=live_canary parent=${primaryPositionId} ticket=${ticketSol} ` +
    `entry=${actualEntryPrice.toFixed(8)} qty=${actualQuantity.toFixed(4)} ` +
    `probe=${config.pureWsSwingV2ProbeWindowSec}s trail=${(config.pureWsSwingV2T1TrailPct * 100).toFixed(0)}% ` +
    `floor=${config.pureWsSwingV2T1ProfitFloorMult}x`
  );
}
