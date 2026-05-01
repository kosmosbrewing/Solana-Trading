/**
 * Research Ledger schema v1 — lightweight runtime validator (S1).
 *
 * Why: typescript types 만으로는 paper/live mode-conditional 필수 필드 / pnlTruthSource 일관성 /
 *      eventType-conditional positionId 보장이 안 됨. runtime 단계에서 schema 무결성 검사.
 *
 * 정책: **fail-open** — validator 가 invalid 라고 판정해도 throw 안 함. 결과 object 만 반환.
 *      writer (S2) 가 결과 보고 log warn 후 row 자체는 계속 append (분석에서 cleansing 가능하게).
 *
 * No external deps. No I/O. Pure function.
 */

import { createHash } from 'crypto';
import type {
  TradeOutcomeV1,
  KolCallFunnelV1,
  FunnelEventIdInput,
  FunnelEventType,
} from './researchLedgerTypes';
import {
  TRADE_OUTCOME_SCHEMA_VERSION,
  KOL_CALL_FUNNEL_SCHEMA_VERSION,
} from './researchLedgerTypes';

export interface ValidationResult {
  valid: boolean;
  /** 누락된 필수 필드 / 일관성 위반 사유 — 모두 collect (early return 안 함) */
  errors: string[];
  /** 비치명적 — schema 통과 하지만 권장 미준수 */
  warnings: string[];
}

const POSITION_ID_REQUIRED_EVENTS: ReadonlySet<FunnelEventType> = new Set([
  'entry_open',
  'position_close',
]);

const REJECT_CATEGORY_REQUIRED_EVENTS: ReadonlySet<FunnelEventType> = new Set([
  'survival_reject',
  'entry_reject',
]);

/**
 * Codex F1 보정 — eventType enum 강제. unknown event 가 main ledger 에 append 되면
 * report cohort 가 깨짐 → hard error.
 */
const VALID_EVENT_TYPES: ReadonlySet<FunnelEventType> = new Set<FunnelEventType>([
  'kol_call',
  'pending_open',
  'survival_reject',
  'observe_open',
  'smart_v3_no_trigger',
  'kol_sell_cancel',
  'trigger_fire',
  'entry_open',
  'entry_reject',
  'position_close',
]);

/** Codex F1 보정 — action enum ('buy' | 'sell') 강제. */
const VALID_ACTIONS: ReadonlySet<string> = new Set(['buy', 'sell']);

/**
 * Numeric finite check — NaN / Infinity 차단.
 * Codex M4 보정: required 체크가 undefined/null 만 봐서 NaN/Infinity 통과 위험.
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 비빈 문자열 검증. */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

const VALID_TIER_TAGS = new Set(['S', 'A', 'B']);

/**
 * trade-outcome/v1 row validator.
 * §3.3 — required field + mode-conditional 필수 + pnlTruthSource 일관성 + numeric 검증.
 */
export function validateTradeOutcome(row: Partial<TradeOutcomeV1>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // schemaVersion 동결
  if (row.schemaVersion !== TRADE_OUTCOME_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${TRADE_OUTCOME_SCHEMA_VERSION}', got '${String(row.schemaVersion)}'`);
  }

  // ─── 필수 (모든 row) ───
  const requiredAlways: Array<keyof TradeOutcomeV1> = [
    'recordId', 'positionId', 'tokenMint', 'mode',
    'armName', 'parameterVersion',
    'isShadowArm', 'isTailPosition',
    'ticketSol', 'effectiveTicketSol',
    'entryPrice', 'exitPrice',
    'netSol', 'netPct', 'pnlTruthSource',
    'mfePctPeak', 'maePct', 'holdSec', 'exitReason',
    't1Visited', 't2Visited', 't3Visited', 'actual5xPeak',
    'survivalFlags',
    'entryAtIso', 'exitAtIso', 'entryTimeSec', 'exitTimeSec',
  ];
  for (const k of requiredAlways) {
    if (row[k] === undefined || row[k] === null) {
      errors.push(`missing required field: ${String(k)}`);
    }
  }

  // ─── Codex M4 보정 — string 필드 빈 문자열 차단 (필수 string) ───
  const nonEmptyStringFields: Array<keyof TradeOutcomeV1> = [
    'recordId', 'positionId', 'tokenMint',
    'armName', 'parameterVersion', 'exitReason',
    'entryAtIso', 'exitAtIso',
  ];
  for (const k of nonEmptyStringFields) {
    const v = row[k];
    if (v !== undefined && v !== null && !isNonEmptyString(v)) {
      errors.push(`${String(k)} must be non-empty string`);
    }
  }

  // ─── Codex S2.5 P2-1 보정 — boolean 필드 타입 강제 ───
  // dual-write payload 가 untyped 일 수 있어 'false' / 0 / 'true' 같은 truthy/falsy 가 통과하면
  // downstream report 가 tail / T-level visit / 5x flag 분류 깨짐.
  const booleanFields: Array<keyof TradeOutcomeV1> = [
    'isShadowArm', 'isTailPosition',
    't1Visited', 't2Visited', 't3Visited',
    'actual5xPeak',
  ];
  for (const k of booleanFields) {
    const v = row[k];
    if (v !== undefined && v !== null && typeof v !== 'boolean') {
      errors.push(`${String(k)} must be boolean, got ${typeof v}`);
    }
  }

  // ─── Codex M4 — numeric finite + sign 검증 ───
  const finiteFields: Array<keyof TradeOutcomeV1> = [
    'ticketSol', 'effectiveTicketSol',
    'entryPrice', 'exitPrice',
    'netSol', 'netPct', 'mfePctPeak', 'maePct',
    'holdSec', 'entryTimeSec', 'exitTimeSec',
    'partialTakeRealizedSol', 'partialTakeLockedTicketSol',
  ];
  for (const k of finiteFields) {
    const v = row[k];
    if (v !== undefined && v !== null && !isFiniteNumber(v)) {
      errors.push(`${String(k)} must be finite number, got ${String(v)}`);
    }
  }
  // 음수 / 0 차단 (Codex F5 — actual close outcome 은 ticket > 0 보장)
  if (isFiniteNumber(row.ticketSol) && row.ticketSol <= 0) {
    errors.push(`ticketSol must be > 0, got ${row.ticketSol}`);
  }
  if (isFiniteNumber(row.effectiveTicketSol) && row.effectiveTicketSol <= 0) {
    errors.push(`effectiveTicketSol must be > 0, got ${row.effectiveTicketSol}`);
  }
  if (isFiniteNumber(row.holdSec) && row.holdSec < 0) {
    errors.push(`holdSec must be >= 0, got ${row.holdSec}`);
  }
  // entryPrice / exitPrice > 0 (0 이하는 invalid pricing)
  if (isFiniteNumber(row.entryPrice) && row.entryPrice <= 0) {
    errors.push(`entryPrice must be > 0, got ${row.entryPrice}`);
  }
  if (isFiniteNumber(row.exitPrice) && row.exitPrice <= 0) {
    errors.push(`exitPrice must be > 0, got ${row.exitPrice}`);
  }

  // participatingKols / kols 필수 + 정합 (Codex M4 — tier enum + timestamp 검증)
  if (!Array.isArray(row.participatingKols)) {
    errors.push('participatingKols must be array');
  } else {
    for (let i = 0; i < row.participatingKols.length; i++) {
      const k = row.participatingKols[i];
      if (!k || typeof k !== 'object') {
        errors.push(`participatingKols[${i}] must be object`);
        continue;
      }
      if (!isNonEmptyString(k.id)) {
        errors.push(`participatingKols[${i}].id must be non-empty string`);
      }
      if (!VALID_TIER_TAGS.has(k.tier)) {
        errors.push(`participatingKols[${i}].tier must be 'S'|'A'|'B', got '${String(k.tier)}'`);
      }
      if (!isFiniteNumber(k.timestamp) || k.timestamp <= 0) {
        errors.push(`participatingKols[${i}].timestamp must be positive finite number`);
      }
    }
    if (Array.isArray(row.kols)) {
      const expected = row.participatingKols.map((k) => k.id);
      const got = row.kols;
      if (expected.length !== got.length || expected.some((id, i) => id !== got[i])) {
        warnings.push('kols should be derived alias of participatingKols.map(k => k.id) in same order');
      }
    } else {
      errors.push('kols must be array (derived from participatingKols)');
    }
  }

  // independentKolCount 필수 + finite + >= 0
  if (!isFiniteNumber(row.independentKolCount) || row.independentKolCount < 0) {
    errors.push('independentKolCount must be finite number >= 0');
  }

  // partial take 필드 — 위 finite check 에 포함되어 있지만 missing required 별도 체크
  if (row.partialTakeRealizedSol === undefined || row.partialTakeRealizedSol === null) {
    errors.push('partialTakeRealizedSol must be number (0 if no partial)');
  }
  if (row.partialTakeLockedTicketSol === undefined || row.partialTakeLockedTicketSol === null) {
    errors.push('partialTakeLockedTicketSol must be number (0 if no partial)');
  }

  // parentPositionId 필수 (null 허용 — non-tail 인 경우 null)
  if (row.parentPositionId === undefined) {
    errors.push('parentPositionId must be present (null if non-tail)');
  }

  // ─── Codex M4 + F2 보정 — survivalFlags 는 string[] 강제 ───
  // F2: non-array 는 error (이전엔 Array.isArray 일 때만 검사 → non-array 통과 위험)
  if (row.survivalFlags !== undefined && row.survivalFlags !== null) {
    if (!Array.isArray(row.survivalFlags)) {
      errors.push('survivalFlags must be array of string');
    } else {
      for (let i = 0; i < row.survivalFlags.length; i++) {
        if (typeof row.survivalFlags[i] !== 'string') {
          errors.push(`survivalFlags[${i}] must be string`);
        }
      }
    }
  }

  // ─── Mode-conditional 필수 + truth source 일관성 (Codex M2 + M3 보정) ───
  if (row.mode === 'live') {
    if (row.walletDeltaSol === undefined || row.walletDeltaSol === null) {
      errors.push("mode='live' → walletDeltaSol non-null required");
    } else if (!isFiniteNumber(row.walletDeltaSol)) {
      errors.push("mode='live' → walletDeltaSol must be finite number");
    }
    if (row.pnlTruthSource !== 'wallet_delta') {
      errors.push(`mode='live' → pnlTruthSource must be 'wallet_delta', got '${String(row.pnlTruthSource)}'`);
    }
    // Codex M3 보정: warning → error (truth source 강제)
    if (row.simulatedNetSol !== null && row.simulatedNetSol !== undefined) {
      errors.push("mode='live' → simulatedNetSol must be null (truth source mismatch)");
    }
    if (row.paperModelVersion !== null && row.paperModelVersion !== undefined) {
      errors.push("mode='live' → paperModelVersion must be null");
    }
    // Codex M2 — netSol === walletDeltaSol 정합
    if (
      isFiniteNumber(row.netSol) &&
      isFiniteNumber(row.walletDeltaSol) &&
      Math.abs(row.netSol - row.walletDeltaSol) > 1e-9
    ) {
      errors.push(
        `mode='live' → netSol must equal walletDeltaSol (truth alias). ` +
        `netSol=${row.netSol} walletDeltaSol=${row.walletDeltaSol}`
      );
    }
  } else if (row.mode === 'paper') {
    if (row.simulatedNetSol === undefined || row.simulatedNetSol === null) {
      errors.push("mode='paper' → simulatedNetSol non-null required");
    } else if (!isFiniteNumber(row.simulatedNetSol)) {
      errors.push("mode='paper' → simulatedNetSol must be finite number");
    }
    if (row.paperModelVersion === undefined || row.paperModelVersion === null) {
      errors.push("mode='paper' → paperModelVersion non-null required");
    } else if (!isNonEmptyString(row.paperModelVersion)) {
      errors.push("mode='paper' → paperModelVersion must be non-empty string");
    }
    if (row.pnlTruthSource !== 'paper_simulation') {
      errors.push(`mode='paper' → pnlTruthSource must be 'paper_simulation', got '${String(row.pnlTruthSource)}'`);
    }
    // Codex M3 보정: warning → error
    if (row.walletDeltaSol !== null && row.walletDeltaSol !== undefined) {
      errors.push("mode='paper' → walletDeltaSol must be null (truth source mismatch)");
    }
    // Codex M2 — netSol === simulatedNetSol 정합
    if (
      isFiniteNumber(row.netSol) &&
      isFiniteNumber(row.simulatedNetSol) &&
      Math.abs(row.netSol - row.simulatedNetSol) > 1e-9
    ) {
      errors.push(
        `mode='paper' → netSol must equal simulatedNetSol (truth alias). ` +
        `netSol=${row.netSol} simulatedNetSol=${row.simulatedNetSol}`
      );
    }
  } else {
    errors.push(`mode must be 'paper' or 'live', got '${String(row.mode)}'`);
  }

  // ─── Codex M5 보정 — T1/T2/T3 visit boolean ↔ timestamp 정합 (loop) ───
  const visitTiers: Array<{
    visitedKey: 't1Visited' | 't2Visited' | 't3Visited';
    timestampKey: 't1VisitAtSec' | 't2VisitAtSec' | 't3VisitAtSec';
    label: string;
  }> = [
    { visitedKey: 't1Visited', timestampKey: 't1VisitAtSec', label: 'T1' },
    { visitedKey: 't2Visited', timestampKey: 't2VisitAtSec', label: 'T2' },
    { visitedKey: 't3Visited', timestampKey: 't3VisitAtSec', label: 'T3' },
  ];
  for (const tier of visitTiers) {
    const visited = row[tier.visitedKey];
    const ts = row[tier.timestampKey];
    if (ts !== undefined && ts !== null && visited === false) {
      warnings.push(`${tier.label} ${tier.visitedKey}=false but ${tier.timestampKey} is set`);
    }
    if ((ts === null || ts === undefined) && visited === true) {
      warnings.push(`${tier.label} ${tier.visitedKey}=true but ${tier.timestampKey} is null`);
    }
  }

  // actual5xPeak 정합 — mfePctPeak >= 4.0 (5x = +400%) 시 true 여야 함
  if (isFiniteNumber(row.mfePctPeak) && row.actual5xPeak !== undefined) {
    const expected5x = row.mfePctPeak >= 4.0;
    if (row.actual5xPeak !== expected5x) {
      warnings.push(`actual5xPeak=${row.actual5xPeak} but mfePctPeak=${row.mfePctPeak} → expected ${expected5x}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * kol-call-funnel/v1 row validator.
 * §3.3 — eventType-conditional positionId / rejectCategory 필수.
 */
export function validateFunnelRecord(row: Partial<KolCallFunnelV1>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (row.schemaVersion !== KOL_CALL_FUNNEL_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${KOL_CALL_FUNNEL_SCHEMA_VERSION}', got '${String(row.schemaVersion)}'`);
  }

  // 필수 (모든 row)
  const requiredAlways: Array<keyof KolCallFunnelV1> = [
    'recordId', 'eventId', 'emitNonce', 'emitTsMs', 'eventType', 'tokenMint',
  ];
  for (const k of requiredAlways) {
    if (row[k] === undefined || row[k] === null) {
      errors.push(`missing required field: ${String(k)}`);
    }
  }

  // Codex M4 — string 비빈 + emitTsMs finite + > 0
  const nonEmptyStringFields: Array<keyof KolCallFunnelV1> = [
    'recordId', 'eventId', 'emitNonce', 'tokenMint',
  ];
  for (const k of nonEmptyStringFields) {
    const v = row[k];
    if (v !== undefined && v !== null && !isNonEmptyString(v)) {
      errors.push(`${String(k)} must be non-empty string`);
    }
  }
  if (row.emitTsMs !== undefined && row.emitTsMs !== null) {
    if (!isFiniteNumber(row.emitTsMs) || row.emitTsMs <= 0) {
      errors.push('emitTsMs must be positive finite number');
    }
  }
  if (row.kolTier !== undefined && !VALID_TIER_TAGS.has(row.kolTier)) {
    errors.push(`kolTier must be 'S'|'A'|'B', got '${String(row.kolTier)}'`);
  }
  // Codex F1 — eventType enum 강제 (필수 + valid)
  if (row.eventType !== undefined && !VALID_EVENT_TYPES.has(row.eventType)) {
    errors.push(
      `eventType must be one of [${Array.from(VALID_EVENT_TYPES).join(', ')}], got '${String(row.eventType)}'`,
    );
  }
  // Codex F1 — action enum 강제 (optional 이지만 set 되면 valid 여야 함)
  if (row.action !== undefined && !VALID_ACTIONS.has(row.action)) {
    errors.push(`action must be 'buy' | 'sell', got '${String(row.action)}'`);
  }
  // Codex F5 — solAmount >= 0 (음수 차단)
  if (row.solAmount !== undefined && row.solAmount !== null) {
    if (!isFiniteNumber(row.solAmount)) {
      errors.push('solAmount must be finite number');
    } else if (row.solAmount < 0) {
      errors.push(`solAmount must be >= 0, got ${row.solAmount}`);
    }
  }

  // eventType-conditional
  // Codex S2.5 P2-2 보정: truthiness 체크가 아닌 isNonEmptyString 사용 — `positionId: 123` /
  //   `rejectCategory: {}` 같은 truthy 비-string 값이 join/grouping key 깨뜨림.
  if (row.eventType && POSITION_ID_REQUIRED_EVENTS.has(row.eventType)) {
    if (!isNonEmptyString(row.positionId)) {
      errors.push(`eventType='${row.eventType}' → positionId required (non-empty string)`);
    }
  }
  if (row.eventType && REJECT_CATEGORY_REQUIRED_EVENTS.has(row.eventType)) {
    if (!isNonEmptyString(row.rejectCategory)) {
      errors.push(`eventType='${row.eventType}' → rejectCategory required (non-empty string)`);
    }
  }

  // emitNonce / eventId / recordId distinct (Codex M1 — 3-key 분리 보장)
  if (
    typeof row.eventId === 'string' &&
    typeof row.emitNonce === 'string' &&
    row.eventId === row.emitNonce
  ) {
    warnings.push('eventId === emitNonce — Codex M1 보정 위반 가능 (3-key 분리)');
  }
  if (
    typeof row.recordId === 'string' &&
    typeof row.eventId === 'string' &&
    row.recordId === row.eventId
  ) {
    warnings.push('recordId === eventId — recordId 는 unique, eventId 는 dedupe 용으로 분리되어야 함');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Codex M1 (S1.5 보정) — deterministic eventId 산출.
 *
 * 정책: **dedupe 목표 = "동일 tx/position 의 재기록 dedupe" + "고정 컨텍스트 없는 event 의 같은 1초 중복 흡수"**.
 *
 *   1) `txSignature` 또는 `positionId` 있는 event → **bucket 제외**.
 *      sha1(eventType | tokenMint | txSignature | positionId | rejectCategory)
 *      재시작 후 1초 밖에서 같은 sig/positionId event 가 다시 emit 되어도 동일 eventId 로 흡수.
 *
 *   2) txSignature / positionId 둘 다 없는 event (kol_call no-tx, smart_v3_no_trigger 등) → **1초 버킷 사용**.
 *      sha1(eventType | tokenMint | rejectCategory | eventTsMsBucket)
 *      이 경우 timestamp 외에 dedupe 차원이 없어 burst 흡수 용도로 1초 버킷.
 *
 * **emitNonce 는 dedupe key 에 절대 포함 안 함** (매번 달라지면 dedupe 불가능).
 */
export function computeEventId(input: FunnelEventIdInput): string {
  const hasStrongKey = Boolean(input.txSignature) || Boolean(input.positionId);
  const parts: string[] = [
    input.eventType,
    input.tokenMint,
    input.txSignature ?? '',
    input.positionId ?? '',
    input.rejectCategory ?? '',
  ];
  if (!hasStrongKey) {
    // 1초 버킷 (timestamp 외 dedupe 차원 없는 경우만)
    const bucket = Math.floor(input.emitTsMs / 1000) * 1000;
    parts.push(String(bucket));
  }
  const hash = createHash('sha1');
  hash.update(parts.join('|'));
  return hash.digest('hex');
}

/**
 * recordId 산출 — eventId + emitNonce 조합으로 unique row id.
 * eventId 가 같아도 emitNonce 가 달라 recordId 는 distinct → analysis 시 eventId 로 dedup 후 첫 row 만 채택.
 */
export function computeRecordId(eventId: string, emitNonce: string): string {
  const hash = createHash('sha1');
  hash.update(`${eventId}|${emitNonce}`);
  return hash.digest('hex');
}
