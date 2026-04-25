/**
 * tokenSessionTracker tests — Phase 3 P1-5/P1-6.
 */
import {
  recordEntry,
  recordClose,
  evaluateContinuation,
  hasOpenPosition,
  resetTokenSessionTrackerForTests,
  configureTokenSessionTracker,
  getSession,
  DEFAULT_TOKEN_SESSION_CONFIG,
} from '../src/orchestration/tokenSessionTracker';

const MINT = 'TokenMint11111111111111111111111111111111111';

describe('tokenSessionTracker', () => {
  beforeEach(() => {
    resetTokenSessionTrackerForTests();
  });

  it('recordEntry creates session + recordClose with winner sets lastWinner', () => {
    recordEntry({ tokenMint: MINT, tradeId: 'tr-1', nowMs: 1_000_000 });
    expect(hasOpenPosition(MINT)).toBe(true);
    recordClose({ tokenMint: MINT, netPct: 0.99, nowMs: 1_001_000 });
    const sess = getSession(MINT);
    expect(sess?.lastWinnerNetPct).toBeCloseTo(0.99, 6);
    expect(sess?.openTradeId).toBeNull();
  });

  it('evaluateContinuation: recent winner within lookback → continuation true', () => {
    recordEntry({ tokenMint: MINT, tradeId: 'tr-1', nowMs: 1_000_000 });
    recordClose({ tokenMint: MINT, netPct: 0.6, nowMs: 1_001_000 }); // winner +60%
    const decision = evaluateContinuation(MINT, 1_005_000); // 4s later
    expect(decision.isContinuation).toBe(true);
    expect(decision.reason).toMatch(/winner_60pct/);
  });

  it('evaluateContinuation: winner too old → false', () => {
    recordEntry({ tokenMint: MINT, tradeId: 'tr-1', nowMs: 1_000_000 });
    recordClose({ tokenMint: MINT, netPct: 0.6, nowMs: 1_001_000 });
    const lateMs = 1_001_000 + DEFAULT_TOKEN_SESSION_CONFIG.winnerLookbackMs + 1_000;
    // session 이 expire 되지 않도록 lookback 보다 짧은 ttl 회피
    const cfg = { ttlMs: 60 * 60 * 1000 } as Partial<typeof DEFAULT_TOKEN_SESSION_CONFIG>;
    configureTokenSessionTracker(cfg);
    const decision = evaluateContinuation(MINT, lateMs);
    expect(decision.isContinuation).toBe(false);
    expect(decision.reason).toBe('winner_too_old');
  });

  it('evaluateContinuation: open position blocks new entry (P1-7)', () => {
    recordEntry({ tokenMint: MINT, tradeId: 'tr-1', nowMs: 1_000_000 });
    const decision = evaluateContinuation(MINT, 1_001_000);
    expect(decision.isContinuation).toBe(false);
    expect(decision.reason).toBe('open_position_active');
  });

  it('losing close does NOT set lastWinner — no continuation', () => {
    recordEntry({ tokenMint: MINT, tradeId: 'tr-1', nowMs: 1_000_000 });
    recordClose({ tokenMint: MINT, netPct: -0.10, nowMs: 1_001_000 });
    const decision = evaluateContinuation(MINT, 1_002_000);
    expect(decision.isContinuation).toBe(false);
    expect(decision.reason).toBe('no_recent_winner');
  });

  it('expired session pruned on next call', () => {
    recordEntry({ tokenMint: MINT, tradeId: 'tr-1', nowMs: 1_000_000 });
    recordClose({ tokenMint: MINT, netPct: -0.05, nowMs: 1_001_000 });
    const lateMs = 1_001_000 + DEFAULT_TOKEN_SESSION_CONFIG.ttlMs + 1_000;
    evaluateContinuation(MINT, lateMs); // triggers prune
    expect(getSession(MINT)).toBeUndefined();
  });
});
