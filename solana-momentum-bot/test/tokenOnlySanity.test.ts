/**
 * Token-only sanity clamp tests (2026-06-10 edge audit).
 * 대상 결함: kol-live-trades.jsonl 의 decimals 버그 row —
 * 0.02 SOL ticket 에 netSolTokenOnly = -20.7701 / -17.0135.
 */
import {
  isRowTokenOnlyInvalid,
  isTokenOnlyNetSolInvalid,
  resolveRowTicketSol,
  TOKEN_ONLY_INVALID_ABS_FLOOR_SOL,
  TOKEN_ONLY_INVALID_TICKET_MULTIPLIER,
} from '../scripts/lib/tokenOnlySanity';

describe('tokenOnlySanity', () => {
  it('flags the actual broken ledger rows (0.02 SOL ticket, -17 / -20 token-only)', () => {
    expect(isTokenOnlyNetSolInvalid(-17.013500070322088, 0.02)).toBe(true);
    expect(isTokenOnlyNetSolInvalid(-20.770116983953773, 0.02)).toBe(true);
  });

  it('keeps physically plausible values valid', () => {
    // 0.02 SOL ticket → limit = max(1, 200*0.02) = 4 SOL
    expect(isTokenOnlyNetSolInvalid(-0.0027, 0.02)).toBe(false);
    expect(isTokenOnlyNetSolInvalid(0.9, 0.02)).toBe(false);
    // 50x winner (0.02 → +0.98) 도 valid — 사명이 측정하는 5x-100x tail 보존
    expect(isTokenOnlyNetSolInvalid(0.98, 0.02)).toBe(false);
    expect(isTokenOnlyNetSolInvalid(3.9, 0.02)).toBe(false); // ~195x, limit 4 미만
  });

  it('uses max(1 SOL, 200 x ticket) as the limit', () => {
    expect(TOKEN_ONLY_INVALID_ABS_FLOOR_SOL).toBe(1);
    expect(TOKEN_ONLY_INVALID_TICKET_MULTIPLIER).toBe(200);
    // 큰 ticket 이면 200x 배수가 floor 를 초과
    expect(isTokenOnlyNetSolInvalid(9.5, 0.05)).toBe(false); // limit 10
    expect(isTokenOnlyNetSolInvalid(10.5, 0.05)).toBe(true);
    // ticket 미상 → floor 1 SOL
    expect(isTokenOnlyNetSolInvalid(1.2)).toBe(true);
    expect(isTokenOnlyNetSolInvalid(0.99, null)).toBe(false);
  });

  it('treats missing / non-finite values as not-invalid (no value to clamp)', () => {
    expect(isTokenOnlyNetSolInvalid(undefined, 0.02)).toBe(false);
    expect(isTokenOnlyNetSolInvalid(null, 0.02)).toBe(false);
    expect(isTokenOnlyNetSolInvalid(Number.NaN, 0.02)).toBe(false);
  });

  it('resolveRowTicketSol prefers ticketSol then swapInputSol then solSpentNominal', () => {
    expect(resolveRowTicketSol({ ticketSol: 0.02, swapInputSol: 0.5 })).toBe(0.02);
    expect(resolveRowTicketSol({ swapInputSol: 0.019, solSpentNominal: 0.017 })).toBe(0.019);
    expect(resolveRowTicketSol({ solSpentNominal: 0.017 })).toBe(0.017);
    expect(resolveRowTicketSol({})).toBeNull();
    expect(resolveRowTicketSol({ ticketSol: 0 })).toBeNull();
  });

  it('isRowTokenOnlyInvalid matches the broken row shape end-to-end', () => {
    expect(isRowTokenOnlyInvalid({
      positionId: 'kolh-live-vA8xka9x-1778689554',
      ticketSol: 0.02,
      swapInputSol: 0.019999999,
      netSol: -0.002720128999999998,
      netSolTokenOnly: -17.013500070322088,
    })).toBe(true);
    expect(isRowTokenOnlyInvalid({
      positionId: 'kolh-live-vA8xka9x-1778689554-tail',
      ticketSol: 0.002519976670560789,
      netSol: -0.001139064670560777,
      netSolTokenOnly: 0.00023918634070300716,
    })).toBe(false);
    expect(isRowTokenOnlyInvalid({ netSol: -0.001 })).toBe(false);
  });
});
