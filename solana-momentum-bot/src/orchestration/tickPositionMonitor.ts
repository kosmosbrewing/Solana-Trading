// Why: tick mode에서 활성 포지션 pair의 swap 도착 시 즉시 SL 체크.
// 기존 5s polling(checkOpenPositions)은 safety net으로 유지.
//
// 범위: SL 즉시 실행 + HWM 갱신만 담당.
// TP1/TP2는 polling에 위임 — runner Grade A/B 판정(shouldActivateRunner, runnerStateMap)
// 및 TP1 partial 분할(handleTakeProfit1Partial)이 필요하므로 tick monitor에서 직접 처리 불가.
import { Trade, isSelfManagedPositionStrategy } from '../utils/types';
import { createModuleLogger } from '../utils/logger';
import { closeTrade } from './tradeExecution';
import { BotContext } from './types';

const log = createModuleLogger('TickPositionMonitor');

// Why: closeTrade 실행 중인 trade에 대해 중복 exit 방지
const exitInProgress = new Set<string>();

// Why: getOpenTrades() 는 DB SELECT — swap 마다 호출하면 초당 수십 회 DB hit.
// 1초 TTL 인메모리 캐시로 hot path 부하 제거. 5s polling이 안전망이므로 1s stale 허용.
let cachedOpenTrades: Trade[] = [];
let cachedAt = 0;
const CACHE_TTL_MS = 1_000;

async function getOpenTradesCached(ctx: BotContext): Promise<Trade[]> {
  const now = Date.now();
  if (now - cachedAt > CACHE_TTL_MS) {
    cachedOpenTrades = (await ctx.tradeStore.getOpenTrades())
      .filter((trade) => !isSelfManagedPositionStrategy(trade.strategy));
    cachedAt = now;
  }
  return cachedOpenTrades;
}

/** 테스트용 캐시 초기화 */
export function _resetCacheForTest(): void {
  cachedOpenTrades = [];
  cachedAt = 0;
}

/**
 * swap handler에서 호출. 해당 pair에 open trade가 있으면 즉시 SL 체크 + HWM 갱신.
 *
 * - SL: 즉시 closeTrade — runner/partial 분기 없음, latency-critical.
 * - TP1/TP2: polling(checkOpenPositions)에 위임 — runner Grade A/B, partial exit 로직 필요.
 * - HWM: 가격 상승 시 즉시 갱신 — trailing stop 정밀도 향상.
 */
export async function checkTickLevelExit(
  pairAddress: string,
  currentPrice: number,
  ctx: BotContext,
): Promise<void> {
  const openTrades = await getOpenTradesCached(ctx);
  const matchingTrade = openTrades.find(t => t.pairAddress === pairAddress);
  if (!matchingTrade) return;

  // Why: 이미 exit 진행 중인 trade는 skip — 중복 closeTrade 방지
  if (exitInProgress.has(matchingTrade.id)) return;

  // Why: execution lock 확인 — closeTrade 내에서도 체크하지만 빠른 short-circuit
  if (ctx.executionLock.isLocked()) return;

  try {
    // SL check — 즉시 실행 (runner/partial 분기 없음)
    if (currentPrice <= matchingTrade.stopLoss) {
      exitInProgress.add(matchingTrade.id);
      log.info(`Tick SL triggered: trade=${matchingTrade.id} price=${currentPrice} sl=${matchingTrade.stopLoss}`);
      await closeTrade(matchingTrade, 'STOP_LOSS', ctx, currentPrice);
      // Why: exit 성공 → 캐시 무효화하여 다음 swap에서 closed trade 재평가 방지
      cachedAt = 0;
      return;
    }

    // HWM 갱신 — 가격 상승 시 즉시 기록 (trailing stop 정밀도 향상)
    if (matchingTrade.highWaterMark && currentPrice > matchingTrade.highWaterMark) {
      await ctx.tradeStore.updateHighWaterMark(matchingTrade.id, currentPrice);
      matchingTrade.highWaterMark = currentPrice;
    }
  } finally {
    exitInProgress.delete(matchingTrade.id);
  }
}
