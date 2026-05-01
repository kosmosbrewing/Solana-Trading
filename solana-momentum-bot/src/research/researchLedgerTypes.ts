/**
 * Research Ledger schema v1 — types only (S1).
 *
 * ADR: docs/design-docs/research-ledger-unification-2026-05-01.md
 *
 * Codex 보정 (2026-05-01) 반영:
 *   M1 — eventId / emitNonce / recordId 3-key 분리
 *   M2 — pnlTruthSource 와 price source 분리
 *   M3 — actualInputSol / receivedSol / solSpentNominal / effectiveTicketSol 추가
 *   M4 — entryTxSignature / exitTxSignature / dbTradeId / wallet 추가
 *   M5 — participatingKols (tier + timestamp), kols 는 derived alias
 *   M6 — t1/t2/t3 visit timestamp 보존
 *   M8 — kolEntryReason / kolConvictionLevel nullable (legacy)
 *   L1 — top10HolderPct 명칭 단축
 *
 * S1 범위: types + fixtures + validator. **writer 미포함** (S2).
 */

export const TRADE_OUTCOME_SCHEMA_VERSION = 'trade-outcome/v1' as const;
export const KOL_CALL_FUNNEL_SCHEMA_VERSION = 'kol-call-funnel/v1' as const;

export type TradeMode = 'paper' | 'live';
export type KolTierTag = 'S' | 'A' | 'B';
export type PnlTruthSource = 'wallet_delta' | 'paper_simulation';

export interface ParticipatingKolSnapshot {
  /** KOL DB id (lowercase, unique) */
  id: string;
  /** 진입 시점 tier — 추후 KOL DB 변경 무관 보존 */
  tier: KolTierTag;
  /** 진입 시점 epoch ms */
  timestamp: number;
}

/**
 * trade-outcome/v1 — 실제 진입한 paper/live position 의 close 시점 record.
 * mode 필드로 paper/live cohort 분리.
 */
export interface TradeOutcomeV1 {
  schemaVersion: typeof TRADE_OUTCOME_SCHEMA_VERSION;

  // ─── Identity ───
  recordId: string;
  positionId: string;
  sessionId?: string;
  tokenMint: string;
  mode: TradeMode;
  wallet?: string;

  // ─── KOL cohort ───
  armName: string;
  parameterVersion: string;
  participatingKols: ParticipatingKolSnapshot[];
  kols: string[]; // derived alias = participatingKols.map(k => k.id)
  independentKolCount: number;
  effectiveIndependentCount?: number;
  kolEntryReason?: string | null;
  kolConvictionLevel?: string | null;
  kolReinforcementCount?: number;

  // ─── Position context ───
  isShadowArm: boolean;
  isTailPosition: boolean;
  parentPositionId: string | null;
  partialTakeRealizedSol: number;
  partialTakeLockedTicketSol: number;
  partialTakeAtSec?: number | null;

  // ─── Pricing / size ───
  ticketSol: number;
  actualInputSol?: number;
  receivedSol?: number;
  solSpentNominal?: number;
  effectiveTicketSol: number;
  entryPrice: number;
  exitPrice: number;
  entrySlippageBps?: number;
  exitSlippageBps?: number;
  entryAdvantagePct?: number;
  buyExecutionMs?: number;
  sellExecutionMs?: number;

  // ─── PnL truth ───
  walletDeltaSol: number | null;
  simulatedNetSol: number | null;
  paperModelVersion: string | null;
  pnlTruthSource: PnlTruthSource;
  netSol: number;
  netPct: number;
  dbPnlSol?: number;
  dbPnlDriftSol?: number;

  // ─── Price source ───
  entryPriceSource?: string;
  exitPriceSource?: string;
  trajectoryPriceSource?: string;

  // ─── tx signatures ───
  entryTxSignature?: string;
  exitTxSignature?: string;
  dbTradeId?: string;

  // ─── Trajectory ───
  mfePctPeak: number;
  maePct: number;
  holdSec: number;
  exitReason: string;
  t1Visited: boolean;
  t2Visited: boolean;
  t3Visited: boolean;
  t1VisitAtSec: number | null;
  t2VisitAtSec: number | null;
  t3VisitAtSec: number | null;
  actual5xPeak: boolean;

  // ─── Survival / quality ───
  survivalFlags: string[];
  tokenQualityFlags?: string[];
  top10HolderPct?: number;
  top1HolderPct?: number;
  top5HolderPct?: number;
  holderHhi?: number;

  // ─── Timestamps ───
  entryAtIso: string;
  exitAtIso: string;
  entryTimeSec: number;
  exitTimeSec: number;
}

/**
 * kol-call-funnel/v1 — KOL call → observe → reject/cancel → entry → close 의 모든 funnel event.
 * 거래 안 한 CA / reject / no-trigger / cancel 모두 기록.
 */
export type FunnelEventType =
  | 'kol_call'
  | 'pending_open'
  | 'survival_reject'
  | 'observe_open'
  | 'smart_v3_no_trigger'
  | 'kol_sell_cancel'
  | 'trigger_fire'
  | 'entry_open'
  | 'entry_reject'
  | 'position_close';

export interface KolCallFunnelV1 {
  schemaVersion: typeof KOL_CALL_FUNNEL_SCHEMA_VERSION;

  // ─── Identity (Codex M1 — 3-key 분리) ───
  /** unique row id — append-side 에서 sha1(eventId|emitNonce) 또는 UUID v4 */
  recordId: string;
  /**
   * deterministic dedupe key. Codex S1.5 보정:
   *   - strong key (txSignature OR positionId) 있으면 bucket 미포함:
   *       sha1(eventType | tokenMint | txSignature | positionId | rejectCategory)
   *       → 재시작 후 1초 밖에서 같은 sig/positionId 재기록되어도 동일 eventId.
   *   - strong key 없는 event 만 1초 버킷 사용:
   *       sha1(eventType | tokenMint | rejectCategory | eventTsMsBucket)
   *       → 같은 1초 안 burst 흡수 용도.
   * 산출: `computeEventId(input)` (researchLedgerValidator.ts).
   */
  eventId: string;
  /** process-local uniqueness (pid + counter). dedupe 미사용, debug 전용 */
  emitNonce: string;
  emitTsMs: number;
  sessionId?: string;

  // ─── Event ───
  eventType: FunnelEventType;
  tokenMint: string;
  positionId?: string;
  txSignature?: string;
  parentPositionId?: string;

  // ─── KOL ───
  kolId?: string;
  kolTier?: KolTierTag;
  walletAddress?: string;
  action?: 'buy' | 'sell';
  solAmount?: number;
  isShadowKol?: boolean;

  // ─── Decision context ───
  armName?: string;
  parameterVersion?: string;
  rejectCategory?: string;
  rejectReason?: string;
  signalSource?: string;

  // ─── Free-form extras ───
  extras?: Record<string, unknown>;
}

/**
 * eventId 산출용 입력 — validator + S2 writer 의 공통 deterministic key 산출.
 * Codex M1: 매번 달라지는 nonce 는 dedupe key 에 포함 금지.
 */
export interface FunnelEventIdInput {
  eventType: FunnelEventType;
  tokenMint: string;
  emitTsMs: number;
  txSignature?: string;
  positionId?: string;
  rejectCategory?: string;
}
