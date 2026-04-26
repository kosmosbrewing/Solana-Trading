// Startup recovery — DB OPEN 인 pure_ws trade 들을 in-memory activePositions 로 rehydrate.
// orphan / dust 검증을 먼저 수행 (4/20 BOME 무한 sell loop fix). HWM peak 으로 state 추정.

import { config } from '../../utils/config';
import type { BotContext } from '../types';
import { LANE_STRATEGY, log } from './constants';
import { activePositions } from './positionState';
import { getPureWsExecutor } from './wallet';
import type { PureWsPosition, PureWsTradeState } from './types';

export async function recoverPureWsOpenPositions(ctx: BotContext): Promise<number> {
  if (!config.pureWsLaneEnabled) return 0;

  const openTrades = await ctx.tradeStore.getOpenTrades();
  const pureWsOpenTrades = openTrades.filter((t) => t.strategy === LANE_STRATEGY);
  let recovered = 0;

  for (const trade of pureWsOpenTrades) {
    // 2026-04-20 P0 fix: 선제 orphan 검사 — live 모드에서만 수행.
    // Why: DB OPEN 인데 지갑에 토큰이 없는 trade 를 in-memory 로 로드하면 tick 마다 close 시도
    // → getTokenBalance==0 → 3,982 회 sell 재시도 spam (4/20 BOME ukHH6c7m 관측).
    // 해결: balance==0 이면 DB 를 직접 orphan close 로 업데이트하고 in-memory load 건너뛴다.
    // balance check 실패 (RPC 문제 등) 시 기존 recovery 로 load (보수적 fallback).
    if (ctx.tradingMode === 'live') {
      try {
        const probeExecutor = getPureWsExecutor(ctx);
        const onchainBalance = await probeExecutor.getTokenBalance(trade.pairAddress);
        if (onchainBalance === 0n) {
          log.warn(
            `[PUREWS_RECOVERY_ORPHAN] trade=${trade.id.slice(0, 8)} pair=${trade.pairAddress.slice(0, 12)} ` +
            `zero token balance — closing DB with 0 pnl, skipping in-memory load`
          );
          await ctx.tradeStore.closeTrade({
            id: trade.id,
            exitPrice: trade.entryPrice,
            pnl: 0,
            slippage: 0,
            exitReason: 'ORPHAN_NO_BALANCE',
            exitSlippageBps: undefined,
            decisionPrice: trade.entryPrice,
          }).catch((err) => log.error(`[PUREWS_RECOVERY_ORPHAN] DB close failed for ${trade.id}: ${err}`));
          await ctx.notifier.sendCritical(
            'purews_recovery_orphan',
            `recovery: ${trade.id.slice(0, 8)} ${trade.pairAddress} zero balance — DB closed, not loaded`
          ).catch(() => {});
          continue;
        }

        // 2026-04-25 Phase 1 P0-2: dust orphan — DB qty 의 5% 미만 잔량.
        // 일부 swap 이 partial 로 들어가서 매도 못 하는 상태. ratio 매우 작으면 cleanup.
        // dbQuantity 는 UI amount, onchainBalance 는 raw — decimals 모르므로 비율 비교만 안전.
        const dbQty = trade.quantity ?? 0;
        if (dbQty > 0 && onchainBalance > 0n) {
          // raw ↔ ui 비교는 decimals 의존이라 보수적: dbQuantity 로부터 expected raw 추정 어려움 →
          // ratio 검사 대신 "onchain balance < 1000 raw units" 절대 임계로만 dust 정의.
          // 1000 raw < 0.001 token at decimals=6 (ui amount). 매도 economic 가치 없음.
          if (onchainBalance < 1000n) {
            log.warn(
              `[PUREWS_RECOVERY_DUST] trade=${trade.id.slice(0, 8)} pair=${trade.pairAddress.slice(0, 12)} ` +
              `dust balance ${onchainBalance.toString()} < 1000 raw — closing DB with 0 pnl`
            );
            await ctx.tradeStore.closeTrade({
              id: trade.id,
              exitPrice: trade.entryPrice,
              pnl: 0,
              slippage: 0,
              exitReason: 'ORPHAN_DUST_BALANCE',
              exitSlippageBps: undefined,
              decisionPrice: trade.entryPrice,
            }).catch((err) => log.error(`[PUREWS_RECOVERY_DUST] DB close failed for ${trade.id}: ${err}`));
            continue;
          }
        }
      } catch (balanceErr) {
        // RPC 실패 시 보수적으로 기존 recovery 로 진행 (close loop fix 가 안전망 역할).
        log.warn(
          `[PUREWS_RECOVERY_ORPHAN] balance check failed for ${trade.pairAddress.slice(0, 12)}: ` +
          `${balanceErr} — falling back to in-memory load`
        );
      }
    }

    // Sanitize HWM (Patch B2 pattern)
    const highWaterMark = trade.highWaterMark ?? trade.entryPrice;
    const safePeak = Math.min(highWaterMark, trade.entryPrice * config.pureWsMaxPeakMultiplier);
    const inferredState: PureWsTradeState =
      safePeak >= trade.entryPrice * (1 + config.pureWsT3MfeThreshold) ? 'RUNNER_T3'
      : safePeak >= trade.entryPrice * (1 + config.pureWsT2MfeThreshold) ? 'RUNNER_T2'
      : safePeak >= trade.entryPrice * (1 + config.pureWsT1MfeThreshold) ? 'RUNNER_T1'
      : 'PROBE';

    const entryTimeSec = Math.floor(trade.createdAt.getTime() / 1000);
    const positionId = `purews-${trade.pairAddress.slice(0, 8)}-${entryTimeSec}`;
    const t2Lock = inferredState === 'RUNNER_T2' || inferredState === 'RUNNER_T3'
      ? trade.entryPrice * config.pureWsT2BreakevenLockMultiplier
      : undefined;

    // 2026-04-19: DB 에 marketReferencePrice 저장 안 됨 → plannedEntryPrice (= signal price)
    // fallback, 없으면 entryPrice. 재시작 이후 새 tick 부터 market ref 기준 적용.
    const marketReferencePrice =
      trade.plannedEntryPrice ?? trade.entryPrice;
    // 2026-04-19 (QA Q4): troughPrice 도 marketReferencePrice domain 이어야 MAE 계산 정합.
    // 기존처럼 entryPrice (fill) 기준으로 두면 trough 가 marketRef 보다 높아 초기 MAE 가
    // 음수로 안 찍힘 → real market drop 반영 지연.
    const position: PureWsPosition = {
      tradeId: positionId,
      dbTradeId: trade.id,
      pairAddress: trade.pairAddress,
      entryPrice: trade.entryPrice,
      marketReferencePrice,
      entryTimeSec,
      quantity: trade.quantity,
      state: inferredState,
      peakPrice: safePeak,
      troughPrice: marketReferencePrice,
      tokenSymbol: trade.tokenSymbol,
      sourceLabel: trade.sourceLabel,
      discoverySource: trade.discoverySource,
      plannedEntryPrice: trade.plannedEntryPrice,
      entryTxSignature: trade.txSignature,
      entrySlippageBps: trade.entrySlippageBps,
      t2BreakevenLockPrice: t2Lock,
    };
    activePositions.set(positionId, position);
    recovered++;
    log.info(
      `[PUREWS_RECOVERED] ${positionId} trade=${trade.id.slice(0, 8)} ` +
      `state=${inferredState} pair=${trade.pairAddress.slice(0, 12)}`
    );
  }

  return recovered;
}
