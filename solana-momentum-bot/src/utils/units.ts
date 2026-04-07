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
