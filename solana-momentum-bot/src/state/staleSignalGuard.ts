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
  /** 데이터 소스의 예상 레이턴시 (ms). currentPrice가 폴링 기반일 경우 설정 */
  dataLatencyMs?: number;
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
  // 주의: signal.timestamp은 캔들 close 시각이므로, 폴링 간격 + 처리 지연이 포함됨
  // dataLatencyMs가 설정된 경우, 데이터 소스의 예상 레이턴시를 효과 나이에서 차감
  const rawAge = Date.now() - signal.timestamp.getTime();
  const effectiveAge = rawAge - (input.dataLatencyMs || 0);
  if (effectiveAge > cfg.maxAgeMs) {
    return { isStale: true, reason: `Signal age ${rawAge}ms (effective: ${effectiveAge}ms) exceeds ${cfg.maxAgeMs}ms limit` };
  }

  // 2. 가격 이탈 체크
  // 주의: currentPrice가 폴링 기반(캔들 close)일 경우 수 초 ~ 수십 초 지연 가능
  // 이 편차가 실제 가격 변동인지 레이턴시 아티팩트인지 구분 불가하므로,
  // micro-cap에서는 maxPriceDeviation을 여유있게 설정 필요 (default 1%→2% 권장)
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
