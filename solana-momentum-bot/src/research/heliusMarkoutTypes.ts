/**
 * Helius Markout Backfill types + writer (2026-05-01, Stream E).
 *
 * ADR: docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md §6 Stream E
 * Research Ledger ADR §13 footnote: 본 ledger 는 별도 sidecar namespace `helius-markout/v1`,
 *                                    `trade-outcome/v1` / `kol-call-funnel/v1` 와 무관.
 *
 * 목적: KOL Hunter 의 close / reject / entry 시점 anchor 에서 N horizon 후 가격 trajectory 측정 →
 *       "5x reached before exit" / "5x reached after exit" / "5x reached after reject" 산출.
 *
 * 정책:
 *   - default source = `historical_rpc` (raw_swaps 는 optional)
 *   - coverage < 70% 인 row 는 incomplete 표시 (cohort policy 에 사용 금지)
 *   - sidecar fail-open writer (research-quarantine 패턴 동일 — append 실패 시 throw 0)
 */

import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('HeliusMarkout');

export const HELIUS_MARKOUT_SCHEMA_VERSION = 'helius-markout/v1' as const;

/** Plan §6 Stream E 의 horizon — 60s/300s/1800s default. */
export const DEFAULT_HORIZONS_SEC = [60, 300, 1800] as const;

/** coverage 가 70% 미만이면 incomplete — Plan §6 Stream E acceptance. */
export const COVERAGE_INCOMPLETE_THRESHOLD = 0.70 as const;

/** Plan §6 Stream E: Source 우선순위 — 'historical_rpc' default, 'raw_swaps' optional. */
export type HeliusMarkoutSource = 'raw_swaps' | 'historical_rpc' | 'mixed';

/** subject 분류 — entry / close / reject. */
export type HeliusMarkoutSubjectType = 'entry' | 'close' | 'reject';

/**
 * 단일 anchor 의 markout record. ADR §6 Stream E 의 schema 정합.
 */
export interface HeliusMarkoutRecord {
  schemaVersion: typeof HELIUS_MARKOUT_SCHEMA_VERSION;
  /** 'entry' | 'close' | 'reject' */
  subjectType: HeliusMarkoutSubjectType;
  /** anchor 의 unique id (positionId / rejectId) */
  subjectId: string;
  tokenMint: string;
  /** anchor timestamp (epoch ms) */
  anchorTsMs: number;
  /** 측정 horizon list (seconds). caller 가 [60, 300, 1800] 등 명시 */
  horizonsSec: number[];
  /** 데이터 source */
  source: HeliusMarkoutSource;
  /**
   * coverage % (0-1) — horizons 중 데이터 누락 없이 측정된 비율.
   *  0.5 = 절반 horizon 만 측정 (incomplete).
   *  Plan §6 Stream E acceptance: < 0.70 면 cohort policy 에 사용 금지.
   */
  coveragePct: number;
  /** 산출 중 parse 실패 raw tx 수 (Helius enhanced parse 실패 등) */
  parseFailedCount: number;

  /** 측정된 trajectory MFE (peak / anchor - 1). null = 측정 불가 */
  trueMfePct?: number;
  /** 측정된 trajectory MAE (trough / anchor - 1) */
  trueMaePct?: number;
  /** peak 도달 시각 (anchor 후 sec). null = unknown */
  peakAtSec?: number;
  troughAtSec?: number;

  /**
   * 5x 도달 여부 — exit 시점 BEFORE / AFTER 분리 (close subject 만 채움).
   *   - reached5xBeforeExit: anchor=close 일 때 entry-after-exit 사이 5x 발생 (false-negative 5x)
   *   - reached5xAfterExit: anchor=close 일 때 close 후 5x 발생 (winner truncation)
   *   reject anchor 면 둘 다 reached5xAfterReject 의미로 reached5xAfterExit 사용 가능.
   */
  reached5xBeforeExit?: boolean;
  reached5xAfterExit?: boolean;

  /** 측정에 소비된 estimated credits (researchLedger 의 source-of-truth 와 join 가능) */
  estimatedCredits: number;
}

export interface AppendMarkoutResult {
  appended: boolean;
  error?: string;
}

const LEDGER_DIR_DEFAULT = 'data/research';
const LEDGER_FILENAME = 'helius-markouts.jsonl';

function resolveLedgerDir(overrideDir?: string): string {
  return overrideDir ?? path.resolve(process.cwd(), LEDGER_DIR_DEFAULT);
}

async function ensureDir(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    return true;
  } catch (err) {
    log.error(`[HELIUS_MARKOUT] mkdir failed dir=${dir}: ${String(err)}`);
    return false;
  }
}

/**
 * Sidecar fail-open writer.
 * Plan §10 의 "All new sidecar JSONL writers must: be append-only; never throw" 정합.
 */
export async function appendHeliusMarkout(
  record: HeliusMarkoutRecord,
  options: { ledgerDir?: string } = {},
): Promise<AppendMarkoutResult> {
  const dir = resolveLedgerDir(options.ledgerDir);
  const dirOk = await ensureDir(dir);
  if (!dirOk) {
    return { appended: false, error: 'ledger_dir_unavailable' };
  }
  try {
    const line = JSON.stringify(record) + '\n';
    await appendFile(path.join(dir, LEDGER_FILENAME), line, 'utf8');
    return { appended: true };
  } catch (err) {
    const msg = String(err);
    log.error(`[HELIUS_MARKOUT] append failed: ${msg}`);
    return { appended: false, error: msg };
  }
}

/**
 * Coverage policy — incomplete 분류.
 * Plan §6 Stream E acceptance: "coverage < 70% as incomplete; not use as policy evidence"
 */
export function isMarkoutComplete(record: HeliusMarkoutRecord): boolean {
  return record.coveragePct >= COVERAGE_INCOMPLETE_THRESHOLD;
}

/**
 * 5x classification — mfePct >= 4.0 (5x = +400%) 정의.
 * mission §3 정합: 사명의 5x bucket 측정.
 */
export function reached5x(mfePct: number | undefined | null): boolean {
  return typeof mfePct === 'number' && Number.isFinite(mfePct) && mfePct >= 4.0;
}

/**
 * Markout 산출 helper — anchor + horizon points → MFE/MAE/peak/trough/5x.
 * pure function (I/O 없음).
 *
 * @param anchorPrice anchor 시점 reference price
 * @param trajectory horizon 별 (relativeSec, price) 점들. 누락 가능 (coverage 측정용)
 * @param expectedHorizonsCount horizon list 의 총 갯수 (coverage 분모)
 */
export function computeMarkoutMetrics(
  anchorPrice: number,
  trajectory: Array<{ relativeSec: number; price: number }>,
  expectedHorizonsCount: number,
): {
  trueMfePct?: number;
  trueMaePct?: number;
  peakAtSec?: number;
  troughAtSec?: number;
  coveragePct: number;
} {
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) {
    return { coveragePct: 0 };
  }
  if (trajectory.length === 0) {
    return { coveragePct: 0 };
  }
  const validPoints = trajectory.filter(
    (p) => Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.relativeSec),
  );
  if (validPoints.length === 0) {
    return { coveragePct: 0 };
  }

  let peakPrice = validPoints[0].price;
  let peakAtSec = validPoints[0].relativeSec;
  let troughPrice = validPoints[0].price;
  let troughAtSec = validPoints[0].relativeSec;
  for (const p of validPoints) {
    if (p.price > peakPrice) {
      peakPrice = p.price;
      peakAtSec = p.relativeSec;
    }
    if (p.price < troughPrice) {
      troughPrice = p.price;
      troughAtSec = p.relativeSec;
    }
  }
  const trueMfePct = (peakPrice - anchorPrice) / anchorPrice;
  const trueMaePct = (troughPrice - anchorPrice) / anchorPrice;
  const coveragePct = expectedHorizonsCount > 0
    ? Math.min(1, validPoints.length / expectedHorizonsCount)
    : 1;

  return {
    trueMfePct,
    trueMaePct,
    peakAtSec,
    troughAtSec,
    coveragePct,
  };
}
