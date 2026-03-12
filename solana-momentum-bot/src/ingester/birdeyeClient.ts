import axios, { AxiosInstance } from 'axios';
import { createModuleLogger } from '../utils/logger';
import { Candle } from '../utils/types';

const log = createModuleLogger('BirdeyeClient');

const BIRDEYE_BASE_URL = 'https://public-api.birdeye.so';

interface BirdeyeOHLCV {
  unixTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
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
   * @param pairAddress DEX pool address
   * @param intervalType '1m' | '5m' | '15m' | '1H'
   * @param timeFrom Unix timestamp (seconds)
   * @param timeTo Unix timestamp (seconds)
   */
  async getOHLCV(
    pairAddress: string,
    intervalType: string,
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

      return items.map((item) => ({
        pairAddress,
        timestamp: new Date(item.unixTime * 1000),
        intervalSec: this.intervalToSeconds(intervalType),
        open: item.o,
        high: item.h,
        low: item.l,
        close: item.c,
        volume: item.v,
        tradeCount: 0, // Birdeye OHLCV에 trade count 미포함
      }));
    } catch (error) {
      log.error(`Failed to fetch OHLCV for ${pairAddress}: ${error}`);
      throw error;
    }
  }

  /**
   * 토큰 메타데이터 조회 (안전 필터용)
   */
  async getTokenSecurity(tokenAddress: string) {
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
  async getTokenOverview(tokenAddress: string) {
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

  private intervalToSeconds(interval: string): number {
    const map: Record<string, number> = {
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1H': 3600,
    };
    return map[interval] || 300;
  }
}
