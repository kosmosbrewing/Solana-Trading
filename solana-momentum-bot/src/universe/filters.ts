import { PoolInfo } from '../utils/types';

export interface UniverseParams {
  minPoolTVL: number;         // U1: $50,000
  minTokenAgeSec: number;     // U2: 86400 (24h)
  maxTop10HolderPct: number;  // U3: 0.80
  minDailyVolume: number;     // U4: $10,000
  minTradeCount24h: number;   // U5: 50
  maxSpreadPct: number;       // U6: 0.03
  maxWatchlistSize: number;   // U7: 20
}

export const DEFAULT_UNIVERSE_PARAMS: UniverseParams = {
  minPoolTVL: 50_000,
  minTokenAgeSec: 86_400,
  maxTop10HolderPct: 0.80,
  minDailyVolume: 10_000,
  minTradeCount24h: 50,
  maxSpreadPct: 0.03,
  maxWatchlistSize: 20,
};

/**
 * Static Filter — 불변 조건 (토큰 본질적 속성)
 */
export function staticFilter(pool: PoolInfo, params: UniverseParams): { pass: boolean; reason?: string } {
  if (pool.tvl < params.minPoolTVL) {
    return { pass: false, reason: `TVL $${pool.tvl.toFixed(0)} < min $${params.minPoolTVL}` };
  }
  if (pool.tokenAgeHours < params.minTokenAgeSec / 3600) {
    return { pass: false, reason: `Token age ${pool.tokenAgeHours.toFixed(1)}h < min ${params.minTokenAgeSec / 3600}h` };
  }
  if (pool.top10HolderPct > params.maxTop10HolderPct) {
    return { pass: false, reason: `Top10 holder ${(pool.top10HolderPct * 100).toFixed(1)}% > max ${(params.maxTop10HolderPct * 100)}%` };
  }
  return { pass: true };
}

/**
 * Dynamic Filter — 시장 상태 의존
 */
export function dynamicFilter(pool: PoolInfo, params: UniverseParams): { pass: boolean; reason?: string } {
  if (pool.dailyVolume < params.minDailyVolume) {
    return { pass: false, reason: `Daily volume $${pool.dailyVolume.toFixed(0)} < min $${params.minDailyVolume}` };
  }
  if (pool.tradeCount24h < params.minTradeCount24h) {
    return { pass: false, reason: `Trade count ${pool.tradeCount24h} < min ${params.minTradeCount24h}` };
  }
  if (pool.spreadPct > params.maxSpreadPct) {
    return { pass: false, reason: `Spread ${(pool.spreadPct * 100).toFixed(2)}% > max ${(params.maxSpreadPct * 100)}%` };
  }
  return { pass: true };
}

/**
 * 실시간 이벤트: 풀 상태 급변 감지
 */
export interface PoolEvent {
  type: 'LP_DROP' | 'RUG_PULL' | 'LIQUIDITY_DRAIN' | 'SPREAD_SPIKE';
  pairAddress: string;
  detail: string;
}

export function checkPoolHealth(
  pool: PoolInfo,
  previousTvl: number,
  params: UniverseParams
): PoolEvent | null {
  // LP 전량 인출 (러그풀)
  if (pool.tvl < 100 && previousTvl > 1000) {
    return { type: 'RUG_PULL', pairAddress: pool.pairAddress, detail: `TVL dropped from $${previousTvl} to $${pool.tvl}` };
  }

  // LP 급감 (5분 내 30% 이상)
  if (previousTvl > 0) {
    const drop = (previousTvl - pool.tvl) / previousTvl;
    if (drop >= 0.30) {
      return { type: 'LP_DROP', pairAddress: pool.pairAddress, detail: `TVL dropped ${(drop * 100).toFixed(1)}%` };
    }
  }

  // 유동성 고갈
  if (pool.tvl < params.minPoolTVL) {
    return { type: 'LIQUIDITY_DRAIN', pairAddress: pool.pairAddress, detail: `TVL $${pool.tvl.toFixed(0)} below minimum` };
  }

  // 스프레드 급등
  if (pool.spreadPct > params.maxSpreadPct * 3) {
    return { type: 'SPREAD_SPIKE', pairAddress: pool.pairAddress, detail: `Spread ${(pool.spreadPct * 100).toFixed(2)}% > 3x max` };
  }

  return null;
}
