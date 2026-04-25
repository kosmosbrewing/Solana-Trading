/**
 * Token Session Tracker — Phase 3 P1-5/P1-6 (2026-04-25)
 *
 * Why: 6h 운영 로그에서 BZtgGZqx (CATCOIN) 가 1 winner (+99.91%) 후 5번 sliced 재진입,
 * 모두 손실. 같은 토큰을 30s scalp 으로 잘라 팔면서 continuation 을 재인식 못 함.
 *
 * 설계:
 *  - tokenMint → { firstEntryAt, lastEntryAt, lastWinnerNetPct, lastWinnerAt,
 *                  totalEntries, openPosition }
 *  - TTL window (default 30분) 내 새 진입은 동일 session 으로 누적.
 *  - lastWinnerNetPct >= threshold (default +50%) 가 최근 lookback (default 15분) 내면
 *    `continuation` mode 권장 — handler 가 정상 PROBE 대신 더 긴 window / 낮은 T1 적용.
 *  - openPosition 가 있으면 새 진입 차단 (P1-7).
 *
 * Real Asset Guard 무영향. observability + entry guidance 만 — 실 trade 결정에는
 * handler 가 결과를 사용해 자체 분기.
 */

export interface TokenSession {
  tokenMint: string;
  firstEntryAtMs: number;
  lastEntryAtMs: number;
  totalEntries: number;
  /** 마지막 closure 의 net pct (winner 라면 양수). */
  lastNetPct: number | null;
  /** 가장 최근 winner (≥ winnerThresholdPct) 의 net + 시각. */
  lastWinnerAtMs: number | null;
  lastWinnerNetPct: number | null;
  /** open position 보유 중이면 trade id. 없으면 null. */
  openTradeId: string | null;
}

export interface TokenSessionTrackerConfig {
  /** session TTL — 마지막 활동 후 이 시간 지나면 expire. default 30분. */
  ttlMs: number;
  /** continuation 판정 winner net pct threshold. default 0.50 (50%). */
  winnerThresholdPct: number;
  /** continuation lookback — 이 시간 내 winner 가 있으면 continuation. default 15분. */
  winnerLookbackMs: number;
}

export const DEFAULT_TOKEN_SESSION_CONFIG: TokenSessionTrackerConfig = {
  ttlMs: 30 * 60 * 1000,
  winnerThresholdPct: 0.50,
  winnerLookbackMs: 15 * 60 * 1000,
};

export interface ContinuationDecision {
  isContinuation: boolean;
  reason: string;
  session: TokenSession | null;
}

/**
 * In-memory token session map. process-wide singleton.
 * Restart 시 휘발 — recovery 는 `executed-buys.jsonl` 에서 별도 처리.
 */
const sessions = new Map<string, TokenSession>();
let activeConfig: TokenSessionTrackerConfig = { ...DEFAULT_TOKEN_SESSION_CONFIG };

export function configureTokenSessionTracker(cfg: Partial<TokenSessionTrackerConfig>): void {
  activeConfig = { ...DEFAULT_TOKEN_SESSION_CONFIG, ...cfg };
}

export function getTokenSessionConfig(): Readonly<TokenSessionTrackerConfig> {
  return activeConfig;
}

export function resetTokenSessionTrackerForTests(): void {
  sessions.clear();
  activeConfig = { ...DEFAULT_TOKEN_SESSION_CONFIG };
}

/** session 생성/갱신 (entry 시 호출). */
export function recordEntry(opts: { tokenMint: string; tradeId: string; nowMs?: number }): TokenSession {
  const nowMs = opts.nowMs ?? Date.now();
  pruneExpired(nowMs);
  const existing = sessions.get(opts.tokenMint);
  if (existing) {
    existing.lastEntryAtMs = nowMs;
    existing.totalEntries++;
    existing.openTradeId = opts.tradeId;
    return existing;
  }
  const fresh: TokenSession = {
    tokenMint: opts.tokenMint,
    firstEntryAtMs: nowMs,
    lastEntryAtMs: nowMs,
    totalEntries: 1,
    lastNetPct: null,
    lastWinnerAtMs: null,
    lastWinnerNetPct: null,
    openTradeId: opts.tradeId,
  };
  sessions.set(opts.tokenMint, fresh);
  return fresh;
}

/** session close 기록 (close 시 호출). winner 면 lastWinnerNetPct 갱신. */
export function recordClose(opts: {
  tokenMint: string;
  netPct: number;
  nowMs?: number;
}): void {
  const nowMs = opts.nowMs ?? Date.now();
  const sess = sessions.get(opts.tokenMint);
  if (!sess) return;
  sess.lastNetPct = opts.netPct;
  sess.openTradeId = null;
  if (opts.netPct >= activeConfig.winnerThresholdPct) {
    sess.lastWinnerAtMs = nowMs;
    sess.lastWinnerNetPct = opts.netPct;
  }
  sess.lastEntryAtMs = nowMs;
}

/** Continuation 결정. */
export function evaluateContinuation(tokenMint: string, nowMs?: number): ContinuationDecision {
  const t = nowMs ?? Date.now();
  pruneExpired(t);
  const sess = sessions.get(tokenMint);
  if (!sess) return { isContinuation: false, reason: 'no_session', session: null };

  if (sess.openTradeId) {
    // P1-7: open position 보유 중이면 신규 진입 자체 차단 — 별도 reason 으로 표시.
    return { isContinuation: false, reason: 'open_position_active', session: sess };
  }

  if (sess.lastWinnerAtMs == null || sess.lastWinnerNetPct == null) {
    return { isContinuation: false, reason: 'no_recent_winner', session: sess };
  }

  const elapsedMs = t - sess.lastWinnerAtMs;
  if (elapsedMs > activeConfig.winnerLookbackMs) {
    return { isContinuation: false, reason: 'winner_too_old', session: sess };
  }

  return {
    isContinuation: true,
    reason: `winner_${(sess.lastWinnerNetPct * 100).toFixed(0)}pct_${Math.round(elapsedMs / 1000)}s_ago`,
    session: sess,
  };
}

/** 같은 mint 의 open position 존재 여부 — P1-7 caller 가 별도 호출 가능. */
export function hasOpenPosition(tokenMint: string): boolean {
  const sess = sessions.get(tokenMint);
  return sess?.openTradeId != null;
}

export function getSession(tokenMint: string): TokenSession | undefined {
  return sessions.get(tokenMint);
}

function pruneExpired(nowMs: number): void {
  const cutoff = nowMs - activeConfig.ttlMs;
  for (const [mint, sess] of sessions) {
    if (sess.lastEntryAtMs < cutoff && sess.openTradeId == null) {
      sessions.delete(mint);
    }
  }
}
