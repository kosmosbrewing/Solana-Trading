import { Signal } from '../utils/types';

export interface StaleCheckConfig {
  maxAgeMs: number;         // 시그널 최대 유효 시간 (default: 10초)
  maxPriceDeviation: number; // 최대 가격 이탈률 (default: 0.01 = 1%)
  maxSpreadMultiplier: number; // 스프레드 급등 배수 (default: 2.0)
  maxTvlDrop: number;       // TVL 최대 감소율 (default: 0.10 = 10%)
}

const DEFAULT_CONFIG: StaleCheckConfig = {
  maxAgeMs: 10_000,
  maxPriceDeviation: 0.01,
  maxSpreadMultiplier: 2.0,
  maxTvlDrop: 0.10,
};

export interface StaleCheckInput {
  signal: Signal;
  currentPrice: number;
  currentSpread?: number;
  currentTvl?: number;
}

export interface StaleCheckResult {
  isStale: boolean;
  reason?: string;
}

/**
 * Stale Signal 판정 — 순수 함수
 */
export function checkStaleSignal(
  input: StaleCheckInput,
  config: Partial<StaleCheckConfig> = {}
): StaleCheckResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { signal, currentPrice, currentSpread, currentTvl } = input;

  // 1. 시간 경과 체크
  const age = Date.now() - signal.timestamp.getTime();
  if (age > cfg.maxAgeMs) {
    return { isStale: true, reason: `Signal age ${age}ms exceeds ${cfg.maxAgeMs}ms limit` };
  }

  // 2. 가격 이탈 체크
  const priceDeviation = Math.abs(currentPrice - signal.price) / signal.price;
  if (priceDeviation > cfg.maxPriceDeviation) {
    return {
      isStale: true,
      reason: `Price deviation ${(priceDeviation * 100).toFixed(2)}% exceeds ${(cfg.maxPriceDeviation * 100)}% limit`,
    };
  }

  // 3. 스프레드 급등 체크
  if (currentSpread !== undefined && signal.spreadPct !== undefined && signal.spreadPct > 0) {
    if (currentSpread > signal.spreadPct * cfg.maxSpreadMultiplier) {
      return {
        isStale: true,
        reason: `Spread surged from ${(signal.spreadPct * 100).toFixed(2)}% to ${(currentSpread * 100).toFixed(2)}%`,
      };
    }
  }

  // 4. TVL 변동 체크
  if (currentTvl !== undefined && signal.poolTvl !== undefined && signal.poolTvl > 0) {
    const tvlDrop = (signal.poolTvl - currentTvl) / signal.poolTvl;
    if (tvlDrop > cfg.maxTvlDrop) {
      return {
        isStale: true,
        reason: `TVL dropped ${(tvlDrop * 100).toFixed(1)}% since signal`,
      };
    }
  }

  return { isStale: false };
}
