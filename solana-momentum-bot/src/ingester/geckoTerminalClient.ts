/**
 * GeckoTerminal API Client — Birdeye 대체 (무료, API 키 불필요)
 *
 * 역할: OHLCV 캔들 + Trending Pools
 * Rate limit: 30 req/min → 2100ms 간격
 * 429 에러 시 exponential backoff 후 1회 재시도
 */
import axios, { AxiosInstance, AxiosError } from 'axios';
import { createModuleLogger } from '../utils/logger';
import { Candle, CandleInterval } from '../utils/types';
import { BirdeyeTrendingToken } from './birdeyeClient';

const log = createModuleLogger('GeckoTerminal');

const GECKO_BASE_URL = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';
type GeckoInterval = Exclude<CandleInterval, '5s' | '15s'>;

// Why: GeckoTerminal OHLCV uses timeframe + aggregate, Birdeye uses '5m' string
const INTERVAL_MAP: Record<GeckoInterval, { timeframe: string; aggregate: number; seconds: number }> = {
  '1m': { timeframe: 'minute', aggregate: 1, seconds: 60 },
  '5m': { timeframe: 'minute', aggregate: 5, seconds: 300 },
  '15m': { timeframe: 'minute', aggregate: 15, seconds: 900 },
  '1H': { timeframe: 'hour', aggregate: 1, seconds: 3600 },
  '4H': { timeframe: 'hour', aggregate: 4, seconds: 14400 },
};

// ─── Exported Types ───

export interface GeckoPool {
  address: string;
  name: string;
  baseTokenSymbol: string;
  baseTokenAddress: string;
  quoteTokenSymbol: string;
  quoteTokenAddress: string;
  tvlUsd: number;
  volume24hUsd: number;
  poolCreatedAt: string;
  buys24h: number;
  sells24h: number;
  fdvUsd?: number;
  marketCapUsd?: number;
  priceUsd?: number;
  priceChange24hPct?: number;
}

// ─── Raw API Response Shapes ───

interface RawPoolAttributes {
  address?: string;
  name?: string;
  pool_created_at?: string;
  reserve_in_usd?: string;
  base_token_price_usd?: string;
  volume_usd?: Record<string, string>;
  price_change_percentage?: Record<string, number>;
  transactions?: Record<string, { buys?: number; sells?: number }>;
  fdv_usd?: string;
  market_cap_usd?: string;
}

interface RawPoolRelationships {
  base_token?: { data?: { id?: string } };
  quote_token?: { data?: { id?: string } };
}

interface RawPoolData {
  id?: string;
  attributes?: RawPoolAttributes;
  relationships?: RawPoolRelationships;
}

interface RawIncludedToken {
  id?: string;
  attributes?: { symbol?: string; address?: string; name?: string };
}

interface RawTrendingResponse {
  data?: RawPoolData[];
  included?: RawIncludedToken[];
}

interface RawSinglePoolResponse {
  data?: RawPoolData;
  included?: RawIncludedToken[];
}

interface RawOHLCVResponse {
  data?: {
    attributes?: {
      ohlcv_list?: number[][];
    };
  };
}

// ─── Client ───

const RATE_LIMIT_MS = 2_500; // 보수 운영: ~24 req/min으로 headroom 확보
const RETRY_DELAY_MS = 10_000;

export class GeckoTerminalClient {
  private client: AxiosInstance;
  private lastRequestTime = 0;
  private currentRateLimitMs = RATE_LIMIT_MS;
  private requestQueue: Promise<void> = Promise.resolve();

  /** Trending 캐시 — EventMonitor + Scanner 동시 호출 시 429 방지 */
  private trendingCache: { data: BirdeyeTrendingToken[]; fetchedAt: number } | null = null;
  private trendingInFlight: Promise<BirdeyeTrendingToken[]> | null = null;
  private static readonly TRENDING_CACHE_TTL_MS = 60_000;

  constructor() {
    this.client = axios.create({
      baseURL: GECKO_BASE_URL,
      timeout: 15_000,
      headers: { Accept: 'application/json' },
    });
  }

  /**
   * OHLCV 캔들 조회 — BirdeyeClient.getOHLCV() 호환 시그니처
   * Why: Ingester가 동일한 (poolAddress, interval, timeFrom, timeTo) 시그니처로 호출
   */
  async getOHLCV(
    poolAddress: string,
    intervalType: CandleInterval,
    timeFrom: number,
    timeTo: number
  ): Promise<Candle[]> {
    const mapping = INTERVAL_MAP[intervalType as GeckoInterval];
    if (!mapping) throw new Error(`Unsupported interval: ${intervalType}`);

    const limit = Math.min(
      Math.ceil((timeTo - timeFrom) / mapping.seconds) + 1,
      1000
    );

    const data = await this.get<RawOHLCVResponse>(
      `/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${mapping.timeframe}`,
      {
        aggregate: mapping.aggregate,
        before_timestamp: timeTo,
        limit,
        currency: 'usd',
      }
    );

    const ohlcvList = data?.data?.attributes?.ohlcv_list ?? [];

    return ohlcvList
      .filter((row): row is number[] => Array.isArray(row) && row.length >= 6)
      .filter(row => row[0] >= timeFrom && row[0] <= timeTo)
      .map(row => ({
        pairAddress: poolAddress,
        timestamp: new Date(row[0] * 1000),
        intervalSec: mapping.seconds,
        open: row[1],
        high: row[2],
        low: row[3],
        close: row[4],
        volume: row[5],
        // Why: GeckoTerminal OHLCV에는 directional volume 없음
        buyVolume: 0,
        sellVolume: 0,
        tradeCount: 0,
      }))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Trending tokens — BirdeyeClient.getTrendingTokens() 호환 시그니처
   * Why: Scanner + EventMonitor가 BirdeyeTrendingToken[] 타입을 기대
   */
  async getTrendingTokens(limit = 20): Promise<BirdeyeTrendingToken[]> {
    if (this.trendingCache && Date.now() - this.trendingCache.fetchedAt < GeckoTerminalClient.TRENDING_CACHE_TTL_MS) {
      log.debug('Trending cache hit');
      return this.trendingCache.data.slice(0, limit);
    }

    if (!this.trendingInFlight) {
      this.trendingInFlight = this.fetchTrendingTokens();
    }

    try {
      const result = await this.trendingInFlight;
      return result.slice(0, limit);
    } finally {
      this.trendingInFlight = null;
    }
  }

  /**
   * Raw Trending Pools — GeckoPool[] 형태 (DexScreener enrichment용)
   */
  async getTrendingPools(): Promise<GeckoPool[]> {
    const data = await this.get<RawTrendingResponse>(
      `/networks/${NETWORK}/trending_pools`,
      { page: 1, duration: '24h', include: 'base_token,quote_token' }
    );

    if (!data?.data || !Array.isArray(data.data)) return [];

    const tokenMap = new Map<string, { symbol: string; address: string }>();
    if (Array.isArray(data.included)) {
      for (const token of data.included) {
        if (token.id && token.attributes) {
          tokenMap.set(token.id, {
            symbol: token.attributes.symbol ?? '',
            address: token.attributes.address ?? token.id.replace('solana_', ''),
          });
        }
      }
    }

    return data.data
      .map((pool): GeckoPool | null => {
        const attrs = pool.attributes;
        if (!attrs) return null;

        const baseTokenId = pool.relationships?.base_token?.data?.id;
        const quoteTokenId = pool.relationships?.quote_token?.data?.id;
        const baseToken = baseTokenId ? tokenMap.get(baseTokenId) : undefined;
        const quoteToken = quoteTokenId ? tokenMap.get(quoteTokenId) : undefined;
        const txns = attrs.transactions?.h24;

        return {
          address: attrs.address ?? pool.id?.replace('solana_', '') ?? '',
          name: attrs.name ?? '',
          baseTokenSymbol: baseToken?.symbol ?? '',
          baseTokenAddress: baseToken?.address ?? baseTokenId?.replace('solana_', '') ?? '',
          quoteTokenSymbol: quoteToken?.symbol ?? '',
          quoteTokenAddress: quoteToken?.address ?? quoteTokenId?.replace('solana_', '') ?? '',
          tvlUsd: parseFloat(attrs.reserve_in_usd ?? '0') || 0,
          volume24hUsd: parseFloat(attrs.volume_usd?.h24 ?? '0') || 0,
          poolCreatedAt: attrs.pool_created_at ?? '',
          buys24h: txns?.buys ?? 0,
          sells24h: txns?.sells ?? 0,
          fdvUsd: attrs.fdv_usd ? parseFloat(attrs.fdv_usd) : undefined,
          marketCapUsd: attrs.market_cap_usd ? parseFloat(attrs.market_cap_usd) : undefined,
          priceUsd: parseFloat(attrs.base_token_price_usd || '0') || undefined,
          priceChange24hPct: attrs.price_change_percentage?.h24 ?? undefined,
        };
      })
      .filter((p): p is GeckoPool => p !== null);
  }

  /**
   * 단일 풀 정보 조회 — UniverseEngine.fetchPoolInfo()용
   */
  async getPoolInfo(poolAddress: string): Promise<GeckoPool | null> {
    const data = await this.get<RawSinglePoolResponse>(
      `/networks/${NETWORK}/pools/${poolAddress}`,
      { include: 'base_token,quote_token' }
    );

    const attrs = data?.data?.attributes;
    if (!attrs) return null;

    const tokenMap = new Map<string, { symbol: string; address: string }>();
    if (Array.isArray(data.included)) {
      for (const token of data.included) {
        if (token.id && token.attributes) {
          tokenMap.set(token.id, {
            symbol: token.attributes.symbol ?? '',
            address: token.attributes.address ?? token.id.replace('solana_', ''),
          });
        }
      }
    }

    const baseTokenId = data.data?.relationships?.base_token?.data?.id;
    const quoteTokenId = data.data?.relationships?.quote_token?.data?.id;
    const baseToken = baseTokenId ? tokenMap.get(baseTokenId) : undefined;
    const quoteToken = quoteTokenId ? tokenMap.get(quoteTokenId) : undefined;
    const txns = attrs.transactions?.h24;

    return {
      address: attrs.address ?? poolAddress,
      name: attrs.name ?? '',
      baseTokenSymbol: baseToken?.symbol ?? '',
      baseTokenAddress: baseToken?.address ?? baseTokenId?.replace('solana_', '') ?? '',
      quoteTokenSymbol: quoteToken?.symbol ?? '',
      quoteTokenAddress: quoteToken?.address ?? quoteTokenId?.replace('solana_', '') ?? '',
      tvlUsd: parseFloat(attrs.reserve_in_usd ?? '0') || 0,
      volume24hUsd: parseFloat(attrs.volume_usd?.h24 ?? '0') || 0,
      poolCreatedAt: attrs.pool_created_at ?? '',
      buys24h: txns?.buys ?? 0,
      sells24h: txns?.sells ?? 0,
      fdvUsd: attrs.fdv_usd ? parseFloat(attrs.fdv_usd) : undefined,
      marketCapUsd: attrs.market_cap_usd ? parseFloat(attrs.market_cap_usd) : undefined,
      priceUsd: parseFloat(attrs.base_token_price_usd || '0') || undefined,
      priceChange24hPct: attrs.price_change_percentage?.h24 ?? undefined,
    };
  }

  // ─── Private ───

  private async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.enqueueRequest(async () => {
      await this.rateLimit();

      try {
        const res = await this.client.get<T>(path, { params });
        this.currentRateLimitMs = RATE_LIMIT_MS;
        return res.data;
      } catch (err) {
        if (err instanceof AxiosError && err.response?.status === 429) {
          this.currentRateLimitMs = Math.min(this.currentRateLimitMs * 2, 10_000);
          log.warn(`GeckoTerminal 429 rate limited. Backing off ${RETRY_DELAY_MS / 1000}s (next gap: ${this.currentRateLimitMs}ms)...`);
          await sleep(RETRY_DELAY_MS);
          this.lastRequestTime = Date.now();
          const res = await this.client.get<T>(path, { params });
          this.currentRateLimitMs = RATE_LIMIT_MS;
          return res.data;
        }
        throw err;
      }
    });
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.currentRateLimitMs) {
      await sleep(this.currentRateLimitMs - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  private enqueueRequest<T>(task: () => Promise<T>): Promise<T> {
    const run = this.requestQueue.then(task, task);
    this.requestQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async fetchTrendingTokens(): Promise<BirdeyeTrendingToken[]> {
    const data = await this.get<RawTrendingResponse>(
      `/networks/${NETWORK}/trending_pools`,
      { page: 1, duration: '24h', include: 'base_token,quote_token' }
    );

    if (!data?.data || !Array.isArray(data.data)) {
      this.trendingCache = { data: [], fetchedAt: Date.now() };
      return [];
    }

    const tokenMap = new Map<string, { symbol: string; address: string; name?: string }>();
    if (Array.isArray(data.included)) {
      for (const token of data.included) {
        if (token.id && token.attributes) {
          tokenMap.set(token.id, {
            symbol: token.attributes.symbol ?? '',
            address: token.attributes.address ?? token.id.replace('solana_', ''),
            name: token.attributes.name,
          });
        }
      }
    }

    const result: BirdeyeTrendingToken[] = data.data
      .map((pool, index): BirdeyeTrendingToken | null => {
        const attrs = pool.attributes;
        if (!attrs) return null;

        const baseTokenId = pool.relationships?.base_token?.data?.id;
        const baseToken = baseTokenId ? tokenMap.get(baseTokenId) : undefined;
        const address = baseToken?.address || baseTokenId?.replace('solana_', '') || '';
        if (!address) return null;

        return {
          address,
          symbol: baseToken?.symbol || attrs.name?.split('/')[0] || 'UNKNOWN',
          name: baseToken?.name || attrs.name,
          rank: index + 1,
          price: parseFloat(attrs.base_token_price_usd || '0') || undefined,
          priceChange24hPct: attrs.price_change_percentage?.h24 ?? undefined,
          volume24hUsd: parseFloat(attrs.volume_usd?.h24 || '0') || undefined,
          liquidityUsd: parseFloat(attrs.reserve_in_usd || '0') || undefined,
          marketCap: attrs.market_cap_usd ? parseFloat(attrs.market_cap_usd) : undefined,
          updatedAt: new Date().toISOString(),
          source: 'token_trending' as const,
          raw: {
            pool_address: attrs.address,
            pool_created_at: attrs.pool_created_at,
            fdv_usd: attrs.fdv_usd,
            buys_24h: attrs.transactions?.h24?.buys,
            sells_24h: attrs.transactions?.h24?.sells,
          },
        };
      })
      .filter((t): t is BirdeyeTrendingToken => t !== null);

    this.trendingCache = { data: result, fetchedAt: Date.now() };
    return result;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
