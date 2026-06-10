/**
 * KOL Candle Coverage Policy (2026-06-10, edge-audit 07 root cause fix)
 *
 * Why: KOL 후보 candle 구독의 capacity knob (target max / TTL) 이 index.ts 에
 * hardcoded 상수로 박혀 있어 관측 capacity 를 조정할 수 없었다. 이 모듈은
 * env 입력의 clamp 와 capacity eviction 선택을 순수 함수로 분리한다.
 *
 * 경계 (HARD):
 *   - targetMax 는 Helius realtimeMaxSubscriptions cap 을 절대 초과 못 함
 *     (KOL target 은 resolveRealtimePools 에서 watchlist 보다 우선 배치되므로,
 *     cap 초과 설정 시 watchlist 가 전부 밀려나는 사고 방지).
 *   - 이 정책은 관측 전용 구독에만 적용 — live entry/exit 판단 경로와 무관.
 */

export const DEFAULT_KOL_CANDLE_TARGET_MAX = 8;
export const DEFAULT_KOL_CANDLE_TARGET_TTL_MS = 15 * 60 * 1000;
/** TTL 하한 — 60s 미만이면 pre60 창조차 못 덮어 구독이 무의미. */
export const MIN_KOL_CANDLE_TARGET_TTL_MS = 60 * 1000;

export interface KolCandleCoverageLimits {
  targetMax: number;
  ttlMs: number;
}

export function resolveKolCandleCoverageLimits(input: {
  configuredTargetMax: number;
  configuredTtlMs: number;
  realtimeMaxSubscriptions: number;
}): KolCandleCoverageLimits {
  const subscriptionCap = Number.isFinite(input.realtimeMaxSubscriptions) && input.realtimeMaxSubscriptions >= 1
    ? Math.floor(input.realtimeMaxSubscriptions)
    : DEFAULT_KOL_CANDLE_TARGET_MAX;

  // 하한 1 (default 복귀가 아님): 운영자가 0/음수로 "줄이기" 를 의도했을 때
  // default 8 로 되돌리면 의도와 반대 방향 (구독 압력 증가) 이 된다.
  let targetMax = Number.isFinite(input.configuredTargetMax)
    ? Math.floor(input.configuredTargetMax)
    : DEFAULT_KOL_CANDLE_TARGET_MAX;
  if (targetMax < 1) targetMax = 1;
  targetMax = Math.min(targetMax, subscriptionCap);

  let ttlMs = Number.isFinite(input.configuredTtlMs)
    ? Math.floor(input.configuredTtlMs)
    : DEFAULT_KOL_CANDLE_TARGET_TTL_MS;
  if (ttlMs < MIN_KOL_CANDLE_TARGET_TTL_MS) ttlMs = MIN_KOL_CANDLE_TARGET_TTL_MS;

  return { targetMax, ttlMs };
}

export interface KolCandleCoverageEvictionEntry {
  tokenMint: string;
  expiresAtMs: number;
}

/**
 * 신규 target 1개를 넣기 위해 비워야 할 mint 목록 (earliest-expiry 순).
 * 운영자가 env 로 max 를 줄였을 때도 (재시작 없이 호출되는 경우 포함)
 * size 가 targetMax-1 이하가 될 때까지 선택한다.
 */
export function selectKolCandleCoverageEvictions(
  entries: KolCandleCoverageEvictionEntry[],
  targetMax: number
): string[] {
  const max = Number.isFinite(targetMax) && targetMax >= 1
    ? Math.floor(targetMax)
    : DEFAULT_KOL_CANDLE_TARGET_MAX;
  if (entries.length < max) return [];
  const overflow = entries.length - max + 1;
  return [...entries]
    .sort((left, right) => left.expiresAtMs - right.expiresAtMs)
    .slice(0, overflow)
    .map((entry) => entry.tokenMint);
}
