/**
 * Lane Outcome Types — Kelly Controller P0 (Accounting Eligibility, 2026-04-26)
 *
 * ADR: docs/design-docs/lane-edge-controller-kelly-2026-04-25.md §10 P0
 * INCIDENT: 2026-04-26 entry — P0 산출물 5 필드 명시.
 *
 * Why: Kelly / cohort allocator 는 wallet-truth 기반 outcome 만 입력으로 받아야 한다.
 *      duplicate buy / open-row stale / DB drift 같은 reconcile 실패 trade 는
 *      `kelly_eligible=false` 로 분리해 Kelly 계산에서 제외.
 *
 * 본 파일은 single source of truth — laneOutcomeReconciler / canary-eval / 향후
 * laneEdgeController 모두 이 타입을 import.
 */

/** Lane 명시 — legacy StrategyName 외에 신규 lane 도 1st-class. */
export type LaneName =
  | 'cupsey_flip_10s'
  | 'pure_ws_breakout'
  | 'kol_hunter'
  | 'migration_reclaim'
  | 'bootstrap_10s'
  | 'volume_spike'
  | 'fib_pullback'
  | 'core_momentum'
  | 'new_lp_sniper'
  | 'unknown';

/** Arm 명시 — lane 안의 sub-variant (예: pure_ws 의 v1_bootstrap vs ws_burst_v2). */
export type ArmName = string; // free-form (lane 별로 자체 정의)

/**
 * Reconcile 결과 분류.
 *  - ok: buy ↔ sell FIFO 매칭 + entry/exit price 정합 + wallet delta drift 허용 범위
 *  - duplicate_buy: 동일 entryTxSignature 가 buy ledger 에 2회 이상
 *  - orphan_sell: sell tx 의 entryTxSignature 가 buy ledger 에 없음
 *  - open_row_stale: buy 만 있고 sell 없는 채로 N 시간 이상 (default 24h)
 *  - wallet_drift: paired trade 의 DB pnl 과 wallet delta 차이 > threshold
 */
export type ReconcileStatus =
  | 'ok'
  | 'duplicate_buy'
  | 'orphan_sell'
  | 'open_row_stale'
  | 'wallet_drift';

/**
 * Outcome 의 wallet truth source.
 *  - executed_ledger: executed-buys/sells.jsonl 의 actual fill (1순위)
 *  - wallet_delta_comparator: comparator 의 observed delta (paired trade 가 없을 때)
 *  - db_pnl: fallback only — kelly_eligible=false 강제
 *  - unreconciled: 근거 부족 — kelly_eligible=false 강제
 */
export type WalletTruthSource =
  | 'executed_ledger'
  | 'wallet_delta_comparator'
  | 'db_pnl'
  | 'unreconciled';

/**
 * Reconciled lane outcome — Kelly Controller P0 산출물.
 *
 * 출력 파일: `${REALTIME_DATA_DIR}/lane-outcomes-reconciled.jsonl` (append-only).
 * 매 trade close 또는 batch reconcile 시 1 record 추가.
 */
export interface LaneOutcomeRecord {
  // Identity
  positionId: string;
  laneName: LaneName;
  armName: ArmName;
  tokenMint?: string;
  pairAddress?: string;
  tokenSymbol?: string;

  // Tx signatures (buy/sell match key)
  entryTxSignature?: string;
  exitTxSignature?: string;

  // Timing
  entryTimeSec?: number;
  exitTimeSec?: number;
  holdSec?: number;

  // Cash flow (wallet truth — sell.receivedSol, buy.solSpent)
  spentSol?: number;
  receivedSol?: number;
  feesSol?: number;
  realizedPnlSol?: number; // receivedSol - spentSol - feesSol

  // Microstructure (P2-4)
  maxMfePct?: number;
  maxMaePct?: number;
  t1VisitAtSec?: number | null;
  t2VisitAtSec?: number | null;
  t3VisitAtSec?: number | null;
  exitReason?: string;

  // ─── Kelly Controller P0 핵심 5 필드 ───
  /** 모든 reconcile 통과 시 true. false 인 outcome 은 Kelly 계산에서 제외 강제. */
  kellyEligible: boolean;
  /** Reconcile 분류 — non-'ok' 시 kellyEligible=false. */
  reconcileStatus: ReconcileStatus;
  /** Buy ledger record 의 식별자 (positionId or txSignature). null = orphan_sell. */
  matchedBuyId: string | null;
  /** Sell ledger record 의 식별자. null = open_row_stale. */
  matchedSellId: string | null;
  /** Wallet truth source. db_pnl/unreconciled 는 kellyEligible=false 강제. */
  walletTruthSource: WalletTruthSource;

  // Discovery / cohort 입력
  discoverySource?: string;  // ws_burst_v2 / kol_lexapro / launchlab_event 등
  paperOnly?: boolean;

  // Append metadata
  recordedAt: string; // ISO date
}

/**
 * Reconcile 통계 — 운영 모니터링용.
 */
export interface ReconcileSummary {
  totalRecords: number;
  byStatus: Record<ReconcileStatus, number>;
  kellyEligibleRatio: number; // ok / total
  byLane: Record<string, number>;
  /** P0 종료 조건 검증: ≥ 0.95 면 P1 진행 가능 (ADR §10 P0 종료 조건). */
  p0GateMet: boolean;
}
