import axios, { AxiosError, AxiosInstance } from 'axios';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('DexScreener');

const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com';

export interface DexScreenerBoost {
  tokenAddress: string;
  chainId: string;
  amount: number;
  totalAmount: number;
  icon?: string;
  description?: string;
  url?: string;
}

export interface DexScreenerOrder {
  type: string;
  status: string;
  paymentTimestamp?: number;
}

/** Token pair data from /latest/dex/tokens endpoint */
export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: number;
  liquidity: { usd: number; base: number; quote: number };
  volume: { h1?: number; h6?: number; h24?: number };
  priceChange: { h1?: number; h6?: number; h24?: number };
  txns: { h1?: { buys: number; sells: number }; h24?: { buys: number; sells: number } };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number; // Unix ms
}

export class DexScreenerClient {
  private client: AxiosInstance;
  private lastRequestMs = 0;
  private readonly minIntervalMs = 1_100; // ~60 req/min

  constructor(apiKey?: string) {
    const headers: Record<string, string> = {};
    if (apiKey) headers['X-API-KEY'] = apiKey;
    this.client = axios.create({
      baseURL: DEXSCREENER_BASE_URL,
      headers,
      timeout: 10_000,
    });
  }

  /** Latest boosted tokens — marketing intensity feature */
  async getLatestBoosts(): Promise<DexScreenerBoost[]> {
    try {
      const data = await this.getWithRetry('/token-boosts/latest/v1');
      return this.normalizeBoosts(data);
    } catch (error) {
      log.warn(`Failed to fetch latest boosts: ${error}`);
      return [];
    }
  }

  /** Top boosted tokens — highest total boost amount */
  async getTopBoosts(): Promise<DexScreenerBoost[]> {
    try {
      const data = await this.getWithRetry('/token-boosts/top/v1');
      return this.normalizeBoosts(data);
    } catch (error) {
      log.warn(`Failed to fetch top boosts: ${error}`);
      return [];
    }
  }

  /** Check if a token has paid orders/ads */
  async getTokenOrders(tokenAddress: string): Promise<DexScreenerOrder[]> {
    try {
      const data = await this.getWithRetry(`/orders/v1/solana/${tokenAddress}`);
      const items = Array.isArray(data) ? data : [];
      return items.map((o: Record<string, unknown>) => ({
        type: String(o.type ?? ''),
        status: String(o.status ?? ''),
        paymentTimestamp: o.paymentTimestamp != null ? Number(o.paymentTimestamp) : undefined,
      }));
    } catch (error) {
      log.debug(`No paid orders for ${tokenAddress}`);
      return [];
    }
  }

  /**
   * Token mint → pair 데이터 조회 (최대 30개 배치)
   * Why: GeckoTerminal은 pool address 기반이므로, token mint → pool 매핑 필요
   */
  async getTokenPairs(tokenAddress: string): Promise<DexScreenerPair[]> {
    try {
      const data = await this.getWithRetry<{ pairs?: Record<string, unknown>[] }>(
        `/latest/dex/tokens/${tokenAddress}`
      );
      const pairs = data?.pairs;
      if (!Array.isArray(pairs)) return [];

      return pairs
        .filter((p: Record<string, unknown>) => p.chainId === 'solana')
        .map((p: Record<string, unknown>) => this.normalizePair(p))
        .filter((p): p is DexScreenerPair => p !== null);
    } catch (error) {
      log.warn(`Failed to fetch token pairs for ${tokenAddress}: ${error}`);
      return [];
    }
  }

  /**
   * 배치 Token pairs 조회 — 최대 30개 token address를 콤마로 연결
   */
  async getTokenPairsBatch(tokenAddresses: string[]): Promise<Map<string, DexScreenerPair[]>> {
    const result = new Map<string, DexScreenerPair[]>();
    // DexScreener는 한 번에 1개 토큰만 조회 가능하므로 순차 호출
    for (const addr of tokenAddresses) {
      const pairs = await this.getTokenPairs(addr);
      if (pairs.length > 0) result.set(addr, pairs);
    }
    return result;
  }

  /**
   * Token의 최고 유동성 Solana pair 주소 반환
   * Why: Ingester가 GeckoTerminal OHLCV를 호출하려면 pool address 필요
   */
  async getBestPoolAddress(tokenMint: string): Promise<string | null> {
    const pairs = await this.getTokenPairs(tokenMint);
    if (pairs.length === 0) return null;
    // 유동성 최고인 pair 선택
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs[0].pairAddress;
  }

  private normalizePair(p: Record<string, unknown>): DexScreenerPair | null {
    const baseToken = p.baseToken as Record<string, unknown> | undefined;
    const quoteToken = p.quoteToken as Record<string, unknown> | undefined;
    const liquidity = p.liquidity as Record<string, unknown> | undefined;
    const volume = p.volume as Record<string, unknown> | undefined;
    const priceChange = p.priceChange as Record<string, unknown> | undefined;
    const txns = p.txns as Record<string, Record<string, unknown>> | undefined;

    if (!baseToken?.address) return null;

    return {
      chainId: String(p.chainId ?? 'solana'),
      dexId: String(p.dexId ?? ''),
      pairAddress: String(p.pairAddress ?? ''),
      baseToken: {
        address: String(baseToken.address ?? ''),
        name: String(baseToken.name ?? ''),
        symbol: String(baseToken.symbol ?? ''),
      },
      quoteToken: {
        address: String(quoteToken?.address ?? ''),
        name: String(quoteToken?.name ?? ''),
        symbol: String(quoteToken?.symbol ?? ''),
      },
      priceUsd: Number(p.priceUsd ?? 0),
      liquidity: {
        usd: Number(liquidity?.usd ?? 0),
        base: Number(liquidity?.base ?? 0),
        quote: Number(liquidity?.quote ?? 0),
      },
      volume: {
        h1: volume?.h1 != null ? Number(volume.h1) : undefined,
        h6: volume?.h6 != null ? Number(volume.h6) : undefined,
        h24: volume?.h24 != null ? Number(volume.h24) : undefined,
      },
      priceChange: {
        h1: priceChange?.h1 != null ? Number(priceChange.h1) : undefined,
        h6: priceChange?.h6 != null ? Number(priceChange.h6) : undefined,
        h24: priceChange?.h24 != null ? Number(priceChange.h24) : undefined,
      },
      txns: {
        h1: txns?.h1 ? { buys: Number(txns.h1.buys ?? 0), sells: Number(txns.h1.sells ?? 0) } : undefined,
        h24: txns?.h24 ? { buys: Number(txns.h24.buys ?? 0), sells: Number(txns.h24.sells ?? 0) } : undefined,
      },
      fdv: p.fdv != null ? Number(p.fdv) : undefined,
      marketCap: p.marketCap != null ? Number(p.marketCap) : undefined,
      pairCreatedAt: p.pairCreatedAt != null ? Number(p.pairCreatedAt) : undefined,
    };
  }

  private normalizeBoosts(data: unknown): DexScreenerBoost[] {
    const items = Array.isArray(data) ? data : [];
    return items
      .filter((b: Record<string, unknown>) => b.chainId === 'solana')
      .map((b: Record<string, unknown>) => ({
        tokenAddress: String(b.tokenAddress ?? ''),
        chainId: 'solana',
        amount: Number(b.amount ?? 0),
        totalAmount: Number(b.totalAmount ?? b.amount ?? 0),
        icon: b.icon as string | undefined,
        description: b.description as string | undefined,
        url: b.url as string | undefined,
      }));
  }

  /**
   * M-19: 429 감지 시 자동 backoff + retry (최대 1회)
   */
  private async getWithRetry<T>(path: string): Promise<T | null> {
    await this.rateLimit();
    try {
      const res = await this.client.get<T>(path);
      return res.data;
    } catch (err) {
      if (err instanceof AxiosError && err.response?.status === 429) {
        const retryAfter = Number(err.response.headers['retry-after'] || 5) * 1000;
        log.warn(`DexScreener 429 rate limited. Backing off ${retryAfter}ms...`);
        await new Promise(r => setTimeout(r, retryAfter));
        this.lastRequestMs = Date.now();
        try {
          const res = await this.client.get<T>(path);
          return res.data;
        } catch (retryErr) {
          log.warn(`DexScreener retry failed: ${retryErr}`);
          return null;
        }
      }
      throw err;
    }
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestMs;
    if (elapsed < this.minIntervalMs) {
      await new Promise(resolve => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.lastRequestMs = Date.now();
  }
}
