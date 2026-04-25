// Why: per-signal gate fetch (security data, exit liquidity) 가 1-5s 소요.
// tick mode에서 같은 토큰의 signal이 빈번하면 매번 fetch 불필요.
// TTL 기반 cache로 gate latency 제거.
import { TokenSecurityData, ExitLiquidityData } from '../ingester/onchainSecurity';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('GateCache');

export interface CachedGateResult {
  tokenSecurityData: TokenSecurityData | null;
  exitLiquidityData: ExitLiquidityData | null;
  spreadMeasurement?: { spreadPct: number; effectiveFeePct: number };
  sellImpactPct?: number;
}

interface CacheEntry {
  data: CachedGateResult;
  cachedAt: number;
}

export class GateCacheManager {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;
  /** Phase 6 P2-5/P2-6 (2026-04-25): stale fallback TTL — fresh expire 후에도 이 시간까지는
   * RPC 실패 시 stale 값 반환 가능. RPC pressure 방어 + KOL DB 확장 전제 인프라. */
  private readonly staleFallbackMs: number;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private stats = { hits: 0, misses: 0, staleFallbacks: 0 };

  constructor(ttlMs = 30_000, staleFallbackMs = 24 * 60 * 60 * 1000) {
    this.defaultTtlMs = ttlMs;
    this.staleFallbackMs = staleFallbackMs;
    // Why: 1분 주기로 만료 entry 정리 — memory leak 방지
    this.pruneTimer = setInterval(() => this.pruneExpired(), 60_000);
  }

  get(tokenMint: string): CachedGateResult | null {
    const entry = this.cache.get(tokenMint);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    if (Date.now() - entry.cachedAt > this.defaultTtlMs) {
      // Phase 6 P2-6: fresh TTL 만료 — stale fallback 호출자가 의도적으로 요청해야 함.
      // 일반 get 은 null 반환해 caller 가 fresh fetch 시도하게 함.
      this.stats.misses++;
      return null;
    }
    this.stats.hits++;
    return entry.data;
  }

  /**
   * Phase 6 P2-6: RPC fetch 실패 시 stale 값 fallback.
   * fresh TTL 만료됐어도 staleFallbackMs 내라면 마지막 cache 반환.
   */
  getStaleFallback(tokenMint: string): CachedGateResult | null {
    const entry = this.cache.get(tokenMint);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.staleFallbackMs) {
      this.cache.delete(tokenMint);
      return null;
    }
    this.stats.staleFallbacks++;
    return entry.data;
  }

  set(tokenMint: string, result: CachedGateResult): void {
    this.cache.set(tokenMint, { data: result, cachedAt: Date.now() });
  }

  invalidate(tokenMint: string): void {
    this.cache.delete(tokenMint);
  }

  pruneExpired(): void {
    const now = Date.now();
    let pruned = 0;
    // Phase 6 P2-6: prune 기준은 stale fallback TTL — fresh 만료된 entry 도 stale 까지는 보존.
    for (const [key, entry] of this.cache) {
      if (now - entry.cachedAt > this.staleFallbackMs) {
        this.cache.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) {
      log.debug(`Pruned ${pruned} expired gate cache entries, remaining=${this.cache.size}`);
    }
  }

  getStats(): { hits: number; misses: number; staleFallbacks: number; size: number; hitRate: string } {
    const total = this.stats.hits + this.stats.misses;
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      staleFallbacks: this.stats.staleFallbacks,
      size: this.cache.size,
      hitRate: total > 0 ? `${((this.stats.hits / total) * 100).toFixed(1)}%` : '0%',
    };
  }

  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.cache.clear();
  }
}
