import { EventEmitter } from 'events';
import { createModuleLogger } from '../utils/logger';
import { PoolInfo } from '../utils/types';
import { BirdeyeClient } from '../ingester/birdeyeClient';
import {
  UniverseParams,
  DEFAULT_UNIVERSE_PARAMS,
  staticFilter,
  dynamicFilter,
  checkPoolHealth,
  PoolEvent,
} from './filters';
import { rankPools } from './ranker';

const log = createModuleLogger('UniverseEngine');

export interface UniverseEngineConfig {
  params: Partial<UniverseParams>;
  refreshIntervalMs: number;  // 5분 = 300_000
  poolAddresses?: string[];   // 초기 풀 목록 (없으면 BirdeyeAPI에서 탐색)
}

/**
 * Universe Engine — "어떤 토큰을 감시할 것인가" 결정
 * 전략/사이징/청산은 전혀 관여하지 않음
 */
export class UniverseEngine extends EventEmitter {
  private params: UniverseParams;
  private birdeyeClient: BirdeyeClient;
  private refreshIntervalMs: number;
  private watchlist: PoolInfo[] = [];
  private previousTvl: Map<string, number> = new Map();
  private refreshTimer?: NodeJS.Timeout;
  private poolAddresses: string[];

  constructor(birdeyeClient: BirdeyeClient, config: UniverseEngineConfig) {
    super();
    this.birdeyeClient = birdeyeClient;
    this.params = { ...DEFAULT_UNIVERSE_PARAMS, ...config.params };
    this.refreshIntervalMs = config.refreshIntervalMs;
    this.poolAddresses = config.poolAddresses || [];
  }

  async start(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(err => {
        log.error(`Universe refresh failed: ${err}`);
        this.emit('error', err);
      });
    }, this.refreshIntervalMs);
    log.info(`UniverseEngine started (refresh every ${this.refreshIntervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  getWatchlist(): PoolInfo[] {
    return [...this.watchlist];
  }

  isInWatchlist(pairAddress: string): boolean {
    return this.watchlist.some(p => p.pairAddress === pairAddress);
  }

  /**
   * 풀 정보 조회 + 필터링 + 랭킹 → 워치리스트 갱신
   */
  async refresh(): Promise<void> {
    const allPools: PoolInfo[] = [];

    for (const addr of this.poolAddresses) {
      try {
        const pool = await this.fetchPoolInfo(addr);
        if (pool) allPools.push(pool);
      } catch (err) {
        log.warn(`Failed to fetch pool ${addr}: ${err}`);
      }
    }

    // Static filter
    const afterStatic = allPools.filter(pool => {
      const result = staticFilter(pool, this.params);
      if (!result.pass) log.debug(`Static filter rejected ${pool.pairAddress}: ${result.reason}`);
      return result.pass;
    });

    // Dynamic filter
    const afterDynamic = afterStatic.filter(pool => {
      const result = dynamicFilter(pool, this.params);
      if (!result.pass) log.debug(`Dynamic filter rejected ${pool.pairAddress}: ${result.reason}`);
      return result.pass;
    });

    // Health check (pool event detection)
    for (const pool of afterDynamic) {
      const prevTvl = this.previousTvl.get(pool.pairAddress) || pool.tvl;
      const event = checkPoolHealth(pool, prevTvl, this.params);
      if (event) {
        this.emit('poolEvent', event);
        log.warn(`Pool event: ${event.type} on ${event.pairAddress} — ${event.detail}`);
      }
      this.previousTvl.set(pool.pairAddress, pool.tvl);
    }

    // Rank and trim
    const ranked = rankPools(afterDynamic);
    this.watchlist = ranked.slice(0, this.params.maxWatchlistSize);

    this.emit('watchlistUpdated', this.watchlist);
    log.info(`Watchlist updated: ${this.watchlist.length} pools (from ${allPools.length} total)`);
  }

  private async fetchPoolInfo(pairAddress: string): Promise<PoolInfo | null> {
    try {
      const overview = await this.birdeyeClient.getTokenOverview(pairAddress);
      if (!overview) return null;

      const security = await this.birdeyeClient.getTokenSecurity(pairAddress);

      return {
        pairAddress,
        tokenMint: (overview.address as string) || pairAddress,
        tvl: Number(overview.liquidity || 0),
        dailyVolume: Number(overview.v24hUSD || 0),
        tradeCount24h: Number(overview.trade24h || 0),
        spreadPct: 0, // Birdeye doesn't directly provide this
        tokenAgeHours: this.calcTokenAge(overview.createdAt as number | undefined),
        top10HolderPct: Number(security?.top10HolderPercent || 0),
        lpBurned: !!(security?.isLpBurned),
        ownershipRenounced: !!(security?.isOwnerRenounced),
        rankScore: 0,
      };
    } catch {
      return null;
    }
  }

  private calcTokenAge(createdAtUnix: number | undefined): number {
    if (!createdAtUnix) return 999;
    return (Date.now() / 1000 - createdAtUnix) / 3600;
  }
}
