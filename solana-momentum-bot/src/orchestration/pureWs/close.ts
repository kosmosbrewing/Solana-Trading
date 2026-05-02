// Live sell + DB close + ledger reconciliation + canary feedback.
// closePureWsPosition 은 항상 serializeClose 로 wrap — 동시 close 시도 race 방지.
//
// 주요 분기:
// 1. live: tokenBalance 조회 → 0 이면 ORPHAN_NO_BALANCE 강제 close (4/20 BOME 무한 sell loop fix)
// 2. live: sell 성공 → wallet delta 측정, dbPnl ↔ wallet drift snapshot
// 3. live: sell 실패 → previousState 복원 + 60s 쿨다운 critical notifier (재시도 spam 방어)
// 4. paper: paperCost = entry * qty * (defaultAmmFeePct + defaultMevMarginPct) 차감
// 5. close 후: livePriceTracker unsubscribe + canary slot release + bleed budget 누적

import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { config } from '../../utils/config';
import { Trade, CloseReason } from '../../utils/types';
import { bpsToDecimal } from '../../utils/units';
import { escapeHtml, shortenAddress } from '../../notifier/formatting';
import { reportCanaryClose } from '../../risk/canaryAutoHalt';
import { releaseCanarySlot } from '../../risk/canaryConcurrencyGuard';
import { reportBleed } from '../../risk/dailyBleedBudget';
import { getWalletStopGuardState } from '../../risk/walletStopGuard';
import { recordClose as recordTokenSessionClose } from '../tokenSessionTracker';
import { appendEntryLedger, triggerEntryHalt } from '../entryIntegrity';
import { serializeClose } from '../swapSerializer';
import type { BotContext } from '../types';
import { LANE_STRATEGY, log } from './constants';
import { activePositions, funnelStats } from './positionState';
import { getPureWsLivePriceTracker } from './livePriceTracker';
import { getPureWsExecutor, resolvePureWsWalletLabel } from './wallet';
import type { PureWsPosition } from './types';
import { lookupCachedSymbol } from '../../ingester/tokenSymbolResolver';

export async function closePureWsPosition(
  id: string,
  pos: PureWsPosition,
  exitPrice: number,
  reason: CloseReason,
  ctx: BotContext
): Promise<void> {
  return serializeClose(() => closePureWsPositionSerialized(id, pos, exitPrice, reason, ctx));
}

async function closePureWsPositionSerialized(
  id: string,
  pos: PureWsPosition,
  exitPrice: number,
  reason: CloseReason,
  ctx: BotContext
): Promise<void> {
  if (pos.state === 'CLOSED') return;

  // Paper-only arm — DB persist / live sell 모두 우회.
  // wallet 영향 0. live 운영 중 pure_ws primary paper 검증과 swing-v2 shadow 모두 여기로 온다.
  if (pos.isShadowArm === true || pos.paperOnlyReason != null) {
    await closePaperOnlyPosition(id, pos, exitPrice, reason, ctx);
    return;
  }

  let actualExitPrice = exitPrice;
  let executionSlippage = 0;
  let exitTxSignature = pos.entryTxSignature;
  const holdSec = Math.floor(Date.now() / 1000) - pos.entryTimeSec;
  const previousState = pos.state;
  let sellCompleted = ctx.tradingMode !== 'live';
  let dbCloseSucceeded = false;
  // Phase 1 P0-4 (2026-04-25): wallet truth — live sell 시 receivedSol 을 outer 에 보존.
  let liveReceivedSol = 0;

  if (ctx.tradingMode === 'live') {
    try {
      const sellExecutor = getPureWsExecutor(ctx);
      // 2026-04-28 P0-C fix: tokenBalance + getBalance(solBefore) 병렬 (~250ms 단축).
      const [tokenBalance, solBefore] = await Promise.all([
        sellExecutor.getTokenBalance(pos.pairAddress),
        sellExecutor.getBalance(),
      ]);
      if (tokenBalance > 0n) {
        const sellResult = await sellExecutor.executeSell(pos.pairAddress, tokenBalance);
        const solAfter = await sellExecutor.getBalance();
        const receivedSol = solAfter - solBefore;
        liveReceivedSol = receivedSol;
        // 2026-04-29: wallet ground truth — receivedSol 부호 무관 항상 wallet 기준.
        if (pos.quantity > 0) {
          actualExitPrice = receivedSol / pos.quantity;
        }
        executionSlippage = bpsToDecimal(sellResult.slippageBps);
        exitTxSignature = sellResult.txSignature;
        sellCompleted = true;
        log.info(
          `[PUREWS_LIVE_SELL] ${id} sig=${sellResult.txSignature.slice(0, 12)} ` +
          `received=${receivedSol.toFixed(6)} SOL slip=${sellResult.slippageBps}bps`
        );
        // 2026-04-22 P2-4: MFE peak + tier visit timestamp 기록 — canary-eval 이 net return
        // 기반 `winners5x` 외에 **visit 기반 winner 분포** 도 집계할 수 있게 한다.
        const mfePctPeak =
          pos.marketReferencePrice > 0
            ? (pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice
            : 0;
        // Phase 1 P0-4: DB pnl ↔ wallet delta drift — sell 직후 즉시 측정 (price-based vs wallet-based).
        const solSpentNominalLocal = pos.entryPrice * pos.quantity;
        const dbPnlLocal = (actualExitPrice - pos.entryPrice) * pos.quantity;
        const walletDeltaLocal = receivedSol - solSpentNominalLocal;
        const dbPnlDriftLocal = dbPnlLocal - walletDeltaLocal;
        if (Math.abs(dbPnlDriftLocal) > 0.001) {
          log.warn(
            `[PUREWS_PNL_DRIFT] ${id} dbPnl=${dbPnlLocal.toFixed(6)} ` +
            `walletDelta=${walletDeltaLocal.toFixed(6)} drift=${dbPnlDriftLocal.toFixed(6)} SOL`
          );
        }
        await appendEntryLedger('sell', {
          positionId: id,
          dbTradeId: pos.dbTradeId,
          txSignature: exitTxSignature,
          entryTxSignature: pos.entryTxSignature,
          strategy: LANE_STRATEGY,
          wallet: resolvePureWsWalletLabel(ctx), // Block 1 QA fix
          pairAddress: pos.pairAddress,
          tokenSymbol: pos.tokenSymbol,
          exitReason: reason,
          receivedSol,
          actualExitPrice,
          slippageBps: sellResult.slippageBps,
          entryPrice: pos.entryPrice,
          holdSec,
          mfePctPeak,
          peakPrice: pos.peakPrice,
          troughPrice: pos.troughPrice,
          marketReferencePrice: pos.marketReferencePrice,
          t1VisitAtSec: pos.t1VisitAtSec ?? null,
          t2VisitAtSec: pos.t2VisitAtSec ?? null,
          t3VisitAtSec: pos.t3VisitAtSec ?? null,
          closeState: pos.state,
          // Phase 1 P0-4 — DB pnl ↔ wallet delta reconciliation snapshot.
          dbPnlSol: dbPnlLocal,
          walletDeltaSol: walletDeltaLocal,
          dbPnlDriftSol: dbPnlDriftLocal,
          solSpentNominal: solSpentNominalLocal,
          // Phase 2 P1-3 — T1 promotion 이 quote-based 신호로 발동됐는지.
          t1ViaQuote: pos.t1ViaQuote === true,
        });
      } else {
        // 2026-04-20 P0 fix: orphan position (지갑에 토큰 없음) — 기존 `throw Error` 는
        // previousState 복원 → 매 tick sell 재시도 → 무한 loop (VPS 4/20 관측 3,982회/8분).
        // 원인: 외부 sell / rug / DB OPEN 으로 남은 이전 세션 trade recovery.
        // Fix: tokenBalance==0 을 정상 close 로 마감 — pnl=0, reason=ORPHAN_NO_BALANCE,
        // sellCompleted=true 로 DB close 진행. 1회 critical notifier.
        log.warn(
          `[PUREWS_ORPHAN_CLOSE] ${id} ${pos.pairAddress.slice(0, 12)} zero token balance — ` +
          `force closing (previousReason=${reason} entry=${pos.entryPrice.toFixed(8)} qty=${pos.quantity})`
        );
        reason = 'ORPHAN_NO_BALANCE';
        actualExitPrice = pos.entryPrice;  // pnl = 0
        sellCompleted = true;
        exitTxSignature = pos.entryTxSignature ?? 'ORPHAN_NO_TX';
        await ctx.notifier.sendCritical(
          'purews_orphan_close',
          `${id} ${pos.pairAddress} zero token balance at close — force closing with 0 pnl`
        ).catch(() => {});
      }
    } catch (sellErr) {
      log.warn(`[PUREWS_LIVE_SELL] ${id} sell failed: ${sellErr}`);
      pos.state = previousState;
      const nowSec = Math.floor(Date.now() / 1000);
      if (!pos.lastCloseFailureAtSec || nowSec - pos.lastCloseFailureAtSec >= 60) {
        pos.lastCloseFailureAtSec = nowSec;
        await ctx.notifier.sendCritical(
          'purews_close_failed',
          `${id} ${pos.pairAddress} reason=${reason} sell failed — OPEN 유지`
        ).catch(() => {});
      }
      return;
    }
  }

  pos.state = 'CLOSED';
  funnelStats.closedTrades++;
  // Phase 2 P1-1: live tracker unsubscribe — 닫힌 position 의 reverse quote 폴 중단.
  getPureWsLivePriceTracker()?.unsubscribe(pos.pairAddress);
  // Phase 3 P1-5: token session close 기록 (winner/loser 분류는 lastNetPct 기준).
  if (config.tokenSessionTrackerEnabled) {
    const closingNetPct = pos.entryPrice > 0
      ? (actualExitPrice - pos.entryPrice) / pos.entryPrice
      : 0;
    recordTokenSessionClose({ tokenMint: pos.pairAddress, netPct: closingNetPct });
  }

  const rawPnl = (actualExitPrice - pos.entryPrice) * pos.quantity;
  const paperCost = ctx.tradingMode === 'paper'
    ? pos.entryPrice * pos.quantity * (config.defaultAmmFeePct + config.defaultMevMarginPct)
    : 0;
  const pnl = rawPnl - paperCost;
  // Phase 1 P0-4 — `liveReceivedSol` 은 sell 직후 set. paper 에서는 0 → drift 0.
  void liveReceivedSol; // referenced via ledger snapshot (no further use here, suppress unused warn)
  const pnlPct = pos.entryPrice > 0
    ? ((actualExitPrice - pos.entryPrice) / pos.entryPrice) * 100
    : 0;
  const exitSlippageBps = ctx.tradingMode === 'live' ? Math.round(executionSlippage * 10_000) : undefined;

  let tradeId = pos.dbTradeId;
  try {
    if (!tradeId) {
      // fallback: persistOpen 단계에서 실패했으면 close 시점에 다시 시도
      tradeId = await ctx.tradeStore.insertTrade({
        pairAddress: pos.pairAddress,
        strategy: LANE_STRATEGY,
        side: 'BUY',
        tokenSymbol: pos.tokenSymbol,
        sourceLabel: pos.sourceLabel,
        discoverySource: pos.discoverySource,
        entryPrice: pos.entryPrice,
        plannedEntryPrice: pos.plannedEntryPrice,
        quantity: pos.quantity,
        stopLoss: pos.entryPrice * (1 - config.pureWsProbeHardCutPct),
        takeProfit1: pos.entryPrice * (1 + config.pureWsT1MfeThreshold),
        takeProfit2: pos.entryPrice * (1 + config.pureWsT2MfeThreshold),
        highWaterMark: pos.peakPrice,
        timeStopAt: new Date((pos.entryTimeSec + config.pureWsProbeWindowSec) * 1000),
        status: 'OPEN',
        txSignature: pos.entryTxSignature,
        createdAt: new Date(pos.entryTimeSec * 1000),
        entrySlippageBps: pos.entrySlippageBps,
      });
    }
    if (!sellCompleted) {
      throw new Error(`purews close reached DB close without completed sell: ${id}`);
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
    log.warn(`Failed to record purews trade ${id}: ${error}`);
    // 2026-04-26 Real Asset Guard fix: live sell 성공했는데 DB close 실패 →
    // wallet ↔ DB drift 누적 가능. cupsey 패턴 (`integrityHaltActive`) 동일 적용:
    // live 모드에서 entry halt 트리거 → 운영자 reconciliation 후 reset 필요.
    if (ctx.tradingMode === 'live') {
      triggerEntryHalt(LANE_STRATEGY, `close persist failed for ${id}: ${error}`);
    }
    await ctx.notifier.sendCritical(
      'purews_close_persist',
      `${id} ${pos.pairAddress} reason=${reason} sell ok but DB close failed — NEW POSITIONS HALTED`
    ).catch(() => {});
  }

  const sym = pos.tokenSymbol || pos.pairAddress.slice(0, 8);
  log.info(
    `[PUREWS_CLOSED] ${id} ${sym} reason=${reason} state=${previousState} ` +
    `pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) ` +
    `hold=${holdSec}s peak=${((pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice * 100).toFixed(2)}%`
  );

  if (tradeId && dbCloseSucceeded) {
    const closedTrade: Trade = {
      id: tradeId,
      pairAddress: pos.pairAddress,
      strategy: LANE_STRATEGY,
      side: 'BUY',
      // 2026-04-29: close path 도 동일 fallback 체인 (resolver cache).
      tokenSymbol: pos.tokenSymbol ?? lookupCachedSymbol(pos.pairAddress) ?? undefined,
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
      stopLoss: pos.entryPrice * (1 - config.pureWsProbeHardCutPct),
      takeProfit1: pos.entryPrice * (1 + config.pureWsT1MfeThreshold),
      takeProfit2: pos.entryPrice * (1 + config.pureWsT2MfeThreshold),
      highWaterMark: pos.peakPrice,
      timeStopAt: new Date((pos.entryTimeSec + config.pureWsProbeWindowSec) * 1000),
      entrySlippageBps: pos.entrySlippageBps,
      exitSlippageBps,
      exitReason: reason,
      decisionPrice: exitPrice,
    };
    // 2026-04-28 P0-B fix: notifier fire-and-forget — Telegram 429 close path blocking 차단.
    void ctx.notifier.sendTradeClose(closedTrade).catch(() => {});
  }

  // Block 4: canary auto-halt feed
  // 2026-04-26: swing-v2 live canary 는 별도 lane ('pure_ws_swing_v2') 으로 보고 — primary 와
  // budget / consec losers 분리. shadow (paper) 는 isShadowArm=true 라 closePaperOnlyPosition 에서
  // 이미 분기되었으므로 여기 도달 안 함.
  const closeLane = (pos.armName === 'pure_ws_swing_v2' && pos.isShadowArm === false)
    ? 'pure_ws_swing_v2'
    : LANE_STRATEGY;
  reportCanaryClose(closeLane, pnl);
  // Block 4 QA fix: 전역 concurrency slot 해제 (acquire 대응)
  // legacy recovered position 은 flag 가 없을 수 있어 기존 동작 유지.
  if (pos.canarySlotAcquired !== false) releaseCanarySlot(closeLane);

  // DEX_TRADE Phase 2: daily bleed budget 누적
  // Why: close 직후 실제 발생한 loss 를 budget 에 반영. winner 는 budget 영향 없음 (spend 0).
  if (config.dailyBleedBudgetEnabled) {
    const walletState = getWalletStopGuardState();
    const walletBaselineSol = walletState.lastBalanceSol > 0 && Number.isFinite(walletState.lastBalanceSol)
      ? walletState.lastBalanceSol
      : config.walletStopMinSol;  // 2026-04-26 fix: floor 자체를 baseline 으로 (보수적)
    // pnl < 0 이면 -pnl 을 소비로 집계. pnl >= 0 이면 소비 없음.
    const bleedSol = pnl < 0 ? -pnl : 0;
    reportBleed(bleedSol, walletBaselineSol, {
      alpha: config.dailyBleedAlpha,
      minCapSol: config.dailyBleedMinCapSol,
      maxCapSol: config.dailyBleedMaxCapSol,
    });
  }
}

/**
 * pure_ws paper-only close.
 *
 * 단순 paper-only 회수 — wallet/DB 모두 미접촉:
 *  - live sell 안 함 (paper 가격으로 가상 체결)
 *  - DB persist / closeTrade 안 함 (별도 paper ledger)
 *  - canary slot release 안 함 (애초에 acquire 안 함)
 *  - bleed budget 누적 안 함 (paper 손실은 실제 wallet 영향 없음)
 *  - primary paper-only 만 lightweight notifier 발송 가능 (shadow 는 중복 방지)
 *
 * 산출물: `data/realtime/pure-ws-paper-trades.jsonl` — paper-arm-report 가 sub-arm 통계 산출.
 */
async function closePaperOnlyPosition(
  id: string,
  pos: PureWsPosition,
  exitPrice: number,
  reason: CloseReason,
  ctx: BotContext
): Promise<void> {
  pos.state = 'CLOSED';
  const holdSec = Math.floor(Date.now() / 1000) - pos.entryTimeSec;

  // Paper PnL — KOL paper 와 동일 비용 모델 (왕복 cost 차감).
  const rawPnl = (exitPrice - pos.entryPrice) * pos.quantity;
  const ticketSol = pos.entryPrice * pos.quantity;
  const paperCost = ticketSol * (config.defaultAmmFeePct + config.defaultMevMarginPct);
  const pnl = rawPnl - paperCost;
  const tokenOnlyNetPct = pos.entryPrice > 0
    ? (exitPrice - pos.entryPrice) / pos.entryPrice
    : 0;
  const netPct = ticketSol > 0 ? pnl / ticketSol : tokenOnlyNetPct;

  const ref = pos.marketReferencePrice;
  const mfePct = ref > 0 ? (pos.peakPrice - ref) / ref : 0;
  const maePct = ref > 0 ? (pos.troughPrice - ref) / ref : 0;
  const isShadow = pos.isShadowArm === true;
  const strategy = isShadow ? 'pure_ws_swing_v2' : LANE_STRATEGY;
  const armName = pos.armName ?? strategy;
  const tag = isShadow ? 'PUREWS_SWING_V2_PAPER_CLOSE' : 'PUREWS_PAPER_CLOSE';

  if (config.tokenSessionTrackerEnabled) {
    recordTokenSessionClose({ tokenMint: pos.pairAddress, netPct });
  }
  if (!isShadow) funnelStats.closedTrades++;

  log.info(
    `[${tag}] ${id} reason=${reason} ` +
    `pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${netPct >= 0 ? '+' : ''}${(netPct * 100).toFixed(2)}%) ` +
    `hold=${holdSec}s mfe=${(mfePct * 100).toFixed(2)}% mae=${(maePct * 100).toFixed(2)}% ` +
    `t1=${pos.t1VisitAtSec ? 'y' : 'n'} t2=${pos.t2VisitAtSec ? 'y' : 'n'} t3=${pos.t3VisitAtSec ? 'y' : 'n'}`
  );
  if (config.pureWsPaperNotifyEnabled && !isShadow) {
    const symbol = pos.tokenSymbol ?? shortenAddress(pos.pairAddress);
    void ctx.notifier.sendMessage([
      `🟣 <b>pure_ws paper 종료</b> <b>${escapeHtml(symbol)}</b> <code>${escapeHtml(id.slice(0, 12))}</code> · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL`,
      `${reason} · 보유 ${holdSec}s · net ${(netPct * 100).toFixed(2)}% · token-only ${(tokenOnlyNetPct * 100).toFixed(2)}%`,
      `MFE ${(mfePct * 100).toFixed(2)}% · MAE ${(maePct * 100).toFixed(2)}%`,
      `<code>${escapeHtml(pos.pairAddress)}</code>`,
    ].join('\n')).catch((err) => {
      log.warn(`[PUREWS_PAPER_NOTIFY_CLOSE_FAIL] ${id} ${err}`);
    });
  }

  // Paper ledger — kol-paper-trades.jsonl 패턴 동일.
  try {
    const dir = config.realtimeDataDir;
    await mkdir(dir, { recursive: true });
    const closedAt = new Date();
    const record = {
      positionId: id,
      strategy,
      lane: LANE_STRATEGY,
      armName,
      parameterVersion: pos.parameterVersion ?? (isShadow ? config.pureWsSwingV2ParameterVersion : 'pure-ws-v1.0.0'),
      isShadowArm: isShadow,
      parentPositionId: pos.parentPositionId ?? null,
      executionMode: pos.executionMode ?? 'paper',
      paperOnlyReason: pos.paperOnlyReason ?? (isShadow ? 'shadow_arm' : null),
      pairAddress: pos.pairAddress,
      tokenSymbol: pos.tokenSymbol ?? null,
      sourceLabel: pos.sourceLabel ?? null,
      discoverySource: pos.discoverySource ?? null,
      ticketSol,
      entryPrice: pos.entryPrice,
      exitPrice,
      entryTimeSec: pos.entryTimeSec,
      exitTimeSec: Math.floor(closedAt.getTime() / 1000),
      entryAt: new Date(pos.entryTimeSec * 1000).toISOString(),
      marketReferencePrice: ref,
      peakPrice: pos.peakPrice,
      troughPrice: pos.troughPrice,
      mfePctPeak: mfePct,
      maePct,
      netPct,
      netPctTokenOnly: tokenOnlyNetPct,
      netSol: pnl,
      netSolTokenOnly: rawPnl,
      holdSec,
      exitReason: reason,
      t1VisitAtSec: pos.t1VisitAtSec ?? null,
      t2VisitAtSec: pos.t2VisitAtSec ?? null,
      t3VisitAtSec: pos.t3VisitAtSec ?? null,
      probeWindowSec: pos.probeWindowSecOverride ?? null,
      probeHardCutPct: pos.probeHardCutPctOverride ?? null,
      t1TrailPct: pos.t1TrailPctOverride ?? null,
      t1ProfitFloorMult: pos.t1ProfitFloorMultOverride ?? null,
      closedAt: closedAt.toISOString(),
    };
    await appendFile(
      path.join(dir, 'pure-ws-paper-trades.jsonl'),
      JSON.stringify(record) + '\n',
      'utf8'
    );
  } catch (err) {
    log.debug(`[${tag}] paper ledger append failed: ${err}`);
  }

  // 메모리 정리만 — primary 의 livePriceTracker 는 primary close 가 처리.
  activePositions.delete(id);
}
