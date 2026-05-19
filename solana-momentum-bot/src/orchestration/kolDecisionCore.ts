import type {
  KolDecisionAction,
  KolLiveEquivalenceDecisionStage,
  KolPaperRole,
} from '../observability/kolLiveEquivalence';
import { createHash } from 'crypto';

export const KOL_EXECUTION_PLAN_SCHEMA_VERSION = 'kol-execution-plan/v1' as const;
export const KOL_EXECUTION_GUARD_SCHEMA_VERSION = 'kol-execution-guard/v1' as const;

export type KolExecutionGuardAction =
  | 'pretrade_reject'
  | 'telemetry_only'
  | 'forced_exit'
  | 'fallback_paper'
  | 'reject'
  | 'defer';

export type KolExecutionGuardName =
  | 'price_feed_missing'
  | 'inflight_live_entry'
  | 'live_price_timeout'
  | 'live_fresh_reference_reject'
  | 'rotation_underfill_live_pretrade_reject'
  | 'live_sell_quote_reject'
  | 'canary_slot_full'
  | 'smart_v3_hardcut_reentry_inflight'
  | 'live_buy_failed'
  | 'rotation_underfill_actual_discount_warn'
  | 'promotion_loop_halt';

export interface KolExecutionGuardSnapshot {
  schemaVersion: typeof KOL_EXECUTION_GUARD_SCHEMA_VERSION;
  guard: KolExecutionGuardName;
  action: KolExecutionGuardAction;
  reason: string | null;
  flags: string[];
}

export interface KolDecisionTraceFields {
  liveEquivalenceCandidateId?: string;
  liveEquivalenceDecisionId?: string;
  liveEquivalenceDecisionAction?: KolDecisionAction;
  paperRole?: KolPaperRole | null;
  liveEquivalenceDecisionStage?: KolLiveEquivalenceDecisionStage;
  liveEquivalenceLiveWouldEnter?: boolean;
  liveEquivalenceLiveBlockReason?: string | null;
}

export interface KolExecutionPlanSnapshot {
  schemaVersion: typeof KOL_EXECUTION_PLAN_SCHEMA_VERSION;
  planId: string;
  executionPlanHash: string;
  mode: 'paper' | 'live';
  candidateId: string | null;
  decisionId: string | null;
  referencePrice: number;
  ticketSol: number;
  expectedQuantity: number;
  tokenDecimals: number | null;
  routeFound: boolean | null;
  sellQuoteReason: string | null;
  executionGuard: KolExecutionGuardSnapshot | null;
}

function normalizePlanNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Number(value.toPrecision(12));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function executionPlanHash(input: {
  candidateId: string | null;
  decisionId: string | null;
  referencePrice: number;
  ticketSol: number;
  expectedQuantity: number;
  tokenDecimals: number | null;
  routeFound: boolean | null;
  sellQuoteReason: string | null;
  executionGuard: KolExecutionGuardSnapshot | null;
}): string {
  const hashInput = {
    candidateId: input.candidateId,
    decisionId: input.decisionId,
    referencePrice: normalizePlanNumber(input.referencePrice),
    ticketSol: normalizePlanNumber(input.ticketSol),
    expectedQuantity: normalizePlanNumber(input.expectedQuantity),
    tokenDecimals: input.tokenDecimals,
    routeFound: input.routeFound,
    sellQuoteReason: input.sellQuoteReason,
    executionGuard: input.executionGuard,
  };
  return createHash('sha256').update(stableStringify(hashInput)).digest('hex').slice(0, 24);
}

export function buildKolExecutionGuardSnapshot(input: {
  guard: KolExecutionGuardName;
  action: KolExecutionGuardAction;
  reason?: string | null;
  flags?: string[];
}): KolExecutionGuardSnapshot {
  return {
    schemaVersion: KOL_EXECUTION_GUARD_SCHEMA_VERSION,
    guard: input.guard,
    action: input.action,
    reason: input.reason ?? null,
    flags: Array.from(new Set(input.flags ?? [])),
  };
}

export function buildLiveEquivalenceDecisionId(
  candidateId: string,
  stage: KolLiveEquivalenceDecisionStage,
  action: KolDecisionAction,
  reason?: string | null
): string {
  const normalizedReason = (reason ?? 'none')
    .toLowerCase()
    .replace(/[^a-z0-9_=-]+/g, '_')
    .slice(0, 80);
  return `${candidateId}:${stage}:${action}:${normalizedReason}`;
}

export function liveEquivalenceActionFor(liveWouldEnter: boolean): KolDecisionAction {
  return liveWouldEnter ? 'enter' : 'block';
}

export function paperRoleForLiveEquivalence(
  stage: KolLiveEquivalenceDecisionStage,
  liveWouldEnter: boolean
): KolPaperRole {
  if (liveWouldEnter) return 'mirror';
  if (stage === 'default_paper' || stage === 'paper_only') return 'research_arm';
  return 'fallback_execution_safety';
}

export function decisionActionForTrace(trace: KolDecisionTraceFields): KolDecisionAction | undefined {
  if (trace.liveEquivalenceDecisionAction) return trace.liveEquivalenceDecisionAction;
  if (typeof trace.liveEquivalenceLiveWouldEnter === 'boolean') {
    return liveEquivalenceActionFor(trace.liveEquivalenceLiveWouldEnter);
  }
  return undefined;
}

export function decisionIdForTrace(trace: KolDecisionTraceFields): string | undefined {
  if (trace.liveEquivalenceDecisionId) return trace.liveEquivalenceDecisionId;
  const action = decisionActionForTrace(trace);
  if (!trace.liveEquivalenceCandidateId || !trace.liveEquivalenceDecisionStage || !action) {
    return undefined;
  }
  return buildLiveEquivalenceDecisionId(
    trace.liveEquivalenceCandidateId,
    trace.liveEquivalenceDecisionStage,
    action,
    trace.liveEquivalenceLiveBlockReason
  );
}

export function paperRoleForTrace(
  trace: KolDecisionTraceFields,
  input: { isShadowArm: boolean }
): KolPaperRole {
  if (input.isShadowArm) return 'shadow';
  if (trace.paperRole) return trace.paperRole;
  if (
    trace.liveEquivalenceDecisionStage &&
    typeof trace.liveEquivalenceLiveWouldEnter === 'boolean'
  ) {
    return paperRoleForLiveEquivalence(
      trace.liveEquivalenceDecisionStage,
      trace.liveEquivalenceLiveWouldEnter
    );
  }
  return 'research_arm';
}

export function buildKolExecutionPlanSnapshot(input: {
  mode: 'paper' | 'live';
  positionId: string;
  trace: KolDecisionTraceFields;
  referencePrice: number;
  ticketSol: number;
  expectedQuantity: number;
  tokenDecimals?: number;
  sellQuoteEvidence?: { routeFound?: boolean | null; reason?: string | null } | null;
  executionGuard?: KolExecutionGuardSnapshot | null;
}): KolExecutionPlanSnapshot {
  const decisionId = decisionIdForTrace(input.trace) ?? null;
  const candidateId = input.trace.liveEquivalenceCandidateId ?? null;
  const tokenDecimals = input.tokenDecimals ?? null;
  const routeFound = input.sellQuoteEvidence?.routeFound ?? null;
  const sellQuoteReason = input.sellQuoteEvidence?.reason ?? null;
  const executionGuard = input.executionGuard ?? null;
  return {
    schemaVersion: KOL_EXECUTION_PLAN_SCHEMA_VERSION,
    planId: decisionId
      ? `${decisionId}:${input.mode}:${input.positionId}:plan`
      : `${input.mode}:${input.positionId}:plan`,
    executionPlanHash: executionPlanHash({
      candidateId,
      decisionId,
      referencePrice: input.referencePrice,
      ticketSol: input.ticketSol,
      expectedQuantity: input.expectedQuantity,
      tokenDecimals,
      routeFound,
      sellQuoteReason,
      executionGuard,
    }),
    mode: input.mode,
    candidateId,
    decisionId,
    referencePrice: input.referencePrice,
    ticketSol: input.ticketSol,
    expectedQuantity: input.expectedQuantity,
    tokenDecimals,
    routeFound,
    sellQuoteReason,
    executionGuard,
  };
}
