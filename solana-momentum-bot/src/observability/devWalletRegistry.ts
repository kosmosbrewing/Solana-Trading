/**
 * Dev Wallet Registry (2026-05-01, Decu Quality Layer Phase B.5).
 *
 * ADR §5 정합. 운영자 수동 dev list — KOL DB 패턴 (src/kol/db.ts) 정합.
 *
 * 정책:
 *   - 수동 편집 only (자동 추가 API 미제공)
 *   - hot reload (default 60s) — 파일 mtime watch
 *   - allowlist 도 security/sell quote/drift guard 우회 금지 (Phase B/C 에서는 report only)
 *   - lookup 은 address → DevEntry 역인덱스 O(1)
 */
import { readFile, stat } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import type { DevStatus } from './tokenQualityInspector';

const log = createModuleLogger('DevWalletRegistry');

// ─── Schema ─────────────────────────────────────────────

export interface DevEntry {
  id: string;
  addresses: string[];
  status: DevStatus;
  is_active?: boolean;
  source?: string;
  added_at?: string;
  last_verified_at?: string;
  notes?: string;
  known_projects?: string[];
  risk_notes?: string[];
  success_notes?: string[];
}

export interface DevWalletDbFile {
  version: string;
  last_updated: string;
  devs: DevEntry[];
}

export interface DevWalletRegistryConfig {
  /** 파일 경로 (default: data/dev-wallets/wallets.json) */
  path: string;
  /** hot reload polling 주기 (ms). 0 = 비활성 */
  hotReloadIntervalMs: number;
}

export const DEFAULT_DEV_WALLET_CONFIG: DevWalletRegistryConfig = {
  path: path.resolve(process.cwd(), 'data/dev-wallets/wallets.json'),
  hotReloadIntervalMs: 60_000,
};

// ─── Module state ───────────────────────────────────────

let loadedFile: DevWalletDbFile | null = null;
let addressIndex = new Map<string, DevEntry>();
let lastLoadedMtimeMs = 0;
let watchTimer: NodeJS.Timeout | null = null;

// ─── Public API ─────────────────────────────────────────

export async function initDevWalletRegistry(config: Partial<DevWalletRegistryConfig> = {}): Promise<void> {
  const cfg = { ...DEFAULT_DEV_WALLET_CONFIG, ...config };
  await loadFile(cfg.path);
  if (cfg.hotReloadIntervalMs > 0 && !watchTimer) {
    watchTimer = setInterval(() => {
      reloadIfChanged(cfg.path).catch((err) => {
        log.debug(`[DEV_WALLET] hot reload error: ${String(err)}`);
      });
    }, cfg.hotReloadIntervalMs);
    if (watchTimer.unref) watchTimer.unref();
  }
}

export function stopDevWalletRegistryWatcher(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

export function resetDevWalletRegistryState(): void {
  stopDevWalletRegistryWatcher();
  loadedFile = null;
  addressIndex = new Map();
  lastLoadedMtimeMs = 0;
}

/**
 * Address 로 dev entry lookup. is_active=false 는 lookup 제외 (과거 보존용).
 * Solana address 는 case-sensitive — 대소문자 보존.
 */
export function lookupDevByAddress(address: string): DevEntry | undefined {
  if (!address) return undefined;
  const entry = addressIndex.get(address);
  if (!entry || entry.is_active === false) return undefined;
  return entry;
}

/**
 * Address → DevStatus 매핑 (lookup 안 됐으면 'unknown').
 * tokenQualityInspector 가 직접 호출.
 */
export function resolveDevStatus(address?: string): DevStatus {
  if (!address) return 'unknown';
  const entry = addressIndex.get(address);
  if (!entry || entry.is_active === false) return 'unknown';
  return entry.status;
}

export function getAllDevs(): DevEntry[] {
  return loadedFile?.devs.filter((d) => d.is_active !== false) ?? [];
}

export function getDevWalletRegistryStats(): {
  totalEntries: number;
  activeEntries: number;
  addressCount: number;
  byStatus: Record<DevStatus, number>;
} {
  const all = loadedFile?.devs ?? [];
  const active = all.filter((d) => d.is_active !== false);
  const byStatus: Record<DevStatus, number> = { allowlist: 0, watchlist: 0, blacklist: 0, unknown: 0 };
  for (const d of active) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
  return {
    totalEntries: all.length,
    activeEntries: active.length,
    addressCount: addressIndex.size,
    byStatus,
  };
}

// ─── Internal ───────────────────────────────────────────

async function loadFile(filePath: string): Promise<void> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as DevWalletDbFile;
    if (!parsed || !Array.isArray(parsed.devs)) {
      throw new Error('invalid schema — devs[] missing');
    }
    loadedFile = parsed;
    rebuildAddressIndex(parsed);
    const st = await stat(filePath);
    lastLoadedMtimeMs = st.mtimeMs;
    const stats = getDevWalletRegistryStats();
    log.info(
      `[DEV_WALLET] loaded ${stats.activeEntries}/${stats.totalEntries} active devs ` +
      `(addresses=${stats.addressCount}, allowlist=${stats.byStatus.allowlist}, ` +
      `watchlist=${stats.byStatus.watchlist}, blacklist=${stats.byStatus.blacklist})`
    );
  } catch (err) {
    // fail-open — 파일 없거나 parse 실패 시 빈 DB. Gate pipeline 중단 금지.
    log.warn(`[DEV_WALLET] load failed (fail-open): ${String(err)}`);
    loadedFile = { version: 'v1', last_updated: '', devs: [] };
    addressIndex = new Map();
  }
}

async function reloadIfChanged(filePath: string): Promise<void> {
  try {
    const st = await stat(filePath);
    if (st.mtimeMs > lastLoadedMtimeMs) {
      log.debug(`[DEV_WALLET] mtime changed — reloading`);
      await loadFile(filePath);
    }
  } catch {
    // 파일 missing — 다음 polling 에서 재시도
  }
}

function rebuildAddressIndex(file: DevWalletDbFile): void {
  const idx = new Map<string, DevEntry>();
  for (const dev of file.devs) {
    if (dev.is_active === false) continue;  // inactive 제외 (lookup 효율)
    for (const addr of dev.addresses) {
      idx.set(addr, dev);
    }
  }
  addressIndex = idx;
}
