/**
 * Missed Alpha Observer (2026-04-22, mission-refinement P0+P2)
 *
 * Why: 9h VPS 관측 (2026-04-22 04:00-13:13 UTC) 에서 V2 PASS 9회 → 100% reject.
 *      reject 이후 pair 가 어떻게 움직였는지 기록이 없어 "우리가 옳게 cut 했는지
 *      틀리게 cut 했는지" 판정 불가. mission-refinement §5 Stage 2 "5x+ winner 분포"
 *      판정의 분모 (놓친 winner) 가 부재.
 *
 * 목적: Reject 이벤트 (survival / entry_drift / sell_quote / viability / security / v2_pass baseline)
 *      발생 시 비동기로 T+60s/300s/1800s Jupiter quote 를 fetch 해서
 *      signal price 대비 delta 를 JSONL 로 기록 → 주간 리뷰에서 post-reject trajectory
 *      분포 (p50/p90/p95) 로 집계 가능.
 *
 * 설계 원칙:
 *  - Fire-and-forget. trade pipeline latency 영향 없음.
 *  - Entry pipeline 의 entryDriftGuard Jupiter 회로와 별도 429 circuit 유지 — observer 의
 *    load 가 gate 성능에 역류하지 않도록.
 *  - Per-event dedup 창 (default 30s) — positionId 가 있으면 close 단위, 없으면 tokenMint 단위.
 *  - Hard max inflight cap (default 50) — Jupiter rate limit 안전.
 *  - 실패는 silent. observer 가 trade 판단에 절대 간섭하지 않는다.
 *  - env kill-switch: `MISSED_ALPHA_OBSERVER_ENABLED=false` 로 완전 무음.
 *
 * 기록 형식 (`${REALTIME_DATA_DIR}/missed-alpha.jsonl`):
 *   한 줄 = 한 probe tick (eventId 로 그룹핑). 예시:
 *   {
 *     "eventId": "ma-1714093022-Dfh5DzRg",
 *     "tokenMint": "...",
 *     "lane": "pure_ws_breakout",
 *     "rejectCategory": "entry_drift",
 *     "rejectReason": "suspicious_favorable_drift ...",
 *     "signalPrice": 0.00349601,
 *     "probeSolAmount": 0.01,
 *     "signalSource": "ws_burst_v2",
 *     "rejectedAt": "2026-04-22T05:57:02.452Z",
 *     "probe": {
 *       "offsetSec": 60,
 *       "firedAt": "2026-04-22T05:58:02.400Z",
 *       "observedPrice": 0.00030,
 *       "deltaPct": -0.914,
 *       "quoteStatus": "ok"
 *     }
 *   }
 *
 * NOT a trading decision input — pure observability. threshold 튜닝은 최소 1 week 분포가
 * 쌓인 후에 사람이 판단 (Stage 1 원칙 "관측 우선, 튜닝 금지").
 */
import axios from 'axios';
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { SOL_MINT, LAMPORTS_PER_SOL } from '../utils/constants';
import {
  JUPITER_KEYLESS_SWAP_API_URL,
  normalizeJupiterSwapApiUrl,
} from '../utils/jupiterApi';
import { recordJupiter429 } from './jupiterRateLimitMetric';

const log = createModuleLogger('MissedAlphaObserver');

/**
 * Category 는 2개 계열:
 *  - Pre-entry (reject-side): entry 전에 차단된 signal. "이 signal 을 무시한 게 옳았나?"
 *  - Post-entry (close-side): 진입했다가 cut 된 position. "이 cut 이 옳았나? Phase 3 miss?"
 * 소비자 스크립트는 category prefix 로 구분할 수 있다 (예: "probe_", "hold_").
 */
export type RejectCategory =
  // Pre-entry
  | 'survival'
  | 'entry_drift'
  | 'sell_quote_probe'
  | 'viability'
  | 'security_gate'
  | 'v2_pass_baseline'
  | 'pair_outcome_cooldown'
  // Post-entry (2026-04-22 P2-1b 확장 — LANE_20260422.md §6.1 요구사항)
  | 'probe_hard_cut'
  | 'probe_reject_timeout'
  | 'probe_flat_cut'
  | 'quick_reject_classifier_exit'
  | 'hold_phase_sentinel_degraded_exit'
  // 2026-04-30 (B1): KOL close-site 명시 카테고리. winner / insider / orphan / structural_kill_sell_route
  // 등 기존 enum 으로 매핑 안 되던 close reason 을 single enum 으로 정리.
  // 분석 스크립트는 lane='kol_hunter' + rejectCategory='kol_close' 로 close-site 만 직접 필터.
  | 'kol_close'
  | 'other';

export interface MissedAlphaEvent {
  rejectCategory: RejectCategory;
  rejectReason: string;
  tokenMint: string;
  lane: string;
  /** SOL / token (UI units) — baseline for deltaPct */
  signalPrice: number;
  /** ticket notional SOL — forward quote amount */
  probeSolAmount: number;
  /** known by caller (pureWs: getMintDecimals). 없으면 quote fallback. */
  tokenDecimals?: number;
  signalSource?: string;
  extras?: Record<string, unknown>;
}

export interface MissedAlphaObserverConfig {
  enabled: boolean;
  /** offset 초 배열 (T+Xs). */
  offsetsSec: number[];
  /** offset 에 ±jitterPct 무작위 가감 (default 0.1 = 10%). Jupiter 쏠림 완화. */
  jitterPct: number;
  /** 동시 inflight probe 상한. 넘치면 새 event drop. */
  maxInflight: number;
  /** 같은 tokenMint 에 대한 dedup 창 (초). 기본 30s. */
  dedupWindowSec: number;
  /** 출력 jsonl 절대 경로. caller 가 `${realtimeDataDir}/missed-alpha.jsonl` 주입. */
  outputFile: string;
  jupiterApiUrl: string;
  jupiterApiKey?: string;
  timeoutMs: number;
  slippageBps: number;
  /** Jupiter 429 감지 후 observer 자체의 호출 cooldown (ms). */
  rateLimitCooldownMs: number;
  /** 스케줄 시점 marker 를 즉시 남겨 timer 유실/재시작에도 coverage 를 보존. */
  writeScheduleMarker: boolean;
}

// ─── Defaults (caller 가 대부분 override) ───

export const DEFAULT_MISSED_ALPHA_CONFIG: MissedAlphaObserverConfig = {
  enabled: true,
  offsetsSec: [60, 300, 1800],
  jitterPct: 0.1,
  maxInflight: 50,
  dedupWindowSec: 30,
  outputFile: '', // caller override
  jupiterApiUrl: JUPITER_KEYLESS_SWAP_API_URL,
  timeoutMs: 6_000,
  slippageBps: 200,
  rateLimitCooldownMs: 5_000,
  writeScheduleMarker: false,
};

/**
 * 2026-04-30 (B2 refactor): observer config builder 공통 helper.
 *
 * pureWs / kol-missed-alpha 두 lane 의 buildMissedAlphaConfig 가 동일한 config field 를
 * 복제하던 한계 해소. caller 는 lane-specific override 만 추가하면 됨.
 *
 * @param overrides - lane-specific 옵션 (writeScheduleMarker 등)
 */
export function buildMissedAlphaConfigFromGlobal(overrides: {
  realtimeDataDir: string;
  enabled: boolean;
  offsetsSec: number[];
  jitterPct: number;
  maxInflight: number;
  dedupWindowSec: number;
  jupiterApiUrl: string;
  jupiterApiKey?: string;
  /** lane-specific 옵션 — kol_hunter 는 writeScheduleMarker=true (재시작 직후 coverage 보존) */
  writeScheduleMarker?: boolean;
  outputFileName?: string; // default 'missed-alpha.jsonl'
}): Partial<MissedAlphaObserverConfig> {
  return {
    enabled: overrides.enabled,
    offsetsSec: overrides.offsetsSec,
    jitterPct: overrides.jitterPct,
    maxInflight: overrides.maxInflight,
    dedupWindowSec: overrides.dedupWindowSec,
    outputFile: pathJoin(overrides.realtimeDataDir, overrides.outputFileName ?? 'missed-alpha.jsonl'),
    jupiterApiUrl: overrides.jupiterApiUrl,
    jupiterApiKey: overrides.jupiterApiKey,
    ...(overrides.writeScheduleMarker !== undefined ? { writeScheduleMarker: overrides.writeScheduleMarker } : {}),
  };
}

// path.join 인라인 — 모듈 의존성 최소화 (path 는 이미 import 위쪽에 있음).
function pathJoin(a: string, b: string): string {
  return path.join(a, b);
}

// ─── Module State (process-wide) ───

interface ScheduledProbe {
  eventId: string;
  tokenMint: string;
  offsetSec: number;
  timer: NodeJS.Timeout;
}

const recentEventsByToken = new Map<string, number>(); // dedupKey(tokenMint or tokenMint:positionId) → epochMs
let inflightProbes = 0;
let rateLimitedUntilMs = 0;
let outputDirEnsured = false;
const scheduled = new Set<ScheduledProbe>();

/** 테스트/재기동 시 reset. scheduled timer 도 해제. */
export function resetMissedAlphaObserverState(): void {
  for (const p of scheduled) {
    clearTimeout(p.timer);
  }
  scheduled.clear();
  recentEventsByToken.clear();
  inflightProbes = 0;
  rateLimitedUntilMs = 0;
  outputDirEnsured = false;
}

export function getMissedAlphaObserverStats(): {
  inflight: number;
  rateLimitedUntilMs: number;
  recentEventsByToken: number;
  scheduled: number;
} {
  return {
    inflight: inflightProbes,
    rateLimitedUntilMs,
    recentEventsByToken: recentEventsByToken.size,
    scheduled: scheduled.size,
  };
}

/**
 * Entry point. fire-and-forget (no await needed from callers).
 * Caller 가 await 해도 수 μs 내 반환 — setTimeout 스케줄만 한다.
 */
export function trackRejectForMissedAlpha(
  event: MissedAlphaEvent,
  config: Partial<MissedAlphaObserverConfig> = {}
): void {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;

  // Basic sanity — bad input 은 silent drop (observer 가 throw 하면 안 됨).
  if (
    !event.tokenMint ||
    !Number.isFinite(event.signalPrice) ||
    event.signalPrice <= 0 ||
    !Number.isFinite(event.probeSolAmount) ||
    event.probeSolAmount <= 0 ||
    !Array.isArray(cfg.offsetsSec) ||
    cfg.offsetsSec.length === 0 ||
    !cfg.outputFile
  ) {
    return;
  }

  const nowMs = Date.now();

  // Per-event dedup. close-site 는 positionId 로 같은 mint 반복 close 를 분리한다.
  const dedupKey = dedupKeyFor(event);
  const lastAt = recentEventsByToken.get(dedupKey);
  if (lastAt != null && nowMs - lastAt < cfg.dedupWindowSec * 1000) {
    return;
  }
  recentEventsByToken.set(dedupKey, nowMs);
  prunePerTokenCache(nowMs, cfg.dedupWindowSec);

  // 하드캡 — 새 이벤트 drop.
  if (inflightProbes + cfg.offsetsSec.length > cfg.maxInflight) {
    log.debug(
      `[MISSED_ALPHA] drop event ${event.tokenMint.slice(0, 8)} — inflight cap ` +
      `(${inflightProbes}+${cfg.offsetsSec.length} > ${cfg.maxInflight})`
    );
    return;
  }

  const eventId = buildEventId(event, nowMs);
  const rejectedAtIso = new Date(nowMs).toISOString();
  if (cfg.writeScheduleMarker) {
    void writeRecord(cfg.outputFile, buildScheduleMarkerRecord(event, eventId, rejectedAtIso));
  }

  for (const offsetSec of cfg.offsetsSec) {
    const jitterMs = computeJitterMs(offsetSec, cfg.jitterPct);
    const delayMs = Math.max(0, offsetSec * 1000 + jitterMs);

    inflightProbes += 1;
    const probe: ScheduledProbe = {
      eventId,
      tokenMint: event.tokenMint,
      offsetSec,
      timer: setTimeout(() => {
        scheduled.delete(probe);
        runProbe(event, eventId, rejectedAtIso, offsetSec, cfg)
          .catch((err) => {
            // defensive — runProbe 는 내부 try/catch 하지만 이 레이어는 절대 throw 하면 안 됨.
            log.debug(`[MISSED_ALPHA] probe error: ${String(err)}`);
          })
          .finally(() => {
            inflightProbes = Math.max(0, inflightProbes - 1);
          });
      }, delayMs),
    };
    // Node timer 가 프로세스 종료를 막지 않도록.
    if (probe.timer.unref) probe.timer.unref();
    scheduled.add(probe);
  }
}

// ─── Probe Runner ───

async function runProbe(
  event: MissedAlphaEvent,
  eventId: string,
  rejectedAtIso: string,
  offsetSec: number,
  cfg: MissedAlphaObserverConfig
): Promise<void> {
  const firedAtMs = Date.now();
  let observedPrice: number | null = null;
  let quoteStatus: 'ok' | 'no_route' | 'rate_limited' | 'error' = 'ok';
  let quoteReason: string | null = null;
  let outAmountRaw: string | null = null;
  let outputDecimals: number | null = event.tokenDecimals ?? null;

  if (firedAtMs < rateLimitedUntilMs) {
    quoteStatus = 'rate_limited';
    quoteReason = 'observer_cooldown';
  } else {
    try {
      const quote = await fetchForwardQuote(event, cfg);
      if (quote == null) {
        quoteStatus = 'no_route';
        quoteReason = 'no_route_or_zero_out';
      } else {
        outAmountRaw = quote.outAmount.toString();
        const decimals = quote.outputDecimals ?? event.tokenDecimals ?? null;
        if (decimals == null) {
          quoteStatus = 'error';
          quoteReason = 'decimals_unknown';
        } else {
          outputDecimals = decimals;
          const outUi = Number(quote.outAmount) / Math.pow(10, decimals);
          if (outUi <= 0) {
            quoteStatus = 'error';
            quoteReason = 'expected_out_zero';
          } else {
            observedPrice = event.probeSolAmount / outUi;
          }
        }
      }
    } catch (err) {
      quoteStatus = 'error';
      quoteReason = err instanceof Error ? err.message : String(err);
      if (is429Error(err)) {
        recordJupiter429('missed_alpha_observer');
        if (cfg.rateLimitCooldownMs > 0) {
          rateLimitedUntilMs = Date.now() + cfg.rateLimitCooldownMs;
          quoteStatus = 'rate_limited';
        }
      }
    }
  }

  const deltaPct =
    observedPrice != null && event.signalPrice > 0
      ? (observedPrice - event.signalPrice) / event.signalPrice
      : null;

  const record: Record<string, unknown> = {
    eventId,
    tokenMint: event.tokenMint,
    lane: event.lane,
    rejectCategory: event.rejectCategory,
    rejectReason: event.rejectReason,
    signalPrice: event.signalPrice,
    probeSolAmount: event.probeSolAmount,
    signalSource: event.signalSource ?? null,
    rejectedAt: rejectedAtIso,
    extras: event.extras ?? null,
    probe: {
      offsetSec,
      firedAt: new Date(firedAtMs).toISOString(),
      observedPrice,
      outAmountRaw,
      outputDecimals,
      deltaPct,
      quoteStatus,
      quoteReason,
    },
  };

  await writeRecord(cfg.outputFile, record);
}

function buildScheduleMarkerRecord(
  event: MissedAlphaEvent,
  eventId: string,
  rejectedAtIso: string
): Record<string, unknown> {
  return {
    eventId,
    tokenMint: event.tokenMint,
    lane: event.lane,
    rejectCategory: event.rejectCategory,
    rejectReason: event.rejectReason,
    signalPrice: event.signalPrice,
    probeSolAmount: event.probeSolAmount,
    signalSource: event.signalSource ?? null,
    rejectedAt: rejectedAtIso,
    extras: event.extras ?? null,
    probe: {
      offsetSec: 0,
      firedAt: rejectedAtIso,
      observedPrice: null,
      outAmountRaw: null,
      outputDecimals: event.tokenDecimals ?? null,
      deltaPct: null,
      quoteStatus: 'scheduled',
      quoteReason: null,
    },
  };
}

// ─── Jupiter forward quote (observer-local, separate from gate circuit) ───

interface ForwardQuote {
  outAmount: bigint;
  outputDecimals: number | null;
}

async function fetchForwardQuote(
  event: MissedAlphaEvent,
  cfg: MissedAlphaObserverConfig
): Promise<ForwardQuote | null> {
  const amountLamports = BigInt(Math.round(event.probeSolAmount * LAMPORTS_PER_SOL));
  const headers: Record<string, string> = {};
  if (cfg.jupiterApiKey) headers['X-API-Key'] = cfg.jupiterApiKey;

  // Why: cfg.jupiterApiUrl 은 resolveConfig 에서 normalize 완료된 상태 — 재호출 금지
  //      (entryDriftGuard 는 매 evaluate 마다 재호출하지만 probe 는 최대 1800s 주기라 무의미,
  //       일관성과 가독성을 위해 1회 normalize 원칙 적용).
  const response = await axios.get(`${cfg.jupiterApiUrl}/quote`, {
    params: {
      inputMint: SOL_MINT,
      outputMint: event.tokenMint,
      amount: amountLamports.toString(),
      slippageBps: cfg.slippageBps,
    },
    headers,
    timeout: cfg.timeoutMs,
  });
  const quote = response.data;
  if (!quote || !quote.outAmount) return null;
  const outAmount = BigInt(quote.outAmount);
  if (outAmount <= 0n) return null;
  const outputDecimals =
    typeof quote.outputDecimals === 'number' &&
    Number.isFinite(quote.outputDecimals) &&
    quote.outputDecimals >= 0 &&
    quote.outputDecimals <= 18
      ? quote.outputDecimals
      : null;
  return { outAmount, outputDecimals };
}

function is429Error(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/status code 429|rate[_ ]?limit|too many requests/i.test(msg)) return true;
  const anyErr = err as { response?: { status?: number } };
  return anyErr?.response?.status === 429;
}

// ─── Writer ───

async function writeRecord(outputFile: string, record: Record<string, unknown>): Promise<void> {
  try {
    if (!outputDirEnsured) {
      await mkdir(path.dirname(outputFile), { recursive: true });
      outputDirEnsured = true;
    }
    // Why: JSON.stringify 기본 동작은 Infinity/NaN 을 "null" 로 직렬화 → 데이터 유실 없음.
    //      BigInt 는 throw → replacer 에서 string 으로 변환해 안전 append. extras 에 미래 caller 가
    //      예상 못한 타입을 넣어도 observer 가 절대 throw 하지 않도록 방어.
    const line = JSON.stringify(record, (_key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'number' && !Number.isFinite(value)) return null;
      return value;
    }) + '\n';
    await appendFile(outputFile, line, 'utf8');
  } catch (err) {
    log.debug(`[MISSED_ALPHA] write failed: ${String(err)}`);
  }
}

// ─── Helpers ───

function resolveConfig(partial: Partial<MissedAlphaObserverConfig>): MissedAlphaObserverConfig {
  const merged = { ...DEFAULT_MISSED_ALPHA_CONFIG, ...partial };
  // Why: Jupiter URL 은 config 해석 시점에 1회 normalize → probe fire 마다 재호출 방지.
  return {
    ...merged,
    jupiterApiUrl: normalizeJupiterSwapApiUrl(merged.jupiterApiUrl, merged.jupiterApiKey),
  };
}

function dedupKeyFor(event: MissedAlphaEvent): string {
  const positionId = typeof event.extras?.positionId === 'string' && event.extras.positionId.length > 0
    ? event.extras.positionId
    : null;
  return positionId ? `${event.tokenMint}:${positionId}` : event.tokenMint;
}

function buildEventId(event: MissedAlphaEvent, epochMs: number): string {
  const tokenShort = event.tokenMint.slice(0, 8);
  const positionId = typeof event.extras?.positionId === 'string' && event.extras.positionId.length > 0
    ? event.extras.positionId
    : null;
  if (!positionId) return `ma-${epochMs}-${tokenShort}`;
  const positionShort = positionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-24);
  return `ma-${epochMs}-${tokenShort}-${positionShort}`;
}

function computeJitterMs(offsetSec: number, jitterPct: number): number {
  if (!jitterPct || jitterPct <= 0) return 0;
  const range = offsetSec * 1000 * jitterPct;
  return (Math.random() * 2 - 1) * range;
}

function prunePerTokenCache(nowMs: number, dedupWindowSec: number): void {
  const cutoff = nowMs - dedupWindowSec * 1000 * 4; // 4× 창 이상 지난 엔트리만 정리
  for (const [mint, at] of recentEventsByToken) {
    if (at < cutoff) recentEventsByToken.delete(mint);
  }
}
