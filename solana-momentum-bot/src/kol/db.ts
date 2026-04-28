/**
 * KOL DB Loader (Option 5, 2026-04-23)
 *
 * - JSON 파일 로드 (js-yaml 의존 회피)
 * - address → kol_id 역인덱스 (O(1) lookup)
 * - Hot reload 지원 (파일 mtime watch, 재시작 없이 업데이트)
 * - 수동 편집 only — 자동 추가 API 미제공 (ADR §5.4)
 *
 * REFACTORING_v1.0.md §5: Phase 0 YAML schema 확정 후 운영자 수동 입력.
 */
import { readFile, stat } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import type { KolWallet, KolDbFile, KolTier } from './types';

const log = createModuleLogger('KolDb');

export interface KolDbConfig {
  /** 파일 경로 (default: data/kol/wallets.json) */
  path: string;
  /** hot reload polling 주기. 0 = 비활성 */
  hotReloadIntervalMs: number;
}

export const DEFAULT_KOL_DB_CONFIG: KolDbConfig = {
  path: path.resolve(process.cwd(), 'data/kol/wallets.json'),
  hotReloadIntervalMs: 60_000,
};

// ─── Module state ────────────────────────────────────────

let loadedFile: KolDbFile | null = null;
let addressIndex = new Map<string, KolWallet>(); // address → wallet
let idIndex = new Map<string, KolWallet>(); // id → wallet
let lastLoadedMtimeMs = 0;
let watchTimer: NodeJS.Timeout | null = null;

// ─── Public API ──────────────────────────────────────────

/**
 * 최초 로드 + (옵션) hot reload 시작.
 * 파일 없거나 parse 실패 시 fail-open (빈 DB 로 초기화) — Gate pipeline 중단 금지.
 */
export async function initKolDb(config: Partial<KolDbConfig> = {}): Promise<void> {
  const cfg = { ...DEFAULT_KOL_DB_CONFIG, ...config };
  await loadFile(cfg.path);
  if (cfg.hotReloadIntervalMs > 0 && !watchTimer) {
    watchTimer = setInterval(() => {
      reloadIfChanged(cfg.path).catch((err) => {
        log.debug(`[KOL_DB] hot reload error: ${String(err)}`);
      });
    }, cfg.hotReloadIntervalMs);
    if (watchTimer.unref) watchTimer.unref();
  }
}

export function stopKolDbWatcher(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

/** 테스트/재기동 시 reset. */
export function resetKolDbState(): void {
  stopKolDbWatcher();
  loadedFile = null;
  addressIndex = new Map();
  idIndex = new Map();
  lastLoadedMtimeMs = 0;
}

/** address 로 KOL wallet lookup. 대소문자 보존 — Solana address 는 case-sensitive. */
export function lookupKolByAddress(address: string): KolWallet | undefined {
  if (!address) return undefined;
  const wallet = addressIndex.get(address);
  if (!wallet || !wallet.is_active) return undefined;
  return wallet;
}

/** id 로 KOL wallet lookup. */
export function lookupKolById(id: string): KolWallet | undefined {
  if (!id) return undefined;
  const wallet = idIndex.get(id);
  if (!wallet || !wallet.is_active) return undefined;
  return wallet;
}

/**
 * 2026-04-28 (Phase 0B/1): KOL 의 lane_role 조회. 미분류 시 'unknown' fallback.
 * Phase 1 (style-aware insider_exit) 의 입력. 미분류 KOL 은 보수적 분기 (현재 default behavior 유지).
 *
 * Decision input:
 *   - copy_core: sell 신호 → 우리도 close (직접 카피)
 *   - discovery_canary: sell 신호 → confidence 하향만 (close 안 함)
 *   - observer: trigger 자체 안 줌
 *   - unknown: 보수적 — 직접 카피 default (기존 behavior)
 */
export function getKolLaneRole(kolId: string): 'copy_core' | 'discovery_canary' | 'observer' | 'unknown' {
  const wallet = idIndex.get(kolId);
  return wallet?.lane_role ?? 'unknown';
}

/**
 * 2026-04-28 (Phase 0B/1): KOL trading style 조회. 미분류 시 'unknown'.
 * lane_role 의 보조 dimension. scalper sell 무시 정책의 입력.
 */
export function getKolTradingStyle(kolId: string): 'longhold' | 'swing' | 'scalper' | 'unknown' {
  const wallet = idIndex.get(kolId);
  return wallet?.trading_style ?? 'unknown';
}

/** 활성 KOL 의 모든 address set. tracker subscription 용. */
export function getAllActiveAddresses(): string[] {
  const result: string[] = [];
  for (const wallet of idIndex.values()) {
    if (!wallet.is_active) continue;
    for (const addr of wallet.addresses) {
      if (addr) result.push(addr);
    }
  }
  return result;
}

/**
 * 비활성 KOL 의 모든 address set. Shadow track (Option A, 2026-04-27) 전용.
 * Why: inactive 활동량을 paper position 영향 0 으로 관측 → promotion candidate 식별.
 * Active 와 분리 반환해야 호출 측에서 shadow vs live routing 결정 가능.
 */
export function getAllInactiveAddresses(): string[] {
  const result: string[] = [];
  for (const wallet of idIndex.values()) {
    if (wallet.is_active) continue;
    for (const addr of wallet.addresses) {
      if (addr) result.push(addr);
    }
  }
  return result;
}

/**
 * Active 여부 무관 lookup. Shadow track 에서 inactive wallet metadata (id/tier) 조회용.
 * 일반 hot path 는 `lookupKolByAddress` 사용 (inactive 자동 필터). 본 함수는 shadow 전용.
 */
export function lookupAnyKolByAddress(address: string): KolWallet | undefined {
  if (!address) return undefined;
  return addressIndex.get(address);
}

/** 활성 KOL id 집합 (tier 필터링 가능). */
export function getActiveKols(tierFilter?: KolTier[]): KolWallet[] {
  const result: KolWallet[] = [];
  for (const wallet of idIndex.values()) {
    if (!wallet.is_active) continue;
    if (tierFilter && !tierFilter.includes(wallet.tier)) continue;
    result.push(wallet);
  }
  return result;
}

export function getKolDbStats(): {
  totalKols: number;
  activeKols: number;
  totalAddresses: number;
  activeAddresses: number;
  byTier: Record<KolTier, number>;
} {
  const byTier: Record<KolTier, number> = { S: 0, A: 0, B: 0 };
  let active = 0;
  let totalAddr = 0;
  let activeAddr = 0;
  for (const wallet of idIndex.values()) {
    totalAddr += wallet.addresses.length;
    if (wallet.is_active) {
      active += 1;
      byTier[wallet.tier] = (byTier[wallet.tier] ?? 0) + 1;
      activeAddr += wallet.addresses.length;
    }
  }
  return {
    totalKols: idIndex.size,
    activeKols: active,
    totalAddresses: totalAddr,
    activeAddresses: activeAddr,
    byTier,
  };
}

// ─── Internal ────────────────────────────────────────────

async function loadFile(filePath: string): Promise<void> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as KolDbFile;
    if (!parsed || !Array.isArray(parsed.kols)) {
      log.warn(`[KOL_DB] malformed file, fail-open with empty DB: ${filePath}`);
      return;
    }
    const newIdIdx = new Map<string, KolWallet>();
    const newAddrIdx = new Map<string, KolWallet>();
    for (const wallet of parsed.kols) {
      if (!wallet.id || !Array.isArray(wallet.addresses)) continue;
      if (!isValidTier(wallet.tier)) continue;
      newIdIdx.set(wallet.id, wallet);
      for (const addr of wallet.addresses) {
        if (!addr || typeof addr !== 'string') continue;
        newAddrIdx.set(addr, wallet);
      }
    }
    loadedFile = parsed;
    idIndex = newIdIdx;
    addressIndex = newAddrIdx;
    const st = await stat(filePath).catch(() => null);
    lastLoadedMtimeMs = st ? st.mtimeMs : Date.now();
    const stats = getKolDbStats();
    log.info(
      `[KOL_DB] loaded — active=${stats.activeKols}/${stats.totalKols} ` +
      `addresses=${stats.activeAddresses}/${stats.totalAddresses} ` +
      `S=${stats.byTier.S} A=${stats.byTier.A} B=${stats.byTier.B}`
    );
  } catch (err) {
    log.warn(`[KOL_DB] load failed (fail-open with empty DB): ${String(err)}`);
  }
}

async function reloadIfChanged(filePath: string): Promise<void> {
  try {
    const st = await stat(filePath);
    if (st.mtimeMs > lastLoadedMtimeMs) {
      log.info(`[KOL_DB] file changed — reloading...`);
      await loadFile(filePath);
    }
  } catch {
    // 파일 일시 없음은 무시 (운영자가 edit 중일 수 있음)
  }
}

function isValidTier(tier: unknown): tier is KolTier {
  return tier === 'S' || tier === 'A' || tier === 'B';
}

/** 테스트 전용 — 파일 경로 우회하고 메모리에 직접 inject. */
export function __testInject(kols: KolWallet[]): void {
  const newIdIdx = new Map<string, KolWallet>();
  const newAddrIdx = new Map<string, KolWallet>();
  for (const wallet of kols) {
    newIdIdx.set(wallet.id, wallet);
    for (const addr of wallet.addresses) {
      newAddrIdx.set(addr, wallet);
    }
  }
  idIndex = newIdIdx;
  addressIndex = newAddrIdx;
  loadedFile = { version: 1, last_updated: 'test', kols };
}

/** 현재 loaded 파일 snapshot (debug). */
export function getLoadedFileSnapshot(): KolDbFile | null {
  return loadedFile;
}
