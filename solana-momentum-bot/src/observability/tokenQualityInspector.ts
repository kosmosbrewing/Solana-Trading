/**
 * Token Quality Inspector (2026-05-01, Decu Quality Layer Phase B).
 *
 * ADR: docs/design-docs/decu-new-pair-quality-layer-2026-05-01.md
 *
 * Why: KOL Hunter entry 직후 token detail (holder distribution / vamp / metadata /
 *      global fee proxy / dev wallet status) 을 observe-only 로 기록.
 *      paper reject / live hard gate 가 아니라 **사후 cohort 분석용 telemetry**.
 *      Phase D / E 에서 검증된 flag 만 paper reject 로 승격.
 *
 * 설계 원칙:
 *  - Fire-and-forget: caller 는 await 안 함, entry critical path 영향 0
 *  - Read-only: trade 결정에 절대 간섭 안 함
 *  - Cache + dedup: 동일 mint 의 1h 안 재호출 차단 (RPC 부담 < 100/min cap)
 *  - 실패 silent: observer 가 Gate / Trade pipeline 중단 금지
 *  - schema v1: 향후 필드 추가 시 schemaVersion bump
 */
import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('TokenQualityInspector');

// ─── Types ──────────────────────────────────────────────

export type DevStatus = 'allowlist' | 'watchlist' | 'blacklist' | 'unknown';

/**
 * Token Quality observation record (schema v1).
 * ADR §4.1 정합. 향후 필드 추가 시 schemaVersion 'token-quality/v2' 로 bump.
 */
export interface TokenQualityRecord {
  schemaVersion: 'token-quality/v1';
  tokenMint: string;
  pairAddress?: string;
  dexId?: string;
  observedAt: string; // ISO

  // Metadata
  name?: string;
  symbol?: string;
  imageUri?: string;
  metadataUri?: string;

  // Holder distribution (B.2)
  top1HolderPct?: number;
  top5HolderPct?: number;
  top10HolderPct?: number;
  holderHhi?: number;
  holderCountApprox?: number;

  // Dev / creator (B.5)
  creatorAddress?: string;
  devWallet?: string;
  firstLpProvider?: string;
  operatorDevStatus?: DevStatus;

  // Vamp / fee (B.3 / B.4)
  vampSimilarityScore?: number;
  suspectedBundleScore?: number;
  estimatedGlobalFees5mSol?: number;
  feeToLiquidity?: number;
  feeToMcap?: number;
  feeVelocity?: number;
  volumeToLiq?: number;

  // 통합 risk flag list — analyzer 가 cohort 분리 시 입력
  riskFlags: string[];

  // 측정 context (cohort join 용)
  observationContext?: {
    armName?: string;
    parameterVersion?: string;
    isLive?: boolean;
    isShadowArm?: boolean;
    positionId?: string;
    entryPrice?: number;
    ticketSol?: number;
  };
}

export interface TokenQualityInspectorConfig {
  /** observer 자체 활성화. default true (observe-only 라 안전) */
  enabled: boolean;
  /** dedup 윈도우 (h). 기본 24h. 동일 mint 재기록 방지. */
  observationTtlHours: number;
  /** 출력 jsonl 절대 경로. */
  outputFile: string;
}

const DEFAULT_CONFIG: TokenQualityInspectorConfig = {
  enabled: true,
  observationTtlHours: 24,
  outputFile: '',
};

// ─── Module state ───────────────────────────────────────

// 2026-05-01 (codex F1 fix): dedup key 를 positionId (또는 tokenMint+armName+isLive+isShadow)
//   로 변경. 이전 tokenMint 단독 key 는 paper/live/shadow cohort 분리 깨뜨림 — 같은 mint 의
//   v1 / swing shadow / live 가 24h 안 발생 시 첫 record 만 남고 나머지 cohort 손실.
const recentByDedupKey = new Map<string, number>(); // dedupKey → epochMs
let outputDirEnsured = false;

/** dedup key 빌드 — positionId 우선, 없으면 mint + arm + live + shadow flag 조합. */
export function buildDedupKey(input: {
  tokenMint: string;
  positionId?: string;
  armName?: string;
  isLive?: boolean;
  isShadowArm?: boolean;
}): string {
  if (input.positionId) return `pos:${input.positionId}`;
  return `mint:${input.tokenMint}|arm:${input.armName ?? 'unk'}|live:${input.isLive ? '1' : '0'}|shadow:${input.isShadowArm ? '1' : '0'}`;
}

/**
 * 동기 lookup — caller path 에서 dedup 사전 검사 (RPC / IPFS 호출 회피).
 * 24h 안 재기록 차단. cache hit 시 true.
 *
 * 2026-05-01 (F9): TTL 초과 entry eviction — size > 1000 시 sweep.
 * 2026-05-01 (codex F1): dedup key 변경 — positionId / cohort 기반.
 */
export function isObservationDeduped(
  dedupKey: string,
  ttlHours: number = DEFAULT_CONFIG.observationTtlHours,
  nowMs = Date.now(),
): boolean {
  // 가벼운 lazy eviction — size > 1000 시점에만 sweep
  if (recentByDedupKey.size > 1000) {
    const ttlMs = ttlHours * 3600 * 1000;
    for (const [k, ts] of recentByDedupKey) {
      if (nowMs - ts >= ttlMs) recentByDedupKey.delete(k);
    }
  }
  const last = recentByDedupKey.get(dedupKey);
  if (last == null) return false;
  return nowMs - last < ttlHours * 3600 * 1000;
}

/**
 * Token quality observation record 를 jsonl 로 append.
 * fire-and-forget — caller 는 await 안 해도 됨. 실패 silent.
 *
 * @returns 실제 기록 여부 (false = dedup hit / disabled / write fail)
 */
export async function appendTokenQualityObservation(
  record: TokenQualityRecord,
  config: Partial<TokenQualityInspectorConfig> = {},
): Promise<boolean> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) return false;
  if (!cfg.outputFile) {
    log.debug(`[TOKEN_QUALITY] outputFile not configured — skip ${record.tokenMint.slice(0, 12)}`);
    return false;
  }
  // 2026-05-01 (codex F1): dedup key — positionId 우선, 없으면 mint + cohort 조합.
  //   같은 mint 의 paper / live / shadow 가 24h 안 발생해도 cohort 별 record 보존.
  const dedupKey = buildDedupKey({
    tokenMint: record.tokenMint,
    positionId: record.observationContext?.positionId,
    armName: record.observationContext?.armName,
    isLive: record.observationContext?.isLive,
    isShadowArm: record.observationContext?.isShadowArm,
  });
  if (isObservationDeduped(dedupKey, cfg.observationTtlHours)) {
    return false;
  }
  try {
    if (!outputDirEnsured) {
      await mkdir(path.dirname(cfg.outputFile), { recursive: true });
      outputDirEnsured = true;
    }
    await appendFile(cfg.outputFile, JSON.stringify(record) + '\n', 'utf8');
    recentByDedupKey.set(dedupKey, Date.now());
    return true;
  } catch (err) {
    // observer 가 Gate / Trade pipeline 중단 금지 — silent
    log.debug(`[TOKEN_QUALITY] append failed for ${record.tokenMint.slice(0, 12)}: ${String(err)}`);
    return false;
  }
}

/** 테스트/재기동 시 reset. */
export function resetTokenQualityInspectorState(): void {
  recentByDedupKey.clear();
  outputDirEnsured = false;
}

/** 테스트 — dedup map 직접 inject. */
export function __testInjectObservation(dedupKey: string, observedAtMs: number = Date.now()): void {
  recentByDedupKey.set(dedupKey, observedAtMs);
}

/** 운영 통계 — observer 활동 stats. */
export function getTokenQualityInspectorStats(): { dedupCacheSize: number } {
  return {
    dedupCacheSize: recentByDedupKey.size,
  };
}
