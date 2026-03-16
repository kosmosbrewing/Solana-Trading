import axios, { AxiosInstance } from 'axios';
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
    await this.rateLimit();
    try {
      const res = await this.client.get('/token-boosts/latest/v1');
      return this.normalizeBoosts(res.data);
    } catch (error) {
      log.warn(`Failed to fetch latest boosts: ${error}`);
      return [];
    }
  }

  /** Top boosted tokens — highest total boost amount */
  async getTopBoosts(): Promise<DexScreenerBoost[]> {
    await this.rateLimit();
    try {
      const res = await this.client.get('/token-boosts/top/v1');
      return this.normalizeBoosts(res.data);
    } catch (error) {
      log.warn(`Failed to fetch top boosts: ${error}`);
      return [];
    }
  }

  /** Check if a token has paid orders/ads */
  async getTokenOrders(tokenAddress: string): Promise<DexScreenerOrder[]> {
    await this.rateLimit();
    try {
      const res = await this.client.get(`/orders/v1/solana/${tokenAddress}`);
      const items = Array.isArray(res.data) ? res.data : [];
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

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestMs;
    if (elapsed < this.minIntervalMs) {
      await new Promise(resolve => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.lastRequestMs = Date.now();
  }
}
