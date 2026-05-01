/**
 * Research Ledger writer (S2, 2026-05-01).
 *
 * ADR: docs/design-docs/research-ledger-unification-2026-05-01.md
 *
 * 책임:
 *   - `data/realtime/trade-outcomes.jsonl` append (TradeOutcomeV1 row)
 *   - `data/realtime/kol-call-funnel.jsonl` append (KolCallFunnelV1 row)
 *   - validator invalid row → `data/realtime/research-quarantine.jsonl` 격리 (ADR §12.A 확정)
 *   - eventId / recordId / emitNonce 산출 helper
 *   - **dual-write 는 S3 sprint** — 본 모듈은 writer + helper 만 제공.
 *
 * 정책:
 *   - **fail-open** — append 실패해도 throw 안 함. 운영 path 영향 0 (mission §3 wallet floor 우선).
 *   - **append-only** — 정상 ledger 와 quarantine 모두 한 번 쓴 row 는 수정 안 함.
 *   - **process-local nonce** — pid + counter. process 재시작 시 counter reset (collision rate ~0).
 */

import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { createModuleLogger } from '../utils/logger';

const log = createModuleLogger('ResearchLedger');
import { config } from '../utils/config';
import {
  TRADE_OUTCOME_SCHEMA_VERSION,
  KOL_CALL_FUNNEL_SCHEMA_VERSION,
} from './researchLedgerTypes';
import type {
  TradeOutcomeV1,
  KolCallFunnelV1,
  FunnelEventIdInput,
} from './researchLedgerTypes';
import {
  validateTradeOutcome,
  validateFunnelRecord,
  computeEventId,
  computeRecordId,
} from './researchLedgerValidator';

const TRADE_OUTCOMES_FILENAME = 'trade-outcomes.jsonl';
const KOL_CALL_FUNNEL_FILENAME = 'kol-call-funnel.jsonl';
const QUARANTINE_FILENAME = 'research-quarantine.jsonl';

/** Process-local emitNonce counter — pid + monotonic counter. */
let nonceCounter = 0;
const NONCE_PID_TAG = `pid${process.pid}`;

export function nextEmitNonce(): string {
  nonceCounter += 1;
  // 충돌 방지를 위한 randomness 추가 — concurrent same-process call 안전
  const rand = randomBytes(3).toString('hex');
  return `${NONCE_PID_TAG}_${nonceCounter}_${rand}`;
}

/**
 * Resolve ledger directory. config.realtimeDataDir 기준 + override 가능.
 */
function resolveLedgerDir(overrideDir?: string): string {
  return overrideDir ?? (config as { realtimeDataDir: string }).realtimeDataDir;
}

/** Ensure dir exists — fail-open (실패 시 log.error + 호출자에 false 반환). */
async function ensureDir(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    return true;
  } catch (err) {
    log.error(`[RESEARCH_LEDGER] mkdir failed dir=${dir}: ${String(err)}`);
    return false;
  }
}

/** Append single JSONL row — fail-open. */
async function appendJsonl(filePath: string, record: unknown): Promise<boolean> {
  try {
    const line = JSON.stringify(record) + '\n';
    await appendFile(filePath, line, 'utf8');
    return true;
  } catch (err) {
    log.error(`[RESEARCH_LEDGER] append failed file=${filePath}: ${String(err)}`);
    return false;
  }
}

/**
 * Quarantine writer (ADR §12.A 확정).
 * validator invalid row 를 격리 — 정상 ledger append 안 함, log.warn + 격리 ledger append.
 *
 * Codex F3 보정: append 결과 boolean 반환 → caller 가 `quarantineAppendFailed` 로 구분.
 */
async function appendQuarantine(
  ledgerDir: string,
  schemaTarget: 'trade-outcome/v1' | 'kol-call-funnel/v1',
  rawRow: unknown,
  errors: string[],
  warnings: string[],
): Promise<boolean> {
  const record = {
    quarantinedAtIso: new Date().toISOString(),
    schemaTarget,
    errors,
    warnings,
    // best-effort raw — JSON.stringify 가능한 부분만. circular ref 시 fallback.
    rawRow: safeSerialize(rawRow),
  };
  const ok = await appendJsonl(path.join(ledgerDir, QUARANTINE_FILENAME), record);
  if (!ok) {
    // append 실패 자체가 silent loss — log.error 는 appendJsonl 에서 이미 발사
    log.error(`[RESEARCH_LEDGER] quarantine ledger 손실 발생 (target=${schemaTarget})`);
  }
  return ok;
}

/** circular ref 안전 직렬화 — 실패 시 'SERIALIZATION_FAILED' string 반환. */
function safeSerialize(row: unknown): unknown {
  try {
    JSON.stringify(row);
    return row;
  } catch {
    return { _serializationError: 'SERIALIZATION_FAILED', rowKind: typeof row };
  }
}

// ─── Public API ─────────────────────────────────────────────

export interface AppendResult {
  /** 정상 ledger 에 append 됐는지 */
  appended: boolean;
  /** quarantine 에 격리 시도됐는지 (invalid row 일 때만 true) */
  quarantined: boolean;
  /**
   * Codex F3 보정: quarantine 격리 시도가 실제로 disk write 실패한 경우 true.
   * - quarantined=true && quarantineAppendFailed=true  → invalid row 인식 + 격리 실패 (silent loss).
   *                                                       audit script 가 별도 detect 필요.
   * - quarantined=true && quarantineAppendFailed=false → 정상 격리 (정상 path).
   * - quarantined=false                                → invalid 아님 (정상 ledger append).
   */
  quarantineAppendFailed?: boolean;
  /** validator errors (격리 사유) */
  errors: string[];
  /** validator warnings (정상 append 시에도 있을 수 있음) */
  warnings: string[];
}

/**
 * trade-outcome/v1 row append.
 *
 * 정책:
 *   - validator pass → trade-outcomes.jsonl append, quarantine 안 함.
 *   - validator invalid → quarantine 만 append, 정상 ledger append 안 함.
 *   - 어느 경우든 throw 안 함 (fail-open).
 */
export async function appendTradeOutcome(
  row: TradeOutcomeV1,
  options: { ledgerDir?: string } = {},
): Promise<AppendResult> {
  const dir = resolveLedgerDir(options.ledgerDir);
  const dirOk = await ensureDir(dir);
  if (!dirOk) {
    return { appended: false, quarantined: false, errors: ['ledger_dir_unavailable'], warnings: [] };
  }

  const validation = validateTradeOutcome(row);
  if (!validation.valid) {
    const qok = await appendQuarantine(dir, TRADE_OUTCOME_SCHEMA_VERSION, row, validation.errors, validation.warnings);
    log.warn(
      `[RESEARCH_LEDGER] trade-outcome quarantined positionId=${row.positionId} ` +
      `errors=${validation.errors.length} qWriteOk=${qok}: ${validation.errors.slice(0, 2).join(' | ')}`
    );
    return {
      appended: false,
      quarantined: true,
      quarantineAppendFailed: !qok,
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }

  const appended = await appendJsonl(path.join(dir, TRADE_OUTCOMES_FILENAME), row);
  if (validation.warnings.length > 0) {
    log.debug(
      `[RESEARCH_LEDGER] trade-outcome warnings positionId=${row.positionId} ` +
      `count=${validation.warnings.length}: ${validation.warnings.slice(0, 2).join(' | ')}`
    );
  }
  return { appended, quarantined: false, errors: [], warnings: validation.warnings };
}

/**
 * kol-call-funnel/v1 row append.
 *
 * 정책 동일 — invalid → quarantine, valid → 정상 ledger.
 */
export async function appendFunnelEvent(
  row: KolCallFunnelV1,
  options: { ledgerDir?: string } = {},
): Promise<AppendResult> {
  const dir = resolveLedgerDir(options.ledgerDir);
  const dirOk = await ensureDir(dir);
  if (!dirOk) {
    return { appended: false, quarantined: false, errors: ['ledger_dir_unavailable'], warnings: [] };
  }

  const validation = validateFunnelRecord(row);
  if (!validation.valid) {
    const qok = await appendQuarantine(dir, KOL_CALL_FUNNEL_SCHEMA_VERSION, row, validation.errors, validation.warnings);
    log.warn(
      `[RESEARCH_LEDGER] funnel quarantined eventType=${row.eventType} mint=${String(row.tokenMint).slice(0, 8)} ` +
      `errors=${validation.errors.length} qWriteOk=${qok}: ${validation.errors.slice(0, 2).join(' | ')}`
    );
    return {
      appended: false,
      quarantined: true,
      quarantineAppendFailed: !qok,
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }

  const appended = await appendJsonl(path.join(dir, KOL_CALL_FUNNEL_FILENAME), row);
  return { appended, quarantined: false, errors: [], warnings: validation.warnings };
}

/**
 * Funnel event 빌드 helper — dual-write wiring (S3) 시 emit site 가 사용.
 *
 * 사용 예:
 *   const evt = buildFunnelEvent({
 *     eventType: 'survival_reject', tokenMint, txSignature, rejectCategory: 'NO_SECURITY_DATA',
 *     extras: { ... },
 *   });
 *   await appendFunnelEvent(evt);
 */
export function buildFunnelEvent(input: {
  eventType: FunnelEventIdInput['eventType'];
  tokenMint: string;
  emitTsMs?: number;
  txSignature?: string;
  positionId?: string;
  parentPositionId?: string;
  kolId?: string;
  kolTier?: 'S' | 'A' | 'B';
  walletAddress?: string;
  action?: 'buy' | 'sell';
  solAmount?: number;
  isShadowKol?: boolean;
  armName?: string;
  parameterVersion?: string;
  rejectCategory?: string;
  rejectReason?: string;
  signalSource?: string;
  sessionId?: string;
  extras?: Record<string, unknown>;
}): KolCallFunnelV1 {
  const emitTsMs = input.emitTsMs ?? Date.now();
  const eventId = computeEventId({
    eventType: input.eventType,
    tokenMint: input.tokenMint,
    emitTsMs,
    txSignature: input.txSignature,
    positionId: input.positionId,
    rejectCategory: input.rejectCategory,
  });
  const emitNonce = nextEmitNonce();
  const recordId = computeRecordId(eventId, emitNonce);
  return {
    schemaVersion: KOL_CALL_FUNNEL_SCHEMA_VERSION,
    recordId,
    eventId,
    emitNonce,
    emitTsMs,
    sessionId: input.sessionId,
    eventType: input.eventType,
    tokenMint: input.tokenMint,
    positionId: input.positionId,
    txSignature: input.txSignature,
    parentPositionId: input.parentPositionId,
    kolId: input.kolId,
    kolTier: input.kolTier,
    walletAddress: input.walletAddress,
    action: input.action,
    solAmount: input.solAmount,
    isShadowKol: input.isShadowKol,
    armName: input.armName,
    parameterVersion: input.parameterVersion,
    rejectCategory: input.rejectCategory,
    rejectReason: input.rejectReason,
    signalSource: input.signalSource,
    extras: input.extras,
  };
}

/**
 * trade-outcome recordId 산출 — 변경 시 v2 ADR 필요.
 *   = sha1(positionId | exitAtIso | emitNonce)
 */
export function buildTradeOutcomeRecordId(
  positionId: string,
  exitAtIso: string,
  emitNonce: string,
): string {
  return computeRecordId(`${positionId}|${exitAtIso}`, emitNonce);
}

/**
 * Test 전용 — nonce counter reset (jest 격리).
 */
export function __resetNonceCounterForTest(): void {
  nonceCounter = 0;
}
