/**
 * Trade Markout Observer (2026-05-02).
 *
 * Why: executed-buys / executed-sells / kol-live-trades 는 체결 원장이다. 이 파일들을
 *      사후 수정하지 않고, buy/sell anchor 이후 T+N 가격을 별도 sidecar 로 append 한다.
 *
 * Output: `${REALTIME_DATA_DIR}/trade-markouts.jsonl`
 * Anchor ledger: `${REALTIME_DATA_DIR}/trade-markout-anchors.jsonl`
 * Hot path policy: fire-and-forget, fail-open, timer unref. Trading decision 에 사용하지 않는다.
 */
import axios from 'axios';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { LAMPORTS_PER_SOL, SOL_MINT } from '../utils/constants';
import {
  JUPITER_KEYLESS_SWAP_API_URL,
  normalizeJupiterSwapApiUrl,
} from '../utils/jupiterApi';
import { recordJupiter429 } from './jupiterRateLimitMetric';

const log = createModuleLogger('TradeMarkoutObserver');

export const TRADE_MARKOUT_SCHEMA_VERSION = 'trade-markout/v1' as const;
export const TRADE_MARKOUT_ANCHOR_SCHEMA_VERSION = 'trade-markout-anchor/v1' as const;
export const DEFAULT_TRADE_MARKOUT_OFFSETS_SEC = [30, 60, 300, 1800] as const;

export type TradeMarkoutAnchorType = 'buy' | 'sell';
export type TradeMarkoutPriceKind =
  | 'entry_token_only'
  | 'exit_token_only'
  | 'wallet_delta_fallback';
export type TradeMarkoutQuoteStatus = 'ok' | 'no_route' | 'rate_limited' | 'error';

export interface TradeMarkoutAnchor {
  anchorType: TradeMarkoutAnchorType;
  positionId: string;
  tokenMint: string;
  anchorTxSignature?: string | null;
  anchorAtMs?: number;
  anchorPrice: number;
  anchorPriceKind: TradeMarkoutPriceKind;
  probeSolAmount: number;
  tokenDecimals?: number | null;
  signalSource?: string | null;
  extras?: Record<string, unknown>;
}

export interface TradeMarkoutObserverConfig {
  enabled: boolean;
  offsetsSec: number[];
  jitterPct: number;
  maxInflight: number;
  dedupWindowSec: number;
  outputFile: string;
  anchorOutputFile: string;
  jupiterApiUrl: string;
  jupiterApiKey?: string;
  timeoutMs: number;
  slippageBps: number;
  rateLimitCooldownMs: number;
}

export interface TradeMarkoutRecord {
  schemaVersion: typeof TRADE_MARKOUT_SCHEMA_VERSION;
  eventId: string;
  anchorType: TradeMarkoutAnchorType;
  positionId: string;
  tokenMint: string;
  anchorTxSignature: string | null;
  anchorAt: string;
  anchorPrice: number;
  anchorPriceKind: TradeMarkoutPriceKind;
  probeSolAmount: number;
  horizonSec: number;
  firedAt: string;
  observedPrice: number | null;
  deltaPct: number | null;
  quoteStatus: TradeMarkoutQuoteStatus;
  quoteReason: string | null;
  outAmountRaw: string | null;
  outputDecimals: number | null;
  source: 'jupiter_quote';
  signalSource: string | null;
  extras: Record<string, unknown> | null;
  recordedAt: string;
}

export interface TradeMarkoutAnchorRecord {
  schemaVersion: typeof TRADE_MARKOUT_ANCHOR_SCHEMA_VERSION;
  eventId: string;
  anchorType: TradeMarkoutAnchorType;
  positionId: string;
  tokenMint: string;
  anchorTxSignature: string | null;
  anchorAt: string;
  anchorPrice: number;
  anchorPriceKind: TradeMarkoutPriceKind;
  probeSolAmount: number;
  tokenDecimals: number | null;
  signalSource: string | null;
  extras: Record<string, unknown> | null;
  recordedAt: string;
}

export interface TradeMarkoutHydrationSummary {
  loadedBuys: number;
  loadedSells: number;
  loadedAnchorRecords: number;
  loadedPaperCloses: number;
  loadedPartialTakes: number;
  existingMarkouts: number;
  scheduled: number;
  skippedExisting: number;
  skippedExpired: number;
}

const DEFAULT_CONFIG: TradeMarkoutObserverConfig = {
  enabled: true,
  offsetsSec: [...DEFAULT_TRADE_MARKOUT_OFFSETS_SEC],
  jitterPct: 0.05,
  maxInflight: 32,
  dedupWindowSec: 30,
  outputFile: '',
  anchorOutputFile: '',
  jupiterApiUrl: JUPITER_KEYLESS_SWAP_API_URL,
  timeoutMs: 6_000,
  slippageBps: 200,
  rateLimitCooldownMs: 5_000,
};

interface ScheduledMarkout {
  key: string;
  timer: NodeJS.Timeout;
  retryAttempt: number;
}

const recentAnchorKeys = new Map<string, number>();
const scheduled = new Map<string, ScheduledMarkout>();
let inflightProbes = 0;
let outputDirEnsured = false;
let rateLimitedUntilMs = 0;

export function buildTradeMarkoutConfigFromGlobal(overrides: {
  realtimeDataDir: string;
  enabled: boolean;
  offsetsSec: number[];
  jitterPct: number;
  maxInflight: number;
  dedupWindowSec: number;
  jupiterApiUrl: string;
  jupiterApiKey?: string;
  outputFileName?: string;
  anchorOutputFileName?: string;
}): Partial<TradeMarkoutObserverConfig> {
  return {
    enabled: overrides.enabled,
    offsetsSec: overrides.offsetsSec,
    jitterPct: overrides.jitterPct,
    maxInflight: overrides.maxInflight,
    dedupWindowSec: overrides.dedupWindowSec,
    outputFile: path.join(overrides.realtimeDataDir, overrides.outputFileName ?? 'trade-markouts.jsonl'),
    anchorOutputFile: path.join(overrides.realtimeDataDir, overrides.anchorOutputFileName ?? 'trade-markout-anchors.jsonl'),
    jupiterApiUrl: overrides.jupiterApiUrl,
    jupiterApiKey: overrides.jupiterApiKey,
  };
}

export function resetTradeMarkoutObserverState(): void {
  for (const item of scheduled.values()) {
    clearTimeout(item.timer);
  }
  scheduled.clear();
  recentAnchorKeys.clear();
  inflightProbes = 0;
  outputDirEnsured = false;
  rateLimitedUntilMs = 0;
}

export function getTradeMarkoutObserverStats(): {
  scheduled: number;
  inflight: number;
  recentAnchors: number;
  rateLimitedUntilMs: number;
} {
  return {
    scheduled: scheduled.size,
    inflight: inflightProbes,
    recentAnchors: recentAnchorKeys.size,
    rateLimitedUntilMs,
  };
}

export function trackTradeMarkout(
  anchor: TradeMarkoutAnchor,
  config: Partial<TradeMarkoutObserverConfig> = {},
): void {
  const cfg = resolveConfig(config);
  if (!cfg.enabled || !isValidAnchor(anchor, cfg)) return;
  const scheduledOffsetsSec = [...cfg.offsetsSec];
  const scheduledAnchor: TradeMarkoutAnchor = {
    ...anchor,
    extras: {
      ...(anchor.extras ?? {}),
      markoutOffsetsSec: scheduledOffsetsSec,
    },
  };

  const nowMs = Date.now();
  const anchorKey = `${anchor.anchorType}:${anchor.positionId}:${anchor.anchorTxSignature ?? anchor.anchorAtMs ?? ''}`;
  const lastAt = recentAnchorKeys.get(anchorKey);
  if (lastAt != null && nowMs - lastAt < cfg.dedupWindowSec * 1000) return;
  recentAnchorKeys.set(anchorKey, nowMs);
  pruneRecentAnchorKeys(nowMs, cfg.dedupWindowSec);
  if (cfg.anchorOutputFile) {
    void writeAnchorRecord(cfg.anchorOutputFile, scheduledAnchor).catch(() => {});
  }

  for (const horizonSec of scheduledOffsetsSec) {
    const jitterMs = computeJitterMs(horizonSec, cfg.jitterPct);
    scheduleProbe(scheduledAnchor, cfg, horizonSec, Math.max(0, horizonSec * 1000 + jitterMs));
  }
}

export async function hydrateTradeMarkoutSchedulesFromLedger(options: {
  realtimeDir: string;
  config: Partial<TradeMarkoutObserverConfig>;
  lookbackHours: number;
  maxCatchupAgeSec?: number;
}): Promise<TradeMarkoutHydrationSummary> {
  const cfg = resolveConfig(options.config);
  const summary: TradeMarkoutHydrationSummary = {
    loadedBuys: 0,
    loadedSells: 0,
    loadedAnchorRecords: 0,
    loadedPaperCloses: 0,
    loadedPartialTakes: 0,
    existingMarkouts: 0,
    scheduled: 0,
    skippedExisting: 0,
    skippedExpired: 0,
  };
  if (!cfg.enabled) return summary;

  const nowMs = Date.now();
  const sinceMs = nowMs - Math.max(0, options.lookbackHours) * 3600_000;
  const maxCatchupAgeSec = options.maxCatchupAgeSec ?? 7200;
  const [anchorRows, buys, sells, closes, paperCloses, shadowPaperCloses, pureWsPaperCloses, partialTakes, existing] = await Promise.all([
    readJsonlMaybe(cfg.anchorOutputFile),
    readJsonlMaybe(path.join(options.realtimeDir, 'executed-buys.jsonl')),
    readJsonlMaybe(path.join(options.realtimeDir, 'executed-sells.jsonl')),
    readJsonlMaybe(path.join(options.realtimeDir, 'kol-live-trades.jsonl')),
    readJsonlMaybe(path.join(options.realtimeDir, 'kol-paper-trades.jsonl')),
    readJsonlMaybe(path.join(options.realtimeDir, 'kol-shadow-paper-trades.jsonl')),
    readJsonlMaybe(path.join(options.realtimeDir, 'pure-ws-paper-trades.jsonl')),
    readJsonlMaybe(path.join(options.realtimeDir, 'kol-partial-takes.jsonl')),
    readJsonlMaybe(cfg.outputFile),
  ]);

  const closeByPosition = new Map<string, Record<string, unknown>>();
  for (const row of closes) {
    const id = stringField(row.positionId);
    if (id) closeByPosition.set(id, row);
  }
  const existingKeys = new Set<string>();
  for (const row of existing) {
    const id = stringField(row.positionId);
    const anchorType = stringField(row.anchorType);
    const horizonSec = numberField(row.horizonSec);
    if (id && anchorType && horizonSec != null) {
      if (isRetryableExistingMarkout(row)) continue;
      const anchorTxSignature = stringField(row.anchorTxSignature);
      const anchorAtMs = timeField(row.anchorAt);
      existingKeys.add(
        markoutKey({
          positionId: id,
          anchorType: anchorType as TradeMarkoutAnchorType,
          anchorTxSignature,
          anchorAtMs: anchorAtMs ?? undefined,
        }, horizonSec)
      );
      if (!anchorTxSignature && anchorAtMs == null) {
        existingKeys.add(legacyMarkoutKey(id, anchorType as TradeMarkoutAnchorType, horizonSec));
      }
    }
  }
  summary.existingMarkouts = existingKeys.size;

  const anchors: TradeMarkoutAnchor[] = [];
  for (const row of anchorRows) {
    const anchor = buildAnchorFromAnchorRecord(row);
    if (!anchor || (anchor.anchorAtMs ?? 0) < sinceMs) continue;
    summary.loadedAnchorRecords += 1;
    anchors.push(anchor);
  }
  for (const row of buys) {
    const anchor = buildBuyAnchor(row);
    if (!anchor || (anchor.anchorAtMs ?? 0) < sinceMs) continue;
    summary.loadedBuys += 1;
    anchors.push(anchor);
  }
  for (const row of sells) {
    const close = closeByPosition.get(stringField(row.positionId) ?? '');
    const anchor = buildSellAnchor(row, close);
    if (!anchor || (anchor.anchorAtMs ?? 0) < sinceMs) continue;
    summary.loadedSells += 1;
    anchors.push(anchor);
  }
  for (const row of [...paperCloses, ...shadowPaperCloses]) {
    const paperAnchors = buildPaperCloseAnchors(row);
    if (paperAnchors.length === 0) continue;
    summary.loadedPaperCloses += 1;
    for (const anchor of paperAnchors) {
      if ((anchor.anchorAtMs ?? 0) >= sinceMs) anchors.push(anchor);
    }
  }
  for (const row of pureWsPaperCloses) {
    const paperAnchors = buildPureWsPaperCloseAnchors(row);
    if (paperAnchors.length === 0) continue;
    summary.loadedPaperCloses += 1;
    for (const anchor of paperAnchors) {
      if ((anchor.anchorAtMs ?? 0) >= sinceMs) anchors.push(anchor);
    }
  }
  for (const row of partialTakes) {
    const anchor = buildPartialTakeAnchor(row);
    if (!anchor || (anchor.anchorAtMs ?? 0) < sinceMs) continue;
    summary.loadedPartialTakes += 1;
    anchors.push(anchor);
  }

  for (const anchor of anchors) {
    for (const horizonSec of markoutOffsetsForAnchor(anchor, cfg)) {
      const key = markoutKey(anchor, horizonSec);
      const legacyKey = legacyMarkoutKey(anchor.positionId, anchor.anchorType, horizonSec);
      const hasUniqueAnchor = Boolean(anchor.anchorTxSignature || anchor.anchorAtMs != null);
      if (existingKeys.has(key) || (!hasUniqueAnchor && existingKeys.has(legacyKey)) || scheduled.has(key)) {
        summary.skippedExisting += 1;
        continue;
      }
      const anchorAtMs = anchor.anchorAtMs ?? nowMs;
      const targetMs = anchorAtMs + horizonSec * 1000;
      if (nowMs - targetMs > maxCatchupAgeSec * 1000) {
        summary.skippedExpired += 1;
        continue;
      }
      scheduleProbe(anchor, cfg, horizonSec, Math.max(0, targetMs - nowMs));
      summary.scheduled += 1;
    }
  }

  return summary;
}

function markoutOffsetsForAnchor(anchor: TradeMarkoutAnchor, cfg: TradeMarkoutObserverConfig): number[] {
  const raw = anchor.extras?.markoutOffsetsSec;
  if (!Array.isArray(raw)) return cfg.offsetsSec;
  const parsed = raw
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return parsed.length > 0 ? [...new Set(parsed)].sort((a, b) => a - b) : cfg.offsetsSec;
}

function isRetryableExistingMarkout(row: Record<string, unknown>): boolean {
  if (stringField(row.quoteStatus) !== 'rate_limited') return false;
  const reason = stringField(row.quoteReason);
  if (!isRetryableQuoteReason(reason)) return false;
  const horizonSec = numberField(row.horizonSec);
  const anchorAtMs = timeField(row.anchorAt);
  if (horizonSec == null || anchorAtMs == null) return false;
  return Date.now() <= anchorAtMs + horizonSec * 1000 + maxRetryLateMs(horizonSec);
}

function isRetryableQuoteReason(reason: string | null): boolean {
  if (!reason || reason.endsWith('_exhausted')) return false;
  return reason === 'observer_inflight_cap' || reason === 'observer_cooldown' || /429|rate[_ ]?limit/i.test(reason);
}

function scheduleProbe(
  anchor: TradeMarkoutAnchor,
  cfg: TradeMarkoutObserverConfig,
  horizonSec: number,
  delayMs: number,
  retryAttempt = 0,
): void {
  const key = markoutKey(anchor, horizonSec);
  if (scheduled.has(key)) return;

  const timer = setTimeout(() => {
    scheduled.delete(key);
    runProbe(anchor, cfg, horizonSec, retryAttempt)
      .catch((err) => log.debug(`[TRADE_MARKOUT] probe error: ${String(err)}`));
  }, delayMs);
  if (timer.unref) timer.unref();
  scheduled.set(key, { key, timer, retryAttempt });
}

async function runProbe(
  anchor: TradeMarkoutAnchor,
  cfg: TradeMarkoutObserverConfig,
  horizonSec: number,
  retryAttempt = 0,
): Promise<void> {
  const firedAtMs = Date.now();
  let observedPrice: number | null = null;
  let quoteStatus: TradeMarkoutQuoteStatus = 'ok';
  let quoteReason: string | null = null;
  let outAmountRaw: string | null = null;
  let outputDecimals: number | null = anchor.tokenDecimals ?? null;

  if (firedAtMs < rateLimitedUntilMs) {
    quoteStatus = 'rate_limited';
    quoteReason = 'observer_cooldown';
    if (scheduleRetryableProbe(anchor, cfg, horizonSec, firedAtMs, retryAttempt, quoteReason)) return;
    quoteReason = exhaustedQuoteReason(quoteReason);
  } else if (cfg.maxInflight > 0 && inflightProbes >= cfg.maxInflight) {
    quoteStatus = 'rate_limited';
    quoteReason = 'observer_inflight_cap';
    if (scheduleRetryableProbe(anchor, cfg, horizonSec, firedAtMs, retryAttempt, quoteReason)) return;
    quoteReason = exhaustedQuoteReason(quoteReason);
  } else {
    inflightProbes += 1;
    try {
      const quote = await fetchForwardQuote(anchor, cfg);
      if (!quote) {
        quoteStatus = 'no_route';
        quoteReason = 'no_route_or_zero_out';
      } else {
        outAmountRaw = quote.outAmount.toString();
        const decimals = quote.outputDecimals ?? anchor.tokenDecimals ?? null;
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
            observedPrice = anchor.probeSolAmount / outUi;
          }
        }
      }
    } catch (err) {
      quoteStatus = is429Error(err) ? 'rate_limited' : 'error';
      quoteReason = err instanceof Error ? err.message : String(err);
      if (quoteStatus === 'rate_limited') {
        recordJupiter429('trade_markout_observer');
        if (cfg.rateLimitCooldownMs > 0) {
          rateLimitedUntilMs = Date.now() + cfg.rateLimitCooldownMs;
        }
        if (scheduleRetryableProbe(anchor, cfg, horizonSec, Date.now(), retryAttempt, 'jupiter_429')) return;
        quoteReason = exhaustedQuoteReason('jupiter_429');
      }
    } finally {
      inflightProbes = Math.max(0, inflightProbes - 1);
    }
  }

  const deltaPct =
    observedPrice != null && anchor.anchorPrice > 0
      ? (observedPrice - anchor.anchorPrice) / anchor.anchorPrice
      : null;

  const record: TradeMarkoutRecord = {
    schemaVersion: TRADE_MARKOUT_SCHEMA_VERSION,
    eventId: `tm-${markoutKey(anchor, horizonSec)}`,
    anchorType: anchor.anchorType,
    positionId: anchor.positionId,
    tokenMint: anchor.tokenMint,
    anchorTxSignature: anchor.anchorTxSignature ?? null,
    anchorAt: new Date(anchor.anchorAtMs ?? firedAtMs).toISOString(),
    anchorPrice: anchor.anchorPrice,
    anchorPriceKind: anchor.anchorPriceKind,
    probeSolAmount: anchor.probeSolAmount,
    horizonSec,
    firedAt: new Date(firedAtMs).toISOString(),
    observedPrice,
    deltaPct,
    quoteStatus,
    quoteReason,
    outAmountRaw,
    outputDecimals,
    source: 'jupiter_quote',
    signalSource: anchor.signalSource ?? null,
    extras: anchor.extras ?? null,
    recordedAt: new Date().toISOString(),
  };
  await writeRecord(cfg.outputFile, record);
}

function exhaustedQuoteReason(reason: string): string {
  if (reason.endsWith('_exhausted')) return reason;
  return `${reason}_exhausted`;
}

function scheduleRetryableProbe(
  anchor: TradeMarkoutAnchor,
  cfg: TradeMarkoutObserverConfig,
  horizonSec: number,
  firedAtMs: number,
  retryAttempt: number,
  reason: string,
): boolean {
  const retryDelayMs = computeRetryDelayMs(cfg, retryAttempt);
  const targetMs = (anchor.anchorAtMs ?? firedAtMs) + horizonSec * 1000;
  const maxRetryUntilMs = targetMs + maxRetryLateMs(horizonSec);
  if (firedAtMs + retryDelayMs > maxRetryUntilMs) return false;
  scheduleProbe(anchor, cfg, horizonSec, retryDelayMs, retryAttempt + 1);
  log.debug(
    `[TRADE_MARKOUT_RETRY] ${anchor.positionId} ${anchor.anchorType} T+${horizonSec}s ` +
    `reason=${reason} retry=${retryAttempt + 1} delayMs=${retryDelayMs}`
  );
  return true;
}

function computeRetryDelayMs(cfg: TradeMarkoutObserverConfig, retryAttempt: number): number {
  const baseMs = Math.max(1_000, cfg.rateLimitCooldownMs > 0 ? cfg.rateLimitCooldownMs : 5_000);
  const multiplier = Math.pow(2, Math.min(4, Math.max(0, retryAttempt)));
  return Math.min(60_000, Math.round(baseMs * multiplier));
}

function maxRetryLateMs(horizonSec: number): number {
  if (horizonSec <= 60) return 60_000;
  if (horizonSec <= 300) return 180_000;
  return 600_000;
}

interface ForwardQuote {
  outAmount: bigint;
  outputDecimals: number | null;
}

async function fetchForwardQuote(
  anchor: TradeMarkoutAnchor,
  cfg: TradeMarkoutObserverConfig,
): Promise<ForwardQuote | null> {
  const amountLamports = BigInt(Math.round(anchor.probeSolAmount * LAMPORTS_PER_SOL));
  const headers: Record<string, string> = {};
  if (cfg.jupiterApiKey) headers['X-API-Key'] = cfg.jupiterApiKey;
  const response = await axios.get(`${cfg.jupiterApiUrl}/quote`, {
    params: {
      inputMint: SOL_MINT,
      outputMint: anchor.tokenMint,
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

async function writeRecord(outputFile: string, record: TradeMarkoutRecord): Promise<void> {
  try {
    if (!outputDirEnsured) {
      await mkdir(path.dirname(outputFile), { recursive: true });
      outputDirEnsured = true;
    }
    await appendFile(outputFile, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    log.warn(`[TRADE_MARKOUT_APPEND_FAIL] ${record.positionId} ${record.anchorType} ${record.horizonSec}s ${err}`);
  }
}

async function writeAnchorRecord(outputFile: string, anchor: TradeMarkoutAnchor): Promise<void> {
  const anchorAtMs = anchor.anchorAtMs ?? Date.now();
  const record: TradeMarkoutAnchorRecord = {
    schemaVersion: TRADE_MARKOUT_ANCHOR_SCHEMA_VERSION,
    eventId: `tma-${anchorIdentity(anchor)}`,
    anchorType: anchor.anchorType,
    positionId: anchor.positionId,
    tokenMint: anchor.tokenMint,
    anchorTxSignature: anchor.anchorTxSignature ?? null,
    anchorAt: new Date(anchorAtMs).toISOString(),
    anchorPrice: anchor.anchorPrice,
    anchorPriceKind: anchor.anchorPriceKind,
    probeSolAmount: anchor.probeSolAmount,
    tokenDecimals: anchor.tokenDecimals ?? null,
    signalSource: anchor.signalSource ?? null,
    extras: anchor.extras ?? null,
    recordedAt: new Date().toISOString(),
  };
  try {
    if (!outputDirEnsured) {
      await mkdir(path.dirname(outputFile), { recursive: true });
      outputDirEnsured = true;
    }
    await appendFile(outputFile, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    log.warn(`[TRADE_MARKOUT_ANCHOR_APPEND_FAIL] ${anchor.positionId} ${anchor.anchorType} ${err}`);
  }
}

async function readJsonlMaybe(file: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function resolveConfig(config: Partial<TradeMarkoutObserverConfig>): TradeMarkoutObserverConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    offsetsSec: Array.isArray(config.offsetsSec) && config.offsetsSec.length > 0
      ? config.offsetsSec.filter((n) => Number.isFinite(n) && n > 0)
      : [...DEFAULT_CONFIG.offsetsSec],
    jupiterApiUrl: normalizeJupiterSwapApiUrl(config.jupiterApiUrl ?? DEFAULT_CONFIG.jupiterApiUrl),
  };
}

function isValidAnchor(anchor: TradeMarkoutAnchor, cfg: TradeMarkoutObserverConfig): boolean {
  return Boolean(
    cfg.outputFile &&
    anchor.positionId &&
    anchor.tokenMint &&
    Number.isFinite(anchor.anchorPrice) &&
    anchor.anchorPrice > 0 &&
    Number.isFinite(anchor.probeSolAmount) &&
    anchor.probeSolAmount > 0 &&
    cfg.offsetsSec.length > 0,
  );
}

function computeJitterMs(offsetSec: number, jitterPct: number): number {
  if (!Number.isFinite(jitterPct) || jitterPct <= 0) return 0;
  const span = offsetSec * 1000 * jitterPct;
  return Math.round((Math.random() * 2 - 1) * span);
}

function pruneRecentAnchorKeys(nowMs: number, dedupWindowSec: number): void {
  const before = nowMs - dedupWindowSec * 1000;
  for (const [key, timestampMs] of recentAnchorKeys) {
    if (timestampMs < before) recentAnchorKeys.delete(key);
  }
}

function markoutKey(
  anchor: Pick<TradeMarkoutAnchor, 'positionId' | 'anchorType' | 'anchorTxSignature' | 'anchorAtMs'>,
  horizonSec: number,
): string {
  return `${anchorIdentity(anchor)}:${horizonSec}`;
}

function anchorIdentity(
  anchor: Pick<TradeMarkoutAnchor, 'positionId' | 'anchorType' | 'anchorTxSignature' | 'anchorAtMs'>,
): string {
  const anchorId = anchor.anchorTxSignature ?? (anchor.anchorAtMs != null ? String(secondMs(anchor.anchorAtMs)) : 'na');
  return `${anchor.anchorType}:${anchor.positionId}:${anchorId}`;
}

function legacyMarkoutKey(positionId: string, anchorType: TradeMarkoutAnchorType, horizonSec: number): string {
  return `${anchorType}:${positionId}:${horizonSec}`;
}

function is429Error(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/status code 429|rate[_ ]?limit|too many requests/i.test(msg)) return true;
  const anyErr = err as { response?: { status?: number } };
  return anyErr?.response?.status === 429;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timeField(value: unknown): number | null {
  const direct = numberField(value);
  if (direct != null) return direct < 1e12 ? direct * 1000 : direct;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function secondMs(value: number): number {
  return Math.floor(value / 1000) * 1000;
}

function buildAnchorFromAnchorRecord(row: Record<string, unknown>): TradeMarkoutAnchor | null {
  const positionId = stringField(row.positionId);
  const tokenMint = stringField(row.tokenMint);
  const anchorType = stringField(row.anchorType) as TradeMarkoutAnchorType | null;
  const anchorAtMs = timeField(row.anchorAt);
  const anchorPrice = numberField(row.anchorPrice);
  const probeSolAmount = numberField(row.probeSolAmount);
  const anchorPriceKind = stringField(row.anchorPriceKind) as TradeMarkoutPriceKind | null;
  if (
    !positionId ||
    !tokenMint ||
    (anchorType !== 'buy' && anchorType !== 'sell') ||
    anchorAtMs == null ||
    anchorPrice == null ||
    probeSolAmount == null ||
    (anchorPriceKind !== 'entry_token_only' && anchorPriceKind !== 'exit_token_only' && anchorPriceKind !== 'wallet_delta_fallback')
  ) {
    return null;
  }
  return {
    anchorType,
    positionId,
    tokenMint,
    anchorTxSignature: stringField(row.anchorTxSignature),
    anchorAtMs,
    anchorPrice,
    anchorPriceKind,
    probeSolAmount,
    tokenDecimals: numberField(row.tokenDecimals),
    signalSource: stringField(row.signalSource),
    extras: typeof row.extras === 'object' && row.extras != null
      ? row.extras as Record<string, unknown>
      : undefined,
  };
}

function buildBuyAnchor(row: Record<string, unknown>): TradeMarkoutAnchor | null {
  if (stringField(row.strategy) !== 'kol_hunter') return null;
  const positionId = stringField(row.positionId);
  const tokenMint = stringField(row.pairAddress);
  const anchorPrice = numberField(row.entryPriceTokenOnly) ?? numberField(row.actualEntryPrice);
  const probeSolAmount = numberField(row.swapInputUiAmount) ?? numberField(row.actualInputUiAmount);
  const anchorAtMs = timeField(row.buyCompletedAtMs) ?? timeField(row.recordedAt);
  if (!positionId || !tokenMint || anchorPrice == null || probeSolAmount == null || anchorAtMs == null) return null;
  return {
    anchorType: 'buy',
    positionId,
    tokenMint,
    anchorTxSignature: stringField(row.txSignature),
    anchorAtMs,
    anchorPrice,
    anchorPriceKind: numberField(row.entryPriceTokenOnly) != null ? 'entry_token_only' : 'wallet_delta_fallback',
    probeSolAmount,
    tokenDecimals: numberField(row.outputDecimals),
    signalSource: stringField(row.strategy),
  };
}

function buildSellAnchor(
  row: Record<string, unknown>,
  closeRow?: Record<string, unknown>,
): TradeMarkoutAnchor | null {
  if (stringField(row.strategy) !== 'kol_hunter') return null;
  const positionId = stringField(row.positionId);
  const tokenMint = stringField(row.pairAddress);
  const anchorPrice = numberField(row.exitPriceTokenOnly) ?? numberField(row.actualExitPrice);
  const probeSolAmount = numberField(row.swapInputSol) ?? numberField(row.solSpentNominal);
  const anchorAtMs = timeField(row.recordedAt);
  if (!positionId || !tokenMint || anchorPrice == null || probeSolAmount == null || anchorAtMs == null) return null;
  return {
    anchorType: 'sell',
    positionId,
    tokenMint,
    anchorTxSignature: stringField(row.txSignature),
    anchorAtMs,
    anchorPrice,
    anchorPriceKind: numberField(row.exitPriceTokenOnly) != null ? 'exit_token_only' : 'wallet_delta_fallback',
    probeSolAmount,
    tokenDecimals: numberField(closeRow?.tokenDecimals),
    signalSource: stringField(row.armName) ?? stringField(row.strategy),
    extras: {
      exitReason: stringField(row.exitReason),
    },
  };
}

function buildPaperCloseAnchors(row: Record<string, unknown>): TradeMarkoutAnchor[] {
  if (stringField(row.strategy) !== 'kol_hunter') return [];
  const positionId = stringField(row.positionId);
  const tokenMint = stringField(row.tokenMint);
  const closedAtMs = timeField(row.closedAt);
  const holdSec = numberField(row.holdSec);
  const entryPrice = numberField(row.entryPriceTokenOnly) ?? numberField(row.entryPrice);
  const exitPrice = numberField(row.exitPriceTokenOnly) ?? numberField(row.exitPrice);
  const ticketSol = numberField(row.ticketSol);
  const inferredTicketSol = ticketSol ?? inferTicketSol(row);
  const probeSolAmount =
    numberField(row.swapInputSol) ??
    inferredTicketSol;
  if (
    !positionId ||
    !tokenMint ||
    closedAtMs == null ||
    holdSec == null ||
    entryPrice == null ||
    exitPrice == null ||
    probeSolAmount == null ||
    probeSolAmount <= 0
  ) {
    return [];
  }

  const common = {
    positionId,
    tokenMint,
    probeSolAmount,
    tokenDecimals: numberField(row.tokenDecimals),
    signalSource: stringField(row.armName) ?? stringField(row.strategy),
    extras: {
      mode: 'paper',
      probeSolAmountSource: numberField(row.swapInputSol) != null
        ? 'swapInputSol'
        : ticketSol != null
          ? 'ticketSol'
          : 'inferredFromPnl',
      exitReason: stringField(row.exitReason),
      armName: stringField(row.armName),
      parameterVersion: stringField(row.parameterVersion),
      isShadowArm: row.isShadowArm === true,
      parentPositionId: stringField(row.parentPositionId),
    },
  };
  return [
    {
      ...common,
      anchorType: 'buy',
      anchorTxSignature: null,
      anchorAtMs: secondMs(closedAtMs - holdSec * 1000),
      anchorPrice: entryPrice,
      anchorPriceKind: numberField(row.entryPriceTokenOnly) != null ? 'entry_token_only' : 'wallet_delta_fallback',
    },
    {
      ...common,
      anchorType: 'sell',
      anchorTxSignature: null,
      anchorAtMs: secondMs(closedAtMs),
      anchorPrice: exitPrice,
      anchorPriceKind: numberField(row.exitPriceTokenOnly) != null ? 'exit_token_only' : 'wallet_delta_fallback',
    },
  ];
}

function buildPureWsPaperCloseAnchors(row: Record<string, unknown>): TradeMarkoutAnchor[] {
  const strategy = stringField(row.strategy);
  if (!strategy?.startsWith('pure_ws')) return [];
  const positionId = stringField(row.positionId);
  const tokenMint = stringField(row.pairAddress);
  const entryAtMs = timeField(row.entryAt) ?? timeField(row.entryTimeSec);
  const closedAtMs = timeField(row.closedAt) ?? timeField(row.exitTimeSec);
  const entryPrice = numberField(row.entryPrice);
  const exitPrice = numberField(row.exitPrice);
  const probeSolAmount = numberField(row.ticketSol) ?? inferTicketSol(row);
  if (
    !positionId ||
    !tokenMint ||
    entryAtMs == null ||
    closedAtMs == null ||
    entryPrice == null ||
    exitPrice == null ||
    probeSolAmount == null ||
    probeSolAmount <= 0
  ) {
    return [];
  }
  const common = {
    positionId,
    tokenMint,
    probeSolAmount,
    tokenDecimals: numberField(row.tokenDecimals),
    signalSource: stringField(row.armName) ?? strategy,
    extras: {
      lane: 'pure_ws',
      mode: 'paper',
      strategy,
      armName: stringField(row.armName),
      parameterVersion: stringField(row.parameterVersion),
      isShadowArm: row.isShadowArm === true,
      parentPositionId: stringField(row.parentPositionId),
      executionMode: stringField(row.executionMode),
      paperOnlyReason: stringField(row.paperOnlyReason),
      sourceLabel: stringField(row.sourceLabel),
      discoverySource: stringField(row.discoverySource),
      exitReason: stringField(row.exitReason),
      markoutOffsetsSec: [15, 30, 60, 180, 300, 1800],
    },
  };
  return [
    {
      ...common,
      anchorType: 'buy',
      anchorTxSignature: null,
      anchorAtMs: secondMs(entryAtMs),
      anchorPrice: entryPrice,
      anchorPriceKind: 'entry_token_only',
    },
    {
      ...common,
      anchorType: 'sell',
      anchorTxSignature: null,
      anchorAtMs: secondMs(closedAtMs),
      anchorPrice: exitPrice,
      anchorPriceKind: 'exit_token_only',
    },
  ];
}

function buildPartialTakeAnchor(row: Record<string, unknown>): TradeMarkoutAnchor | null {
  if (stringField(row.strategy) !== 'kol_hunter') return null;
  const positionId = stringField(row.positionId);
  const tokenMint = stringField(row.tokenMint);
  const anchorAtMs = timeField(row.promotedAt);
  const anchorPrice = numberField(row.exitPrice);
  const probeSolAmount = numberField(row.lockedTicketSol);
  if (!positionId || !tokenMint || anchorAtMs == null || anchorPrice == null || probeSolAmount == null) return null;
  return {
    anchorType: 'sell',
    positionId,
    tokenMint,
    anchorTxSignature: null,
    anchorAtMs,
    anchorPrice,
    anchorPriceKind: 'exit_token_only',
    probeSolAmount,
    tokenDecimals: numberField(row.tokenDecimals),
    signalSource: stringField(row.armName) ?? stringField(row.strategy),
    extras: {
      mode: 'paper',
      eventType: stringField(row.eventType) ?? 'partial_take',
      armName: stringField(row.armName),
      parameterVersion: stringField(row.parameterVersion),
      isShadowArm: row.isShadowArm === true,
      mfePctAtTake: numberField(row.mfePctAtTake),
      lockedQuantity: numberField(row.lockedQuantity),
      lockedNetPct: numberField(row.lockedNetPct),
    },
  };
}

function inferTicketSol(row: Record<string, unknown>): number | null {
  const netSol = numberField(row.netSol);
  const netPct = numberField(row.netPct);
  if (netSol != null && netPct != null && Math.abs(netPct) > 1e-9) {
    const inferred = Math.abs(netSol / netPct);
    return Number.isFinite(inferred) && inferred > 0 ? inferred : null;
  }
  return null;
}
