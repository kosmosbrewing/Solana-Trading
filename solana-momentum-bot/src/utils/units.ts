/**
 * TD-12 / Phase S-5 (2026-04-07): bps ↔ decimal 변환 매직넘버 제거.
 *
 * BPS = basis points = 1/10_000.
 * 코드베이스 곳곳에 흩어진 `* 10000` / `/ 10000` 호출을 단일 util로 통합한다.
 * 단위 의미를 변수명으로 표시해 리뷰 시 단위 오염을 즉시 식별할 수 있게 한다.
 */

/** BPS denominator used by Number arithmetic. */
export const BPS_DENOMINATOR = 10_000;

/** BPS denominator used by BigInt arithmetic (e.g. on-chain raw amounts). */
export const BPS_DENOMINATOR_BIGINT = 10_000n;

/**
 * Convert a decimal fraction (e.g. 0.005 = 50bps) to integer basis points.
 * Always rounds to nearest integer.
 */
export function decimalToBps(decimal: number): number {
  return Math.round(decimal * BPS_DENOMINATOR);
}

/**
 * Convert an integer basis-points value (e.g. 50bps) to a decimal fraction (0.005).
 */
export function bpsToDecimal(bps: number): number {
  return bps / BPS_DENOMINATOR;
}

/**
 * UI amount → raw BigInt 변환 (decimals 적용).
 *
 * 2026-04-21 (QA L2): JS number 정밀도 한계 (2^53) 방어.
 * `Math.floor(ui * 10^decimals)` 는 decimals=18 + large ui 에서 정밀 손실 가능.
 * `toFixed` 로 string 변환 후 소수점 이동하여 BigInt 화.
 *
 * 2026-04-26 H2-followup: pureWsBreakoutHandler 에서 utils 로 격상.
 * livePriceTracker 등 lower layer 모듈도 같은 helper 를 사용하도록.
 *
 * 주의: ui 가 매우 크면 (1e21+) `.toFixed()` 가 과학 표기 반환 — 그 범위는 invalid input 취급.
 */
export function uiAmountToRaw(ui: number, decimals: number): bigint {
  if (!isFinite(ui) || ui <= 0) return 0n;
  if (decimals < 0 || decimals > 18) return 0n;
  // 과학 표기 방어: ui >= 1e21 또는 너무 작으면 reject (실무 범위 밖)
  if (ui >= 1e21) return 0n;
  const fixed = ui.toFixed(decimals);
  const [intStr, fracStrRaw = ''] = fixed.split('.');
  const fracStr = fracStrRaw.padEnd(decimals, '0').slice(0, decimals);
  const combined = (intStr + fracStr).replace(/^0+/, '') || '0';
  try {
    return BigInt(combined);
  } catch {
    return 0n;
  }
}
