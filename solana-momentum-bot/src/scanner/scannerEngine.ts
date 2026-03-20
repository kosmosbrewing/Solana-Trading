import { EventEmitter } from 'events';
import { createModuleLogger } from '../utils/logger';
import { BirdeyeClient, BirdeyeTrendingToken } from '../ingester/birdeyeClient';
import { BirdeyeWSClient, WSPriceUpdate, WSNewListingUpdate, WSNewPairUpdate } from '../ingester/birdeyeWSClient';
import { DexScreenerClient } from './dexScreenerClient';
import { calcWatchlistScore, WatchlistScoreInput, WatchlistScoreResult } from './watchlistScore';
import { SocialMentionTracker } from './socialMentionTracker';
import { PoolInfo } from '../utils/types';

const log = createModuleLogger('Scanner');

export interface WatchlistEntry {
  tokenMint: string;
  pairAddress: string;
  symbol: string;
  name?: string;
  lane: 'A' | 'B';             // A = Mature, B = Fresh
  watchlistScore: WatchlistScoreResult;
  poolInfo?: PoolInfo;
  addedAt: Date;
  lastPriceUsd?: number;
  lastUpdatedAt: Date;
}

export interface ScannerEngineConfig {
  /** Birdeye REST client */
  birdeyeClient: BirdeyeClient;
  /** Birdeye WebSocket client (optional — falls back to polling if null) */
  birdeyeWS: BirdeyeWSClient | null;
  /** DexScreener client (optional) */
  dexScreenerClient: DexScreenerClient | null;
  /** Maximum watchlist size */
  maxWatchlistSize: number;
  /** Minimum WatchlistScore to enter watchlist */
  minWatchlistScore: number;
  /** Polling interval for trending discovery (ms, fallback when WS unavailable) */
  trendingPollIntervalMs: number;
  /** DexScreener enrichment interval (ms) */
  dexEnrichIntervalMs: number;
  /** Lane A minimum token age (seconds) */
  laneAMinAgeSec: number;
  /** Lane B maximum token age (seconds) — 초신규 */
  laneBMaxAgeSec: number;
  /** Minimum liquidity USD to consider */
  minLiquidityUsd: number;
  /** H-02: Social mention tracker for WatchlistScore enrichment */
  socialMentionTracker?: SocialMentionTracker;
}

/**
 * ScannerEngine — Multi-pair 동적 watchlist 관리.
 *
 * 기능:
 *   1. Birdeye trending + WS new listing/pair → 후보 발견
 *   2. DexScreener boosts/orders → WatchlistScore 보강
 *   3. Lane A (Mature) / Lane B (Fresh) 분류
 *   4. 동적 watchlist 유지 (score 기반 eviction)
 *
 * Events:
 *   - 'watchlistUpdated' (WatchlistEntry[])
 *   - 'candidateDiscovered' (WatchlistEntry)
 *   - 'candidateEvicted' (tokenMint: string)
 */
export class ScannerEngine extends EventEmitter {
  private config: ScannerEngineConfig;
  private watchlist: Map<string, WatchlistEntry> = new Map(); // key = tokenMint
  private trendingTimer: ReturnType<typeof setInterval> | null = null;
  private dexEnrichTimer: ReturnType<typeof setInterval> | null = null;
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

  isInWatchlist(tokenMint: string): boolean {
    return this.watchlist.has(tokenMint);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log.info('Scanner starting...');

    // Wire WS events if available
    if (this.config.birdeyeWS) {
      this.config.birdeyeWS.on('price', (update: WSPriceUpdate) => this.handlePriceUpdate(update));
      this.config.birdeyeWS.on('newListing', (update: WSNewListingUpdate) => this.handleNewListing(update));
      this.config.birdeyeWS.on('newPair', (update: WSNewPairUpdate) => this.handleNewPair(update));
    }

    // Initial discovery via trending
    await this.discoverFromTrending();

    if (this.config.socialMentionTracker) {
      await this.config.socialMentionTracker.startFilteredStream().catch(
        error => log.warn(`Social filtered stream start failed: ${error}`)
      );
    }

    // Schedule recurring trending poll
    this.trendingTimer = setInterval(
      () => this.discoverFromTrending().catch(e => log.error(`Trending poll error: ${e}`)),
      this.config.trendingPollIntervalMs
    );

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
    if (this.dexEnrichTimer) { clearInterval(this.dexEnrichTimer); this.dexEnrichTimer = null; }
    this.config.socialMentionTracker?.stopFilteredStream();
    log.info('Scanner stopped.');
  }

  // ─── Discovery ───

  private async discoverFromTrending(): Promise<void> {
    try {
      const tokens = await this.config.birdeyeClient.getTrendingTokens(20);
      log.info(`Trending discovery: ${tokens.length} candidates`);

      for (const token of tokens) {
        if (!token.address || this.watchlist.has(token.address)) continue;
        if ((token.liquidityUsd ?? 0) < this.config.minLiquidityUsd) continue;

        await this.evaluateCandidate(token);
      }

      this.pruneWatchlist();
      this.emit('watchlistUpdated', this.getWatchlist());
    } catch (error) {
      log.error(`Trending discovery failed: ${error}`);
    }
  }

  private async evaluateCandidate(token: BirdeyeTrendingToken): Promise<void> {
    // H-02: SocialMentionTracker에서 social score 조회
    const socialScore = this.config.socialMentionTracker
      ? this.config.socialMentionTracker.calcSocialScore(token.address)
      : undefined;

    const scoreInput: WatchlistScoreInput = {
      trendingRank: token.rank,
      priceChange24hPct: token.priceChange24hPct,
      volume24hUsd: token.volume24hUsd,
      liquidityUsd: token.liquidityUsd,
      socialScore,
    };

    const scoreResult = calcWatchlistScore(scoreInput);

    if (scoreResult.totalScore < this.config.minWatchlistScore) {
      log.debug(`Candidate ${token.symbol} rejected: score=${scoreResult.totalScore}`);
      return;
    }

    // Determine lane based on available age info
    const lane = this.determineLane(token);
    if (!lane) return; // doesn't fit either lane

    const entry: WatchlistEntry = {
      tokenMint: token.address,
      pairAddress: token.address, // will be resolved later if pair differs
      symbol: token.symbol,
      name: token.name,
      lane,
      watchlistScore: scoreResult,
      poolInfo: {
        pairAddress: token.address,
        tokenMint: token.address,
        tvl: token.liquidityUsd ?? 0,
        marketCap: token.marketCap,
        dailyVolume: token.volume24hUsd ?? 0,
        tradeCount24h: 0,
        spreadPct: 0,
        tokenAgeHours: 0,
        top10HolderPct: 0,
        lpBurned: false,
        ownershipRenounced: false,
        rankScore: scoreResult.totalScore,
      },
      addedAt: new Date(),
      lastPriceUsd: token.price,
      lastUpdatedAt: new Date(),
    };

    this.watchlist.set(token.address, entry);
    this.config.socialMentionTracker?.registerTrackedToken(
      token.address,
      token.symbol,
      [token.name ?? '']
    );
    log.info(`+ Watchlist: ${token.symbol} lane=${lane} score=${scoreResult.totalScore} grade=${scoreResult.grade}`);

    // Subscribe to WS price feed if available
    if (this.config.birdeyeWS) {
      this.config.birdeyeWS.subscribePrice(token.address);
    }

    this.emit('candidateDiscovered', entry);
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

  // ─── WS Event Handlers ───

  private handlePriceUpdate(update: WSPriceUpdate): void {
    const entry = this.watchlist.get(update.tokenMint);
    if (!entry) return;
    entry.lastPriceUsd = update.price;
    entry.lastUpdatedAt = new Date();
  }

  private handleNewListing(update: WSNewListingUpdate): void {
    if (!update.address) return;
    if (this.watchlist.has(update.address)) return;
    if ((update.liquidity ?? 0) < this.config.minLiquidityUsd) return;

    log.info(`New listing detected: ${update.symbol ?? update.address} liq=${update.liquidity}`);

    // Create a minimal trending token to evaluate
    const token: BirdeyeTrendingToken = {
      address: update.address,
      symbol: update.symbol ?? 'UNKNOWN',
      name: update.name,
      rank: 999, // not ranked
      liquidityUsd: update.liquidity,
      source: 'token_trending',
      raw: update as unknown as Record<string, unknown>,
    };

    this.evaluateCandidate(token).catch(e =>
      log.error(`Failed to evaluate new listing ${update.address}: ${e}`)
    );
  }

  private handleNewPair(update: WSNewPairUpdate): void {
    if (!update.baseMint) return;
    if (this.watchlist.has(update.baseMint)) return;
    if ((update.liquidity ?? 0) < this.config.minLiquidityUsd) return;

    log.info(`New pair detected: ${update.pairAddress} base=${update.baseMint} liq=${update.liquidity}`);

    const token: BirdeyeTrendingToken = {
      address: update.baseMint,
      symbol: 'NEW_PAIR',
      rank: 999,
      liquidityUsd: update.liquidity,
      source: 'token_trending',
      raw: update as unknown as Record<string, unknown>,
    };

    this.evaluateCandidate(token).catch(e =>
      log.error(`Failed to evaluate new pair ${update.pairAddress}: ${e}`)
    );
  }

  // ─── DexScreener Enrichment ───

  private async enrichFromDexScreener(): Promise<void> {
    if (!this.config.dexScreenerClient) return;

    try {
      const [latestBoosts, topBoosts] = await Promise.all([
        this.config.dexScreenerClient.getLatestBoosts(),
        this.config.dexScreenerClient.getTopBoosts(),
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
          // Re-score with DexScreener data
          const orders = await this.config.dexScreenerClient!.getTokenOrders(mint);
          const updatedInput: WatchlistScoreInput = {
            trendingRank: entry.watchlistScore.components.trendingScore > 0 ? undefined : undefined,
            volume24hUsd: entry.poolInfo?.dailyVolume,
            liquidityUsd: entry.poolInfo?.tvl,
            boostAmount,
            hasPaidOrders: orders.length > 0,
          };
          entry.watchlistScore = calcWatchlistScore(updatedInput);
          entry.lastUpdatedAt = new Date();
          enriched++;
        }
      }

      // Also check for new candidates from boosts
      for (const boost of latestBoosts) {
        if (!this.watchlist.has(boost.tokenAddress) && boost.totalAmount >= 100) {
          const token: BirdeyeTrendingToken = {
            address: boost.tokenAddress,
            symbol: 'BOOSTED',
            rank: 999,
            source: 'token_trending',
            raw: boost as unknown as Record<string, unknown>,
          };
          await this.evaluateCandidate(token);
        }
      }

      if (enriched > 0) {
        log.info(`DexScreener enriched ${enriched} watchlist entries`);
        this.emit('watchlistUpdated', this.getWatchlist());
      }
    } catch (error) {
      log.warn(`DexScreener enrichment error: ${error}`);
    }
  }

  // ─── Watchlist Management ───

  private pruneWatchlist(): void {
    const maxSize = this.config.maxWatchlistSize;
    if (this.watchlist.size <= maxSize) return;

    const sorted = this.getWatchlist();
    const toRemove = sorted.slice(maxSize);

    for (const entry of toRemove) {
      this.watchlist.delete(entry.tokenMint);
      this.config.socialMentionTracker?.unregisterTrackedToken(entry.tokenMint);
      if (this.config.birdeyeWS) {
        this.config.birdeyeWS.unsubscribeAll(entry.tokenMint);
      }
      log.info(`- Watchlist evicted: ${entry.symbol} score=${entry.watchlistScore.totalScore}`);
      this.emit('candidateEvicted', entry.tokenMint);
    }
  }

  /** Manually add a pair (for backward compatibility with TARGET_PAIR_ADDRESS) */
  addManualEntry(tokenMint: string, pairAddress: string, symbol: string): void {
    if (this.watchlist.has(tokenMint)) return;

    const entry: WatchlistEntry = {
      tokenMint,
      pairAddress,
      symbol,
      lane: 'A',
      watchlistScore: {
        totalScore: 100,
        grade: 'A',
        components: { trendingScore: 30, marketingScore: 0, volumeScore: 25, liquidityScore: 15, momentumScore: 15 },
      },
      addedAt: new Date(),
      lastUpdatedAt: new Date(),
    };

    this.watchlist.set(tokenMint, entry);
    this.config.socialMentionTracker?.registerTrackedToken(tokenMint, symbol);

    if (this.config.birdeyeWS) {
      this.config.birdeyeWS.subscribePrice(tokenMint);
    }

    log.info(`+ Manual watchlist entry: ${symbol} (${tokenMint})`);
  }

  /** Update PoolInfo for a watchlist entry (called after UniverseEngine refresh) */
  updatePoolInfo(tokenMint: string, poolInfo: PoolInfo): void {
    const entry = this.watchlist.get(tokenMint);
    if (entry) {
      entry.poolInfo = poolInfo;
      entry.lastUpdatedAt = new Date();
    }
  }
}
