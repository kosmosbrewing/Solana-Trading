import type { TradeStore } from '../candle';
import { EdgeTracker, sanitizeEdgeLikeTrades } from '../reporting';

type ScannerBlacklistTradeStore = Pick<TradeStore, 'getClosedTradesChronological'>;

export async function createScannerBlacklistCheck(
  tradeStore: ScannerBlacklistTradeStore
): Promise<(pairAddress: string) => boolean> {
  let cachedBlacklist = new Set<string>();
  let lastRefreshMs = 0;
  let lastRefreshAttemptMs = 0;
  let refreshingPromise: Promise<void> | null = null;
  const REFRESH_INTERVAL_MS = 5 * 60_000;

  const refresh = (): Promise<void> => {
    if (refreshingPromise) return refreshingPromise;

    lastRefreshAttemptMs = Date.now();
    refreshingPromise = tradeStore.getClosedTradesChronological()
      .then((trades) => {
        const edgeTracker = new EdgeTracker(sanitizeEdgeLikeTrades(trades.map((trade) => ({
          pairAddress: trade.pairAddress,
          strategy: trade.strategy,
          entryPrice: trade.entryPrice,
          stopLoss: trade.stopLoss,
          quantity: trade.quantity,
          pnl: trade.pnl ?? 0,
        }))).trades);
        cachedBlacklist = new Set(edgeTracker.getBlacklistedPairs().map((pair) => pair.pairAddress));
        lastRefreshMs = Date.now();
      })
      .catch(() => {
        // 기존 캐시 유지. cold start 실패 시 다음 호출에서 재시도한다.
      })
      .finally(() => {
        refreshingPromise = null;
      });

    return refreshingPromise;
  };

  // startup 시점에 1회 preload해서 cold-start 우회 구간을 최소화한다.
  await refresh();

  return (pairAddress: string): boolean => {
    const freshnessBase = Math.max(lastRefreshMs, lastRefreshAttemptMs);
    if (Date.now() - freshnessBase > REFRESH_INTERVAL_MS) {
      void refresh();
    }
    return cachedBlacklist.has(pairAddress);
  };
}
