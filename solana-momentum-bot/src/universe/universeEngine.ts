import { EventEmitter } from 'events';
import { createModuleLogger } from '../utils/logger';
import { PoolInfo } from '../utils/types';
import { GeckoTerminalClient } from '../ingester/geckoTerminalClient';
import { DexScreenerClient } from '../scanner/dexScreenerClient';
import {
  UniverseParams,
  DEFAULT_UNIVERSE_PARAMS,
  staticFilter,
  dynamicFilter,
  checkPoolHealth,
} from './filters';
import { rankPools } from './ranker';

const log = createModuleLogger('UniverseEngine');

export interface UniverseEngineConfig {
  params: Partial<UniverseParams>;
  refreshIntervalMs: number;  // 5분 = 300_000
  poolAddresses?: string[];   // 초기 풀 목록 (없으면 Scanner에서 동적 추가)
}

/**
 * Universe Engine — "어떤 토큰을 감시할 것인가" 결정
 * 전략/사이징/청산은 전혀 관여하지 않음
 */
export class UniverseEngine extends EventEmitter {
  private params: UniverseParams;
  private geckoClient: GeckoTerminalClient;
  private dexScreenerClient: DexScreenerClient | null;
  private refreshIntervalMs: number;
  private watchlist: PoolInfo[] = [];
  private previousTvl: Map<string, number> = new Map();
  private refreshTimer?: NodeJS.Timeout;
  private poolAddresses: string[];

  constructor(
    geckoClient: GeckoTerminalClient,
    config: UniverseEngineConfig,
    dexScreenerClient?: DexScreenerClient | null
  ) {
    super();
    this.geckoClient = geckoClient;
    this.dexScreenerClient = dexScreenerClient ?? null;
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

  /** Scanner가 발견한 pool을 API fetch 없이 직접 추가 */
  addPoolDirect(pool: PoolInfo): void {
    if (this.isInWatchlist(pool.pairAddress)) return;
    this.watchlist.push(pool);
    this.previousTvl.set(pool.pairAddress, pool.tvl);
    log.info(`Pool added directly: ${pool.pairAddress} (tvl=${pool.tvl})`);
  }

  /** Scanner eviction 시 pool 제거 */
  removePool(pairAddress: string): void {
    this.watchlist = this.watchlist.filter(p => p.pairAddress !== pairAddress);
    this.previousTvl.delete(pairAddress);
    this.poolAddresses = this.poolAddresses.filter(a => a !== pairAddress);
  }

  /**
   * 풀 정보 조회 + 필터링 + 랭킹 → 워치리스트 갱신
   * Why: Scanner가 addPoolDirect()로 추가한 풀은 refresh에서 보존
   */
  async refresh(): Promise<void> {
    // Scanner가 추가한 풀 보존 (poolAddresses에 없는 것 = Scanner 관리)
    const scannerPools = this.watchlist.filter(
      p => !this.poolAddresses.includes(p.pairAddress)
    );

    const apiPools: PoolInfo[] = [];

    for (const addr of this.poolAddresses) {
      try {
        const pool = await this.fetchPoolInfo(addr);
        if (pool) apiPools.push(pool);
      } catch (err) {
        log.warn(`Failed to fetch pool ${addr}: ${err}`);
      }
    }

    // Static filter (API pools only — Scanner pools already vetted)
    const afterStatic = apiPools.filter(pool => {
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

    // Rank and trim — merge Scanner pools + API pools
    const ranked = rankPools(afterDynamic);
    const merged = [...scannerPools, ...ranked];
    // 중복 제거 (pairAddress 기준)
    const seen = new Set<string>();
    const deduped = merged.filter(p => {
      if (seen.has(p.pairAddress)) return false;
      seen.add(p.pairAddress);
      return true;
    });
    this.watchlist = deduped.slice(0, this.params.maxWatchlistSize);

    this.emit('watchlistUpdated', this.watchlist);
    log.info(`Watchlist updated: ${this.watchlist.length} pools (${scannerPools.length} scanner + ${ranked.length} API)`);
  }

  /**
   * 풀 정보 조회 — DexScreener (TVL, volume, age) + GeckoTerminal (spread proxy)
   * Why: Paper 모드에서는 Security Gate 비활성화이므로 security 정보 불필요
   */
  private async fetchPoolInfo(pairAddress: string): Promise<PoolInfo | null> {
    try {
      // DexScreener로 토큰 정보 조회
      if (this.dexScreenerClient) {
        const pairs = await this.dexScreenerClient.getTokenPairs(pairAddress);
        if (pairs.length > 0) {
          const pair = pairs[0];
          return {
            pairAddress,
            tokenMint: pair.baseToken.address || pairAddress,
            tvl: pair.liquidity?.usd || 0,
            marketCap: pair.marketCap,
            dailyVolume: pair.volume?.h24 || 0,
            tradeCount24h: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
            spreadPct: await this.estimateSpreadProxy(pairAddress),
            tokenAgeHours: this.calcTokenAge(pair.pairCreatedAt),
            // Why: GeckoTerminal/DexScreener은 LP burn, ownership 데이터 미제공 → null
            top10HolderPct: 0,
            lpBurned: null,
            ownershipRenounced: null,
            rankScore: 0,
          };
        }
      }

      // Fallback: GeckoTerminal pool info
      const poolInfo = await this.geckoClient.getPoolInfo(pairAddress);
      if (!poolInfo) return null;

      return {
        pairAddress,
        tokenMint: poolInfo.baseTokenAddress || pairAddress,
        tvl: poolInfo.tvlUsd,
        marketCap: poolInfo.marketCapUsd,
        dailyVolume: poolInfo.volume24hUsd,
        tradeCount24h: poolInfo.buys24h + poolInfo.sells24h,
        spreadPct: await this.estimateSpreadProxy(pairAddress),
        tokenAgeHours: this.calcTokenAgeFromISO(poolInfo.poolCreatedAt),
        top10HolderPct: 0,
        lpBurned: null,
        ownershipRenounced: null,
        rankScore: 0,
      };
    } catch {
      return null;
    }
  }

  private calcTokenAge(createdAtMs: number | undefined): number {
    if (!createdAtMs) return 999;
    return (Date.now() - createdAtMs) / (3600 * 1000);
  }

  private calcTokenAgeFromISO(createdAt: string | undefined): number {
    if (!createdAt) return 999;
    const ts = new Date(createdAt).getTime();
    if (isNaN(ts)) return 999;
    return (Date.now() - ts) / (3600 * 1000);
  }

  private async estimateSpreadProxy(pairAddress: string): Promise<number> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const candles = await this.geckoClient.getOHLCV(
        pairAddress,
        '1m',
        now - 180,
        now
      );
      if (candles.length === 0) return 0;

      const proxyValues = candles
        .slice(-3)
        .map(candle => candle.close > 0 ? Math.max(0, (candle.high - candle.low) / candle.close) : 0)
        .filter(value => Number.isFinite(value));
      if (proxyValues.length === 0) return 0;

      proxyValues.sort((a, b) => a - b);
      return proxyValues[Math.floor(proxyValues.length / 2)];
    } catch {
      return 0;
    }
  }
}
