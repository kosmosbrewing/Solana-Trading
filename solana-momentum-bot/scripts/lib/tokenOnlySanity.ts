/**
 * Token-only PnL sanity clamp (2026-06-10 edge audit).
 *
 * Why: kol-live-trades.jsonl / executed-sells.jsonl 에 decimals 버그로 0.02 SOL ticket 에
 * netSolTokenOnly = -20.77 / -17.01 같은 물리적으로 불가능한 row 가 존재한다
 * (positionId kolh-live-7vLkpoGr-1778690130 / kolh-live-vA8xka9x-1778689554).
 * ledger row 자체는 수정하지 않고 (append-only 원장 원칙), report 집계에서만 해당 row 의
 * token-only 축을 invalid 처리해 token-only 합계/중앙값 왜곡을 막는다.
 * wallet 축 (netSol) 은 그대로 사용한다 — wallet delta 가 유일한 ground truth.
 */

// abs(netSolTokenOnly) > max(1 SOL, 200 × ticketSol) 이면 invalid.
// 실제 버그 class 는 ~850x 규모 (0.02 ticket 에 −17/−20 SOL) 라 200x 로도 동일하게 잡히고,
// 사명이 측정하려는 5x-100x tail winner 를 invalid 로 오판하지 않는다 (50x 는 경계에 닿았음).
export const TOKEN_ONLY_INVALID_ABS_FLOOR_SOL = 1;
export const TOKEN_ONLY_INVALID_TICKET_MULTIPLIER = 200;

export function isTokenOnlyNetSolInvalid(
  netSolTokenOnly: number | null | undefined,
  ticketSol?: number | null,
): boolean {
  if (typeof netSolTokenOnly !== 'number' || !Number.isFinite(netSolTokenOnly)) return false;
  const ticket =
    typeof ticketSol === 'number' && Number.isFinite(ticketSol) && ticketSol > 0 ? ticketSol : 0;
  const limit = Math.max(
    TOKEN_ONLY_INVALID_ABS_FLOOR_SOL,
    TOKEN_ONLY_INVALID_TICKET_MULTIPLIER * ticket,
  );
  return Math.abs(netSolTokenOnly) > limit;
}

// ledger row 에서 ticket 크기 추정 — 필드 우선순위는 close ledger 표준 순서.
export function resolveRowTicketSol(row: Record<string, unknown>): number | null {
  for (const key of ['ticketSol', 'swapInputSol', 'solSpentNominal'] as const) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

// row 단위 판정 shortcut — netSolTokenOnly 명시 필드만 검사한다.
// (netSol fallback 은 wallet 축이므로 clamp 대상이 아니다.)
export function isRowTokenOnlyInvalid(row: Record<string, unknown>): boolean {
  const netSolTokenOnly = row.netSolTokenOnly;
  if (typeof netSolTokenOnly !== 'number') return false;
  return isTokenOnlyNetSolInvalid(netSolTokenOnly, resolveRowTicketSol(row));
}
