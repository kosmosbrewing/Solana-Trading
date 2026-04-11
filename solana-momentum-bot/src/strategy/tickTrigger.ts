// Why: 10s candle close 대기 없이 raw swap event마다 즉시 trigger 평가.
// 기존 VolumeMcapSpikeTrigger와 동일한 volume/buyRatio 평가 로직,
// 평가 시점만 candle close → swap arrival로 변경.
import { Signal } from '../utils/types';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('TickTrigger');
const STATS_LOG_INTERVAL_MS = 5 * 60 * 1000;

export interface SwapEntry {
  timestamp: number;    // epoch ms
  volumeSol: number;    // SOL 기준 volume
  side: 'buy' | 'sell';
  price: number;        // native price
}

export interface TickTriggerConfig {
  windowSec: number;          // rolling window 전체 (default 200s)
  burstSec: number;           // burst 구간 — 기존 candle interval 대체 (default 10s)
  volumeSurgeMultiplier: number;
  minBuyRatio: number;
  cooldownSec: number;
  sparseMinSwaps: number;     // burst window 내 최소 swap 수
  volumeMcapBoostThreshold: number;
  volumeMcapBoostMultiplier: number;
}

export interface TickTriggerRejectStats {
  evaluations: number;
  signals: number;
  insufficientSwaps: number;
  volumeInsufficient: number;
  lowBuyRatio: number;
  cooldown: number;
  volumeMcapBoosted: number;
  sparseReference: number;
}

export class TickTrigger {
  private readonly config: TickTriggerConfig;
  // Why: pool별 rolling window — raw swap 저장
  private readonly poolWindows = new Map<string, SwapEntry[]>();
  private readonly lastSignalAt = new Map<string, number>();
  private readonly poolContext = new Map<string, { marketCap?: number }>();
  private readonly stats: TickTriggerRejectStats = {
    evaluations: 0,
    signals: 0,
    insufficientSwaps: 0,
    volumeInsufficient: 0,
    lowBuyRatio: 0,
    cooldown: 0,
    volumeMcapBoosted: 0,
    sparseReference: 0,
  };
  private lastStatsLogAt = 0;

  constructor(
    config: TickTriggerConfig,
    private readonly onStatsFlush?: (stats: TickTriggerRejectStats) => void,
  ) {
    this.config = config;
  }

  setPoolContext(pairAddress: string, ctx: { marketCap?: number }): void {
    this.poolContext.set(pairAddress, ctx);
  }

  clearPoolContext(pairAddress: string): void {
    this.poolContext.delete(pairAddress);
    // Why: evicted pool의 rolling window + cooldown 정리 — 미정리 시 메모리 누수
    this.poolWindows.delete(pairAddress);
    this.lastSignalAt.delete(pairAddress);
  }

  getRejectStats(): Readonly<TickTriggerRejectStats> {
    return { ...this.stats };
  }

  /**
   * swap event마다 호출. 조건 충족 시 Signal 반환, 아니면 null.
   */
  onTick(swap: {
    pool: string;
    amountQuote: number;
    side: 'buy' | 'sell';
    priceNative: number;
    timestamp?: number;
  }): Signal | null {
    const nowMs = swap.timestamp ?? Date.now();
    const pool = swap.pool;
    const windowMs = this.config.windowSec * 1000;
    const burstMs = this.config.burstSec * 1000;

    // 1. swap을 window에 추가
    const entry: SwapEntry = {
      timestamp: nowMs,
      volumeSol: swap.amountQuote,
      side: swap.side,
      price: swap.priceNative,
    };
    let window = this.poolWindows.get(pool);
    if (!window) {
      window = [];
      this.poolWindows.set(pool, window);
    }
    window.push(entry);

    // 2. pruneWindow: windowSec 이전 swap 제거
    // Why: shift() 는 O(n) — hot path에서 splice로 일괄 제거하여 O(1) amortized
    const cutoff = nowMs - windowMs;
    let pruneIdx = 0;
    while (pruneIdx < window.length && window[pruneIdx].timestamp < cutoff) {
      pruneIdx++;
    }
    if (pruneIdx > 0) {
      window.splice(0, pruneIdx);
    }

    this.stats.evaluations++;

    // 3. burst window 내 swap 분리
    const burstCutoff = nowMs - burstMs;
    let burstVolume = 0;
    let burstBuyVolume = 0;
    let burstSwapCount = 0;
    // Why: reference는 burst 이전 구간 (windowSec - burstSec)의 per-burstSec 평균
    let referenceVolume = 0;
    let referenceCount = 0;

    for (const s of window) {
      if (s.timestamp >= burstCutoff) {
        burstVolume += s.volumeSol;
        if (s.side === 'buy') burstBuyVolume += s.volumeSol;
        burstSwapCount++;
      } else {
        referenceVolume += s.volumeSol;
        referenceCount++;
      }
    }

    // 4. sparse check: burst window 내 최소 swap 수
    if (burstSwapCount < this.config.sparseMinSwaps) {
      this.stats.insufficientSwaps++;
      this.maybeLogStats();
      return null;
    }

    // 5. reference 평균 계산
    // Why: reference 구간의 총 volume을 burstSec 단위로 정규화
    const referenceDurationSec = this.config.windowSec - this.config.burstSec;
    let referenceAvgPerBurst: number;
    if (referenceCount === 0 || referenceVolume === 0) {
      // sparse reference: 비교 대상 없음 → volume 비교 불가
      this.stats.sparseReference++;
      this.maybeLogStats();
      return null;
    }
    referenceAvgPerBurst = (referenceVolume / referenceDurationSec) * this.config.burstSec;

    // 6. volumeRatio
    const volumeRatio = burstVolume / referenceAvgPerBurst;

    // 7. effective multiplier (volumeMcap boost)
    let effectiveMultiplier = this.config.volumeSurgeMultiplier;
    const ctx = this.poolContext.get(pool);
    if (ctx?.marketCap && ctx.marketCap > 0) {
      const volumeMcapRatio = burstVolume / ctx.marketCap;
      if (volumeMcapRatio >= this.config.volumeMcapBoostThreshold) {
        effectiveMultiplier = this.config.volumeMcapBoostMultiplier;
        this.stats.volumeMcapBoosted++;
      }
    }

    if (volumeRatio < effectiveMultiplier) {
      this.stats.volumeInsufficient++;
      this.maybeLogStats();
      return null;
    }

    // 8. buyRatio
    const buyRatio = burstVolume > 0 ? burstBuyVolume / burstVolume : 0;
    if (buyRatio < this.config.minBuyRatio) {
      this.stats.lowBuyRatio++;
      this.maybeLogStats();
      return null;
    }

    // 9. cooldown
    const nowSec = Math.floor(nowMs / 1000);
    const lastSignal = this.lastSignalAt.get(pool);
    if (lastSignal && nowSec - lastSignal < this.config.cooldownSec) {
      this.stats.cooldown++;
      this.maybeLogStats();
      return null;
    }

    // 10. Signal 생성
    this.lastSignalAt.set(pool, nowSec);
    this.stats.signals++;

    const volumeMcapPct = ctx?.marketCap && ctx.marketCap > 0
      ? burstVolume / ctx.marketCap
      : undefined;

    return {
      action: 'BUY',
      strategy: 'tick_momentum',
      pairAddress: pool,
      price: swap.priceNative,
      timestamp: new Date(nowMs),
      sourceLabel: 'trigger_tick_momentum',
      // Why: atr 필드 없음 — ATR은 candle 기반 계산이라 tick 시점에는 불가.
      // handleRealtimeSignal이 candleBuilder.getRecentCandles()에서 ATR 계산하므로 order building은 정상 동작.
      meta: {
        realtimeSignal: 1,
        triggerMode: 2,           // 2 = tick mode (기존 1 = candle mode)
        primaryIntervalSec: this.config.burstSec,
        volumeRatio,
        avgVolume: referenceAvgPerBurst,
        currentVolume: burstVolume,
        buyRatio,
        burstSwapCount,
        ...(volumeMcapPct !== undefined ? { volumeMcapPct } : {}),
      },
    };
  }

  private maybeLogStats(): void {
    const now = Date.now();
    if (now - this.lastStatsLogAt < STATS_LOG_INTERVAL_MS) return;
    this.lastStatsLogAt = now;
    const s = this.stats;
    log.info(
      `[TickStats] evals=${s.evaluations} signals=${s.signals} | ` +
      `insuffSwaps=${s.insufficientSwaps} volInsuf=${s.volumeInsufficient} ` +
      `lowBuyRatio=${s.lowBuyRatio} cooldown=${s.cooldown} ` +
      `boosted=${s.volumeMcapBoosted} sparseRef=${s.sparseReference} ` +
      `pools=${this.poolWindows.size}`
    );
    if (this.onStatsFlush) {
      this.onStatsFlush(this.getRejectStats());
    }
  }
}
