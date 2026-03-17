import axios, { AxiosInstance } from 'axios';
import { createModuleLogger } from '../utils/logger';
import { Candle, CandleInterval } from '../utils/types';
import { buildDirectionalVolumeBuckets, DirectionalVolumeBucket } from './birdeyeTradeBuckets';

const log = createModuleLogger('BirdeyeClient');

const BIRDEYE_BASE_URL = 'https://public-api.birdeye.so';

const INTERVAL_TO_SECONDS: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1H': 3600,
  '4H': 14400,
};
const MAX_TXS_PER_REQUEST = 50;
const MAX_TX_PAGES = 200;

interface BirdeyeOHLCV {
  unixTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// ─── Token Security (강화) ───

export interface TokenSecurityData {
  isHoneypot: boolean;
  isFreezable: boolean;
  isMintable: boolean;
  hasTransferFee: boolean;
  freezeAuthorityPresent: boolean;
  top10HolderPct: number;
  creatorPct: number;
  ownerAddress?: string;
  creatorAddress?: string;
}

export interface ExitLiquidityData {
  exitLiquidityUsd: number | null;
  sellVolume24h: number;
  buyVolume24h: number;
  sellBuyRatio: number;
}

export interface BirdeyeTrendingToken {
  address: string;
  symbol: string;
  name?: string;
  rank: number;
  price?: number;
  priceChange24hPct?: number;
  volume24hUsd?: number;
  liquidityUsd?: number;
  marketCap?: number;
  updatedAt?: string;
  source: 'token_trending';
  raw: Record<string, unknown>;
}

export class BirdeyeClient {
  private client: AxiosInstance;

  constructor(apiKey: string) {
    this.client = axios.create({
      baseURL: BIRDEYE_BASE_URL,
      headers: {
        'X-API-KEY': apiKey,
        'x-chain': 'solana',
      },
      timeout: 15000,
    });
  }

  /**
   * OHLCV 캔들 데이터 조회
   */
  async getOHLCV(
    pairAddress: string,
    intervalType: CandleInterval,
    timeFrom: number,
    timeTo: number
  ): Promise<Candle[]> {
    try {
      const response = await this.client.get('/defi/ohlcv/pair', {
        params: {
          address: pairAddress,
          type: intervalType,
          time_from: timeFrom,
          time_to: timeTo,
        },
      });

      const items: BirdeyeOHLCV[] = response.data?.data?.items || [];
      const tradeBuckets = await this.getDirectionalVolumeBuckets(
        pairAddress,
        intervalType,
        timeFrom,
        timeTo
      );

      return items.map((item) => {
        const tradeBucket = tradeBuckets.get(item.unixTime);
        return {
          pairAddress,
          timestamp: new Date(item.unixTime * 1000),
          intervalSec: INTERVAL_TO_SECONDS[intervalType],
          open: item.o,
          high: item.h,
          low: item.l,
          close: item.c,
          volume: item.v,
          buyVolume: tradeBucket?.buyVolume || 0,
          sellVolume: tradeBucket?.sellVolume || 0,
          tradeCount: tradeBucket?.tradeCount || 0,
        };
      });
    } catch (error) {
      log.error(`Failed to fetch OHLCV for ${pairAddress}: ${error}`);
      throw error;
    }
  }

  /**
   * 토큰 메타데이터 조회 (안전 필터용)
   */
  async getTokenSecurity(tokenAddress: string): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.client.get('/defi/token_security', {
        params: { address: tokenAddress },
      });
      return response.data?.data;
    } catch (error) {
      log.error(`Failed to fetch token security for ${tokenAddress}: ${error}`);
      throw error;
    }
  }

  /**
   * 토큰 개요 조회 (TVL, 나이 등)
   */
  async getTokenOverview(tokenAddress: string): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.client.get('/defi/token_overview', {
        params: { address: tokenAddress },
      });
      return response.data?.data;
    } catch (error) {
      log.error(`Failed to fetch token overview for ${tokenAddress}: ${error}`);
      throw error;
    }
  }

  /**
   * 토큰 보안 상세 조회 (honeypot, freeze, mint, transfer fee)
   * Requires: Premium+ plan
   */
  async getTokenSecurityDetailed(tokenAddress: string): Promise<TokenSecurityData | null> {
    try {
      const response = await this.client.get('/defi/token_security', {
        params: { address: tokenAddress },
      });
      const d = response.data?.data;
      if (!d) return null;

      return {
        isHoneypot: Boolean(d.isHoneypot ?? d.is_honeypot ?? false),
        isFreezable: Boolean(d.isFreezable ?? d.is_freezable ?? d.freezeable ?? false),
        isMintable: Boolean(d.isMintable ?? d.is_mintable ?? d.mintable ?? false),
        hasTransferFee: Boolean(d.hasTransferFee ?? d.has_transfer_fee ?? d.transferFeeEnable ?? false),
        freezeAuthorityPresent: Boolean(d.freezeAuthority ?? d.freeze_authority ?? false),
        top10HolderPct: Number(d.top10HolderPercent ?? d.top10_holder_percent ?? 0),
        creatorPct: Number(d.creatorPercent ?? d.creator_percent ?? 0),
        ownerAddress: d.ownerAddress ?? d.owner_address,
        creatorAddress: d.creatorAddress ?? d.creator_address,
      };
    } catch (error) {
      log.error(`Failed to fetch token security (detailed) for ${tokenAddress}: ${error}`);
      return null;
    }
  }

  /**
   * Exit Liquidity 조회 (실제로 팔 수 있는지)
   * Requires: Premium+ plan
   */
  async getExitLiquidity(tokenAddress: string): Promise<ExitLiquidityData | null> {
    try {
      const response = await this.client.get('/defi/v3/token/exit-liquidity', {
        params: { address: tokenAddress },
      });
      const d = response.data?.data;
      if (!d) return null;

      const sellVol = Number(d.sell24hVolume ?? d.sellVolume24h ?? 0);
      const buyVol = Number(d.buy24hVolume ?? d.buyVolume24h ?? 0);

      return {
        exitLiquidityUsd: d.exitLiquidity != null ? Number(d.exitLiquidity) : null,
        sellVolume24h: sellVol,
        buyVolume24h: buyVol,
        sellBuyRatio: buyVol > 0 ? sellVol / buyVol : 0,
      };
    } catch (error) {
      // exit-liquidity may return null for unsupported tokens
      log.warn(`Exit liquidity unavailable for ${tokenAddress}: ${error}`);
      return null;
    }
  }

  async getTrendingTokens(limit = 20): Promise<BirdeyeTrendingToken[]> {
    try {
      const response = await this.client.get('/defi/token_trending', {
        params: { limit },
      });
      const items = response.data?.data?.tokens || response.data?.data?.items || response.data?.data || [];
      const rows = Array.isArray(items) ? items as Record<string, unknown>[] : [];
      return rows
        .map((item, index) => this.normalizeTrendingToken(item, index))
        .filter((item): item is BirdeyeTrendingToken => !!item);
    } catch (error) {
      log.error(`Failed to fetch Birdeye trending tokens: ${error}`);
      throw error;
    }
  }

  private async getDirectionalVolumeBuckets(
    pairAddress: string,
    intervalType: CandleInterval,
    timeFrom: number,
    timeTo: number
  ): Promise<Map<number, DirectionalVolumeBucket>> {
    try {
      const trades = await this.getPairTrades(pairAddress, timeFrom, timeTo);
      return buildDirectionalVolumeBuckets(trades, intervalType);
    } catch (error) {
      log.warn(`Directional volume unavailable for ${pairAddress}: ${error}`);
      return new Map<number, DirectionalVolumeBucket>();
    }
  }

  private async getPairTrades(
    pairAddress: string,
    timeFrom: number,
    timeTo: number
  ): Promise<Record<string, unknown>[]> {
    const trades: Record<string, unknown>[] = [];

    for (let page = 0; page < MAX_TX_PAGES; page++) {
      const offset = page * MAX_TXS_PER_REQUEST;
      const response = await this.client.get('/defi/txs/pair/seek_by_time', {
        params: {
          address: pairAddress,
          after_time: timeFrom,
          before_time: timeTo,
          offset,
          limit: MAX_TXS_PER_REQUEST,
          tx_type: 'swap',
        },
      });

      const items = response.data?.data?.items;
      const batch = Array.isArray(items) ? items as Record<string, unknown>[] : [];

      trades.push(...batch);
      if (batch.length < MAX_TXS_PER_REQUEST) break;
      if (page === MAX_TX_PAGES - 1) {
        log.warn(`Directional volume pagination capped for ${pairAddress} (${trades.length} trades fetched)`);
      }
    }

    return trades;
  }

  private normalizeTrendingToken(
    item: Record<string, unknown>,
    index: number
  ): BirdeyeTrendingToken | null {
    const address = this.pickString(
      item.address,
      item.mint,
      item.tokenAddress,
      item.token_address
    );
    const symbol = this.pickString(item.symbol, item.tokenSymbol, item.token_symbol);
    if (!address || !symbol) return null;

    const rank = this.pickNumber(item.rank, item.trendingRank, item.trending_rank) ?? index + 1;

    return {
      address,
      symbol,
      name: this.pickString(item.name, item.tokenName, item.token_name),
      rank,
      price: this.pickNumber(item.price, item.priceUsd, item.priceUSD, item.value),
      priceChange24hPct: this.pickNumber(
        item.priceChange24hPercent,
        item.price24hChangePercent,
        item.v24hChangePercent,
        item.price_change_24h_percent
      ),
      volume24hUsd: this.pickNumber(
        item.volume24hUSD,
        item.v24hUSD,
        item.volume24hUsd,
        item.volume24h
      ),
      liquidityUsd: this.pickNumber(item.liquidity, item.liquidityUsd, item.liquidityUSD),
      marketCap: this.pickNumber(item.marketCap, item.marketcap, item.mc),
      updatedAt: this.pickDate(
        item.updatedAt,
        item.lastTradeUnixTime,
        item.last_trade_unix_time,
        item.unixTime
      ),
      source: 'token_trending',
      raw: item,
    };
  }

  private pickString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return undefined;
  }

  private pickNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return undefined;
  }

  private pickDate(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string') {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        const millis = value > 1_000_000_000_000 ? value : value * 1000;
        const date = new Date(millis);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
      }
    }
    return undefined;
  }
}
