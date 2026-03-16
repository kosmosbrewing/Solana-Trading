/**
 * GeckoTerminal API Client — 무료, API 키 불필요
 *
 * Rate limit: 30/min → 2500ms 간격 유지
 * 429 에러 시 10초 대기 후 1회 재시도
 */
import axios, { AxiosInstance, AxiosError } from 'axios';

// ─── Types ───

export interface GeckoPool {
  address: string;
  name: string;
  baseTokenSymbol: string;
  baseTokenAddress: string;
  quoteTokenSymbol: string;
  quoteTokenAddress: string;
  tvlUsd: number;
  volume24hUsd: number;
  poolCreatedAt: string; // ISO 8601
  buys24h: number;
  sells24h: number;
}

export interface GeckoOHLCVBar {
  timestamp: number;  // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface GeckoOHLCVResponse {
  poolAddress: string;
  baseTokenSymbol: string;
  baseTokenAddress: string;
  bars: GeckoOHLCVBar[];
}

// ─── Raw API Response Shapes ───

interface RawPoolAttributes {
  address?: string;
  name?: string;
  pool_created_at?: string;
  reserve_in_usd?: string;
  volume_usd?: { h24?: string };
  transactions?: { h24?: { buys?: number; sells?: number } };
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
  attributes?: { symbol?: string; address?: string };
}

interface RawTrendingResponse {
  data?: RawPoolData[];
  included?: RawIncludedToken[];
}

interface RawOHLCVResponse {
  data?: {
    attributes?: {
      ohlcv_list?: number[][];
    };
  };
  included?: RawIncludedToken[];
  meta?: { base?: { address?: string; symbol?: string } };
}

// ─── Client ───

const RATE_LIMIT_MS = 2500;
const RETRY_DELAY_MS = 10000;

export class GeckoTerminalClient {
  private client: AxiosInstance;
  private lastRequestTime = 0;
  private currentRateLimitMs = RATE_LIMIT_MS;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.geckoterminal.com/api/v2',
      timeout: 15000,
      headers: { Accept: 'application/json' },
    });
  }

  /**
   * Solana 트렌딩 풀 목록 조회
   */
  async getTrendingPools(): Promise<GeckoPool[]> {
    const data = await this.get<RawTrendingResponse>(
      '/networks/solana/trending_pools?include=base_token,quote_token&page=1'
    );

    if (!data?.data || !Array.isArray(data.data)) return [];

    // token id → symbol 매핑 (included 배열에서)
    const tokenSymbols = new Map<string, string>();
    if (Array.isArray(data.included)) {
      for (const token of data.included) {
        if (token.id && token.attributes?.symbol) {
          tokenSymbols.set(token.id, token.attributes.symbol);
        }
      }
    }

    return data.data
      .map((pool): GeckoPool | null => {
        const attrs = pool.attributes;
        if (!attrs) return null;

        const baseTokenId = pool.relationships?.base_token?.data?.id;
        const quoteTokenId = pool.relationships?.quote_token?.data?.id;

        // token ID format: "solana_<address>"
        const baseAddr = baseTokenId?.replace('solana_', '') ?? '';
        const quoteAddr = quoteTokenId?.replace('solana_', '') ?? '';
        const baseSymbol = baseTokenId ? (tokenSymbols.get(baseTokenId) ?? '') : '';
        const quoteSymbol = quoteTokenId ? (tokenSymbols.get(quoteTokenId) ?? '') : '';

        const txns = attrs.transactions?.h24;

        return {
          address: attrs.address ?? pool.id?.replace('solana_', '') ?? '',
          name: attrs.name ?? '',
          baseTokenSymbol: baseSymbol,
          baseTokenAddress: baseAddr,
          quoteTokenSymbol: quoteSymbol,
          quoteTokenAddress: quoteAddr,
          tvlUsd: parseFloat(attrs.reserve_in_usd ?? '0') || 0,
          volume24hUsd: parseFloat(attrs.volume_usd?.h24 ?? '0') || 0,
          poolCreatedAt: attrs.pool_created_at ?? '',
          buys24h: txns?.buys ?? 0,
          sells24h: txns?.sells ?? 0,
        };
      })
      .filter((p): p is GeckoPool => p !== null);
  }

  /**
   * 특정 풀의 5분봉 OHLCV 조회 (최대 1000개 ≈ 3.5일)
   */
  async getOHLCV(poolAddress: string): Promise<GeckoOHLCVResponse> {
    const data = await this.get<RawOHLCVResponse>(
      `/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=5&limit=1000&currency=usd`
    );

    const ohlcvList = data?.data?.attributes?.ohlcv_list ?? [];
    const baseAddr = data?.meta?.base?.address ?? poolAddress;
    const baseSymbol = data?.meta?.base?.symbol ?? '';

    // ohlcv_list: [[timestamp, open, high, low, close, volume], ...]
    const bars: GeckoOHLCVBar[] = ohlcvList
      .filter((row): row is number[] => Array.isArray(row) && row.length >= 6)
      .map(row => ({
        timestamp: row[0],
        open: row[1],
        high: row[2],
        low: row[3],
        close: row[4],
        volume: row[5],
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    return { poolAddress, baseTokenSymbol: baseSymbol, baseTokenAddress: baseAddr, bars };
  }

  // ─── Private ───

  private async get<T>(path: string): Promise<T> {
    await this.rateLimit();

    try {
      const res = await this.client.get<T>(path);
      // 성공 시 rate limit 원복
      this.currentRateLimitMs = RATE_LIMIT_MS;
      return res.data;
    } catch (err) {
      if (err instanceof AxiosError && err.response?.status === 429) {
        // 429 발생 시 후속 요청 간격을 2배로 증가 (최대 10초)
        this.currentRateLimitMs = Math.min(this.currentRateLimitMs * 2, 10000);
        console.warn(`[GeckoTerminal] Rate limited, retrying in ${RETRY_DELAY_MS / 1000}s (next gap: ${this.currentRateLimitMs}ms)...`);
        await sleep(RETRY_DELAY_MS);
        this.lastRequestTime = Date.now();
        const res = await this.client.get<T>(path);
        this.currentRateLimitMs = RATE_LIMIT_MS;
        return res.data;
      }
      throw err;
    }
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.currentRateLimitMs) {
      await sleep(this.currentRateLimitMs - elapsed);
    }
    this.lastRequestTime = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
