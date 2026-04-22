/**
 * Jupiter Rate-Limit Metric (2026-04-22, P1-1)
 *
 * Why: 2026-04-22 9h 운영 관측에서 07:36 cluster 에 Jupiter 429 → quoteGate /
 *      entryDriftGuard / sellQuoteProbe / swap retry 3× 전부 실패 → 유일한 live buy 시도 전멸.
 *      개별 WARN 로그는 있었지만 "signal → entry 체결률" 을 추적하는 metric 이 없어 silent loss.
 *      본 모듈은 429 발생을 source 별로 counter 로 집계하고 주기적 summary 로그 출력.
 *
 * 사용처 — 아래 429 발생 지점에서 `recordJupiter429('<source>')` 호출:
 *  - `src/gate/entryDriftGuard.ts` → source='entry_drift_guard'
 *  - `src/gate/sellQuoteProbe.ts` → source='sell_quote_probe'
 *  - `src/observability/missedAlphaObserver.ts` → source='missed_alpha_observer'
 *  - (추가) `src/gate/quoteGate.ts` / executor swap 도 원하면 확장
 *
 * NOT a trading decision input — observability only. Rate-limit budget 조정은 운영자 판단.
 */
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('JupiterRateLimit');

interface Counter {
  total: number;
  windowStartMs: number;
  sinceLastSummary: number;
}

const counters = new Map<string, Counter>();
let summaryIntervalMs = 5 * 60 * 1000; // 5 min default — test/runtime 에서 override 가능
let summaryTimer: NodeJS.Timeout | null = null;

/**
 * 429 발생 기록. 인자 source 로 호출자 구분 (e.g. 'entry_drift_guard').
 * Non-blocking, sync, throw 없음.
 */
export function recordJupiter429(source: string): void {
  if (!source || typeof source !== 'string') return;
  const now = Date.now();
  const cur = counters.get(source);
  if (cur) {
    cur.total += 1;
    cur.sinceLastSummary += 1;
  } else {
    counters.set(source, {
      total: 1,
      windowStartMs: now,
      sinceLastSummary: 1,
    });
  }
}

/** 누적 카운터 snapshot. 운영 중 확인용. */
export function getJupiter429Stats(): Array<{
  source: string;
  total: number;
  sinceLastSummary: number;
  uptimeMs: number;
}> {
  const now = Date.now();
  return [...counters.entries()].map(([source, c]) => ({
    source,
    total: c.total,
    sinceLastSummary: c.sinceLastSummary,
    uptimeMs: now - c.windowStartMs,
  }));
}

/** 주기 summary 로그 시작. index.ts bootstrap 에서 1회 호출. */
export function startJupiter429SummaryLoop(intervalMs: number = summaryIntervalMs): void {
  if (summaryTimer) return; // idempotent
  summaryIntervalMs = intervalMs;
  summaryTimer = setInterval(() => {
    emitSummary();
  }, intervalMs);
  if (summaryTimer.unref) summaryTimer.unref();
}

export function stopJupiter429SummaryLoop(): void {
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
}

/** 즉시 summary 출력 (테스트/수동 호출). 카운터의 `sinceLastSummary` 를 reset. */
export function emitSummary(): void {
  if (counters.size === 0) return;
  const parts: string[] = [];
  let totalRecent = 0;
  for (const [source, c] of counters) {
    if (c.sinceLastSummary > 0) {
      parts.push(`${source}=${c.sinceLastSummary}(total=${c.total})`);
      totalRecent += c.sinceLastSummary;
      c.sinceLastSummary = 0;
    }
  }
  if (parts.length === 0) return;
  log.info(
    `[JUPITER_429_SUMMARY] window=${Math.round(summaryIntervalMs / 1000)}s recent=${totalRecent} ${parts.join(' ')}`
  );
}

/** 테스트용 reset. */
export function resetJupiter429Metric(): void {
  counters.clear();
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
}
