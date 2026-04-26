// 2026-04-25 Phase 3 P1-5/P1-6/P1-7: token session tracker bootstrap.
// configureTokenSessionTracker 는 idempotent — 첫 entryFlow 진입 시 lazy bootstrap.

import { config } from '../../utils/config';
import { configureTokenSessionTracker } from '../tokenSessionTracker';

export let tokenSessionConfigured = false;
export function ensureTokenSessionConfigured(): void {
  if (tokenSessionConfigured) return;
  tokenSessionConfigured = true;
  configureTokenSessionTracker({
    ttlMs: config.tokenSessionTtlMin * 60 * 1000,
    winnerThresholdPct: config.tokenSessionWinnerThresholdPct,
    winnerLookbackMs: config.tokenSessionWinnerLookbackMin * 60 * 1000,
  });
}

/** resetPureWsLaneStateForTests 가 사용 — bootstrap flag 만 다시 false 로. */
export function clearTokenSessionConfigured(): void {
  tokenSessionConfigured = false;
}
