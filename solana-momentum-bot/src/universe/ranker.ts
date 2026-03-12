import { PoolInfo } from '../utils/types';

/**
 * Watchlist 랭킹 — TVL × Volume × TradeCount 가중합
 */
export function rankPools(pools: PoolInfo[]): PoolInfo[] {
  if (pools.length === 0) return [];

  const maxTvl = Math.max(...pools.map(p => p.tvl), 1);
  const maxVol = Math.max(...pools.map(p => p.dailyVolume), 1);
  const maxTrades = Math.max(...pools.map(p => p.tradeCount24h), 1);

  return pools
    .map(pool => ({
      ...pool,
      rankScore:
        (pool.tvl / maxTvl) * 0.4 +
        (pool.dailyVolume / maxVol) * 0.4 +
        (pool.tradeCount24h / maxTrades) * 0.2,
    }))
    .sort((a, b) => b.rankScore - a.rankScore);
}
