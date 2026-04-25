/**
 * Pair Quarantine Tracker — Phase 4 P2-1/P2-2 (2026-04-25)
 *
 * Why: 6h 운영에서 pippin (Dfh5DzRgSvvC) 한 토큰이 entry_drift_reject 513건 (V2 PASS 의 16%).
 * `project_signal_quality_reinforcement_2026_04_22` signal price 12배 부풀림 버그.
 * P2 mitigation 은 reject 잘 하지만 RPC + Jupiter 비용 매번 소비. 운영자 manual blacklist 보다
 * **자동 회복 가능한** quarantine 으로 자동화.
 *
 * 발동 조건:
 *  - 10분 내 `drift_reject` 카운트 ≥ threshold (default 20) OR
 *  - 10분 내 `favorable_drift > 20%` 카운트 ≥ threshold (default 5)
 *  → 60분 동안 entry_drift_guard 단계에서 quarantine reject (Jupiter quote 호출 자체 skip).
 *
 * 자동 해제: timer 만료 시 카운터 리셋. recovery 후 다시 발동 가능.
 *
 * 데이터: in-memory only. 재시작 시 휘발 (의도된 — restart = 재평가).
 */

export interface PairQuarantineConfig {
  enabled: boolean;
  driftRejectThreshold: number;
  favorableDriftThreshold: number;
  windowMs: number;
  durationMs: number;
}

export const DEFAULT_PAIR_QUARANTINE_CONFIG: PairQuarantineConfig = {
  enabled: true,
  driftRejectThreshold: 20,
  favorableDriftThreshold: 5,
  windowMs: 10 * 60 * 1000,
  durationMs: 60 * 60 * 1000,
};

interface DriftEvent {
  ts: number;
  category: 'drift_reject' | 'favorable_drift';
}

interface PairState {
  events: DriftEvent[];
  quarantinedUntilMs: number;
  totalQuarantines: number;
}

const states = new Map<string, PairState>();
let activeConfig: PairQuarantineConfig = { ...DEFAULT_PAIR_QUARANTINE_CONFIG };

export function configurePairQuarantine(cfg: Partial<PairQuarantineConfig>): void {
  activeConfig = { ...DEFAULT_PAIR_QUARANTINE_CONFIG, ...cfg };
}

export function getPairQuarantineConfig(): Readonly<PairQuarantineConfig> {
  return activeConfig;
}

export function resetPairQuarantineForTests(): void {
  states.clear();
  activeConfig = { ...DEFAULT_PAIR_QUARANTINE_CONFIG };
}

function getOrCreate(pair: string): PairState {
  let st = states.get(pair);
  if (!st) {
    st = { events: [], quarantinedUntilMs: 0, totalQuarantines: 0 };
    states.set(pair, st);
  }
  return st;
}

function pruneOldEvents(st: PairState, nowMs: number): void {
  const cutoff = nowMs - activeConfig.windowMs;
  while (st.events.length > 0 && st.events[0].ts < cutoff) {
    st.events.shift();
  }
}

function maybeTriggerQuarantine(pair: string, st: PairState, nowMs: number): boolean {
  pruneOldEvents(st, nowMs);
  const driftRejectCount = st.events.filter((e) => e.category === 'drift_reject').length;
  const favorableDriftCount = st.events.filter((e) => e.category === 'favorable_drift').length;
  if (
    driftRejectCount >= activeConfig.driftRejectThreshold ||
    favorableDriftCount >= activeConfig.favorableDriftThreshold
  ) {
    st.quarantinedUntilMs = nowMs + activeConfig.durationMs;
    st.totalQuarantines++;
    st.events.length = 0; // reset counters after firing
    return true;
  }
  return false;
}

/** drift_reject 이벤트 기록. trigger 면 `triggered: true`. */
export function recordDriftReject(opts: {
  pair: string;
  nowMs?: number;
}): { triggered: boolean; quarantinedUntilMs: number } {
  if (!activeConfig.enabled) return { triggered: false, quarantinedUntilMs: 0 };
  const nowMs = opts.nowMs ?? Date.now();
  const st = getOrCreate(opts.pair);
  st.events.push({ ts: nowMs, category: 'drift_reject' });
  const triggered = maybeTriggerQuarantine(opts.pair, st, nowMs);
  return { triggered, quarantinedUntilMs: st.quarantinedUntilMs };
}

/** favorable_drift > threshold 이벤트 기록. */
export function recordFavorableDrift(opts: {
  pair: string;
  nowMs?: number;
}): { triggered: boolean; quarantinedUntilMs: number } {
  if (!activeConfig.enabled) return { triggered: false, quarantinedUntilMs: 0 };
  const nowMs = opts.nowMs ?? Date.now();
  const st = getOrCreate(opts.pair);
  st.events.push({ ts: nowMs, category: 'favorable_drift' });
  const triggered = maybeTriggerQuarantine(opts.pair, st, nowMs);
  return { triggered, quarantinedUntilMs: st.quarantinedUntilMs };
}

/** 현재 quarantine 상태 — true 면 entry skip. */
export function isQuarantined(pair: string, nowMs?: number): boolean {
  if (!activeConfig.enabled) return false;
  const t = nowMs ?? Date.now();
  const st = states.get(pair);
  if (!st) return false;
  if (st.quarantinedUntilMs > t) return true;
  // expire — cleanup state if no recent events
  if (st.events.length === 0 && st.quarantinedUntilMs > 0 && st.quarantinedUntilMs <= t) {
    states.delete(pair);
  }
  return false;
}

export function getPairQuarantineState(pair: string): Readonly<PairState> | undefined {
  return states.get(pair);
}

export function getActiveQuarantines(nowMs?: number): Array<{ pair: string; untilMs: number }> {
  const t = nowMs ?? Date.now();
  const result: Array<{ pair: string; untilMs: number }> = [];
  for (const [pair, st] of states) {
    if (st.quarantinedUntilMs > t) {
      result.push({ pair, untilMs: st.quarantinedUntilMs });
    }
  }
  return result;
}
