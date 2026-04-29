/**
 * Token Symbol Resolver (2026-04-29, 외부 전략 리포트 후속).
 *
 * Why: Telegram 진입/종료 알림에서 tokenSymbol 누락 시 `8KQhezEX...6hRY` 같은 shortened
 *   address 만 표시 → 운영자가 token 식별 어려움. Helius DAS getAsset 으로 lazy 해결.
 *
 * Flow:
 *   1) In-memory cache (24h TTL) — hottest path
 *   2) Persisted JSONL cache (data/realtime/token-symbols.jsonl) — restart 후 보존
 *   3) Helius DAS `getAsset` (primary) — 모든 Solana token (Token-2022 metadata 포함)
 *   4) Pump.fun frontend-api (fallback) — pump 토큰 한정
 *   5) Negative cache (1h TTL) — 실패 시 spam lookup 차단
 *
 * Notifier path 차단 방지:
 *   - resolveTokenSymbol() 은 비동기 fire-and-forget 로 prefetch 권장
 *   - 알림 발사 시점에 lookupCachedSymbol() 만 사용 (RPC 호출 없음)
 *   - cache miss 시 shortenAddress() fallback (현재 동작 보존)
 */
import axios from 'axios';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('TokenSymbolResolver');

const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;  // 24h
const NEGATIVE_TTL_MS = 60 * 60 * 1000;       // 1h (실패 시 spam 차단)
const REQUEST_TIMEOUT_MS = 3_000;
const PERSIST_FILE = 'token-symbols.jsonl';

interface CacheEntry {
  symbol: string | null;  // null = negative (resolved but no symbol)
  resolvedAt: number;
}

const memCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string | null>>();
// F1 fix (2026-04-29 QA): single-flight hydrate. 이전엔 `if (!hydrated)` race 로 burst 시 N회 readFile.
let hydratePromise: Promise<void> | null = null;
let persistDirEnsured = false;

/** 동기 cache lookup — notifier path 에서만 호출. RPC 0. */
export function lookupCachedSymbol(mint: string): string | null {
  const entry = memCache.get(mint);
  if (!entry) return null;
  const ttl = entry.symbol == null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
  if (Date.now() - entry.resolvedAt >= ttl) return null;
  return entry.symbol;  // null OR string
}

/**
 * 비동기 resolve — prefetch / 새 mint 첫 만남 시 호출.
 * cache hit 시 즉시 반환. miss 시 Helius → pump.fun fallback. 실패 시 negative cache.
 */
export async function resolveTokenSymbol(mint: string): Promise<string | null> {
  if (!hydratePromise) {
    hydratePromise = hydrateFromDisk().catch((err) => {
      log.debug(`hydrate failed: ${err}`);
    });
  }
  await hydratePromise;
  const cached = memCache.get(mint);
  if (cached) {
    const ttl = cached.symbol == null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
    if (Date.now() - cached.resolvedAt < ttl) return cached.symbol;
  }
  // In-flight dedup — 동일 mint 동시 prefetch 차단
  const pending = inFlight.get(mint);
  if (pending) return pending;
  const promise = doResolve(mint).finally(() => inFlight.delete(mint));
  inFlight.set(mint, promise);
  return promise;
}

async function doResolve(mint: string): Promise<string | null> {
  // Primary: Helius DAS
  let symbol = await fetchFromHelius(mint).catch(() => null);
  // Fallback: pump.fun
  if (!symbol) {
    symbol = await fetchFromPumpFun(mint).catch(() => null);
  }
  const entry: CacheEntry = { symbol: symbol ?? null, resolvedAt: Date.now() };
  memCache.set(mint, entry);
  // F5 fix (2026-04-29 QA): negative cache 는 disk persist 제외.
  //   신생 mint metadata 가 launch 직후 누락된 경우, 1h 동안 disk hydrate 가 fallback 차단하는 부작용 방지.
  // F2 fix: positive cache 만 disk append → 24h 후 자연 expire (hydrate 시 skip).
  if (symbol) {
    void persistEntry(mint, entry).catch(() => {});  // best-effort
  }
  return symbol;
}

async function fetchFromHelius(mint: string): Promise<string | null> {
  const apiKey = config.heliusApiKey;
  if (!apiKey) return null;
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const body = {
    jsonrpc: '2.0',
    id: `kol-symbol-${mint.slice(0, 8)}`,
    method: 'getAsset',
    params: { id: mint },
  };
  try {
    const res = await axios.post(url, body, { timeout: REQUEST_TIMEOUT_MS });
    const symbol = extractHeliusSymbol(res.data);
    return symbol;
  } catch (err) {
    log.debug(`helius getAsset failed for ${mint.slice(0, 8)}: ${err}`);
    return null;
  }
}

/** Helius DAS getAsset response 에서 symbol 추출. Metaplex / Token-2022 both. */
function extractHeliusSymbol(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== 'object') return null;
  // Metaplex: result.content.metadata.symbol
  const content = (result as { content?: { metadata?: { symbol?: string } } }).content;
  const metaSymbol = content?.metadata?.symbol;
  if (typeof metaSymbol === 'string' && metaSymbol.trim().length > 0) {
    return sanitizeSymbol(metaSymbol);
  }
  // Token-2022 metadata extension: result.token_info.symbol (DAS 가 자동 normalize)
  const tokenInfo = (result as { token_info?: { symbol?: string } }).token_info;
  const tiSymbol = tokenInfo?.symbol;
  if (typeof tiSymbol === 'string' && tiSymbol.trim().length > 0) {
    return sanitizeSymbol(tiSymbol);
  }
  return null;
}

async function fetchFromPumpFun(mint: string): Promise<string | null> {
  const url = `https://frontend-api.pump.fun/coins/${mint}`;
  try {
    const res = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });
    const data = res.data;
    if (data && typeof data === 'object') {
      const symbol = (data as { symbol?: string }).symbol;
      if (typeof symbol === 'string' && symbol.trim().length > 0) {
        return sanitizeSymbol(symbol);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** symbol 길이 / 위험 char 검증 — UI 안전성. */
function sanitizeSymbol(raw: string): string {
  // null byte / control char 제거 + max 16 char
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleaned.slice(0, 16);
}

async function hydrateFromDisk(): Promise<void> {
  try {
    const dir = config.realtimeDataDir;
    const file = path.join(dir, PERSIST_FILE);
    const text = await readFile(file, 'utf8').catch(() => '');
    if (!text) return;
    const now = Date.now();
    let loaded = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { mint?: string; symbol?: string | null; resolvedAt?: number };
        if (typeof entry.mint !== 'string' || typeof entry.resolvedAt !== 'number') continue;
        const ttl = entry.symbol == null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
        if (now - entry.resolvedAt >= ttl) continue;
        memCache.set(entry.mint, { symbol: entry.symbol ?? null, resolvedAt: entry.resolvedAt });
        loaded++;
      } catch {
        // malformed — skip
      }
    }
    if (loaded > 0) log.info(`[TokenSymbolResolver] hydrated ${loaded} symbol(s) from disk`);
  } catch (err) {
    log.debug(`hydrate failed: ${err}`);
  }
}

async function persistEntry(mint: string, entry: CacheEntry): Promise<void> {
  try {
    const dir = config.realtimeDataDir;
    if (!persistDirEnsured) {
      await mkdir(dir, { recursive: true });
      persistDirEnsured = true;
    }
    const line = JSON.stringify({ mint, symbol: entry.symbol, resolvedAt: entry.resolvedAt }) + '\n';
    await appendFile(path.join(dir, PERSIST_FILE), line, 'utf8');
  } catch {
    // best-effort
  }
}

/** 운영자 / test 용. */
export function resetTokenSymbolResolverForTests(): void {
  memCache.clear();
  inFlight.clear();
  hydratePromise = null;
  persistDirEnsured = false;
}

/** Test 용 — DAS / pump.fun 호출 없이 symbol 주입. */
export function injectSymbolForTests(mint: string, symbol: string | null): void {
  memCache.set(mint, { symbol, resolvedAt: Date.now() });
}
