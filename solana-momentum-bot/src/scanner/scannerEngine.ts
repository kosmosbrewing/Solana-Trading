import { EventEmitter } from 'events';
import type { TrendingTokenProvider } from '../discovery/trendingTokenProvider';
import { createModuleLogger } from '../utils/logger';
import { BirdeyeTrendingToken } from '../ingester/birdeyeClient';
import { GeckoTerminalClient } from '../ingester/geckoTerminalClient';
import { DexScreenerClient } from './dexScreenerClient';
import {
  buildDexAdDiscoveryCandidates,
  buildDexBoostDiscoveryCandidates,
  buildDexCommunityTakeoverDiscoveryCandidates,
  buildDexProfileDiscoveryCandidates,
} from './dexBoostDiscovery';
import { calcWatchlistScore, mergeWatchlistScore, WatchlistScoreInput, WatchlistScoreResult } from './watchlistScore';
import { SocialMentionTracker } from './socialMentionTracker';
import { PoolInfo } from '../utils/types';
import { resolveAmmFeePct } from '../utils/dexFeeMap';
import { resolveCohortFromSources, type Cohort } from './cohort';

const log = createModuleLogger('Scanner');
const HOT_SOURCE_REENTRY_MULTIPLIER = 1.5;
const STABLE_SOURCE_REENTRY_MULTIPLIER = 0.5;

/**
 * calcTokenAgeHours() 가 createdAt 데이터 부재 시 반환하는 sentinel.
 * Why: cohort resolver 로 전파될 때 이 값은 실제 나이가 아니라 "미지" 를 의미하므로
 *      호출자는 sentinel 여부를 검사해 null 로 치환해야 한다. 숫자 리터럴 비교가 여러 곳으로
 *      흩어지면 추후 sentinel 변경 시 silent breakage 가 발생하기 때문에 단일 상수로 고정한다.
 */
const UNKNOWN_TOKEN_AGE_HOURS = 999;

export interface WatchlistEntry {
  tokenMint: string;
  pairAddress: string;
  dexId?: string;
  baseTokenAddress?: string;
  quoteTokenAddress?: string;
  symbol: string;
  name?: string;
  discoverySource: string;
  lane: 'A' | 'B';             // A = Mature, B = Fresh
  watchlistScore: WatchlistScoreResult;
  poolInfo?: PoolInfo;
  addedAt: Date;
  lastActivityAt?: Date;  // non-zero swap 수신 시 갱신; idle eviction 기준
  lastPriceUsd?: number;
  lastUpdatedAt: Date;
  /**
   * Phase 1 fresh-cohort instrumentation (optional).
   * Why: evaluateCandidate 시점에 age source 를 취합해 1 회 계산 후 재사용 —
   *      downstream (index.ts listeners, runtime diagnostics) hot path 에 resolver 를
   *      반복 호출하지 않기 위해.
   */
  cohort?: Cohort;
}

export interface ScannerEngineConfig {
  /** GeckoTerminal client (Birdeye 대체) */
  geckoClient: GeckoTerminalClient;
  /** Internal-first trending candidate provider */
  trendingProvider?: TrendingTokenProvider;
  /** DexScreener client (optional) */
  dexScreenerClient: DexScreenerClient | null;
  /** Maximum watchlist size */
  maxWatchlistSize: number;
  /** Minimum WatchlistScore to enter watchlist */
  minWatchlistScore: number;
  /** Polling interval for trending discovery (ms, fallback when WS unavailable) */
  trendingPollIntervalMs: number;
  /** Polling interval for Gecko new-pool discovery (ms) */
  geckoNewPoolIntervalMs: number;
  /** DexScreener discovery interval (ms) */
  dexDiscoveryIntervalMs: number;
  /** DexScreener enrichment interval (ms) */
  dexEnrichIntervalMs: number;
  /** Lane A minimum token age (seconds) */
  laneAMinAgeSec: number;
  /** Lane B maximum token age (seconds) — 초신규 */
  laneBMaxAgeSec: number;
  /** Recently evicted token re-entry cooldown (ms) */
  reentryCooldownMs?: number;
  /** Minimum residency before an auto-discovered entry can be displaced (ms) */
  minimumResidencyMs?: number;
  /** Minimum score edge required to replace an existing watchlist entry */
  replacementScoreMargin?: number;
  /** Minimum liquidity USD to consider */
  minLiquidityUsd: number;
  /** H-02: Social mention tracker for WatchlistScore enrichment */
  socialMentionTracker?: SocialMentionTracker;
  /** R3: 블랙리스트 pair 재진입 차단 — pairAddress → boolean */
  blacklistCheck?: (pairAddress: string) => boolean;
  /** Maximum idle time before auto-eviction (ms). 0 = disabled. */
  idleEvictionMs?: number;
  /** Interval for periodic idle eviction sweep (ms). Default 60_000. */
  idleEvictionSweepIntervalMs?: number;
  /** Realtime mode pre-watchlist candidate filter */
  candidateFilter?: (
    token: BirdeyeTrendingToken
  ) => { allowed: boolean; reason?: string } | Promise<{ allowed: boolean; reason?: string }>;
}

/**
 * ScannerEngine — Multi-pair 동적 watchlist 관리.
 *
 * 기능:
 *   1. Gecko trending + Dex boosts/profiles → 후보 발견
 *   2. DexScreener boosts/orders → WatchlistScore 보강
 *   3. Lane A (Mature) / Lane B (Fresh) 분류
 *   4. 동적 watchlist 유지 (score 기반 eviction)
 *
 * Events:
 *   - 'watchlistUpdated' (WatchlistEntry[])
 *   - 'candidateDiscovered' (WatchlistEntry)
 *   - 'candidateEvicted' (tokenMint: string, reason?: string, detail?: string, cohort?: Cohort)
 */
export class ScannerEngine extends EventEmitter {
  private config: ScannerEngineConfig;
  private watchlist: Map<string, WatchlistEntry> = new Map(); // key = tokenMint
  private evictedCooldowns: Map<string, number> = new Map();
  private trendingTimer: ReturnType<typeof setInterval> | null = null;
  private geckoNewPoolTimer: ReturnType<typeof setInterval> | null = null;
  private dexDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
  private dexEnrichTimer: ReturnType<typeof setInterval> | null = null;
  private blacklistEvictTimer: ReturnType<typeof setInterval> | null = null;
  private idleEvictTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: ScannerEngineConfig) {
    super();
    this.config = config;
  }

  getWatchlist(): WatchlistEntry[] {
    return Array.from(this.watchlist.values())
      .sort((a, b) => b.watchlistScore.totalScore - a.watchlistScore.totalScore);
  }

  getWatchlistByLane(lane: 'A' | 'B'): WatchlistEntry[] {
    return this.getWatchlist().filter(e => e.lane === lane);
  }

  getEntry(tokenMint: string): WatchlistEntry | undefined {
    return this.watchlist.get(tokenMint);
  }

  /**
   * pairAddress 로 WatchlistEntry 를 조회한다.
   * Why: watchlist 는 tokenMint 로 키잉되지만 strategy signal 은 pairAddress 만 들고 다닌다.
   *      signalProcessor / realtimeHandler / riskManager 는 signal 시점에 cohort 등
   *      entry metadata 를 읽어야 하므로 pair-side lookup 이 필요하다.
   *      Watchlist 크기가 bounded (수십~수백) 이므로 선형 탐색으로 충분.
   */
  getEntryByPairAddress(pairAddress: string): WatchlistEntry | undefined {
    if (!pairAddress) return undefined;
    for (const entry of this.watchlist.values()) {
      if (entry.pairAddress === pairAddress) return entry;
    }
    return undefined;
  }

  isInWatchlist(tokenMint: string): boolean {
    return this.watchlist.has(tokenMint);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log.info('Scanner starting...');

    // Initial discovery via DexScreener
    if (this.config.dexScreenerClient) {
      await this.discoverFromDexSources();
    }

    // Initial discovery via Gecko new pools
    await this.discoverFromGeckoNewPools();

    // Initial discovery via trending
    await this.discoverFromTrending();

    if (this.config.socialMentionTracker) {
      await this.config.socialMentionTracker.startFilteredStream().catch(
        error => log.warn(`Social filtered stream start failed: ${error}`)
      );
    }

    // Schedule recurring Gecko new-pool discovery
    this.geckoNewPoolTimer = setInterval(
      () => this.discoverFromGeckoNewPools().catch(e => log.error(`Gecko new pool discovery error: ${e}`)),
      this.config.geckoNewPoolIntervalMs
    );

    // Schedule recurring trending fallback poll
    this.trendingTimer = setInterval(
      () => this.discoverFromTrending().catch(e => log.error(`Trending poll error: ${e}`)),
      this.config.trendingPollIntervalMs
    );

    if (this.config.dexScreenerClient) {
      this.dexDiscoveryTimer = setInterval(
        () => this.discoverFromDexSources().catch(e => log.error(`Dex discovery error: ${e}`)),
        this.config.dexDiscoveryIntervalMs
      );
    }

    // R3: 블랙리스트 pair 주기적 제거 (5분)
    if (this.config.blacklistCheck) {
      this.blacklistEvictTimer = setInterval(
        () => this.evictBlacklistedEntries(),
        5 * 60_000
      );
    }

    // Idle eviction sweep — stale pair 자동 제거
    if ((this.config.idleEvictionMs ?? 0) > 0) {
      const sweepMs = this.config.idleEvictionSweepIntervalMs ?? 60_000;
      this.idleEvictTimer = setInterval(() => this.evictIdlePairs(), sweepMs);
    }

    // Schedule DexScreener enrichment
    if (this.config.dexScreenerClient) {
      this.dexEnrichTimer = setInterval(
        () => this.enrichFromDexScreener().catch(e => log.error(`DexScreener enrich error: ${e}`)),
        this.config.dexEnrichIntervalMs
      );
    }

    log.info(`Scanner started. Watchlist: ${this.watchlist.size} entries.`);
  }

  stop(): void {
    this.running = false;
    if (this.trendingTimer) { clearInterval(this.trendingTimer); this.trendingTimer = null; }
    if (this.geckoNewPoolTimer) { clearInterval(this.geckoNewPoolTimer); this.geckoNewPoolTimer = null; }
    if (this.dexDiscoveryTimer) { clearInterval(this.dexDiscoveryTimer); this.dexDiscoveryTimer = null; }
    if (this.dexEnrichTimer) { clearInterval(this.dexEnrichTimer); this.dexEnrichTimer = null; }
    if (this.blacklistEvictTimer) { clearInterval(this.blacklistEvictTimer); this.blacklistEvictTimer = null; }
    if (this.idleEvictTimer) { clearInterval(this.idleEvictTimer); this.idleEvictTimer = null; }
    this.config.socialMentionTracker?.stopFilteredStream();
    log.info('Scanner stopped.');
  }

  // ─── Discovery ───

  private async discoverFromTrending(): Promise<void> {
    try {
      if (!this.shouldRunTrendingDiscovery()) {
        log.debug('Trending discovery skipped: Dex sources already filled watchlist');
        return;
      }
      this.cleanupCooldowns();
      const previousMints = new Set(this.watchlist.keys());
      const tokens = await (this.config.trendingProvider ?? this.config.geckoClient).getTrendingTokens(20);
      log.info(`Trending discovery: ${tokens.length} candidates`);

      for (const token of tokens) {
        if (!token.address || this.watchlist.has(token.address)) continue;
        if ((token.liquidityUsd ?? 0) < this.config.minLiquidityUsd) continue;

        await this.evaluateCandidate(token);
      }

      this.finalizeWatchlist(previousMints);
    } catch (error) {
      log.error(`Trending discovery failed: ${error}`);
    }
  }

  private async discoverFromGeckoNewPools(): Promise<void> {
    const getNewPoolTokens = this.config.geckoClient.getNewPoolTokens?.bind(this.config.geckoClient);
    if (!getNewPoolTokens) return;

    try {
      const candidates = await getNewPoolTokens(20);
      await this.considerDiscoveryCandidates(candidates, 'Gecko new pool discovery');
    } catch (error) {
      log.warn(`Gecko new pool discovery failed: ${error}`);
    }
  }

  private shouldRunTrendingDiscovery(): boolean {
    if (!this.config.dexScreenerClient) return true;
    return this.watchlist.size < this.config.maxWatchlistSize;
  }

  private async evaluateCandidate(token: BirdeyeTrendingToken): Promise<WatchlistEntry | undefined> {
    if (!token.address || this.isCoolingDown(token.address)) {
      return undefined;
    }

    // R3: 블랙리스트 pair 재진입 차단
    const pairAddress = typeof token.raw?.pair_address === 'string'
      ? token.raw.pair_address
      : typeof token.raw?.pool_address === 'string'
        ? token.raw.pool_address
      : token.address;
    if (this.config.blacklistCheck?.(pairAddress)) {
      log.info(`Candidate ${token.symbol} skipped: pair blacklisted by edge tracker (${pairAddress})`);
      return undefined;
    }

    const candidateFilterResult = this.config.candidateFilter
      ? await this.config.candidateFilter(token)
      : undefined;
    if (candidateFilterResult && !candidateFilterResult.allowed) {
      log.info(
        `Candidate ${token.symbol} skipped pre-watchlist: ${candidateFilterResult.reason ?? 'filtered'} ` +
        `source=${this.resolveDiscoverySource(token)} ${formatCandidateFilterContext(token)}`
      );
      return undefined;
    }

    // H-02: SocialMentionTracker에서 social score 조회
    const socialScore = this.config.socialMentionTracker
      ? this.config.socialMentionTracker.calcSocialScore(token.address)
      : undefined;

    const scoreInput: WatchlistScoreInput = {
      trendingRank: token.rank,
      priceChange24hPct: token.priceChange24hPct,
      volume24hUsd: token.volume24hUsd,
      liquidityUsd: token.liquidityUsd,
      boostAmount: token.raw?.boost_total_amount as number | undefined,
      hasPaidOrders: token.raw?.has_paid_orders as boolean | undefined,
      socialScore,
      marketCap: token.marketCap,
    };

    const scoreResult = calcWatchlistScore(scoreInput);

    if (scoreResult.totalScore < this.config.minWatchlistScore) {
      log.debug(`Candidate ${token.symbol} rejected: score=${scoreResult.totalScore}`);
      return undefined;
    }

    const admissionDecision = this.getAdmissionDecision(scoreResult.totalScore);
    if (!admissionDecision.allowed) {
      const cutoffSuffix = admissionDecision.cutoff != null ? ` cutoff=${admissionDecision.cutoff}` : '';
      log.debug(
        `Candidate ${token.symbol} skipped: score=${scoreResult.totalScore} ` +
        `reason=${admissionDecision.reason ?? 'capacity'}${cutoffSuffix}`
      );
      return undefined;
    }

    // Determine lane based on available age info
    const lane = this.determineLane(token);
    if (!lane) return undefined; // doesn't fit either lane

    const tokenAgeHours = this.calcTokenAgeHours(token.raw?.pool_created_at as string | undefined);
    // Phase 1: cohort 를 evaluateCandidate 시점에 단 1 회 계산해 재사용.
    // sentinel UNKNOWN_TOKEN_AGE_HOURS → null 치환 후 resolver 에 전달 (false-mature 방지).
    const cohort = resolveCohortFromSources({
      birdeyeUpdatedAt: token.updatedAt,
      ageHours: tokenAgeHours >= UNKNOWN_TOKEN_AGE_HOURS ? null : tokenAgeHours,
    });

    const entry: WatchlistEntry = {
      tokenMint: token.address,
      pairAddress, // R3: raw.pair_address 우선, 없으면 token.address
      dexId: typeof token.raw?.dex_id === 'string' ? token.raw.dex_id : undefined,
      baseTokenAddress: typeof token.raw?.base_token_address === 'string'
        ? token.raw.base_token_address
        : token.address,
      quoteTokenAddress: typeof token.raw?.quote_token_address === 'string'
        ? token.raw.quote_token_address
        : undefined,
      symbol: token.symbol,
      name: token.name,
      discoverySource: this.resolveDiscoverySource(token),
      lane,
      cohort,
      watchlistScore: scoreResult,
      poolInfo: {
        pairAddress,
        tokenMint: token.address,
        tvl: token.liquidityUsd ?? 0,
        marketCap: token.marketCap,
        dailyVolume: token.volume24hUsd ?? 0,
        tradeCount24h: (token.raw?.buys_24h as number ?? 0) + (token.raw?.sells_24h as number ?? 0),
        spreadPct: 0,
        ammFeePct: resolveAmmFeePct(typeof token.raw?.dex_id === 'string' ? token.raw.dex_id : undefined),
        tokenAgeHours,
        top10HolderPct: 0,
        lpBurned: null,
        ownershipRenounced: null,
        rankScore: scoreResult.totalScore,
      },
      addedAt: new Date(),
      lastPriceUsd: token.price,
      lastUpdatedAt: new Date(),
    };

    this.watchlist.set(token.address, entry);
    return entry;
  }

  private determineLane(token: BirdeyeTrendingToken): 'A' | 'B' | null {
    // If we don't know the age, default to Lane A (safer)
    const updatedAt = token.updatedAt ? new Date(token.updatedAt).getTime() : 0;
    const ageSec = updatedAt > 0 ? (Date.now() - updatedAt) / 1000 : Infinity;

    if (ageSec <= this.config.laneBMaxAgeSec) {
      return 'B'; // Fresh listing
    }
    if (ageSec >= this.config.laneAMinAgeSec || ageSec === Infinity) {
      return 'A'; // Mature
    }
    return null; // in between — doesn't fit either lane
  }

  private resolveDiscoverySource(token: BirdeyeTrendingToken): string {
    const discoverySource = token.raw?.discovery_source;
    return typeof discoverySource === 'string' && discoverySource.length > 0
      ? discoverySource
      : 'gecko_trending';
  }

  // ─── DexScreener Enrichment ───

  private async enrichFromDexScreener(): Promise<void> {
    if (!this.config.dexScreenerClient) return;

    try {
      const [latestBoosts, topBoosts, latestProfiles] = await Promise.all([
        this.config.dexScreenerClient.getLatestBoosts(),
        this.config.dexScreenerClient.getTopBoosts(),
        this.config.dexScreenerClient.getLatestTokenProfiles(),
      ]);

      // Index boosts by token address
      const boostMap = new Map<string, number>();
      for (const b of [...latestBoosts, ...topBoosts]) {
        const prev = boostMap.get(b.tokenAddress) ?? 0;
        boostMap.set(b.tokenAddress, Math.max(prev, b.totalAmount));
      }

      // Enrich existing watchlist entries
      let enriched = 0;
      for (const [mint, entry] of this.watchlist) {
        const boostAmount = boostMap.get(mint);
        if (boostAmount != null && boostAmount > 0) {
          // Merge enrichment — 기존 trending/momentum/social 점수 보존
          const orders = await this.config.dexScreenerClient!.getTokenOrders(mint);
          entry.watchlistScore = mergeWatchlistScore(entry.watchlistScore, {
            volume24hUsd: entry.poolInfo?.dailyVolume,
            liquidityUsd: entry.poolInfo?.tvl,
            boostAmount,
            hasPaidOrders: orders.length > 0,
            marketCap: entry.poolInfo?.marketCap,
          });
          entry.lastUpdatedAt = new Date();
          enriched++;
        }
      }

      await this.considerDexBoostCandidates([...latestBoosts, ...topBoosts]);
      await this.considerDexProfileCandidates(latestProfiles);

      if (enriched > 0) {
        log.info(`DexScreener enriched ${enriched} watchlist entries`);
        this.emit('watchlistUpdated', this.getWatchlist());
      }
    } catch (error) {
      log.warn(`DexScreener enrichment error: ${error}`);
    }
  }

  private async discoverFromDexSources(): Promise<void> {
    await this.discoverFromDexBoosts();
    await this.discoverFromDexProfiles();
    await this.discoverFromDexCommunityTakeovers();
    await this.discoverFromDexAds();
  }

  private async discoverFromDexBoosts(): Promise<void> {
    if (!this.config.dexScreenerClient) return;

    try {
      const [latestBoosts, topBoosts] = await Promise.all([
        this.config.dexScreenerClient.getLatestBoosts(),
        this.config.dexScreenerClient.getTopBoosts(),
      ]);
      await this.considerDexBoostCandidates([...latestBoosts, ...topBoosts]);
    } catch (error) {
      log.warn(`Dex boost discovery failed: ${error}`);
    }
  }

  private async discoverFromDexProfiles(): Promise<void> {
    if (!this.config.dexScreenerClient) return;

    try {
      const latestProfiles = await this.config.dexScreenerClient.getLatestTokenProfiles();
      await this.considerDexProfileCandidates(latestProfiles);
    } catch (error) {
      log.warn(`Dex profile discovery failed: ${error}`);
    }
  }

  private async discoverFromDexCommunityTakeovers(): Promise<void> {
    if (!this.config.dexScreenerClient) return;

    try {
      const takeovers = await this.config.dexScreenerClient.getLatestCommunityTakeovers();
      if (takeovers.length === 0) return;
      const candidates = await buildDexCommunityTakeoverDiscoveryCandidates(
        this.config.dexScreenerClient,
        takeovers,
        5
      );
      await this.considerDiscoveryCandidates(candidates, 'Dex community takeover discovery');
    } catch (error) {
      log.warn(`Dex community takeover discovery failed: ${error}`);
    }
  }

  private async discoverFromDexAds(): Promise<void> {
    if (!this.config.dexScreenerClient) return;

    try {
      const ads = await this.config.dexScreenerClient.getLatestAds();
      if (ads.length === 0) return;
      const candidates = await buildDexAdDiscoveryCandidates(
        this.config.dexScreenerClient,
        ads,
        5
      );
      await this.considerDiscoveryCandidates(candidates, 'Dex ad discovery');
    } catch (error) {
      log.warn(`Dex ad discovery failed: ${error}`);
    }
  }

  private async considerDexBoostCandidates(boosts: import('./dexScreenerClient').DexScreenerBoost[]): Promise<void> {
    if (!this.config.dexScreenerClient || boosts.length === 0) return;

    const candidates = await buildDexBoostDiscoveryCandidates(
      this.config.dexScreenerClient,
      boosts
    );
    await this.considerDiscoveryCandidates(candidates, 'Dex boost discovery');
  }

  private async considerDexProfileCandidates(
    profiles: import('./dexScreenerClient').DexScreenerTokenProfile[]
  ): Promise<void> {
    if (!this.config.dexScreenerClient || profiles.length === 0) return;

    const candidates = await buildDexProfileDiscoveryCandidates(
      this.config.dexScreenerClient,
      profiles,
      5
    );
    await this.considerDiscoveryCandidates(candidates, 'Dex profile discovery');
  }

  private async considerDiscoveryCandidates(
    candidates: BirdeyeTrendingToken[],
    label: string
  ): Promise<void> {
    const previousMints = new Set(this.watchlist.keys());
    let discovered = 0;
    for (const token of candidates) {
      if (this.watchlist.has(token.address)) continue;
      if ((token.liquidityUsd ?? 0) < this.config.minLiquidityUsd) continue;
      const entry = await this.evaluateCandidate(token);
      if (entry) discovered += 1;
    }
    if (discovered > 0) {
      log.info(`${label}: ${discovered} new candidates`);
      this.finalizeWatchlist(previousMints);
    }
  }

  // ─── Watchlist Management ───

  private pruneWatchlist(): void {
    const maxSize = this.config.maxWatchlistSize;
    if (this.watchlist.size <= maxSize) return;

    const overflowCount = this.watchlist.size - maxSize;
    const evictableEntries = this.getWatchlist().filter((entry) => !this.isResidencyProtected(entry));
    const toRemove = evictableEntries.slice(-overflowCount);

    for (const entry of toRemove) {
      this.watchlist.delete(entry.tokenMint);
      this.markEvicted(entry);
      this.config.socialMentionTracker?.unregisterTrackedToken(entry.tokenMint);
      log.info(`- Watchlist evicted: ${entry.symbol} score=${entry.watchlistScore.totalScore}`);
      this.emit(
        'candidateEvicted',
        entry.tokenMint,
        'score',
        `score=${entry.watchlistScore.totalScore}|lane=${entry.lane}|source=${entry.discoverySource}`,
        entry.cohort
      );
    }
  }

  /** Manually add a pair (for backward compatibility with TARGET_PAIR_ADDRESS) */
  addManualEntry(tokenMint: string, pairAddress: string, symbol: string): void {
    if (this.watchlist.has(tokenMint)) return;

    const entry: WatchlistEntry = {
      tokenMint,
      pairAddress,
      symbol,
      discoverySource: 'manual',
      lane: 'A',
      watchlistScore: {
        totalScore: 100,
        grade: 'A',
        components: { trendingScore: 30, marketingScore: 0, volumeScore: 25, liquidityScore: 15, momentumScore: 15, volMcapScore: 0 },
      },
      addedAt: new Date(),
      lastUpdatedAt: new Date(),
    };

    this.watchlist.set(tokenMint, entry);
    this.activateCandidate(entry);
    log.info(`+ Manual watchlist entry: ${symbol} (${tokenMint})`);
  }

  /**
   * ISO 8601 pool_created_at → 시간 단위 나이.
   * createdAt 미제공/파싱 실패 시 UNKNOWN_TOKEN_AGE_HOURS 반환 — 호출자는
   * 이 sentinel 을 null 로 치환해 cohort resolver 가 'unknown' 으로 분류하도록 해야 한다.
   */
  private calcTokenAgeHours(createdAt?: string): number {
    if (!createdAt) return UNKNOWN_TOKEN_AGE_HOURS;
    const ts = new Date(createdAt).getTime();
    if (isNaN(ts)) return UNKNOWN_TOKEN_AGE_HOURS;
    return (Date.now() - ts) / (3600 * 1000);
  }

  /** Update PoolInfo for a watchlist entry (called after UniverseEngine refresh) */
  updatePoolInfo(tokenMint: string, poolInfo: PoolInfo): void {
    const entry = this.watchlist.get(tokenMint);
    if (entry) {
      entry.poolInfo = poolInfo;
      entry.lastUpdatedAt = new Date();
    }
  }

  private async considerCandidate(token: BirdeyeTrendingToken): Promise<void> {
    this.cleanupCooldowns();
    const previousMints = new Set(this.watchlist.keys());
    const entry = await this.evaluateCandidate(token);
    if (!entry) return;
    this.finalizeWatchlist(previousMints);
  }

  private finalizeWatchlist(previousMints: Set<string>): void {
    this.pruneWatchlist();

    for (const entry of this.getWatchlist()) {
      if (!previousMints.has(entry.tokenMint)) {
        this.activateCandidate(entry);
      }
    }

    this.emit('watchlistUpdated', this.getWatchlist());
  }

  private activateCandidate(entry: WatchlistEntry): void {
    this.config.socialMentionTracker?.registerTrackedToken(
      entry.tokenMint,
      entry.symbol,
      [entry.name ?? '']
    );

    log.info(
      `+ Watchlist: ${entry.symbol} source=${entry.discoverySource} lane=${entry.lane} ` +
      `score=${entry.watchlistScore.totalScore} grade=${entry.watchlistScore.grade}`
    );
    this.emit('candidateDiscovered', entry);
  }

  private getAdmissionDecision(score: number): { allowed: boolean; reason?: string; cutoff?: number } {
    if (this.watchlist.size < this.config.maxWatchlistSize) {
      return { allowed: true };
    }

    const weakest = this.getWeakestEvictableEntry();
    if (!weakest) {
      return { allowed: false, reason: 'minimum_residency' };
    }

    const cutoff = weakest.watchlistScore.totalScore + (this.config.replacementScoreMargin ?? 0);
    if (score < cutoff) {
      return { allowed: false, reason: 'replacement_margin', cutoff };
    }

    return { allowed: true, cutoff };
  }

  private isCoolingDown(tokenMint: string): boolean {
    const until = this.evictedCooldowns.get(tokenMint);
    if (!until) return false;
    if (until <= Date.now()) {
      this.evictedCooldowns.delete(tokenMint);
      return false;
    }
    return true;
  }

  private markEvicted(entry: WatchlistEntry): void {
    const cooldownMs = this.getReentryCooldownMs(entry.discoverySource);
    if (cooldownMs <= 0) return;
    this.evictedCooldowns.set(entry.tokenMint, Date.now() + cooldownMs);
  }

  private cleanupCooldowns(): void {
    const now = Date.now();
    for (const [tokenMint, until] of this.evictedCooldowns) {
      if (until <= now) {
        this.evictedCooldowns.delete(tokenMint);
      }
    }
  }

  private getWeakestEvictableEntry(): WatchlistEntry | undefined {
    return this.getWatchlist()
      .filter((entry) => !this.isResidencyProtected(entry))
      .at(-1);
  }

  private isResidencyProtected(entry: WatchlistEntry): boolean {
    const minimumResidencyMs = this.config.minimumResidencyMs ?? 0;
    if (minimumResidencyMs <= 0 || entry.discoverySource === 'manual') {
      return false;
    }
    return Date.now() - entry.addedAt.getTime() < minimumResidencyMs;
  }

  private getReentryCooldownMs(discoverySource: string): number {
    const baseCooldownMs = this.config.reentryCooldownMs ?? 0;
    if (baseCooldownMs <= 0 || discoverySource === 'manual') {
      return 0;
    }

    if (discoverySource === 'internal_activity') {
      return Math.round(baseCooldownMs * STABLE_SOURCE_REENTRY_MULTIPLIER);
    }
    if (
      discoverySource === 'gecko_new_pool' ||
      discoverySource === 'dex_boost' ||
      discoverySource === 'dex_ad' ||
      discoverySource === 'dex_community_takeover'
    ) {
      return Math.round(baseCooldownMs * HOT_SOURCE_REENTRY_MULTIPLIER);
    }

    return baseCooldownMs;
  }

  /**
   * R3: watchlist 내 블랙리스트 pair를 제거한다.
   * 주기적으로 호출되어 슬롯 점유를 방지한다.
   */
  evictBlacklistedEntries(): number {
    if (!this.config.blacklistCheck) return 0;
    let evicted = 0;
    for (const [tokenMint, entry] of this.watchlist) {
      if (this.config.blacklistCheck(entry.pairAddress)) {
        this.watchlist.delete(tokenMint);
        this.config.socialMentionTracker?.unregisterTrackedToken(tokenMint);
        log.info(`- Watchlist blacklist evict: ${entry.symbol} pair=${entry.pairAddress}`);
        this.emit('candidateEvicted', tokenMint, 'blacklist', `pair=${entry.pairAddress}`, entry.cohort);
        evicted++;
      }
    }
    if (evicted > 0) {
      this.emit('watchlistUpdated', this.getWatchlist());
    }
    return evicted;
  }

  /** non-zero swap 시 activity timestamp 갱신 */
  updateActivity(tokenMint: string): void {
    const entry = this.watchlist.get(tokenMint);
    if (entry) {
      entry.lastActivityAt = new Date();
    }
  }

  /** staleness 기반 idle pair eviction — sweep timer에서 호출 */
  evictIdlePairs(): number {
    const idleEvictionMs = this.config.idleEvictionMs ?? 0;
    if (idleEvictionMs <= 0) return 0;

    const now = Date.now();
    let evicted = 0;

    for (const [tokenMint, entry] of this.watchlist) {
      if (this.isResidencyProtected(entry)) continue;
      if (entry.discoverySource === 'manual') continue;

      const lastActive = entry.lastActivityAt?.getTime() ?? entry.addedAt.getTime();
      if (now - lastActive >= idleEvictionMs) {
        this.watchlist.delete(tokenMint);
        this.markEvicted(entry);
        this.config.socialMentionTracker?.unregisterTrackedToken(tokenMint);
        log.info(`- Watchlist idle evict: ${entry.symbol} idle=${Math.round((now - lastActive) / 1000)}s`);
        const lastActivityAt = entry.lastActivityAt ?? entry.addedAt;
        this.emit(
          'candidateEvicted',
          tokenMint,
          'idle',
          `idleSec=${Math.round((now - lastActive) / 1000)}|lastActivityAt=${lastActivityAt.toISOString()}`,
          entry.cohort
        );
        evicted++;
      }
    }

    if (evicted > 0) {
      this.emit('watchlistUpdated', this.getWatchlist());
    }
    return evicted;
  }
}

function formatCandidateFilterContext(token: BirdeyeTrendingToken): string {
  const dexId = typeof token.raw?.dex_id === 'string' ? token.raw.dex_id : undefined;
  const quoteTokenAddress =
    typeof token.raw?.quote_token_address === 'string' ? token.raw.quote_token_address : undefined;
  const parts = [];
  if (dexId) parts.push(`dexId=${dexId}`);
  if (quoteTokenAddress) parts.push(`quote=${quoteTokenAddress}`);
  return parts.join(' ');
}
