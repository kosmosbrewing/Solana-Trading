/**
 * kol_hunter Lane Handler (Option 5 Phase 3 — FULL, 2026-04-23)
 *
 * ADR: docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md
 * REFACTORING_v1.0.md §8: Phase 3 paper-first full state machine.
 *
 * Paper-mode only (config.kolHunterPaperOnly=true 강제 권장).
 * Live 전환은 Phase 4 canary 단계에서 운영자 명시 승인 필요.
 *
 * ─── Flow ─────────────────────────────────────────────
 *  1. handleKolSwap(tx) — KolWalletTracker 에서 emit 된 KolTx 수신
 *  2. sell event → Phase 4+ exit tracking (현재 로깅만)
 *  3. buy event → pending candidate 로 등록 + stalk window 시작
 *  4. Stalk window 내 추가 KOL tx → multi-KOL consensus 집계
 *  5. Stalk 만료 or consensus ≥ minConsensus → PaperPosition 생성
 *  6. price feed subscribe → 주기 tick 으로 state machine 평가
 *  7. PROBE → T1(+50%) → T2(+400%) → T3(+900%) — Lane T 파라미터
 *  8. exit 시 observer 훅 (5 category) + paper ledger append
 *
 * ─── State Machine (Lane T 파라미터) ──────────────────
 *  PROBE:
 *    - hardcut: MAE ≤ -10%                          → probe_hard_cut
 *    - quickReject: 180s 내 3-factor degraded exit  → quick_reject_classifier_exit
 *    - flat timeout: stalk window+180s 만료 + flat → probe_reject_timeout
 *    - probe trail: peak × (1 - 15%) hit           → probe_flat_cut
 *    - T1 promote: MFE ≥ +50%
 *  RUNNER_T1:
 *    - T2 promote: MFE ≥ +400%
 *    - holdPhase degraded (3+ factor)              → hold_phase_sentinel_degraded_exit
 *    - T1 trail: peak × (1 - 15%)                  → WINNER_TRAILING
 *  RUNNER_T2:
 *    - T3 promote: MFE ≥ +900%
 *    - T2 trail: max(peak × (1-20%), entry×3 lock)
 *    - holdPhase degraded                          → hold_phase_sentinel_degraded_exit
 *  RUNNER_T3:
 *    - no time stop
 *    - T3 trail: peak × (1 - 25%)
 *
 * Real Asset Guard 무영향 (paper only, 지갑 trade 0).
 */
import { EventEmitter } from 'events';
import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { createModuleLogger } from '../utils/logger';
import { config } from '../utils/config';
import type { KolTx, KolDiscoveryScore } from '../kol/types';
import { computeKolDiscoveryScore } from '../kol/scoring';
import { getKolLaneRole, getKolTradingStyle, lookupKolById } from '../kol/db';
import { evaluateKolShadowPolicy } from '../kol/policy';
import type { KolPolicyDecision, KolPolicyInput, KolPolicyParticipant } from '../kol/policyTypes';
import {
  evaluatePostDistributionGuard,
} from '../kol/postDistributionGuard';
import { PaperPriceFeed, type PriceTick } from '../kol/paperPriceFeed';
import { trackRejectForMissedAlpha, type MissedAlphaEvent } from '../observability/missedAlphaObserver';
import {
  buildTradeMarkoutConfigFromGlobal,
  hydrateTradeMarkoutSchedulesFromLedger,
  trackTradeMarkout,
} from '../observability/tradeMarkoutObserver';
import { trackKolClose } from './kolMissedAlpha';
import {
  appendKolLiveEquivalence,
  KOL_LIVE_EQUIVALENCE_SCHEMA_VERSION,
  type KolLiveEquivalenceDecisionStage,
  type KolLiveEquivalenceRow,
} from '../observability/kolLiveEquivalence';
import {
  appendTokenQualityObservation,
  type DevStatus,
  type TokenQualityRecord,
} from '../observability/tokenQualityInspector';
import { resolveDevStatus } from '../observability/devWalletRegistry';
import { evaluateSecurityGate } from '../gate/securityGate';
import { evaluateSellQuoteProbe } from '../gate/sellQuoteProbe';
import type {
  ExitLiquidityData,
  OnchainSecurityClient,
  TokenSecurityData,
} from '../ingester/onchainSecurity';
// 2026-05-01 (Helius Stream B PR 2A close-out): holder risk flag wiring 입력
import { computeHolderRiskFlags } from '../observability/holderDistribution';
// 2026-05-01 (Helius Stream X3): EXIT_LIQUIDITY_UNKNOWN / POOL_NOT_PREWARMED flag wiring
import { joinExitabilityEvidence } from '../observability/exitabilityEvidence';
// 2026-05-01 (Helius Stream X1): pool prewarm admission check
import type { HeliusPoolRegistry } from '../scanner/heliusPoolRegistry';
import { GateCacheManager } from '../gate/gateCacheManager';
import { getJupiter429Stats } from '../observability/jupiterRateLimitMetric';
import { resolveTokenSymbol, lookupCachedSymbol } from '../ingester/tokenSymbolResolver';
import { resolveSellReceivedSolFromSwapResult } from '../executor/executor';
import {
  confirmLiveSellZeroTokenBalance,
  executeLiveSellWithImmediateRetries,
  liveSellRetryMaxAttempts,
  resolveLiveSellInitialTokenBalance,
  setLiveSellInitialBalanceRetryDelaysMsForTests,
  setLiveSellRetryDelaysMsForTests,
  setLiveSellZeroBalanceConfirmDelaysMsForTests,
  type LiveSellRetryUrgency,
} from '../executor/liveSellRetry';
// 2026-04-27 (KOL live canary): pure_ws live path 와 동일 패턴.
import type { Order, PartialFillDataReason, Trade } from '../utils/types';
import type { BotContext } from './types';
import { isPureWsNewPairDiscoverySource } from './pureWs/sourceGate';
import { acquireCanarySlot, releaseCanarySlot } from '../risk/canaryConcurrencyGuard';
import { reportCanaryClose } from '../risk/canaryAutoHalt';
import { reportBleed } from '../risk/dailyBleedBudget';
import { getHardTradingHaltReason, isDrawdownGuardHaltReason } from '../risk/tradingHaltPolicy';
import { isWalletStopActive, getWalletStopGuardState } from '../risk/walletStopGuard';
import { persistOpenTradeWithIntegrity, appendEntryLedger, isEntryHaltActive, triggerEntryHalt, type EntryLane } from './entryIntegrity';
import { resolveActualEntryMetrics } from './signalProcessor';
import { bpsToDecimal } from '../utils/units';
import {
  buildRotationChaseTopupMetrics,
  buildRotationFlowMetrics,
  type RotationFlowMetrics,
} from './rotation/flowMetrics';
import {
  decideRotationFlowExit,
  decideRotationFlowPriceKill,
  type RotationFlowExitDecision,
} from './rotation/flowExitPolicy';
import {
  buildRotationMonetizableEdgeEstimate,
  type RotationMonetizableEdgeEstimate,
} from './rotation/monetizableEdge';
import {
  buildExcursionTelemetryRecord,
  updateExcursionTelemetry,
  type ExcursionTelemetrySnapshot,
} from './excursionTelemetry';
import {
  evaluateCapitulationReboundPolicy,
  evaluateCapitulationReboundRrPolicy,
  type CapitulationReboundDecision,
  type CapitulationReboundTelemetry,
} from './capitulationRebound/policy';

const log = createModuleLogger('KolHunter');
const LANE_STRATEGY = 'kol_hunter' as const;
const LANE_KOL_SMART_V3 = 'kol_hunter_smart_v3' as const;
const LANE_KOL_ROTATION = 'kol_hunter_rotation' as const;
const CAPITULATION_REBOUND_ARM = 'kol_hunter_capitulation_rebound_v1';
const CAPITULATION_REBOUND_RR_ARM = 'kol_hunter_capitulation_rebound_rr_v1';
const ROTATION_UNDERFILL_ARM = 'rotation_underfill_v1';
const ROTATION_EXIT_FLOW_ARM = 'rotation_exit_kol_flow_v1';
const ROTATION_UNDERFILL_EXIT_FLOW_PROFILE_ARM = 'rotation_underfill_exit_flow_v1';
const ROTATION_UNDERFILL_COST_AWARE_PROFILE_ARM = 'rotation_underfill_cost_aware_exit_v2';
const PAPER_CLOSE_WRITER_SCHEMA_VERSION = 'kol-paper-close/v2';
const ROTATION_EXIT_ROUTE_PROOF_SCHEMA_VERSION = 'rotation-exit-route-proof/v1';

// ─── State Types ─────────────────────────────────────────

export type LaneTState =
  | 'STALK'        // 첫 KOL tx 수신 후 consensus 대기
  | 'PROBE'        // entry 직후
  | 'RUNNER_T1'
  | 'RUNNER_T2'
  | 'RUNNER_T3'
  // 2026-05-01 (Phase C): tail sub-position. price kill 후 retained 비중의 별도 state.
  // looser trail + max hold cap. paper-only (config.kolHunterTailRetainEnabled=false default).
  | 'TAIL'
  | 'CLOSED';

export type CloseReason =
  | 'probe_hard_cut'
  | 'probe_reject_timeout'
  | 'probe_flat_cut'
  | 'quick_reject_classifier_exit'
  | 'rotation_dead_on_arrival'
  | 'rotation_mae_fast_fail'
  | 'smart_v3_mae_fast_fail'
  | 'smart_v3_mfe_floor_exit'
  | 'rotation_flow_residual_timeout'
  | 'capitulation_no_reaction'
  | 'capitulation_no_post_cost'
  | 'hold_phase_sentinel_degraded_exit'
  | 'smart_v3_no_trigger'
  | 'smart_v3_price_timeout'
  | 'smart_v3_kol_sell_cancel'
  | 'post_distribution_entry_block'
  | 'insider_exit_full'
  | 'entry_advantage_emergency_exit'
  | 'winner_trailing_t1'
  | 'winner_trailing_t2'
  | 'winner_trailing_t3'
  | 'stalk_expired_no_consensus'
  // 2026-04-27 (P1 audit fix): live canary closeLivePosition 의 orphan path 에서 사용.
  // 기존 cast `as unknown as CloseReason` 제거 — type safety 회복.
  | 'ORPHAN_NO_BALANCE'
  // 2026-04-30 (Sprint 2.A1): runtime sell quote impact / no-route 시 emergency exit.
  // Why: hardcut/QR 보다 우선 — D-bucket (mae<-30%) 의 root cause 가 sell tx confirm 지연.
  //      "팔 수 있는가" 가 stop 보다 먼저 (학술 §exit two-layer 권고).
  | 'structural_kill_sell_route'
  // 2026-05-01 (Phase C): tail sub-position 의 close reasons.
  // price kill 후 15% tail 보존 → 다음 close trigger:
  | 'tail_trail_close'    // peak 대비 trail 임계 (default 30%) 도달
  | 'tail_max_hold'       // max hold (default 3600s) 만료 — moonbag 무한 hold 방지
  | 'tail_winner_capture'; // tail 이 5x+ 도달 후 정상 trail (winner 분리)

export type KolEntryReason =
  | 'legacy_v1'
  | 'swing_v2'
  | 'rotation_v1'
  | 'capitulation_rebound'
  | 'pullback'
  | 'velocity'
  | 'pullback_and_velocity';

export type KolConvictionLevel =
  | 'LOW'
  | 'MEDIUM_HIGH'
  | 'HIGH'
  | 'HIGH_PLUS';

type SmartV3MfeStage =
  | 'probe'
  | 'breakeven_watch'
  | 'profit_lock'
  | 'runner'
  | 'convexity';

export interface PaperPosition {
  positionId: string;
  tokenMint: string;
  state: LaneTState;
  // entry
  entryPrice: number;           // Jupiter quote 시점 가격 (paper — 실 fill 없음)
  entryTimeSec: number;
  /** Stable open timestamp for post-entry top-up checks. `entryTimeSec` may be shifted by recovery/tests. */
  entryOpenedAtMs?: number;
  ticketSol: number;
  quantity: number;             // 가상 수량 (ticketSol / entryPrice)
  // 2026-05-01 (Sprint X measurement-only): ATA rent 분리. token-only entry price 별도 저장.
  // - entryPriceTokenOnly: Jupiter swap input / received qty (사명 §3 5x peak 측정 — paper/live 통일)
  // - entryPriceWalletDelta: wallet pre/post delta / received qty (실 wallet 손익 측정 — Real Asset Guard)
  // paper 는 ATA rent 없음 → 두 값 동일. live 의 신규 토큰 첫 진입 시 ~0.002 SOL 차이 발생.
  // entryPrice 는 backward-compat 으로 유지 (= entryPriceWalletDelta).
  entryPriceTokenOnly?: number;
  entryPriceWalletDelta?: number;
  ataRentSol?: number;          // 신규 ATA 생성 funded SOL (재진입 시 0). live 만.
  swapInputSol?: number;        // 실 swap 에 들어간 SOL (ATA rent / fee / tip 제외). live 만.
  // market reference (MAE/MFE 계산 기준)
  marketReferencePrice: number;
  peakPrice: number;
  troughPrice: number;
  // tier visit timestamps (P2-4 호환)
  t1VisitAtSec?: number;
  t2VisitAtSec?: number;
  t3VisitAtSec?: number;
  // kol metadata
  participatingKols: Array<{ id: string; tier: 'S' | 'A' | 'B'; timestamp: number }>;
  kolScore: number;
  // t2 lock
  t2BreakevenLockPrice?: number;
  /**
   * 2026-04-26 (P1 critical fix): tokenDecimals 를 entry 시점에 stash.
   * Why: missed_alpha_observer 가 close 후 T+60/300/1800s Jupiter price 조회 시
   *      decimals 모르면 'decimals_unknown' error 로 trajectory 측정 불가.
   *      현재 KOL paper 21 trades 의 missed-alpha 대부분이 decimals_unknown 이라 swing arm 결정 데이터 부재.
   *      securityClient 또는 Jupiter quote 에서 정확히 확인된 decimals 만 저장 → close 시 observer 에 전파.
   */
  tokenDecimals?: number;
  tokenDecimalsSource?: 'security_client' | 'jupiter_quote';
  entrySecurityEvidence?: KolEntrySecurityEvidence;
  entrySellQuoteEvidence?: KolEntrySellQuoteEvidence;
  lastPrice: number;
  // 2026-04-25 MISSION_CONTROL §Control 5 telemetry — paper trade ledger 가 live 와 비교 가능하려면
  // arm identity / discovery cluster / parameter version 이 trade 단위로 기록되어야 한다.
  armName: string;
  parameterVersion: string;
  /** Comparable promoted profile when entry and exit arms are intentionally combined. */
  profileArm?: string;
  entryArm?: string;
  exitArm?: string;
  /** Internal live canary circuit lane. DB strategy remains kol_hunter for backward compatibility. */
  canaryLane?: EntryLane;
  isShadowArm: boolean;
  parentPositionId?: string;
  /**
   * 2026-04-28: inactive (shadow) KOL 만으로 trigger 된 paper position 여부.
   * true 면 active KOL paper 분포와 분리된 ledger (`kol-shadow-paper-trades.jsonl`) 로 dump.
   * 결정 정책: cand.kolTxs 의 모든 tx 가 isShadow=true 일 때만 shadow. active 가 1명이라도
   * 끼면 active 우선 (downgrade 안 함).
   */
  isShadowKol?: boolean;
  kolEntryReason: KolEntryReason;
  kolConvictionLevel: KolConvictionLevel;
  t1MfeOverride?: number;
  t1TrailPctOverride?: number;
  t1ProfitFloorMult?: number;
  probeFlatTimeoutSec?: number;
  probeHardCutPctOverride?: number;
  rotationDoaWindowSecOverride?: number;
  rotationDoaMinMfePctOverride?: number;
  rotationDoaMaxMaePctOverride?: number;
  rotationAnchorKols?: string[];
  rotationEntryAtMs?: number;
  rotationAnchorPrice?: number;
  rotationAnchorPriceSource?: string;
  rotationFirstBuyAtMs?: number;
  rotationLastBuyAtMs?: number;
  rotationLastBuyAgeMs?: number;
  rotationScore?: number;
  underfillReferenceSolAmount?: number;
  underfillReferenceTokenAmount?: number;
  rotationFlowExitEnabled?: boolean;
  rotationFlowMetrics?: RotationFlowMetrics;
  rotationFlowDecision?: string;
  rotationFlowReducedAtSec?: number;
  rotationFlowResidualUntilSec?: number;
  rotationFlowLastReducePct?: number;
  rotationFlowReduceInFlight?: boolean;
  rotationFlowLiveReduceTxSignature?: string;
  rotationFlowLiveReduceAttempts?: number;
  rotationMonetizableEdge?: RotationMonetizableEdgeEstimate | null;
  executionGuardReason?: string | null;
  executionGuardAction?: 'pretrade_reject' | 'telemetry_only' | 'forced_exit' | null;
  capitulationTelemetry?: CapitulationReboundTelemetry;
  capitulationEntryLowPrice?: number;
  capitulationEntryLowAtMs?: number;
  capitulationRecoveryConfirmations?: number;
  kolReinforcementCount: number;
  detectorVersion: string;
  independentKolCount: number;
  survivalFlags: string[];
  // 2026-04-27 (KOL live canary): live wallet path 진입 여부.
  // closePosition 가 isLive=true 면 live sell + DB close + canary release 까지 처리.
  // 기본값 false (paper). enterLivePosition 만 true 로 설정.
  isLive?: boolean;
  /** Live position 의 DB tradeId — closeTrade 시 사용. */
  dbTradeId?: string;
  /** Live entry tx signature — ledger / notifier 에 전파. */
  entryTxSignature?: string;
  /** Live entry slippage (bps) — ledger 기록용. */
  entrySlippageBps?: number;
  /**
   * 2026-04-28 F2 fix: live close failure 의 critical notifier 60s cooldown.
   * 이전 코드는 `nowSec - entryTimeSec >= 60s` 라 entry 직후 60s 내 sell 실패 시 critical 미발사.
   * cupsey/pure_ws/migration 패턴 동일 — 마지막 critical 발사 시각 비교.
   */
  lastCloseFailureAtSec?: number;
  /**
   * 2026-05-01 (Phase C): tail sub-position 마커. parent 의 price-kill 후 spawn 된 retained
   * 비중 (default 15%). state 'TAIL' 에서 별도 trail + max hold cap 적용.
   * - paper-only first (isShadowArm=true 강제) — wallet ledger 영향 0
   * - 추가 tail spawn 차단 (재귀 방지)
   */
  isTailPosition?: boolean;
  /**
   * 2026-05-01 (Phase 2.A2 P0): partial take 발화 시각 (재실행 방지).
   * Backward-compatible aggregate marker. T1 partial take 와 rotation flow reduce 는
   * 아래 전용 marker 로 분리하고, 이 필드는 legacy reports/research schema 의 "partial 있음"으로만 쓴다.
   */
  partialTakeAtSec?: number;
  /** T1 promote partial take marker — rotation_flow_reduce 와 독립. */
  partialTakeT1AtSec?: number;
  /** Live T1 partial sell 진행 중 marker. Tick 중복 발화를 막는다. */
  partialTakeT1InFlight?: boolean;
  /** Live T1 partial sell 실패 cooldown marker. 실패 시 runner 는 계속 보유한다. */
  partialTakeT1LiveFailedAtSec?: number;
  partialTakeT1LiveFailureCount?: number;
  partialTakeT1LiveFailureReason?: string;
  partialTakeT1LiveTxSignature?: string;
  partialTakeT1LiveAttempts?: number;
  pendingCloseAfterPartialTake?: {
    exitPrice: number;
    reason: CloseReason;
    nowSec: number;
    mfePctAtClose: number;
    maePctAtClose: number;
  };
  /**
   * 2026-05-01 (codex F-A fix): partial take 시 lock-in 된 SOL 손익 누적.
   * close 시 runner netSol 에 합산 → appendPaperLedger / markKolClosed / DSR validator 가 보는
   * `netSol` 이 trade 전체 PnL (runner + partial) 을 정확히 반영.
   * 이전: kol-partial-takes.jsonl 별도 jsonl 만 기록 → 어떤 reader 도 join 안 함 → 부분익절 winner
   *       전부 underreport. 이제 close 시 합산 + 별도 jsonl 도 유지 (cohort 분석용).
   */
  partialTakeRealizedSol?: number;
  /**
   * 2026-05-01 (codex F-A fix): partial take 시 lock-in 된 ticket size (effectiveTicketSol 산출용).
   * runnerNetPct = runnerNetSol/runnerTicket vs totalNetPct = totalNetSol/originalTicket 구분.
   */
  partialTakeLockedTicketSol?: number;
  /** Token-only MAE/MFE telemetry for hard-cut quality analysis. */
  excursionTelemetry?: ExcursionTelemetrySnapshot;
  /** smart-v3 paper/live comparability shadow: would this signal pass live gates? */
  smartV3LiveEligibleShadow?: boolean;
  smartV3LiveBlockReason?: string | null;
  smartV3LiveBlockFlags?: string[];
  smartV3LiveEligibilityEvaluatedAtMs?: number;
  /** Paper/live gate equivalence trace id for explaining why paper entered but live did not. */
  liveEquivalenceCandidateId?: string;
  liveEquivalenceDecisionStage?: KolLiveEquivalenceDecisionStage;
  liveEquivalenceLiveWouldEnter?: boolean;
  liveEquivalenceLiveBlockReason?: string | null;
  liveEquivalenceLiveBlockFlags?: string[];
  smartV3EntryComboKey?: string | null;
  smartV3LiveHardCutReentry?: boolean;
  smartV3HardCutParentPositionId?: string;
  smartV3HardCutAtMs?: number;
  smartV3HardCutEntryPrice?: number;
  smartV3HardCutExitPrice?: number;
  smartV3HardCutDiscountPct?: number;
  smartV3MaeFastFail?: boolean;
  smartV3MaeRecoveryHold?: boolean;
  smartV3MaeRecoveryHoldAtSec?: number;
  smartV3MaeRecoveryHoldUntilSec?: number;
  smartV3MaeRecoveryHoldReason?: string;
  smartV3MfeStage?: SmartV3MfeStage;
  smartV3MfeStageUpdatedAtSec?: number;
  smartV3ProfitFloorPct?: number | null;
  smartV3ProfitFloorPrice?: number | null;
  smartV3ProfitFloorExit?: boolean;
  smartV3ProfitFloorExitAtSec?: number;
  smartV3ProfitFloorExitNetPct?: number;
  smartV3ProfitFloorExitStage?: SmartV3MfeStage;
}

interface SmartV3CopyableEdgeEstimate {
  schemaVersion: 'smart-v3-copyable-edge/v1';
  shadowOnly: true;
  pass: boolean;
  reason: 'copyable_net_positive' | 'copyable_net_non_positive' | 'invalid_ticket';
  mode: 'paper' | 'live';
  ticketSol: number;
  walletNetSol: number;
  tokenOnlyNetSol: number;
  copyableNetSol: number;
  copyableNetPct: number | null;
  actualWalletDragSol: number | null;
  estimatedDragSol: number;
  assumedAtaRentSol: number;
  assumedNetworkFeeSol: number;
  requiredGrossMovePct: number | null;
}

interface KolEntrySecurityEvidence {
  schemaVersion: 'kol-entry-security/v1';
  checkedAtMs: number;
  securityClientPresent: boolean;
  tokenSecurityKnown: boolean;
  exitLiquidityKnown: boolean;
  reason: string | null;
  flags: string[];
  tokenSecurityData: TokenSecurityData | null;
  exitLiquidityData: ExitLiquidityData | null;
}

type KolSellQuoteEvidenceSchemaVersion = 'kol-entry-sell-quote/v1' | 'kol-exit-sell-quote/v1';

interface KolEntrySellQuoteEvidence {
  schemaVersion: KolSellQuoteEvidenceSchemaVersion;
  checkedAtMs: number;
  probeEnabled: boolean;
  approved: boolean;
  routeFound: boolean | null;
  reason: string | null;
  plannedQuantityUi: number | null;
  ticketSol: number | null;
  tokenDecimals: number | null;
  observedOutSol: number | null;
  observedImpactPct: number | null;
  roundTripPct: number | null;
  quoteFailed: boolean | null;
  cacheStatus: string | null;
}

type KolExitRouteProofSkipReason =
  | 'sell_quote_probe_disabled'
  | 'invalid_quantity'
  | 'sell_quote_error'
  | 'route_found_unknown'
  | 'exit_route_proof_exception'
  | 'exit_route_proof_missing_evidence';

interface KolExitRouteProofResult {
  evidence: KolEntrySellQuoteEvidence | null;
  skipReason: KolExitRouteProofSkipReason | null;
  skipDetail: string | null;
}

interface SmartV3PendingState {
  startedAtMs: number;
  observeExpiresAtMs: number;
  kolEntryPrice: number;
  peakPrice: number;
  currentPrice: number;
  preEntryFlags: string[];
  preEntrySecurityEvidence?: KolEntrySecurityEvidence;
  tokenDecimals?: number;
  tokenDecimalsSource?: 'security_client' | 'jupiter_quote';
  resolving: boolean;
}

interface PaperEntryOptions {
  parameterVersion?: string;
  positionIdSuffix?: string;
  profileArm?: string;
  entryArm?: string;
  exitArm?: string;
  canaryLane?: EntryLane;
  entryReason?: KolEntryReason;
  convictionLevel?: KolConvictionLevel;
  tokenDecimals?: number;
  tokenDecimalsSource?: 'security_client' | 'jupiter_quote';
  entrySecurityEvidence?: KolEntrySecurityEvidence;
  skipPolicyEntry?: boolean;
  rotationTelemetry?: RotationV1TriggerResult['telemetry'];
  rotationAnchorKols?: string[];
  rotationAnchorPrice?: number;
  rotationAnchorPriceSource?: string;
  rotationFirstBuyAtMs?: number;
  rotationLastBuyAtMs?: number;
  rotationLastBuyAgeMs?: number;
  rotationScore?: number;
  underfillReferenceSolAmount?: number;
  underfillReferenceTokenAmount?: number;
  rotationFlowExitEnabled?: boolean;
  executionGuardReason?: string | null;
  executionGuardAction?: 'pretrade_reject' | 'telemetry_only' | 'forced_exit' | null;
  entryIndependentKolCount?: number;
  entryKolScore?: number;
  entryParticipatingKols?: KolDiscoveryScore['participatingKols'];
  smartV3LiveEligibleShadow?: boolean;
  smartV3LiveBlockReason?: string | null;
  smartV3LiveBlockFlags?: string[];
  smartV3LiveEligibilityEvaluatedAtMs?: number;
  liveEquivalenceCandidateId?: string;
  liveEquivalenceDecisionStage?: KolLiveEquivalenceDecisionStage;
  liveEquivalenceLiveWouldEnter?: boolean;
  liveEquivalenceLiveBlockReason?: string | null;
  liveEquivalenceLiveBlockFlags?: string[];
  smartV3EntryComboKey?: string | null;
  smartV3LiveHardCutReentry?: boolean;
  smartV3HardCutParentPositionId?: string;
  smartV3HardCutAtMs?: number;
  smartV3HardCutEntryPrice?: number;
  smartV3HardCutExitPrice?: number;
  smartV3HardCutDiscountPct?: number;
  capitulationTelemetry?: CapitulationReboundTelemetry;
  capitulationEntryLowPrice?: number;
  capitulationEntryLowAtMs?: number;
  capitulationRecoveryConfirmations?: number;
}

interface DynamicExitParams {
  t1Mfe?: number;
  t1TrailPct?: number;
  t1ProfitFloorMult?: number;
  probeFlatTimeoutSec?: number;
  probeHardCutPct?: number;
  rotationDoaWindowSec?: number;
  rotationDoaMinMfePct?: number;
  rotationDoaMaxMaePct?: number;
}

interface PendingCandidate {
  tokenMint: string;
  firstKolEntryMs: number;
  stalkExpiresAtMs: number;
  timer: NodeJS.Timeout;
  kolTxs: KolTx[];
  smartV3?: SmartV3PendingState;
  rotationV1?: {
    anchorPrice?: number;
    enteredAtMs?: number;
    underfillEnteredAtMs?: number;
    chaseTopupEnteredAtMs?: number;
    noTradeReasonsEmitted: Set<string>;
    underfillNoTradeReasonsEmitted?: Set<string>;
    chaseTopupNoTradeReasonsEmitted?: Set<string>;
  };
  capitulation?: {
    lowPrice?: number;
    lowAtMs?: number;
    recoveryConfirmations: number;
    lastRecoveryAtMs?: number;
    lastRecoveryPrice?: number;
    enteredAtMs?: number;
    rrEnteredAtMs?: number;
    noTradeReasonsEmitted: Set<string>;
    rrNoTradeReasonsEmitted?: Set<string>;
  };
}

// ─── Module State ────────────────────────────────────────

const pending = new Map<string, PendingCandidate>();        // tokenMint → pending
const active = new Map<string, PaperPosition>();            // positionId → position
const SMART_V3_ADMISSION_TIMEOUT_MS = 30_000;

/**
 * 2026-04-29 (Track 1): Same-token re-entry cooldown.
 * Why: GUfyGEF6 incident — 같은 token 에 4회 진입 (paper 3 + live 1) 모두 손실. 5 mints / 12 big losses
 *   누적 −0.033 SOL. 시뮬 +13% improvement. 5x winner 는 대부분 single-entry 라 보호.
 * State: tokenMint → 마지막 close 시각 (epoch ms). cooldown 안에 재진입 차단.
 * Pruning: 4 × cooldown 보다 오래된 entry 자동 정리 (메모리 leak 방지).
 */
const recentClosedTokens = new Map<string, number>();
function markTokenClosed(tokenMint: string): void {
  const cooldownMs = config.kolHunterReentryCooldownMs;
  if (cooldownMs <= 0) return;  // disabled — stamp 의미 없음 (memory leak 방지)
  const nowMs = Date.now();
  recentClosedTokens.set(tokenMint, nowMs);
  // Lazy prune — 100 entry 마다 cooldown 4배 이상 된 것 정리
  if (recentClosedTokens.size > 100) {
    const pruneBeforeMs = nowMs - cooldownMs * 4;
    for (const [mint, ts] of recentClosedTokens) {
      if (ts < pruneBeforeMs) recentClosedTokens.delete(mint);
    }
  }
}
function isInReentryCooldown(tokenMint: string): { blocked: boolean; remainingMs: number } {
  const lastClosedMs = recentClosedTokens.get(tokenMint);
  if (lastClosedMs == null) return { blocked: false, remainingMs: 0 };
  const cooldownMs = config.kolHunterReentryCooldownMs;
  if (cooldownMs <= 0) return { blocked: false, remainingMs: 0 };  // disabled
  const elapsedMs = Date.now() - lastClosedMs;
  if (elapsedMs >= cooldownMs) return { blocked: false, remainingMs: 0 };
  return { blocked: true, remainingMs: cooldownMs - elapsedMs };
}
/** 테스트용 reset. */
export function resetReentryCooldownForTests(): void {
  recentClosedTokens.clear();
  smartV3LiveHardCutReentryByMint.clear();
}

const smartV3SellCancelByMint = new Map<string, number>();

const SMART_V3_LIVE_HARD_CUT_REENTRY_WINDOW_MS = 10 * 60 * 1000;
const SMART_V3_LIVE_HARD_CUT_REENTRY_MAX_ATTEMPTS = 1;
const SMART_V3_LIVE_HARD_CUT_REENTRY_MIN_RECOVERY_PCT = 0.01;

interface SmartV3LiveHardCutReentryState {
  tokenMint: string;
  parentPositionId: string;
  closedAtMs: number;
  expiresAtMs: number;
  parentEntryTimeMs: number;
  parentEntryPrice: number;
  hardCutPrice: number;
  participatingKolIds: string[];
  attempts: number;
  attempting: boolean;
}

interface SmartV3LiveHardCutReentryDecision {
  allowed: boolean;
  state?: SmartV3LiveHardCutReentryState;
  discountPct?: number;
  recoveredFromCutPct?: number;
  reason?: string;
}

const smartV3LiveHardCutReentryByMint = new Map<string, SmartV3LiveHardCutReentryState>();

function clearSmartV3LiveHardCutReentry(tokenMint: string): void {
  smartV3LiveHardCutReentryByMint.delete(tokenMint);
}

function hasParticipatingKolSellSince(tokenMint: string, kolIds: string[], sinceMs: number): boolean {
  const normalized = new Set(kolIds.map((id) => id.toLowerCase()));
  if (normalized.size === 0) return false;
  return recentKolTxs.some((tx) =>
    tx.tokenMint === tokenMint &&
    tx.action === 'sell' &&
    tx.timestamp >= sinceMs &&
    normalized.has(tx.kolId.toLowerCase())
  );
}

function hasParticipatingKolBuyAfter(tokenMint: string, kolIds: string[], afterMs: number, sinceMs: number): boolean {
  const normalized = new Set(kolIds.map((id) => id.toLowerCase()));
  if (normalized.size === 0) return false;
  return recentKolTxs.some((tx) =>
    tx.tokenMint === tokenMint &&
    tx.action === 'buy' &&
    tx.timestamp > afterMs &&
    tx.timestamp >= sinceMs &&
    normalized.has(tx.kolId.toLowerCase())
  );
}

function maybeRegisterSmartV3LiveHardCutReentry(
  pos: PaperPosition,
  hardCutPrice: number,
  reason: CloseReason,
  nowMs = Date.now()
): void {
  if (reason !== 'probe_hard_cut') return;
  if (pos.isLive !== true || pos.isShadowArm || !isSmartV3Position(pos)) return;
  const parentEntryPrice = pos.entryPriceTokenOnly && pos.entryPriceTokenOnly > 0
    ? pos.entryPriceTokenOnly
    : pos.entryPrice;
  if (!Number.isFinite(parentEntryPrice) || parentEntryPrice <= 0) return;
  if (!Number.isFinite(hardCutPrice) || hardCutPrice <= 0) return;
  const participatingKolIds = pos.participatingKols.map((kol) => kol.id).filter(Boolean);
  if (participatingKolIds.length === 0) return;
  if (hasParticipatingKolSellSince(pos.tokenMint, participatingKolIds, pos.entryTimeSec * 1000)) {
    clearSmartV3LiveHardCutReentry(pos.tokenMint);
    return;
  }
  if (recentSmartV3SellCancelAt(pos.tokenMint, nowMs) != null) {
    clearSmartV3LiveHardCutReentry(pos.tokenMint);
    return;
  }
  const state: SmartV3LiveHardCutReentryState = {
    tokenMint: pos.tokenMint,
    parentPositionId: pos.positionId,
    closedAtMs: nowMs,
    expiresAtMs: nowMs + SMART_V3_LIVE_HARD_CUT_REENTRY_WINDOW_MS,
    parentEntryTimeMs: pos.entryTimeSec * 1000,
    parentEntryPrice,
    hardCutPrice,
    participatingKolIds,
    attempts: 0,
    attempting: false,
  };
  smartV3LiveHardCutReentryByMint.set(pos.tokenMint, state);
  log.info(
    `[KOL_HUNTER_SMART_V3_HARDCUT_REENTRY_ARMED] ${pos.tokenMint.slice(0, 8)} ` +
    `parent=${pos.positionId} entry=${parentEntryPrice.toFixed(8)} cut=${hardCutPrice.toFixed(8)} ` +
    `expires=${Math.round(SMART_V3_LIVE_HARD_CUT_REENTRY_WINDOW_MS / 1000)}s`
  );
}

function evaluateSmartV3LiveHardCutReentry(
  tokenMint: string,
  currentPrice: number,
  nowMs = Date.now()
): SmartV3LiveHardCutReentryDecision {
  const state = smartV3LiveHardCutReentryByMint.get(tokenMint);
  if (!state) return { allowed: false, reason: 'not_armed' };
  if (nowMs > state.expiresAtMs) {
    clearSmartV3LiveHardCutReentry(tokenMint);
    return { allowed: false, reason: 'expired' };
  }
  if (state.attempts >= SMART_V3_LIVE_HARD_CUT_REENTRY_MAX_ATTEMPTS) {
    clearSmartV3LiveHardCutReentry(tokenMint);
    return { allowed: false, reason: 'attempt_exhausted' };
  }
  if (state.attempting) {
    return { allowed: false, state, reason: 'attempt_inflight' };
  }
  if (hasParticipatingKolSellSince(tokenMint, state.participatingKolIds, state.parentEntryTimeMs)) {
    clearSmartV3LiveHardCutReentry(tokenMint);
    return { allowed: false, reason: 'participating_kol_sold' };
  }
  if (recentSmartV3SellCancelAt(tokenMint, nowMs) != null) {
    clearSmartV3LiveHardCutReentry(tokenMint);
    return { allowed: false, reason: 'sell_cancel_quarantine' };
  }
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { allowed: false, state, reason: 'invalid_price' };
  }
  const discountPct = currentPrice / state.parentEntryPrice - 1;
  if (discountPct > 0) {
    return { allowed: false, state, discountPct, reason: 'not_discounted' };
  }
  const recoveredFromCutPct = currentPrice / state.hardCutPrice - 1;
  if (recoveredFromCutPct < SMART_V3_LIVE_HARD_CUT_REENTRY_MIN_RECOVERY_PCT) {
    return { allowed: false, state, discountPct, recoveredFromCutPct, reason: 'no_recovery_confirm' };
  }
  return { allowed: true, state, discountPct, recoveredFromCutPct };
}

function beginSmartV3LiveHardCutReentryAttempt(tokenMint: string, parentPositionId?: string): boolean {
  const state = smartV3LiveHardCutReentryByMint.get(tokenMint);
  if (!state) return false;
  if (parentPositionId && state.parentPositionId !== parentPositionId) return false;
  if (state.attempting || state.attempts >= SMART_V3_LIVE_HARD_CUT_REENTRY_MAX_ATTEMPTS) return false;
  state.attempting = true;
  return true;
}

function releaseSmartV3LiveHardCutReentryAttempt(tokenMint: string, parentPositionId?: string): void {
  const state = smartV3LiveHardCutReentryByMint.get(tokenMint);
  if (!state) return;
  if (parentPositionId && state.parentPositionId !== parentPositionId) return;
  state.attempting = false;
}

function completeSmartV3LiveHardCutReentryAttempt(tokenMint: string, parentPositionId?: string): void {
  const state = smartV3LiveHardCutReentryByMint.get(tokenMint);
  if (!state) return;
  if (parentPositionId && state.parentPositionId !== parentPositionId) return;
  state.attempts += 1;
  state.attempting = false;
  clearSmartV3LiveHardCutReentry(tokenMint);
}

function invalidateSmartV3LiveHardCutReentryOnSell(tx: KolTx): void {
  const state = smartV3LiveHardCutReentryByMint.get(tx.tokenMint);
  if (!state) return;
  const soldByParticipant = state.participatingKolIds
    .some((id) => id.toLowerCase() === tx.kolId.toLowerCase());
  if (!soldByParticipant) return;
  clearSmartV3LiveHardCutReentry(tx.tokenMint);
  log.info(
    `[KOL_HUNTER_SMART_V3_HARDCUT_REENTRY_CANCEL] ${tx.tokenMint.slice(0, 8)} ` +
    `kol=${tx.kolId} sell after hardcut`
  );
}

function markSmartV3SellCancel(tokenMint: string, nowMs = Date.now()): void {
  clearSmartV3LiveHardCutReentry(tokenMint);
  smartV3SellCancelByMint.set(tokenMint, nowMs);
  if (smartV3SellCancelByMint.size <= 1000) return;
  const pruneBeforeMs = nowMs - config.kolHunterPostDistributionCancelQuarantineSec * 1000 * 4;
  for (const [mint, ts] of smartV3SellCancelByMint) {
    if (ts < pruneBeforeMs) smartV3SellCancelByMint.delete(mint);
  }
}

function recentSmartV3SellCancelAt(tokenMint: string, nowMs = Date.now()): number | null {
  const ts = smartV3SellCancelByMint.get(tokenMint);
  if (ts == null) return null;
  const quarantineMs = config.kolHunterPostDistributionCancelQuarantineSec * 1000;
  if (quarantineMs <= 0 || nowMs - ts > quarantineMs) return null;
  return ts;
}

interface LiveExecutionQualityCooldown {
  untilMs: number;
  reason: string;
}
interface LiveExecutionQualityBuyRecord {
  strategy?: string;
  pairAddress?: string;
  tokenMint?: string;
  recordedAt?: string;
  signalTimeSec?: number;
  buyExecutionMs?: number;
  plannedEntryPrice?: number;
  actualEntryPrice?: number;
  partialFillDataMissing?: boolean;
  partialFillDataReason?: string;
}
export interface LiveExecutionQualityHydrationSummary {
  loaded: number;
  hydrated: number;
  skippedExpired: number;
}
export interface RotationLiveKolDecayHydrationSummary {
  loaded: number;
  hydrated: number;
  skippedExpired: number;
}
const liveExecutionQualityCooldowns = new Map<string, LiveExecutionQualityCooldown>();

function pruneLiveExecutionQualityCooldowns(nowMs: number): void {
  if (liveExecutionQualityCooldowns.size <= 100) return;
  for (const [mint, state] of liveExecutionQualityCooldowns) {
    if (state.untilMs <= nowMs) liveExecutionQualityCooldowns.delete(mint);
  }
}

function markLiveExecutionQualityCooldown(tokenMint: string, reason: string): void {
  if (!config.kolHunterLiveExecutionQualityCooldownEnabled) return;
  const cooldownMs = config.kolHunterLiveExecutionQualityCooldownMs;
  if (cooldownMs <= 0) return;
  const nowMs = Date.now();
  const untilMs = nowMs + cooldownMs;
  setLiveExecutionQualityCooldown(tokenMint, untilMs, reason);
  pruneLiveExecutionQualityCooldowns(nowMs);
  log.warn(
    `[KOL_HUNTER_LIVE_QUALITY_COOLDOWN_SET] ${tokenMint.slice(0, 8)} ` +
    `reason=${reason} cooldown=${Math.round(cooldownMs / 1000)}s`
  );
}

function setLiveExecutionQualityCooldown(tokenMint: string, untilMs: number, reason: string): void {
  const current = liveExecutionQualityCooldowns.get(tokenMint);
  if (current && current.untilMs > untilMs) return;
  liveExecutionQualityCooldowns.set(tokenMint, { untilMs, reason });
}

function isInLiveExecutionQualityCooldown(
  tokenMint: string
): { blocked: boolean; remainingMs: number; reason?: string } {
  if (!config.kolHunterLiveExecutionQualityCooldownEnabled) return { blocked: false, remainingMs: 0 };
  const state = liveExecutionQualityCooldowns.get(tokenMint);
  if (!state) return { blocked: false, remainingMs: 0 };
  const nowMs = Date.now();
  if (state.untilMs <= nowMs) {
    liveExecutionQualityCooldowns.delete(tokenMint);
    return { blocked: false, remainingMs: 0 };
  }
  return { blocked: true, remainingMs: state.untilMs - nowMs, reason: state.reason };
}

function parseJsonlRows<T>(raw: string): T[] {
  const rows: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // 한 줄 오염이 startup hydrate 전체를 막지 않게 한다.
    }
  }
  return rows;
}

async function readJsonlRowsMaybe<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return parseJsonlRows<T>(raw);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== 'ENOENT') {
      log.warn(`[KOL_HUNTER] jsonl read failed ${path.basename(filePath)}: ${err}`);
    }
    return [];
  }
}

function liveExecutionQualityReasonFromBuyRecord(record: LiveExecutionQualityBuyRecord): string | null {
  const reasons: string[] = [];
  if (record.partialFillDataMissing === true) {
    reasons.push(record.partialFillDataReason ?? 'partial_fill_data_missing');
  }
  const entryAdvantageReason = liveExecutionQualityEntryAdvantageReason(
    record.plannedEntryPrice,
    record.actualEntryPrice
  );
  if (entryAdvantageReason) reasons.push(entryAdvantageReason);
  if (
    config.kolHunterLiveExecutionQualityMaxBuyLagMs > 0 &&
    (
      (typeof record.buyExecutionMs === 'number' && Number.isFinite(record.buyExecutionMs)) ||
      (typeof record.signalTimeSec === 'number' && !!record.recordedAt)
    )
  ) {
    const explicitBuyExecutionMs =
      typeof record.buyExecutionMs === 'number' && Number.isFinite(record.buyExecutionMs)
        ? record.buyExecutionMs
        : null;
    let buyLagMs = explicitBuyExecutionMs;
    if (buyLagMs == null && typeof record.signalTimeSec === 'number' && record.recordedAt) {
      const recordedMs = new Date(record.recordedAt).getTime();
      if (Number.isFinite(recordedMs)) buyLagMs = recordedMs - record.signalTimeSec * 1000;
    }
    if (buyLagMs != null && buyLagMs >= config.kolHunterLiveExecutionQualityMaxBuyLagMs) {
      reasons.push(`${explicitBuyExecutionMs == null ? 'buy_lag_ms' : 'buy_execution_ms'}=${buyLagMs}`);
    }
  }
  return reasons.length > 0 ? reasons.join('+') : null;
}

function liveExecutionQualityEntryAdvantageReason(
  plannedEntryPrice?: number,
  actualEntryPrice?: number
): string | null {
  const threshold = config.kolHunterLiveExecutionQualityMaxEntryAdvantageAbsPct;
  if (threshold <= 0) return null;
  if (
    typeof plannedEntryPrice !== 'number' ||
    typeof actualEntryPrice !== 'number' ||
    !Number.isFinite(plannedEntryPrice) ||
    !Number.isFinite(actualEntryPrice) ||
    plannedEntryPrice <= 0 ||
    actualEntryPrice <= 0
  ) {
    return null;
  }
  const entryAdvantagePct = actualEntryPrice / plannedEntryPrice - 1;
  if (Math.abs(entryAdvantagePct) < threshold) return null;
  return `entry_advantage_pct=${entryAdvantagePct.toFixed(6)}`;
}

function rotationUnderfillReferencePriceFromOptions(options: PaperEntryOptions): number | null {
  return rotationUnderfillReferencePriceFromTelemetry({
    underfillReferenceSolAmount:
      options.underfillReferenceSolAmount ?? options.rotationTelemetry?.underfillReferenceSolAmount,
    underfillReferenceTokenAmount:
      options.underfillReferenceTokenAmount ?? options.rotationTelemetry?.underfillReferenceTokenAmount,
  } as RotationV1TriggerResult['telemetry']);
}

function rotationUnderfillLivePretradeGuard(
  referencePrice: number,
  options: PaperEntryOptions
): { reason: string; discountPct: number | null; referencePrice: number | null } | null {
  if (options.parameterVersion !== config.kolHunterRotationUnderfillParameterVersion) return null;
  const underfillReferencePrice = rotationUnderfillReferencePriceFromOptions(options);
  if (underfillReferencePrice == null || underfillReferencePrice <= 0) {
    return {
      reason: 'rotation_underfill_live_missing_reference',
      discountPct: null,
      referencePrice: null,
    };
  }
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return {
      reason: 'rotation_underfill_live_invalid_reference_price',
      discountPct: null,
      referencePrice: underfillReferencePrice,
    };
  }
  const discountPct = 1 - referencePrice / underfillReferencePrice;
  if (discountPct < config.kolHunterRotationUnderfillMinDiscountPct) {
    return {
      reason: `rotation_underfill_pretrade_discount_pct=${discountPct.toFixed(4)}`,
      discountPct,
      referencePrice: underfillReferencePrice,
    };
  }
  if (discountPct > config.kolHunterRotationUnderfillMaxDiscountPct) {
    return {
      reason: `rotation_underfill_pretrade_discount_too_deep_pct=${discountPct.toFixed(4)}`,
      discountPct,
      referencePrice: underfillReferencePrice,
    };
  }
  return null;
}

export function hydrateLiveExecutionQualityCooldownsFromBuyRecords(
  records: LiveExecutionQualityBuyRecord[],
  nowMs = Date.now()
): LiveExecutionQualityHydrationSummary {
  if (!config.kolHunterLiveExecutionQualityCooldownEnabled) {
    return { loaded: records.length, hydrated: 0, skippedExpired: 0 };
  }
  const cooldownMs = config.kolHunterLiveExecutionQualityCooldownMs;
  if (cooldownMs <= 0) return { loaded: records.length, hydrated: 0, skippedExpired: 0 };

  let hydrated = 0;
  let skippedExpired = 0;
  for (const record of records) {
    if (record.strategy && record.strategy !== LANE_STRATEGY) continue;
    const tokenMint = record.pairAddress ?? record.tokenMint;
    if (!tokenMint) continue;
    const reason = liveExecutionQualityReasonFromBuyRecord(record);
    if (!reason) continue;
    const eventMs = record.recordedAt ? new Date(record.recordedAt).getTime() : NaN;
    const fallbackEventMs = typeof record.signalTimeSec === 'number' ? record.signalTimeSec * 1000 : NaN;
    const baseMs = Number.isFinite(eventMs) ? eventMs : fallbackEventMs;
    if (!Number.isFinite(baseMs)) continue;
    const untilMs = baseMs + cooldownMs;
    if (untilMs <= nowMs) {
      skippedExpired += 1;
      continue;
    }
    setLiveExecutionQualityCooldown(tokenMint, untilMs, reason);
    hydrated += 1;
  }
  pruneLiveExecutionQualityCooldowns(nowMs);
  return { loaded: records.length, hydrated, skippedExpired };
}

export async function hydrateLiveExecutionQualityCooldownsFromLedger(
  ledgerDir = config.realtimeDataDir
): Promise<LiveExecutionQualityHydrationSummary> {
  try {
    const raw = await readFile(path.join(ledgerDir, 'executed-buys.jsonl'), 'utf8');
    const rows = parseJsonlRows<LiveExecutionQualityBuyRecord>(raw);
    const summary = hydrateLiveExecutionQualityCooldownsFromBuyRecords(rows);
    if (summary.hydrated > 0) {
      log.warn(
        `[KOL_HUNTER_LIVE_QUALITY_COOLDOWN_HYDRATE] ` +
        `loaded=${summary.loaded} hydrated=${summary.hydrated} expired=${summary.skippedExpired}`
      );
    }
    return summary;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== 'ENOENT') {
      log.warn(`[KOL_HUNTER_LIVE_QUALITY_COOLDOWN_HYDRATE] failed: ${err}`);
    }
    return { loaded: 0, hydrated: 0, skippedExpired: 0 };
  }
}

function uniqSortedSeconds(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
}

function rotationV1MarkoutOffsetsSec(): number[] {
  return uniqSortedSeconds(config.kolHunterRotationV1MarkoutOffsetsSec ?? [15, 30, 60]);
}

function capitulationReboundMarkoutOffsetsSec(): number[] {
  return uniqSortedSeconds(config.kolHunterCapitulationReboundMarkoutOffsetsSec ?? [15, 30, 60, 180, 300, 1800]);
}

function isRotationFamilyMarkoutPosition(
  pos?: { parameterVersion?: string | null; kolEntryReason?: string | null; armName?: string | null }
): boolean {
  if (!pos) return false;
  if (pos.parameterVersion === config.kolHunterRotationV1ParameterVersion) return true;
  if (pos.kolEntryReason === 'rotation_v1') return true;
  if (pos.armName?.startsWith('rotation_')) return true;
  if (pos.armName === 'kol_hunter_rotation_v1') return true;
  return pos.parameterVersion?.startsWith('rotation-') === true;
}

function isCapitulationReboundPosition(
  pos?: Pick<PaperPosition, 'parameterVersion' | 'kolEntryReason' | 'armName'>
): boolean {
  if (!pos) return false;
  if (isCapitulationParameterVersion(pos.parameterVersion)) return true;
  if (pos.kolEntryReason === 'capitulation_rebound') return true;
  if (pos.armName === CAPITULATION_REBOUND_ARM || pos.armName === CAPITULATION_REBOUND_RR_ARM) return true;
  return pos.parameterVersion?.startsWith('capitulation-rebound-') === true;
}

function isCapitulationParameterVersion(parameterVersion?: string): boolean {
  return parameterVersion === config.kolHunterCapitulationReboundParameterVersion ||
    parameterVersion === config.kolHunterCapitulationReboundRrParameterVersion ||
    parameterVersion?.startsWith('capitulation-rebound-') === true;
}

function tradeMarkoutOffsetsSecForPosition(
  pos?: Pick<PaperPosition, 'parameterVersion' | 'kolEntryReason' | 'armName'>
): number[] {
  const base = config.tradeMarkoutObserverOffsetsSec ?? [30, 60, 300, 1800];
  if (isCapitulationReboundPosition(pos)) {
    return uniqSortedSeconds([...base, ...capitulationReboundMarkoutOffsetsSec()]);
  }
  if (!isRotationFamilyMarkoutPosition(pos)) {
    return uniqSortedSeconds(base);
  }
  return uniqSortedSeconds([...base, ...rotationV1MarkoutOffsetsSec()]);
}

function buildTradeMarkoutObserverConfig(
  pos?: Pick<PaperPosition, 'parameterVersion' | 'kolEntryReason' | 'armName'>
) {
  return buildTradeMarkoutConfigFromGlobal({
    realtimeDataDir: config.realtimeDataDir,
    enabled: config.tradeMarkoutObserverEnabled,
    offsetsSec: tradeMarkoutOffsetsSecForPosition(pos),
    jitterPct: config.tradeMarkoutObserverJitterPct,
    maxInflight: config.tradeMarkoutObserverMaxInflight,
    dedupWindowSec: config.tradeMarkoutObserverDedupWindowSec,
    jupiterApiUrl: config.jupiterApiUrl,
    jupiterApiKey: config.jupiterApiKey,
  });
}

function trackPaperPositionMarkout(
  pos: PaperPosition,
  anchorType: 'buy' | 'sell',
  anchorPrice: number,
  probeSolAmount: number,
  anchorAtMs: number,
  extras: Record<string, unknown> = {}
): void {
  trackTradeMarkout(
    {
      anchorType,
      positionId: pos.positionId,
      tokenMint: pos.tokenMint,
      anchorTxSignature: null,
      anchorAtMs,
      anchorPrice,
      anchorPriceKind: anchorType === 'buy' ? 'entry_token_only' : 'exit_token_only',
      probeSolAmount,
      tokenDecimals: pos.tokenDecimals,
      signalSource: pos.armName,
      extras: {
        mode: pos.isLive === true ? 'live' : 'paper',
        armName: pos.armName,
        profileArm: pos.profileArm ?? null,
        entryArm: pos.entryArm ?? pos.armName,
        exitArm: pos.exitArm ?? pos.armName,
        canaryLane: pos.canaryLane ?? null,
        parameterVersion: pos.parameterVersion,
        isShadowArm: pos.isShadowArm,
        isShadowKol: pos.isShadowKol ?? false,
        isTailPosition: pos.isTailPosition ?? false,
        parentPositionId: pos.parentPositionId ?? null,
        entryReason: pos.kolEntryReason,
        convictionLevel: pos.kolConvictionLevel,
        kolScore: pos.kolScore,
        independentKolCount: pos.independentKolCount,
        rotationAnchorKols: pos.rotationAnchorKols ?? null,
        rotationEntryAtMs: pos.rotationEntryAtMs ?? null,
        rotationAnchorPrice: pos.rotationAnchorPrice ?? null,
        rotationAnchorPriceSource: pos.rotationAnchorPriceSource ?? null,
        rotationFirstBuyAtMs: pos.rotationFirstBuyAtMs ?? null,
        rotationLastBuyAtMs: pos.rotationLastBuyAtMs ?? null,
        rotationLastBuyAgeMs: pos.rotationLastBuyAgeMs ?? null,
        rotationScore: pos.rotationScore ?? null,
        underfillReferenceSolAmount: pos.underfillReferenceSolAmount ?? null,
        underfillReferenceTokenAmount: pos.underfillReferenceTokenAmount ?? null,
        rotationFlowExitEnabled: pos.rotationFlowExitEnabled ?? false,
        rotationFlowMetrics: pos.rotationFlowMetrics ?? null,
        rotationFlowDecision: pos.rotationFlowDecision ?? null,
        rotationFlowReducedAtSec: pos.rotationFlowReducedAtSec ?? null,
        rotationFlowResidualUntilSec: pos.rotationFlowResidualUntilSec ?? null,
        rotationFlowLastReducePct: pos.rotationFlowLastReducePct ?? null,
        rotationMonetizableEdge: pos.rotationMonetizableEdge ?? null,
        entrySecurityEvidence: pos.entrySecurityEvidence ?? null,
        entrySellQuoteEvidence: pos.entrySellQuoteEvidence ?? null,
        tokenSecurityKnown: pos.entrySecurityEvidence?.tokenSecurityKnown ?? null,
        securityClientPresent: pos.entrySecurityEvidence?.securityClientPresent ?? null,
        sellRouteKnown: pos.entrySellQuoteEvidence?.routeFound === true ? true : null,
        routeFound: pos.entrySellQuoteEvidence?.routeFound ?? null,
        exitLiquidityKnown: pos.entrySecurityEvidence?.exitLiquidityKnown ?? null,
        exitLiquidityData: pos.entrySecurityEvidence?.exitLiquidityData ?? null,
        smartV3LiveEligibleShadow: pos.smartV3LiveEligibleShadow ?? null,
        smartV3LiveBlockReason: pos.smartV3LiveBlockReason ?? null,
        smartV3LiveBlockFlags: pos.smartV3LiveBlockFlags ?? null,
        smartV3LiveEligibilityEvaluatedAtMs: pos.smartV3LiveEligibilityEvaluatedAtMs ?? null,
        ...extras,
        rotationMaeFastFail: extras.exitReason === 'rotation_mae_fast_fail',
      },
    },
    buildTradeMarkoutObserverConfig(pos)
  );
}

export async function hydrateTradeMarkoutsFromLedger(
  ledgerDir = config.realtimeDataDir
) {
  if (!config.tradeMarkoutObserverHydrateOnStart) {
    return {
      loadedBuys: 0,
      loadedSells: 0,
      loadedAnchorRecords: 0,
      loadedPaperCloses: 0,
      loadedPartialTakes: 0,
      existingMarkouts: 0,
      scheduled: 0,
      skippedExisting: 0,
      skippedExpired: 0,
    };
  }
  const summary = await hydrateTradeMarkoutSchedulesFromLedger({
    realtimeDir: ledgerDir,
    config: buildTradeMarkoutObserverConfig(),
    lookbackHours: config.tradeMarkoutObserverHydrateLookbackHours,
  });
  if (summary.scheduled > 0) {
    log.info(
      `[KOL_HUNTER_TRADE_MARKOUT_HYDRATE] ` +
      `buys=${summary.loadedBuys} sells=${summary.loadedSells} ` +
      `anchors=${summary.loadedAnchorRecords} ` +
      `paper=${summary.loadedPaperCloses} partial=${summary.loadedPartialTakes} ` +
      `existing=${summary.existingMarkouts} scheduled=${summary.scheduled} ` +
      `expired=${summary.skippedExpired}`
    );
  }
  return summary;
}

/** 테스트용 reset. */
export function resetLiveExecutionQualityCooldownForTests(): void {
  liveExecutionQualityCooldowns.clear();
}

// 2026-04-29 (P0-2 손실 방어 layer 0): KOL alpha decay cooldown.
// 격언 "Cut losses short" 의 KOL-level 확장. 직전 N close 가 손실 streak 인 KOL 이 trigger 한
// entry 를 차단 — 8JH1J6p4 incident 같은 cascade 직전 패턴 (KOL 4명 dump 직전) 의 코드화.
//
// State: kolId → recent N close pnl (ring buffer, in-memory).
// 매 close 시 push (live + paper). startup empty.
// 정확히는 "최근 close 의 cumulative pnl < 0 AND consec losing >= threshold" → cooldownMs 차단.
//
// Track 1 (same-token cooldown) 과 직교 — 둘 다 entry path 에서 검사.
interface KolCloseRecord { closedAtMs: number; pnlSol: number; isWin: boolean; }
const recentKolCloses = new Map<string, KolCloseRecord[]>();
const KOL_DECAY_RING_SIZE = 5;  // 최근 N close 추적

function markKolClosed(kolIds: string[], pnlSol: number): void {
  if (!config.kolHunterKolDecayCooldownEnabled) return;
  const nowMs = Date.now();
  const isWin = pnlSol > 0;
  for (const kolId of kolIds) {
    const buf = recentKolCloses.get(kolId) ?? [];
    buf.push({ closedAtMs: nowMs, pnlSol, isWin });
    while (buf.length > KOL_DECAY_RING_SIZE) buf.shift();
    recentKolCloses.set(kolId, buf);
  }
  // Lazy prune (잘 활동 안 하는 KOL 의 stale buffer 정리)
  if (recentKolCloses.size > 200) {
    const cutoff = nowMs - 24 * 60 * 60 * 1000;  // 24h 이상 된 entry 의 last record 면 drop
    for (const [id, recs] of recentKolCloses) {
      const last = recs[recs.length - 1];
      if (last && last.closedAtMs < cutoff) recentKolCloses.delete(id);
    }
  }
}

function isKolInDecay(kolId: string): { decayed: boolean; reason?: string } {
  if (!config.kolHunterKolDecayCooldownEnabled) return { decayed: false };
  const buf = recentKolCloses.get(kolId);
  if (!buf || buf.length < config.kolHunterKolDecayMinCloses) return { decayed: false };
  const cooldownMs = config.kolHunterKolDecayCooldownMs;
  if (cooldownMs <= 0) return { decayed: false };
  const recent = buf.slice(-config.kolHunterKolDecayMinCloses);
  const cumPnl = recent.reduce((s, r) => s + r.pnlSol, 0);
  const losses = recent.filter((r) => !r.isWin).length;
  const lossRatio = losses / recent.length;
  // 결정 로직: 직전 N close 의 cumulative pnl 음수 AND 손실 비율 ≥ threshold AND 최근 close 가 cooldown 안
  if (cumPnl >= 0) return { decayed: false };
  if (lossRatio < config.kolHunterKolDecayLossRatioThreshold) return { decayed: false };
  const lastCloseMs = recent[recent.length - 1].closedAtMs;
  const elapsedMs = Date.now() - lastCloseMs;
  if (elapsedMs >= cooldownMs) return { decayed: false };
  return {
    decayed: true,
    reason: `kol=${kolId} recent ${recent.length} cum=${cumPnl.toFixed(4)} losses=${losses}/${recent.length} cooldown=${Math.round((cooldownMs - elapsedMs) / 60000)}min`,
  };
}

/** entry 시 participating KOL 중 alpha decay 인 KOL 발견 시 차단. */
function checkKolAlphaDecay(kolIds: string[]): { blocked: boolean; reason?: string } {
  for (const kolId of kolIds) {
    const r = isKolInDecay(kolId);
    if (r.decayed) return { blocked: true, reason: r.reason };
  }
  return { blocked: false };
}

const recentRotationLiveKolCloses = new Map<string, KolCloseRecord[]>();
const ROTATION_LIVE_KOL_DECAY_RING_SIZE = 5;

interface RotationLiveKolDecayCloseRecord {
  positionId?: string;
  isLive?: boolean;
  parentPositionId?: string | null;
  isTailPosition?: boolean;
  armName?: string | null;
  profileArm?: string | null;
  entryArm?: string | null;
  parameterVersion?: string | null;
  entryReason?: string | null;
  kolEntryReason?: string | null;
  netSol?: number | null;
  closedAt?: string | null;
  exitTimeSec?: number | null;
  kols?: Array<{ id?: string | null }>;
  extras?: {
    parentPositionId?: string | null;
    isTailPosition?: boolean;
    armName?: string | null;
    profileArm?: string | null;
    entryArm?: string | null;
    parameterVersion?: string | null;
    entryReason?: string | null;
    rotationAnchorKols?: string[];
    participatingKols?: Array<{ id?: string | null }>;
  };
}

function pushRotationLiveKolClose(kolIds: string[], pnlSol: number, closedAtMs: number): number {
  if (!Number.isFinite(pnlSol) || !Number.isFinite(closedAtMs)) return 0;
  const isWin = pnlSol > 0;
  let pushed = 0;
  for (const kolId of [...new Set(kolIds.map((id) => id.trim()).filter(Boolean))]) {
    const buf = recentRotationLiveKolCloses.get(kolId) ?? [];
    buf.push({ closedAtMs, pnlSol, isWin });
    while (buf.length > ROTATION_LIVE_KOL_DECAY_RING_SIZE) buf.shift();
    recentRotationLiveKolCloses.set(kolId, buf);
    pushed += 1;
  }
  return pushed;
}

function markRotationLiveKolClosed(pos: PaperPosition, pnlSol: number): void {
  if (!config.kolHunterRotationLiveKolDecayEnabled) return;
  if (!isRotationFamilyMarkoutPosition(pos)) return;
  const nowMs = Date.now();
  const kolIds = [...new Set(
    [
      ...(pos.rotationAnchorKols ?? []),
      ...pos.participatingKols.map((kol) => kol.id),
    ].map((id) => id.trim()).filter(Boolean)
  )];
  pushRotationLiveKolClose(kolIds, pnlSol, nowMs);
  if (recentRotationLiveKolCloses.size > 200) {
    const cutoff = nowMs - 24 * 60 * 60 * 1000;
    for (const [id, recs] of recentRotationLiveKolCloses) {
      const last = recs[recs.length - 1];
      if (last && last.closedAtMs < cutoff) recentRotationLiveKolCloses.delete(id);
    }
  }
}

function checkRotationLiveKolDecay(kolIds: string[]): { blocked: boolean; reason?: string; flags: string[] } {
  if (!config.kolHunterRotationLiveKolDecayEnabled) return { blocked: false, flags: [] };
  const minCloses = Math.max(1, config.kolHunterRotationLiveKolDecayMinCloses);
  const cooldownMs = config.kolHunterRotationLiveKolDecayCooldownMs;
  if (cooldownMs <= 0) return { blocked: false, flags: [] };
  for (const kolId of [...new Set(kolIds.map((id) => id.trim()).filter(Boolean))]) {
    const buf = recentRotationLiveKolCloses.get(kolId);
    if (!buf || buf.length < minCloses) continue;
    const recent = buf.slice(-minCloses);
    const losses = recent.filter((row) => !row.isWin).length;
    const lossRatio = losses / recent.length;
    const cumPnl = recent.reduce((sum, row) => sum + row.pnlSol, 0);
    const elapsedMs = Date.now() - recent[recent.length - 1].closedAtMs;
    if (cumPnl >= 0) continue;
    if (lossRatio < config.kolHunterRotationLiveKolDecayLossRatio) continue;
    if (elapsedMs >= cooldownMs) continue;
    return {
      blocked: true,
      reason: `rotation_live_kol_decay:${kolId}:cum=${cumPnl.toFixed(4)}:losses=${losses}/${recent.length}`,
      flags: [
        'ROTATION_LIVE_KOL_DECAY',
        `ROTATION_LIVE_KOL_DECAY_KOL_${kolId.toUpperCase()}`,
        `ROTATION_LIVE_KOL_DECAY_LOSSES_${losses}_OF_${recent.length}`,
      ],
    };
  }
  return { blocked: false, flags: [] };
}

function recordClosedAtMs(record: RotationLiveKolDecayCloseRecord): number | null {
  if (typeof record.closedAt === 'string') {
    const parsed = new Date(record.closedAt).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof record.exitTimeSec === 'number' && Number.isFinite(record.exitTimeSec)) {
    return record.exitTimeSec * 1000;
  }
  return null;
}

function rotationLiveKolIdsFromRecord(record: RotationLiveKolDecayCloseRecord): string[] {
  return [
    ...(record.extras?.rotationAnchorKols ?? []),
    ...(record.extras?.participatingKols ?? []).map((kol) => kol.id ?? ''),
    ...(record.kols ?? []).map((kol) => kol.id ?? ''),
  ].map((id) => id.trim()).filter(Boolean);
}

function isRotationLiveKolDecayHydratableRecord(record: RotationLiveKolDecayCloseRecord): boolean {
  if (record.isLive === false) return false;
  if (record.isTailPosition === true || record.extras?.isTailPosition === true) return false;
  if (record.parentPositionId || record.extras?.parentPositionId) return false;
  if (record.positionId?.endsWith('-tail')) return false;
  const probe = {
    parameterVersion: record.parameterVersion ?? record.extras?.parameterVersion ?? undefined,
    kolEntryReason: record.kolEntryReason ?? record.entryReason ?? record.extras?.entryReason ?? undefined,
    armName: record.profileArm ??
      record.extras?.profileArm ??
      record.armName ??
      record.extras?.armName ??
      record.entryArm ??
      record.extras?.entryArm ??
      undefined,
  };
  return isRotationFamilyMarkoutPosition(probe);
}

export function hydrateRotationLiveKolDecayFromCloseRecords(
  records: RotationLiveKolDecayCloseRecord[],
  nowMs = Date.now()
): RotationLiveKolDecayHydrationSummary {
  if (!config.kolHunterRotationLiveKolDecayEnabled) {
    return { loaded: records.length, hydrated: 0, skippedExpired: 0 };
  }
  const cooldownMs = config.kolHunterRotationLiveKolDecayCooldownMs;
  if (cooldownMs <= 0) return { loaded: records.length, hydrated: 0, skippedExpired: 0 };
  let hydrated = 0;
  let skippedExpired = 0;
  const seen = new Set<string>();
  for (const record of records) {
    if (!isRotationLiveKolDecayHydratableRecord(record)) continue;
    const positionId = record.positionId?.trim();
    const pnlSol = record.netSol;
    if (typeof pnlSol !== 'number' || !Number.isFinite(pnlSol)) continue;
    const closedAtMs = recordClosedAtMs(record);
    if (closedAtMs == null) continue;
    if (closedAtMs + cooldownMs <= nowMs) {
      skippedExpired += 1;
      continue;
    }
    const kolIds = rotationLiveKolIdsFromRecord(record);
    if (kolIds.length === 0) continue;
    if (positionId) {
      if (seen.has(positionId)) continue;
      seen.add(positionId);
    }
    if (pushRotationLiveKolClose(kolIds, pnlSol, closedAtMs) > 0) {
      hydrated += 1;
    }
  }
  return { loaded: records.length, hydrated, skippedExpired };
}

export async function hydrateRotationLiveKolDecayFromLedger(
  ledgerDir = config.realtimeDataDir
): Promise<RotationLiveKolDecayHydrationSummary> {
  const rows = [
    ...await readJsonlRowsMaybe<RotationLiveKolDecayCloseRecord>(path.join(ledgerDir, 'rotation-v1-live-trades.jsonl')),
    ...await readJsonlRowsMaybe<RotationLiveKolDecayCloseRecord>(path.join(ledgerDir, 'kol-live-trades.jsonl')),
  ];
  const summary = hydrateRotationLiveKolDecayFromCloseRecords(rows);
  if (summary.hydrated > 0 || summary.skippedExpired > 0) {
    log.warn(
      `[KOL_HUNTER_ROTATION_LIVE_KOL_DECAY_HYDRATE] ` +
      `loaded=${summary.loaded} hydrated=${summary.hydrated} expired=${summary.skippedExpired}`
    );
  }
  return summary;
}

interface SmartV3ComboCloseRecord {
  closedAtMs: number;
  pnlSol: number;
  isWin: boolean;
  mode: 'paper' | 'live';
}
const recentSmartV3ComboCloses = new Map<string, SmartV3ComboCloseRecord[]>();
const SMART_V3_COMBO_DECAY_RING_SIZE = 5;

function smartV3ComboKey(kolIds: string[]): string | null {
  const normalized = [...new Set(kolIds.map((id) => id.trim().toLowerCase()).filter(Boolean))]
    .sort();
  if (normalized.length < 2) return null;
  return normalized.join('+');
}

function pushSmartV3ComboCloseRecord(key: string, pnlSol: number, mode: 'paper' | 'live'): void {
  if (!config.kolHunterSmartV3ComboDecayEnabled) return;
  const buf = recentSmartV3ComboCloses.get(key) ?? [];
  buf.push({ closedAtMs: Date.now(), pnlSol, isWin: pnlSol > 0, mode });
  while (buf.length > SMART_V3_COMBO_DECAY_RING_SIZE) buf.shift();
  recentSmartV3ComboCloses.set(key, buf);
  if (recentSmartV3ComboCloses.size > 500) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [combo, recs] of recentSmartV3ComboCloses) {
      const last = recs[recs.length - 1];
      if (last && last.closedAtMs < cutoff) recentSmartV3ComboCloses.delete(combo);
    }
  }
}

function markSmartV3ComboClosed(pos: PaperPosition, pnlSol: number, mode: 'paper' | 'live'): void {
  if (!config.kolHunterSmartV3ComboDecayEnabled) return;
  if (!isSmartV3Position(pos) || isRotationFamilyMarkoutPosition(pos)) return;
  const key = pos.smartV3EntryComboKey ?? smartV3ComboKey(pos.participatingKols.map((k) => k.id));
  if (!key) return;
  pushSmartV3ComboCloseRecord(key, pnlSol, mode);
}

function checkSmartV3ComboDecay(kolIds: string[]): { blocked: boolean; reason?: string; flags: string[] } {
  if (!config.kolHunterSmartV3ComboDecayEnabled) return { blocked: false, flags: [] };
  const key = smartV3ComboKey(kolIds);
  if (!key) return { blocked: false, flags: [] };
  const minCloses = Math.max(1, config.kolHunterSmartV3ComboDecayMinCloses);
  const buf = recentSmartV3ComboCloses.get(key);
  if (!buf) return { blocked: false, flags: [] };
  const recentWindow = buf.slice(-Math.max(minCloses, 1));
  const hasRecentLiveLoss = recentWindow.some((row) => row.mode === 'live' && !row.isWin);
  if (buf.length < minCloses && !hasRecentLiveLoss) return { blocked: false, flags: [] };
  const cooldownMs = config.kolHunterSmartV3ComboDecayCooldownMs;
  if (cooldownMs <= 0) return { blocked: false, flags: [] };
  const recent = buf.length < minCloses ? recentWindow : buf.slice(-minCloses);
  const cumPnl = recent.reduce((sum, row) => sum + row.pnlSol, 0);
  const losses = recent.filter((row) => !row.isWin).length;
  const liveLosses = recent.filter((row) => row.mode === 'live' && !row.isWin).length;
  const lossRatio = losses / recent.length;
  const lastCloseMs = recent[recent.length - 1].closedAtMs;
  const elapsedMs = Date.now() - lastCloseMs;
  if (cumPnl >= 0 && liveLosses === 0) return { blocked: false, flags: [] };
  if (liveLosses === 0 && lossRatio < config.kolHunterSmartV3ComboDecayLossRatio) return { blocked: false, flags: [] };
  if (elapsedMs >= cooldownMs) return { blocked: false, flags: [] };
  return {
    blocked: true,
    reason: `smart_v3_combo_decay:${key}:cum=${cumPnl.toFixed(4)}:losses=${losses}/${recent.length}:liveLosses=${liveLosses}`,
    flags: [
      'SMART_V3_COMBO_DECAY',
      `SMART_V3_COMBO_DECAY_LOSSES_${losses}_OF_${recent.length}`,
      `SMART_V3_COMBO_DECAY_LIVE_LOSSES_${liveLosses}`,
    ],
  };
}

/** 테스트용 reset. */
export function resetKolDecayForTests(): void {
  recentKolCloses.clear();
  recentSmartV3ComboCloses.clear();
  recentRotationLiveKolCloses.clear();
}
// 2026-04-26 P1 audit fix #5: O(N) `[...active.values()].filter(p => p.tokenMint === X)` 패턴이
// 매 price tick / kol_swap 마다 hot path 에 등장. token → positionId Set 인덱스로 O(1) 화.
// 항상 active 와 동기화 (setActivePosition / deleteActivePosition wrapper 만 사용).
const activeByMint = new Map<string, Set<string>>();
function setActivePosition(pos: PaperPosition): void {
  active.set(pos.positionId, pos);
  let set = activeByMint.get(pos.tokenMint);
  if (!set) {
    set = new Set();
    activeByMint.set(pos.tokenMint, set);
  }
  set.add(pos.positionId);
}
function deleteActivePosition(positionId: string): void {
  const pos = active.get(positionId);
  if (!pos) return;
  active.delete(positionId);
  const set = activeByMint.get(pos.tokenMint);
  if (set) {
    set.delete(positionId);
    if (set.size === 0) activeByMint.delete(pos.tokenMint);
  }
  // 2026-04-30 (F11 fix): structural kill cache 정리 — close 후에도 entry 유지되면
  // 장기 봇 운영 시 1 trade per entry 누적 → memory leak. positionId 기반 cleanup.
  structuralKillCache.delete(positionId);
}
function getActivePositionsByMint(tokenMint: string): PaperPosition[] {
  const set = activeByMint.get(tokenMint);
  if (!set || set.size === 0) return [];
  const out: PaperPosition[] = [];
  for (const id of set) {
    const pos = active.get(id);
    if (pos) out.push(pos);
  }
  return out;
}
const recentKolTxs: KolTx[] = [];                           // scoring 용 buffer (24h)

// 2026-04-26 P0 audit fix #2: shift while-loop 가 O(N) per push 라 24h × N KOLs × tx-rate 누적 시
// 매 신규 tx 마다 30k+ shift = handler latency 누적. push 마다 prune 대신 batch (1024 마다 1회).
const RECENT_TX_PRUNE_BATCH = 1024;
let pushesSinceLastPrune = 0;
function pruneRecentKolTxsByCutoff(cutoffMs: number): void {
  // 첫 retain index 찾기 → 단 1회 splice. shift while 루프보다 O(N) 한 번으로 감소.
  let firstKeep = 0;
  while (firstKeep < recentKolTxs.length && recentKolTxs[firstKeep].timestamp < cutoffMs) {
    firstKeep++;
  }
  if (firstKeep > 0) recentKolTxs.splice(0, firstKeep);
}

// 2026-04-26 P1 audit fix #7: computeKolDiscoveryScore 가 같은 token 에 대해 5 호출 사이트
// (handleKolSwap / registerSmartV3Pending / resolveSmartV3NoTrigger / evaluateSmartV3Triggers /
// resolveStalk) 에서 호출됨. 매번 30k+ recentKolTxs 풀 스캔 → tx burst 시 CPU spike.
// → 토큰별로 (recentKolTxs.length, nowMs/SCORE_CACHE_BUCKET_MS) 키로 결과 캐싱.
// recentKolTxs 가 push/splice 될 때마다 length 가 바뀌므로 자동 invalidation.
const SCORE_CACHE_BUCKET_MS = 1000;  // 1s bucket — 같은 second 내 중복 호출만 캐시 hit
const scoreCache = new Map<string, { recentTxsLen: number; nowBucket: number; score: KolDiscoveryScore }>();
const rotationV1RecentTxsByMint = new Map<string, KolTx[]>();
const rotationV1PreObserveBlockLogKeys = new Set<string>();
let rotationV1ConfigLogged = false;

// 2026-04-29: Co-buy graph community 캐시 (외부 전략 리포트 권고 #5).
// recentKolTxs 로 community 빌드 → effectiveIndependentCount 산출 시 활용.
// 빈도: 높지 않음 — 매 N분 마다 갱신 (cost = O(k²) where k=KOL count, ≤ 50).
import { buildCoBuyGraph, type KolCommunity } from '../kol/coBuyGraph';
let cachedCommunities: KolCommunity[] = [];
let lastCommunityRefreshMs = 0;
const COMMUNITY_REFRESH_INTERVAL_MS = 10 * 60 * 1000;  // 10분
function refreshCommunitiesIfStale(nowMs: number): void {
  if (!config.kolHunterCommunityDetectionEnabled) {
    cachedCommunities = [];
    return;
  }
  if (nowMs - lastCommunityRefreshMs < COMMUNITY_REFRESH_INTERVAL_MS) return;
  try {
    const result = buildCoBuyGraph(recentKolTxs, {
      windowMs: config.kolHunterCommunityWindowMs,
      minEdgeWeight: config.kolHunterCommunityMinEdgeWeight,
    });
    cachedCommunities = result.communities;
    lastCommunityRefreshMs = nowMs;
    if (result.communities.length > 0) {
      const summary = result.communities
        .filter((c) => c.members.length >= 2)
        .map((c) => `${c.communityId}:${c.members.length}`)
        .join(',');
      log.info(
        `[KOL_COBUY_GRAPH] refreshed — edges=${result.edges.length} communities=${result.communities.length} multi-member=[${summary}]`
      );
    }
  } catch (err) {
    log.warn(`[KOL_COBUY_GRAPH] refresh failed: ${err}`);
  }
}
/** 테스트용 reset. */
export function resetCommunityCacheForTests(): void {
  cachedCommunities = [];
  lastCommunityRefreshMs = 0;
}

function computeKolDiscoveryScoreCached(tokenMint: string, nowMs: number): KolDiscoveryScore {
  const bucket = Math.floor(nowMs / SCORE_CACHE_BUCKET_MS);
  const cached = scoreCache.get(tokenMint);
  if (
    cached &&
    cached.recentTxsLen === recentKolTxs.length &&
    cached.nowBucket === bucket
  ) {
    return cached.score;
  }
  refreshCommunitiesIfStale(nowMs);
  const score = computeKolDiscoveryScore(tokenMint, recentKolTxs, nowMs, {
    windowMs: config.kolScoringWindowMs,
    antiCorrelationMs: config.kolAntiCorrelationMs,
  }, cachedCommunities.length > 0 ? cachedCommunities : undefined);
  scoreCache.set(tokenMint, { recentTxsLen: recentKolTxs.length, nowBucket: bucket, score });
  // Cache size cap — 1000 token (스캐닝 token 수가 그 이상이면 LRU 효과로 oldest 제거)
  if (scoreCache.size > 1000) {
    const firstKey = scoreCache.keys().next().value;
    if (firstKey) scoreCache.delete(firstKey);
  }
  return score;
}

interface SmartV3FreshContext {
  freshIndependentKolCount: number;
  freshTierStrongCount: number;
  freshSignalScore: number;
  freshBuySol: number;
  freshParticipatingKols: KolDiscoveryScore['participatingKols'];
  triggerFreshIndependentKolCount: number;
  triggerFreshTierStrongCount: number;
  triggerFreshSignalScore: number;
  triggerLastFreshBuyAgeMs: number | null;
  shadowFreshIndependentKolCount: number;
  shadowFreshTierStrongCount: number;
  shadowFreshBuySol: number;
  shadowFreshParticipatingKols: KolDiscoveryScore['participatingKols'];
  firstFreshBuyAtMs: number | null;
  lastFreshBuyAtMs: number | null;
  lastFreshBuyAgeMs: number | null;
  preEntrySellSol: number;
  preEntrySellKols: number;
  lastSellAtMs: number | null;
  secondsSinceLastSell: number | null;
  freshBuyKolsAfterLastSell: number;
  flags: string[];
}

function mergeRecentAndCandidateTxs(cand: PendingCandidate): KolTx[] {
  const byKey = new Map<string, KolTx>();
  for (const tx of [...recentKolTxs, ...cand.kolTxs]) {
    const key = tx.txSignature || `${tx.kolId}:${tx.tokenMint}:${tx.action}:${tx.timestamp}`;
    byKey.set(key, tx);
  }
  return [...byKey.values()];
}

function buildSmartV3FreshContext(cand: PendingCandidate, nowMs: number): SmartV3FreshContext {
  const freshWindowMs = Math.max(1, config.kolHunterSmartV3FreshWindowSec) * 1000;
  const freshStartMs = nowMs - freshWindowMs;
  const sellWindowMs = Math.max(freshWindowMs, config.kolHunterPostDistributionWindowSec * 1000);
  const sellStartMs = nowMs - sellWindowMs;
  const rows = mergeRecentAndCandidateTxs(cand).filter((tx) =>
    tx.tokenMint === cand.tokenMint &&
    tx.timestamp <= nowMs
  );

  const latestFreshBuyByKol = new Map<string, KolTx>();
  const latestShadowFreshBuyByKol = new Map<string, KolTx>();
  let freshBuySol = 0;
  let shadowFreshBuySol = 0;
  for (const tx of rows) {
    if (tx.action !== 'buy' || tx.timestamp < freshStartMs) continue;
    if (tx.isShadow === true) {
      const existingShadow = latestShadowFreshBuyByKol.get(tx.kolId);
      if (!existingShadow || tx.timestamp > existingShadow.timestamp) {
        latestShadowFreshBuyByKol.set(tx.kolId, tx);
      }
      shadowFreshBuySol += Math.max(0, tx.solAmount ?? 0);
    } else {
      const existing = latestFreshBuyByKol.get(tx.kolId);
      if (!existing || tx.timestamp > existing.timestamp) {
        latestFreshBuyByKol.set(tx.kolId, tx);
      }
      freshBuySol += Math.max(0, tx.solAmount ?? 0);
    }
  }

  const freshBuys = [...latestFreshBuyByKol.values()].sort((a, b) => a.timestamp - b.timestamp);
  const shadowFreshBuys = [...latestShadowFreshBuyByKol.values()].sort((a, b) => a.timestamp - b.timestamp);
  // Live eligibility must never be created by shadow/inactive KOLs. Shadow-only candidates still
  // produce paper observations, but once any active KOL is present the trigger path uses active KOLs only.
  const triggerFreshBuys = (freshBuys.length > 0 ? freshBuys : shadowFreshBuys)
    .sort((a, b) => a.timestamp - b.timestamp);
  const triggerFreshIndependentKolCount = new Set(triggerFreshBuys.map((tx) => tx.kolId)).size;
  const firstFreshBuyAtMs = freshBuys[0]?.timestamp ?? null;
  const lastFreshBuyAtMs = freshBuys[freshBuys.length - 1]?.timestamp ?? null;
  const lastFreshBuyAgeMs = lastFreshBuyAtMs == null ? null : Math.max(0, nowMs - lastFreshBuyAtMs);
  const triggerLastFreshBuyAtMs = triggerFreshBuys[triggerFreshBuys.length - 1]?.timestamp ?? null;
  const triggerLastFreshBuyAgeMs = triggerLastFreshBuyAtMs == null ? null : Math.max(0, nowMs - triggerLastFreshBuyAtMs);
  const freshTierStrongCount = freshBuys.filter((tx) => tx.tier === 'S' || tx.tier === 'A').length;
  const shadowFreshTierStrongCount = shadowFreshBuys.filter((tx) => tx.tier === 'S' || tx.tier === 'A').length;
  const freshParticipatingKols = freshBuys.map((tx) => ({
    id: tx.kolId,
    tier: tx.tier,
    timestamp: tx.timestamp,
  }));
  const shadowFreshParticipatingKols = shadowFreshBuys.map((tx) => ({
    id: tx.kolId,
    tier: tx.tier,
    timestamp: tx.timestamp,
  }));
  const freshTierScore = freshBuys.reduce((sum, tx) => {
    if (tx.tier === 'S') return sum + 3.0;
    if (tx.tier === 'A') return sum + 1.0;
    return sum + 0.5;
  }, 0);
  const freshConsensusBonus =
    freshBuys.length === 0 ? 0
    : freshBuys.length === 1 ? 1.0
    : freshBuys.length <= 4 ? 3.0
    : 10.0;
  const freshSignalScore = freshTierScore + freshConsensusBonus;
  const triggerFreshTierScore = triggerFreshBuys.reduce((sum, tx) => {
    if (tx.tier === 'S') return sum + 3.0;
    if (tx.tier === 'A') return sum + 1.0;
    return sum + 0.5;
  }, 0);
  const triggerFreshConsensusBonus =
    triggerFreshBuys.length === 0 ? 0
    : triggerFreshBuys.length === 1 ? 1.0
    : triggerFreshBuys.length <= 4 ? 3.0
    : 10.0;
  const triggerFreshSignalScore = triggerFreshTierScore + triggerFreshConsensusBonus;

  let preEntrySellSol = 0;
  let lastSellAtMs: number | null = null;
  const sellKols = new Set<string>();
  for (const tx of rows) {
    if (tx.action !== 'sell' || tx.timestamp < sellStartMs) continue;
    preEntrySellSol += Math.max(0, tx.solAmount ?? 0);
    sellKols.add(tx.kolId);
    if (lastSellAtMs == null || tx.timestamp > lastSellAtMs) lastSellAtMs = tx.timestamp;
  }

  const freshBuyKolsAfterLastSell = lastSellAtMs == null
    ? latestFreshBuyByKol.size
    : new Set(freshBuys.filter((tx) => tx.timestamp > lastSellAtMs).map((tx) => tx.kolId)).size;
  const secondsSinceLastSell = lastSellAtMs == null
    ? null
    : Math.max(0, Math.floor((nowMs - lastSellAtMs) / 1000));

  const flags = [
    `SMART_V3_FRESH_KOLS_${latestFreshBuyByKol.size}`,
    `SMART_V3_FRESH_STRONG_KOLS_${freshTierStrongCount}`,
    `SMART_V3_FRESH_SCORE_${freshSignalScore.toFixed(1)}`,
    `SMART_V3_FRESH_AFTER_SELL_KOLS_${freshBuyKolsAfterLastSell}`,
  ];
  if (latestShadowFreshBuyByKol.size > 0) {
    flags.push(`SMART_V3_SHADOW_FRESH_KOLS_${latestShadowFreshBuyByKol.size}`);
    flags.push(`SMART_V3_SHADOW_FRESH_STRONG_KOLS_${shadowFreshTierStrongCount}`);
    flags.push('SMART_V3_SHADOW_CONFIRMATION_AUX');
    flags.push(`SMART_V3_TRIGGER_FRESH_KOLS_${triggerFreshIndependentKolCount}`);
    flags.push(`SMART_V3_TRIGGER_FRESH_SCORE_${triggerFreshSignalScore.toFixed(1)}`);
  }
  if (lastFreshBuyAgeMs !== null) {
    flags.push(`SMART_V3_LAST_BUY_AGE_${Math.round(lastFreshBuyAgeMs / 1000)}S`);
  }
  if (preEntrySellSol > 0) {
    flags.push(`SMART_V3_PRE_ENTRY_SELL_SOL_${preEntrySellSol.toFixed(2)}`);
    flags.push(`SMART_V3_PRE_ENTRY_SELL_KOLS_${sellKols.size}`);
  }

  return {
    freshIndependentKolCount: latestFreshBuyByKol.size,
    freshTierStrongCount,
    freshSignalScore,
    freshBuySol,
    freshParticipatingKols,
    triggerFreshIndependentKolCount,
    triggerFreshTierStrongCount: freshTierStrongCount + shadowFreshTierStrongCount,
    triggerFreshSignalScore,
    triggerLastFreshBuyAgeMs,
    shadowFreshIndependentKolCount: latestShadowFreshBuyByKol.size,
    shadowFreshTierStrongCount,
    shadowFreshBuySol,
    shadowFreshParticipatingKols,
    firstFreshBuyAtMs,
    lastFreshBuyAtMs,
    lastFreshBuyAgeMs,
    preEntrySellSol,
    preEntrySellKols: sellKols.size,
    lastSellAtMs,
    secondsSinceLastSell,
    freshBuyKolsAfterLastSell,
    flags,
  };
}
let priceFeed: PaperPriceFeed | null = null;
const priceListeners = new Map<string, (tick: PriceTick) => void>(); // tokenMint → fan-out handler

// 2026-04-28 (P0-2A fix, ralph-loop): inflight dedup for live entry path.
// Why: KOL hunter 가 cupsey/pure_ws 패턴의 inflight guard 누락 — 동일 mint 동시 signal
// 들어오면 enterLivePosition 두 번 진입 → executeBuy 두 번 + DB duplicate row 위험.
// pure_ws 의 inflightEntryByPair 와 cupsey 의 enteringLock 패턴 동일.
// live entry 전체 lifetime (subscribe → first tick → executeBuy → persist) 동안 보호.
const inflightLiveEntry = new Set<string>();

/**
 * MISSION_CONTROL §KOL Control survival 의존성 (2026-04-25):
 * Phase 3 paper-mode 도 live 와 동일한 entry-side gate 를 거쳐야 paper 결과가 live 비교 가능.
 * `initKolHunter({ securityClient, gateCache })` 로 주입. 미주입 시 survival 단계 skip
 * (config.kolHunterSurvivalAllowDataMissing 동작과 동일).
 */
let securityClient: OnchainSecurityClient | undefined;
let gateCache: GateCacheManager | undefined;
let ownedGateCache: GateCacheManager | undefined;
// 2026-05-01 (Helius Stream X1 wiring): pool registry inject — recordTokenQualityObservation 가
//   poolRegistry?.getTokenPairs(tokenMint) 호출해 EXIT_LIQUIDITY_UNKNOWN / POOL_NOT_PREWARMED
//   flag 정확도 향상. inject 안 되면 default emit (X3 minimal mode).
let heliusPoolRegistry: HeliusPoolRegistry | undefined;

/**
 * 2026-05-01 (Helius Stream X1): 별도 setter — initKolHunter 시 BotContext 미경유 inject path.
 *   index.ts 에서 `setHeliusPoolRegistryForKolHunter(registry)` 호출 → registry 가 token quality
 *   observation 의 EXIT/POOL flag 정확도 향상.
 *   미주입 시 default emit (모든 token 에 양 flag 기록 — sparse cohort).
 */
export function setHeliusPoolRegistryForKolHunter(registry: HeliusPoolRegistry | undefined): void {
  heliusPoolRegistry = registry;
}
// 2026-04-27 (KOL live canary): ctx 보존 — closePosition 등 deep call site 에서 사용.
// initKolHunter 시 주입. paper-only 경로에선 unused (graceful null check).
let botCtx: BotContext | undefined;

export const kolHunterEvents = new EventEmitter();           // 외부 관측용 (test/index)

const KOL_POLICY_DECISIONS_FILE = 'kol-policy-decisions.jsonl';

function currentRecentJupiter429(): number {
  return getJupiter429Stats().reduce((sum, stat) => sum + stat.sinceLastSummary, 0);
}

function enrichPolicyParticipants(
  participants: Array<Pick<KolPolicyParticipant, 'id' | 'tier' | 'timestamp'>>
): KolPolicyParticipant[] {
  return participants.map((p) => ({
    ...p,
    style: getKolTradingStyle(p.id),
  }));
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

async function appendKolPolicyDecision(decision: KolPolicyDecision): Promise<void> {
  try {
    const dir = config.realtimeDataDir;
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, KOL_POLICY_DECISIONS_FILE), JSON.stringify(decision) + '\n', 'utf8');
  } catch (err) {
    log.debug(`[KOL_HUNTER_POLICY] decision append failed: ${String(err)}`);
  }
}

function emitKolShadowPolicy(
  input: Omit<KolPolicyInput, 'participatingKols'> & {
    participatingKols: Array<Pick<KolPolicyParticipant, 'id' | 'tier' | 'timestamp'>>;
  }
): void {
  const decision = evaluateKolShadowPolicy({
    ...input,
    participatingKols: enrichPolicyParticipants(input.participatingKols),
  });
  void appendKolPolicyDecision(decision);
}

function emitKolPositionPolicy(
  pos: PaperPosition,
  eventKind: KolPolicyInput['eventKind'],
  currentAction: KolPolicyInput['currentAction'],
  extras: Partial<Omit<KolPolicyInput, 'eventKind' | 'tokenMint' | 'currentAction' | 'participatingKols'>> = {}
): void {
  const ref = pos.marketReferencePrice > 0 ? pos.marketReferencePrice : pos.entryPrice;
  const mfePct = ref > 0 ? (pos.peakPrice - ref) / ref : undefined;
  const maePct = ref > 0 ? (pos.troughPrice - ref) / ref : undefined;
  const peakDriftPct = pos.peakPrice > 0 ? (pos.peakPrice - pos.lastPrice) / pos.peakPrice : undefined;
  emitKolShadowPolicy({
    eventKind,
    tokenMint: pos.tokenMint,
    currentAction,
    isLive: pos.isLive === true,
    isShadowArm: pos.isShadowArm,
    armName: pos.armName,
    entryReason: pos.kolEntryReason,
    independentKolCount: pos.independentKolCount,
    effectiveIndependentCount: pos.independentKolCount,
    kolScore: pos.kolScore,
    participatingKols: pos.participatingKols,
    survivalFlags: pos.survivalFlags,
    recentJupiter429: currentRecentJupiter429(),
    mfePct,
    maePct,
    peakDriftPct,
    holdSec: Math.max(0, Math.floor(Date.now() / 1000) - pos.entryTimeSec),
    ...extras,
  });
}

function emitKolLiveFallbackPolicy(
  tokenMint: string,
  score: KolDiscoveryScore,
  survivalFlags: string[],
  extras: Partial<Omit<KolPolicyInput, 'eventKind' | 'tokenMint' | 'currentAction' | 'participatingKols'>> = {}
): void {
  emitKolShadowPolicy({
    eventKind: 'entry',
    tokenMint,
    currentAction: 'enter',
    isLive: true,
    isShadowArm: false,
    independentKolCount: score.independentKolCount,
    effectiveIndependentCount: score.effectiveIndependentCount,
    kolScore: score.finalScore,
    participatingKols: score.participatingKols,
    survivalFlags,
    recentJupiter429: currentRecentJupiter429(),
    ...extras,
  });
}

function buildLiveEquivalenceCandidateId(
  tokenMint: string,
  entrySignal: KolEntrySignal,
  nowMs: number,
  parameterVersionOverride?: string,
  profileArmOverride?: string
): string {
  const arm = profileArmOverride ?? armNameForVersion(parameterVersionOverride ?? entrySignal.parameterVersion);
  return `${tokenMint}:${entrySignal.label}:${arm}:${nowMs}`;
}

function buildLiveEquivalenceOptionPatch(input: {
  candidateId: string;
  stage: KolLiveEquivalenceDecisionStage;
  liveWouldEnter: boolean;
  reason?: string | null;
  flags?: string[];
}): Pick<
  PaperEntryOptions,
  | 'liveEquivalenceCandidateId'
  | 'liveEquivalenceDecisionStage'
  | 'liveEquivalenceLiveWouldEnter'
  | 'liveEquivalenceLiveBlockReason'
  | 'liveEquivalenceLiveBlockFlags'
> {
  return {
    liveEquivalenceCandidateId: input.candidateId,
    liveEquivalenceDecisionStage: input.stage,
    liveEquivalenceLiveWouldEnter: input.liveWouldEnter,
    liveEquivalenceLiveBlockReason: input.reason ?? null,
    liveEquivalenceLiveBlockFlags: Array.from(new Set(input.flags ?? [])),
  };
}

function emitKolLiveEquivalence(input: {
  candidateId: string;
  tokenMint: string;
  entrySignal: KolEntrySignal;
  score: KolDiscoveryScore;
  entryOptions: PaperEntryOptions;
  survivalFlags: string[];
  candIsShadow: boolean;
  stage: KolLiveEquivalenceDecisionStage;
  paperWouldEnter?: boolean;
  liveWouldEnter: boolean;
  liveAttempted?: boolean;
  liveBlockReason?: string | null;
  liveBlockFlags?: string[];
  paperOnlyReason?: string | null;
  sameMintLiveActive?: boolean;
  hardTradingHaltReason?: string | null;
  liveExecutionQualityReason?: string | null;
  liveExecutionQualityRemainingMs?: number | null;
}): void {
  const participants = input.entryOptions.entryParticipatingKols ?? input.score.participatingKols;
  const independentKolCount =
    input.entryOptions.entryIndependentKolCount ?? input.score.independentKolCount;
  const effectiveIndependentKolCount =
    input.entryOptions.entryIndependentKolCount ?? input.score.effectiveIndependentCount;
  const kolScore = input.entryOptions.entryKolScore ?? input.score.finalScore;
  const effectiveParameterVersion =
    input.entryOptions.parameterVersion ?? input.entrySignal.parameterVersion;
  const effectiveArmName = armNameForVersion(effectiveParameterVersion);
  const effectiveProfileArm = input.entryOptions.profileArm ?? effectiveArmName;
  const record: KolLiveEquivalenceRow = {
    schemaVersion: KOL_LIVE_EQUIVALENCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    candidateId: input.candidateId,
    tokenMint: input.tokenMint,
    entrySignalLabel: input.entrySignal.label,
    armName: effectiveArmName,
    profileArm: effectiveProfileArm,
    entryArm: input.entryOptions.entryArm ?? effectiveArmName,
    exitArm: input.entryOptions.exitArm ?? effectiveArmName,
    parameterVersion: effectiveParameterVersion,
    entryReason: input.entryOptions.entryReason ?? input.entrySignal.entryReason,
    convictionLevel: input.entryOptions.convictionLevel ?? input.entrySignal.conviction,
    paperWouldEnter: input.paperWouldEnter ?? true,
    liveWouldEnter: input.liveWouldEnter,
    liveAttempted: input.liveAttempted ?? false,
    decisionStage: input.stage,
    liveBlockReason: input.liveBlockReason ?? null,
    liveBlockFlags: Array.from(new Set(input.liveBlockFlags ?? [])),
    paperOnlyReason: input.paperOnlyReason ?? null,
    isShadowKol: input.candIsShadow,
    isLiveCanaryActive: isLiveCanaryActive(),
    hasBotContext: botCtx != null,
    independentKolCount,
    effectiveIndependentKolCount,
    kolScore,
    participatingKols: participants.map((p) => ({
      id: p.id,
      tier: p.tier,
      timestamp: p.timestamp,
    })),
    survivalFlags: Array.from(new Set(input.survivalFlags)),
    sameMintLiveActive: input.sameMintLiveActive,
    hardTradingHaltReason: input.hardTradingHaltReason ?? null,
    liveExecutionQualityReason: input.liveExecutionQualityReason ?? null,
    liveExecutionQualityRemainingMs: input.liveExecutionQualityRemainingMs ?? null,
    source: 'runtime',
  };
  void appendKolLiveEquivalence(record, { realtimeDir: config.realtimeDataDir }).catch((err) => {
    log.debug(`[KOL_LIVE_EQUIVALENCE] append failed: ${String(err)}`);
  });
}

// ─── Swing-v2 arm 판정 (2026-04-26) ─────────────────────

/**
 * Paper-only swing arm 진입 자격 — 3 조건 모두 만족 시 swing-v2 파라미터 사용.
 * - KOL_HUNTER_SWING_V2_ENABLED=true
 * - independentKolCount ≥ minKolCount (default 2 — multi-KOL only)
 * - kolScore ≥ minScore (default 5.0 — high confidence only)
 * 외부 review feedback (Q2 답변): single-KOL 까지 swing 보내면 confidence 부족.
 */
function isSwingV2Eligible(score: KolDiscoveryScore): boolean {
  if (!config.kolHunterSwingV2Enabled) return false;
  if (score.independentKolCount < config.kolHunterSwingV2MinKolCount) return false;
  if (score.finalScore < config.kolHunterSwingV2MinScore) return false;
  return true;
}

/** PaperPosition 에 stash 된 parameterVersion 으로 swing-v2 여부 판정. */
function isSwingV2Position(pos: PaperPosition): boolean {
  return pos.parameterVersion === config.kolHunterSwingV2ParameterVersion;
}

function isSmartV3Position(pos: PaperPosition): boolean {
  return pos.parameterVersion === config.kolHunterSmartV3ParameterVersion ||
    pos.parameterVersion.startsWith('smart-v3-') ||
    pos.armName?.startsWith('smart_v3_') === true;
}

type SmartV3PreT1MfeBand = '10_20' | '20_30' | '30_50';

function smartV3PreT1MfeBandForClose(pos: PaperPosition, mfePct: number): SmartV3PreT1MfeBand | null {
  if (!isSmartV3Position(pos)) return null;
  if (isRotationFamilyMarkoutPosition(pos)) return null;
  if (pos.t1VisitAtSec != null) return null;
  const t1Threshold = pos.t1MfeOverride ?? config.kolHunterT1Mfe;
  if (mfePct >= t1Threshold) return null;
  if (mfePct >= 0.30) return '30_50';
  if (mfePct >= 0.20) return '20_30';
  if (mfePct >= 0.10) return '10_20';
  return null;
}

function smartV3MfeStageFor(mfePct: number): SmartV3MfeStage {
  if (mfePct >= config.kolHunterSmartV3MfeConvexityThresholdPct) return 'convexity';
  if (mfePct >= config.kolHunterSmartV3MfeRunnerThresholdPct) return 'runner';
  if (mfePct >= config.kolHunterSmartV3MfeProfitLockThresholdPct) return 'profit_lock';
  if (mfePct >= config.kolHunterSmartV3MfeBreakevenThresholdPct) return 'breakeven_watch';
  return 'probe';
}

function smartV3ProfitFloorPctForStage(stage: SmartV3MfeStage): number | null {
  if (stage === 'convexity') return config.kolHunterSmartV3MfeConvexityFloorPct;
  if (stage === 'runner') return config.kolHunterSmartV3MfeRunnerFloorPct;
  if (stage === 'profit_lock') return config.kolHunterSmartV3MfeProfitLockFloorPct;
  if (stage === 'breakeven_watch') return config.kolHunterSmartV3MfeBreakevenFloorPct;
  return null;
}

function strategyEntryReferencePrice(pos: Pick<PaperPosition, 'marketReferencePrice' | 'entryPriceTokenOnly' | 'entryPrice'>): number {
  if (Number.isFinite(pos.marketReferencePrice) && pos.marketReferencePrice > 0) {
    return pos.marketReferencePrice;
  }
  if (pos.entryPriceTokenOnly != null && Number.isFinite(pos.entryPriceTokenOnly) && pos.entryPriceTokenOnly > 0) {
    return pos.entryPriceTokenOnly;
  }
  return pos.entryPrice;
}

function smartV3TokenEntryReference(pos: PaperPosition): number {
  return strategyEntryReferencePrice(pos);
}

function refreshSmartV3MfeFloorState(
  pos: PaperPosition,
  mfePct: number,
  nowSec: number
): { stage: SmartV3MfeStage; floorPct: number | null; floorPrice: number | null } {
  const stage = smartV3MfeStageFor(mfePct);
  const floorPct = config.kolHunterSmartV3MfeFloorEnabled
    ? smartV3ProfitFloorPctForStage(stage)
    : null;
  const entryRef = smartV3TokenEntryReference(pos);
  const floorPrice = floorPct != null && entryRef > 0
    ? entryRef * (1 + floorPct)
    : null;

  if (pos.smartV3MfeStage !== stage) {
    pos.smartV3MfeStage = stage;
    pos.smartV3MfeStageUpdatedAtSec = nowSec;
  }
  pos.smartV3ProfitFloorPct = floorPct;
  pos.smartV3ProfitFloorPrice = floorPrice;
  return { stage, floorPct, floorPrice };
}

function shouldCloseSmartV3MfeFloor(
  pos: PaperPosition,
  currentPrice: number,
  nowSec: number,
  mfePct: number
): boolean {
  if (!config.kolHunterSmartV3MfeFloorEnabled) return false;
  if (!isSmartV3Position(pos)) return false;
  if (isRotationFamilyMarkoutPosition(pos)) return false;
  if (pos.isTailPosition === true) return false;

  const state = refreshSmartV3MfeFloorState(pos, mfePct, nowSec);
  if (state.floorPct == null || state.floorPrice == null) return false;
  if (currentPrice > state.floorPrice) return false;

  const tokenRef = smartV3TokenEntryReference(pos);
  const tokenNetPct = tokenRef > 0 ? (currentPrice - tokenRef) / tokenRef : 0;
  pos.smartV3ProfitFloorExit = true;
  pos.smartV3ProfitFloorExitAtSec = nowSec;
  pos.smartV3ProfitFloorExitNetPct = tokenNetPct;
  pos.smartV3ProfitFloorExitStage = state.stage;
  log.info(
    `[KOL_HUNTER_SMART_V3_MFE_FLOOR_EXIT] ${pos.positionId} ` +
    `stage=${state.stage} mfe=${(mfePct * 100).toFixed(2)}% ` +
    `net=${(tokenNetPct * 100).toFixed(2)}% floor=${(state.floorPct * 100).toFixed(2)}%`
  );
  return true;
}

function buildSmartV3PreT1CloseTelemetry(
  pos: PaperPosition,
  exitPriceForMetric: number,
  mfePct: number,
): {
  smartV3PreT1MfeBand: SmartV3PreT1MfeBand | null;
  smartV3PreT1ClosePct: number | null;
  smartV3PreT1GivebackPct: number | null;
  smartV3PreT1WouldLockBreakeven: boolean | null;
} {
  const band = smartV3PreT1MfeBandForClose(pos, mfePct);
  if (band == null) {
    return {
      smartV3PreT1MfeBand: null,
      smartV3PreT1ClosePct: null,
      smartV3PreT1GivebackPct: null,
      smartV3PreT1WouldLockBreakeven: null,
    };
  }
  const closePct = pos.marketReferencePrice > 0
    ? (exitPriceForMetric - pos.marketReferencePrice) / pos.marketReferencePrice
    : null;
  return {
    smartV3PreT1MfeBand: band,
    smartV3PreT1ClosePct: closePct,
    smartV3PreT1GivebackPct: closePct == null ? null : Math.max(0, mfePct - closePct),
    smartV3PreT1WouldLockBreakeven: closePct == null ? null : closePct < 0,
  };
}

function isRotationV1Position(pos: PaperPosition): boolean {
  return isRotationFamilyMarkoutPosition(pos);
}

function armNameForVersion(parameterVersion: string): string {
  if (parameterVersion === config.kolHunterSmartV3ParameterVersion) return 'kol_hunter_smart_v3';
  if (parameterVersion === config.kolHunterSmartV3QualityUnknownMicroParameterVersion) return 'smart_v3_quality_unknown_micro';
  if (parameterVersion === config.kolHunterSmartV3FastCanaryParameterVersion) return 'smart_v3_fast_canary_v1';
  if (parameterVersion === config.kolHunterSmartV3FastFailLiveParameterVersion) return 'smart_v3_fast_fail_live_v1';
  if (parameterVersion === config.kolHunterSmartV3NewPoolConfirmedParameterVersion) return 'smart_v3_new_pool_confirmed_v1';
  if (parameterVersion === 'smart-v3-fast-fail-v1.0.0') return 'smart_v3_fast_fail';
  if (parameterVersion === 'smart-v3-runner-relaxed-v1.0.0') return 'smart_v3_runner_relaxed';
  if (parameterVersion === config.kolHunterSwingV2ParameterVersion) return 'kol_hunter_swing_v2';
  if (parameterVersion === config.kolHunterRotationV1ParameterVersion) return 'kol_hunter_rotation_v1';
  if (parameterVersion === config.kolHunterRotationUnderfillParameterVersion) return ROTATION_UNDERFILL_ARM;
  if (parameterVersion === config.kolHunterRotationUnderfillCostAwareParameterVersion) return ROTATION_UNDERFILL_COST_AWARE_PROFILE_ARM;
  if (parameterVersion === config.kolHunterRotationExitFlowParameterVersion) return ROTATION_EXIT_FLOW_ARM;
  if (parameterVersion === config.kolHunterRotationChaseTopupParameterVersion) return 'rotation_chase_topup_v1';
  if (parameterVersion === config.kolHunterCapitulationReboundParameterVersion) return CAPITULATION_REBOUND_ARM;
  if (parameterVersion === config.kolHunterCapitulationReboundRrParameterVersion) return CAPITULATION_REBOUND_RR_ARM;
  return 'kol_hunter_v1';
}

interface RotationPaperArmSpec extends DynamicExitParams {
  suffix: string;
  armName: string;
  parameterVersion: string;
  enabled: boolean;
  minPriceResponsePct?: number;
  strictQuality?: boolean;
  flowExit?: boolean;
  profileArm?: string;
  costAwareExit?: boolean;
  costAwareT1MinMfe?: number;
  costAwareT1BufferPct?: number;
  costAwareT1MaxMfe?: number;
  costAwareProfitFloorMult?: number;
  costAwareProfitFloorBufferPct?: number;
}

interface SmartV3PaperArmSpec extends DynamicExitParams {
  suffix: string;
  armName: string;
  parameterVersion: string;
  enabled: boolean;
  extraSurvivalFlags?: string[];
}

interface SmartV3NewPoolContext {
  pairAddress: string;
  discoverySource: string;
  observedAgeSec: number;
}

function resolveSmartV3NewPoolContext(tokenMint: string): SmartV3NewPoolContext | null {
  if (!heliusPoolRegistry) return null;
  const maxAgeSec = config.kolHunterSmartV3NewPoolConfirmedMaxContextAgeSec;
  if (maxAgeSec <= 0) return null;
  const nowMs = Date.now();
  const contexts = heliusPoolRegistry
    .getObservedPairContexts(tokenMint)
    .filter((ctx) => ctx.discoverySource && isPureWsNewPairDiscoverySource(ctx.discoverySource));
  for (const ctx of contexts) {
    const observedAgeSec = Math.max(0, (nowMs - ctx.lastObservedAtMs) / 1000);
    if (observedAgeSec <= maxAgeSec && ctx.discoverySource) {
      return {
        pairAddress: ctx.pairAddress,
        discoverySource: ctx.discoverySource,
        observedAgeSec,
      };
    }
  }
  return null;
}

function buildSmartV3PaperArmSpecs(
  reason: KolEntryReason,
  newPoolContext: SmartV3NewPoolContext | null = null
): SmartV3PaperArmSpec[] {
  if (!config.kolHunterSmartV3PaperArmsEnabled) return [];
  const base = dynamicExitParamsForEntry(reason);
  const baseTrail = base.t1TrailPct ?? config.kolHunterSmartV3T1TrailVelocity;
  const baseFloor = base.t1ProfitFloorMult ?? 1.08;
  const specs: SmartV3PaperArmSpec[] = [
    {
      suffix: 'fast-fail',
      armName: 'smart_v3_fast_fail',
      parameterVersion: 'smart-v3-fast-fail-v1.0.0',
      enabled: config.kolHunterSmartV3FastFailPaperEnabled,
      t1Mfe: base.t1Mfe,
      t1TrailPct: Math.max(0.08, baseTrail * 0.75),
      t1ProfitFloorMult: baseFloor,
      probeFlatTimeoutSec: Math.min(base.probeFlatTimeoutSec ?? 300, 90),
      probeHardCutPct: 0.06,
    },
    {
      suffix: 'runner-relaxed',
      armName: 'smart_v3_runner_relaxed',
      parameterVersion: 'smart-v3-runner-relaxed-v1.0.0',
      enabled: config.kolHunterSmartV3RunnerRelaxedPaperEnabled,
      t1Mfe: base.t1Mfe,
      t1TrailPct: Math.min(0.35, baseTrail + 0.08),
      t1ProfitFloorMult: Math.max(1.03, baseFloor - 0.03),
      probeFlatTimeoutSec: base.probeFlatTimeoutSec,
      probeHardCutPct: base.probeHardCutPct,
    },
  ];
  if (newPoolContext) {
    specs.push({
      suffix: 'new-pool-confirmed',
      armName: 'smart_v3_new_pool_confirmed_v1',
      parameterVersion: config.kolHunterSmartV3NewPoolConfirmedParameterVersion,
      enabled: config.kolHunterSmartV3NewPoolConfirmedPaperEnabled,
      t1Mfe: base.t1Mfe,
      t1TrailPct: Math.min(0.35, baseTrail + 0.05),
      t1ProfitFloorMult: Math.max(1.02, baseFloor - 0.04),
      probeFlatTimeoutSec: base.probeFlatTimeoutSec,
      probeHardCutPct: base.probeHardCutPct,
      extraSurvivalFlags: [
        'SMART_V3_NEW_POOL_CONFIRMED_ARM',
        `SMART_V3_NEW_POOL_SOURCE_${newPoolContext.discoverySource.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
        `SMART_V3_NEW_POOL_CONTEXT_AGE_${Math.round(newPoolContext.observedAgeSec)}S`,
      ],
    });
  }
  return specs;
}

function buildRotationPaperArmSpecs(primaryVersion: string): RotationPaperArmSpec[] {
  if (!config.kolHunterRotationPaperArmsEnabled) return [];
  const flowSpec: RotationPaperArmSpec = {
    suffix: 'exit-flow',
    armName: ROTATION_EXIT_FLOW_ARM,
    parameterVersion: config.kolHunterRotationExitFlowParameterVersion,
    enabled: config.kolHunterRotationExitFlowPaperEnabled,
    t1Mfe: config.kolHunterRotationUnderfillT1Mfe,
    t1TrailPct: config.kolHunterRotationUnderfillT1TrailPct,
    t1ProfitFloorMult: config.kolHunterRotationUnderfillProfitFloorMult,
    probeFlatTimeoutSec: config.kolHunterRotationUnderfillProbeTimeoutSec,
    probeHardCutPct: config.kolHunterRotationUnderfillHardCutPct,
    rotationDoaWindowSec: config.kolHunterRotationUnderfillDoaWindowSec,
    rotationDoaMinMfePct: config.kolHunterRotationUnderfillDoaMinMfePct,
    rotationDoaMaxMaePct: config.kolHunterRotationUnderfillDoaMaxMaePct,
    flowExit: true,
  };
  const underfillCostAwareSpec: RotationPaperArmSpec = {
    suffix: 'cost-aware-exit',
    armName: ROTATION_UNDERFILL_COST_AWARE_PROFILE_ARM,
    profileArm: ROTATION_UNDERFILL_COST_AWARE_PROFILE_ARM,
    parameterVersion: config.kolHunterRotationUnderfillCostAwareParameterVersion,
    enabled: config.kolHunterRotationUnderfillCostAwarePaperEnabled,
    t1Mfe: config.kolHunterRotationUnderfillCostAwareT1MinMfe,
    t1TrailPct: config.kolHunterRotationUnderfillCostAwareT1TrailPct,
    t1ProfitFloorMult: config.kolHunterRotationUnderfillCostAwareProfitFloorMult,
    probeFlatTimeoutSec: config.kolHunterRotationUnderfillCostAwareProbeTimeoutSec,
    probeHardCutPct: config.kolHunterRotationUnderfillCostAwareHardCutPct,
    rotationDoaWindowSec: config.kolHunterRotationUnderfillDoaWindowSec,
    rotationDoaMinMfePct: config.kolHunterRotationUnderfillDoaMinMfePct,
    rotationDoaMaxMaePct: config.kolHunterRotationUnderfillDoaMaxMaePct,
    flowExit: true,
    costAwareExit: true,
    costAwareT1MinMfe: config.kolHunterRotationUnderfillCostAwareT1MinMfe,
    costAwareT1BufferPct: config.kolHunterRotationUnderfillCostAwareT1BufferPct,
    costAwareT1MaxMfe: config.kolHunterRotationUnderfillCostAwareT1MaxMfe,
    costAwareProfitFloorMult: config.kolHunterRotationUnderfillCostAwareProfitFloorMult,
    costAwareProfitFloorBufferPct: config.kolHunterRotationUnderfillCostAwareProfitFloorBufferPct,
  };
  if (primaryVersion === config.kolHunterRotationUnderfillParameterVersion) {
    return [flowSpec, underfillCostAwareSpec];
  }
  return [
    {
      suffix: 'fast15',
      armName: 'rotation_fast15_v1',
      parameterVersion: 'rotation-fast15-v1.0.0',
      enabled: config.kolHunterRotationFast15PaperEnabled,
      t1Mfe: config.kolHunterRotationFast15T1Mfe,
      t1TrailPct: config.kolHunterRotationFast15T1TrailPct,
      t1ProfitFloorMult: config.kolHunterRotationFast15ProfitFloorMult,
      probeFlatTimeoutSec: config.kolHunterRotationFast15ProbeTimeoutSec,
      probeHardCutPct: config.kolHunterRotationFast15HardCutPct,
      rotationDoaWindowSec: config.kolHunterRotationFast15DoaWindowSec,
      rotationDoaMinMfePct: config.kolHunterRotationFast15DoaMinMfePct,
      rotationDoaMaxMaePct: config.kolHunterRotationFast15DoaMaxMaePct,
    },
    {
      suffix: 'cost-guard',
      armName: 'rotation_cost_guard_v1',
      parameterVersion: 'rotation-cost-guard-v1.0.0',
      enabled: config.kolHunterRotationCostGuardPaperEnabled,
      t1Mfe: config.kolHunterRotationCostGuardT1Mfe,
      t1TrailPct: config.kolHunterRotationCostGuardT1TrailPct,
      t1ProfitFloorMult: config.kolHunterRotationCostGuardProfitFloorMult,
      probeFlatTimeoutSec: config.kolHunterRotationCostGuardProbeTimeoutSec,
      probeHardCutPct: config.kolHunterRotationCostGuardHardCutPct,
      rotationDoaWindowSec: config.kolHunterRotationCostGuardDoaWindowSec,
      rotationDoaMinMfePct: config.kolHunterRotationCostGuardDoaMinMfePct,
      rotationDoaMaxMaePct: config.kolHunterRotationCostGuardDoaMaxMaePct,
      minPriceResponsePct: config.kolHunterRotationCostGuardMinPriceResponsePct,
    },
    {
      suffix: 'quality-strict',
      armName: 'rotation_quality_strict_v1',
      parameterVersion: 'rotation-quality-strict-v1.0.0',
      enabled: config.kolHunterRotationQualityStrictPaperEnabled,
      t1Mfe: config.kolHunterRotationQualityStrictT1Mfe,
      t1TrailPct: config.kolHunterRotationQualityStrictT1TrailPct,
      t1ProfitFloorMult: config.kolHunterRotationQualityStrictProfitFloorMult,
      probeFlatTimeoutSec: config.kolHunterRotationQualityStrictProbeTimeoutSec,
      probeHardCutPct: config.kolHunterRotationQualityStrictHardCutPct,
      rotationDoaWindowSec: config.kolHunterRotationQualityStrictDoaWindowSec,
      rotationDoaMinMfePct: config.kolHunterRotationQualityStrictDoaMinMfePct,
      rotationDoaMaxMaePct: config.kolHunterRotationQualityStrictDoaMaxMaePct,
      strictQuality: true,
    },
    flowSpec,
  ];
}

function rotationPriceResponsePct(entryPrice: number, anchorPrice?: number): number | undefined {
  if (!anchorPrice || anchorPrice <= 0 || !Number.isFinite(anchorPrice)) return undefined;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return undefined;
  return entryPrice / anchorPrice - 1;
}

function isRotationStrictQualityRiskFlag(flag: string): boolean {
  const upper = flag.toUpperCase();
  return upper === 'EXIT_LIQUIDITY_UNKNOWN' ||
    upper === 'NO_HELIUS_PROVENANCE' ||
    upper === 'NO_SECURITY_DATA' ||
    upper === 'TOKEN_2022' ||
    upper.startsWith('EXT_') ||
    upper.startsWith('UNCLEAN_TOKEN') ||
    upper.startsWith('HOLDER_') ||
    upper.includes('HIGH_CONCENTRATION') ||
    upper.includes('RUG') ||
    upper.includes('NO_SELL_ROUTE');
}

function rotationPaperArmRejectReason(
  spec: RotationPaperArmSpec,
  entryPrice: number,
  anchorPrice: number | undefined,
  survivalFlags: string[]
): string | undefined {
  if (!spec.enabled) return 'disabled';
  const priceResponsePct = rotationPriceResponsePct(entryPrice, anchorPrice);
  if (
    typeof spec.minPriceResponsePct === 'number' &&
    (priceResponsePct == null || priceResponsePct < spec.minPriceResponsePct)
  ) {
    return 'cost_response_too_low';
  }
  if (spec.strictQuality && survivalFlags.some(isRotationStrictQualityRiskFlag)) {
    return 'quality_risk_flag';
  }
  return undefined;
}

function applyRotationPaperArmSpec(pos: PaperPosition, spec: RotationPaperArmSpec): void {
  const parentArmName = pos.armName;
  pos.armName = spec.armName;
  pos.parameterVersion = spec.parameterVersion;
  pos.entryArm = pos.entryArm ?? parentArmName;
  pos.exitArm = spec.flowExit === true ? spec.armName : pos.exitArm ?? spec.armName;
  if (spec.profileArm) {
    pos.profileArm = spec.profileArm;
  } else if (spec.flowExit === true && parentArmName === ROTATION_UNDERFILL_ARM) {
    pos.profileArm = ROTATION_UNDERFILL_EXIT_FLOW_PROFILE_ARM;
  }
  pos.kolEntryReason = 'rotation_v1';
  pos.kolConvictionLevel = 'MEDIUM_HIGH';
  pos.t1MfeOverride = spec.t1Mfe;
  pos.t1TrailPctOverride = spec.t1TrailPct;
  pos.t1ProfitFloorMult = spec.t1ProfitFloorMult;
  pos.probeFlatTimeoutSec = spec.probeFlatTimeoutSec;
  pos.probeHardCutPctOverride = spec.probeHardCutPct;
  pos.rotationDoaWindowSecOverride = spec.rotationDoaWindowSec;
  pos.rotationDoaMinMfePctOverride = spec.rotationDoaMinMfePct;
  pos.rotationDoaMaxMaePctOverride = spec.rotationDoaMaxMaePct;
  pos.rotationFlowExitEnabled = spec.flowExit === true;
  const costAwareFlags: string[] = [];
  if (spec.costAwareExit) {
    const rawRequiredGrossMove = pos.rotationMonetizableEdge?.requiredGrossMovePct ?? pos.rotationMonetizableEdge?.costRatio;
    const requiredGrossMove = typeof rawRequiredGrossMove === 'number' && Number.isFinite(rawRequiredGrossMove)
      ? Math.max(0, rawRequiredGrossMove)
      : 0;
    const minT1 = spec.costAwareT1MinMfe ?? spec.t1Mfe ?? 0.12;
    const maxT1 = spec.costAwareT1MaxMfe ?? Math.max(minT1, 0.18);
    const t1Buffer = spec.costAwareT1BufferPct ?? 0.03;
    const floorBuffer = spec.costAwareProfitFloorBufferPct ?? 0.02;
    const baseFloor = spec.costAwareProfitFloorMult ?? spec.t1ProfitFloorMult ?? 1.10;
    const costAwareT1 = Math.min(maxT1, Math.max(minT1, requiredGrossMove + t1Buffer));
    const rawCostAwareFloor = Math.max(baseFloor, 1 + requiredGrossMove + floorBuffer);
    const maxExecutableFloor = 1 + costAwareT1;
    const costAwareFloor = Math.min(rawCostAwareFloor, maxExecutableFloor);
    pos.t1MfeOverride = costAwareT1;
    pos.t1ProfitFloorMult = costAwareFloor;
    costAwareFlags.push(
      'ROTATION_COST_AWARE_EXIT_V2',
      `ROTATION_COST_AWARE_REQUIRED_GROSS_${requiredGrossMove.toFixed(3)}`,
      `ROTATION_COST_AWARE_T1_${costAwareT1.toFixed(3)}`,
      `ROTATION_COST_AWARE_FLOOR_${costAwareFloor.toFixed(3)}`,
      ...(rawCostAwareFloor > maxExecutableFloor ? ['ROTATION_COST_AWARE_FLOOR_CAPPED_TO_T1'] : [])
    );
  }
  pos.survivalFlags = [
    ...pos.survivalFlags,
    'ROTATION_V1_PAPER_PARAM_ARM',
    `ROTATION_V1_PAPER_ARM_${spec.suffix.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
    ...costAwareFlags,
  ];
}

function applySmartV3PaperArmSpec(pos: PaperPosition, spec: SmartV3PaperArmSpec): void {
  pos.armName = spec.armName;
  pos.parameterVersion = spec.parameterVersion;
  pos.t1MfeOverride = spec.t1Mfe;
  pos.t1TrailPctOverride = spec.t1TrailPct;
  pos.t1ProfitFloorMult = spec.t1ProfitFloorMult;
  pos.probeFlatTimeoutSec = spec.probeFlatTimeoutSec;
  pos.probeHardCutPctOverride = spec.probeHardCutPct;
  pos.survivalFlags = [
    ...pos.survivalFlags,
    'SMART_V3_PAPER_PARAM_ARM',
    `SMART_V3_PAPER_ARM_${spec.suffix.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
    ...(spec.extraSurvivalFlags ?? []),
  ];
}

function defaultEntryReasonForVersion(parameterVersion: string): KolEntryReason {
  if (parameterVersion === config.kolHunterSmartV3ParameterVersion || parameterVersion.startsWith('smart-v3-')) return 'velocity';
  if (parameterVersion === config.kolHunterSwingV2ParameterVersion) return 'swing_v2';
  if (parameterVersion === config.kolHunterRotationV1ParameterVersion) return 'rotation_v1';
  if (parameterVersion === config.kolHunterRotationUnderfillParameterVersion) return 'rotation_v1';
  if (parameterVersion === config.kolHunterRotationExitFlowParameterVersion) return 'rotation_v1';
  if (parameterVersion === config.kolHunterRotationChaseTopupParameterVersion) return 'rotation_v1';
  if (isCapitulationParameterVersion(parameterVersion)) return 'capitulation_rebound';
  return 'legacy_v1';
}

function defaultConvictionForVersion(parameterVersion: string): KolConvictionLevel {
  if (parameterVersion === config.kolHunterSmartV3ParameterVersion || parameterVersion.startsWith('smart-v3-')) return 'MEDIUM_HIGH';
  if (parameterVersion === config.kolHunterSwingV2ParameterVersion) return 'HIGH';
  if (parameterVersion === config.kolHunterRotationV1ParameterVersion) return 'MEDIUM_HIGH';
  if (parameterVersion === config.kolHunterRotationUnderfillParameterVersion) return 'MEDIUM_HIGH';
  if (parameterVersion === config.kolHunterRotationExitFlowParameterVersion) return 'MEDIUM_HIGH';
  if (parameterVersion === config.kolHunterRotationChaseTopupParameterVersion) return 'MEDIUM_HIGH';
  if (isCapitulationParameterVersion(parameterVersion)) return 'MEDIUM_HIGH';
  return 'LOW';
}

function dynamicExitParamsForEntry(reason: KolEntryReason): DynamicExitParams {
  switch (reason) {
    case 'pullback_and_velocity':
      return {
        t1Mfe: config.kolHunterSmartV3T1ThresholdHigh,
        t1TrailPct: config.kolHunterSmartV3T1TrailBoth,
        t1ProfitFloorMult: config.kolHunterSmartV3ProfitFloorBoth,
        probeFlatTimeoutSec: config.kolHunterSmartV3ProbeTimeoutBothSec,
      };
    case 'pullback':
      return {
        t1Mfe: config.kolHunterSmartV3T1ThresholdHigh,
        t1TrailPct: config.kolHunterSmartV3T1TrailPullback,
        t1ProfitFloorMult: config.kolHunterSmartV3ProfitFloorPullback,
        probeFlatTimeoutSec: config.kolHunterSmartV3ProbeTimeoutPullbackSec,
      };
    case 'velocity':
      return {
        t1Mfe: config.kolHunterT1Mfe,
        t1TrailPct: config.kolHunterSmartV3T1TrailVelocity,
        t1ProfitFloorMult: config.kolHunterSmartV3ProfitFloorVelocity,
        probeFlatTimeoutSec: config.kolHunterSmartV3ProbeTimeoutVelocitySec,
      };
    case 'rotation_v1':
      return {
        t1Mfe: config.kolHunterRotationV1T1Mfe,
        t1TrailPct: config.kolHunterRotationV1T1TrailPct,
        t1ProfitFloorMult: config.kolHunterRotationV1ProfitFloorMult,
        probeFlatTimeoutSec: config.kolHunterRotationV1ProbeTimeoutSec,
      };
    case 'capitulation_rebound':
      return {
        t1Mfe: config.kolHunterCapitulationReboundT1Mfe,
        t1TrailPct: config.kolHunterCapitulationReboundT1TrailPct,
        t1ProfitFloorMult: config.kolHunterCapitulationReboundProfitFloorMult,
        probeFlatTimeoutSec: config.kolHunterCapitulationReboundProbeTimeoutSec,
        probeHardCutPct: config.kolHunterCapitulationReboundHardCutPct,
      };
    default:
      return {};
  }
}

function dynamicExitParamsForPosition(parameterVersion: string, reason: KolEntryReason): DynamicExitParams {
  if (
    parameterVersion === config.kolHunterRotationUnderfillParameterVersion ||
    parameterVersion === config.kolHunterRotationExitFlowParameterVersion ||
    parameterVersion === config.kolHunterRotationChaseTopupParameterVersion
  ) {
    return {
      t1Mfe: config.kolHunterRotationUnderfillT1Mfe,
      t1TrailPct: config.kolHunterRotationUnderfillT1TrailPct,
      t1ProfitFloorMult: config.kolHunterRotationUnderfillProfitFloorMult,
      probeFlatTimeoutSec: config.kolHunterRotationUnderfillProbeTimeoutSec,
      probeHardCutPct: config.kolHunterRotationUnderfillHardCutPct,
      rotationDoaWindowSec: config.kolHunterRotationUnderfillDoaWindowSec,
      rotationDoaMinMfePct: config.kolHunterRotationUnderfillDoaMinMfePct,
      rotationDoaMaxMaePct: config.kolHunterRotationUnderfillDoaMaxMaePct,
    };
  }
  if (
    parameterVersion === config.kolHunterSmartV3ParameterVersion ||
    parameterVersion === config.kolHunterSmartV3QualityUnknownMicroParameterVersion ||
    parameterVersion === config.kolHunterSmartV3FastCanaryParameterVersion ||
    parameterVersion === config.kolHunterSmartV3FastFailLiveParameterVersion ||
    parameterVersion === config.kolHunterRotationV1ParameterVersion ||
    isCapitulationParameterVersion(parameterVersion)
  ) {
    return dynamicExitParamsForEntry(reason);
  }
  return {};
}

function countActivePrimaryPositions(): number {
  return [...active.values()].filter((p) => !p.isShadowArm).length;
}

function appendParticipatingKol(pos: PaperPosition, tx: KolTx): void {
  if (!pos.participatingKols.find((k) => k.id === tx.kolId)) {
    pos.participatingKols.push({ id: tx.kolId, tier: tx.tier, timestamp: tx.timestamp });
  }
}

function applySmartV3Reinforcement(pos: PaperPosition, tx: KolTx): void {
  appendParticipatingKol(pos, tx);
  if (!isSmartV3Position(pos)) return;
  pos.kolReinforcementCount += 1;

  // 2026-04-28 (P2 fix): trail buildup 을 style-aware 로 변경 — buildup/reduce 비대칭 해결.
  // 이전: 모든 KOL buy → trail += inc (style 무관). Phase 1 의 lower_confidence (scalper sell)
  //   가 trail -= inc 했는데 scalper buy 가 다시 trail += inc → 정책 효과 약화.
  // 수정: scalper KOL buy 는 trail 변경 안 함 (reinforcementCount 만 +1). longhold/swing/unknown
  //   buy 만 trail buildup. unknown 은 보수적 fallback (기존 default 보존, 운영자 분류 후 점진).
  const buyerStyle = getKolTradingStyle(tx.kolId);
  if (buyerStyle === 'scalper') {
    log.info(
      `[KOL_REINFORCEMENT] ${pos.positionId} +1 from kol=${tx.kolId} tier=${tx.tier} (scalper — trail unchanged)`
    );
    return;
  }
  const nextTrail = Math.min(
    config.kolHunterSmartV3ReinforcementTrailMax,
    (pos.t1TrailPctOverride ?? config.kolHunterT1TrailPct) + config.kolHunterSmartV3ReinforcementTrailInc
  );
  pos.t1TrailPctOverride = nextTrail;
  log.info(
    `[KOL_REINFORCEMENT] ${pos.positionId} +1 from kol=${tx.kolId} tier=${tx.tier} style=${buyerStyle} ` +
    `trail=${(nextTrail * 100).toFixed(1)}% floor=${pos.t1ProfitFloorMult ?? 'none'}`
  );
}

// ─── Init / Shutdown ─────────────────────────────────────

export function initKolHunter(
  options: {
    priceFeed?: PaperPriceFeed;
    securityClient?: OnchainSecurityClient;
    gateCache?: GateCacheManager;
    ctx?: BotContext;
    // 2026-05-01 (Helius Stream X1): pool registry inject for EXIT/POOL flag accuracy.
    heliusPoolRegistry?: HeliusPoolRegistry;
  } = {}
): void {
  if (ownedGateCache) {
    ownedGateCache.destroy();
    ownedGateCache = undefined;
  }
  if (options.heliusPoolRegistry) {
    heliusPoolRegistry = options.heliusPoolRegistry;
  }
  // 기존에 set 된 registry 는 유지 (setHeliusPoolRegistry 로 별도 inject 가능).
  priceFeed = options.priceFeed ?? new PaperPriceFeed({
    jupiterApiUrl: config.jupiterApiUrl,
    jupiterApiKey: config.jupiterApiKey,
    probeSolAmount: 0.01,
  });
  securityClient = options.securityClient;
  if (options.gateCache) {
    gateCache = options.gateCache;
  } else if (securityClient) {
    ownedGateCache = new GateCacheManager(30_000);
    gateCache = ownedGateCache;
  } else {
    gateCache = undefined;
  }
  // 2026-04-27 (KOL live canary): ctx 주입 — live path (executeBuy/executeSell, DB persist) 에 필요.
  // paper-only 경로는 ctx 없어도 동작. live 가능 여부는 isLiveCanaryEnabled() 가 ctx 존재 + 3 flag 모두 검증.
  botCtx = options.ctx;
  const liveCapable = botCtx != null
    && config.kolHunterLiveCanaryEnabled
    && !config.kolHunterPaperOnly
    && botCtx.tradingMode === 'live';
  log.info(
    `[KOL_HUNTER] initialized — paperOnly=${config.kolHunterPaperOnly} ` +
    `survival=${securityClient ? 'enabled' : 'skipped (no client)'} ` +
    `liveCanary=${liveCapable ? 'ENABLED (live wallet exposure)' : 'disabled'} ` +
    `liveCanaryArms=${configuredLiveCanaryArmsForLog()} ` +
    `liveCanaryArmMode=${hasExplicitLiveCanaryArmPortfolio() ? 'explicit' : 'legacy'}`
  );
}

// ─── Live canary helpers (2026-04-27, Phase 5 P1-9~14) ───────────────
/**
 * 3-flag triple gate. 어느 하나라도 false 면 live wallet 영향 0 (paper fallback).
 * - kolHunterLiveCanaryEnabled (env, default false)
 * - !kolHunterPaperOnly (env, default true → must explicit set false)
 * - tradingMode === 'live' (env)
 * + botCtx 주입 + executor available
 */
function isLiveCanaryActive(): boolean {
  if (!botCtx) return false;
  if (botCtx.tradingMode !== 'live') return false;
  if (config.kolHunterPaperOnly) return false;
  if (!config.kolHunterLiveCanaryEnabled) return false;
  return true;
}

type KolLiveCanaryArm =
  | 'smart_v3_clean'
  | 'smart_v3_quality_unknown_micro'
  | 'smart_v3_fast_canary_v1'
  | 'smart_v3_fast_fail_live_v1'
  | 'rotation_v1'
  | 'rotation_chase_topup_v1'
  | 'rotation_underfill_v1'
  | 'rotation_underfill_exit_flow_v1';

function normalizedLiveCanaryArmSet(): Set<string> {
  const configured = Array.isArray(config.kolHunterLiveCanaryArms)
    ? config.kolHunterLiveCanaryArms
    : [];
  return new Set(
    configured
      .map((arm) => arm.trim().toLowerCase())
      .filter((arm) => arm.length > 0)
  );
}

function hasExplicitLiveCanaryArmPortfolio(): boolean {
  return normalizedLiveCanaryArmSet().size > 0;
}

function isKolLiveCanaryArmEnabled(arm: KolLiveCanaryArm): boolean {
  const explicit = normalizedLiveCanaryArmSet();
  if (explicit.size > 0) return explicit.has(arm);
  switch (arm) {
    case 'smart_v3_clean':
      return config.kolHunterSmartV3LiveEnabled;
    case 'smart_v3_quality_unknown_micro':
      return false;
    case 'smart_v3_fast_canary_v1':
      return false;
    case 'smart_v3_fast_fail_live_v1':
      return false;
    case 'rotation_v1':
      return config.kolHunterRotationV1LiveEnabled;
    case 'rotation_chase_topup_v1':
      return config.kolHunterRotationChaseTopupLiveCanaryEnabled;
    case 'rotation_underfill_v1':
      return config.kolHunterRotationUnderfillLiveCanaryEnabled;
    case 'rotation_underfill_exit_flow_v1':
      return config.kolHunterRotationUnderfillLiveCanaryEnabled &&
        config.kolHunterRotationUnderfillLiveExitFlowEnabled;
  }
}

function isRotationUnderfillExitFlowLiveCanaryEnabled(): boolean {
  const explicit = normalizedLiveCanaryArmSet();
  if (explicit.size > 0) return explicit.has(ROTATION_UNDERFILL_EXIT_FLOW_PROFILE_ARM);
  return config.kolHunterRotationUnderfillLiveCanaryEnabled &&
    config.kolHunterRotationUnderfillLiveExitFlowEnabled;
}

function isRotationUnderfillLiveCanaryEnabled(): boolean {
  return isKolLiveCanaryArmEnabled('rotation_underfill_v1') ||
    isRotationUnderfillExitFlowLiveCanaryEnabled();
}

function rotationUnderfillLiveProfileArm(): string | undefined {
  if (isRotationUnderfillExitFlowLiveCanaryEnabled()) {
    return ROTATION_UNDERFILL_EXIT_FLOW_PROFILE_ARM;
  }
  return undefined;
}

function configuredLiveCanaryArmsForLog(): string {
  const explicit = normalizedLiveCanaryArmSet();
  if (explicit.size > 0) return [...explicit].sort().join(',');
  const legacy: string[] = [];
  if (config.kolHunterSmartV3LiveEnabled) legacy.push('smart_v3_clean');
  if (config.kolHunterRotationV1LiveEnabled) legacy.push('rotation_v1');
  if (config.kolHunterRotationChaseTopupLiveCanaryEnabled) legacy.push('rotation_chase_topup_v1');
  if (config.kolHunterRotationUnderfillLiveCanaryEnabled) {
    legacy.push(config.kolHunterRotationUnderfillLiveExitFlowEnabled
      ? 'rotation_underfill_exit_flow_v1'
      : 'rotation_underfill_v1');
  }
  return legacy.length > 0 ? legacy.join(',') : 'none';
}

function getLiveCanaryInactiveReason(candIsShadow: boolean): { reason: string; flag: string } | null {
  if (!botCtx) return { reason: 'bot_ctx_missing', flag: 'LIVE_GATE_BOT_CTX_MISSING' };
  if (botCtx.tradingMode !== 'live') return { reason: 'trading_mode_not_live', flag: 'LIVE_GATE_TRADING_MODE_NOT_LIVE' };
  if (config.kolHunterPaperOnly) return { reason: 'kol_hunter_paper_only', flag: 'LIVE_GATE_KOL_HUNTER_PAPER_ONLY' };
  if (!config.kolHunterLiveCanaryEnabled) return { reason: 'kol_live_canary_disabled', flag: 'LIVE_GATE_KOL_CANARY_DISABLED' };
  if (candIsShadow) return { reason: 'shadow_candidate', flag: 'LIVE_GATE_SHADOW_CANDIDATE' };
  return null;
}

/** Live canary 의 wallet executor 결정. 현 phase 5 P1-15: main wallet 사용.
 *  추후 KOL_HUNTER_WALLET_MODE env 추가 가능 (sandbox / main). */
function getKolHunterExecutor(ctx: BotContext) {
  return ctx.executor;
}

export function stopKolHunter(): void {
  for (const [mint, listener] of priceListeners) {
    priceFeed?.off('price', listener);
    priceFeed?.unsubscribe(mint);
  }
  priceListeners.clear();
  priceFeed?.stopAll();
  priceFeed = null;
  for (const c of pending.values()) clearTimeout(c.timer);
  pending.clear();
  active.clear();
  activeByMint.clear();   // P1 #5: index 동기화
  recentKolTxs.length = 0;
  pushesSinceLastPrune = 0;
  scoreCache.clear();     // P1 #7: score cache 동기화
  rotationV1RecentTxsByMint.clear();
  rotationV1PreObserveBlockLogKeys.clear();
  rotationV1ConfigLogged = false;
  smartV3SellCancelByMint.clear();
  if (ownedGateCache) {
    ownedGateCache.destroy();
    ownedGateCache = undefined;
  }
  gateCache = undefined;
  securityClient = undefined;
  botCtx = undefined;
}

export function getKolHunterState(): {
  pending: number;
  active: number;
  closed: number;
  tiersByState: Record<LaneTState, number>;
} {
  const tiersByState: Record<LaneTState, number> = {
    STALK: 0, PROBE: 0, RUNNER_T1: 0, RUNNER_T2: 0, RUNNER_T3: 0, TAIL: 0, CLOSED: 0,
  };
  for (const pos of active.values()) tiersByState[pos.state] = (tiersByState[pos.state] ?? 0) + 1;
  return {
    pending: pending.size,
    active: countActivePrimaryPositions(),
    closed: 0, // in-memory closed 제거, ledger 가 누적
    tiersByState,
  };
}

export function getActiveKolHunterPositionsSnapshot(): PaperPosition[] {
  return [...active.values()].map((pos) => ({
    ...pos,
    participatingKols: pos.participatingKols.map((kol) => ({ ...kol })),
    survivalFlags: [...pos.survivalFlags],
  }));
}

// ─── Entry Point ─────────────────────────────────────────

/**
 * KolWalletTracker 에서 'kol_swap' event 수신 시 호출.
 */
export async function handleKolSwap(tx: KolTx): Promise<void> {
  if (!config.kolHunterEnabled) return;
  logRotationV1ConfigOnce();
  recordRotationV1Intake(tx);

  // 2026-04-26 paper notifier L1: discovery 카운팅 (kolPaperNotifier 가 hourly digest 에 사용)
  kolHunterEvents.emit('discovery', tx);

  // 2026-04-29: token symbol prefetch (Helius DAS + pump.fun fallback, 24h cache).
  // KOL signal 첫 만남 시 fire-and-forget 으로 resolve → entry 까지 5-30s 사이 cache populate.
  // 알림 발사 시점엔 lookupCachedSymbol() 만 사용 (RPC 차단 0).
  // F3 fix (2026-04-29 QA): cache hit 시 함수 진입 자체 skip — burst (KOL squad) 시 5명 동시 buy 도 1회만 호출.
  if (tx.action === 'buy' && !lookupCachedSymbol(tx.tokenMint)) {
    void resolveTokenSymbol(tx.tokenMint).catch(() => {});
  }

  // recent buffer 유지 (24h). audit fix #2: batch prune (매 1024 push 마다, splice 1회).
  recentKolTxs.push(tx);
  pushesSinceLastPrune++;
  if (pushesSinceLastPrune >= RECENT_TX_PRUNE_BATCH) {
    pruneRecentKolTxsByCutoff(Date.now() - config.kolScoringWindowMs);
    pushesSinceLastPrune = 0;
  }

  if (tx.action === 'sell') {
    await handleKolSellSignal(tx);
    return;
  }

  const existingPending = pending.get(tx.tokenMint);
  if (existingPending) {
    const activeBeforeEvaluate = getActivePositionsByMint(tx.tokenMint);
    existingPending.kolTxs.push(tx);
    if (existingPending.smartV3) {
      await evaluateSmartV3Triggers(existingPending);
    }
    if (activeBeforeEvaluate.length > 0) {
      for (const pos of activeBeforeEvaluate) applySmartV3Reinforcement(pos, tx);
    }
    return;
  }

  // Active 또는 pending 이미 있으면 추가 KOL 만 집계 (P1 #5: O(1) lookup)
  const existingActive = getActivePositionsByMint(tx.tokenMint);
  if (existingActive.length > 0) {
    // 이미 진입한 포지션에 추가 KOL 은 정보만 누적 (sizing 변경 없음).
    // v1 + swing shadow 가 동시에 떠 있으면 두 arm 모두 동일 discovery context 를 유지한다.
    for (const pos of existingActive) applySmartV3Reinforcement(pos, tx);
    return;
  }

  // REFACTORING §2.1 hard constraint: max concurrent (Lane T 단독 상한).
  // 전역 3 은 canaryConcurrencyGuard 관할 — Phase 4 에서 연결 예정.
  const activePrimaryMints = new Set(
    [...active.values()]
      .filter((p) => !p.isShadowArm)
      .map((p) => p.tokenMint)
  );
  const pendingOnlyCount = [...pending.keys()].filter((mint) => !activePrimaryMints.has(mint)).length;
  const laneConcurrentBudget = activePrimaryMints.size + pendingOnlyCount;
  if (laneConcurrentBudget >= config.kolHunterMaxConcurrent) {
    log.info(
      `[KOL_HUNTER_SKIP] max concurrent (activeMints=${activePrimaryMints.size} pendingOnly=${pendingOnlyCount} ` +
      `>= cap=${config.kolHunterMaxConcurrent}) — ${tokenMint(tx)} ${tx.kolId}`
    );
    trackKolHunterAdmissionSkipMarkout(tx, 'max_concurrent', {
      activeMints: activePrimaryMints.size,
      pendingOnly: pendingOnlyCount,
      cap: config.kolHunterMaxConcurrent,
    });
    return;
  }

  // 신규 pending candidate 생성 + stalk/observe window 시작
  if (config.kolHunterSmartV3Enabled) {
    await registerSmartV3Pending(tx);
  } else {
    await registerPending(tx);
  }
}

function tokenMint(tx: KolTx): string {
  return tx.tokenMint.slice(0, 8);
}

/**
 * 2026-04-28 (Phase 1): Style-aware insider_exit decision.
 *
 * Why: 외부 피드백 + GUfyGEF6 incident 정합. kev (5분 flip scalper) sell 한 건이 bflg
 *   (13일 hold copy_core) thesis 까지 청산하는 mismatch 차단.
 *
 * Decision tree (input: position 의 진입 KOL 들 + sell 한 KOL 의 lane_role/style):
 *   1) sell 한 KOL 이 'observer' lane → 무시 (entry 대상도 아니므로 close 도 trigger 안 함).
 *   2) sell 한 KOL 이 'scalper' style + position 의 다른 진입 KOL 중 'longhold/swing' 있음
 *      → confidence 하향만 (close 안 함). scalper sell 은 short-term flip 신호.
 *   3) sell 한 KOL 이 'longhold' or 'swing' style (copy_core/canary 무관)
 *      → close. 의미 있는 exit 신호.
 *   4) sell 한 KOL 이 lane_role/style 모두 'unknown' → close (보수적 fallback, 기존 default).
 *   5) Position 의 모든 진입 KOL 이 scalper 면 어쨌든 close (cohort 자체가 short-term).
 *
 * 'unknown' fallback 정책: KOL DB 의 운영자 manual 분류 (Phase 0A) 가 완료되기 전엔 거의 모든
 *   KOL 이 unknown 이라 기존 behavior 보존. 분류 누적될수록 점진적 정확도 향상.
 */
type InsiderExitAction = 'close' | 'lower_confidence' | 'ignore';

export function evaluateInsiderExitDecision(
  pos: PaperPosition,
  sellingKolId: string
): { action: InsiderExitAction; reason: string } {
  const sellingRole = getKolLaneRole(sellingKolId);
  const sellingStyle = getKolTradingStyle(sellingKolId);

  // (1) Observer 는 trigger 안 줌. 단 entry 도 안 줘야 정합 — observer KOL 이 진입 KOL 에 있는
  //     것 자체가 misconfiguration. 안전: ignore (close 도 안 함, 다른 진입 KOL 의 신호 대기).
  if (sellingRole === 'observer') {
    return { action: 'ignore', reason: `kol=${sellingKolId} is observer-only` };
  }

  // (5) 모든 진입 KOL 이 scalper 면 cohort 자체가 short-term — sell 은 그대로 따라감.
  const allScalper = pos.participatingKols.length > 0
    && pos.participatingKols.every((k) => getKolTradingStyle(k.id) === 'scalper');
  if (allScalper) {
    return { action: 'close', reason: `all-scalper cohort, follow sell` };
  }

  // (2) Scalper sell + position 에 longhold/swing 진입 KOL 있음 → confidence 하향만.
  //     scalper 의 5분 flip 신호로 swing thesis 청산 방지.
  if (sellingStyle === 'scalper') {
    const hasNonScalper = pos.participatingKols.some((k) => {
      const s = getKolTradingStyle(k.id);
      return s === 'longhold' || s === 'swing';
    });
    if (hasNonScalper) {
      return { action: 'lower_confidence', reason: `scalper sell ignored (longhold/swing in cohort)` };
    }
  }

  // (3) Longhold / swing sell → close.
  if (sellingStyle === 'longhold' || sellingStyle === 'swing') {
    return { action: 'close', reason: `${sellingStyle} kol sell` };
  }

  // (4) Unknown fallback — 보수적으로 close (기존 default behavior 보존).
  return { action: 'close', reason: `unknown style, conservative close` };
}

async function handleKolSellSignal(tx: KolTx): Promise<void> {
  invalidateSmartV3LiveHardCutReentryOnSell(tx);
  const cand = pending.get(tx.tokenMint);
  const positions = getActivePositionsByMint(tx.tokenMint).filter((p) =>
    p.participatingKols.some((k) => k.id === tx.kolId) ||
    (
      isRotationV1Position(p) &&
      (p.rotationAnchorKols ?? []).some((id) => id.toLowerCase() === tx.kolId.toLowerCase())
    )
  );
  if (
    positions.length === 0 &&
    cand &&
    (cand.smartV3 || config.kolHunterSmartV3Enabled) &&
    cand.kolTxs.some((buy) => buy.kolId === tx.kolId)
  ) {
    pending.delete(tx.tokenMint);
    cleanupPendingCandidate(cand, true);
    const score = computeKolDiscoveryScoreCached(tx.tokenMint, Date.now());  // P1 #7
    markSmartV3SellCancel(tx.tokenMint);
    log.info(`[KOL_HUNTER_SMART_V3_CANCEL] ${tokenMint(tx)} kol=${tx.kolId} sell during observe`);
    fireRejectObserver(tx.tokenMint, 'smart_v3_kol_sell_cancel', cand, score);
    return;
  }

  if (positions.length === 0) {
    log.debug(`[KOL_HUNTER] sell ${tx.kolId} ${tx.tokenMint.slice(0, 8)} (no matching active/pending position)`);
    return;
  }
  if (
    cand &&
    (cand.smartV3 || config.kolHunterSmartV3Enabled) &&
    cand.kolTxs.some((buy) => buy.kolId === tx.kolId)
  ) {
    pending.delete(tx.tokenMint);
    cleanupPendingCandidate(cand, false);
    markSmartV3SellCancel(tx.tokenMint);
  }

  for (const pos of positions) {
    const decision = evaluateInsiderExitDecision(pos, tx.kolId);
    const nowSec = Math.floor(Date.now() / 1000);
    const ref = pos.marketReferencePrice;
    const mfePct = (pos.peakPrice - ref) / ref;
    const maePct = (pos.troughPrice - ref) / ref;
    const anchorSell =
      isRotationV1Position(pos) &&
      (pos.rotationAnchorKols ?? []).some((id) => id.toLowerCase() === tx.kolId.toLowerCase());

    if (anchorSell) {
      if (await handleRotationFlowAnchorSell(pos, tx, nowSec, mfePct, maePct)) {
        continue;
      }
      log.info(
        `[KOL_HUNTER_ROTATION_ANCHOR_EXIT] ${pos.positionId} kol=${tx.kolId} ` +
        `action=close reason="rotation anchor sell"`
      );
      closePosition(pos, pos.lastPrice, 'insider_exit_full', nowSec, mfePct, maePct);
      continue;
    }

    if (decision.action === 'close') {
      log.info(
        `[KOL_HUNTER_INSIDER_EXIT] ${pos.positionId} kol=${tx.kolId} action=close reason="${decision.reason}"`
      );
      closePosition(pos, pos.lastPrice, 'insider_exit_full', nowSec, mfePct, maePct);
    } else if (decision.action === 'lower_confidence') {
      // 2026-04-28 (Phase 1 QA F1 fix): scalper sell → close 안 함 + trail 즉시 보수화.
      // 이전: kolReinforcementCount 만 하향 — applySmartV3Reinforcement 가 buildup 만 하고
      //   reduce 안 하므로 t1TrailPctOverride stuck → 정책 영향 0 였음 (cosmetic 만).
      // 수정: t1TrailPctOverride 를 ReinforcementTrailInc 만큼 즉시 보수 회복. 다음 reinforcement
      //   buildup 시 다시 올라가지만, 일시적으로 trail 좁혀 scalper sell 의 단기 retreat 위험 차단.
      pos.kolReinforcementCount = Math.max(0, pos.kolReinforcementCount - 1);
      const baseTrail = config.kolHunterT1TrailPct;
      const inc = config.kolHunterSmartV3ReinforcementTrailInc;
      const currentTrail = pos.t1TrailPctOverride ?? baseTrail;
      const reducedTrail = Math.max(baseTrail, currentTrail - inc);
      pos.t1TrailPctOverride = reducedTrail;
      log.info(
        `[KOL_HUNTER_SCALPER_SELL_IGNORE] ${pos.positionId} kol=${tx.kolId} action=lower_confidence ` +
        `reason="${decision.reason}" reinforcementCount=${pos.kolReinforcementCount} ` +
        `trail=${(currentTrail * 100).toFixed(1)}% → ${(reducedTrail * 100).toFixed(1)}%`
      );
    } else {
      log.debug(
        `[KOL_HUNTER_OBSERVER_SELL_IGNORE] ${pos.positionId} kol=${tx.kolId} action=ignore reason="${decision.reason}"`
      );
    }
  }
}

// ─── Pending / Stalk Window ──────────────────────────────

async function registerPending(tx: KolTx): Promise<void> {
  const tokenMint = tx.tokenMint;
  const stalkMs = config.kolHunterStalkWindowSec * 1000;
  const expiresAt = Date.now() + stalkMs;
  const timer = setTimeout(() => {
    void resolveStalk(tokenMint);
  }, stalkMs);
  if (timer.unref) timer.unref();
  pending.set(tokenMint, {
    tokenMint,
    firstKolEntryMs: tx.timestamp,
    stalkExpiresAtMs: expiresAt,
    timer,
    kolTxs: [tx],
  });
  log.info(
    `[KOL_HUNTER_STALK] ${tokenMint.slice(0, 8)} opened — kol=${tx.kolId} tier=${tx.tier} ` +
    `stalk=${config.kolHunterStalkWindowSec}s`
  );
}

async function registerSmartV3Pending(tx: KolTx): Promise<void> {
  const tokenMint = tx.tokenMint;
  if (!priceFeed) {
    log.warn(`[KOL_HUNTER_SMART_V3] priceFeed not initialized — cannot observe`);
    return;
  }

  const nowMs = Date.now();
  const existing = pending.get(tokenMint);
  if (existing) {
    existing.kolTxs.push(tx);
    if (existing.smartV3) {
      await evaluateSmartV3Triggers(existing);
    }
    return;
  }

  const admissionExpiresAtMs = nowMs + SMART_V3_ADMISSION_TIMEOUT_MS;
  const cand: PendingCandidate = {
    tokenMint,
    firstKolEntryMs: tx.timestamp,
    stalkExpiresAtMs: admissionExpiresAtMs,
    timer: setTimeout(() => {
      const current = pending.get(tokenMint);
      if (current !== cand || current.smartV3) return;
      pending.delete(tokenMint);
      cleanupPendingCandidate(current, true);
      log.warn(
        `[KOL_HUNTER_SMART_V3_ADMISSION_TIMEOUT] ${tokenMint.slice(0, 8)} ` +
        `pre-observe setup exceeded ${Math.round(SMART_V3_ADMISSION_TIMEOUT_MS / 1000)}s — reject`
      );
      const timeoutScore = computeKolDiscoveryScoreCached(tokenMint, Date.now());
      fireRejectObserver(tokenMint, 'smart_v3_price_timeout', current, timeoutScore, { smartV3: true });
    }, SMART_V3_ADMISSION_TIMEOUT_MS),
    kolTxs: [tx],
  };
  if (cand.timer.unref) cand.timer.unref();
  pending.set(tokenMint, cand);

  const score = computeKolDiscoveryScoreCached(tokenMint, nowMs);  // P1 #7: 1s bucket cache
  const preEntry = await checkKolSurvivalPreEntry(tokenMint);
  if (pending.get(tokenMint) !== cand) return;
  if (!preEntry.approved) {
    maybeLogRotationV1PreObserveBlock(cand, score, preEntry);
    pending.delete(tokenMint);
    cleanupPendingCandidate(cand, true);
    log.info(
      `[KOL_HUNTER_SMART_V3_SURVIVAL_REJECT] ${tokenMint.slice(0, 8)} ` +
      `reason=${preEntry.reason ?? 'unknown'} flags=${preEntry.flags.join(',')}`
    );
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
      survivalReason: preEntry.reason ?? null,
      survivalFlags: preEntry.flags,
      smartV3: true,
    });
    return;
  }

  priceFeed.subscribe(tokenMint);
  // PaperPriceFeed 는 subscribe 시 즉시 1회 poll 한다. 캐시 hit 은 즉시 반환.
  // Periodic poll 은 기본 8s 로 유지해 paper feed 가 Jupiter budget 을 점유하지 않게 한다.
  const firstTick = await waitForFirstTick(tokenMint, 5_000);
  if (pending.get(tokenMint) !== cand) {
    unsubscribePriceIfIdle(tokenMint);
    return;
  }
  if (firstTick === null) {
    pending.delete(tokenMint);
    cleanupPendingCandidate(cand, true);
    fireRejectObserver(tokenMint, 'smart_v3_price_timeout', cand, score, { smartV3: true });
    return;
  }

  const entryTokenDecimals = await resolveTokenDecimalsForObserver(tokenMint, firstTick.outputDecimals);
  if (pending.get(tokenMint) !== cand) {
    unsubscribePriceIfIdle(tokenMint);
    return;
  }
  const observeMs = config.kolHunterSmartV3ObserveWindowSec * 1000;
  const expiresAt = Date.now() + observeMs;
  const timer = setTimeout(() => {
    void resolveSmartV3NoTrigger(tokenMint);
  }, observeMs);
  if (timer.unref) timer.unref();

  clearTimeout(cand.timer);
  cand.stalkExpiresAtMs = expiresAt;
  cand.timer = timer;
  cand.smartV3 = {
    startedAtMs: Date.now(),
    observeExpiresAtMs: expiresAt,
    kolEntryPrice: firstTick.price,
    peakPrice: firstTick.price,
    currentPrice: firstTick.price,
    preEntryFlags: [
      ...preEntry.flags,
      `DECIMALS_${entryTokenDecimals.source?.toUpperCase() ?? 'UNKNOWN'}`,
    ],
    preEntrySecurityEvidence: preEntry.evidence,
    tokenDecimals: entryTokenDecimals.value,
    tokenDecimalsSource: entryTokenDecimals.source,
    resolving: false,
  };
  ensurePendingPriceListener(tokenMint);
  log.info(
    `[KOL_HUNTER_SMART_V3_OBSERVE] ${tokenMint.slice(0, 8)} opened — kol=${tx.kolId} tier=${tx.tier} ` +
    `observe=${config.kolHunterSmartV3ObserveWindowSec}s entryRef=${firstTick.price.toFixed(8)}`
  );
  await evaluateSmartV3Triggers(cand);
}

function ensurePendingPriceListener(tokenMint: string): void {
  if (!priceFeed || priceListeners.has(tokenMint)) return;
  const listener = (tick: PriceTick) => {
    if (tick.tokenMint !== tokenMint) return;
    const cand = pending.get(tokenMint);
    if (cand?.smartV3) {
      cand.smartV3.currentPrice = tick.price;
      if (tick.price > cand.smartV3.peakPrice) cand.smartV3.peakPrice = tick.price;
      void evaluateSmartV3Triggers(cand);
    }
    const positions = getActivePositionsByMint(tokenMint);
    for (const pos of positions) onPriceTick(pos.positionId, tick);
  };
  priceListeners.set(tokenMint, listener);
  priceFeed.on('price', listener);
}

async function resolveSmartV3NoTrigger(tokenMint: string): Promise<void> {
  const cand = pending.get(tokenMint);
  if (!cand?.smartV3 || cand.smartV3.resolving) return;
  cand.smartV3.resolving = true;
  pending.delete(tokenMint);
  const score = computeKolDiscoveryScoreCached(tokenMint, Date.now());  // P1 #7
  cleanupPendingCandidate(cand, true);
  log.info(`[KOL_HUNTER_SMART_V3_REJECT] ${tokenMint.slice(0, 8)} no trigger`);
  fireRejectObserver(tokenMint, 'smart_v3_no_trigger', cand, score, {
    smartV3: true,
    peakPrice: cand.smartV3.peakPrice,
    currentPrice: cand.smartV3.currentPrice,
    kolEntryPrice: cand.smartV3.kolEntryPrice,
  });
}

function cleanupPendingCandidate(cand: PendingCandidate, unsubscribePrice: boolean): void {
  clearTimeout(cand.timer);
  if (!unsubscribePrice) return;
  unsubscribePriceIfIdle(cand.tokenMint);
}

function unsubscribePriceIfIdle(tokenMint: string): void {
  const hasActive = (activeByMint.get(tokenMint)?.size ?? 0) > 0;
  const hasPending = pending.has(tokenMint);
  if (hasActive || hasPending) return;
  const listener = priceListeners.get(tokenMint);
  if (listener) {
    priceFeed?.off('price', listener);
    priceListeners.delete(tokenMint);
  }
  priceFeed?.unsubscribe(tokenMint);
}

interface SmartV3TriggerResult {
  pullback: boolean;
  velocity: boolean;
  reason?: Extract<KolEntryReason, 'pullback' | 'velocity' | 'pullback_and_velocity'>;
  conviction?: Extract<KolConvictionLevel, 'MEDIUM_HIGH' | 'HIGH' | 'HIGH_PLUS'>;
}

function evaluateSmartV3TriggerState(
  cand: PendingCandidate,
  fresh: SmartV3FreshContext
): SmartV3TriggerResult {
  const smart = cand.smartV3;
  if (!smart) return { pullback: false, velocity: false };

  const pullbackPct = (smart.peakPrice - smart.currentPrice) / Math.max(smart.peakPrice, 1e-12);
  const aboveKolDrawdownFloor =
    smart.currentPrice >= smart.kolEntryPrice * (1 - config.kolHunterSmartV3MaxDrawdownFromKolEntryPct);
  const lastBuyFreshEnough =
    fresh.triggerLastFreshBuyAgeMs !== null &&
    fresh.triggerLastFreshBuyAgeMs <= config.kolHunterSmartV3MaxLastBuyAgeSec * 1000;
  // 2026-04-30 (P1-2): pullback path 에 KOL count gate 추가.
  //   live 15h 분석: pullback|kols=1 이 손실의 103% 차지. velocity path 와 동일 강도로 강제.
  // 2026-05-03: live 연패 분석 이후 24h 누적 score 가 아니라 entry 직전 fresh consensus 를 강제.
  //   stale 2+ KOL count 로 pullback 이 열리는 케이스를 차단하고, pullback 은 live 에서 별도 fallback.
  const pullback =
    smart.peakPrice > smart.kolEntryPrice &&
    pullbackPct >= config.kolHunterSmartV3MinPullbackPct &&
    aboveKolDrawdownFloor &&
    fresh.triggerFreshIndependentKolCount >= config.kolHunterSmartV3PullbackMinKolCount;

  const velocity =
    fresh.triggerFreshSignalScore >= config.kolHunterSmartV3VelocityScoreThreshold &&
    fresh.triggerFreshIndependentKolCount >= config.kolHunterSmartV3VelocityMinIndependentKol &&
    fresh.triggerFreshTierStrongCount >= 2 &&
    lastBuyFreshEnough;

  if (pullback && velocity) return { pullback, velocity, reason: 'pullback_and_velocity', conviction: 'HIGH_PLUS' };
  if (pullback) return { pullback, velocity, reason: 'pullback', conviction: 'HIGH' };
  if (velocity) return { pullback, velocity, reason: 'velocity', conviction: 'MEDIUM_HIGH' };
  return { pullback, velocity };
}

interface RotationV1TriggerResult {
  triggered: boolean;
  flags: string[];
  reason?: string;
  participatingKols?: KolDiscoveryScore['participatingKols'];
  telemetry: {
    buyCount: number;
    smallBuyCount: number;
    grossBuySol: number;
    distinctRotationKols: number;
    recentSellCount: number;
    priceResponsePct: number;
    currentPrice: number;
    anchorKols: string[];
    anchorPrice: number;
    anchorPriceSource?: string;
    firstBuyAtMs: number | null;
    lastBuyAtMs: number | null;
    lastBuyAgeMs: number | null;
    rotationScore: number;
    underfillReferenceSolAmount?: number;
    underfillReferenceTokenAmount?: number;
  };
}

interface KolEntrySignal {
  label: 'smart-v3' | 'rotation-v1' | 'rotation-underfill' | 'rotation-chase-topup' | 'capitulation-rebound';
  logTag: string;
  parameterVersion: string;
  entryReason: KolEntryReason;
  conviction: KolConvictionLevel;
  extraFlags: string[];
  telemetry?: RotationV1TriggerResult['telemetry'];
  rotationAnchorKols?: string[];
  entryParticipatingKols?: KolDiscoveryScore['participatingKols'];
  entryIndependentKolCount?: number;
  entryKolScore?: number;
  paperOnly?: boolean;
  paperOnlyReason?: string;
}

function isRotationCanaryArmName(armName?: string | null): boolean {
  const lower = String(armName ?? '').toLowerCase();
  return lower.includes('rotation') || lower.includes('underfill') || lower.includes('chase_topup');
}

function isSmartV3CanaryArmName(armName?: string | null): boolean {
  const lower = String(armName ?? '').toLowerCase();
  return lower.includes('smart_v3') || lower.includes('kol_hunter_smart_v3');
}

function kolHunterCanaryLaneForEntrySignal(entrySignal: Pick<KolEntrySignal, 'label'>): EntryLane {
  if (
    entrySignal.label === 'rotation-v1' ||
    entrySignal.label === 'rotation-underfill' ||
    entrySignal.label === 'rotation-chase-topup'
  ) {
    return LANE_KOL_ROTATION;
  }
  if (entrySignal.label === 'smart-v3') return LANE_KOL_SMART_V3;
  return LANE_STRATEGY;
}

function kolHunterCanaryLaneForOptions(options: PaperEntryOptions): EntryLane {
  if (options.canaryLane) return options.canaryLane;
  if (isRotationCanaryArmName(options.profileArm) || isRotationCanaryArmName(options.entryArm)) {
    return LANE_KOL_ROTATION;
  }
  if (isSmartV3CanaryArmName(options.profileArm) || isSmartV3CanaryArmName(options.entryArm)) {
    return LANE_KOL_SMART_V3;
  }
  const armName = options.parameterVersion ? armNameForVersion(options.parameterVersion) : null;
  if (isRotationCanaryArmName(armName)) return LANE_KOL_ROTATION;
  if (isSmartV3CanaryArmName(armName)) return LANE_KOL_SMART_V3;
  return LANE_STRATEGY;
}

function kolHunterCanaryLaneForPosition(pos: PaperPosition): EntryLane {
  if (pos.canaryLane) return pos.canaryLane;
  if (
    isRotationCanaryArmName(pos.profileArm) ||
    isRotationCanaryArmName(pos.entryArm) ||
    isRotationCanaryArmName(pos.armName)
  ) {
    return LANE_KOL_ROTATION;
  }
  if (
    isSmartV3CanaryArmName(pos.profileArm) ||
    isSmartV3CanaryArmName(pos.entryArm) ||
    isSmartV3CanaryArmName(pos.armName)
  ) {
    return LANE_KOL_SMART_V3;
  }
  return LANE_STRATEGY;
}

const SMART_V3_LIVE_HARD_TOP10_HOLDER_PCT = 0.60;

function smartV3LiveHardTop10HolderPct(): number {
  return Math.min(config.kolHunterSurvivalMaxTop10HolderPct, SMART_V3_LIVE_HARD_TOP10_HOLDER_PCT);
}

function isSmartV3LiveStrictQualityFlag(flag: string): boolean {
  const upper = flag.toUpperCase();
  if (config.kolHunterSmartV3LiveBlockExitLiquidityUnknown && upper === 'EXIT_LIQUIDITY_UNKNOWN') return true;
  if (config.kolHunterSmartV3LiveBlockTokenQualityUnknown && upper === 'TOKEN_QUALITY_UNKNOWN') return true;
  if (config.kolHunterSmartV3LiveBlockUncleanToken && upper.startsWith('UNCLEAN_TOKEN')) {
    const top10Pct = parseSmartV3Top10PctFromFlag(flag);
    return top10Pct === null || top10Pct > smartV3LiveHardTop10HolderPct();
  }
  if (config.kolHunterSmartV3LiveBlockUncleanToken && upper.startsWith('HOLDER_')) return true;
  if (upper === 'NO_SELL_ROUTE' || upper === 'SELL_NO_ROUTE' || upper === 'NO_ROUTE') return true;
  if (upper.includes('NO_SELL_ROUTE') || upper.includes('RUG')) return true;
  return false;
}

function isSmartV3QualityUnknownMicroFlag(flag: string): boolean {
  const upper = flag.toUpperCase();
  return upper === 'SMART_V3_LIVE_QUALITY_FALLBACK' ||
    upper === 'SMART_V3_LIVE_DISABLED' ||
    upper === 'SMART_V3_QUALITY_EXIT_LIQUIDITY_UNKNOWN' ||
    upper === 'SMART_V3_QUALITY_TOKEN_QUALITY_UNKNOWN';
}

function parseSmartV3Top10PctFromFlag(flag: string): number | null {
  const match = flag.toUpperCase().match(/TOP10_(\d+(?:\.\d+)?)PCT/);
  if (!match) return null;
  const pct = Number(match[1]);
  if (!Number.isFinite(pct)) return null;
  return pct / 100;
}

function isSmartV3FastCanaryModerateHolderFlag(flag: string): boolean {
  const upper = flag.toUpperCase();
  return upper === 'SMART_V3_QUALITY_HOLDER_TOP1_HIGH' ||
    upper === 'SMART_V3_QUALITY_HOLDER_TOP5_HIGH' ||
    upper === 'SMART_V3_QUALITY_HOLDER_HHI_HIGH';
}

function hasSmartV3FastCanaryHardConcentrationFlag(flags: string[]): boolean {
  return flags.some((flag) => {
    const upper = flag.toUpperCase();
    if (upper.includes('HIGH_CONCENTRATION')) return true;
    if (upper === 'SMART_V3_QUALITY_HOLDER_TOP10_HIGH') return true;
    const top10Pct = parseSmartV3Top10PctFromFlag(flag);
    return top10Pct !== null && top10Pct > smartV3LiveHardTop10HolderPct();
  });
}

function isSmartV3FastCanaryFlag(flag: string, allFlags: string[]): boolean {
  const upper = flag.toUpperCase();
  if (isSmartV3QualityUnknownMicroFlag(flag)) return true;
  if (upper.startsWith('SMART_V3_QUALITY_UNCLEAN_TOKEN')) {
    const top10Pct = parseSmartV3Top10PctFromFlag(flag);
    return top10Pct !== null && top10Pct <= smartV3LiveHardTop10HolderPct();
  }
  if (isSmartV3FastCanaryModerateHolderFlag(flag)) {
    return !hasSmartV3FastCanaryHardConcentrationFlag(allFlags);
  }
  return false;
}

function parseSmartV3KolFillAdversePctFromFlag(flag: string): number | null {
  const match = flag.toUpperCase().match(/SMART_V3_KOL_FILL_ADVERSE_(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const pct = Number(match[1]);
  return Number.isFinite(pct) ? pct : null;
}

function smartV3FastFailLiveMaxTop10HolderPct(): number {
  return Math.min(
    config.kolHunterSurvivalMaxTop10HolderPct,
    config.kolHunterSmartV3FastFailLiveMaxTop10HolderPct
  );
}

function isSmartV3FastFailLiveAllowedFlag(flag: string, allFlags: string[]): boolean {
  const upper = flag.toUpperCase();
  if (
    upper === 'SMART_V3_LIVE_DISABLED' ||
    upper === 'SMART_V3_LIVE_QUALITY_FALLBACK' ||
    upper === 'SMART_V3_PULLBACK_LIVE_DISABLED' ||
    upper === 'SMART_V3_POST_SELL_RECOVERY_WEAK' ||
    upper === 'SMART_V3_PRE_ENTRY_SELL_LIVE_DISABLED' ||
    upper === 'SMART_V3_RECENT_SELL_NO_SELL_WINDOW' ||
    upper === 'SMART_V3_QUALITY_EXIT_LIQUIDITY_UNKNOWN' ||
    upper === 'SMART_V3_QUALITY_TOKEN_QUALITY_UNKNOWN'
  ) {
    return true;
  }
  if (upper.includes('NO_ROUTE') || upper.includes('RUG') || upper.includes('HIGH_CONCENTRATION')) {
    return false;
  }
  if (upper === 'SMART_V3_COMBO_DECAY' || upper.startsWith('SMART_V3_COMBO_DECAY_')) {
    return false;
  }
  if (upper === 'SMART_V3_QUALITY_HOLDER_TOP10_HIGH') {
    return false;
  }
  if (isSmartV3FastCanaryModerateHolderFlag(flag)) {
    return true;
  }
  if (upper.startsWith('SMART_V3_QUALITY_UNCLEAN_TOKEN')) {
    const top10Pct = parseSmartV3Top10PctFromFlag(flag);
    return top10Pct !== null && top10Pct <= smartV3FastFailLiveMaxTop10HolderPct();
  }
  const adversePct = parseSmartV3KolFillAdversePctFromFlag(flag);
  if (adversePct !== null) {
    return adversePct <= config.kolHunterSmartV3FastFailLiveMaxAdverseKolFillPct;
  }
  if (upper === 'SMART_V3_ENTRY_ADVANTAGE_ADVERSE') {
    return allFlags.some((other) => {
      const otherAdversePct = parseSmartV3KolFillAdversePctFromFlag(other);
      return otherAdversePct !== null &&
        otherAdversePct <= config.kolHunterSmartV3FastFailLiveMaxAdverseKolFillPct;
    });
  }
  return false;
}

function canRouteSmartV3FallbackToQualityUnknownMicro(
  fallback: { fallback: boolean; reason?: string; flags: string[] }
): boolean {
  if (!fallback.fallback) return false;
  if (!isKolLiveCanaryArmEnabled('smart_v3_quality_unknown_micro')) return false;
  if (!fallback.flags.includes('SMART_V3_LIVE_QUALITY_FALLBACK')) return false;
  return fallback.flags.every(isSmartV3QualityUnknownMicroFlag);
}

function canRouteSmartV3FallbackToFastCanary(
  fallback: { fallback: boolean; reason?: string; flags: string[] }
): boolean {
  if (!fallback.fallback) return false;
  if (!isKolLiveCanaryArmEnabled('smart_v3_fast_canary_v1')) return false;
  if (!fallback.flags.includes('SMART_V3_LIVE_QUALITY_FALLBACK')) return false;
  return fallback.flags.every((flag) => isSmartV3FastCanaryFlag(flag, fallback.flags));
}

function canRouteSmartV3FallbackToFastFailLive(
  fallback: { fallback: boolean; reason?: string; flags: string[] }
): boolean {
  if (!fallback.fallback) return false;
  if (!isKolLiveCanaryArmEnabled('smart_v3_fast_fail_live_v1')) return false;
  return fallback.flags.every((flag) => isSmartV3FastFailLiveAllowedFlag(flag, fallback.flags));
}

function smartV3KolWeightedFillPrice(cand: PendingCandidate, fresh: SmartV3FreshContext): number | null {
  if (!config.kolHunterSmartV3KolFillAdvantageEnabled) return null;
  const freshKolIds = new Set(fresh.freshParticipatingKols.map((k) => k.id.toLowerCase()));
  if (freshKolIds.size === 0) return null;
  let solAmount = 0;
  let tokenAmount = 0;
  for (const tx of mergeRecentAndCandidateTxs(cand)) {
    if (tx.tokenMint !== cand.tokenMint || tx.action !== 'buy') continue;
    if (!freshKolIds.has(tx.kolId.toLowerCase())) continue;
    const sol = typeof tx.solAmount === 'number' && Number.isFinite(tx.solAmount) ? tx.solAmount : 0;
    const tokens = typeof tx.tokenAmount === 'number' && Number.isFinite(tx.tokenAmount) ? tx.tokenAmount : 0;
    if (sol <= 0 || tokens <= 0) continue;
    solAmount += sol;
    tokenAmount += tokens;
  }
  if (solAmount <= 0 || tokenAmount <= 0) return null;
  return solAmount / tokenAmount;
}

function evaluateSmartV3LiveFallback(
  cand: PendingCandidate,
  entrySignal: KolEntrySignal,
  fresh: SmartV3FreshContext,
  entryFlags: string[]
): { fallback: boolean; reason?: string; flags: string[] } {
  if (entrySignal.label !== 'smart-v3') return { fallback: false, flags: [] };
  const flags: string[] = [];
  if (!isKolLiveCanaryArmEnabled('smart_v3_clean')) {
    flags.push('SMART_V3_LIVE_DISABLED');
  }
  if (entrySignal.entryReason === 'pullback' && !config.kolHunterSmartV3PullbackLiveEnabled) {
    flags.push('SMART_V3_PULLBACK_LIVE_DISABLED');
  }
  const weakPostSellRecovery =
    fresh.lastSellAtMs !== null &&
    fresh.preEntrySellSol >= config.kolHunterPostDistributionMinGrossSellSol &&
    fresh.freshBuyKolsAfterLastSell < config.kolHunterSmartV3MinFreshAfterSellKols;
  if (weakPostSellRecovery) {
    flags.push('SMART_V3_POST_SELL_RECOVERY_WEAK');
  }
  if (config.kolHunterSmartV3PreEntrySellLiveBlockEnabled && fresh.preEntrySellKols > 0) {
    const minNoSellSec = Math.max(0, config.kolHunterSmartV3PreEntrySellMinNoSellSec);
    const noSellWindowSatisfied =
      fresh.secondsSinceLastSell !== null && fresh.secondsSinceLastSell >= minNoSellSec;
    if (fresh.freshBuyKolsAfterLastSell < config.kolHunterSmartV3MinFreshAfterSellKols) {
      flags.push('SMART_V3_PRE_ENTRY_SELL_LIVE_DISABLED');
    } else if (!noSellWindowSatisfied) {
      flags.push('SMART_V3_RECENT_SELL_NO_SELL_WINDOW');
    }
  }
  if (config.kolHunterSmartV3LiveStrictQualityEnabled) {
    const qualityFlags = entryFlags.filter(isSmartV3LiveStrictQualityFlag);
    if (qualityFlags.length > 0) {
      flags.push('SMART_V3_LIVE_QUALITY_FALLBACK');
      flags.push(...qualityFlags.map((flag) => `SMART_V3_QUALITY_${flag}`));
    }
  }
  const comboDecay = checkSmartV3ComboDecay(fresh.freshParticipatingKols.map((k) => k.id));
  if (comboDecay.blocked) {
    flags.push(...comboDecay.flags);
  }
  const smart = cand.smartV3;
  const kolFillPrice = smartV3KolWeightedFillPrice(cand, fresh);
  if (smart && kolFillPrice && kolFillPrice > 0) {
    const adversePct = smart.currentPrice / kolFillPrice - 1;
    if (adversePct > config.kolHunterSmartV3MaxAdverseKolFillPct) {
      flags.push('SMART_V3_ENTRY_ADVANTAGE_ADVERSE');
      flags.push(`SMART_V3_KOL_FILL_ADVERSE_${adversePct.toFixed(4)}`);
    }
  }
  if (flags.length === 0) return { fallback: false, flags: [] };
  return {
    fallback: true,
    reason: flags.includes('SMART_V3_LIVE_QUALITY_FALLBACK')
      ? 'smart_v3_live_quality_fallback'
      : flags.includes('SMART_V3_PULLBACK_LIVE_DISABLED')
      ? 'smart_v3_pullback_live_disabled'
      : flags.includes('SMART_V3_PRE_ENTRY_SELL_LIVE_DISABLED') || flags.includes('SMART_V3_RECENT_SELL_NO_SELL_WINDOW')
      ? 'smart_v3_pre_entry_sell_risk'
      : flags.includes('SMART_V3_COMBO_DECAY')
      ? 'smart_v3_combo_decay'
      : flags.includes('SMART_V3_ENTRY_ADVANTAGE_ADVERSE')
      ? 'smart_v3_entry_advantage_adverse'
      : flags.includes('SMART_V3_LIVE_DISABLED')
      ? 'smart_v3_live_disabled'
      : 'smart_v3_post_sell_recovery_weak',
    flags,
  };
}

interface SmartV3LiveEligibilityShadow {
  smartV3LiveEligibleShadow: boolean;
  smartV3LiveBlockReason: string | null;
  smartV3LiveBlockFlags: string[];
  smartV3LiveEligibilityEvaluatedAtMs: number;
}

function buildSmartV3LiveEligibilityShadow(options: {
  cand: PendingCandidate;
  score: KolDiscoveryScore;
  entrySignal: KolEntrySignal;
  entryFlags: string[];
  smartFresh: SmartV3FreshContext;
  candIsShadow: boolean;
  hardTradingHaltReason?: string | null;
}): SmartV3LiveEligibilityShadow | undefined {
  const { cand, score, entrySignal, entryFlags, smartFresh, candIsShadow, hardTradingHaltReason } = options;
  if (entrySignal.label !== 'smart-v3') return undefined;

  const evaluatedAtMs = Date.now();
  const blocked = (reason: string, flags: string[]): SmartV3LiveEligibilityShadow => ({
    smartV3LiveEligibleShadow: false,
    smartV3LiveBlockReason: reason,
    smartV3LiveBlockFlags: Array.from(new Set(flags)),
    smartV3LiveEligibilityEvaluatedAtMs: evaluatedAtMs,
  });

  if (candIsShadow) {
    return blocked('shadow_kol', ['SHADOW_KOL_LIVE_BLOCK']);
  }
  const sameMintLiveActive = getActivePositionsByMint(cand.tokenMint).some((p) =>
    p.isLive === true && !p.isShadowArm
  );
  if (sameMintLiveActive) {
    return blocked('same_mint_live_active', ['SAME_MINT_LIVE_EXPOSURE_GUARD']);
  }
  if (hardTradingHaltReason) {
    return blocked('hard_trading_halt', ['LIVE_HARD_TRADING_HALT']);
  }
  if (isWalletStopActive()) {
    return blocked('wallet_stop_active', ['WALLET_STOP_ACTIVE']);
  }
  if (isEntryHaltActive(LANE_KOL_SMART_V3)) {
    return blocked('entry_halt_active', ['ENTRY_HALT_ACTIVE']);
  }
  const qualityCooldown = isInLiveExecutionQualityCooldown(cand.tokenMint);
  if (qualityCooldown.blocked) {
    return blocked('live_execution_quality_cooldown', ['LIVE_EXEC_QUALITY_COOLDOWN']);
  }
  const liveGate = evaluateKolLiveCanaryGate(score, entryFlags, {
    independentKolCountOverride: smartFresh.freshIndependentKolCount,
  });
  if (!liveGate.allowLive) {
    return blocked(liveGate.reason ?? 'live_gate_blocked', liveGate.flags);
  }
  const fallback = evaluateSmartV3LiveFallback(cand, entrySignal, smartFresh, entryFlags);
  if (fallback.fallback) {
    if (canRouteSmartV3FallbackToQualityUnknownMicro(fallback)) {
      return {
        smartV3LiveEligibleShadow: true,
        smartV3LiveBlockReason: null,
        smartV3LiveBlockFlags: [
          'SMART_V3_QUALITY_UNKNOWN_MICRO_CANARY',
          ...fallback.flags,
        ],
        smartV3LiveEligibilityEvaluatedAtMs: evaluatedAtMs,
      };
    }
    if (canRouteSmartV3FallbackToFastCanary(fallback)) {
      return {
        smartV3LiveEligibleShadow: true,
        smartV3LiveBlockReason: null,
        smartV3LiveBlockFlags: [
          'SMART_V3_FAST_CANARY',
          ...fallback.flags,
        ],
        smartV3LiveEligibilityEvaluatedAtMs: evaluatedAtMs,
      };
    }
    return blocked(fallback.reason ?? 'smart_v3_live_fallback', fallback.flags);
  }
  return {
    smartV3LiveEligibleShadow: true,
    smartV3LiveBlockReason: null,
    smartV3LiveBlockFlags: [],
    smartV3LiveEligibilityEvaluatedAtMs: evaluatedAtMs,
  };
}

function parseRotationV1KolIds(): Set<string> {
  return new Set(
    String(config.kolHunterRotationV1KolIds ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0)
  );
}

function parseRotationV1ExcludeKolIds(): Set<string> {
  return new Set(
    String(config.kolHunterRotationV1ExcludeKolIds ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0)
  );
}

function ensureRotationV1State(cand: PendingCandidate): NonNullable<PendingCandidate['rotationV1']> {
  if (!cand.rotationV1) {
    cand.rotationV1 = {
      noTradeReasonsEmitted: new Set<string>(),
      underfillNoTradeReasonsEmitted: new Set<string>(),
      chaseTopupNoTradeReasonsEmitted: new Set<string>(),
    };
  } else if (!cand.rotationV1.underfillNoTradeReasonsEmitted) {
    cand.rotationV1.underfillNoTradeReasonsEmitted = new Set<string>();
  }
  if (!cand.rotationV1.chaseTopupNoTradeReasonsEmitted) {
    cand.rotationV1.chaseTopupNoTradeReasonsEmitted = new Set<string>();
  }
  return cand.rotationV1;
}

function ensureCapitulationReboundState(cand: PendingCandidate): NonNullable<PendingCandidate['capitulation']> {
  if (!cand.capitulation) {
    cand.capitulation = {
      recoveryConfirmations: 0,
      noTradeReasonsEmitted: new Set<string>(),
      rrNoTradeReasonsEmitted: new Set<string>(),
    };
  } else if (!cand.capitulation.rrNoTradeReasonsEmitted) {
    cand.capitulation.rrNoTradeReasonsEmitted = new Set<string>();
  }
  return cand.capitulation;
}

function updateCapitulationRecoveryState(cand: PendingCandidate, nowMs: number): NonNullable<PendingCandidate['capitulation']> {
  const state = ensureCapitulationReboundState(cand);
  const smart = cand.smartV3;
  const currentPrice = smart?.currentPrice ?? 0;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return state;

  if (!state.lowPrice || currentPrice < state.lowPrice) {
    state.lowPrice = currentPrice;
    state.lowAtMs = nowMs;
    state.recoveryConfirmations = 0;
    state.lastRecoveryAtMs = undefined;
    state.lastRecoveryPrice = undefined;
    return state;
  }

  const lowPrice = state.lowPrice;
  const bouncePct = lowPrice > 0 ? currentPrice / lowPrice - 1 : 0;
  const spacingMs = Math.max(0, config.kolHunterCapitulationReboundRecoverySpacingSec) * 1000;
  const spacingOk = state.lastRecoveryAtMs == null || nowMs - state.lastRecoveryAtMs >= spacingMs;
  const monotonicOk = state.lastRecoveryPrice == null || currentPrice > state.lastRecoveryPrice;
  const recoveryBouncePct = config.kolHunterCapitulationReboundRrEnabled
    ? Math.min(config.kolHunterCapitulationReboundMinBouncePct, config.kolHunterCapitulationReboundRrMinBouncePct)
    : config.kolHunterCapitulationReboundMinBouncePct;
  if (bouncePct >= recoveryBouncePct && spacingOk && monotonicOk) {
    state.recoveryConfirmations += 1;
    state.lastRecoveryAtMs = nowMs;
    state.lastRecoveryPrice = currentPrice;
  }
  return state;
}

function buildCapitulationSellSplit(
  cand: PendingCandidate,
  state: NonNullable<PendingCandidate['capitulation']>,
  nowMs: number
): {
  preLowSellSol: number;
  preLowSellKols: number;
  postLowSellSol: number;
  postLowSellKols: number;
  postBounceSellSol: number;
  postBounceSellKols: number;
} {
  const sellWindowMs = Math.max(1, config.kolHunterPostDistributionWindowSec) * 1000;
  const sellStartMs = nowMs - sellWindowMs;
  const lowAtMs = state.lowAtMs ?? nowMs;
  const bounceAtMs = state.lastRecoveryAtMs ?? Number.POSITIVE_INFINITY;
  const preLowKols = new Set<string>();
  const postLowKols = new Set<string>();
  const postBounceKols = new Set<string>();
  let preLowSellSol = 0;
  let postLowSellSol = 0;
  let postBounceSellSol = 0;
  for (const tx of mergeRecentAndCandidateTxs(cand)) {
    if (tx.tokenMint !== cand.tokenMint || tx.action !== 'sell') continue;
    if (tx.timestamp < sellStartMs || tx.timestamp > nowMs) continue;
    const sol = Math.max(0, tx.solAmount ?? 0);
    if (tx.timestamp < lowAtMs) {
      preLowSellSol += sol;
      preLowKols.add(tx.kolId);
      continue;
    }
    postLowSellSol += sol;
    postLowKols.add(tx.kolId);
    if (tx.timestamp >= bounceAtMs) {
      postBounceSellSol += sol;
      postBounceKols.add(tx.kolId);
    }
  }
  return {
    preLowSellSol,
    preLowSellKols: preLowKols.size,
    postLowSellSol,
    postLowSellKols: postLowKols.size,
    postBounceSellSol,
    postBounceSellKols: postBounceKols.size,
  };
}

interface CapitulationReboundTriggerResult extends CapitulationReboundDecision {
  participatingKols?: KolDiscoveryScore['participatingKols'];
}

function evaluateCapitulationReboundTriggerState(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  fresh: SmartV3FreshContext,
  nowMs: number
): CapitulationReboundTriggerResult {
  const state = updateCapitulationRecoveryState(cand, nowMs);
  const smart = cand.smartV3;
  const decision = evaluateCapitulationReboundPolicy({
    alreadyEntered: state.enteredAtMs != null,
    currentPrice: smart?.currentPrice ?? 0,
    peakPrice: smart?.peakPrice ?? 0,
    lowPrice: state.lowPrice ?? smart?.currentPrice ?? 0,
    kolScore: fresh.triggerFreshSignalScore || score.finalScore,
    preEntrySellSol: fresh.preEntrySellSol,
    preEntrySellKols: fresh.preEntrySellKols,
    recoveryConfirmations: state.recoveryConfirmations,
    survivalFlags: smart?.preEntryFlags ?? [],
    config: {
      enabled: config.kolHunterCapitulationReboundEnabled,
      paperEnabled: config.kolHunterCapitulationReboundPaperEnabled,
      minKolScore: config.kolHunterCapitulationReboundMinKolScore,
      minDrawdownPct: config.kolHunterCapitulationReboundMinDrawdownPct,
      maxDrawdownPct: config.kolHunterCapitulationReboundMaxDrawdownPct,
      minBouncePct: config.kolHunterCapitulationReboundMinBouncePct,
      requiredRecoveryConfirmations: config.kolHunterCapitulationReboundRecoveryConfirmations,
      maxRecentSellSol: config.kolHunterCapitulationReboundMaxRecentSellSol,
      maxRecentSellKols: config.kolHunterCapitulationReboundMaxRecentSellKols,
    },
  });

  const participatingKols =
    fresh.freshParticipatingKols.length > 0
      ? fresh.freshParticipatingKols
      : fresh.shadowFreshParticipatingKols.length > 0
        ? fresh.shadowFreshParticipatingKols
        : score.participatingKols;
  return {
    ...decision,
    participatingKols,
  };
}

function evaluateCapitulationReboundRrTriggerState(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  fresh: SmartV3FreshContext,
  nowMs: number
): CapitulationReboundTriggerResult {
  const state = updateCapitulationRecoveryState(cand, nowMs);
  const smart = cand.smartV3;
  const sellSplit = buildCapitulationSellSplit(cand, state, nowMs);
  const decision = evaluateCapitulationReboundRrPolicy({
    alreadyEntered: state.rrEnteredAtMs != null,
    currentPrice: smart?.currentPrice ?? 0,
    peakPrice: smart?.peakPrice ?? 0,
    lowPrice: state.lowPrice ?? smart?.currentPrice ?? 0,
    kolScore: fresh.triggerFreshSignalScore || score.finalScore,
    preEntrySellSol: fresh.preEntrySellSol,
    preEntrySellKols: fresh.preEntrySellKols,
    ...sellSplit,
    recoveryConfirmations: state.recoveryConfirmations,
    survivalFlags: smart?.preEntryFlags ?? [],
    config: {
      enabled: config.kolHunterCapitulationReboundRrEnabled,
      paperEnabled: config.kolHunterCapitulationReboundRrPaperEnabled,
      minKolScore: config.kolHunterCapitulationReboundRrMinKolScore,
      minDrawdownPct: config.kolHunterCapitulationReboundRrMinDrawdownPct,
      maxDrawdownPct: config.kolHunterCapitulationReboundRrMaxDrawdownPct,
      minBouncePct: config.kolHunterCapitulationReboundRrMinBouncePct,
      requiredRecoveryConfirmations: config.kolHunterCapitulationReboundRrRecoveryConfirmations,
      maxRecentSellSol: Number.POSITIVE_INFINITY,
      maxRecentSellKols: Number.POSITIVE_INFINITY,
      minRr: config.kolHunterCapitulationReboundRrMinRr,
      stopBufferPct: config.kolHunterCapitulationReboundRrStopBufferPct,
      targetPct: config.kolHunterCapitulationReboundRrTargetPct,
      maxPostLowSellSol: config.kolHunterCapitulationReboundRrMaxPostLowSellSol,
      maxPostLowSellKols: config.kolHunterCapitulationReboundRrMaxPostLowSellKols,
      maxPostBounceSellSol: config.kolHunterCapitulationReboundRrMaxPostBounceSellSol,
      maxPostBounceSellKols: config.kolHunterCapitulationReboundRrMaxPostBounceSellKols,
    },
  });

  const participatingKols =
    fresh.freshParticipatingKols.length > 0
      ? fresh.freshParticipatingKols
      : fresh.shadowFreshParticipatingKols.length > 0
        ? fresh.shadowFreshParticipatingKols
        : score.participatingKols;
  return {
    ...decision,
    participatingKols,
  };
}

function logRotationV1ConfigOnce(): void {
  if (rotationV1ConfigLogged) return;
  rotationV1ConfigLogged = true;
  log.info(
    `[KOL_HUNTER_ROTATION_V1_CONFIG] enabled=${config.kolHunterRotationV1Enabled} ` +
    `live=${isKolLiveCanaryArmEnabled('rotation_v1')} minKols=${config.kolHunterRotationV1MinIndependentKol} ` +
    `minScore=${config.kolHunterRotationV1MinKolScore} window=${config.kolHunterRotationV1WindowSec}s ` +
    `buys>=${config.kolHunterRotationV1MinBuyCount} smallBuys>=${config.kolHunterRotationV1MinSmallBuyCount} ` +
    `gross>=${config.kolHunterRotationV1MinGrossBuySol}SOL recentSellBlock=${config.kolHunterRotationV1MaxRecentSellSec}s ` +
    `priceResponse>=${(config.kolHunterRotationV1MinPriceResponsePct * 100).toFixed(2)}% ` +
    `seeds=${config.kolHunterRotationV1KolIds || 'none'} excludes=${config.kolHunterRotationV1ExcludeKolIds || 'none'} ` +
    `offsets=${rotationV1MarkoutOffsetsSec().join(',')}`
  );
}

function rotationV1KolScore(tx: KolTx, seedKolIds: Set<string>, excludedKolIds: Set<string>): number {
  const kolId = tx.kolId.toLowerCase();
  if (tx.isShadow === true) return 0;
  if (excludedKolIds.has(kolId)) return 0;
  const wallet = lookupKolById(tx.kolId);
  if (!wallet && !seedKolIds.has(kolId)) return 0;

  const role = getKolLaneRole(tx.kolId);
  if (role === 'observer') return 0;
  const style = getKolTradingStyle(tx.kolId);
  let score = seedKolIds.has(kolId) ? 0.30 : 0;
  if (tx.tier === 'S') score += 0.20;
  else if (tx.tier === 'A') score += 0.15;
  else if (tx.tier === 'B') score += 0.05;

  if (role === 'discovery_canary') score += 0.25;
  else if (role === 'copy_core') score += 0.15;
  else if (role === 'unknown') score += 0.05;

  if (style === 'scalper') score += 0.30;
  else if (style === 'unknown') score += 0.10;
  else if (style === 'swing') score += 0.05;

  return Math.min(1, score);
}

function isRotationUnderfillTierEligible(tx: KolTx): boolean {
  return tx.tier === 'S' || tx.tier === 'A';
}

function kolBuyFillPriceSolPerToken(tx: KolTx): number | undefined {
  const solAmount = typeof tx.solAmount === 'number' && Number.isFinite(tx.solAmount)
    ? tx.solAmount
    : 0;
  const tokenAmount = typeof tx.tokenAmount === 'number' && Number.isFinite(tx.tokenAmount)
    ? tx.tokenAmount
    : 0;
  if (tx.action !== 'buy' || solAmount <= 0 || tokenAmount <= 0) return undefined;
  return solAmount / tokenAmount;
}

function buildRotationUnderfillReference(
  scoredBuys: Array<{ tx: KolTx; score: number }>
): {
  price: number;
  source: 'kol_weighted_fill';
  solAmount: number;
  tokenAmount: number;
} | undefined {
  let solAmount = 0;
  let tokenAmount = 0;
  for (const row of scoredBuys) {
    const price = kolBuyFillPriceSolPerToken(row.tx);
    if (price == null || price <= 0) continue;
    solAmount += Math.max(0, row.tx.solAmount ?? 0);
    tokenAmount += Math.max(0, row.tx.tokenAmount ?? 0);
  }
  if (solAmount <= 0 || tokenAmount <= 0) return undefined;
  return {
    price: solAmount / tokenAmount,
    source: 'kol_weighted_fill',
    solAmount,
    tokenAmount,
  };
}

function rotationUnderfillReferencePriceFromTelemetry(
  telemetry?: RotationV1TriggerResult['telemetry']
): number | null {
  const solAmount = telemetry?.underfillReferenceSolAmount;
  const tokenAmount = telemetry?.underfillReferenceTokenAmount;
  if (
    typeof solAmount !== 'number' ||
    typeof tokenAmount !== 'number' ||
    !Number.isFinite(solAmount) ||
    !Number.isFinite(tokenAmount) ||
    solAmount <= 0 ||
    tokenAmount <= 0
  ) {
    return null;
  }
  return solAmount / tokenAmount;
}

function isRotationUnderfillExitRouteUnknownFlag(flag: string): boolean {
  const upper = flag.toUpperCase();
  return upper === 'EXIT_LIQUIDITY_UNKNOWN' ||
    upper === 'NO_SELL_ROUTE' ||
    upper === 'SELL_NO_ROUTE' ||
    upper === 'NO_ROUTE' ||
    upper.includes('NO_SELL_ROUTE');
}

function evaluateRotationUnderfillLiveFallback(
  entrySignal: KolEntrySignal,
  entryFlags: string[] = []
): { fallback: boolean; reason?: string; flags: string[] } {
  if (entrySignal.label !== 'rotation-underfill') return { fallback: false, flags: [] };
  const flags: string[] = [];
  if (!isRotationUnderfillLiveCanaryEnabled()) {
    flags.push('ROTATION_UNDERFILL_LIVE_DISABLED');
  }
  if (entryFlags.some(isRotationUnderfillExitRouteUnknownFlag)) {
    flags.push('ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN');
  }
  const decayCheck = checkRotationLiveKolDecay(
    (entrySignal.entryParticipatingKols ?? [])
      .map((kol) => kol.id)
      .concat(entrySignal.rotationAnchorKols ?? [])
  );
  if (decayCheck.blocked) {
    flags.push(...decayCheck.flags);
  }
  if (flags.length === 0) return { fallback: false, flags: [] };
  const reason = flags.includes('ROTATION_UNDERFILL_LIVE_DISABLED')
    ? 'rotation_underfill_live_disabled'
    : flags.includes('ROTATION_UNDERFILL_LIVE_EXIT_ROUTE_UNKNOWN')
      ? 'rotation_underfill_live_exit_route_unknown'
      : decayCheck.reason ?? 'rotation_underfill_live_kol_decay';
  return {
    fallback: true,
    reason,
    flags,
  };
}

interface RotationV1IntakeSnapshot {
  buyCount: number;
  smallBuyCount: number;
  grossBuySol: number;
  distinctRotationKols: number;
  recentSellCount: number;
  anchorKols: string[];
  firstBuyAtMs: number | null;
  lastBuyAtMs: number | null;
  lastBuyAgeMs: number | null;
  rotationScore: number;
}

function recordRotationV1Intake(tx: KolTx): void {
  if (!config.kolHunterRotationV1Enabled) return;
  if (tx.action !== 'buy' && tx.action !== 'sell') return;

  const nowMs = Date.now();
  const retainMs = Math.max(
    config.kolHunterRotationV1WindowSec,
    config.kolHunterRotationV1MaxRecentSellSec,
    config.kolHunterRotationFlowMetricsLookbackSec
  ) * 1000;
  const rows = rotationV1RecentTxsByMint.get(tx.tokenMint) ?? [];
  rows.push(tx);
  const cutoffMs = nowMs - retainMs;
  const retained = rows.filter((row) => row.timestamp >= cutoffMs);
  rotationV1RecentTxsByMint.set(tx.tokenMint, retained);

  if (rotationV1RecentTxsByMint.size > 500) {
    for (const [mint, mintRows] of rotationV1RecentTxsByMint) {
      const nextRows = mintRows.filter((row) => row.timestamp >= cutoffMs);
      if (nextRows.length === 0) rotationV1RecentTxsByMint.delete(mint);
      else rotationV1RecentTxsByMint.set(mint, nextRows);
    }
  }
}

function buildRotationV1IntakeSnapshot(tokenMint: string, nowMs: number): RotationV1IntakeSnapshot {
  const seedKolIds = parseRotationV1KolIds();
  const excludedKolIds = parseRotationV1ExcludeKolIds();
  const windowStartMs = nowMs - config.kolHunterRotationV1WindowSec * 1000;
  const recentSellStartMs = nowMs - config.kolHunterRotationV1MaxRecentSellSec * 1000;
  const rows = rotationV1RecentTxsByMint.get(tokenMint) ?? [];
  const scoredRotationBuys = rows
    .filter((tx) => tx.action === 'buy' && tx.timestamp >= windowStartMs)
    .map((tx) => ({ tx, score: rotationV1KolScore(tx, seedKolIds, excludedKolIds) }))
    .filter((row) => row.score > 0);
  const rotationBuys = scoredRotationBuys.map((row) => row.tx);
  const smallBuyCount = rotationBuys.filter((tx) => {
    const sol = typeof tx.solAmount === 'number' ? tx.solAmount : 0;
    return Number.isFinite(sol) && sol > 0 && sol <= config.kolHunterRotationV1SmallBuyMaxSol;
  }).length;
  const grossBuySol = rotationBuys.reduce((sum, tx) => {
    const sol = typeof tx.solAmount === 'number' ? tx.solAmount : 0;
    return sum + (Number.isFinite(sol) && sol > 0 ? sol : 0);
  }, 0);
  const recentSellCount = rows.filter((tx) => tx.action === 'sell' && tx.timestamp >= recentSellStartMs).length;
  const firstBuyAtMs = rotationBuys.reduce<number | null>(
    (min, tx) => min === null ? tx.timestamp : Math.min(min, tx.timestamp),
    null
  );
  const lastBuyAtMs = rotationBuys.reduce<number | null>(
    (max, tx) => max === null ? tx.timestamp : Math.max(max, tx.timestamp),
    null
  );
  const anchorKols = [...new Set(rotationBuys.map((tx) => tx.kolId))];
  return {
    buyCount: rotationBuys.length,
    smallBuyCount,
    grossBuySol,
    distinctRotationKols: new Set(rotationBuys.map((tx) => tx.kolId.toLowerCase())).size,
    recentSellCount,
    anchorKols,
    firstBuyAtMs,
    lastBuyAtMs,
    lastBuyAgeMs: lastBuyAtMs === null ? null : nowMs - lastBuyAtMs,
    rotationScore: scoredRotationBuys.reduce((max, row) => Math.max(max, row.score), 0),
  };
}

function rotationV1IntakePassesCoreSignal(snapshot: RotationV1IntakeSnapshot): boolean {
  const minKolScore = config.kolHunterRotationV1MinKolScore ?? 0.45;
  const minIndependentKol = config.kolHunterRotationV1MinIndependentKol ?? 1;
  const maxLastBuyAgeSec = config.kolHunterRotationV1MaxLastBuyAgeSec ?? 15;
  return snapshot.buyCount >= config.kolHunterRotationV1MinBuyCount &&
    snapshot.smallBuyCount >= config.kolHunterRotationV1MinSmallBuyCount &&
    snapshot.grossBuySol >= config.kolHunterRotationV1MinGrossBuySol &&
    snapshot.rotationScore >= minKolScore &&
    snapshot.distinctRotationKols >= minIndependentKol &&
    snapshot.recentSellCount === 0 &&
    (snapshot.lastBuyAgeMs === null || snapshot.lastBuyAgeMs <= maxLastBuyAgeSec * 1000);
}

function maybeLogRotationV1PreObserveBlock(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  preEntry: { reason?: string | null; flags: string[] }
): void {
  if (!config.kolHunterRotationV1Enabled) return;
  const nowMs = Date.now();
  const snapshot = buildRotationV1IntakeSnapshot(cand.tokenMint, nowMs);
  if (!rotationV1IntakePassesCoreSignal(snapshot)) return;
  const lastBuyAtMs = snapshot.lastBuyAtMs ?? 0;
  const logKey = `${cand.tokenMint}:${preEntry.reason ?? 'unknown'}:${lastBuyAtMs}:${snapshot.buyCount}:${snapshot.smallBuyCount}`;
  if (rotationV1PreObserveBlockLogKeys.has(logKey)) return;
  rotationV1PreObserveBlockLogKeys.add(logKey);
  if (rotationV1PreObserveBlockLogKeys.size > 1000) {
    rotationV1PreObserveBlockLogKeys.clear();
    rotationV1PreObserveBlockLogKeys.add(logKey);
  }
  log.info(
    `[KOL_HUNTER_ROTATION_V1_PREOBSERVE_BLOCK] ${cand.tokenMint.slice(0, 8)} ` +
    `reason=${preEntry.reason ?? 'unknown'} flags=${preEntry.flags.join(',')} ` +
    `buys=${snapshot.buyCount} smallBuys=${snapshot.smallBuyCount} ` +
    `gross=${snapshot.grossBuySol.toFixed(4)}SOL kols=${snapshot.distinctRotationKols} ` +
    `score=${snapshot.rotationScore.toFixed(2)} lastBuyAge=${Math.round((snapshot.lastBuyAgeMs ?? 0) / 1000)}s ` +
    `anchors=${snapshot.anchorKols.join(',') || 'none'} ` +
    `policy=blocked_before_price_observe smartScore=${score.finalScore.toFixed(2)}`
  );
}

function evaluateRotationV1TriggerState(cand: PendingCandidate, nowMs: number): RotationV1TriggerResult {
  const empty = {
    buyCount: 0,
    smallBuyCount: 0,
    grossBuySol: 0,
    distinctRotationKols: 0,
    recentSellCount: 0,
    priceResponsePct: 0,
    currentPrice: 0,
    anchorKols: [],
    anchorPrice: 0,
    anchorPriceSource: 'none',
    firstBuyAtMs: null,
    lastBuyAtMs: null,
    lastBuyAgeMs: null,
    rotationScore: 0,
  };
  if (!config.kolHunterRotationV1Enabled) {
    return { triggered: false, flags: [], reason: 'disabled', telemetry: empty };
  }
  const rotationState = ensureRotationV1State(cand);
  if (rotationState.enteredAtMs) {
    return { triggered: false, flags: [], reason: 'already_entered', telemetry: empty };
  }

  const seedKolIds = parseRotationV1KolIds();
  const excludedKolIds = parseRotationV1ExcludeKolIds();
  const minKolScore = config.kolHunterRotationV1MinKolScore ?? 0.45;
  const maxLastBuyAgeSec = config.kolHunterRotationV1MaxLastBuyAgeSec ?? 15;
  const minIndependentKol = config.kolHunterRotationV1MinIndependentKol ?? 1;

  const windowStartMs = nowMs - config.kolHunterRotationV1WindowSec * 1000;
  const recentSellStartMs = nowMs - config.kolHunterRotationV1MaxRecentSellSec * 1000;
  const scoredRotationBuys = recentKolTxs
    .filter((tx) =>
      tx.tokenMint === cand.tokenMint &&
      tx.action === 'buy' &&
      tx.timestamp >= windowStartMs
    )
    .map((tx) => ({ tx, score: rotationV1KolScore(tx, seedKolIds, excludedKolIds) }))
    .filter((row) => row.score >= minKolScore);
  const rotationBuys = scoredRotationBuys.map((row) => row.tx);
  const recentSameMintSells = recentKolTxs.filter((tx) =>
    tx.tokenMint === cand.tokenMint &&
    tx.action === 'sell' &&
    tx.timestamp >= recentSellStartMs
  );
  const smallBuyCount = rotationBuys.filter((tx) => {
    const solAmount = typeof tx.solAmount === 'number' && Number.isFinite(tx.solAmount) ? tx.solAmount : 0;
    return solAmount > 0 && solAmount <= config.kolHunterRotationV1SmallBuyMaxSol;
  }).length;
  const grossBuySol = rotationBuys.reduce((sum, tx) => {
    const solAmount = typeof tx.solAmount === 'number' && Number.isFinite(tx.solAmount) ? tx.solAmount : 0;
    return sum + Math.max(0, solAmount);
  }, 0);
  const distinctRotationKols = new Set(rotationBuys.map((tx) => tx.kolId.toLowerCase())).size;
  const anchorKols = [...new Set(rotationBuys.map((tx) => tx.kolId))];
  const firstBuyAtMs = rotationBuys.reduce<number | null>(
    (min, tx) => (min == null || tx.timestamp < min ? tx.timestamp : min),
    null
  );
  const lastBuyAtMs = rotationBuys.reduce<number | null>(
    (max, tx) => (max == null || tx.timestamp > max ? tx.timestamp : max),
    null
  );
  const lastBuyAgeMs = lastBuyAtMs == null ? null : Math.max(0, nowMs - lastBuyAtMs);
  const smart = cand.smartV3;
  if (rotationBuys.length > 0 && !rotationState.anchorPrice && smart?.currentPrice && smart.currentPrice > 0) {
    rotationState.anchorPrice = smart.currentPrice;
  }
  const anchorPrice = rotationState.anchorPrice ?? smart?.kolEntryPrice ?? 0;
  const priceResponsePct = smart && anchorPrice > 0
    ? smart.currentPrice / anchorPrice - 1
    : 0;
  const currentPrice = smart?.currentPrice ?? 0;
  const rotationScore = scoredRotationBuys.reduce((max, row) => Math.max(max, row.score), 0);
  const telemetry = {
    buyCount: rotationBuys.length,
    smallBuyCount,
    grossBuySol,
    distinctRotationKols,
    recentSellCount: recentSameMintSells.length,
    priceResponsePct,
    currentPrice,
    anchorKols,
    anchorPrice,
    firstBuyAtMs,
    lastBuyAtMs,
    lastBuyAgeMs,
    rotationScore,
  };

  if (rotationBuys.length < config.kolHunterRotationV1MinBuyCount) {
    return { triggered: false, flags: [], reason: 'insufficient_buy_count', telemetry };
  }
  if (rotationScore < minKolScore) {
    return {
      triggered: false,
      flags: [`ROTATION_V1_LOW_KOL_SCORE_${rotationScore.toFixed(2)}`],
      reason: 'low_rotation_score',
      telemetry,
    };
  }
  if (minIndependentKol > 1 && distinctRotationKols < minIndependentKol) {
    return {
      triggered: false,
      flags: [`ROTATION_V1_MIN_KOL_${distinctRotationKols}_OF_${minIndependentKol}`],
      reason: 'insufficient_rotation_kol_count',
      telemetry,
    };
  }
  if (smallBuyCount < config.kolHunterRotationV1MinSmallBuyCount) {
    return { triggered: false, flags: [], reason: 'insufficient_small_buys', telemetry };
  }
  if (grossBuySol < config.kolHunterRotationV1MinGrossBuySol) {
    return { triggered: false, flags: [], reason: 'insufficient_gross_buy_sol', telemetry };
  }
  if (
    lastBuyAgeMs != null &&
    lastBuyAgeMs > maxLastBuyAgeSec * 1000
  ) {
    return {
      triggered: false,
      flags: [`ROTATION_V1_STALE_LAST_BUY_${Math.round(lastBuyAgeMs / 1000)}S`],
      reason: 'stale_last_buy',
      telemetry,
    };
  }
  if (recentSameMintSells.length > 0) {
    return { triggered: false, flags: ['ROTATION_V1_RECENT_SELL_BLOCK'], reason: 'recent_same_mint_sell', telemetry };
  }
  if (priceResponsePct < config.kolHunterRotationV1MinPriceResponsePct) {
    return {
      triggered: false,
      flags: [
        'ROTATION_V1_NO_PRICE_RESPONSE',
        `ROTATION_V1_RESPONSE_PCT_${priceResponsePct.toFixed(4)}`,
      ],
      reason: 'insufficient_price_response',
      telemetry,
    };
  }

  return {
    triggered: true,
    flags: [
      'ROTATION_V1',
      `ROTATION_V1_BUYS_${rotationBuys.length}`,
      `ROTATION_V1_SMALL_BUYS_${smallBuyCount}`,
      `ROTATION_V1_GROSS_BUY_SOL_${grossBuySol.toFixed(2)}`,
      `ROTATION_V1_KOLS_${distinctRotationKols}`,
      `ROTATION_V1_SCORE_${rotationScore.toFixed(2)}`,
      `ROTATION_V1_RESPONSE_PCT_${priceResponsePct.toFixed(4)}`,
    ],
    telemetry,
  };
}

function buildRotationUnderfillParticipants(
  scoredBuys: Array<{ tx: KolTx; score: number }>
): KolDiscoveryScore['participatingKols'] {
  const latestByKol = new Map<string, { tx: KolTx; score: number }>();
  for (const row of scoredBuys) {
    const key = row.tx.kolId.toLowerCase();
    const current = latestByKol.get(key);
    if (!current || row.tx.timestamp > current.tx.timestamp) {
      latestByKol.set(key, row);
    }
  }
  return [...latestByKol.values()]
    .sort((a, b) => b.tx.timestamp - a.tx.timestamp)
    .map((row) => ({
      id: row.tx.kolId,
      tier: row.tx.tier,
      timestamp: row.tx.timestamp,
    }));
}

function evaluateRotationUnderfillTriggerState(cand: PendingCandidate, nowMs: number): RotationV1TriggerResult {
  const empty = {
    buyCount: 0,
    smallBuyCount: 0,
    grossBuySol: 0,
    distinctRotationKols: 0,
    recentSellCount: 0,
    priceResponsePct: 0,
    currentPrice: 0,
    anchorKols: [],
    anchorPrice: 0,
    firstBuyAtMs: null,
    lastBuyAtMs: null,
    lastBuyAgeMs: null,
    rotationScore: 0,
  };
  if (!config.kolHunterRotationV1Enabled || !config.kolHunterRotationUnderfillPaperEnabled) {
    return { triggered: false, flags: [], reason: 'disabled', telemetry: empty };
  }
  const rotationState = ensureRotationV1State(cand);
  if (rotationState.underfillEnteredAtMs) {
    return { triggered: false, flags: [], reason: 'already_entered', telemetry: empty };
  }
  const smart = cand.smartV3;
  const currentPrice = smart?.currentPrice ?? 0;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { triggered: false, flags: [], reason: 'missing_reference_price', telemetry: empty };
  }

  const seedKolIds = parseRotationV1KolIds();
  const excludedKolIds = parseRotationV1ExcludeKolIds();
  const maxLastBuyAgeSec = config.kolHunterRotationUnderfillMaxLastBuyAgeSec;
  const buyLookbackSec = Math.max(
    maxLastBuyAgeSec,
    config.kolHunterRotationV1WindowSec,
    config.kolHunterRotationUnderfillMaxRecentSellSec
  );
  const recentBuyStartMs = nowMs - buyLookbackSec * 1000;
  const recentSellStartMs = nowMs - config.kolHunterRotationUnderfillMaxRecentSellSec * 1000;
  const minKolScore = config.kolHunterRotationUnderfillMinKolScore;
  const scoredBuys = recentKolTxs
    .filter((tx) =>
      tx.tokenMint === cand.tokenMint &&
      tx.action === 'buy' &&
      isRotationUnderfillTierEligible(tx) &&
      tx.timestamp >= recentBuyStartMs
    )
    .map((tx) => ({ tx, score: rotationV1KolScore(tx, seedKolIds, excludedKolIds) }))
    .filter((row) => row.score >= minKolScore);
  const eligibleBuys = scoredBuys.map((row) => row.tx);
  const recentSameMintSells = recentKolTxs.filter((tx) =>
    tx.tokenMint === cand.tokenMint &&
    tx.action === 'sell' &&
    tx.timestamp >= recentSellStartMs
  );
  const grossBuySol = eligibleBuys.reduce((sum, tx) => {
    const solAmount = typeof tx.solAmount === 'number' && Number.isFinite(tx.solAmount) ? tx.solAmount : 0;
    return sum + Math.max(0, solAmount);
  }, 0);
  const firstBuyAtMs = eligibleBuys.reduce<number | null>(
    (min, tx) => (min == null || tx.timestamp < min ? tx.timestamp : min),
    null
  );
  const lastBuyAtMs = eligibleBuys.reduce<number | null>(
    (max, tx) => (max == null || tx.timestamp > max ? tx.timestamp : max),
    null
  );
  const lastBuyAgeMs = lastBuyAtMs == null ? null : Math.max(0, nowMs - lastBuyAtMs);
  const anchorKols = [...new Set(eligibleBuys.map((tx) => tx.kolId))];
  const distinctRotationKols = new Set(eligibleBuys.map((tx) => tx.kolId.toLowerCase())).size;
  const rotationScore = scoredBuys.reduce((max, row) => Math.max(max, row.score), 0);
  const underfillReference = buildRotationUnderfillReference(scoredBuys);
  const anchorPrice = underfillReference?.price ?? 0;
  const discountPct = anchorPrice > 0 ? 1 - currentPrice / anchorPrice : 0;
  const priceResponsePct = anchorPrice > 0 ? currentPrice / anchorPrice - 1 : 0;
  const telemetry = {
    buyCount: eligibleBuys.length,
    smallBuyCount: eligibleBuys.length,
    grossBuySol,
    distinctRotationKols,
    recentSellCount: recentSameMintSells.length,
    priceResponsePct,
    currentPrice,
    anchorKols,
    anchorPrice,
    anchorPriceSource: underfillReference?.source ?? 'missing_kol_fill',
    firstBuyAtMs,
    lastBuyAtMs,
    lastBuyAgeMs,
    rotationScore,
    underfillReferenceSolAmount: underfillReference?.solAmount,
    underfillReferenceTokenAmount: underfillReference?.tokenAmount,
  };

  if (eligibleBuys.length === 0) {
    return {
      triggered: false,
      flags: [
        'ROTATION_UNDERFILL_SA_ONLY',
        `ROTATION_UNDERFILL_LOW_KOL_SCORE_${rotationScore.toFixed(2)}`,
      ],
      reason: 'underfill_no_eligible_buy',
      telemetry,
    };
  }
  if (!underfillReference) {
    return {
      triggered: false,
      flags: [
        'ROTATION_UNDERFILL_MISSING_KOL_FILL_PRICE',
        'ROTATION_UNDERFILL_SA_ONLY',
      ],
      reason: 'underfill_missing_kol_fill_price',
      participatingKols: buildRotationUnderfillParticipants(scoredBuys),
      telemetry,
    };
  }
  if (recentSameMintSells.length > 0) {
    return {
      triggered: false,
      flags: ['ROTATION_UNDERFILL_RECENT_SELL_BLOCK'],
      reason: 'underfill_recent_same_mint_sell',
      participatingKols: buildRotationUnderfillParticipants(scoredBuys),
      telemetry,
    };
  }
  if (lastBuyAgeMs != null && lastBuyAgeMs > maxLastBuyAgeSec * 1000) {
    return {
      triggered: false,
      flags: [`ROTATION_UNDERFILL_STALE_LAST_BUY_${Math.round(lastBuyAgeMs / 1000)}S`],
      reason: 'underfill_stale_last_buy',
      participatingKols: buildRotationUnderfillParticipants(scoredBuys),
      telemetry,
    };
  }
  if (discountPct < config.kolHunterRotationUnderfillMinDiscountPct) {
    return {
      triggered: false,
      flags: [
        'ROTATION_UNDERFILL_DISCOUNT_TOO_LOW',
        `ROTATION_UNDERFILL_DISCOUNT_PCT_${discountPct.toFixed(4)}`,
      ],
      reason: 'underfill_discount_too_low',
      participatingKols: buildRotationUnderfillParticipants(scoredBuys),
      telemetry,
    };
  }
  if (discountPct > config.kolHunterRotationUnderfillMaxDiscountPct) {
    return {
      triggered: false,
      flags: [
        'ROTATION_UNDERFILL_DISCOUNT_TOO_DEEP',
        `ROTATION_UNDERFILL_DISCOUNT_PCT_${discountPct.toFixed(4)}`,
      ],
      reason: 'underfill_discount_too_deep',
      participatingKols: buildRotationUnderfillParticipants(scoredBuys),
      telemetry,
    };
  }

  return {
    triggered: true,
    flags: [
      'ROTATION_UNDERFILL_V1',
      isRotationUnderfillLiveCanaryEnabled()
        ? 'ROTATION_UNDERFILL_LIVE_CANARY_ENABLED'
        : 'ROTATION_UNDERFILL_PAPER_ONLY',
      `ROTATION_UNDERFILL_DISCOUNT_PCT_${discountPct.toFixed(4)}`,
      `ROTATION_UNDERFILL_KOLS_${distinctRotationKols}`,
      `ROTATION_UNDERFILL_BUYS_${eligibleBuys.length}`,
      'ROTATION_UNDERFILL_SA_ONLY',
      `ROTATION_UNDERFILL_REF_${underfillReference.source.toUpperCase()}`,
      `ROTATION_UNDERFILL_SCORE_${rotationScore.toFixed(2)}`,
      `ROTATION_UNDERFILL_LAST_BUY_AGE_${Math.round((lastBuyAgeMs ?? 0) / 1000)}S`,
    ],
    participatingKols: buildRotationUnderfillParticipants(scoredBuys),
    telemetry,
  };
}

function evaluateRotationChaseTopupTriggerState(cand: PendingCandidate, nowMs: number): RotationV1TriggerResult {
  const empty = {
    buyCount: 0,
    smallBuyCount: 0,
    grossBuySol: 0,
    distinctRotationKols: 0,
    recentSellCount: 0,
    priceResponsePct: 0,
    currentPrice: 0,
    anchorKols: [],
    anchorPrice: 0,
    anchorPriceSource: 'none',
    firstBuyAtMs: null,
    lastBuyAtMs: null,
    lastBuyAgeMs: null,
    rotationScore: 0,
  };
  if (!config.kolHunterRotationV1Enabled || !config.kolHunterRotationChaseTopupPaperEnabled) {
    return { triggered: false, flags: [], reason: 'disabled', telemetry: empty };
  }
  const rotationState = ensureRotationV1State(cand);
  if (rotationState.chaseTopupEnteredAtMs) {
    return { triggered: false, flags: [], reason: 'already_entered', telemetry: empty };
  }
  const smart = cand.smartV3;
  const currentPrice = smart?.currentPrice ?? 0;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { triggered: false, flags: [], reason: 'missing_reference_price', telemetry: empty };
  }

  const seedKolIds = parseRotationV1KolIds();
  const excludedKolIds = parseRotationV1ExcludeKolIds();
  const minKolScore = config.kolHunterRotationUnderfillMinKolScore;
  const buyLookbackSec = Math.max(
    config.kolHunterRotationV1WindowSec,
    config.kolHunterRotationUnderfillMaxLastBuyAgeSec
  );
  const buyStartMs = nowMs - buyLookbackSec * 1000;
  const sellStartMs = nowMs - config.kolHunterRotationChaseTopupMaxRecentSellSec * 1000;
  const scoredBuys = recentKolTxs
    .filter((tx) =>
      tx.tokenMint === cand.tokenMint &&
      tx.action === 'buy' &&
      isRotationUnderfillTierEligible(tx) &&
      tx.timestamp >= buyStartMs
    )
    .map((tx) => ({ tx, score: rotationV1KolScore(tx, seedKolIds, excludedKolIds) }))
    .filter((row) => row.score >= minKolScore);
  const eligibleBuys = scoredBuys.map((row) => row.tx);
  const firstBuyAtMs = eligibleBuys.reduce<number | null>(
    (min, tx) => (min == null || tx.timestamp < min ? tx.timestamp : min),
    null
  );
  const lastBuyAtMs = eligibleBuys.reduce<number | null>(
    (max, tx) => (max == null || tx.timestamp > max ? tx.timestamp : max),
    null
  );
  const lastBuyAgeMs = lastBuyAtMs == null ? null : Math.max(0, nowMs - lastBuyAtMs);
  const anchorKols = [...new Set(eligibleBuys.map((tx) => tx.kolId))];
  const distinctRotationKols = new Set(eligibleBuys.map((tx) => tx.kolId.toLowerCase())).size;
  const rotationScore = scoredBuys.reduce((max, row) => Math.max(max, row.score), 0);
  const reference = buildRotationUnderfillReference(scoredBuys);
  const anchorPrice = reference?.price ?? 0;
  const grossBuySol = eligibleBuys.reduce((sum, tx) => {
    const solAmount = typeof tx.solAmount === 'number' && Number.isFinite(tx.solAmount) ? tx.solAmount : 0;
    return sum + Math.max(0, solAmount);
  }, 0);
  const recentSameMintSells = recentKolTxs.filter((tx) =>
    tx.tokenMint === cand.tokenMint &&
    tx.action === 'sell' &&
    tx.timestamp >= sellStartMs
  );
  const openerSol = eligibleBuys.length > 0
    ? Math.max(0, eligibleBuys[0].solAmount ?? 0)
    : 0;
  const topupSol = eligibleBuys.slice(1).reduce((sum, tx) => sum + Math.max(0, tx.solAmount ?? 0), 0);
  const topupStrength = openerSol > 0 ? topupSol / openerSol : 0;
  const chaseMetrics = buildRotationChaseTopupMetrics({
    buys: eligibleBuys,
    entryAtMs: firstBuyAtMs ?? nowMs,
    chaseStepPct: config.kolHunterRotationFlowChaseStepPct,
  });
  const priceResponsePct = anchorPrice > 0 ? currentPrice / anchorPrice - 1 : 0;
  const telemetry = {
    buyCount: eligibleBuys.length,
    smallBuyCount: eligibleBuys.length,
    grossBuySol,
    distinctRotationKols,
    recentSellCount: recentSameMintSells.length,
    priceResponsePct,
    currentPrice,
    anchorKols,
    anchorPrice,
    anchorPriceSource: reference?.source ?? 'missing_kol_fill',
    firstBuyAtMs,
    lastBuyAtMs,
    lastBuyAgeMs,
    rotationScore,
    underfillReferenceSolAmount: reference?.solAmount,
    underfillReferenceTokenAmount: reference?.tokenAmount,
  };

  if (eligibleBuys.length < config.kolHunterRotationChaseTopupMinBuys) {
    return { triggered: false, flags: [], reason: 'chase_insufficient_buys', telemetry };
  }
  if (!reference) {
    return { triggered: false, flags: ['ROTATION_CHASE_MISSING_FILL_PRICE'], reason: 'chase_missing_fill_price', telemetry };
  }
  if (recentSameMintSells.length > 0) {
    return { triggered: false, flags: ['ROTATION_CHASE_RECENT_SELL_BLOCK'], reason: 'chase_recent_same_mint_sell', telemetry };
  }
  if (lastBuyAgeMs != null && lastBuyAgeMs > config.kolHunterRotationUnderfillMaxLastBuyAgeSec * 1000) {
    return { triggered: false, flags: [`ROTATION_CHASE_STALE_LAST_BUY_${Math.round(lastBuyAgeMs / 1000)}S`], reason: 'chase_stale_last_buy', telemetry };
  }
  if (topupStrength < config.kolHunterRotationChaseTopupMinTopupStrength) {
    return {
      triggered: false,
      flags: [`ROTATION_CHASE_TOPUP_STRENGTH_${topupStrength.toFixed(3)}`],
      reason: 'chase_topup_strength_too_low',
      telemetry,
    };
  }
  if (chaseMetrics.chaseTopupCount <= 0) {
    return {
      triggered: false,
      flags: [`ROTATION_CHASE_MAX_STEP_${chaseMetrics.maxStepPct.toFixed(4)}`],
      reason: 'chase_no_positive_step',
      telemetry,
    };
  }

  return {
    triggered: true,
    flags: [
      'ROTATION_CHASE_TOPUP_V1',
      'ROTATION_CHASE_TOPUP_PAPER_ONLY',
      'ROTATION_CHASE_SA_ONLY',
      `ROTATION_CHASE_BUYS_${eligibleBuys.length}`,
      `ROTATION_CHASE_TOPUP_STRENGTH_${topupStrength.toFixed(3)}`,
      `ROTATION_CHASE_STEP_${chaseMetrics.maxStepPct.toFixed(4)}`,
      `ROTATION_CHASE_SCORE_${rotationScore.toFixed(2)}`,
    ],
    participatingKols: buildRotationUnderfillParticipants(scoredBuys),
    telemetry,
  };
}

function shouldEmitRotationNoTrade(reason?: string): boolean {
  return reason === 'recent_same_mint_sell' ||
    reason === 'insufficient_price_response' ||
    reason === 'stale_last_buy' ||
    reason === 'low_rotation_score' ||
    reason === 'insufficient_rotation_kol_count' ||
    reason === 'kol_alpha_decay';
}

function shouldEmitRotationUnderfillNoTrade(reason?: string): boolean {
  return reason === 'underfill_recent_same_mint_sell' ||
    reason === 'underfill_missing_kol_fill_price' ||
    reason === 'underfill_discount_too_low' ||
    reason === 'underfill_discount_too_deep' ||
    reason === 'underfill_stale_last_buy';
}

function shouldEmitRotationChaseTopupNoTrade(reason?: string): boolean {
  return reason === 'chase_recent_same_mint_sell' ||
    reason === 'chase_missing_fill_price' ||
    reason === 'chase_stale_last_buy' ||
    reason === 'chase_topup_strength_too_low' ||
    reason === 'chase_no_positive_step';
}

function shouldEmitCapitulationNoTrade(reason?: string): boolean {
  return reason === 'hard_veto' ||
    reason === 'sell_wave' ||
    reason === 'post_low_sell' ||
    reason === 'post_bounce_sell' ||
    reason === 'drawdown_too_deep' ||
    reason === 'bounce_not_confirmed' ||
    reason === 'rr_too_low';
}

function capitulationParameterVersionForResult(result: CapitulationReboundTriggerResult): string {
  return result.flags.some((flag) => flag.startsWith('CAPITULATION_RR') || flag === 'CAPITULATION_REBOUND_RR_V1')
    ? config.kolHunterCapitulationReboundRrParameterVersion
    : config.kolHunterCapitulationReboundParameterVersion;
}

function buildRotationNoTradeObserverConfig() {
  return {
    ...buildObserverConfig(),
    offsetsSec: rotationV1MarkoutOffsetsSec(),
    writeScheduleMarker: true,
  };
}

function trackKolHunterAdmissionSkipMarkout(
  tx: KolTx,
  reason: string,
  extras: Record<string, unknown>
): void {
  const signalPrice = kolBuyFillPriceSolPerToken(tx);
  if (signalPrice == null || signalPrice <= 0) return;
  const nowMs = Date.now();
  trackRejectForMissedAlpha(
    {
      rejectCategory: 'viability',
      rejectReason: `kol_hunter_${reason}_skip`,
      tokenMint: tx.tokenMint,
      lane: LANE_STRATEGY,
      signalPrice,
      probeSolAmount: config.kolHunterTicketSol,
      signalSource: 'kol_hunter_admission_skip',
      extras: {
        positionId: `kol-admission-skip-${tx.tokenMint.slice(0, 8)}-${reason}-${nowMs}`,
        eventType: 'kol_hunter_admission_skip',
        noTradeReason: reason,
        paperOnlyMeasurement: true,
        measurementTarget: 'kol_buy_admission_skip',
        kolId: tx.kolId,
        tier: tx.tier,
        action: tx.action,
        solAmount: tx.solAmount ?? null,
        tokenAmount: tx.tokenAmount ?? null,
        ...extras,
      },
    },
    buildRotationNoTradeObserverConfig()
  );
}

function trackRotationNoTradeMarkout(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  result: RotationV1TriggerResult,
  reason: string,
  flags: string[]
): void {
  const signalPrice =
    result.telemetry.currentPrice > 0
      ? result.telemetry.currentPrice
      : result.telemetry.anchorPrice > 0
        ? result.telemetry.anchorPrice
        : cand.smartV3?.currentPrice ?? cand.smartV3?.kolEntryPrice ?? 0;
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) return;
  const nowMs = Date.now();
  trackRejectForMissedAlpha(
    {
      rejectCategory: 'viability',
      rejectReason: `rotation_v1_${reason}`,
      tokenMint: cand.tokenMint,
      lane: LANE_STRATEGY,
      signalPrice,
      probeSolAmount: config.kolHunterTicketSol,
      tokenDecimals: cand.smartV3?.tokenDecimals,
      signalSource: 'kol_hunter_rotation_v1',
      extras: {
        positionId: `rotation-notrade-${cand.tokenMint.slice(0, 8)}-${reason}-${nowMs}`,
        eventType: 'rotation_no_trade',
        armName: armNameForVersion(config.kolHunterRotationV1ParameterVersion),
        entryReason: 'rotation_v1',
        parameterVersion: config.kolHunterRotationV1ParameterVersion,
        tokenDecimalsSource: cand.smartV3?.tokenDecimalsSource ?? null,
        noTradeReason: reason,
        survivalFlags: flags,
        kolCount: cand.kolTxs.length,
        independentKolCount: score.independentKolCount,
        effectiveIndependentCount: score.effectiveIndependentCount,
        kolScore: score.finalScore,
        rotationV1: result.telemetry,
        rotationAnchorKols: result.telemetry.anchorKols,
        rotationAnchorPrice: result.telemetry.anchorPrice,
        rotationFirstBuyAtMs: result.telemetry.firstBuyAtMs,
        rotationLastBuyAtMs: result.telemetry.lastBuyAtMs,
        rotationLastBuyAgeMs: result.telemetry.lastBuyAgeMs,
        rotationScore: result.telemetry.rotationScore,
        priceResponsePct: result.telemetry.priceResponsePct,
      },
    },
    buildRotationNoTradeObserverConfig()
  );
}

function buildCapitulationNoTradeObserverConfig() {
  return {
    ...buildObserverConfig(),
    offsetsSec: capitulationReboundMarkoutOffsetsSec(),
    writeScheduleMarker: true,
  };
}

function trackCapitulationNoTradeMarkout(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  result: CapitulationReboundTriggerResult,
  reason: string,
  flags: string[]
): void {
  const signalPrice = result.telemetry.currentPrice > 0
    ? result.telemetry.currentPrice
    : cand.smartV3?.currentPrice ?? cand.smartV3?.kolEntryPrice ?? 0;
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) return;
  const nowMs = Date.now();
  const parameterVersion = capitulationParameterVersionForResult(result);
  const armName = armNameForVersion(parameterVersion);
  trackRejectForMissedAlpha(
    {
      rejectCategory: 'viability',
      rejectReason: `capitulation_rebound_${reason}`,
      tokenMint: cand.tokenMint,
      lane: LANE_STRATEGY,
      signalPrice,
      probeSolAmount: config.kolHunterTicketSol,
      tokenDecimals: cand.smartV3?.tokenDecimals,
      signalSource: armName,
      extras: {
        positionId: `capitulation-notrade-${cand.tokenMint.slice(0, 8)}-${reason}-${nowMs}`,
        eventType: 'capitulation_rebound_no_trade',
        armName,
        entryReason: 'capitulation_rebound',
        parameterVersion,
        tokenDecimalsSource: cand.smartV3?.tokenDecimalsSource ?? null,
        noTradeReason: reason,
        survivalFlags: flags,
        kolCount: cand.kolTxs.length,
        independentKolCount: score.independentKolCount,
        effectiveIndependentCount: score.effectiveIndependentCount,
        kolScore: score.finalScore,
        participatingKols: result.participatingKols ?? score.participatingKols,
        capitulation: result.telemetry,
      },
    },
    buildCapitulationNoTradeObserverConfig()
  );
}

function trackCapitulationEntryRejectMarkout(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  reason: string,
  signalPrice: number,
  flags: string[],
  options: PaperEntryOptions,
  extra: Record<string, unknown> = {}
): void {
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) return;
  const nowMs = Date.now();
  const parameterVersion = options.parameterVersion ?? config.kolHunterCapitulationReboundParameterVersion;
  const armName = armNameForVersion(parameterVersion);
  const survivalFlags = [
    ...flags,
    `CAPITULATION_NOTRADE_${reason.toUpperCase()}`,
  ];
  emitKolShadowPolicy({
    eventKind: 'reject',
    tokenMint: cand.tokenMint,
    currentAction: 'block',
    isLive: false,
    isShadowArm: false,
    armName,
    entryReason: 'capitulation_rebound',
    rejectReason: `capitulation_rebound_${reason}`,
    independentKolCount: options.entryIndependentKolCount ?? score.independentKolCount,
    effectiveIndependentCount: options.entryIndependentKolCount ?? score.effectiveIndependentCount,
    kolScore: options.entryKolScore ?? score.finalScore,
    participatingKols: options.entryParticipatingKols ?? score.participatingKols,
    survivalFlags,
    recentJupiter429: currentRecentJupiter429(),
    routeFound: survivalFlags.includes('NO_SELL_ROUTE') ? false : undefined,
  });
  trackRejectForMissedAlpha(
    {
      rejectCategory: 'viability',
      rejectReason: `capitulation_rebound_${reason}`,
      tokenMint: cand.tokenMint,
      lane: LANE_STRATEGY,
      signalPrice,
      probeSolAmount: config.kolHunterTicketSol,
      tokenDecimals: options.tokenDecimals,
      signalSource: armName,
      extras: {
        positionId: `capitulation-notrade-${cand.tokenMint.slice(0, 8)}-${reason}-${nowMs}`,
        eventType: 'capitulation_rebound_no_trade',
        armName,
        entryReason: 'capitulation_rebound',
        parameterVersion,
        tokenDecimalsSource: options.tokenDecimalsSource ?? null,
        noTradeReason: reason,
        survivalFlags,
        kolCount: cand.kolTxs.length,
        independentKolCount: options.entryIndependentKolCount ?? score.independentKolCount,
        effectiveIndependentCount: options.entryIndependentKolCount ?? score.effectiveIndependentCount,
        kolScore: options.entryKolScore ?? score.finalScore,
        participatingKols: options.entryParticipatingKols ?? score.participatingKols,
        capitulation: options.capitulationTelemetry ?? null,
        ...extra,
      },
    },
    buildCapitulationNoTradeObserverConfig()
  );
}

function trackRotationUnderfillNoTradeMarkout(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  result: RotationV1TriggerResult,
  reason: string,
  flags: string[]
): void {
  const signalPrice =
    result.telemetry.currentPrice > 0
      ? result.telemetry.currentPrice
      : result.telemetry.anchorPrice > 0
        ? result.telemetry.anchorPrice
        : cand.smartV3?.currentPrice ?? cand.smartV3?.kolEntryPrice ?? 0;
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) return;
  const nowMs = Date.now();
  trackRejectForMissedAlpha(
    {
      rejectCategory: 'viability',
      rejectReason: `rotation_underfill_${reason}`,
      tokenMint: cand.tokenMint,
      lane: LANE_STRATEGY,
      signalPrice,
      probeSolAmount: config.kolHunterTicketSol,
      tokenDecimals: cand.smartV3?.tokenDecimals,
      signalSource: 'rotation_underfill_v1',
      extras: {
        positionId: `rotation-underfill-notrade-${cand.tokenMint.slice(0, 8)}-${reason}-${nowMs}`,
        eventType: 'rotation_underfill_no_trade',
        armName: armNameForVersion(config.kolHunterRotationUnderfillParameterVersion),
        entryReason: 'rotation_v1',
        parameterVersion: config.kolHunterRotationUnderfillParameterVersion,
        tokenDecimalsSource: cand.smartV3?.tokenDecimalsSource ?? null,
        noTradeReason: reason,
        survivalFlags: flags,
        kolCount: cand.kolTxs.length,
        independentKolCount: result.telemetry.distinctRotationKols || score.independentKolCount,
        effectiveIndependentCount: result.telemetry.distinctRotationKols || score.effectiveIndependentCount,
        kolScore: result.telemetry.rotationScore || score.finalScore,
        participatingKols: result.participatingKols ?? [],
        rotationV1: result.telemetry,
        rotationAnchorKols: result.telemetry.anchorKols,
        rotationAnchorPrice: result.telemetry.anchorPrice,
        rotationAnchorPriceSource: result.telemetry.anchorPriceSource ?? null,
        rotationFirstBuyAtMs: result.telemetry.firstBuyAtMs,
        rotationLastBuyAtMs: result.telemetry.lastBuyAtMs,
        rotationLastBuyAgeMs: result.telemetry.lastBuyAgeMs,
        rotationScore: result.telemetry.rotationScore,
        underfillReferenceSolAmount: result.telemetry.underfillReferenceSolAmount ?? null,
        underfillReferenceTokenAmount: result.telemetry.underfillReferenceTokenAmount ?? null,
        priceResponsePct: result.telemetry.priceResponsePct,
        underfillDiscountPct: -result.telemetry.priceResponsePct,
      },
    },
    buildRotationNoTradeObserverConfig()
  );
}

function trackRotationChaseTopupNoTradeMarkout(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  result: RotationV1TriggerResult,
  reason: string,
  flags: string[]
): void {
  const signalPrice =
    result.telemetry.currentPrice > 0
      ? result.telemetry.currentPrice
      : result.telemetry.anchorPrice > 0
        ? result.telemetry.anchorPrice
        : cand.smartV3?.currentPrice ?? cand.smartV3?.kolEntryPrice ?? 0;
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) return;
  const nowMs = Date.now();
  trackRejectForMissedAlpha(
    {
      rejectCategory: 'viability',
      rejectReason: `rotation_chase_topup_${reason}`,
      tokenMint: cand.tokenMint,
      lane: LANE_STRATEGY,
      signalPrice,
      probeSolAmount: config.kolHunterTicketSol,
      tokenDecimals: cand.smartV3?.tokenDecimals,
      signalSource: 'rotation_chase_topup_v1',
      extras: {
        positionId: `rotation-chase-topup-notrade-${cand.tokenMint.slice(0, 8)}-${reason}-${nowMs}`,
        eventType: 'rotation_chase_topup_no_trade',
        armName: armNameForVersion(config.kolHunterRotationChaseTopupParameterVersion),
        entryReason: 'rotation_v1',
        parameterVersion: config.kolHunterRotationChaseTopupParameterVersion,
        tokenDecimalsSource: cand.smartV3?.tokenDecimalsSource ?? null,
        noTradeReason: reason,
        survivalFlags: flags,
        kolCount: cand.kolTxs.length,
        independentKolCount: result.telemetry.distinctRotationKols || score.independentKolCount,
        effectiveIndependentCount: result.telemetry.distinctRotationKols || score.effectiveIndependentCount,
        kolScore: result.telemetry.rotationScore || score.finalScore,
        participatingKols: result.participatingKols ?? [],
        rotationV1: result.telemetry,
        rotationAnchorKols: result.telemetry.anchorKols,
        rotationAnchorPrice: result.telemetry.anchorPrice,
        rotationAnchorPriceSource: result.telemetry.anchorPriceSource ?? null,
        rotationFirstBuyAtMs: result.telemetry.firstBuyAtMs,
        rotationLastBuyAtMs: result.telemetry.lastBuyAtMs,
        rotationLastBuyAgeMs: result.telemetry.lastBuyAgeMs,
        rotationScore: result.telemetry.rotationScore,
        underfillReferenceSolAmount: result.telemetry.underfillReferenceSolAmount ?? null,
        underfillReferenceTokenAmount: result.telemetry.underfillReferenceTokenAmount ?? null,
        priceResponsePct: result.telemetry.priceResponsePct,
      },
    },
    buildRotationNoTradeObserverConfig()
  );
}

function trackRotationPaperArmSkipMarkout(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  spec: RotationPaperArmSpec,
  skipReason: string,
  entryPrice: number,
  options: PaperEntryOptions,
  survivalFlags: string[],
  entryTokenDecimals: { value?: number; source?: 'security_client' | 'jupiter_quote' }
): void {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;
  const nowMs = Date.now();
  const telemetry = options.rotationTelemetry ?? {
    buyCount: null,
    smallBuyCount: null,
    grossBuySol: null,
    distinctRotationKols: null,
    recentSellCount: null,
    priceResponsePct: rotationPriceResponsePct(entryPrice, options.rotationAnchorPrice) ?? 0,
    currentPrice: entryPrice,
    anchorKols: options.rotationAnchorKols ?? [],
    anchorPrice: options.rotationAnchorPrice ?? 0,
    firstBuyAtMs: options.rotationFirstBuyAtMs ?? null,
    lastBuyAtMs: options.rotationLastBuyAtMs ?? null,
    lastBuyAgeMs: options.rotationLastBuyAgeMs ?? null,
    rotationScore: options.rotationScore ?? 0,
  };
  trackRejectForMissedAlpha(
    {
      rejectCategory: 'viability',
      rejectReason: `rotation_arm_skip_${skipReason}`,
      tokenMint: cand.tokenMint,
      lane: LANE_STRATEGY,
      signalPrice: entryPrice,
      probeSolAmount: config.kolHunterTicketSol,
      tokenDecimals: entryTokenDecimals.value,
      signalSource: spec.armName,
      extras: {
        positionId: `rotation-arm-skip-${cand.tokenMint.slice(0, 8)}-${spec.suffix}-${skipReason}-${nowMs}`,
        eventType: 'rotation_arm_skip',
        armName: spec.armName,
        parameterVersion: spec.parameterVersion,
        parentArmName: armNameForVersion(options.parameterVersion ?? config.kolHunterRotationV1ParameterVersion),
        parentParameterVersion: options.parameterVersion ?? config.kolHunterRotationV1ParameterVersion,
        entryReason: 'rotation_v1',
        tokenDecimalsSource: entryTokenDecimals.source ?? null,
        skipReason,
        noTradeReason: `${spec.armName}_${skipReason}`,
        survivalFlags,
        kolCount: cand.kolTxs.length,
        independentKolCount: score.independentKolCount,
        effectiveIndependentCount: score.effectiveIndependentCount,
        kolScore: score.finalScore,
        rotationV1: telemetry,
        rotationAnchorKols: telemetry.anchorKols,
        rotationAnchorPrice: telemetry.anchorPrice,
        rotationFirstBuyAtMs: telemetry.firstBuyAtMs,
        rotationLastBuyAtMs: telemetry.lastBuyAtMs,
        rotationLastBuyAgeMs: telemetry.lastBuyAgeMs,
        rotationScore: telemetry.rotationScore,
        priceResponsePct: telemetry.priceResponsePct,
      },
    },
    buildRotationNoTradeObserverConfig()
  );
}

function trackSmartV3EntryFilterShadowMarkout(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  opts: {
    entryReason: KolEntryReason;
    signalPrice: number;
    tokenDecimals?: number;
    tokenDecimalsSource?: 'security_client' | 'jupiter_quote';
    armName: string;
    parameterVersion: string;
    noTradeReason: string;
    survivalFlags: string[];
    smartFresh: SmartV3FreshContext;
    smartV3LiveEligibleShadow?: boolean;
    smartV3LiveBlockReason?: string | null;
    smartV3LiveBlockFlags?: string[];
  }
): void {
  if (!Number.isFinite(opts.signalPrice) || opts.signalPrice <= 0) return;
  const nowMs = Date.now();
  trackRejectForMissedAlpha(
    {
      rejectCategory: 'viability',
      rejectReason: opts.noTradeReason,
      tokenMint: cand.tokenMint,
      lane: LANE_STRATEGY,
      signalPrice: opts.signalPrice,
      probeSolAmount: config.kolHunterTicketSol,
      tokenDecimals: opts.tokenDecimals,
      signalSource: opts.armName,
      extras: {
        positionId: `smart-v3-filter-shadow-${cand.tokenMint.slice(0, 8)}-${opts.armName}-${nowMs}`,
        eventType: 'smart_v3_entry_filter_shadow',
        armName: opts.armName,
        parameterVersion: opts.parameterVersion,
        parentArmName: armNameForVersion(config.kolHunterSmartV3ParameterVersion),
        parentParameterVersion: config.kolHunterSmartV3ParameterVersion,
        entryReason: opts.entryReason,
        tokenDecimalsSource: opts.tokenDecimalsSource ?? null,
        noTradeReason: opts.noTradeReason,
        survivalFlags: opts.survivalFlags,
        kolCount: cand.kolTxs.length,
        independentKolCount: score.independentKolCount,
        effectiveIndependentCount: score.effectiveIndependentCount,
        kolScore: score.finalScore,
        freshIndependentKolCount: opts.smartFresh.freshIndependentKolCount,
        freshTierStrongCount: opts.smartFresh.freshTierStrongCount,
        freshSignalScore: opts.smartFresh.freshSignalScore,
        freshBuyKolsAfterLastSell: opts.smartFresh.freshBuyKolsAfterLastSell,
        preEntrySellSol: opts.smartFresh.preEntrySellSol,
        smartV3LiveEligibleShadow: opts.smartV3LiveEligibleShadow ?? null,
        smartV3LiveBlockReason: opts.smartV3LiveBlockReason ?? null,
        smartV3LiveBlockFlags: opts.smartV3LiveBlockFlags ?? null,
      },
    },
    {
      ...buildObserverConfig(),
      writeScheduleMarker: true,
    }
  );
}

function emitRotationV1NoTradePolicy(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  result: RotationV1TriggerResult
): void {
  if (!shouldEmitRotationNoTrade(result.reason)) return;
  const rotationState = ensureRotationV1State(cand);
  const reason = result.reason ?? 'unknown';
  if (rotationState.noTradeReasonsEmitted.has(reason)) return;
  rotationState.noTradeReasonsEmitted.add(reason);
  const flags = [
    ...result.flags,
    `ROTATION_V1_NOTRADE_${reason.toUpperCase()}`,
    `ROTATION_V1_RESPONSE_PCT_${result.telemetry.priceResponsePct.toFixed(4)}`,
    `ROTATION_V1_SCORE_${result.telemetry.rotationScore.toFixed(2)}`,
  ];
  if (typeof result.telemetry.lastBuyAgeMs === 'number') {
    flags.push(`ROTATION_V1_LAST_BUY_AGE_${Math.round(result.telemetry.lastBuyAgeMs / 1000)}S`);
  }
  emitKolShadowPolicy({
    eventKind: 'reject',
    tokenMint: cand.tokenMint,
    currentAction: 'block',
    isLive: false,
    isShadowArm: false,
    armName: armNameForVersion(config.kolHunterRotationV1ParameterVersion),
    entryReason: 'rotation_v1',
    rejectReason: `rotation_v1_${reason}`,
    independentKolCount: score.independentKolCount,
    effectiveIndependentCount: score.effectiveIndependentCount,
    kolScore: score.finalScore,
    participatingKols: score.participatingKols,
    survivalFlags: flags,
    recentJupiter429: currentRecentJupiter429(),
  });
  trackRotationNoTradeMarkout(cand, score, result, reason, flags);
}

function emitRotationUnderfillNoTradePolicy(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  result: RotationV1TriggerResult
): void {
  if (!shouldEmitRotationUnderfillNoTrade(result.reason)) return;
  const discountPct = -result.telemetry.priceResponsePct;
  if (result.reason === 'underfill_discount_too_low' && discountPct <= 0) return;
  const rotationState = ensureRotationV1State(cand);
  const reason = result.reason ?? 'unknown';
  if (rotationState.underfillNoTradeReasonsEmitted?.has(reason)) return;
  rotationState.underfillNoTradeReasonsEmitted?.add(reason);
  const flags = [
    ...result.flags,
    `ROTATION_UNDERFILL_NOTRADE_${reason.toUpperCase()}`,
    `ROTATION_UNDERFILL_DISCOUNT_PCT_${discountPct.toFixed(4)}`,
    `ROTATION_UNDERFILL_SCORE_${result.telemetry.rotationScore.toFixed(2)}`,
  ];
  if (typeof result.telemetry.lastBuyAgeMs === 'number') {
    flags.push(`ROTATION_UNDERFILL_LAST_BUY_AGE_${Math.round(result.telemetry.lastBuyAgeMs / 1000)}S`);
  }
  emitKolShadowPolicy({
    eventKind: 'reject',
    tokenMint: cand.tokenMint,
    currentAction: 'block',
    isLive: false,
    isShadowArm: false,
    armName: armNameForVersion(config.kolHunterRotationUnderfillParameterVersion),
    entryReason: 'rotation_v1',
    rejectReason: `rotation_underfill_${reason}`,
    independentKolCount: result.telemetry.distinctRotationKols || score.independentKolCount,
    effectiveIndependentCount: result.telemetry.distinctRotationKols || score.effectiveIndependentCount,
    kolScore: result.telemetry.rotationScore || score.finalScore,
    participatingKols: result.participatingKols ?? score.participatingKols,
    survivalFlags: flags,
    recentJupiter429: currentRecentJupiter429(),
  });
  trackRotationUnderfillNoTradeMarkout(cand, score, result, reason, flags);
}

function emitRotationChaseTopupNoTradePolicy(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  result: RotationV1TriggerResult
): void {
  if (!shouldEmitRotationChaseTopupNoTrade(result.reason)) return;
  const rotationState = ensureRotationV1State(cand);
  const reason = result.reason ?? 'unknown';
  if (rotationState.chaseTopupNoTradeReasonsEmitted?.has(reason)) return;
  rotationState.chaseTopupNoTradeReasonsEmitted?.add(reason);
  const flags = [
    ...result.flags,
    `ROTATION_CHASE_NOTRADE_${reason.toUpperCase()}`,
    `ROTATION_CHASE_SCORE_${result.telemetry.rotationScore.toFixed(2)}`,
  ];
  if (typeof result.telemetry.lastBuyAgeMs === 'number') {
    flags.push(`ROTATION_CHASE_LAST_BUY_AGE_${Math.round(result.telemetry.lastBuyAgeMs / 1000)}S`);
  }
  emitKolShadowPolicy({
    eventKind: 'reject',
    tokenMint: cand.tokenMint,
    currentAction: 'block',
    isLive: false,
    isShadowArm: false,
    armName: armNameForVersion(config.kolHunterRotationChaseTopupParameterVersion),
    entryReason: 'rotation_v1',
    rejectReason: `rotation_chase_topup_${reason}`,
    independentKolCount: result.telemetry.distinctRotationKols || score.independentKolCount,
    effectiveIndependentCount: result.telemetry.distinctRotationKols || score.effectiveIndependentCount,
    kolScore: result.telemetry.rotationScore || score.finalScore,
    participatingKols: result.participatingKols ?? score.participatingKols,
    survivalFlags: flags,
    recentJupiter429: currentRecentJupiter429(),
  });
  trackRotationChaseTopupNoTradeMarkout(cand, score, result, reason, flags);
}

function emitCapitulationNoTradePolicy(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  result: CapitulationReboundTriggerResult
): void {
  if (!shouldEmitCapitulationNoTrade(result.reason)) return;
  const capState = ensureCapitulationReboundState(cand);
  const reason = result.reason ?? 'unknown';
  const parameterVersion = capitulationParameterVersionForResult(result);
  const armName = armNameForVersion(parameterVersion);
  const emitted = parameterVersion === config.kolHunterCapitulationReboundRrParameterVersion
    ? capState.rrNoTradeReasonsEmitted ?? capState.noTradeReasonsEmitted
    : capState.noTradeReasonsEmitted;
  if (emitted.has(reason)) return;
  emitted.add(reason);
  const flags = [
    ...result.flags,
    `CAPITULATION_NOTRADE_${reason.toUpperCase()}`,
  ];
  emitKolShadowPolicy({
    eventKind: 'reject',
    tokenMint: cand.tokenMint,
    currentAction: 'block',
    isLive: false,
    isShadowArm: false,
    armName,
    entryReason: 'capitulation_rebound',
    rejectReason: `capitulation_rebound_${reason}`,
    independentKolCount: score.independentKolCount,
    effectiveIndependentCount: score.effectiveIndependentCount,
    kolScore: score.finalScore,
    participatingKols: result.participatingKols ?? score.participatingKols,
    survivalFlags: flags,
    recentJupiter429: currentRecentJupiter429(),
  });
  trackCapitulationNoTradeMarkout(cand, score, result, reason, flags);
}

async function enterCapitulationRrPaperSidecar(
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  smartFresh: SmartV3FreshContext,
  result: CapitulationReboundTriggerResult,
  nowMs: number
): Promise<void> {
  if (!result.triggered || !cand.smartV3) return;
  const capState = ensureCapitulationReboundState(cand);
  if (capState.rrEnteredAtMs != null) return;
  capState.rrEnteredAtMs = nowMs;
  const flags = [
    ...result.flags,
    'CAPITULATION_RR_PAPER_ONLY',
    'CAPITULATION_ENTRY_SELL_QUOTE_SIZED_REQUIRED',
  ];
  log.info(
    `[KOL_HUNTER_CAPITULATION_REBOUND_RR_TRIGGER] ${cand.tokenMint.slice(0, 8)} ` +
    `dd=${(result.telemetry.drawdownFromPeakPct * 100).toFixed(1)}% ` +
    `bounce=${(result.telemetry.bounceFromLowPct * 100).toFixed(1)}% ` +
    `rr=${(result.telemetry.rr ?? 0).toFixed(2)} ` +
    `postLowSell=${(result.telemetry.postLowSellSol ?? 0).toFixed(3)}SOL`
  );
  await enterPaperPosition(
    cand.tokenMint,
    cand,
    score,
    flags,
    {
      parameterVersion: config.kolHunterCapitulationReboundRrParameterVersion,
      positionIdSuffix: 'cap-rr',
      entryReason: 'capitulation_rebound',
      convictionLevel: 'MEDIUM_HIGH',
      tokenDecimals: cand.smartV3.tokenDecimals,
      tokenDecimalsSource: cand.smartV3.tokenDecimalsSource,
      capitulationTelemetry: result.telemetry,
      capitulationEntryLowPrice: result.telemetry.lowPrice,
      capitulationEntryLowAtMs: capState.lowAtMs,
      capitulationRecoveryConfirmations: result.telemetry.recoveryConfirmations,
      entryIndependentKolCount: smartFresh.triggerFreshIndependentKolCount || score.independentKolCount,
      entryKolScore: smartFresh.triggerFreshSignalScore || score.finalScore,
      entryParticipatingKols: result.participatingKols ?? score.participatingKols,
    }
  );
}

async function evaluateSmartV3Triggers(cand: PendingCandidate): Promise<void> {
  const smart = cand.smartV3;
  if (!smart || smart.resolving) return;

  const nowMs = Date.now();
  const score = computeKolDiscoveryScoreCached(cand.tokenMint, nowMs);  // P1 #7
  const smartFresh = buildSmartV3FreshContext(cand, nowMs);
  const smartTrigger = evaluateSmartV3TriggerState(cand, smartFresh);
  const rotationTrigger = smartTrigger.reason
    ? undefined
    : evaluateRotationV1TriggerState(cand, nowMs);
  const underfillTrigger = smartTrigger.reason || rotationTrigger?.triggered
    ? undefined
    : evaluateRotationUnderfillTriggerState(cand, nowMs);
  const chaseTopupTrigger = smartTrigger.reason || rotationTrigger?.triggered || underfillTrigger?.triggered
    ? undefined
    : evaluateRotationChaseTopupTriggerState(cand, nowMs);
  const capitulationTrigger =
    smartTrigger.reason || rotationTrigger?.triggered || underfillTrigger?.triggered || chaseTopupTrigger?.triggered
      ? undefined
      : evaluateCapitulationReboundTriggerState(cand, score, smartFresh, nowMs);
  const capitulationRrTrigger = evaluateCapitulationReboundRrTriggerState(cand, score, smartFresh, nowMs);
  const entrySignal: KolEntrySignal | undefined = smartTrigger.reason && smartTrigger.conviction
    ? {
        label: 'smart-v3',
        logTag: 'KOL_HUNTER_SMART_V3_TRIGGER',
        parameterVersion: config.kolHunterSmartV3ParameterVersion,
        entryReason: smartTrigger.reason,
        conviction: smartTrigger.conviction,
        extraFlags: smartFresh.flags,
      }
    : rotationTrigger?.triggered
      ? {
          label: 'rotation-v1',
          logTag: 'KOL_HUNTER_ROTATION_V1_TRIGGER',
          parameterVersion: config.kolHunterRotationV1ParameterVersion,
          entryReason: 'rotation_v1' as const,
          conviction: 'MEDIUM_HIGH' as const,
          extraFlags: rotationTrigger.flags,
          telemetry: rotationTrigger.telemetry,
          rotationAnchorKols: rotationTrigger.telemetry.anchorKols,
        }
      : underfillTrigger?.triggered
        ? {
            label: 'rotation-underfill',
            logTag: 'KOL_HUNTER_ROTATION_UNDERFILL_TRIGGER',
            parameterVersion: config.kolHunterRotationUnderfillParameterVersion,
            entryReason: 'rotation_v1' as const,
            conviction: 'MEDIUM_HIGH' as const,
            extraFlags: underfillTrigger.flags,
            telemetry: underfillTrigger.telemetry,
            rotationAnchorKols: underfillTrigger.telemetry.anchorKols,
            entryParticipatingKols: underfillTrigger.participatingKols,
            entryIndependentKolCount: underfillTrigger.telemetry.distinctRotationKols,
            entryKolScore: underfillTrigger.telemetry.rotationScore,
            paperOnly: !isRotationUnderfillLiveCanaryEnabled(),
            paperOnlyReason: isRotationUnderfillLiveCanaryEnabled()
              ? undefined
              : 'rotation_underfill_paper_only',
          }
      : chaseTopupTrigger?.triggered
        ? {
            label: 'rotation-chase-topup',
            logTag: 'KOL_HUNTER_ROTATION_CHASE_TOPUP_TRIGGER',
            parameterVersion: config.kolHunterRotationChaseTopupParameterVersion,
            entryReason: 'rotation_v1' as const,
            conviction: 'MEDIUM_HIGH' as const,
            extraFlags: [
              ...chaseTopupTrigger.flags.filter((flag) => flag !== 'ROTATION_CHASE_TOPUP_PAPER_ONLY'),
              ...(isKolLiveCanaryArmEnabled('rotation_chase_topup_v1')
                ? ['ROTATION_CHASE_TOPUP_LIVE_CANARY_ENABLED']
                : ['ROTATION_CHASE_TOPUP_PAPER_ONLY']),
            ],
            telemetry: chaseTopupTrigger.telemetry,
            rotationAnchorKols: chaseTopupTrigger.telemetry.anchorKols,
            entryParticipatingKols: chaseTopupTrigger.participatingKols,
            entryIndependentKolCount: chaseTopupTrigger.telemetry.distinctRotationKols,
            entryKolScore: chaseTopupTrigger.telemetry.rotationScore,
            paperOnly: !isKolLiveCanaryArmEnabled('rotation_chase_topup_v1'),
            paperOnlyReason: isKolLiveCanaryArmEnabled('rotation_chase_topup_v1')
              ? undefined
              : 'rotation_chase_topup_paper_only',
          }
      : capitulationTrigger?.triggered
        ? {
            label: 'capitulation-rebound',
            logTag: 'KOL_HUNTER_CAPITULATION_REBOUND_TRIGGER',
            parameterVersion: config.kolHunterCapitulationReboundParameterVersion,
            entryReason: 'capitulation_rebound' as const,
            conviction: 'MEDIUM_HIGH' as const,
            extraFlags: [
              ...capitulationTrigger.flags,
              'CAPITULATION_PAPER_ONLY',
              'CAPITULATION_ENTRY_SELL_QUOTE_SIZED_REQUIRED',
            ],
            entryParticipatingKols: capitulationTrigger.participatingKols,
            entryIndependentKolCount: smartFresh.triggerFreshIndependentKolCount || score.independentKolCount,
            entryKolScore: smartFresh.triggerFreshSignalScore || score.finalScore,
            paperOnly: true,
            paperOnlyReason: 'capitulation_rebound_paper_only',
          }
      : undefined;
  const capitulationRrSidecar = capitulationRrTrigger.triggered
    ? enterCapitulationRrPaperSidecar(cand, score, smartFresh, capitulationRrTrigger, nowMs)
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`[KOL_HUNTER_CAPITULATION_REBOUND_RR_ERROR] ${cand.tokenMint.slice(0, 8)} ${message}`);
        })
    : undefined;
  if (!entrySignal) {
    if (capitulationRrSidecar) await capitulationRrSidecar;
    if (rotationTrigger) emitRotationV1NoTradePolicy(cand, score, rotationTrigger);
    if (underfillTrigger) emitRotationUnderfillNoTradePolicy(cand, score, underfillTrigger);
    if (chaseTopupTrigger) emitRotationChaseTopupNoTradePolicy(cand, score, chaseTopupTrigger);
    if (capitulationTrigger) emitCapitulationNoTradePolicy(cand, score, capitulationTrigger);
    if (capitulationRrTrigger && !capitulationRrTrigger.triggered) {
      emitCapitulationNoTradePolicy(cand, score, capitulationRrTrigger);
    }
    return;
  }

  if (entrySignal.label === 'smart-v3') {
    smart.resolving = true;
    pending.delete(cand.tokenMint);
    cleanupPendingCandidate(cand, false);
  } else if (entrySignal.label === 'rotation-v1') {
    ensureRotationV1State(cand).enteredAtMs = nowMs;
  } else if (entrySignal.label === 'rotation-underfill') {
    ensureRotationV1State(cand).underfillEnteredAtMs = nowMs;
  } else if (entrySignal.label === 'rotation-chase-topup') {
    ensureRotationV1State(cand).chaseTopupEnteredAtMs = nowMs;
  } else {
    ensureCapitulationReboundState(cand).enteredAtMs = nowMs;
  }
  log.info(
    `[${entrySignal.logTag}] ${cand.tokenMint.slice(0, 8)} reason=${entrySignal.entryReason} ` +
    `conviction=${entrySignal.conviction} score=${score.finalScore.toFixed(2)} ` +
    `kols=${score.independentKolCount}` +
    (entrySignal.label === 'smart-v3'
      ? ` freshKols=${smartFresh.freshIndependentKolCount} freshStrong=${smartFresh.freshTierStrongCount} ` +
        `freshScore=${smartFresh.freshSignalScore.toFixed(2)}`
      : '') +
    (entrySignal.telemetry
      ? ` buys=${entrySignal.telemetry.buyCount} smallBuys=${entrySignal.telemetry.smallBuyCount} ` +
        `grossBuy=${Number(entrySignal.telemetry.grossBuySol).toFixed(3)}SOL ` +
        `refMove=${(entrySignal.telemetry.priceResponsePct * 100).toFixed(2)}%`
      : '') +
    (entrySignal.label === 'capitulation-rebound' && capitulationTrigger
      ? ` dd=${(capitulationTrigger.telemetry.drawdownFromPeakPct * 100).toFixed(1)}% ` +
        `bounce=${(capitulationTrigger.telemetry.bounceFromLowPct * 100).toFixed(1)}% ` +
        `recovery=${capitulationTrigger.telemetry.recoveryConfirmations}`
      : '')
  );

  // 2026-04-29 (P0-2 quality fix): smart-v3 production main path 에도 KOL alpha decay 적용.
  // 이전 patch 는 resolveStalk (v1/legacy) 만 적용 → smart-v3 (kolHunterSmartV3Enabled=true default)
  // 운영 환경에서 효과 0. 이 위치 (trigger 발화 직후, entry 진입 직전) 에 차단 검사 삽입.
  // same-token cooldown 도 누락이라 함께 추가.
  const candIsShadowForHardCutReentry = cand.kolTxs.length > 0 && cand.kolTxs.every((t) => t.isShadow === true);
  const canConsiderSmartV3LiveHardCutReentry =
    entrySignal.label === 'smart-v3' &&
    isLiveCanaryActive() &&
    !!botCtx &&
    !candIsShadowForHardCutReentry;
  const cooldownCheck = isInReentryCooldown(cand.tokenMint);
  const smartV3HardCutReentry: SmartV3LiveHardCutReentryDecision =
    cooldownCheck.blocked && canConsiderSmartV3LiveHardCutReentry
    ? evaluateSmartV3LiveHardCutReentry(cand.tokenMint, smart.currentPrice, nowMs)
    : { allowed: false, reason: 'not_applicable' };
  if (cooldownCheck.blocked && !smartV3HardCutReentry.allowed) {
    log.info(
      `[KOL_HUNTER_ENTRY_REENTRY_BLOCK] ${cand.tokenMint.slice(0, 8)} ${entrySignal.label} ` +
      `cooldown ${Math.round(cooldownCheck.remainingMs/1000)}s ` +
      `hardCutReentry=${smartV3HardCutReentry.reason ?? 'blocked'} — reject`
    );
    fireRejectObserver(cand.tokenMint, 'smart_v3_no_trigger', cand, score, {
      survivalReason: 'reentry_cooldown',
      survivalFlags: ['REENTRY_COOLDOWN'],
      cooldownRemainingMs: cooldownCheck.remainingMs,
      entryReason: entrySignal.entryReason,
      parameterVersion: entrySignal.parameterVersion,
      rotationV1: entrySignal.label !== 'smart-v3'
        ? entrySignal.telemetry
        : undefined,
    });
    if (entrySignal.label === 'smart-v3') {
      cleanupPendingCandidate(cand, true);
    }
    return;
  } else if (cooldownCheck.blocked && smartV3HardCutReentry.allowed) {
    log.warn(
      `[KOL_HUNTER_SMART_V3_HARDCUT_REENTRY_ALLOW] ${cand.tokenMint.slice(0, 8)} ` +
      `cooldownBypass parent=${smartV3HardCutReentry.state?.parentPositionId ?? 'unknown'} ` +
      `discount=${((smartV3HardCutReentry.discountPct ?? 0) * 100).toFixed(2)}% ` +
      `recovery=${((smartV3HardCutReentry.recoveredFromCutPct ?? 0) * 100).toFixed(2)}%`
    );
  }
  const decayParticipants = entrySignal.entryParticipatingKols && entrySignal.entryParticipatingKols.length > 0
    ? entrySignal.entryParticipatingKols
    : score.participatingKols;
  const decayCheck = checkKolAlphaDecay(decayParticipants.map((k) => k.id));
  if (decayCheck.blocked) {
    log.info(`[KOL_HUNTER_ENTRY_DECAY_BLOCK] ${cand.tokenMint.slice(0, 8)} ${entrySignal.label} ${decayCheck.reason} — reject`);
    if (entrySignal.label !== 'smart-v3' && entrySignal.telemetry) {
      const rotationState = ensureRotationV1State(cand);
      const emitted = entrySignal.label === 'rotation-underfill'
        ? rotationState.underfillNoTradeReasonsEmitted
        : rotationState.noTradeReasonsEmitted;
      if (!emitted?.has('kol_alpha_decay')) {
        emitted?.add('kol_alpha_decay');
        const flags = entrySignal.label === 'rotation-underfill'
          ? ['KOL_ALPHA_DECAY', 'ROTATION_UNDERFILL_NOTRADE_KOL_ALPHA_DECAY']
          : entrySignal.label === 'rotation-chase-topup'
            ? ['KOL_ALPHA_DECAY', 'ROTATION_CHASE_NOTRADE_KOL_ALPHA_DECAY']
            : ['KOL_ALPHA_DECAY', 'ROTATION_V1_NOTRADE_KOL_ALPHA_DECAY'];
        const decayResult: RotationV1TriggerResult = {
          triggered: false,
          reason: 'kol_alpha_decay',
          flags: ['KOL_ALPHA_DECAY'],
          participatingKols: entrySignal.entryParticipatingKols,
          telemetry: entrySignal.telemetry,
        };
        if (entrySignal.label === 'rotation-underfill') {
          trackRotationUnderfillNoTradeMarkout(cand, score, decayResult, 'kol_alpha_decay', flags);
        } else if (entrySignal.label === 'rotation-chase-topup') {
          trackRotationChaseTopupNoTradeMarkout(cand, score, decayResult, 'kol_alpha_decay', flags);
        } else {
          trackRotationNoTradeMarkout(cand, score, decayResult, 'kol_alpha_decay', flags);
        }
      }
    }
    fireRejectObserver(cand.tokenMint, 'smart_v3_no_trigger', cand, score, {
      survivalReason: 'kol_alpha_decay',
      survivalFlags: ['KOL_ALPHA_DECAY'],
      entryReason: entrySignal.entryReason,
      parameterVersion: entrySignal.parameterVersion,
      rotationV1: entrySignal.label !== 'smart-v3'
        ? entrySignal.telemetry
        : undefined,
      signalPrice: smart.currentPrice,
      tokenDecimals: smart.tokenDecimals,
    });
    if (entrySignal.label === 'smart-v3') {
      cleanupPendingCandidate(cand, true);
    }
    return;
  }

  const profileArm = entrySignal.label === 'rotation-underfill'
    ? rotationUnderfillLiveProfileArm()
    : undefined;
  const entryArm = entrySignal.label === 'rotation-underfill'
    ? ROTATION_UNDERFILL_ARM
    : undefined;
  const exitArm = entrySignal.label === 'rotation-underfill' && profileArm
    ? ROTATION_EXIT_FLOW_ARM
    : undefined;
  const liveEquivalenceCandidateId = buildLiveEquivalenceCandidateId(
    cand.tokenMint,
    entrySignal,
    Date.now(),
    undefined,
    profileArm
  );
  const entryOptions: PaperEntryOptions = {
    parameterVersion: entrySignal.parameterVersion,
    profileArm,
    entryArm,
    exitArm,
    entryReason: entrySignal.entryReason,
    convictionLevel: entrySignal.conviction,
    liveEquivalenceCandidateId,
    tokenDecimals: smart.tokenDecimals,
    tokenDecimalsSource: smart.tokenDecimalsSource,
    entrySecurityEvidence: smart.preEntrySecurityEvidence,
    rotationTelemetry: entrySignal.telemetry,
    rotationAnchorKols: entrySignal.rotationAnchorKols,
    rotationAnchorPrice: entrySignal.telemetry?.anchorPrice,
    rotationAnchorPriceSource: entrySignal.telemetry?.anchorPriceSource,
    rotationFirstBuyAtMs: entrySignal.telemetry?.firstBuyAtMs ?? undefined,
    rotationLastBuyAtMs: entrySignal.telemetry?.lastBuyAtMs ?? undefined,
    rotationLastBuyAgeMs: entrySignal.telemetry?.lastBuyAgeMs ?? undefined,
    rotationScore: entrySignal.telemetry?.rotationScore,
    underfillReferenceSolAmount: entrySignal.telemetry?.underfillReferenceSolAmount,
    underfillReferenceTokenAmount: entrySignal.telemetry?.underfillReferenceTokenAmount,
    rotationFlowExitEnabled: entrySignal.label === 'rotation-underfill' &&
      isRotationUnderfillExitFlowLiveCanaryEnabled(),
    smartV3LiveHardCutReentry: smartV3HardCutReentry.allowed,
    smartV3HardCutParentPositionId: smartV3HardCutReentry.state?.parentPositionId,
    smartV3HardCutAtMs: smartV3HardCutReentry.state?.closedAtMs,
    smartV3HardCutEntryPrice: smartV3HardCutReentry.state?.parentEntryPrice,
    smartV3HardCutExitPrice: smartV3HardCutReentry.state?.hardCutPrice,
    smartV3HardCutDiscountPct: smartV3HardCutReentry.discountPct,
    capitulationTelemetry: entrySignal.label === 'capitulation-rebound'
      ? capitulationTrigger?.telemetry
      : undefined,
    capitulationEntryLowPrice: entrySignal.label === 'capitulation-rebound'
      ? capitulationTrigger?.telemetry.lowPrice
      : undefined,
    capitulationEntryLowAtMs: entrySignal.label === 'capitulation-rebound'
      ? ensureCapitulationReboundState(cand).lowAtMs
      : undefined,
    capitulationRecoveryConfirmations: entrySignal.label === 'capitulation-rebound'
      ? capitulationTrigger?.telemetry.recoveryConfirmations
      : undefined,
    entryIndependentKolCount: entrySignal.label === 'smart-v3'
      ? smartFresh.freshIndependentKolCount
      : entrySignal.entryIndependentKolCount,
    entryKolScore: entrySignal.label === 'smart-v3'
      ? smartFresh.freshSignalScore
      : entrySignal.entryKolScore,
    entryParticipatingKols: entrySignal.label === 'smart-v3'
      ? (smartFresh.freshParticipatingKols.length > 0
          ? smartFresh.freshParticipatingKols
          : smartFresh.shadowFreshParticipatingKols)
      : entrySignal.entryParticipatingKols,
    smartV3EntryComboKey: entrySignal.label === 'smart-v3'
      ? smartV3ComboKey(smartFresh.freshParticipatingKols.map((k) => k.id))
      : undefined,
  };
  const entryPolicyMetrics = entrySignal.label === 'smart-v3'
    ? {
        independentKolCount: smartFresh.freshIndependentKolCount,
        effectiveIndependentCount: smartFresh.freshIndependentKolCount,
        kolScore: smartFresh.freshSignalScore,
      }
    : entrySignal.entryIndependentKolCount != null || entrySignal.entryKolScore != null
      ? {
          independentKolCount: entrySignal.entryIndependentKolCount ?? score.independentKolCount,
          effectiveIndependentCount: entrySignal.entryIndependentKolCount ?? score.effectiveIndependentCount,
          kolScore: entrySignal.entryKolScore ?? score.finalScore,
        }
      : {};
  const postDistribution = evaluatePostDistributionGuard({
    tokenMint: cand.tokenMint,
    nowMs: Date.now(),
    recentKolTxs,
    participatingKols: score.participatingKols,
    priorKolSellCancelAtMs: recentSmartV3SellCancelAt(cand.tokenMint),
    config: {
      enabled: config.kolHunterPostDistributionGuardEnabled,
      windowMs: config.kolHunterPostDistributionWindowSec * 1000,
      minGrossSellSol: config.kolHunterPostDistributionMinGrossSellSol,
      minDistinctSellKols: config.kolHunterPostDistributionMinSellKols,
      cancelQuarantineMs: config.kolHunterPostDistributionCancelQuarantineSec * 1000,
    },
  });
  const entryFlags = [
    ...smart.preEntryFlags,
    ...entrySignal.extraFlags,
    ...postDistribution.flags,
    ...(smartV3HardCutReentry.allowed ? ['SMART_V3_LIVE_HARD_CUT_REENTRY'] : []),
  ];
  const smartV3HardCutReentryLiveOnly = entrySignal.label === 'smart-v3' && smartV3HardCutReentry.allowed;
  const rejectSmartV3HardCutReentryLiveOnlyFallback = (
    blockReason: string,
    flags: string[],
    extras: Record<string, unknown> = {}
  ): void => {
    const survivalFlags = [
      ...flags,
      'SMART_V3_LIVE_HARD_CUT_REENTRY_LIVE_ONLY_BLOCK',
    ];
    log.warn(
      `[KOL_HUNTER_SMART_V3_HARDCUT_REENTRY_LIVE_BLOCK] ${cand.tokenMint.slice(0, 8)} ` +
      `reason=${blockReason} parent=${smartV3HardCutReentry.state?.parentPositionId ?? 'unknown'} — no paper fallback`
    );
    fireRejectObserver(cand.tokenMint, 'smart_v3_no_trigger', cand, score, {
      survivalReason: 'smart_v3_hardcut_reentry_live_blocked',
      survivalFlags,
      liveOnlyBlockReason: blockReason,
      smartV3HardCutParentPositionId: smartV3HardCutReentry.state?.parentPositionId,
      smartV3HardCutAtMs: smartV3HardCutReentry.state?.closedAtMs,
      smartV3HardCutEntryPrice: smartV3HardCutReentry.state?.parentEntryPrice,
      smartV3HardCutExitPrice: smartV3HardCutReentry.state?.hardCutPrice,
      smartV3HardCutDiscountPct: smartV3HardCutReentry.discountPct,
      smartV3HardCutRecoveryPct: smartV3HardCutReentry.recoveredFromCutPct,
      entryReason: entryOptions.entryReason,
      parameterVersion: entryOptions.parameterVersion,
      signalPrice: smart.currentPrice,
      tokenDecimals: smart.tokenDecimals,
      ...extras,
    });
    cleanupPendingCandidate(cand, true);
  };
  if (postDistribution.blocked) {
    log.warn(
      `[KOL_HUNTER_POST_DISTRIBUTION_BLOCK] ${cand.tokenMint.slice(0, 8)} ${entrySignal.label} trigger — ` +
      `${postDistribution.reason} grossSell=${postDistribution.telemetry.sellSol.toFixed(3)}SOL ` +
      `netSell=${postDistribution.telemetry.netSellSol.toFixed(3)}SOL ` +
      `sellKols=${postDistribution.telemetry.distinctSellKols} ` +
      `freshBuyKols=${postDistribution.telemetry.freshIndependentBuyKols}. no entry.`
    );
    fireRejectObserver(cand.tokenMint, 'post_distribution_entry_block', cand, score, {
      survivalReason: postDistribution.reason,
      survivalFlags: entryFlags,
      postDistributionGuard: postDistribution.telemetry,
      rotationV1: entrySignal.label !== 'smart-v3'
        ? entrySignal.telemetry
        : undefined,
      entryReason: entryOptions.entryReason,
      parameterVersion: entryOptions.parameterVersion,
      signalPrice: smart.currentPrice,
      tokenDecimals: smart.tokenDecimals,
    });
    if (entrySignal.label === 'smart-v3') {
      cleanupPendingCandidate(cand, true);
    }
    return;
  }

  const candIsShadow = cand.kolTxs.length > 0 && cand.kolTxs.every((t) => t.isShadow === true);
  const liveCanaryLane = kolHunterCanaryLaneForEntrySignal(entrySignal);
  const hardTradingHaltReasonForShadow = botCtx
    ? getHardTradingHaltReason(botCtx.tradingHaltedReason)
    : null;
  const smartV3LiveEligibilityShadow = buildSmartV3LiveEligibilityShadow({
    cand,
    score,
    entrySignal,
    entryFlags,
    smartFresh,
    candIsShadow,
    hardTradingHaltReason: hardTradingHaltReasonForShadow,
  });
  const entryOptionsWithLiveShadow: PaperEntryOptions = smartV3LiveEligibilityShadow
    ? {
        ...entryOptions,
        canaryLane: liveCanaryLane,
        ...smartV3LiveEligibilityShadow,
      }
    : {
        ...entryOptions,
        canaryLane: liveCanaryLane,
      };
  const withLiveEquivalence = (
    base: PaperEntryOptions,
    stage: KolLiveEquivalenceDecisionStage,
    liveWouldEnter: boolean,
    reason?: string | null,
    flags?: string[],
  ): PaperEntryOptions => ({
    ...base,
    ...buildLiveEquivalenceOptionPatch({
      candidateId: base.liveEquivalenceCandidateId ?? liveEquivalenceCandidateId,
      stage,
      liveWouldEnter,
      reason,
      flags,
    }),
  });
  if (entrySignal.label === 'smart-v3') {
    const baseShadowFlags = [
      ...entryFlags,
      'SMART_V3_ENTRY_FILTER_SHADOW',
    ];
    if (entrySignal.entryReason !== 'velocity') {
      trackSmartV3EntryFilterShadowMarkout(cand, score, {
        entryReason: entrySignal.entryReason,
        signalPrice: smart.currentPrice,
        tokenDecimals: smart.tokenDecimals,
        tokenDecimalsSource: smart.tokenDecimalsSource,
        armName: 'smart_v3_velocity_only_shadow',
        parameterVersion: 'smart-v3-velocity-only-shadow-v1.0.0',
        noTradeReason: 'smart_v3_velocity_only_reject',
        survivalFlags: [...baseShadowFlags, 'SMART_V3_FILTER_VELOCITY_ONLY_REJECT'],
        smartFresh,
        smartV3LiveEligibleShadow: entryOptionsWithLiveShadow.smartV3LiveEligibleShadow,
        smartV3LiveBlockReason: entryOptionsWithLiveShadow.smartV3LiveBlockReason,
        smartV3LiveBlockFlags: entryOptionsWithLiveShadow.smartV3LiveBlockFlags,
      });
    }
    if (entryOptionsWithLiveShadow.smartV3LiveEligibleShadow !== true) {
      trackSmartV3EntryFilterShadowMarkout(cand, score, {
        entryReason: entrySignal.entryReason,
        signalPrice: smart.currentPrice,
        tokenDecimals: smart.tokenDecimals,
        tokenDecimalsSource: smart.tokenDecimalsSource,
        armName: 'smart_v3_live_eligible_only_shadow',
        parameterVersion: 'smart-v3-live-eligible-only-shadow-v1.0.0',
        noTradeReason: 'smart_v3_live_eligible_only_reject',
        survivalFlags: [...baseShadowFlags, 'SMART_V3_FILTER_LIVE_ELIGIBLE_ONLY_REJECT'],
        smartFresh,
        smartV3LiveEligibleShadow: entryOptionsWithLiveShadow.smartV3LiveEligibleShadow,
        smartV3LiveBlockReason: entryOptionsWithLiveShadow.smartV3LiveBlockReason,
        smartV3LiveBlockFlags: entryOptionsWithLiveShadow.smartV3LiveBlockFlags,
      });
    }
  }

  if (entrySignal.paperOnly) {
    const policyFlags = [
      ...entryFlags,
      entrySignal.paperOnlyReason?.toUpperCase() ?? 'ROTATION_UNDERFILL_PAPER_ONLY',
    ];
    log.warn(
      `[KOL_HUNTER_PAPER_ONLY] ${cand.tokenMint.slice(0, 8)} ` +
      `label=${entrySignal.label} reason=${entrySignal.paperOnlyReason ?? 'paper_only'} ` +
      `refMove=${(Number(entrySignal.telemetry?.priceResponsePct ?? 0) * 100).toFixed(2)}% ` +
      `kols=${entrySignal.entryIndependentKolCount ?? 0} score=${(entrySignal.entryKolScore ?? 0).toFixed(2)}. ` +
      `enter paper.`
    );
    emitKolLiveEquivalence({
      candidateId: liveEquivalenceCandidateId,
      tokenMint: cand.tokenMint,
      entrySignal,
      score,
      entryOptions: entryOptionsWithLiveShadow,
      survivalFlags: policyFlags,
      candIsShadow,
      stage: 'paper_only',
      liveWouldEnter: false,
      liveBlockReason: entrySignal.paperOnlyReason ?? 'paper_only',
      liveBlockFlags: policyFlags,
      paperOnlyReason: entrySignal.paperOnlyReason ?? 'paper_only',
    });
    await enterPaperPosition(
      cand.tokenMint,
      cand,
      score,
      policyFlags,
      withLiveEquivalence(
        entryOptionsWithLiveShadow,
        'paper_only',
        false,
        entrySignal.paperOnlyReason ?? 'paper_only',
        policyFlags,
      ),
    );
    return;
  }

  // 2026-04-28 fix: smart-v3 main arm 이 live canary 의 1st-class entry path. 이전에는
  // enterPaperPosition 만 호출하여 KOL_HUNTER_LIVE_CANARY_ENABLED=true 환경에서도
  // executor.executeBuy 가 절대 호출되지 않는 dead-path 였다 (commit 1469a08 의 누락).
  // triple-flag gate 통과 시 enterLivePosition 으로 분기. swing-v2 shadow 는 enterLivePosition
  // 안에서 paper paired 로 자동 추가됨 (재귀 방지).
  // 2026-04-28: inactive (shadow) KOL 만으로 trigger 된 cand 는 live canary 차단 — 무조건 paper.
  // shadow 측정 자체가 active 승격 candidate 식별용이라 실 자산 노출 금지.
  if (isLiveCanaryActive() && botCtx && !candIsShadow) {
    const sameMintLiveActive = getActivePositionsByMint(cand.tokenMint).some((p) =>
      p.isLive === true && !p.isShadowArm
    );
    if (sameMintLiveActive) {
      const policyFlags = [
        ...entryFlags,
        'SAME_MINT_LIVE_EXPOSURE_GUARD',
      ];
      if (smartV3HardCutReentryLiveOnly) {
        rejectSmartV3HardCutReentryLiveOnlyFallback('same_mint_live_active', policyFlags);
        return;
      }
      log.warn(
        `[KOL_HUNTER_SAME_MINT_LIVE_GUARD] ${cand.tokenMint.slice(0, 8)} ${entrySignal.label} trigger — ` +
        `fallback paper.`
      );
      emitKolLiveFallbackPolicy(cand.tokenMint, score, policyFlags, {
        ...entryPolicyMetrics,
        entryReason: entryOptions.entryReason,
        armName: entryOptions.parameterVersion ? armNameForVersion(entryOptions.parameterVersion) : undefined,
      });
      emitKolLiveEquivalence({
        candidateId: liveEquivalenceCandidateId,
        tokenMint: cand.tokenMint,
        entrySignal,
        score,
        entryOptions: entryOptionsWithLiveShadow,
        survivalFlags: policyFlags,
        candIsShadow,
        stage: 'same_mint_live_guard',
        liveWouldEnter: false,
        liveBlockReason: 'same_mint_live_active',
        liveBlockFlags: policyFlags,
        sameMintLiveActive,
      });
      await enterPaperPosition(cand.tokenMint, cand, score, policyFlags, {
        ...withLiveEquivalence(entryOptionsWithLiveShadow, 'same_mint_live_guard', false, 'same_mint_live_active', policyFlags),
        skipPolicyEntry: true,
      });
      return;
    }
    if (entrySignal.label === 'rotation-v1' && !isKolLiveCanaryArmEnabled('rotation_v1')) {
      const policyFlags = [
        ...entryFlags,
        'ROTATION_V1_LIVE_DISABLED',
      ];
      log.warn(
        `[KOL_HUNTER_ROTATION_V1_LIVE_DISABLED] ${cand.tokenMint.slice(0, 8)} rotation-v1 trigger — ` +
        `fallback paper.`
      );
      emitKolLiveFallbackPolicy(cand.tokenMint, score, policyFlags, {
        ...entryPolicyMetrics,
        entryReason: entryOptions.entryReason,
        armName: entryOptions.parameterVersion ? armNameForVersion(entryOptions.parameterVersion) : undefined,
      });
      emitKolLiveEquivalence({
        candidateId: liveEquivalenceCandidateId,
        tokenMint: cand.tokenMint,
        entrySignal,
        score,
        entryOptions: entryOptionsWithLiveShadow,
        survivalFlags: policyFlags,
        candIsShadow,
        stage: 'rotation_live_disabled',
        liveWouldEnter: false,
        liveBlockReason: 'rotation_v1_live_disabled',
        liveBlockFlags: policyFlags,
      });
      await enterPaperPosition(cand.tokenMint, cand, score, policyFlags, {
        ...withLiveEquivalence(entryOptionsWithLiveShadow, 'rotation_live_disabled', false, 'rotation_v1_live_disabled', policyFlags),
        skipPolicyEntry: true,
      });
      return;
    }
    // 2026-04-30 (P1.5): daily-loss halt 도 wallet stop / canary halt 와 동일 강도로 fallback paper.
    //   이전: tradingHaltedReason 은 signalProcessor 의 5분 lane filter 만 → KOL lane 우회 발생.
    //   실측: AwuMSrQm trade 가 daily halt -0.1951 SOL 활성 1h 12m 후 live entry → 추가 -0.0099 SOL 손실.
    //   wallet floor 와 daily halt 사이 buffer 확보를 위해 KOL lane 도 존중.
    const hardTradingHaltReason = getHardTradingHaltReason(botCtx.tradingHaltedReason);
    if (hardTradingHaltReason) {
      if (smartV3HardCutReentryLiveOnly) {
        rejectSmartV3HardCutReentryLiveOnlyFallback('hard_trading_halt', [
          ...entryFlags,
          'LIVE_HARD_TRADING_HALT',
        ], { hardTradingHaltReason });
        return;
      }
      log.warn(
        `[KOL_HUNTER_TRADING_HALT] ${cand.tokenMint.slice(0, 8)} ${entrySignal.label} trigger — ` +
        `${hardTradingHaltReason}. fallback paper.`
      );
      const policyFlags = [...entryFlags, 'LIVE_HARD_TRADING_HALT'];
      emitKolLiveEquivalence({
        candidateId: liveEquivalenceCandidateId,
        tokenMint: cand.tokenMint,
        entrySignal,
        score,
        entryOptions: entryOptionsWithLiveShadow,
        survivalFlags: policyFlags,
        candIsShadow,
        stage: 'hard_trading_halt',
        liveWouldEnter: false,
        liveBlockReason: 'hard_trading_halt',
        liveBlockFlags: policyFlags,
        hardTradingHaltReason,
      });
      await enterPaperPosition(
        cand.tokenMint,
        cand,
        score,
        policyFlags,
        withLiveEquivalence(entryOptionsWithLiveShadow, 'hard_trading_halt', false, 'hard_trading_halt', policyFlags),
      );
      return;
    }
    if (isDrawdownGuardHaltReason(botCtx.tradingHaltedReason)) {
      log.warn(
        `[KOL_HUNTER_DRAWDOWN_GUARD_SOFT] ${cand.tokenMint.slice(0, 8)} ${entrySignal.label} trigger — ` +
        `${botCtx.tradingHaltedReason}. continuing live; wallet floor guard remains active.`
      );
    }
    if (isWalletStopActive()) {
      if (smartV3HardCutReentryLiveOnly) {
        rejectSmartV3HardCutReentryLiveOnlyFallback('wallet_stop_active', [
          ...entryFlags,
          'WALLET_STOP_ACTIVE',
        ]);
        return;
      }
      log.warn(
        `[KOL_HUNTER_WALLET_STOP] ${cand.tokenMint.slice(0, 8)} ${entrySignal.label} trigger — ` +
        `wallet floor active. fallback paper.`
      );
      const policyFlags = [...entryFlags, 'WALLET_STOP_ACTIVE'];
      emitKolLiveEquivalence({
        candidateId: liveEquivalenceCandidateId,
        tokenMint: cand.tokenMint,
        entrySignal,
        score,
        entryOptions: entryOptionsWithLiveShadow,
        survivalFlags: policyFlags,
        candIsShadow,
        stage: 'wallet_stop',
        liveWouldEnter: false,
        liveBlockReason: 'wallet_stop_active',
        liveBlockFlags: policyFlags,
      });
      await enterPaperPosition(
        cand.tokenMint,
        cand,
        score,
        policyFlags,
        withLiveEquivalence(entryOptionsWithLiveShadow, 'wallet_stop', false, 'wallet_stop_active', policyFlags),
      );
      return;
    }
    if (isEntryHaltActive(liveCanaryLane)) {
      if (smartV3HardCutReentryLiveOnly) {
        rejectSmartV3HardCutReentryLiveOnlyFallback('entry_halt_active', [
          ...entryFlags,
          'ENTRY_HALT_ACTIVE',
        ]);
        return;
      }
      log.warn(
        `[KOL_HUNTER_ENTRY_HALT] ${cand.tokenMint.slice(0, 8)} ${entrySignal.label} trigger — ` +
        `lane=${liveCanaryLane} halt active. fallback paper.`
      );
      const policyFlags = [...entryFlags, 'ENTRY_HALT_ACTIVE'];
      emitKolLiveEquivalence({
        candidateId: liveEquivalenceCandidateId,
        tokenMint: cand.tokenMint,
        entrySignal,
        score,
        entryOptions: entryOptionsWithLiveShadow,
        survivalFlags: policyFlags,
        candIsShadow,
        stage: 'entry_halt',
        liveWouldEnter: false,
        liveBlockReason: 'entry_halt_active',
        liveBlockFlags: policyFlags,
      });
      await enterPaperPosition(
        cand.tokenMint,
        cand,
        score,
        policyFlags,
        withLiveEquivalence(entryOptionsWithLiveShadow, 'entry_halt', false, 'entry_halt_active', policyFlags),
      );
      return;
    }
    const qualityCooldown = isInLiveExecutionQualityCooldown(cand.tokenMint);
    if (qualityCooldown.blocked) {
      const policyFlags = [
        ...entryFlags,
        'LIVE_EXEC_QUALITY_COOLDOWN',
      ];
      if (smartV3HardCutReentryLiveOnly) {
        rejectSmartV3HardCutReentryLiveOnlyFallback('live_execution_quality_cooldown', policyFlags, {
          liveExecutionQualityReason: qualityCooldown.reason,
          liveExecutionQualityRemainingMs: qualityCooldown.remainingMs,
        });
        return;
      }
      log.warn(
        `[KOL_HUNTER_LIVE_QUALITY_COOLDOWN] ${cand.tokenMint.slice(0, 8)} ${entrySignal.label} trigger — ` +
        `${qualityCooldown.reason ?? 'execution_quality'} ` +
        `remaining=${Math.round(qualityCooldown.remainingMs / 1000)}s. fallback paper.`
      );
      emitKolLiveFallbackPolicy(cand.tokenMint, score, policyFlags, {
        ...entryPolicyMetrics,
        entryReason: entryOptions.entryReason,
        armName: entryOptions.parameterVersion ? armNameForVersion(entryOptions.parameterVersion) : undefined,
      });
      emitKolLiveEquivalence({
        candidateId: liveEquivalenceCandidateId,
        tokenMint: cand.tokenMint,
        entrySignal,
        score,
        entryOptions: entryOptionsWithLiveShadow,
        survivalFlags: policyFlags,
        candIsShadow,
        stage: 'live_execution_quality_cooldown',
        liveWouldEnter: false,
        liveBlockReason: 'live_execution_quality_cooldown',
        liveBlockFlags: policyFlags,
        liveExecutionQualityReason: qualityCooldown.reason ?? null,
        liveExecutionQualityRemainingMs: qualityCooldown.remainingMs,
      });
      await enterPaperPosition(cand.tokenMint, cand, score, policyFlags, {
        ...withLiveEquivalence(
          entryOptionsWithLiveShadow,
          'live_execution_quality_cooldown',
          false,
          'live_execution_quality_cooldown',
          policyFlags,
        ),
        skipPolicyEntry: true,
      });
      return;
    }
    const isRotationSingleKolLiveCandidate =
      entrySignal.label === 'rotation-v1' ||
      entrySignal.label === 'rotation-underfill' ||
      entrySignal.label === 'rotation-chase-topup';
    const liveGate = evaluateKolLiveCanaryGate(score, entryFlags, {
      liveMinIndependentKol: isRotationSingleKolLiveCandidate
        ? config.kolHunterRotationV1MinIndependentKol
        : undefined,
      independentKolCountOverride: entrySignal.label === 'smart-v3'
        ? smartFresh.freshIndependentKolCount
        : isRotationSingleKolLiveCandidate
          ? entrySignal.entryIndependentKolCount
        : undefined,
    });
    if (!liveGate.allowLive) {
      const policyFlags = [...entryFlags, ...liveGate.flags];
      if (smartV3HardCutReentryLiveOnly) {
        rejectSmartV3HardCutReentryLiveOnlyFallback(liveGate.reason ?? 'live_gate_blocked', policyFlags);
        return;
      }
      log.warn(
        `[KOL_HUNTER_YELLOW_ZONE] ${cand.tokenMint.slice(0, 8)} ${entrySignal.label} trigger — ` +
        `${liveGate.reason}. fallback paper.`
      );
      emitKolLiveFallbackPolicy(cand.tokenMint, score, policyFlags, {
        ...entryPolicyMetrics,
        entryReason: entryOptions.entryReason,
        armName: entryOptions.parameterVersion ? armNameForVersion(entryOptions.parameterVersion) : undefined,
      });
      emitKolLiveEquivalence({
        candidateId: liveEquivalenceCandidateId,
        tokenMint: cand.tokenMint,
        entrySignal,
        score,
        entryOptions: entryOptionsWithLiveShadow,
        survivalFlags: policyFlags,
        candIsShadow,
        stage: 'yellow_zone',
        liveWouldEnter: false,
        liveBlockReason: liveGate.reason ?? 'live_gate_blocked',
        liveBlockFlags: policyFlags,
      });
      await enterPaperPosition(cand.tokenMint, cand, score, policyFlags, {
        ...withLiveEquivalence(
          entryOptionsWithLiveShadow,
          'yellow_zone',
          false,
          liveGate.reason ?? 'live_gate_blocked',
          policyFlags,
        ),
        skipPolicyEntry: true,
      });
      return;
    }
    const rotationUnderfillLiveFallback = evaluateRotationUnderfillLiveFallback(entrySignal, entryFlags);
    if (rotationUnderfillLiveFallback.fallback) {
      const policyFlags = [
        ...entryFlags,
        ...rotationUnderfillLiveFallback.flags,
      ];
      log.warn(
        `[KOL_HUNTER_ROTATION_UNDERFILL_LIVE_FALLBACK] ${cand.tokenMint.slice(0, 8)} ` +
        `reason=${rotationUnderfillLiveFallback.reason}. fallback paper.`
      );
      emitKolLiveFallbackPolicy(cand.tokenMint, score, policyFlags, {
        ...entryPolicyMetrics,
        entryReason: entryOptions.entryReason,
        armName: entryOptions.parameterVersion ? armNameForVersion(entryOptions.parameterVersion) : undefined,
      });
      emitKolLiveEquivalence({
        candidateId: liveEquivalenceCandidateId,
        tokenMint: cand.tokenMint,
        entrySignal,
        score,
        entryOptions: entryOptionsWithLiveShadow,
        survivalFlags: policyFlags,
        candIsShadow,
        stage: 'rotation_underfill_live_fallback',
        liveWouldEnter: false,
        liveBlockReason: rotationUnderfillLiveFallback.reason ?? 'rotation_underfill_live_fallback',
        liveBlockFlags: policyFlags,
      });
      await enterPaperPosition(cand.tokenMint, cand, score, policyFlags, {
        ...withLiveEquivalence(
          entryOptionsWithLiveShadow,
          'rotation_underfill_live_fallback',
          false,
          rotationUnderfillLiveFallback.reason ?? 'rotation_underfill_live_fallback',
          policyFlags,
        ),
        skipPolicyEntry: true,
      });
      return;
    }
    const smartV3LiveFallback = evaluateSmartV3LiveFallback(cand, entrySignal, smartFresh, entryFlags);
    let liveEntryFlags = entryFlags;
    let liveEntryOptions = entryOptionsWithLiveShadow;
    if (smartV3LiveFallback.fallback) {
      const policyFlags = [
        ...entryFlags,
        ...smartV3LiveFallback.flags,
      ];
      if (canRouteSmartV3FallbackToQualityUnknownMicro(smartV3LiveFallback)) {
        const qualityUnknownCanaryCandidateId = buildLiveEquivalenceCandidateId(
          cand.tokenMint,
          entrySignal,
          Date.now(),
          config.kolHunterSmartV3QualityUnknownMicroParameterVersion
        );
        liveEntryFlags = [
          ...policyFlags,
          'SMART_V3_QUALITY_UNKNOWN_MICRO_CANARY',
        ];
        liveEntryOptions = {
          ...entryOptionsWithLiveShadow,
          parameterVersion: config.kolHunterSmartV3QualityUnknownMicroParameterVersion,
          liveEquivalenceCandidateId: qualityUnknownCanaryCandidateId,
          smartV3LiveEligibleShadow: true,
          smartV3LiveBlockReason: null,
          smartV3LiveBlockFlags: [
            'SMART_V3_QUALITY_UNKNOWN_MICRO_CANARY',
            ...smartV3LiveFallback.flags,
          ],
          smartV3LiveEligibilityEvaluatedAtMs: Date.now(),
        };
        log.warn(
          `[KOL_HUNTER_SMART_V3_QUALITY_UNKNOWN_MICRO_CANARY] ${cand.tokenMint.slice(0, 8)} ` +
          `entryReason=${entrySignal.entryReason} flags=${smartV3LiveFallback.flags.join(',')} ` +
          `— restricted quality-unknown live canary.`
        );
      } else if (canRouteSmartV3FallbackToFastCanary(smartV3LiveFallback)) {
        const fastCanaryCandidateId = buildLiveEquivalenceCandidateId(
          cand.tokenMint,
          entrySignal,
          Date.now(),
          config.kolHunterSmartV3FastCanaryParameterVersion
        );
        liveEntryFlags = [
          ...policyFlags,
          'SMART_V3_FAST_CANARY',
        ];
        liveEntryOptions = {
          ...entryOptionsWithLiveShadow,
          parameterVersion: config.kolHunterSmartV3FastCanaryParameterVersion,
          liveEquivalenceCandidateId: fastCanaryCandidateId,
          smartV3LiveEligibleShadow: true,
          smartV3LiveBlockReason: null,
          smartV3LiveBlockFlags: [
            'SMART_V3_FAST_CANARY',
            ...smartV3LiveFallback.flags,
          ],
          smartV3LiveEligibilityEvaluatedAtMs: Date.now(),
        };
        log.warn(
          `[KOL_HUNTER_SMART_V3_FAST_CANARY] ${cand.tokenMint.slice(0, 8)} ` +
          `entryReason=${entrySignal.entryReason} flags=${smartV3LiveFallback.flags.join(',')} ` +
          `— relaxed smart-v3 live canary.`
        );
      } else if (canRouteSmartV3FallbackToFastFailLive(smartV3LiveFallback)) {
        const fastFailLiveCandidateId = buildLiveEquivalenceCandidateId(
          cand.tokenMint,
          entrySignal,
          Date.now(),
          config.kolHunterSmartV3FastFailLiveParameterVersion
        );
        liveEntryFlags = [
          ...policyFlags,
          'SMART_V3_FAST_FAIL_LIVE_CANARY',
        ];
        liveEntryOptions = {
          ...entryOptionsWithLiveShadow,
          parameterVersion: config.kolHunterSmartV3FastFailLiveParameterVersion,
          liveEquivalenceCandidateId: fastFailLiveCandidateId,
          smartV3LiveEligibleShadow: true,
          smartV3LiveBlockReason: null,
          smartV3LiveBlockFlags: [
            'SMART_V3_FAST_FAIL_LIVE_CANARY',
            ...smartV3LiveFallback.flags,
          ],
          smartV3LiveEligibilityEvaluatedAtMs: Date.now(),
        };
        log.warn(
          `[KOL_HUNTER_SMART_V3_FAST_FAIL_LIVE_CANARY] ${cand.tokenMint.slice(0, 8)} ` +
          `entryReason=${entrySignal.entryReason} flags=${smartV3LiveFallback.flags.join(',')} ` +
          `— paper-like smart-v3 fast-fail live canary.`
        );
      } else {
        if (smartV3HardCutReentryLiveOnly) {
          rejectSmartV3HardCutReentryLiveOnlyFallback(
            smartV3LiveFallback.reason ?? 'smart_v3_live_fallback',
            policyFlags
          );
          return;
        }
        log.warn(
          `[KOL_HUNTER_SMART_V3_LIVE_FALLBACK] ${cand.tokenMint.slice(0, 8)} reason=${smartV3LiveFallback.reason} ` +
          `entryReason=${entrySignal.entryReason} freshKols=${smartFresh.freshIndependentKolCount} ` +
          `freshAfterSell=${smartFresh.freshBuyKolsAfterLastSell} sellSol=${smartFresh.preEntrySellSol.toFixed(3)}. ` +
          `fallback paper.`
        );
        emitKolLiveFallbackPolicy(cand.tokenMint, score, policyFlags, {
          ...entryPolicyMetrics,
          entryReason: entryOptions.entryReason,
          armName: entryOptions.parameterVersion ? armNameForVersion(entryOptions.parameterVersion) : undefined,
        });
        emitKolLiveEquivalence({
          candidateId: liveEquivalenceCandidateId,
          tokenMint: cand.tokenMint,
          entrySignal,
          score,
          entryOptions: entryOptionsWithLiveShadow,
          survivalFlags: policyFlags,
          candIsShadow,
          stage: 'smart_v3_live_fallback',
          liveWouldEnter: false,
          liveBlockReason: smartV3LiveFallback.reason ?? 'smart_v3_live_fallback',
          liveBlockFlags: policyFlags,
        });
        await enterPaperPosition(cand.tokenMint, cand, score, policyFlags, {
          ...withLiveEquivalence(
            entryOptionsWithLiveShadow,
            'smart_v3_live_fallback',
            false,
            smartV3LiveFallback.reason ?? 'smart_v3_live_fallback',
            policyFlags,
          ),
          skipPolicyEntry: true,
        });
        return;
      }
    }
    emitKolLiveEquivalence({
      candidateId: liveEntryOptions.liveEquivalenceCandidateId ?? liveEquivalenceCandidateId,
      tokenMint: cand.tokenMint,
      entrySignal,
      score,
      entryOptions: liveEntryOptions,
      survivalFlags: liveEntryFlags,
      candIsShadow,
      stage: 'pre_execution_live_allowed',
      liveWouldEnter: true,
      liveAttempted: true,
      liveBlockReason: null,
      liveBlockFlags: [],
    });
    await enterLivePosition(
      cand.tokenMint,
      cand,
      score,
      liveEntryFlags,
      botCtx,
      withLiveEquivalence(liveEntryOptions, 'pre_execution_live_allowed', true, null, [])
    );
    return;
  }
  const inactiveLiveGate = getLiveCanaryInactiveReason(candIsShadow);
  const shouldLogLiveGateFallback =
    inactiveLiveGate != null &&
    (
      entrySignal.label === 'rotation-chase-topup' ||
      isKolLiveCanaryArmEnabled('rotation_chase_topup_v1') ||
      config.kolHunterLiveCanaryEnabled ||
      !config.kolHunterPaperOnly
    );
  if (shouldLogLiveGateFallback && inactiveLiveGate) {
    const policyFlags = [
      ...entryFlags,
      inactiveLiveGate.flag,
    ];
    log.warn(
      `[KOL_HUNTER_LIVE_GATE_NOT_ENTERED] ${cand.tokenMint.slice(0, 8)} ${entrySignal.label} trigger — ` +
      `reason=${inactiveLiveGate.reason}. fallback paper.`
    );
    emitKolLiveFallbackPolicy(cand.tokenMint, score, policyFlags, {
      ...entryPolicyMetrics,
      entryReason: entryOptions.entryReason,
      armName: entryOptions.parameterVersion ? armNameForVersion(entryOptions.parameterVersion) : undefined,
    });
    emitKolLiveEquivalence({
      candidateId: liveEquivalenceCandidateId,
      tokenMint: cand.tokenMint,
      entrySignal,
      score,
      entryOptions: entryOptionsWithLiveShadow,
      survivalFlags: policyFlags,
      candIsShadow,
      stage: 'live_gate_not_entered',
      liveWouldEnter: false,
      liveBlockReason: inactiveLiveGate.reason,
      liveBlockFlags: policyFlags,
    });
    await enterPaperPosition(cand.tokenMint, cand, score, policyFlags, {
      ...withLiveEquivalence(entryOptionsWithLiveShadow, 'live_gate_not_entered', false, inactiveLiveGate.reason, policyFlags),
      skipPolicyEntry: true,
    });
    return;
  }
  emitKolLiveEquivalence({
    candidateId: liveEquivalenceCandidateId,
    tokenMint: cand.tokenMint,
    entrySignal,
    score,
    entryOptions: entryOptionsWithLiveShadow,
    survivalFlags: entryFlags,
    candIsShadow,
    stage: 'default_paper',
    liveWouldEnter: false,
    liveBlockReason: 'default_paper',
    liveBlockFlags: [],
  });
  await enterPaperPosition(
    cand.tokenMint,
    cand,
    score,
    entryFlags,
    withLiveEquivalence(entryOptionsWithLiveShadow, 'default_paper', false, 'default_paper', []),
  );
}

async function resolveStalk(tokenMint: string): Promise<void> {
  const cand = pending.get(tokenMint);
  if (!cand) return;
  pending.delete(tokenMint);

  const nowMs = Date.now();
  const score = computeKolDiscoveryScoreCached(tokenMint, nowMs);  // P1 #7

  // 2026-04-29 (Track 1): Same-token re-entry cooldown.
  // Why: 같은 mint 에 close 후 30분 안 재진입 차단 (GUfyGEF6 incident 패턴).
  // 시뮬 +13% improvement, 5x winner 보호 (대부분 single-entry).
  const cooldown = isInReentryCooldown(tokenMint);
  if (cooldown.blocked) {
    log.info(
      `[KOL_HUNTER_REENTRY_BLOCK] ${tokenMint.slice(0, 8)} cooldown ${Math.round(cooldown.remainingMs/1000)}s remaining — reject`
    );
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
      survivalReason: 'reentry_cooldown',
      survivalFlags: ['REENTRY_COOLDOWN'],
      cooldownRemainingMs: cooldown.remainingMs,
    });
    return;
  }

  // 2026-04-29 (P0-2): KOL alpha decay cooldown.
  // participating KOL 중 직전 N close 가 손실 streak 인 KOL 발견 시 차단.
  // 8JH1J6p4 incident 의 KOL 다수 dump 직전 패턴 코드화.
  const kolIds = score.participatingKols.map((k) => k.id);
  const kolDecay = checkKolAlphaDecay(kolIds);
  if (kolDecay.blocked) {
    log.info(`[KOL_HUNTER_KOL_DECAY_BLOCK] ${tokenMint.slice(0, 8)} ${kolDecay.reason} — reject`);
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
      survivalReason: 'kol_alpha_decay',
      survivalFlags: ['KOL_ALPHA_DECAY'],
    });
    return;
  }

  // 최소 1명의 독립 KOL 이 있어야 진입 (multi-KOL 합의 선호)
  if (score.independentKolCount === 0) {
    log.info(
      `[KOL_HUNTER_STALK_EXPIRED] ${tokenMint.slice(0, 8)} no_independent_kol — reject`
    );
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score);
    return;
  }

  // MISSION_CONTROL §KOL Control 1단계: security / exit liquidity (price-independent).
  // Paper 결과를 live 와 비교하려면 동일 entry-side gate 를 통과한 분포여야 한다.
  const preEntry = await checkKolSurvivalPreEntry(tokenMint);
  if (!preEntry.approved) {
    log.info(
      `[KOL_HUNTER_SURVIVAL_REJECT] ${tokenMint.slice(0, 8)} reason=${preEntry.reason ?? 'unknown'} ` +
      `flags=${preEntry.flags.join(',')}`
    );
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
      survivalReason: preEntry.reason ?? null,
      survivalFlags: preEntry.flags,
    });
    return;
  }

  // 2026-04-27 (Phase 5 P1-9~14): live canary 실제 구현. triple-flag gate 모두 통과 시 live wallet 사용.
  // 그 외 경우는 paper-only (default 안전).
  // 2026-04-28: shadow KOL 만으로 trigger 된 cand 는 live canary 차단 (실 자산 노출 금지).
  const candIsShadow = cand.kolTxs.length > 0 && cand.kolTxs.every((t) => t.isShadow === true);
  if (isLiveCanaryActive() && botCtx && !candIsShadow) {
    // Hard guards (live wallet protection)
    // 2026-04-30 (P1.5): daily-loss halt 도 KOL lane 에서 존중 (signalProcessor 5분 lane 우회 방지).
    const hardTradingHaltReason = getHardTradingHaltReason(botCtx.tradingHaltedReason);
    if (hardTradingHaltReason) {
      log.warn(`[KOL_HUNTER_TRADING_HALT] ${tokenMint.slice(0, 8)} signal ignored — ${hardTradingHaltReason}. fallback paper.`);
      await enterPaperPosition(tokenMint, cand, score, preEntry.flags, {
        entrySecurityEvidence: preEntry.evidence,
      });
      return;
    }
    if (isDrawdownGuardHaltReason(botCtx.tradingHaltedReason)) {
      log.warn(
        `[KOL_HUNTER_DRAWDOWN_GUARD_SOFT] ${tokenMint.slice(0, 8)} signal — ` +
        `${botCtx.tradingHaltedReason}. continuing live; wallet floor guard remains active.`
      );
    }
    if (isWalletStopActive()) {
      log.warn(`[KOL_HUNTER_WALLET_STOP] ${tokenMint.slice(0, 8)} signal ignored — wallet floor active`);
      fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
        survivalReason: 'wallet_stop_active',
        survivalFlags: ['WALLET_STOP'],
      });
      return;
    }
    if (isEntryHaltActive(LANE_STRATEGY)) {
      log.warn(`[KOL_HUNTER_ENTRY_HALT] ${tokenMint.slice(0, 8)} signal ignored — integrity halt`);
      fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
        survivalReason: 'entry_halt_active',
        survivalFlags: ['ENTRY_HALT'],
      });
      return;
    }
    const qualityCooldown = isInLiveExecutionQualityCooldown(tokenMint);
    if (qualityCooldown.blocked) {
      const policyFlags = [
        ...preEntry.flags,
        'LIVE_EXEC_QUALITY_COOLDOWN',
      ];
      log.warn(
        `[KOL_HUNTER_LIVE_QUALITY_COOLDOWN] ${tokenMint.slice(0, 8)} signal — ` +
        `${qualityCooldown.reason ?? 'execution_quality'} ` +
        `remaining=${Math.round(qualityCooldown.remainingMs / 1000)}s. fallback paper.`
      );
      emitKolLiveFallbackPolicy(tokenMint, score, policyFlags);
      await enterPaperPosition(tokenMint, cand, score, policyFlags, {
        entrySecurityEvidence: preEntry.evidence,
        skipPolicyEntry: true,
      });
      return;
    }
    const liveGate = evaluateKolLiveCanaryGate(score, preEntry.flags);
    if (!liveGate.allowLive) {
      const policyFlags = [...preEntry.flags, ...liveGate.flags];
      log.warn(
        `[KOL_HUNTER_YELLOW_ZONE] ${tokenMint.slice(0, 8)} signal ignored — ` +
        `${liveGate.reason}. fallback paper.`
      );
      emitKolLiveFallbackPolicy(tokenMint, score, policyFlags);
      await enterPaperPosition(tokenMint, cand, score, policyFlags, {
        entrySecurityEvidence: preEntry.evidence,
        skipPolicyEntry: true,
      });
      return;
    }
    await enterLivePosition(tokenMint, cand, score, preEntry.flags, botCtx, {
      entrySecurityEvidence: preEntry.evidence,
    });
    return;
  }
  if (!config.kolHunterPaperOnly && !config.kolHunterLiveCanaryEnabled) {
    log.warn(`[KOL_HUNTER] PAPER_ONLY=false 인데 LIVE_CANARY_ENABLED=false — paper 로만 동작`);
  }
  await enterPaperPosition(tokenMint, cand, score, preEntry.flags, {
    entrySecurityEvidence: preEntry.evidence,
  });
}

function evaluateKolLiveCanaryGate(
  score: KolDiscoveryScore,
  survivalFlags: string[],
  options: {
    independentKolCountOverride?: number;
    liveMinIndependentKol?: number;
    minIndependentKol?: number;
    yellowZoneMinIndependentKol?: number;
  } = {}
): { allowLive: boolean; reason?: string; flags: string[] } {
  const balance = getWalletStopGuardState().lastBalanceSol;
  const balanceKnown = Number.isFinite(balance) && balance !== Number.POSITIVE_INFINITY;
  const liveKolCount = options.independentKolCountOverride ?? score.independentKolCount;
  const liveMinKol = options.liveMinIndependentKol ?? options.minIndependentKol ?? config.kolHunterLiveMinIndependentKol;
  const yellowZoneMinKol = options.yellowZoneMinIndependentKol ?? config.kolHunterYellowZoneMinIndependentKol;

  if (config.kolHunterDevWalletLiveGateEnabled) {
    if (survivalFlags.includes('DEV_WALLET_BLACKLIST')) {
      return {
        allowLive: false,
        reason: 'dev wallet blacklist',
        flags: ['DEV_WALLET_LIVE_BLOCK'],
      };
    }
    if (survivalFlags.includes('DEV_WALLET_WATCHLIST')) {
      return {
        allowLive: false,
        reason: 'dev wallet watchlist',
        flags: ['DEV_WALLET_LIVE_BLOCK'],
      };
    }
  }

  if (
    config.kolHunterYellowZoneEnabled &&
    balanceKnown &&
    balance < config.kolHunterYellowZonePaperFallbackBelowSol
  ) {
    return {
      allowLive: false,
      reason: `wallet ${balance.toFixed(4)} < yellow fallback ${config.kolHunterYellowZonePaperFallbackBelowSol}`,
      flags: ['YELLOW_ZONE_PAPER_FALLBACK'],
    };
  }

  const inYellowZone =
    config.kolHunterYellowZoneEnabled &&
    balanceKnown &&
    balance < config.kolHunterYellowZoneStartSol;
  if (inYellowZone && yellowZoneMinKol > 1 && liveKolCount < yellowZoneMinKol) {
    return {
      allowLive: false,
      reason:
        `wallet ${balance.toFixed(4)} yellow zone requires fresh independentKolCount >= ` +
        `${yellowZoneMinKol}`,
      flags: ['YELLOW_ZONE_MIN_KOL'],
    };
  }

  if (liveMinKol > 1 && liveKolCount < liveMinKol) {
    return {
      allowLive: false,
      reason: `live canary requires fresh independentKolCount >= ${liveMinKol}`,
      flags: ['LIVE_MIN_KOL'],
    };
  }

  if (!config.kolHunterYellowZoneEnabled || !balanceKnown || balance >= config.kolHunterYellowZoneStartSol) {
    return { allowLive: true, flags: [] };
  }

  const hasMissingSecurity = survivalFlags.some((flag) =>
    flag === 'NO_SECURITY_DATA' || flag === 'NO_SECURITY_CLIENT'
  );
  if (hasMissingSecurity) {
    return {
      allowLive: false,
      reason: `wallet ${balance.toFixed(4)} yellow zone rejects missing security data`,
      flags: ['YELLOW_ZONE_SECURITY_DATA'],
    };
  }

  const maxRecent429 = config.kolHunterYellowZoneMaxRecentJupiter429;
  if (maxRecent429 > 0) {
    const recent429 = getJupiter429Stats().reduce((sum, stat) => sum + stat.sinceLastSummary, 0);
    if (recent429 > maxRecent429) {
      return {
        allowLive: false,
        reason: `wallet ${balance.toFixed(4)} yellow zone Jupiter429 ${recent429} > ${maxRecent429}`,
        flags: ['YELLOW_ZONE_JUPITER_429'],
      };
    }
  }

  return { allowLive: true, flags: [] };
}

function devStatusFlag(status: DevStatus): string | null {
  if (status === 'allowlist') return 'DEV_WALLET_ALLOWLIST';
  if (status === 'watchlist') return 'DEV_WALLET_WATCHLIST';
  if (status === 'blacklist') return 'DEV_WALLET_BLACKLIST';
  return null;
}

function resolveDevWalletEntryFlags(tokenSecurityData: unknown): string[] {
  const sec = tokenSecurityData as { creatorAddress?: string; ownerAddress?: string } | null | undefined;
  const flags = new Set<string>();
  for (const address of [sec?.creatorAddress, sec?.ownerAddress]) {
    const flag = devStatusFlag(resolveDevStatus(address));
    if (flag) flags.add(flag);
  }
  return [
    'DEV_WALLET_BLACKLIST',
    'DEV_WALLET_WATCHLIST',
    'DEV_WALLET_ALLOWLIST',
  ].filter((flag) => flags.has(flag));
}

/**
 * MISSION_CONTROL §KOL Control survival 의 1단계 — entry price 가 필요 없는 검사 (security data,
 * exit liquidity). resolveStalk 직후 호출 (PROBE 진입 직전, price subscribe 전).
 *
 * `securityClient` 미주입 시 `kolHunterSurvivalAllowDataMissing` 에 따라 통과/거부.
 */
type KolSurvivalPreEntryResult = {
  approved: boolean;
  reason?: string;
  flags: string[];
  evidence: KolEntrySecurityEvidence;
};

type KolSellQuoteSizedResult = {
  approved: boolean;
  reason?: string;
  flags: string[];
  evidence: KolEntrySellQuoteEvidence;
};

function buildEntrySecurityEvidence(input: {
  securityClientPresent: boolean;
  tokenSecurityData?: TokenSecurityData | null;
  exitLiquidityData?: ExitLiquidityData | null;
  reason?: string | null;
  flags?: string[];
}): KolEntrySecurityEvidence {
  return {
    schemaVersion: 'kol-entry-security/v1',
    checkedAtMs: Date.now(),
    securityClientPresent: input.securityClientPresent,
    tokenSecurityKnown: input.tokenSecurityData != null,
    exitLiquidityKnown: input.exitLiquidityData != null,
    reason: input.reason ?? null,
    flags: [...(input.flags ?? [])],
    tokenSecurityData: input.tokenSecurityData ?? null,
    exitLiquidityData: input.exitLiquidityData ?? null,
  };
}

function buildEntrySellQuoteEvidence(input: {
  schemaVersion?: KolSellQuoteEvidenceSchemaVersion;
  probeEnabled: boolean;
  approved: boolean;
  routeFound?: boolean | null;
  reason?: string | null;
  plannedQuantityUi?: number | null;
  ticketSol?: number | null;
  tokenDecimals?: number | null;
  observedOutSol?: number | null;
  observedImpactPct?: number | null;
  roundTripPct?: number | null;
  quoteFailed?: boolean | null;
  cacheStatus?: string | null;
}): KolEntrySellQuoteEvidence {
  const finiteOrNull = (value?: number | null): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    schemaVersion: input.schemaVersion ?? 'kol-entry-sell-quote/v1',
    checkedAtMs: Date.now(),
    probeEnabled: input.probeEnabled,
    approved: input.approved,
    routeFound: input.routeFound ?? null,
    reason: input.reason ?? null,
    plannedQuantityUi: finiteOrNull(input.plannedQuantityUi),
    ticketSol: finiteOrNull(input.ticketSol),
    tokenDecimals: finiteOrNull(input.tokenDecimals),
    observedOutSol: finiteOrNull(input.observedOutSol),
    observedImpactPct: finiteOrNull(input.observedImpactPct),
    roundTripPct: finiteOrNull(input.roundTripPct),
    quoteFailed: input.quoteFailed ?? null,
    cacheStatus: input.cacheStatus ?? null,
  };
}

async function checkKolSurvivalPreEntry(
  tokenMint: string
): Promise<KolSurvivalPreEntryResult> {
  const flags: string[] = [];

  if (!securityClient) {
    // 2026-04-29 (Track 2B): NO_SECURITY_CLIENT 도 NO_SECURITY_DATA 와 동일 cohort 취급.
    // securityClient 가 미주입이면 결국 data missing 과 효과 같음 — paper n=372 분석에서
    // 두 flag cohort 모두 mfe<1% rate 65.7% / 5x winner 0건.
    if (config.kolHunterRejectOnNoSecurityData) {
      const rejectFlags = ['NO_SECURITY_CLIENT'];
      return {
        approved: false,
        reason: 'no_security_client',
        flags: rejectFlags,
        evidence: buildEntrySecurityEvidence({
          securityClientPresent: false,
          reason: 'no_security_client',
          flags: rejectFlags,
        }),
      };
    }
    if (config.kolHunterSurvivalAllowDataMissing) {
      const allowFlags = ['NO_SECURITY_CLIENT'];
      return {
        approved: true,
        flags: allowFlags,
        evidence: buildEntrySecurityEvidence({
          securityClientPresent: false,
          reason: 'no_security_client',
          flags: allowFlags,
        }),
      };
    }
    const rejectFlags = ['NO_SECURITY_CLIENT'];
    return {
      approved: false,
      reason: 'no_security_client',
      flags: rejectFlags,
      evidence: buildEntrySecurityEvidence({
        securityClientPresent: false,
        reason: 'no_security_client',
        flags: rejectFlags,
      }),
    };
  }

  // gateCache hit (pure_ws 와 공유)
  const cached = gateCache?.get(tokenMint);
  let tokenSecurityData = cached?.tokenSecurityData ?? null;
  let exitLiquidityData = cached?.exitLiquidityData ?? null;

  if (!cached) {
    try {
      const [secData, exitData] = await Promise.all([
        securityClient.getTokenSecurityDetailed(tokenMint),
        securityClient.getExitLiquidity(tokenMint),
      ]);
      tokenSecurityData = secData;
      exitLiquidityData = exitData;
      gateCache?.set(tokenMint, {
        tokenSecurityData: secData,
        exitLiquidityData: exitData,
      });
    } catch (err) {
      log.warn(`[KOL_HUNTER_SURVIVAL] ${tokenMint.slice(0, 12)} security fetch failed: ${err}`);
      // Phase 6 P2-6: stale fallback — RPC pressure 방어.
      const stale = gateCache?.getStaleFallback(tokenMint);
      if (stale) {
        tokenSecurityData = stale.tokenSecurityData;
        exitLiquidityData = stale.exitLiquidityData;
        log.info(
          `[KOL_HUNTER_SURVIVAL_STALE_FALLBACK] ${tokenMint.slice(0, 12)} RPC fail, using stale cache`
        );
      }
    }
  }

  if (!tokenSecurityData) {
    // 2026-04-29 (Track 2B): NO_SECURITY_DATA cohort reject. Track 2A retro 결과 —
    // n=70 / mfe<1% 65.7% (baseline +20.6%) / cum_net -0.0376 SOL / 5x winner 0건.
    // allowDataMissing 보다 우선. RPC stale 후에도 data 없으면 같은 cohort.
    if (config.kolHunterRejectOnNoSecurityData) {
      const rejectFlags = [...flags, 'NO_SECURITY_DATA'];
      return {
        approved: false,
        reason: 'security_data_unavailable',
        flags: rejectFlags,
        evidence: buildEntrySecurityEvidence({
          securityClientPresent: true,
          tokenSecurityData,
          exitLiquidityData,
          reason: 'security_data_unavailable',
          flags: rejectFlags,
        }),
      };
    }
    if (config.kolHunterSurvivalAllowDataMissing) {
      const allowFlags = [...flags, 'NO_SECURITY_DATA'];
      return {
        approved: true,
        flags: allowFlags,
        evidence: buildEntrySecurityEvidence({
          securityClientPresent: true,
          tokenSecurityData,
          exitLiquidityData,
          reason: 'security_data_unavailable',
          flags: allowFlags,
        }),
      };
    }
    const rejectFlags = [...flags, 'NO_SECURITY_DATA'];
    return {
      approved: false,
      reason: 'security_data_unavailable',
      flags: rejectFlags,
      evidence: buildEntrySecurityEvidence({
        securityClientPresent: true,
        tokenSecurityData,
        exitLiquidityData,
        reason: 'security_data_unavailable',
        flags: rejectFlags,
      }),
    };
  }

  const devFlags = resolveDevWalletEntryFlags(tokenSecurityData);

  const gateResult = evaluateSecurityGate(tokenSecurityData, exitLiquidityData, {
    minExitLiquidityUsd: config.kolHunterSurvivalMinExitLiquidityUsd,
    maxTop10HolderPct: config.kolHunterSurvivalMaxTop10HolderPct,
  });

  if (!gateResult.approved) {
    const rejectFlags = [...flags, ...devFlags, ...gateResult.flags];
    return {
      approved: false,
      reason: gateResult.reason,
      flags: rejectFlags,
      evidence: buildEntrySecurityEvidence({
        securityClientPresent: true,
        tokenSecurityData,
        exitLiquidityData,
        reason: gateResult.reason ?? null,
        flags: rejectFlags,
      }),
    };
  }

  const allowFlags = [...flags, ...devFlags, ...gateResult.flags];
  return {
    approved: true,
    flags: allowFlags,
    evidence: buildEntrySecurityEvidence({
      securityClientPresent: true,
      tokenSecurityData,
      exitLiquidityData,
      reason: null,
      flags: allowFlags,
    }),
  };
}

/**
 * MISSION_CONTROL §KOL Control survival 의 2단계 — **size-aware** sell-quote probe.
 * (2026-04-25 review fix: 1 token raw 가 아니라 실 ticket 으로 잡힐 expected quantity 를 검증.)
 *
 * `enterPaperPosition` 가 entry price 를 확정한 직후 호출. probeTokenAmount 는 ticketSol / entryPrice
 * (즉 0.01 SOL 로 살 양). 정확한 decimals 가 없으면 sell-probe raw amount 계산에만 6 fallback 을 쓰고,
 * missed-alpha observer 에는 fallback 값을 넘기지 않는다.
 *
 * Network 실패 / rate-limit 시 false halt 방지 — observability flag 만 남기고 통과.
 */
async function checkKolSellQuoteSized(
  tokenMint: string,
  plannedQuantityUi: number,
  ticketSol: number,
  tokenDecimals?: number,
  schemaVersion: KolSellQuoteEvidenceSchemaVersion = 'kol-entry-sell-quote/v1'
): Promise<KolSellQuoteSizedResult> {
  if (!config.kolHunterRunSellQuoteProbe) {
    return {
      approved: true,
      flags: ['SELL_PROBE_DISABLED'],
      evidence: buildEntrySellQuoteEvidence({
        schemaVersion,
        probeEnabled: false,
        approved: true,
        plannedQuantityUi,
        ticketSol,
        tokenDecimals: tokenDecimals ?? null,
      }),
    };
  }
  if (!Number.isFinite(plannedQuantityUi) || plannedQuantityUi <= 0) {
    return {
      approved: true,
      flags: ['SELL_PROBE_INVALID_QTY'],
      evidence: buildEntrySellQuoteEvidence({
        schemaVersion,
        probeEnabled: true,
        approved: true,
        reason: 'invalid_quantity',
        plannedQuantityUi,
        ticketSol,
        tokenDecimals: tokenDecimals ?? null,
      }),
    };
  }
  const decimalsResolved = tokenDecimals ?? 6;
  // Why: probeTokenAmountRaw = floor(plannedQuantityUi × 10^decimals). plannedQuantityUi 가
  // 큰 (1e9+) 메모코인이라도 BigInt 변환은 안전 — Math.floor 후 stringify.
  const rawAmount = BigInt(Math.max(1, Math.floor(plannedQuantityUi * 10 ** decimalsResolved)));
  try {
    const sellResult = await evaluateSellQuoteProbe({
      tokenMint,
      probeTokenAmountRaw: rawAmount,
      expectedSolReceive: ticketSol, // round-trip 비교 — ticket 대비 회수율 측정
      tokenDecimals: decimalsResolved,
    });
    const baseFlags = [`SELL_DECIMALS_${tokenDecimals == null ? 'FALLBACK6' : decimalsResolved}`];
    if (!sellResult.routeFound) {
      return {
        approved: false,
        reason: sellResult.reason ?? 'no_sell_route',
        flags: [...baseFlags, 'NO_SELL_ROUTE'],
        evidence: buildEntrySellQuoteEvidence({
          schemaVersion,
          probeEnabled: true,
          approved: false,
          routeFound: false,
          reason: sellResult.reason ?? 'no_sell_route',
          plannedQuantityUi,
          ticketSol,
          tokenDecimals: decimalsResolved,
          observedOutSol: sellResult.observedOutSol,
          observedImpactPct: sellResult.observedImpactPct,
          roundTripPct: sellResult.roundTripPct,
          quoteFailed: sellResult.quoteFailed,
          cacheStatus: sellResult.cacheStatus ?? null,
        }),
      };
    }
    if (!sellResult.approved) {
      return {
        approved: false,
        reason: sellResult.reason ?? 'sell_quote_rejected',
        flags: [...baseFlags, `SELL_REJECT_${(sellResult.reason ?? 'unknown').toUpperCase()}`],
        evidence: buildEntrySellQuoteEvidence({
          schemaVersion,
          probeEnabled: true,
          approved: false,
          routeFound: true,
          reason: sellResult.reason ?? 'sell_quote_rejected',
          plannedQuantityUi,
          ticketSol,
          tokenDecimals: decimalsResolved,
          observedOutSol: sellResult.observedOutSol,
          observedImpactPct: sellResult.observedImpactPct,
          roundTripPct: sellResult.roundTripPct,
          quoteFailed: sellResult.quoteFailed,
          cacheStatus: sellResult.cacheStatus ?? null,
        }),
      };
    }
    return {
      approved: true,
      flags: [...baseFlags, 'SELL_ROUTE_OK', 'EXIT_LIQUIDITY_KNOWN'],
      evidence: buildEntrySellQuoteEvidence({
        schemaVersion,
        probeEnabled: true,
        approved: true,
        routeFound: true,
        plannedQuantityUi,
        ticketSol,
        tokenDecimals: decimalsResolved,
        observedOutSol: sellResult.observedOutSol,
        observedImpactPct: sellResult.observedImpactPct,
        roundTripPct: sellResult.roundTripPct,
        quoteFailed: sellResult.quoteFailed,
        cacheStatus: sellResult.cacheStatus ?? null,
      }),
    };
  } catch (err) {
    log.debug(`[KOL_HUNTER_SURVIVAL] sellQuoteProbe error ${tokenMint.slice(0, 12)}: ${err}`);
    // false halt 방지 — observability flag 만 남기고 진입 허용
    return {
      approved: true,
      flags: ['SELL_QUOTE_ERROR'],
      evidence: buildEntrySellQuoteEvidence({
        schemaVersion,
        probeEnabled: true,
        approved: true,
        routeFound: null,
        reason: 'sell_quote_error',
        plannedQuantityUi,
        ticketSol,
        tokenDecimals: decimalsResolved,
        quoteFailed: true,
      }),
    };
  }
}

async function resolveTokenDecimalsForObserver(
  tokenMint: string,
  quoteDecimals: number | null
): Promise<{ value?: number; source?: 'security_client' | 'jupiter_quote' }> {
  if (securityClient) {
    try {
      const decimals = await securityClient.getMintDecimals(tokenMint);
      if (
        typeof decimals === 'number' &&
        Number.isFinite(decimals) &&
        decimals >= 0 &&
        decimals <= 18
      ) {
        return { value: decimals, source: 'security_client' };
      }
    } catch (err) {
      log.debug(`[KOL_HUNTER_SURVIVAL] decimals fetch error ${tokenMint.slice(0, 12)}: ${err}`);
    }
  }

  if (
    typeof quoteDecimals === 'number' &&
    Number.isFinite(quoteDecimals) &&
    quoteDecimals >= 0 &&
    quoteDecimals <= 18
  ) {
    return { value: quoteDecimals, source: 'jupiter_quote' };
  }

  return {};
}

// ─── Paper Entry ─────────────────────────────────────────

async function enterPaperPosition(
  tokenMint: string,
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  survivalFlags: string[] = [],
  options: PaperEntryOptions = {}
): Promise<void> {
  const canaryLane = kolHunterCanaryLaneForOptions(options);
  if (!priceFeed) {
    log.warn(`[KOL_HUNTER] priceFeed not initialized — cannot enter`);
    return;
  }

  // 1. Entry price 측정 — priceFeed subscribe 후 최초 tick 까지 대기 (또는 1회 poll)
  // 2026-04-26 P1 fix: price tick 의 known decimals 와 security decimals 를 분리해서 stash.
  // fallback 6 은 observer 로 넘기지 않아 잘못된 post-close delta 를 막는다.
  priceFeed.subscribe(tokenMint);
  // PaperPriceFeed 는 subscribe 시 즉시 1회 poll 한다. 캐시 hit 은 즉시 반환.
  // Periodic poll 은 기본 8s 로 유지해 paper feed 가 Jupiter budget 을 점유하지 않게 한다.
  const firstTick = await waitForFirstTick(tokenMint, 5_000);
  if (firstTick === null) {
    unsubscribePriceIfIdle(tokenMint);
    log.warn(`[KOL_HUNTER] entry price fetch timeout ${tokenMint.slice(0, 8)}`);
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score);
    return;
  }
  const entryPrice = firstTick.price;
  const entryTokenDecimals = typeof options.tokenDecimals === 'number'
    ? { value: options.tokenDecimals, source: options.tokenDecimalsSource }
    : await resolveTokenDecimalsForObserver(tokenMint, firstTick.outputDecimals);

  const ticketSol = config.kolHunterTicketSol;
  const entryAtMs = Date.now();
  const nowSec = Math.floor(entryAtMs / 1000);
  const positionIdBase = `kolh-${tokenMint.slice(0, 8)}-${nowSec}`;
  const positionId = options.positionIdSuffix
    ? `${positionIdBase}-${options.positionIdSuffix}`
    : positionIdBase;
  const quantity = entryPrice > 0 ? ticketSol / entryPrice : 0;
  const primaryVersion = options.parameterVersion ?? config.kolHunterParameterVersion;
  const entryParticipatingKols = options.entryParticipatingKols ?? score.participatingKols;
  const entryKolScore = options.entryKolScore ?? score.finalScore;
  const entryIndependentKolCount = options.entryIndependentKolCount ?? score.independentKolCount;

  // MISSION_CONTROL §KOL Control 2단계 — size-aware sell-quote probe.
  // 0.01 SOL 로 살 plannedQuantity 그대로를 매도 quote 로 검증 (1 token 가짜 probe 가 아님).
  // 거부되면 PROBE 진입 자체를 막아 paper 결과의 sell-side viability 분포를 정확히 측정.
  const sellSized = await checkKolSellQuoteSized(tokenMint, quantity, ticketSol, entryTokenDecimals.value);
  if (!sellSized.approved) {
    unsubscribePriceIfIdle(tokenMint);
    log.info(
      `[KOL_HUNTER_SELL_REJECT] ${tokenMint.slice(0, 8)} qty=${quantity.toFixed(2)} ticket=${ticketSol}SOL ` +
      `reason=${sellSized.reason ?? 'unknown'} flags=${sellSized.flags.join(',')}`
    );
    const rejectFlags = [...survivalFlags, ...sellSized.flags];
    if (options.entryReason === 'capitulation_rebound' || isCapitulationParameterVersion(primaryVersion)) {
      trackCapitulationEntryRejectMarkout(
        cand,
        score,
        'sell_quote_failed',
        entryPrice,
        rejectFlags,
        {
          ...options,
          tokenDecimals: entryTokenDecimals.value,
          tokenDecimalsSource: entryTokenDecimals.source,
        },
        {
          survivalReason: sellSized.reason ?? null,
          plannedQuantity: quantity,
          ticketSol,
          entryPrice,
          sellQuoteFlags: sellSized.flags,
        }
      );
      return;
    }
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
      survivalReason: sellSized.reason ?? null,
      survivalFlags: rejectFlags,
      plannedQuantity: quantity,
      ticketSol,
      entryPrice,
    });
    return;
  }
  const combinedSurvivalFlags = [
    ...survivalFlags,
    ...sellSized.flags,
    `DECIMALS_${entryTokenDecimals.source?.toUpperCase() ?? 'UNKNOWN'}`,
  ];
  // 2026-04-26: smart-v3 main path 에서도 swing-v2 paper shadow 측정 허용.
  // 이전: `primaryVersion === v1.0.0` 일 때만 shadow 생성 → smart-v3 default ON 이면 swing-v2 영구 비활성.
  // 수정: primary 가 swing-v2 자기자신이 아니면 (재귀 방지) shadow 생성. smart-v3/v1 양쪽 path 에서 동작.
  // 이유: swing 손익비 정책 자체의 paradigm-agnostic 검증 + KOL_HUNTER_SMART_V3_ENABLED 와 SWING_V2_ENABLED 동시 ON 가능.
  const swingEligible =
    primaryVersion !== config.kolHunterSwingV2ParameterVersion && isSwingV2Eligible(score);

  // 2026-04-28: inactive KOL paper trade flag.
  // cand.kolTxs 의 모든 tx 가 isShadow=true 일 때만 position 을 shadow 로 마킹.
  // active 가 1명이라도 끼면 active 우선 (downgrade 안 함) — 분포 정합 + 보수적 정책.
  // active KOL 이 없는 cand 는 enterPaperPosition 에 도달하기 전에 multi-KOL hurdle 에서 거의
  // reject 되므로 실제 shadow position 은 inactive 만으로 hurdle 충족하는 케이스만.
  const isShadowKolPosition =
    cand.kolTxs.length > 0 && cand.kolTxs.every((t) => t.isShadow === true);

  const makePosition = (
    id: string,
    parameterVersion: string,
    isShadowArm: boolean,
    parentPositionId?: string
  ): PaperPosition => {
    const entryReason = parameterVersion === primaryVersion
      ? options.entryReason ?? defaultEntryReasonForVersion(parameterVersion)
      : defaultEntryReasonForVersion(parameterVersion);
    const convictionLevel = parameterVersion === primaryVersion
      ? options.convictionLevel ?? defaultConvictionForVersion(parameterVersion)
      : defaultConvictionForVersion(parameterVersion);
    const dynamicExit = dynamicExitParamsForPosition(parameterVersion, entryReason);
    const pos: PaperPosition = {
      positionId: id,
      tokenMint,
      state: 'PROBE',
      entryPrice,
      entryTimeSec: nowSec,
      entryOpenedAtMs: entryAtMs,
      ticketSol,
      quantity,
      marketReferencePrice: entryPrice,
      peakPrice: entryPrice,
      troughPrice: entryPrice,
      lastPrice: entryPrice,
      participatingKols: entryParticipatingKols.map((k) => ({ ...k })),
      kolScore: entryKolScore,
      armName: armNameForVersion(parameterVersion),
      parameterVersion,
      profileArm: options.profileArm,
      entryArm: options.entryArm,
      exitArm: options.exitArm,
      canaryLane,
      isShadowArm,
      parentPositionId,
      kolEntryReason: entryReason,
      kolConvictionLevel: convictionLevel,
      t1MfeOverride: dynamicExit.t1Mfe,
      t1TrailPctOverride: dynamicExit.t1TrailPct,
      t1ProfitFloorMult: dynamicExit.t1ProfitFloorMult,
      probeFlatTimeoutSec: dynamicExit.probeFlatTimeoutSec,
      probeHardCutPctOverride: dynamicExit.probeHardCutPct,
      rotationDoaWindowSecOverride: dynamicExit.rotationDoaWindowSec,
      rotationDoaMinMfePctOverride: dynamicExit.rotationDoaMinMfePct,
      rotationDoaMaxMaePctOverride: dynamicExit.rotationDoaMaxMaePct,
      rotationAnchorKols: options.rotationAnchorKols,
      rotationEntryAtMs: options.rotationAnchorKols ? entryAtMs : undefined,
      rotationAnchorPrice: options.rotationAnchorPrice,
      rotationAnchorPriceSource: options.rotationAnchorPriceSource,
      rotationFirstBuyAtMs: options.rotationFirstBuyAtMs,
      rotationLastBuyAtMs: options.rotationLastBuyAtMs,
      rotationLastBuyAgeMs: options.rotationLastBuyAgeMs,
      rotationScore: options.rotationScore,
      underfillReferenceSolAmount: options.underfillReferenceSolAmount,
      underfillReferenceTokenAmount: options.underfillReferenceTokenAmount,
      rotationFlowExitEnabled: options.rotationFlowExitEnabled === true ||
        parameterVersion === config.kolHunterRotationExitFlowParameterVersion ||
        parameterVersion === config.kolHunterRotationChaseTopupParameterVersion,
      executionGuardReason: options.executionGuardReason ?? null,
      executionGuardAction: options.executionGuardAction ?? null,
      capitulationTelemetry: options.capitulationTelemetry,
      capitulationEntryLowPrice: options.capitulationEntryLowPrice,
      capitulationEntryLowAtMs: options.capitulationEntryLowAtMs,
      capitulationRecoveryConfirmations: options.capitulationRecoveryConfirmations,
      smartV3LiveHardCutReentry: options.smartV3LiveHardCutReentry,
      smartV3LiveEligibleShadow: options.smartV3LiveEligibleShadow,
      smartV3LiveBlockReason: options.smartV3LiveBlockReason,
      smartV3LiveBlockFlags: options.smartV3LiveBlockFlags,
      smartV3LiveEligibilityEvaluatedAtMs: options.smartV3LiveEligibilityEvaluatedAtMs,
      liveEquivalenceCandidateId: options.liveEquivalenceCandidateId,
      liveEquivalenceDecisionStage: options.liveEquivalenceDecisionStage,
      liveEquivalenceLiveWouldEnter: options.liveEquivalenceLiveWouldEnter,
      liveEquivalenceLiveBlockReason: options.liveEquivalenceLiveBlockReason,
      liveEquivalenceLiveBlockFlags: options.liveEquivalenceLiveBlockFlags,
      smartV3EntryComboKey: options.smartV3EntryComboKey,
      smartV3HardCutParentPositionId: options.smartV3HardCutParentPositionId,
      smartV3HardCutAtMs: options.smartV3HardCutAtMs,
      smartV3HardCutEntryPrice: options.smartV3HardCutEntryPrice,
      smartV3HardCutExitPrice: options.smartV3HardCutExitPrice,
      smartV3HardCutDiscountPct: options.smartV3HardCutDiscountPct,
      kolReinforcementCount: 0,
      detectorVersion: config.kolHunterDetectorVersion,
      independentKolCount: entryIndependentKolCount,
      survivalFlags: combinedSurvivalFlags,
      isShadowKol: isShadowKolPosition,  // 2026-04-28: 분포 분리 marker.
      tokenDecimals: entryTokenDecimals.value,
      tokenDecimalsSource: entryTokenDecimals.source,
      entrySecurityEvidence: options.entrySecurityEvidence,
      entrySellQuoteEvidence: sellSized.evidence,
    };
    if (isRotationFamilyMarkoutPosition(pos)) {
      pos.rotationMonetizableEdge = buildRotationMonetizableEdgeForPosition(pos);
      const edge = pos.rotationMonetizableEdge;
      if (edge) {
        pos.survivalFlags = [
          ...pos.survivalFlags,
          edge.pass ? 'ROTATION_EDGE_SHADOW_PASS' : 'ROTATION_EDGE_SHADOW_FAIL',
          `ROTATION_EDGE_COST_RATIO_${edge.costRatio.toFixed(3)}`,
          `ROTATION_EDGE_VENUE_${edge.venue.toUpperCase()}`,
        ];
      }
    }
    return pos;
  };

  const positions = [
    makePosition(positionId, primaryVersion, false),
  ];
  if (swingEligible) {
    positions.push(
      makePosition(`${positionId}-swing-v2`, config.kolHunterSwingV2ParameterVersion, true, positionId)
    );
    log.info(
      `[KOL_HUNTER_SWING_V2] ${positionId} ${tokenMint.slice(0, 8)} ` +
      `kols=${score.independentKolCount} score=${score.finalScore.toFixed(2)} ` +
      `stalk=${config.kolHunterSwingV2StalkWindowSec}s trail=${(config.kolHunterSwingV2T1TrailPct * 100).toFixed(0)}% ` +
      `profitFloor=${config.kolHunterSwingV2T1ProfitFloorMult}x`
    );
  }
  if (primaryVersion === config.kolHunterSmartV3ParameterVersion) {
    const newPoolContext = resolveSmartV3NewPoolContext(tokenMint);
    const smartArmSpecs = buildSmartV3PaperArmSpecs(
      options.entryReason ?? defaultEntryReasonForVersion(primaryVersion),
      newPoolContext
    );
    for (const spec of smartArmSpecs) {
      if (!spec.enabled) continue;
      const arm = makePosition(`${positionId}-${spec.suffix}`, primaryVersion, true, positionId);
      applySmartV3PaperArmSpec(arm, spec);
      positions.push(arm);
    }
    if (smartArmSpecs.some((spec) => spec.enabled)) {
      log.info(
        `[KOL_HUNTER_SMART_V3_PAPER_ARMS] ${positionId} ${tokenMint.slice(0, 8)} ` +
        `arms=${positions.filter((p) => p.isShadowArm && p.armName.startsWith('smart_v3_')).map((p) => p.armName).join(',') || 'none'}`
      );
    }
  }
  if (
    primaryVersion === config.kolHunterRotationV1ParameterVersion ||
    primaryVersion === config.kolHunterRotationUnderfillParameterVersion
  ) {
    for (const spec of buildRotationPaperArmSpecs(primaryVersion)) {
      const rejectReason = rotationPaperArmRejectReason(
        spec,
        entryPrice,
        options.rotationAnchorPrice,
        combinedSurvivalFlags
      );
      if (rejectReason) {
        log.debug(
          `[KOL_HUNTER_ROTATION_PAPER_ARM_SKIP] ${tokenMint.slice(0, 8)} ` +
          `arm=${spec.armName} reason=${rejectReason}`
        );
        if (rejectReason !== 'disabled') {
          trackRotationPaperArmSkipMarkout(
            cand,
            score,
            spec,
            rejectReason,
            entryPrice,
            options,
            combinedSurvivalFlags,
            entryTokenDecimals
          );
        }
        continue;
      }
      const arm = makePosition(
        `${positionId}-${spec.suffix}`,
        primaryVersion,
        true,
        positionId
      );
      applyRotationPaperArmSpec(arm, spec);
      positions.push(arm);
    }
    if (positions.length > 1) {
      log.info(
        `[KOL_HUNTER_ROTATION_PAPER_ARMS] ${positionId} ${tokenMint.slice(0, 8)} ` +
        `arms=${positions.filter((p) => p.isShadowArm).map((p) => p.armName).join(',') || 'none'}`
      );
    }
  }

  for (const pos of positions) {
    if (isRotationV1Position(pos)) {
      updateRotationFlowMetrics(pos, Date.now());
    }
    setActivePosition(pos);  // P1 #5: index 동기화 (Map + activeByMint Set)
    if (!options.skipPolicyEntry) {
      emitKolPositionPolicy(pos, 'entry', 'enter', { routeFound: true });
    }
    log.info(
      `[KOL_HUNTER_PAPER_ENTER] ${pos.positionId} ${tokenMint.slice(0, 8)} ` +
      `arm=${pos.armName}${pos.isShadowArm ? ' shadow' : ''} ` +
      `entry=${entryPrice.toFixed(8)} ticket=${ticketSol}SOL kols=${score.independentKolCount} ` +
      `score=${score.finalScore.toFixed(2)}`
    );
    // 2026-05-01 (Decu Quality Layer Phase B.6): observe-only token quality record.
    //   fire-and-forget — entry critical path 영향 0. shadow arm 도 fire (cohort 분석 입력).
    if (config.tokenQualityObserverEnabled && !pos.isTailPosition) {
      void recordTokenQualityObservation(pos).catch(() => {});
    }
    trackPaperPositionMarkout(
      pos,
      'buy',
      pos.entryPriceTokenOnly ?? pos.entryPrice,
      pos.swapInputSol ?? pos.ticketSol,
      pos.entryTimeSec * 1000,
      {
        eventType: 'paper_entry',
        survivalFlags: pos.survivalFlags,
        profileArm: pos.profileArm ?? null,
        entryArm: pos.entryArm ?? pos.armName,
        exitArm: pos.exitArm ?? pos.armName,
        smartV3LiveEligibleShadow: pos.smartV3LiveEligibleShadow ?? null,
        smartV3LiveBlockReason: pos.smartV3LiveBlockReason ?? null,
        smartV3LiveBlockFlags: pos.smartV3LiveBlockFlags ?? null,
      }
    );
  }

  // 2. price listener 등록 — token 별 fan-out 으로 v1/v2 shadow arm 을 동시에 평가
  ensurePriceListener(tokenMint);

  for (const pos of positions) kolHunterEvents.emit('paper_entry', pos);
}

const KOL_ENTRY_TICK_MAX_AGE_MS = 10_000;                    // PaperPriceFeed 8s poll 기준 stale cache 1회만 허용

/**
 * 2026-04-26 P1 fix: 첫 tick 전체 (price + outputDecimals) 반환.
 * 기존 waitForFirstPrice 는 price 만 반환 → decimals 유실 → missed_alpha decimals_unknown.
 * 본 helper 가 PaperPosition 의 tokenDecimals stash 핵심.
 */
async function waitForFirstTick(
  tokenMint: string,
  timeoutMs: number
): Promise<{ price: number; outputDecimals: number | null; timestamp: number } | null> {
  if (!priceFeed) return null;
  const cached = priceFeed.getLastTick?.(tokenMint);
  if (cached && Date.now() - cached.timestamp <= KOL_ENTRY_TICK_MAX_AGE_MS) {
    return { price: cached.price, outputDecimals: cached.outputDecimals, timestamp: cached.timestamp };
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      priceFeed?.off('price', handler);
      resolve(null);
    }, timeoutMs);
    const handler = (tick: PriceTick) => {
      if (tick.tokenMint !== tokenMint) return;
      clearTimeout(timeout);
      priceFeed?.off('price', handler);
      resolve({ price: tick.price, outputDecimals: tick.outputDecimals, timestamp: tick.timestamp });
    };
    priceFeed?.on('price', handler);
  });
}

interface LiveFreshReferenceCheck {
  tick: { price: number; outputDecimals: number | null; timestamp: number };
  initialToFreshReferencePct?: number;
  rejected: boolean;
  reason?: string;
}

async function refreshLiveEntryReference(
  tokenMint: string,
  initialTick: { price: number; outputDecimals: number | null; timestamp: number }
): Promise<LiveFreshReferenceCheck> {
  if (!config.kolHunterLiveFreshReferenceGuardEnabled) {
    return { tick: initialTick, rejected: false };
  }
  const freshTick = await priceFeed?.refreshNow(tokenMint);
  if (!freshTick || freshTick.price <= 0 || !Number.isFinite(freshTick.price)) {
    return {
      tick: initialTick,
      rejected: true,
      reason: 'live_fresh_reference_unavailable',
    };
  }
  const freshAgeMs = Math.max(0, Date.now() - freshTick.timestamp);
  if (
    config.kolHunterLiveFreshReferenceMaxAgeMs > 0 &&
    freshAgeMs >= config.kolHunterLiveFreshReferenceMaxAgeMs
  ) {
    return {
      tick: freshTick,
      rejected: true,
      reason: `live_fresh_reference_stale_ms=${freshAgeMs}`,
    };
  }
  const initialToFreshReferencePct = initialTick.price > 0
    ? freshTick.price / initialTick.price - 1
    : undefined;
  const maxAdverseDrift = config.kolHunterLiveFreshReferenceMaxAdverseDriftPct;
  if (
    maxAdverseDrift > 0 &&
    typeof initialToFreshReferencePct === 'number' &&
    initialToFreshReferencePct >= maxAdverseDrift
  ) {
    return {
      tick: freshTick,
      initialToFreshReferencePct,
      rejected: true,
      reason: `live_fresh_reference_drift_pct=${initialToFreshReferencePct.toFixed(6)}`,
    };
  }
  return { tick: freshTick, initialToFreshReferencePct, rejected: false };
}

function ensurePriceListener(tokenMint: string): void {
  if (!priceFeed || priceListeners.has(tokenMint)) return;
  const listener = (tick: PriceTick) => {
    if (tick.tokenMint !== tokenMint) return;
    const positions = getActivePositionsByMint(tokenMint);
    for (const pos of positions) onPriceTick(pos.positionId, tick);
  };
  priceListeners.set(tokenMint, listener);
  priceFeed.on('price', listener);
}

// ─── Paper-only 휴리스틱 named constants ─────────────────
// 2026-04-26: hardcode magic number 를 named constant 로 추출 (의도 명시 + 향후 config 화 후보).
// Paper-only 휴리스틱 — Phase 4+ live 에서는 실 candle / buy ratio / tx density 기반으로 대체 예정.
const KOL_PAPER_PROBE_FLAT_BAND_PCT = 0.10;                  // stalk 만료 시 ±10% 범위 내면 timeout reject
const KOL_PAPER_PROBE_TRAIL_PCT = 0.15;                      // PROBE 의 peak-pullback trail (15%)
// 2026-04-30 (P1-1): MFE_LOW_THRESHOLD/ELAPSED_SEC/PULLBACK_THRESHOLD 가 config 로 승격 (config.kolHunter*).
// 본 constant 는 (b) price drop 만 유지 — 현 price 대비 -5% 이하 시 factor +1.
const KOL_PAPER_QUICK_REJECT_PRICE_DROP_THRESHOLD = -0.05;
// 2026-04-28: 0.30 → config 화 (default 0.45). config.kolHunterHoldPhasePeakDriftThreshold 참조.
// 사유: Sprint 1A paper 분석 (n=401) — mfe 200%+ winner 4건 sentinel cut 발견. 임계 완화로 large
// winner retreat capture. config/kolHunter.ts 의 정책 주석 참조.

// ─── Structural Kill-Switch (Sprint 2.A1, 2026-04-30) ─────
// Why: hardcut/QR 의 가격 신호로는 sellability 변화 미감지. live D-bucket (mae<-30%, n=6) 의
//      root cause = sell tx confirm 지연 (CeAnreXv 84s 동안 -10% → -34%). "팔 수 있는가" 평가
//      를 stop 보다 우선. 학술 §exit two-layer 권고 정합.
//
// Trigger 조건 (모두 AND):
//   1. live position (paper 는 quote 호출 부담)
//   2. config.kolHunterStructuralKillEnabled === true
//   3. hold time >= kolHunterStructuralKillMinHoldSec (default 60s — 진입 직후 noise 차단)
//   4. peakDrift >= kolHunterStructuralKillPeakDriftTrigger (default 0.20 — 가격 약화 전조)
//   5. cache miss + last evaluation > cacheMs ago
//
// 발화 시: sell quote 실시간 호출 → impact >= maxImpactPct (default 0.10) 또는 no_route → close.
const structuralKillCache = new Map<string, { evaluatedAt: number; lastTrigger: 'safe' | 'kill' }>();

/** 동기 cache lookup. quote 호출은 호출자가 별도 schedule. */
function shouldRunStructuralKillProbe(pos: PaperPosition, currentPrice: number, nowMs: number): boolean {
  if (!config.kolHunterStructuralKillEnabled) return false;
  if (pos.isLive !== true) return false;  // paper 는 quote 부담 회피
  const elapsedSec = nowMs / 1000 - pos.entryTimeSec;
  if (elapsedSec < config.kolHunterStructuralKillMinHoldSec) return false;
  const peakDrift = pos.peakPrice > 0 ? (pos.peakPrice - currentPrice) / pos.peakPrice : 0;
  if (peakDrift < config.kolHunterStructuralKillPeakDriftTrigger) return false;
  const cached = structuralKillCache.get(pos.positionId);
  if (cached && nowMs - cached.evaluatedAt < config.kolHunterStructuralKillCacheMs) return false;
  return true;
}

/** Test 용 — cache 격리. */
/**
 * 2026-05-01 (P2-1 회귀): tail spawn 분기 직접 호출 — live entry path 우회.
 * live parent + price kill 흐름이 mock executor 로 검증 어려워, helper 직접 호출로 검증.
 */
export function __testSpawnTailSubPosition(parent: PaperPosition, exitPrice: number, nowSec: number): void {
  spawnTailSubPosition(parent, exitPrice, nowSec);
}

export function __testIsPriceKillReason(reason: CloseReason): boolean {
  return isPriceKillReason(reason);
}

export function __testResetStructuralKillCache(): void {
  structuralKillCache.clear();
}

function hasFreshRotationAnchorBuy(pos: PaperPosition, nowMs: number): boolean {
  const anchorKols = new Set((pos.rotationAnchorKols ?? []).map((id) => id.toLowerCase()));
  if (anchorKols.size === 0) return false;
  const sinceMs = nowMs - config.kolHunterRotationV1FreshBuyGraceSec * 1000;
  const entryMs = pos.rotationEntryAtMs ?? pos.entryTimeSec * 1000;
  return recentKolTxs.some((tx) =>
    tx.tokenMint === pos.tokenMint &&
    tx.action === 'buy' &&
    tx.timestamp >= entryMs &&
    tx.timestamp >= sinceMs &&
    anchorKols.has(tx.kolId.toLowerCase())
  );
}

function rotationFlowMetricsConfig() {
  return {
    sellPressureWindowSec: config.kolHunterRotationFlowSellPressureWindowSec,
    freshTopupSec: config.kolHunterRotationFlowFreshTopupSec,
    chaseStepPct: config.kolHunterRotationFlowChaseStepPct,
  };
}

function rotationMonetizableEdgeConfig() {
  return {
    enabled: config.kolHunterRotationEdgeShadowEnabled,
    maxCostRatio: config.kolHunterRotationEdgeMaxCostRatio,
    assumedAtaRentSol: config.kolHunterRotationEdgeAssumedAtaRentSol,
    priorityFeeSol: config.kolHunterRotationEdgePriorityFeeSol,
    tipSol: config.kolHunterRotationEdgeTipSol,
    entrySlippageBps: config.kolHunterRotationEdgeEntrySlippageBps,
    quickExitSlippageBps: config.kolHunterRotationEdgeQuickExitSlippageBps,
  };
}

function inferRotationVenue(tokenMint: string, anchorKols?: string[]): string | undefined {
  const anchors = new Set((anchorKols ?? []).map((id) => id.toLowerCase()));
  const rows = rotationV1RecentTxsByMint.get(tokenMint) ?? [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (anchors.size > 0 && !anchors.has(row.kolId.toLowerCase())) continue;
    if (typeof row.dexId === 'string' && row.dexId.length > 0) return row.dexId;
  }
  return undefined;
}

function buildRotationMonetizableEdgeForPosition(pos: Pick<PaperPosition, 'tokenMint' | 'ticketSol' | 'rotationAnchorKols'>): RotationMonetizableEdgeEstimate | null {
  return buildRotationMonetizableEdgeEstimate({
    ticketSol: pos.ticketSol,
    venue: inferRotationVenue(pos.tokenMint, pos.rotationAnchorKols),
    config: rotationMonetizableEdgeConfig(),
  });
}

function buildSmartV3CopyableEdgeForClose(input: {
  pos: PaperPosition;
  walletNetSol: number;
  tokenOnlyNetSol: number;
}): SmartV3CopyableEdgeEstimate | null {
  const { pos, walletNetSol, tokenOnlyNetSol } = input;
  if (!isSmartV3Position(pos)) return null;
  const ticketSol = pos.ticketSol;
  const mode = pos.isLive === true ? 'live' : 'paper';
  const assumedAtaRentSol = Math.max(0, pos.ataRentSol ?? config.kolHunterRotationPaperAssumedAtaRentSol);
  const assumedNetworkFeeSol = Math.max(0, config.kolHunterRotationPaperAssumedNetworkFeeSol);
  if (!Number.isFinite(ticketSol) || ticketSol <= 0) {
    return {
      schemaVersion: 'smart-v3-copyable-edge/v1',
      shadowOnly: true,
      pass: false,
      reason: 'invalid_ticket',
      mode,
      ticketSol,
      walletNetSol,
      tokenOnlyNetSol,
      copyableNetSol: walletNetSol,
      copyableNetPct: null,
      actualWalletDragSol: null,
      estimatedDragSol: Infinity,
      assumedAtaRentSol,
      assumedNetworkFeeSol,
      requiredGrossMovePct: null,
    };
  }
  const actualWalletDragSol = mode === 'live'
    ? Math.max(0, tokenOnlyNetSol - walletNetSol)
    : null;
  const estimatedDragSol = actualWalletDragSol ?? (assumedAtaRentSol + assumedNetworkFeeSol);
  const copyableNetSol = mode === 'live'
    ? walletNetSol
    : tokenOnlyNetSol - estimatedDragSol;
  const copyableNetPct = copyableNetSol / ticketSol;
  return {
    schemaVersion: 'smart-v3-copyable-edge/v1',
    shadowOnly: true,
    pass: copyableNetSol > 0,
    reason: copyableNetSol > 0 ? 'copyable_net_positive' : 'copyable_net_non_positive',
    mode,
    ticketSol,
    walletNetSol,
    tokenOnlyNetSol,
    copyableNetSol,
    copyableNetPct,
    actualWalletDragSol,
    estimatedDragSol,
    assumedAtaRentSol,
    assumedNetworkFeeSol,
    requiredGrossMovePct: estimatedDragSol / ticketSol,
  };
}

function rotationFlowExitPolicyConfig() {
  return {
    lightReducePressure: config.kolHunterRotationExitFlowLightPressure,
    strongReducePressure: config.kolHunterRotationExitFlowStrongPressure,
    fullExitPressure: config.kolHunterRotationExitFlowFullExitPressure,
    criticalExitPressure: config.kolHunterRotationExitFlowCriticalPressure,
    lightReducePct: config.kolHunterRotationExitFlowLightReducePct,
    strongReducePct: config.kolHunterRotationExitFlowStrongReducePct,
    residualHoldSec: config.kolHunterRotationExitFlowResidualHoldSec,
  };
}

function updateRotationFlowMetrics(pos: PaperPosition, nowMs: number): RotationFlowMetrics | null {
  const anchorKols = pos.rotationAnchorKols ?? [];
  if (anchorKols.length === 0) return null;
  const rows = rotationV1RecentTxsByMint.get(pos.tokenMint) ?? [];
  const metrics = buildRotationFlowMetrics({
    rows,
    tokenMint: pos.tokenMint,
    anchorKolIds: anchorKols,
    entryAtMs: pos.rotationEntryAtMs ?? pos.entryTimeSec * 1000,
    nowMs,
    config: rotationFlowMetricsConfig(),
  });
  pos.rotationFlowMetrics = metrics;
  return metrics;
}

function applyRotationFlowReduce(
  pos: PaperPosition,
  decision: RotationFlowExitDecision,
  currentPrice: number,
  nowSec: number,
  mfePct: number
): boolean {
  if (pos.rotationFlowReducedAtSec != null || pos.rotationFlowReduceInFlight === true) return false;
  const didReduce = executePaperPartialTake(
    pos,
    currentPrice,
    nowSec,
    mfePct,
    decision.reducePct,
    {
      eventType: 'rotation_flow_reduce',
      ledgerEventType: 'rotation_flow_reduce',
      logTag: 'KOL_HUNTER_ROTATION_FLOW_REDUCE',
      reason: decision.reason,
      partialKind: 'rotation_flow_reduce',
    }
  );
  if (!didReduce) return false;
  pos.rotationFlowDecision = decision.reason;
  pos.rotationFlowReducedAtSec = nowSec;
  pos.rotationFlowLastReducePct = decision.reducePct;
  pos.rotationFlowResidualUntilSec = nowSec + decision.residualHoldSec;
  pos.survivalFlags = [
    ...pos.survivalFlags,
    `ROTATION_FLOW_${decision.action.toUpperCase()}`,
    `ROTATION_FLOW_REASON_${decision.reason.toUpperCase()}`,
  ];
  return true;
}

function markRotationFlowLiveReduceStarted(
  pos: PaperPosition,
  decision: RotationFlowExitDecision,
  nowSec: number
): void {
  pos.rotationFlowDecision = decision.reason;
  pos.rotationFlowReducedAtSec = nowSec;
  pos.rotationFlowLastReducePct = decision.reducePct;
  pos.rotationFlowResidualUntilSec = nowSec + decision.residualHoldSec;
  pos.rotationFlowReduceInFlight = true;
  pos.survivalFlags = [
    ...pos.survivalFlags,
    `ROTATION_FLOW_${decision.action.toUpperCase()}`,
    `ROTATION_FLOW_REASON_${decision.reason.toUpperCase()}`,
    'ROTATION_FLOW_LIVE_REDUCE',
  ];
}

async function executeLiveRotationFlowReduce(
  pos: PaperPosition,
  decision: RotationFlowExitDecision,
  currentPrice: number,
  nowSec: number,
  mfePct: number
): Promise<boolean> {
  if (!botCtx) {
    log.error(`[KOL_HUNTER_ROTATION_FLOW_REDUCE_LIVE_BLOCKED] ${pos.positionId} no botCtx`);
    return false;
  }
  if (decision.reducePct <= 0 || decision.reducePct >= 1) return false;
  if (pos.rotationFlowReducedAtSec != null || pos.rotationFlowReduceInFlight === true) return false;

  const previous = {
    rotationFlowDecision: pos.rotationFlowDecision,
    rotationFlowReducedAtSec: pos.rotationFlowReducedAtSec,
    rotationFlowLastReducePct: pos.rotationFlowLastReducePct,
    rotationFlowResidualUntilSec: pos.rotationFlowResidualUntilSec,
    rotationFlowReduceInFlight: pos.rotationFlowReduceInFlight,
    survivalFlags: [...pos.survivalFlags],
  };
  markRotationFlowLiveReduceStarted(pos, decision, nowSec);

  const ctx = botCtx;
  try {
    const sellExecutor = getKolHunterExecutor(ctx);
    const initialBalanceProbe = await resolveLiveSellInitialTokenBalance({
      executor: sellExecutor,
      tokenMint: pos.tokenMint,
      context: `kol_hunter:${pos.positionId}:rotation_flow_reduce`,
      reason: decision.reason,
      entryTxSignature: pos.entryTxSignature,
      entryTimeSec: pos.entryTimeSec,
    });
    const tokenBalance = initialBalanceProbe.balance;
    if (tokenBalance <= 0n) {
      throw new Error(`zero token balance for live rotation reduce (attempts=${initialBalanceProbe.attempts})`);
    }

    const reduceBps = BigInt(Math.max(1, Math.min(9999, Math.round(decision.reducePct * 10_000))));
    const requestedSellAmount = (tokenBalance * reduceBps) / 10_000n;
    if (requestedSellAmount <= 0n) {
      throw new Error(`requested sell amount resolved to zero (balance=${tokenBalance.toString()})`);
    }
    const expectedRemainingBalance = tokenBalance > requestedSellAmount
      ? tokenBalance - requestedSellAmount
      : 0n;
    const solBefore = await sellExecutor.getBalance();
    const sellExecution = await executeLiveSellWithImmediateRetries({
      executor: sellExecutor,
      tokenMint: pos.tokenMint,
      initialTokenBalance: tokenBalance,
      requestedSellAmount,
      expectedRemainingBalance,
      context: `kol_hunter:${pos.positionId}:rotation_flow_reduce`,
      reason: decision.reason,
      syntheticSignature: `KOL_ROTATION_FLOW_REDUCE_BALANCE_RECOVERED_${pos.positionId}`,
      urgency: 'hard_cut',
      allowBalanceRecovered: initialBalanceProbe.source !== 'entry_tx_post_balance',
    });
    const sellResult = sellExecution.sellResult;
    const solAfter = await sellExecutor.getBalance();
    const balanceDeltaSol = Number.isFinite(solAfter - solBefore) ? solAfter - solBefore : 0;
    const receivedSol = resolveSellReceivedSolFromSwapResult({
      balanceDeltaSol,
      sellResult,
      context: `kol_hunter:${pos.positionId}:rotation_flow_reduce`,
    });
    const soldRatio = Math.max(0, Math.min(1, sellExecution.soldRatio));
    if (soldRatio <= 0) {
      throw new Error(`live rotation reduce sold ratio is zero (tx=${sellResult.txSignature})`);
    }

    const lockedQuantity = pos.quantity * soldRatio;
    const lockedTicketSol = pos.ticketSol * soldRatio;
    const tokenEntryRef = pos.entryPriceTokenOnly ?? pos.entryPrice;
    const soldCostSol = pos.swapInputSol != null && pos.swapInputSol > 0
      ? pos.swapInputSol * soldRatio
      : tokenEntryRef * lockedQuantity;
    const realizedPrice = lockedQuantity > 0 ? receivedSol / lockedQuantity : currentPrice;
    const lockedNetPct = pos.entryPrice > 0 ? (realizedPrice - pos.entryPrice) / pos.entryPrice : 0;
    const lockedNetSol = receivedSol - soldCostSol;
    const tokenOnlyCostSol = tokenEntryRef * lockedQuantity;
    const netPctTokenOnly = tokenEntryRef > 0 ? (realizedPrice - tokenEntryRef) / tokenEntryRef : 0;
    const netSolTokenOnly = receivedSol - tokenOnlyCostSol;

    pos.quantity *= (1 - soldRatio);
    pos.ticketSol *= (1 - soldRatio);
    pos.partialTakeAtSec = pos.partialTakeAtSec ?? nowSec;
    pos.partialTakeRealizedSol = (pos.partialTakeRealizedSol ?? 0) + lockedNetSol;
    pos.partialTakeLockedTicketSol = (pos.partialTakeLockedTicketSol ?? 0) + lockedTicketSol;
    pos.rotationFlowReduceInFlight = false;
    pos.rotationFlowLiveReduceTxSignature = sellResult.txSignature;
    pos.rotationFlowLiveReduceAttempts = sellExecution.attempts;

    log.info(
      `[KOL_HUNTER_ROTATION_FLOW_REDUCE] ${pos.positionId} mode=live ` +
      `reason=${decision.reason} take=${(soldRatio * 100).toFixed(1)}% ` +
      `received=${receivedSol.toFixed(6)}SOL attempts=${sellExecution.attempts} ` +
      `remaining_ticket=${pos.ticketSol.toFixed(6)}`
    );
    trackPaperPositionMarkout(
      pos,
      'sell',
      currentPrice,
      lockedTicketSol,
      nowSec * 1000,
      {
        eventType: 'rotation_flow_live_reduce',
        exitReason: decision.reason,
        mfePctAtTake: mfePct,
        lockedQuantity,
        lockedTicketSol,
        lockedNetPct,
        lockedNetSol,
        remainingQuantity: pos.quantity,
        remainingTicketSol: pos.ticketSol,
        liveReduceTxSignature: sellResult.txSignature,
        liveReduceAttempts: sellExecution.attempts,
        liveReduceRecoveredFromBalanceOnly: sellExecution.recoveredFromBalanceOnly,
      }
    );
    void appendPartialTakeLedger(
      pos,
      currentPrice,
      nowSec,
      mfePct,
      lockedQuantity,
      lockedTicketSol,
      lockedNetPct,
      lockedNetSol,
      'rotation_flow_live_reduce',
      decision.reason,
      {
        partialKind: 'rotation_flow_reduce',
        txSignature: sellResult.txSignature,
        attempts: sellExecution.attempts,
        soldRatio,
        receivedSol,
        recoveredFromBalanceOnly: sellExecution.recoveredFromBalanceOnly,
      }
    ).catch(() => {});
    await appendEntryLedger('sell', {
      positionId: pos.positionId,
      dbTradeId: pos.dbTradeId,
      txSignature: sellResult.txSignature,
      entryTxSignature: pos.entryTxSignature,
      strategy: LANE_STRATEGY,
      wallet: 'main',
      pairAddress: pos.tokenMint,
      exitReason: 'rotation_flow_live_reduce',
      eventType: 'rotation_flow_live_reduce',
      isPartialReduce: true,
      positionStillOpen: true,
      partialReduceReason: decision.reason,
      partialReducePct: soldRatio,
      receivedSol,
      actualExitPrice: realizedPrice,
      slippageBps: sellResult.slippageBps,
      entryPrice: pos.entryPrice,
      holdSec: nowSec - pos.entryTimeSec,
      mfePctPeak: mfePct,
      mfePctPeakTokenOnly: mfePct,
      mfePctPeakWalletBased: pos.entryPrice > 0 ? (pos.peakPrice - pos.entryPrice) / pos.entryPrice : mfePct,
      maePctTokenOnly: tokenEntryRef > 0 ? (pos.troughPrice - tokenEntryRef) / tokenEntryRef : 0,
      exitPriceTokenOnly: currentPrice,
      netPctTokenOnly,
      netSolTokenOnly,
      entryPriceTokenOnly: pos.entryPriceTokenOnly,
      entryPriceWalletDelta: pos.entryPriceWalletDelta,
      ataRentSol: pos.ataRentSol,
      swapInputSol: pos.swapInputSol,
      peakPrice: pos.peakPrice,
      troughPrice: pos.troughPrice,
      marketReferencePrice: pos.marketReferencePrice,
      sellRetryUrgency: 'hard_cut',
      sellRetryAttempts: sellExecution.attempts,
      sellRecoveredFromBalanceOnly: sellExecution.recoveredFromBalanceOnly,
      sellRetrySoldRatio: soldRatio,
      dbPnlSol: lockedNetSol,
      walletDeltaSol: lockedNetSol,
      dbPnlDriftSol: 0,
      solSpentNominal: soldCostSol,
      kolScore: pos.kolScore,
      independentKolCount: pos.independentKolCount,
      armName: pos.armName,
      profileArm: pos.profileArm ?? null,
      entryArm: pos.entryArm ?? pos.armName,
      exitArm: pos.exitArm ?? pos.armName,
      parameterVersion: pos.parameterVersion,
      entryReason: pos.kolEntryReason,
      rotationAnchorKols: pos.rotationAnchorKols ?? null,
      rotationEntryAtMs: pos.rotationEntryAtMs ?? null,
      rotationAnchorPrice: pos.rotationAnchorPrice ?? null,
      rotationFirstBuyAtMs: pos.rotationFirstBuyAtMs ?? null,
      rotationLastBuyAtMs: pos.rotationLastBuyAtMs ?? null,
      rotationLastBuyAgeMs: pos.rotationLastBuyAgeMs ?? null,
      rotationScore: pos.rotationScore ?? null,
      rotationFlowDecision: decision.reason,
      rotationFlowReducedAtSec: nowSec,
      rotationFlowResidualUntilSec: pos.rotationFlowResidualUntilSec ?? null,
    });
    return true;
  } catch (err) {
    pos.rotationFlowDecision = previous.rotationFlowDecision;
    pos.rotationFlowReducedAtSec = previous.rotationFlowReducedAtSec;
    pos.rotationFlowLastReducePct = previous.rotationFlowLastReducePct;
    pos.rotationFlowResidualUntilSec = previous.rotationFlowResidualUntilSec;
    pos.rotationFlowReduceInFlight = previous.rotationFlowReduceInFlight;
    pos.survivalFlags = previous.survivalFlags;
    log.warn(`[KOL_HUNTER_ROTATION_FLOW_REDUCE_FAIL] ${pos.positionId} ${err}`);
    await ctx.notifier.sendCritical(
      'kol_live_rotation_flow_reduce_failed',
      `${pos.positionId} ${pos.tokenMint} reason=${decision.reason} partial sell failed — full close fallback required`
    ).catch(() => {});
    return false;
  }
}

function markRotationFlowDecision(
  pos: PaperPosition,
  decision: RotationFlowExitDecision,
  liveAction: 'close_full' | 'observe'
): void {
  pos.rotationFlowDecision = decision.reason;
  pos.survivalFlags = [
    ...pos.survivalFlags,
    `ROTATION_FLOW_${decision.action.toUpperCase()}`,
    `ROTATION_FLOW_REASON_${decision.reason.toUpperCase()}`,
    `ROTATION_FLOW_LIVE_${liveAction.toUpperCase()}`,
  ];
}

async function handleLiveRotationFlowDecision(
  pos: PaperPosition,
  decision: RotationFlowExitDecision,
  currentPrice: number,
  reason: CloseReason,
  nowSec: number,
  mfePct: number,
  maePct: number,
  logTag: string
): Promise<boolean> {
  if (decision.action === 'close_full') {
    markRotationFlowDecision(pos, decision, 'close_full');
    log.info(
      `[${logTag}] ${pos.positionId} live action=close_full source=${decision.action} ` +
      `reason=${decision.reason}`
    );
    closePosition(pos, currentPrice, reason, nowSec, mfePct, maePct);
    return true;
  }
  if (decision.action === 'reduce_light' || decision.action === 'reduce_strong') {
    if (pos.rotationFlowReducedAtSec != null || pos.rotationFlowReduceInFlight === true) {
      return true;
    }
    log.info(
      `[${logTag}] ${pos.positionId} live action=reduce source=${decision.action} ` +
      `reason=${decision.reason} reducePct=${decision.reducePct.toFixed(2)}`
    );
    const reduced = await executeLiveRotationFlowReduce(pos, decision, currentPrice, nowSec, mfePct);
    if (reduced) return true;
    log.warn(
      `[${logTag}] ${pos.positionId} live partial reduce failed; ` +
      `fallback=full_close reason=${reason} flowReason=${decision.reason}`
    );
    closePosition(pos, currentPrice, reason, nowSec, mfePct, maePct);
    return true;
  }
  markRotationFlowDecision(pos, decision, 'observe');
  return true;
}

function maybeCloseRotationFlowResidual(
  pos: PaperPosition,
  currentPrice: number,
  nowSec: number,
  mfePct: number,
  maePct: number
): boolean {
  if (!pos.rotationFlowExitEnabled || pos.rotationFlowReducedAtSec == null) return false;
  if (pos.rotationFlowResidualUntilSec == null) return false;
  const currentPct = (currentPrice - pos.marketReferencePrice) / pos.marketReferencePrice;
  if (currentPct >= 0) {
    pos.rotationFlowResidualUntilSec = undefined;
    pos.rotationFlowDecision = 'residual_reclaimed_entry';
    return false;
  }
  if (nowSec < pos.rotationFlowResidualUntilSec) return true;
  pos.rotationFlowDecision = 'residual_timeout';
  closePosition(pos, currentPrice, 'rotation_flow_residual_timeout', nowSec, mfePct, maePct);
  return true;
}

async function handleRotationFlowAnchorSell(
  pos: PaperPosition,
  tx: KolTx,
  nowSec: number,
  mfePct: number,
  maePct: number
): Promise<boolean> {
  if (!pos.rotationFlowExitEnabled) return false;
  const metrics = updateRotationFlowMetrics(pos, Date.now());
  if (!metrics) return false;
  const decision = decideRotationFlowExit(metrics, rotationFlowExitPolicyConfig());
  pos.rotationFlowDecision = decision.reason;
  log.info(
    `[KOL_HUNTER_ROTATION_FLOW_EXIT] ${pos.positionId} kol=${tx.kolId} ` +
    `action=${decision.action} reason=${decision.reason} ` +
    `sellPressure30=${metrics.sellPressure30.toFixed(2)} topupStrength=${metrics.topupStrength.toFixed(2)} ` +
    `freshTopup=${metrics.freshTopup ? 'y' : 'n'}`
  );
  if (pos.isLive === true) {
    return handleLiveRotationFlowDecision(
      pos,
      decision,
      pos.lastPrice,
      'insider_exit_full',
      nowSec,
      mfePct,
      maePct,
      'KOL_HUNTER_ROTATION_FLOW_EXIT'
    );
  }
  if (decision.action === 'close_full') {
    closePosition(pos, pos.lastPrice, 'insider_exit_full', nowSec, mfePct, maePct);
    return true;
  }
  if (decision.action === 'reduce_light' || decision.action === 'reduce_strong') {
    return applyRotationFlowReduce(pos, decision, pos.lastPrice, nowSec, mfePct);
  }
  return true;
}

function handleRotationFlowPriceKill(
  pos: PaperPosition,
  currentPrice: number,
  nowSec: number,
  mfePct: number,
  maePct: number
): boolean {
  if (!pos.rotationFlowExitEnabled) return false;
  if (pos.rotationFlowReducedAtSec != null) {
    return pos.rotationFlowResidualUntilSec != null;
  }
  const metrics = updateRotationFlowMetrics(pos, Date.now());
  if (!metrics) return false;
  const decision = decideRotationFlowPriceKill(metrics, rotationFlowExitPolicyConfig());
  pos.rotationFlowDecision = decision.reason;
  if (decision.action === 'close_full') return false;
  log.info(
    `[KOL_HUNTER_ROTATION_FLOW_PRICE_KILL] ${pos.positionId} action=${decision.action} ` +
    `reason=${decision.reason} sellPressure30=${metrics.sellPressure30.toFixed(2)} ` +
    `freshTopup=${metrics.freshTopup ? 'y' : 'n'}`
  );
  if (pos.isLive === true) {
    void handleLiveRotationFlowDecision(
      pos,
      decision,
      currentPrice,
      'probe_hard_cut',
      nowSec,
      mfePct,
      maePct,
      'KOL_HUNTER_ROTATION_FLOW_PRICE_KILL'
    ).catch((err) => {
      log.warn(`[KOL_HUNTER_ROTATION_FLOW_PRICE_KILL] ${pos.positionId} live reduce failed: ${err}`);
    });
    return true;
  }
  return applyRotationFlowReduce(pos, decision, currentPrice, nowSec, mfePct);
}

function shouldRotationDeadOnArrival(
  pos: PaperPosition,
  elapsedSec: number,
  mfePct: number,
  maePct: number,
  nowMs: number
): boolean {
  if (!isRotationV1Position(pos)) return false;
  const doaWindowSec = pos.rotationDoaWindowSecOverride ?? config.kolHunterRotationV1DoaWindowSec;
  const doaMinMfePct = pos.rotationDoaMinMfePctOverride ?? config.kolHunterRotationV1DoaMinMfePct;
  const doaMaxMaePct = pos.rotationDoaMaxMaePctOverride ?? config.kolHunterRotationV1DoaMaxMaePct;
  if (elapsedSec > doaWindowSec) return false;
  if (mfePct >= doaMinMfePct) return false;
  if (maePct > -doaMaxMaePct) return false;
  if (hasFreshRotationAnchorBuy(pos, nowMs)) return false;
  return true;
}

function shouldRotationMaeFastFail(
  pos: PaperPosition,
  elapsedSec: number,
  mfePct: number,
  maePct: number,
  nowMs: number
): boolean {
  if (!config.kolHunterRotationMaeFastFailEnabled) return false;
  if (!isRotationV1Position(pos)) return false;
  if (pos.t1VisitAtSec != null) return false;
  if (elapsedSec < config.kolHunterRotationMaeFastFailMinElapsedSec) return false;
  const tokenMaePct = pos.excursionTelemetry?.lastMaePct ?? maePct;
  if (mfePct >= config.kolHunterRotationMaeFastFailMaxMfePct) return false;
  if (tokenMaePct > -config.kolHunterRotationMaeFastFailMaxMaePct) return false;
  if (hasFreshRotationAnchorBuy(pos, nowMs)) return false;
  return true;
}

function hasFreshSmartV3ParticipatingBuy(pos: PaperPosition, nowMs: number): boolean {
  const participatingKolIds = pos.participatingKols.map((kol) => kol.id).filter(Boolean);
  if (participatingKolIds.length === 0) return false;
  const sinceMs = nowMs - config.kolHunterSmartV3MaeFastFailFreshBuyGraceSec * 1000;
  const entryOpenedAtMs = pos.entryOpenedAtMs ?? pos.entryTimeSec * 1000;
  return hasParticipatingKolBuyAfter(pos.tokenMint, participatingKolIds, entryOpenedAtMs, sinceMs);
}

function shouldSmartV3MaeFastFail(
  pos: PaperPosition,
  elapsedSec: number,
  mfePct: number,
  maePct: number,
  nowMs: number
): boolean {
  if (!config.kolHunterSmartV3MaeFastFailEnabled) return false;
  if (!isSmartV3Position(pos)) return false;
  if (isRotationFamilyMarkoutPosition(pos)) return false;
  if (pos.t1VisitAtSec != null) return false;
  if (elapsedSec < config.kolHunterSmartV3MaeFastFailMinElapsedSec) return false;
  const tokenMaePct = pos.excursionTelemetry?.lastMaePct ?? maePct;
  // token-only MFE can be inflated by recoverable rent on 0.02 SOL tickets.
  // "Alive" detection must use the market/reference move, while MAE uses token-only loss.
  if (mfePct >= config.kolHunterSmartV3MaeFastFailMaxMfePct) return false;
  if (tokenMaePct > -config.kolHunterSmartV3MaeFastFailMaxMaePct) return false;
  if (hasFreshSmartV3ParticipatingBuy(pos, nowMs)) return false;
  return true;
}

function hasParticipatingKolSellAfterEntry(pos: PaperPosition): boolean {
  const participatingKolIds = pos.participatingKols.map((kol) => kol.id).filter(Boolean);
  if (participatingKolIds.length === 0) return false;
  const afterMs = pos.entryOpenedAtMs ?? pos.entryTimeSec * 1000;
  return hasParticipatingKolSellSince(pos.tokenMint, participatingKolIds, afterMs);
}

function maybeHoldSmartV3MaeRecovery(
  pos: PaperPosition,
  nowSec: number,
  mfePct: number,
  maePct: number
): boolean {
  if (!config.kolHunterSmartV3MaeRecoveryHoldEnabled) return false;
  if (!isSmartV3Position(pos)) return false;
  if (isRotationFamilyMarkoutPosition(pos)) return false;
  if (pos.t1VisitAtSec != null) return false;
  const tokenMaePct = pos.excursionTelemetry?.lastMaePct ?? maePct;
  if (hasParticipatingKolSellAfterEntry(pos)) return false;

  if (pos.smartV3MaeRecoveryHoldUntilSec != null) {
    if (tokenMaePct <= -config.kolHunterSmartV3MaeRecoveryMaxMaePct) return false;
    return nowSec < pos.smartV3MaeRecoveryHoldUntilSec;
  }

  if (pos.smartV3MaeRecoveryHold === true) return false;
  if (mfePct < config.kolHunterSmartV3MaeRecoveryMinMfePct) return false;
  if (tokenMaePct <= -config.kolHunterSmartV3MaeRecoveryMaxMaePct) return false;

  pos.smartV3MaeRecoveryHold = true;
  pos.smartV3MaeRecoveryHoldAtSec = nowSec;
  pos.smartV3MaeRecoveryHoldUntilSec = nowSec + config.kolHunterSmartV3MaeRecoveryHoldSec;
  pos.smartV3MaeRecoveryHoldReason = 'pre_t1_mfe_recovery_window';
  log.info(
    `[KOL_HUNTER_SMART_V3_MAE_RECOVERY_HOLD] ${pos.positionId} ` +
    `mfe=${(mfePct * 100).toFixed(2)}% mae=${(tokenMaePct * 100).toFixed(2)}% ` +
    `until=${pos.smartV3MaeRecoveryHoldUntilSec}`
  );
  return true;
}

// ─── State Machine ───────────────────────────────────────

function onPriceTick(positionId: string, tick: PriceTick): void {
  const pos = active.get(positionId);
  if (!pos || pos.state === 'CLOSED') return;

  const currentPrice = tick.price;
  if (currentPrice <= 0) return;
  pos.lastPrice = currentPrice;

  // Market reference peak/trough
  if (currentPrice > pos.peakPrice) pos.peakPrice = currentPrice;
  if (currentPrice < pos.troughPrice) pos.troughPrice = currentPrice;

  const ref = pos.marketReferencePrice;
  const mfePct = (pos.peakPrice - ref) / ref;
  const maePct = (pos.troughPrice - ref) / ref;
  const currentPct = (currentPrice - ref) / ref;
  const nowSec = Math.floor(Date.now() / 1000);
  const elapsedSec = nowSec - pos.entryTimeSec;
  const tokenTelemetryRef = pos.entryPriceTokenOnly && pos.entryPriceTokenOnly > 0
    ? pos.entryPriceTokenOnly
    : ref;
  if (tokenTelemetryRef > 0) {
    const tokenMfePct = (pos.peakPrice - tokenTelemetryRef) / tokenTelemetryRef;
    const tokenMaePct = (pos.troughPrice - tokenTelemetryRef) / tokenTelemetryRef;
    const tokenCurrentPct = (currentPrice - tokenTelemetryRef) / tokenTelemetryRef;
    pos.excursionTelemetry = updateExcursionTelemetry(pos.excursionTelemetry, {
      elapsedSec,
      maePct: tokenMaePct,
      mfePct: tokenMfePct,
      currentPct: tokenCurrentPct,
    });
  }

  // 2026-04-30 (Sprint 2.A1): 모든 state 에서 structural kill-switch 우선 평가.
  //   PROBE / RUNNER_T1/T2/T3 모두 적용 — sellability 변화는 winner 진입 후에도 위험.
  //   호출 자체는 fire-and-forget (state machine 흐름 막지 않음). cache miss 시만 실제 quote.
  if (shouldRunStructuralKillProbe(pos, currentPrice, Date.now())) {
    void evaluateStructuralKillAsync(pos, currentPrice, nowSec, mfePct, maePct).catch(() => {});
  }

  if (shouldCloseSmartV3MfeFloor(pos, currentPrice, nowSec, mfePct)) {
    closePosition(pos, currentPrice, 'smart_v3_mfe_floor_exit', nowSec, mfePct, maePct);
    return;
  }

  switch (pos.state) {
    case 'PROBE': {
      if (isCapitulationReboundPosition(pos)) {
        const noReactionSec = config.kolHunterCapitulationReboundNoReactionSec;
        if (
          elapsedSec >= noReactionSec &&
          mfePct < config.kolHunterCapitulationReboundT1Mfe &&
          currentPct <= config.kolHunterPaperRoundTripCostPct
        ) {
          closePosition(pos, currentPrice, 'capitulation_no_reaction', nowSec, mfePct, maePct);
          return;
        }
        if (
          elapsedSec >= config.kolHunterCapitulationReboundProbeTimeoutSec &&
          currentPct <= config.kolHunterPaperRoundTripCostPct
        ) {
          closePosition(pos, currentPrice, 'capitulation_no_post_cost', nowSec, mfePct, maePct);
          return;
        }
      }
      if (maybeCloseRotationFlowResidual(pos, currentPrice, nowSec, mfePct, maePct)) {
        return;
      }
      if (shouldRotationDeadOnArrival(pos, elapsedSec, mfePct, maePct, Date.now())) {
        closePosition(pos, currentPrice, 'rotation_dead_on_arrival', nowSec, mfePct, maePct);
        return;
      }
      if (shouldRotationMaeFastFail(pos, elapsedSec, mfePct, maePct, Date.now())) {
        closePosition(pos, currentPrice, 'rotation_mae_fast_fail', nowSec, mfePct, maePct);
        return;
      }
      if (shouldSmartV3MaeFastFail(pos, elapsedSec, mfePct, maePct, Date.now())) {
        closePosition(pos, currentPrice, 'smart_v3_mae_fast_fail', nowSec, mfePct, maePct);
        return;
      }
      // 1. Hard cut (Lane T 파라미터: -10%)
      const probeHardCutPct = pos.probeHardCutPctOverride ?? config.kolHunterHardcutPct;
      if (maePct <= -probeHardCutPct) {
        if (handleRotationFlowPriceKill(pos, currentPrice, nowSec, mfePct, maePct)) {
          return;
        }
        if (maybeHoldSmartV3MaeRecovery(pos, nowSec, mfePct, maePct)) {
          return;
        }
        closePosition(pos, currentPrice, 'probe_hard_cut', nowSec, mfePct, maePct);
        return;
      }
      // 2. Quick reject classifier (Lane T: 180s + 3 factor)
      // paper 는 microstructure data 없음 → elapsed + price 기반 단순 휴리스틱
      // 2026-04-30 (P1-1 winner 보호): 한 번이라도 winnerSafeMfe (default 5%) 도달 시 비활성화.
      //   사유: live n=49 분석에서 mfe>=10% 의 3건 평균 hold 83s, mae -14% — winner 진입 후 retest 케이스.
      //   QR 임계 단축 후 false positive 차단. RUNNER_T1 promote 전 단계라도 winner 영역 진입 시 보호.
      const safeMfeReached = mfePct >= config.kolHunterQuickRejectWinnerSafeMfe;
      if (!safeMfeReached && elapsedSec <= config.kolHunterQuickRejectWindowSec) {
        const factors = countQuickRejectFactors(pos, currentPrice, elapsedSec);
        if (factors >= config.kolHunterQuickRejectFactorCount) {
          closePosition(pos, currentPrice, 'quick_reject_classifier_exit', nowSec, mfePct, maePct);
          return;
        }
      }
      // 3. Flat timeout (stalk 후에도 +10% band 안 넘으면 timeout)
      // arm 별 timeout 적용. smart-v3 는 entry reason 별 RR confidence 를 반영한다.
      const armStalkSec = pos.probeFlatTimeoutSec
        ?? (isSwingV2Position(pos) ? config.kolHunterSwingV2StalkWindowSec : config.kolHunterStalkWindowSec);
      if (elapsedSec >= armStalkSec) {
        // 2026-04-26: hardcode 0.10 → KOL_PAPER_PROBE_FLAT_BAND_PCT (paper 휴리스틱 named const)
        const inFlatBand = Math.abs(currentPct) <= KOL_PAPER_PROBE_FLAT_BAND_PCT;
        if (inFlatBand) {
          closePosition(pos, currentPrice, 'probe_reject_timeout', nowSec, mfePct, maePct);
          return;
        }
      }
      // 4. Probe trail (flat band 벗어난 후 pullback)
      if (pos.peakPrice > ref) {
        const trailStop = pos.peakPrice * (1 - KOL_PAPER_PROBE_TRAIL_PCT);
        if (currentPrice <= trailStop) {
          closePosition(pos, currentPrice, 'probe_flat_cut', nowSec, mfePct, maePct);
          return;
        }
      }
      // 5. T1 promote
      if (mfePct >= (pos.t1MfeOverride ?? config.kolHunterT1Mfe)) {
        pos.state = 'RUNNER_T1';
        pos.t1VisitAtSec = nowSec;
        log.info(`[KOL_HUNTER_T1] ${pos.positionId} promoted MFE=${(mfePct * 100).toFixed(2)}%`);
        // 2026-05-01 (Phase 2.A2 P0): T1 promote 시 partial take — 학술 §convexity 권고.
        //   structural / quick reject / probe_hard_cut 등 PROBE 단계 close 와 분리 — winner 진입 시점에만.
        //   재실행 방지: partialTakeAtSec marker. tail position / shadow arm 은 spawn 안 함.
        if (
          config.kolHunterPartialTakeEnabled &&
          !pos.isTailPosition &&
          pos.partialTakeT1AtSec == null &&
          pos.partialTakeT1InFlight !== true
        ) {
          executePartialTake(pos, currentPrice, nowSec, mfePct);
        }
      }
      break;
    }

    case 'RUNNER_T1': {
      if (mfePct >= config.kolHunterT2Mfe) {
        pos.state = 'RUNNER_T2';
        pos.t2VisitAtSec = nowSec;
        pos.t2BreakevenLockPrice = pos.marketReferencePrice * config.kolHunterT2BreakevenLockMult;
        log.info(
          `[KOL_HUNTER_T2] ${pos.positionId} promoted MFE=${(mfePct * 100).toFixed(2)}% ` +
          `lock=${pos.t2BreakevenLockPrice.toFixed(8)}`
        );
        break;
      }
      if (detectHoldPhaseDegraded(pos, currentPrice)) {
        closePosition(pos, currentPrice, 'hold_phase_sentinel_degraded_exit', nowSec, mfePct, maePct);
        return;
      }
      // 2026-04-26 swing-v2: T1 trail 25% (vs v1 15%) + profit floor entry × 1.10.
      // Why: KOL discovery edge 는 "스윙 winner" — T1 winner 가 너무 빨리 손실 전환되는 것 방지.
      //   profit floor 는 stop 하한선이다. price 가 floor 아래로 내려가면 close 해서 수익 반납을 막는다.
      const t1TrailPct = pos.t1TrailPctOverride
        ?? (isSwingV2Position(pos) ? config.kolHunterSwingV2T1TrailPct : config.kolHunterT1TrailPct);
      const rawTrailStop = pos.peakPrice * (1 - t1TrailPct);
      const profitFloorMult = pos.t1ProfitFloorMult
        ?? (isSwingV2Position(pos) ? config.kolHunterSwingV2T1ProfitFloorMult : undefined);
      const entryRef = strategyEntryReferencePrice(pos);
      const trailStop = profitFloorMult != null
        ? Math.max(rawTrailStop, entryRef * profitFloorMult)
        : rawTrailStop;
      if (currentPrice <= trailStop) {
        closePosition(pos, currentPrice, 'winner_trailing_t1', nowSec, mfePct, maePct);
        return;
      }
      break;
    }

    case 'RUNNER_T2': {
      if (mfePct >= config.kolHunterT3Mfe) {
        pos.state = 'RUNNER_T3';
        pos.t3VisitAtSec = nowSec;
        log.info(`[KOL_HUNTER_T3] ${pos.positionId} promoted MFE=${(mfePct * 100).toFixed(2)}%`);
        break;
      }
      if (detectHoldPhaseDegraded(pos, currentPrice)) {
        closePosition(pos, currentPrice, 'hold_phase_sentinel_degraded_exit', nowSec, mfePct, maePct);
        return;
      }
      const trailStop = Math.max(
        pos.peakPrice * (1 - config.kolHunterT2TrailPct),
        pos.t2BreakevenLockPrice ?? pos.marketReferencePrice * config.kolHunterT2BreakevenLockMult
      );
      if (currentPrice <= trailStop) {
        closePosition(pos, currentPrice, 'winner_trailing_t2', nowSec, mfePct, maePct);
        return;
      }
      break;
    }

    case 'RUNNER_T3': {
      // no time stop
      const trailStop = pos.peakPrice * (1 - config.kolHunterT3TrailPct);
      if (currentPrice <= trailStop) {
        closePosition(pos, currentPrice, 'winner_trailing_t3', nowSec, mfePct, maePct);
        return;
      }
      break;
    }

    // 2026-05-01 (Phase C): tail sub-position state machine.
    //   parent 의 price-kill close 후 spawn 된 retained 비중 (default 15%).
    //   학술 §tail retention — convex payoff 기다리되 max hold cap 으로 moonbag 무한 hold 차단.
    case 'TAIL': {
      // 1. Max hold expiry — moonbag 무한 hold 방지 (default 3600s)
      if (elapsedSec >= config.kolHunterTailMaxHoldSec) {
        closePosition(pos, currentPrice, 'tail_max_hold', nowSec, mfePct, maePct);
        return;
      }
      // 2. Tail trail — peak 대비 looser pullback (default 30% — RUNNER_T1 의 15% 보다 관대)
      //    tail 의 entry 는 parent close price 이므로 mfe 는 parent close 시점 대비 추가 상승만 측정.
      const tailTrailStop = pos.peakPrice * (1 - config.kolHunterTailTrailPct);
      const tailEntryRef = strategyEntryReferencePrice(pos);
      if (currentPrice <= tailTrailStop && pos.peakPrice > tailEntryRef) {
        // tail 자체가 5x+ 도달 (mfePct ≥ kolHunterT2Mfe = 4.0) 이면 winner 분리
        const tailMfe = (pos.peakPrice - tailEntryRef) / tailEntryRef;
        const reason: CloseReason = tailMfe >= config.kolHunterT2Mfe
          ? 'tail_winner_capture'
          : 'tail_trail_close';
        closePosition(pos, currentPrice, reason, nowSec, mfePct, maePct);
        return;
      }
      break;
    }
  }
}

/**
 * Sprint 2.A1: structural kill-switch async evaluator.
 *
 * fire-and-forget — onPriceTick 흐름 막지 않음. cache miss 시만 실제 quote (rate-limit).
 * impact >= maxImpactPct 또는 no_route 발견 시 closePosition 으로 emergency close.
 */
async function evaluateStructuralKillAsync(
  pos: PaperPosition,
  currentPrice: number,
  nowSec: number,
  mfePct: number,
  maePct: number
): Promise<void> {
  const nowMs = Date.now();
  // double-check (race fix — 동일 mint 의 동시 tick 처리 시 cache 갱신 직전 race)
  const cached = structuralKillCache.get(pos.positionId);
  if (cached && nowMs - cached.evaluatedAt < config.kolHunterStructuralKillCacheMs) return;

  // 2026-04-30 (F3 fix): tokenDecimals 미설정 시 skip — fallback 6 은 9-decimal 토큰에서
  // probe raw 1000x 작아져 impactPct 부정확. tokenDecimals 는 entry 시점에 stash 되며
  // recovery 등 예외 경로에서만 nullish. 정확도 우선으로 quote 자체 skip.
  if (pos.tokenDecimals == null) {
    structuralKillCache.set(pos.positionId, { evaluatedAt: nowMs, lastTrigger: 'safe' });
    return;
  }
  const tokenDecimals = pos.tokenDecimals;
  // 현재 보유량 기반 sell quote — paper 는 가상 quantity, live 는 실 quantity 동일.
  const probeTokenAmountRaw = BigInt(Math.max(1, Math.floor(pos.quantity * 10 ** tokenDecimals)));
  let observedImpactPct = 0;
  let routeFound = false;
  try {
    const result = await evaluateSellQuoteProbe({
      tokenMint: pos.tokenMint,
      probeTokenAmountRaw,
      expectedSolReceive: pos.ticketSol,
      tokenDecimals,
    }, {
      maxImpactPct: config.kolHunterStructuralKillMaxImpactPct,
    });
    routeFound = result.routeFound;
    observedImpactPct = result.observedImpactPct;
  } catch (err) {
    // quote 실패는 critical 로 간주 안 함 — 다음 tick 에서 재평가.
    structuralKillCache.set(pos.positionId, { evaluatedAt: nowMs, lastTrigger: 'safe' });
    log.debug(`[KOL_STRUCTURAL_KILL_QUOTE_FAIL] ${pos.positionId} ${err}`);
    return;
  }

  const shouldKill = !routeFound || observedImpactPct > config.kolHunterStructuralKillMaxImpactPct;
  structuralKillCache.set(pos.positionId, {
    evaluatedAt: nowMs,
    lastTrigger: shouldKill ? 'kill' : 'safe',
  });

  if (shouldKill && pos.state !== 'CLOSED') {
    log.warn(
      `[KOL_HUNTER_STRUCTURAL_KILL] ${pos.positionId} ${pos.tokenMint.slice(0, 8)} ` +
      `routeFound=${routeFound} impact=${(observedImpactPct * 100).toFixed(2)}% ` +
      `state=${pos.state} mfe=${(mfePct * 100).toFixed(2)}% mae=${(maePct * 100).toFixed(2)}%`
    );
    closePosition(pos, currentPrice, 'structural_kill_sell_route', nowSec, mfePct, maePct);
  }
}

function countQuickRejectFactors(pos: PaperPosition, currentPrice: number, elapsedSec: number): number {
  // Paper 모드에서는 candle microstructure 데이터 없음 → price-based 휴리스틱
  // 2026-04-30 (P1-1): mfeLow / pullback 임계는 config 로 승격. price drop 만 hardcode 유지.
  let factors = 0;
  const mfeSoFar = (pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice;
  const currentPct = (currentPrice - pos.marketReferencePrice) / pos.marketReferencePrice;
  if (
    mfeSoFar < config.kolHunterQuickRejectMfeLowThreshold &&
    elapsedSec > config.kolHunterQuickRejectMfeLowElapsedSec
  ) factors += 1;
  if (currentPct < KOL_PAPER_QUICK_REJECT_PRICE_DROP_THRESHOLD) factors += 1;
  const pullback = (pos.peakPrice - currentPrice) / Math.max(pos.peakPrice, 1e-12);
  if (pullback > config.kolHunterQuickRejectPullbackThreshold) factors += 1;
  return factors;
}

function detectHoldPhaseDegraded(pos: PaperPosition, currentPrice: number): boolean {
  // Paper: peak 로부터 큰 drop + price 감소 지속 시 degraded 판정
  const peakDrift = (pos.peakPrice - currentPrice) / Math.max(pos.peakPrice, 1e-12);
  return peakDrift > config.kolHunterHoldPhasePeakDriftThreshold;
}

// ─── Close ───────────────────────────────────────────────

function closePosition(
  pos: PaperPosition,
  exitPrice: number,
  reason: CloseReason,
  nowSec: number,
  mfePctAtClose: number,
  maePctAtClose: number
): void {
  // 2026-04-27 (KOL live canary): live position 은 비동기 sell + DB close 별도 분기.
  // fire-and-forget — tickMonitor 흐름은 막지 않음. 실패 시 critical alert.
  if (pos.isLive === true) {
    if (pos.partialTakeT1InFlight === true) {
      pos.pendingCloseAfterPartialTake = {
        exitPrice,
        reason,
        nowSec,
        mfePctAtClose,
        maePctAtClose,
      };
      log.warn(
        `[KOL_HUNTER_LIVE_CLOSE_DEFERRED_PARTIAL_TAKE] ${pos.positionId} ` +
        `reason=${reason} — waiting for live T1 partial sell to settle`
      );
      return;
    }
    // 2026-04-27 race fix: tickMonitor 가 동시에 close signal 두 번 발사 시 (예: hardcut + insider_exit)
    // closeLivePosition 가 비동기라 두 번째 invocation 이 첫 sell 완료 전 진입 → 2중 sell 위험.
    // 즉시 state='CLOSED' 로 mark + closing flag 로 추가 동시 호출 차단. 실제 sell/DB close 는 비동기.
    if (pos.state === 'CLOSED') return;  // 이미 진행 중
    // 2026-04-28 F1 fix: previousState 를 mutation 전 capture → closeLivePosition 의 sell-fail 분기에서
    // pos.state = previousState 가 의미 있는 복원이 됨. 이전 코드는 mutation 후 capture 라
    // sell 실패 시 영구 'CLOSED' 잠금 (DB 는 OPEN 으로 남음 → orphan 상태 누적).
    const previousState = pos.state;
    emitKolPositionPolicy(pos, 'close', 'exit', {
      closeReason: reason,
      mfePct: mfePctAtClose,
      maePct: maePctAtClose,
      holdSec: nowSec - pos.entryTimeSec,
    });
    pos.state = 'CLOSED';
    void closeLivePosition(pos, exitPrice, reason, nowSec, mfePctAtClose, maePctAtClose, previousState);
    return;
  }
  pos.state = 'CLOSED';

  const holdSec = nowSec - pos.entryTimeSec;
  const netPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
  const paperRoundTripCostPct = config.kolHunterPaperRoundTripCostPct;
  const runnerNetSol = pos.ticketSol * (netPct - paperRoundTripCostPct);
  // 2026-05-01 (codex F-A fix): partial take realized PnL 을 close netSol 에 합산.
  //   readers (appendPaperLedger / markKolClosed / DSR validator / kol-paper-arm-report / decay
  //   tracker) 가 모두 close netSol 만 본다 → 부분익절 분 합산 안 하면 winner systematic underreport.
  //   netPct 도 effective (original ticket 대비) 로 재계산.
  const partialNetSol = pos.partialTakeRealizedSol ?? 0;
  const partialTicketSol = pos.partialTakeLockedTicketSol ?? 0;
  const netSol = runnerNetSol + partialNetSol;
  const effectiveTicketSol = pos.ticketSol + partialTicketSol;
  const effectiveNetPct = effectiveTicketSol > 0 ? netSol / effectiveTicketSol : netPct;
  emitKolPositionPolicy(pos, 'close', 'exit', {
    closeReason: reason,
    mfePct: mfePctAtClose,
    maePct: maePctAtClose,
    holdSec,
  });

  log.info(
    `[KOL_HUNTER_PAPER_CLOSE] ${pos.positionId} reason=${reason} ` +
    `hold=${holdSec}s mfe=${(mfePctAtClose * 100).toFixed(2)}% mae=${(maePctAtClose * 100).toFixed(2)}% ` +
    `net=${(effectiveNetPct * 100).toFixed(2)}% t1=${pos.t1VisitAtSec ? 'y' : 'n'} ` +
    `t2=${pos.t2VisitAtSec ? 'y' : 'n'} t3=${pos.t3VisitAtSec ? 'y' : 'n'}` +
    (partialNetSol !== 0
      ? ` partial=${partialNetSol >= 0 ? '+' : ''}${partialNetSol.toFixed(6)}SOL runner_net=${(netPct * 100).toFixed(2)}%`
      : '')
  );
  trackPaperPositionMarkout(
    pos,
    'sell',
    exitPrice,
    pos.swapInputSol ?? pos.ticketSol,
    nowSec * 1000,
    {
      eventType: 'paper_close',
      exitReason: reason,
      closeState: pos.state,
      holdSec,
      mfePctAtClose,
      maePctAtClose,
      netSol,
      netPct: effectiveNetPct,
      partialNetSol,
      partialTicketSol,
    }
  );

  // 2026-04-30 (B1 refactor): KOL close-site 는 모두 'kol_close' 로 통일.
  //   세부 분기는 rejectReason 으로 보존 (winner-kill-analyzer 등이 reason 별 cohort 분리 가능).
  //   이전: 5 close reason 별 enum 매핑 → reject-side 와 enum 공유로 close vs reject 구분 약함.
  if (!pos.isShadowArm) {
    trackRejectForMissedAlpha(
      {
        rejectCategory: 'kol_close',
        rejectReason: reason,
        tokenMint: pos.tokenMint,
        lane: LANE_STRATEGY,
        signalPrice: pos.marketReferencePrice,
        probeSolAmount: pos.ticketSol,
        // 2026-04-26 P1 fix: decimals_unknown 차단 — entry 시 stash 한 값 전파
        tokenDecimals: pos.tokenDecimals,
        signalSource: `kol_hunter:${pos.participatingKols.map((k) => k.id).join(',')}`,
        extras: {
          positionId: pos.positionId,
          closeState: pos.state,
          elapsedSecAtClose: holdSec,
          mfePctAtClose,
          maePctAtClose,
          entryPrice: pos.entryPrice,
          exitPrice,
          peakPrice: pos.peakPrice,
          troughPrice: pos.troughPrice,
          t1VisitAtSec: pos.t1VisitAtSec ?? null,
          t2VisitAtSec: pos.t2VisitAtSec ?? null,
          t3VisitAtSec: pos.t3VisitAtSec ?? null,
          kolScore: pos.kolScore,
          armName: pos.armName,
          parameterVersion: pos.parameterVersion,
          isLive: false,
          isShadowArm: pos.isShadowArm,
          parentPositionId: pos.parentPositionId ?? null,
          kolEntryReason: pos.kolEntryReason,
          kolConvictionLevel: pos.kolConvictionLevel,
          kolReinforcementCount: pos.kolReinforcementCount,
          t1MfeOverride: pos.t1MfeOverride ?? null,
          t1TrailPctOverride: pos.t1TrailPctOverride ?? null,
          t1ProfitFloorMult: pos.t1ProfitFloorMult ?? null,
          probeFlatTimeoutSec: pos.probeFlatTimeoutSec ?? null,
          rotationAnchorKols: pos.rotationAnchorKols ?? null,
          rotationEntryAtMs: pos.rotationEntryAtMs ?? null,
          rotationAnchorPrice: pos.rotationAnchorPrice ?? null,
          rotationAnchorPriceSource: pos.rotationAnchorPriceSource ?? null,
          rotationFirstBuyAtMs: pos.rotationFirstBuyAtMs ?? null,
          rotationLastBuyAtMs: pos.rotationLastBuyAtMs ?? null,
          rotationLastBuyAgeMs: pos.rotationLastBuyAgeMs ?? null,
          rotationScore: pos.rotationScore ?? null,
          underfillReferenceSolAmount: pos.underfillReferenceSolAmount ?? null,
          underfillReferenceTokenAmount: pos.underfillReferenceTokenAmount ?? null,
          rotationFlowExitEnabled: pos.rotationFlowExitEnabled ?? false,
          rotationFlowMetrics: pos.rotationFlowMetrics ?? null,
          rotationFlowDecision: pos.rotationFlowDecision ?? null,
          rotationFlowReducedAtSec: pos.rotationFlowReducedAtSec ?? null,
          rotationFlowResidualUntilSec: pos.rotationFlowResidualUntilSec ?? null,
          rotationFlowLastReducePct: pos.rotationFlowLastReducePct ?? null,
          rotationMonetizableEdge: pos.rotationMonetizableEdge ?? null,
          tokenDecimalsSource: pos.tokenDecimalsSource ?? null,
        },
      },
      buildObserverConfig()
    );
  }

  // Paper ledger append
  // 2026-05-01 (codex F-A fix): netPct 도 effective (partial + runner 합산 / original ticket) 로 전달.
  void appendPaperLedger(pos, exitPrice, reason, holdSec, mfePctAtClose, maePctAtClose, netSol, effectiveNetPct);

  deleteActivePosition(pos.positionId);  // P1 #5: index 동기화

  // 2026-04-29 (Track 1): Same-token re-entry cooldown — close 시점 stamp.
  // shadow arm (paired) 도 stamp 하지만 main arm 만 정합 (shadow 는 paper-only fallback).
  if (!pos.isShadowArm) {
    markTokenClosed(pos.tokenMint);
    // 2026-04-29 (P0-2): KOL alpha decay tracking — paper close 도 KOL track-record 누적.
    markKolClosed(pos.participatingKols.map((k) => k.id), netSol);
    markSmartV3ComboClosed(pos, netSol, 'paper');
  }

  // price feed unsubscribe — token 의 모든 A/B arm 이 닫힌 뒤에만 정리
  unsubscribePriceIfIdle(pos.tokenMint);

  // 2026-04-26 paper notifier L2: peak MFE 같이 전달 → anomaly 알림 (5x+ winner) 판정 가능
  const mfePctPeak = pos.marketReferencePrice > 0
    ? (pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice
    : 0;
  // 2026-05-01 (codex F-A fix): netPct → effectiveNetPct (partial 합산 기준).
  kolHunterEvents.emit('paper_close', { pos, reason, exitPrice, netSol, netPct: effectiveNetPct, mfePctPeak, holdSec });

  // 2026-05-01 (Phase C): tail retain — price-kill close 후 별도 sub-position 생성.
  //   학술 §tail retention (Kaminski-Lo + Taleb + TSMOM) 정합. paper-only first.
  //   structural_kill / insider_exit_full / winner_trailing / orphan / tail_* 는 spawn 안 함.
  //   shadow arm (이미 sub-position) 자체에서 tail spawn 안 함 (recursive 차단).
  if (
    config.kolHunterTailRetainEnabled &&
    !pos.isShadowArm &&
    !pos.isTailPosition &&  // tail 의 close 에서 다시 tail spawn 차단
    !isRotationFamilyMarkoutPosition(pos) &&
    isPriceKillReason(reason)
  ) {
    spawnTailSubPosition(pos, exitPrice, nowSec);
  }
}

/** Phase C: price-kill close reason 판정 — tail retain 분기 입력. */
function isPriceKillReason(reason: CloseReason): boolean {
  return reason === 'probe_hard_cut'
    || reason === 'rotation_mae_fast_fail'
    || reason === 'smart_v3_mae_fast_fail'
    || reason === 'probe_flat_cut'
    || reason === 'probe_reject_timeout'
    || reason === 'quick_reject_classifier_exit';
}

function liveSellUrgencyForCloseReason(reason: CloseReason): LiveSellRetryUrgency {
  if (reason === 'structural_kill_sell_route') return 'structural';
  if (
    reason === 'probe_hard_cut' ||
    reason === 'rotation_dead_on_arrival' ||
    reason === 'rotation_mae_fast_fail' ||
    reason === 'smart_v3_mae_fast_fail' ||
    reason === 'smart_v3_mfe_floor_exit'
  ) return 'hard_cut';
  return 'normal';
}

/**
 * Phase C: tail sub-position spawn. parent close 직후 호출.
 *   - state: 'TAIL'
 *   - quantity: parent.quantity * kolHunterTailRetainPct (default 15%)
 *   - tickerSol: parent ticket * retainPct (paper accounting)
 *   - peak/trough: 현재 exit price 기준 reset (tail 자체 trail)
 *   - parentPositionId: 추적용
 */
/**
 * 2026-05-01 (Phase 2.A2 P0): T1 promote 시 partial take.
 *
 * 동작:
 *   - takePct (default 30%) 비중을 lock-in (paper accounting 또는 live partial sell)
 *   - pos.quantity / ticketSol 을 (1 - takePct) 배수로 축소 (잔여 runner)
 *   - partialTakeAtSec marker 로 재실행 방지
 *   - paper: 가상 lock-in (ledger jsonl 별도 record)
 *   - live (kolHunterPartialTakeLiveEnabled=true + isLive=true): closeLivePosition 패턴 재사용
 *
 * 학술 정합:
 *   - Taleb (2007) convexity — 일부 lock-in + nominal upside 추구
 *   - Carver (2015) Systematic Trading — 1/3 at +N, 1/3 at +2N, 1/3 trail 권고 변형
 *   - Moskowitz et al. TSMOM — winner truncation 위험 차단 (전량 close 회피)
 */
function executePartialTake(pos: PaperPosition, currentPrice: number, nowSec: number, mfePct: number): void {
  if (pos.isLive === true) {
    if (!config.kolHunterPartialTakeLiveEnabled) {
      log.debug(
        `[KOL_HUNTER_PARTIAL_TAKE_PAPER_ONLY] ${pos.positionId} live parent — ` +
        `partial take skipped because live flag is disabled`
      );
      return;
    }
    if (pos.partialTakeT1InFlight === true || pos.partialTakeT1AtSec != null) return;
    pos.partialTakeT1InFlight = true;
    void executeLiveT1PartialTake(pos, currentPrice, nowSec, mfePct).catch((err) => {
      pos.partialTakeT1InFlight = false;
      pos.partialTakeT1LiveFailedAtSec = Math.floor(Date.now() / 1000);
      pos.partialTakeT1LiveFailureCount = (pos.partialTakeT1LiveFailureCount ?? 0) + 1;
      pos.partialTakeT1LiveFailureReason = String(err);
      log.warn(`[KOL_HUNTER_PARTIAL_TAKE_LIVE_FAIL] ${pos.positionId} ${err}`);
      drainPendingCloseAfterPartialTake(pos);
    });
    return;
  }
  executePaperPartialTake(pos, currentPrice, nowSec, mfePct, config.kolHunterPartialTakePct, {
    eventType: 'paper_partial_take',
    ledgerEventType: 'partial_take',
    logTag: 'KOL_HUNTER_PARTIAL_TAKE',
    partialKind: 't1_partial_take',
  });
}

function drainPendingCloseAfterPartialTake(pos: PaperPosition): void {
  const pendingClose = pos.pendingCloseAfterPartialTake;
  if (!pendingClose || pos.state === 'CLOSED') return;
  pos.pendingCloseAfterPartialTake = undefined;
  closePosition(
    pos,
    pendingClose.exitPrice,
    pendingClose.reason,
    pendingClose.nowSec,
    pendingClose.mfePctAtClose,
    pendingClose.maePctAtClose,
  );
}

async function executeLiveT1PartialTake(
  pos: PaperPosition,
  currentPrice: number,
  nowSec: number,
  mfePct: number
): Promise<boolean> {
  if (!botCtx) {
    throw new Error('botCtx missing for live T1 partial take');
  }
  const takePct = config.kolHunterPartialTakePct;
  if (takePct <= 0 || takePct >= 1) {
    pos.partialTakeT1InFlight = false;
    return false;
  }
  const ctx = botCtx;
  const sellExecutor = getKolHunterExecutor(ctx);
  try {
    const initialBalanceProbe = await resolveLiveSellInitialTokenBalance({
      executor: sellExecutor,
      tokenMint: pos.tokenMint,
      context: `kol_hunter:${pos.positionId}:partial_take_t1`,
      reason: 'partial_take_t1',
      entryTxSignature: pos.entryTxSignature,
      entryTimeSec: pos.entryTimeSec,
    });
    const tokenBalance = initialBalanceProbe.balance;
    if (tokenBalance <= 0n) {
      throw new Error(`zero token balance for live T1 partial take (attempts=${initialBalanceProbe.attempts})`);
    }
    const takeBps = BigInt(Math.max(1, Math.min(9999, Math.round(takePct * 10_000))));
    const requestedSellAmount = (tokenBalance * takeBps) / 10_000n;
    if (requestedSellAmount <= 0n) {
      throw new Error(`requested T1 partial sell amount resolved to zero (balance=${tokenBalance.toString()})`);
    }
    const expectedRemainingBalance = tokenBalance > requestedSellAmount
      ? tokenBalance - requestedSellAmount
      : 0n;
    const solBefore = await sellExecutor.getBalance();
    const sellExecution = await executeLiveSellWithImmediateRetries({
      executor: sellExecutor,
      tokenMint: pos.tokenMint,
      initialTokenBalance: tokenBalance,
      requestedSellAmount,
      expectedRemainingBalance,
      context: `kol_hunter:${pos.positionId}:partial_take_t1`,
      reason: 'partial_take_t1',
      syntheticSignature: `KOL_PARTIAL_TAKE_T1_BALANCE_RECOVERED_${pos.positionId}`,
      urgency: 'normal',
      allowBalanceRecovered: initialBalanceProbe.source !== 'entry_tx_post_balance',
    });
    const sellResult = sellExecution.sellResult;
    const solAfter = await sellExecutor.getBalance();
    const balanceDeltaSol = Number.isFinite(solAfter - solBefore) ? solAfter - solBefore : 0;
    const receivedSol = resolveSellReceivedSolFromSwapResult({
      balanceDeltaSol,
      sellResult,
      context: `kol_hunter:${pos.positionId}:partial_take_t1`,
    });
    const soldRatio = Math.max(0, Math.min(1, sellExecution.soldRatio));
    if (soldRatio <= 0) {
      throw new Error(`live T1 partial sold ratio is zero (tx=${sellResult.txSignature})`);
    }

    const lockedQuantity = pos.quantity * soldRatio;
    const lockedTicketSol = pos.ticketSol * soldRatio;
    const walletCostSol = pos.entryPrice * lockedQuantity;
    const tokenEntryRef = pos.entryPriceTokenOnly && pos.entryPriceTokenOnly > 0
      ? pos.entryPriceTokenOnly
      : pos.marketReferencePrice;
    const realizedPrice = lockedQuantity > 0 ? receivedSol / lockedQuantity : currentPrice;
    const lockedNetPct = pos.entryPrice > 0 ? (realizedPrice - pos.entryPrice) / pos.entryPrice : 0;
    const lockedNetSol = receivedSol - walletCostSol;
    const netPctTokenOnly = tokenEntryRef > 0 ? (currentPrice - tokenEntryRef) / tokenEntryRef : 0;
    const netSolTokenOnly = tokenEntryRef > 0 ? (currentPrice - tokenEntryRef) * lockedQuantity : lockedNetSol;

    pos.quantity *= (1 - soldRatio);
    pos.ticketSol *= (1 - soldRatio);
    if (pos.swapInputSol != null && pos.swapInputSol > 0) {
      pos.swapInputSol *= (1 - soldRatio);
    }
    pos.partialTakeAtSec = pos.partialTakeAtSec ?? nowSec;
    pos.partialTakeT1AtSec = nowSec;
    pos.partialTakeT1InFlight = false;
    pos.partialTakeT1LiveFailedAtSec = undefined;
    pos.partialTakeT1LiveFailureReason = undefined;
    pos.partialTakeT1LiveTxSignature = sellResult.txSignature;
    pos.partialTakeT1LiveAttempts = sellExecution.attempts;
    pos.partialTakeRealizedSol = (pos.partialTakeRealizedSol ?? 0) + lockedNetSol;
    pos.partialTakeLockedTicketSol = (pos.partialTakeLockedTicketSol ?? 0) + lockedTicketSol;

    log.info(
      `[KOL_HUNTER_PARTIAL_TAKE] ${pos.positionId} mode=live reason=t1_partial_take ` +
      `take=${(soldRatio * 100).toFixed(1)}% received=${receivedSol.toFixed(6)}SOL ` +
      `attempts=${sellExecution.attempts} remaining_ticket=${pos.ticketSol.toFixed(6)}`
    );

    trackTradeMarkout(
      {
        anchorType: 'sell',
        positionId: pos.positionId,
        tokenMint: pos.tokenMint,
        anchorTxSignature: sellResult.txSignature,
        anchorAtMs: Date.now(),
        anchorPrice: currentPrice,
        anchorPriceKind: 'exit_token_only',
        probeSolAmount: lockedTicketSol,
        tokenDecimals: pos.tokenDecimals,
        signalSource: pos.armName,
        extras: {
          mode: 'live',
          eventType: 'live_partial_take_t1',
          exitReason: 'partial_take_t1',
          partialKind: 't1_partial_take',
          armName: pos.armName,
          profileArm: pos.profileArm ?? null,
          entryArm: pos.entryArm ?? pos.armName,
          exitArm: pos.exitArm ?? pos.armName,
          parameterVersion: pos.parameterVersion,
          mfePctAtTake: mfePct,
          lockedQuantity,
          lockedTicketSol,
          lockedNetPct,
          lockedNetSol,
          remainingQuantity: pos.quantity,
          remainingTicketSol: pos.ticketSol,
          txSignature: sellResult.txSignature,
          attempts: sellExecution.attempts,
          recoveredFromBalanceOnly: sellExecution.recoveredFromBalanceOnly,
          receivedSol,
          netPctTokenOnly,
          netSolTokenOnly,
        },
      },
      buildTradeMarkoutObserverConfig(pos)
    );
    void appendPartialTakeLedger(
      pos,
      currentPrice,
      nowSec,
      mfePct,
      lockedQuantity,
      lockedTicketSol,
      lockedNetPct,
      lockedNetSol,
      'partial_take_t1',
      'partial_take_t1',
      {
        partialKind: 't1_partial_take',
        mode: 'live',
        txSignature: sellResult.txSignature,
        attempts: sellExecution.attempts,
        soldRatio,
        receivedSol,
        recoveredFromBalanceOnly: sellExecution.recoveredFromBalanceOnly,
        netPctTokenOnly,
        netSolTokenOnly,
      }
    ).catch(() => {});
    await appendEntryLedger('sell', {
      positionId: pos.positionId,
      dbTradeId: pos.dbTradeId,
      txSignature: sellResult.txSignature,
      entryTxSignature: pos.entryTxSignature,
      strategy: LANE_STRATEGY,
      wallet: 'main',
      pairAddress: pos.tokenMint,
      exitReason: 'partial_take_t1',
      eventType: 'partial_take_t1',
      isPartialTake: true,
      partialTakeKind: 't1_partial_take',
      positionStillOpen: true,
      partialTakePct: soldRatio,
      receivedSol,
      actualExitPrice: realizedPrice,
      slippageBps: sellResult.slippageBps,
      entryPrice: pos.entryPrice,
      holdSec: nowSec - pos.entryTimeSec,
      mfePctPeak: mfePct,
      mfePctPeakTokenOnly: mfePct,
      mfePctPeakWalletBased: pos.entryPrice > 0 ? (pos.peakPrice - pos.entryPrice) / pos.entryPrice : mfePct,
      maePctTokenOnly: tokenEntryRef > 0 ? (pos.troughPrice - tokenEntryRef) / tokenEntryRef : 0,
      exitPriceTokenOnly: currentPrice,
      netPctTokenOnly,
      netSolTokenOnly,
      entryPriceTokenOnly: pos.entryPriceTokenOnly,
      entryPriceWalletDelta: pos.entryPriceWalletDelta,
      ataRentSol: pos.ataRentSol,
      swapInputSol: pos.swapInputSol,
      peakPrice: pos.peakPrice,
      troughPrice: pos.troughPrice,
      marketReferencePrice: pos.marketReferencePrice,
      sellRetryUrgency: 'normal',
      sellRetryAttempts: sellExecution.attempts,
      sellRecoveredFromBalanceOnly: sellExecution.recoveredFromBalanceOnly,
      sellRetrySoldRatio: soldRatio,
      dbPnlSol: lockedNetSol,
      walletDeltaSol: lockedNetSol,
      dbPnlDriftSol: 0,
      solSpentNominal: walletCostSol,
      kolScore: pos.kolScore,
      independentKolCount: pos.independentKolCount,
      armName: pos.armName,
      profileArm: pos.profileArm ?? null,
      entryArm: pos.entryArm ?? pos.armName,
      exitArm: pos.exitArm ?? pos.armName,
      parameterVersion: pos.parameterVersion,
      entryReason: pos.kolEntryReason,
      partialTakeAtSec: pos.partialTakeAtSec ?? null,
      partialTakeT1AtSec: pos.partialTakeT1AtSec ?? null,
      partialTakeT1LiveTxSignature: pos.partialTakeT1LiveTxSignature ?? null,
      partialTakeT1LiveAttempts: pos.partialTakeT1LiveAttempts ?? null,
    });
    drainPendingCloseAfterPartialTake(pos);
    return true;
  } catch (err) {
    pos.partialTakeT1InFlight = false;
    pos.partialTakeT1LiveFailedAtSec = Math.floor(Date.now() / 1000);
    pos.partialTakeT1LiveFailureCount = (pos.partialTakeT1LiveFailureCount ?? 0) + 1;
    pos.partialTakeT1LiveFailureReason = String(err);
    log.warn(`[KOL_HUNTER_PARTIAL_TAKE_LIVE_FAIL] ${pos.positionId} ${err}`);
    drainPendingCloseAfterPartialTake(pos);
    return false;
  }
}

function executePaperPartialTake(
  pos: PaperPosition,
  currentPrice: number,
  nowSec: number,
  mfePct: number,
  takePct: number,
  meta: {
    eventType: string;
    ledgerEventType: string;
    logTag: string;
    reason?: string;
    partialKind?: 't1_partial_take' | 'rotation_flow_reduce';
  }
): boolean {
  if (takePct <= 0 || takePct >= 1) return false;

  // Paper helper 는 live parent 를 절대 mutation 하지 않는다.
  // Live T1 partial take 는 executeLiveT1PartialTake 경로에서 실제 sell tx 로만 처리한다.
  if (pos.isLive === true) {
    if (config.kolHunterPartialTakeLiveEnabled === true) {
      log.error(
        `[${meta.logTag}_LIVE_PAPER_HELPER_BLOCKED] ${pos.positionId} live parent reached paper ` +
        `partial helper — wallet drift 방지 위해 helper mutation 차단.`
      );
    } else {
      log.debug(
        `[${meta.logTag}_PAPER_HELPER_ONLY] ${pos.positionId} live parent — paper partial helper skipped.`
      );
    }
    return false;
  }

  const lockedQuantity = pos.quantity * takePct;
  const lockedTicketSol = pos.ticketSol * takePct;
  const lockedNetPct = (currentPrice - pos.entryPrice) / pos.entryPrice;
  const lockedNetSol = lockedTicketSol * (lockedNetPct - config.kolHunterPaperRoundTripCostPct);

  // paper accounting: pos.quantity / ticketSol 축소 (잔여 runner)
  pos.quantity *= (1 - takePct);
  pos.ticketSol *= (1 - takePct);
  pos.partialTakeAtSec = pos.partialTakeAtSec ?? nowSec;
  if ((meta.partialKind ?? 't1_partial_take') === 't1_partial_take') {
    pos.partialTakeT1AtSec = nowSec;
  }
  // 2026-05-01 (codex F-A fix): close netSol 합산용 누적. 다중 partial 발화 시 누적 가능 (현 정책은
  //   1회만이지만, 향후 multi-tier partial 채택 시에도 정합).
  pos.partialTakeRealizedSol = (pos.partialTakeRealizedSol ?? 0) + lockedNetSol;
  pos.partialTakeLockedTicketSol = (pos.partialTakeLockedTicketSol ?? 0) + lockedTicketSol;

  log.info(
    `[${meta.logTag}] ${pos.positionId} mfe=${(mfePct * 100).toFixed(2)}% ` +
    `take=${(takePct * 100).toFixed(0)}% locked_qty=${lockedQuantity.toFixed(2)} ` +
    `locked_net=${(lockedNetPct * 100).toFixed(2)}% remaining_qty=${pos.quantity.toFixed(2)} ` +
      `mode=paper-shadow${meta.reason ? ` reason=${meta.reason}` : ''}`
  );
  trackPaperPositionMarkout(
    pos,
    'sell',
    currentPrice,
    lockedTicketSol,
    nowSec * 1000,
    {
      eventType: meta.eventType,
      exitReason: meta.reason ?? null,
      mfePctAtTake: mfePct,
      lockedQuantity,
      lockedTicketSol,
      lockedNetPct,
      lockedNetSol,
      remainingQuantity: pos.quantity,
      remainingTicketSol: pos.ticketSol,
      partialKind: meta.partialKind ?? 't1_partial_take',
    }
  );

  // Paper ledger 의 partial record 별도 jsonl entry — DSR / winner-kill 분석 시 partial 따로 cohort 가능.
  void appendPartialTakeLedger(
    pos,
    currentPrice,
    nowSec,
    mfePct,
    lockedQuantity,
    lockedTicketSol,
    lockedNetPct,
    lockedNetSol,
    meta.ledgerEventType,
    meta.reason,
    {
      partialKind: meta.partialKind ?? 't1_partial_take',
    }
  ).catch(() => {});
  return true;
}

/** Phase 2.A2 P0: partial take 별도 ledger jsonl writer. */
async function appendPartialTakeLedger(
  pos: PaperPosition,
  exitPrice: number,
  nowSec: number,
  mfePct: number,
  lockedQuantity: number,
  lockedTicketSol: number,
  lockedNetPct: number,
  lockedNetSol: number,
  eventType: string = 'partial_take',
  reason?: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    const dir = config.realtimeDataDir;
    await mkdir(dir, { recursive: true });
    const record = {
      positionId: pos.positionId,
      strategy: LANE_STRATEGY,
      tokenMint: pos.tokenMint,
      armName: pos.armName,
      parameterVersion: pos.parameterVersion,
      tokenDecimals: pos.tokenDecimals ?? null,
      tokenDecimalsSource: pos.tokenDecimalsSource ?? null,
      isShadowArm: pos.isShadowArm,
      isLive: pos.isLive ?? false,
      mode: pos.isLive === true ? 'live' : 'paper',
      eventType,
      reason: reason ?? null,
      promotedAt: new Date(nowSec * 1000).toISOString(),
      mfePctAtTake: mfePct,
      exitPrice,
      entryPrice: pos.entryPrice,
      lockedQuantity,
      lockedTicketSol,
      lockedNetPct,
      lockedNetSol,
      remainingQuantity: pos.quantity,
      remainingTicketSol: pos.ticketSol,
      partialTakeAtSec: pos.partialTakeAtSec ?? null,
      partialTakeT1AtSec: pos.partialTakeT1AtSec ?? null,
      ...extra,
    };
    await appendFile(path.join(dir, 'kol-partial-takes.jsonl'), JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    log.debug(`[KOL_HUNTER] partial take ledger append failed: ${String(err)}`);
  }
}

function spawnTailSubPosition(parent: PaperPosition, exitPrice: number, nowSec: number): void {
  const retainPct = config.kolHunterTailRetainPct;
  if (retainPct <= 0 || retainPct >= 1) return;
  // Phase D: live tail flag — paper 가 선행 활성 후 live 로 단계 승격.
  //   `kolHunterTailRetainEnabled=true` (paper) → spawn 자체는 가능
  //   `kolHunterTailRetainLiveEnabled=true` (live) → parent live 인 경우만 live tail
  //   parent 가 paper (isLive=false) 면 무조건 paper tail (live flag 무관)
  const liveTail = config.kolHunterTailRetainLiveEnabled === true && parent.isLive === true;
  const tailId = `${parent.positionId}-tail`;
  const tailQuantity = parent.quantity * retainPct;
  // 2026-05-01 (P1-1 fix): tail.ticketSol 은 quantity * exitPrice 의 SOL 가치 기준.
  //   이전 (parent.ticketSol * retainPct) 은 parent entry 시 ticketSol 기준이라 close 시점
  //   가격 변동분 미반영 → tail 의 entry notional 과 ticketSol 불일치.
  //   현재: ticketSol = tailQuantity * exitPrice → DSR / paper ledger 의 netPct 정합.
  const tailTicketSol = tailQuantity * exitPrice;
  const tail: PaperPosition = {
    ...parent,
    positionId: tailId,
    state: 'TAIL',
    quantity: tailQuantity,
    ticketSol: tailTicketSol,
    entryTimeSec: nowSec,
    peakPrice: exitPrice,
    troughPrice: exitPrice,
    entryPrice: exitPrice,  // tail 의 P&L 기준은 parent close price
    // 2026-05-01 (M3 fix — Codex 권고): tail 의 token-only / wallet-delta entry 도 close price 로 갱신.
    //   parent 값 spread 로 물려받으면 tail 측정이 parent entry 기반으로 오염.
    //   tail 은 parent close price = exitPrice 가 새 baseline. ATA rent 는 parent 가 이미 부담 → tail 은 0.
    entryPriceTokenOnly: exitPrice,
    entryPriceWalletDelta: exitPrice,
    ataRentSol: 0,
    swapInputSol: tailTicketSol,
    marketReferencePrice: exitPrice,
    isTailPosition: true,
    parentPositionId: parent.positionId,
    // Phase C paper: isShadowArm=true (wallet ledger 영향 0)
    // Phase D live:  isShadowArm=false (정상 wallet ledger), isLive=true (closeLivePosition 의 sell tx 사용)
    isShadowArm: !liveTail,
    isLive: liveTail,
    // live tail 의 dbTradeId — parent 와 동일 유지 (DB row 분리 안 함, ledger 정합만).
    //   parent close 시 closeTrade 가 이미 호출되어 status='CLOSED'.
    //   tail 의 close 는 jsonl ledger (kol-live-trades.jsonl) 만 추가, DB 미기록.
    //   walletDeltaComparator 는 sells - buys 단순 합산이라 partial sell 두 번도 정합.
    dbTradeId: liveTail ? undefined : parent.dbTradeId,
    // RUNNER state 의 timestamp 는 parent 와 분리 — tail 자체 새 lifecycle
    t1VisitAtSec: undefined,
    t2VisitAtSec: undefined,
    t3VisitAtSec: undefined,
    t2BreakevenLockPrice: undefined,
  };
  setActivePosition(tail);
  trackPaperPositionMarkout(
    tail,
    'buy',
    tail.entryPriceTokenOnly ?? tail.entryPrice,
    tail.swapInputSol ?? tail.ticketSol,
    nowSec * 1000,
    {
      eventType: liveTail ? 'live_tail_entry' : 'paper_tail_entry',
      parentPositionId: parent.positionId,
      retainPct,
    }
  );
  log.info(
    `[KOL_HUNTER_TAIL_SPAWN] ${tailId} parent=${parent.positionId} ` +
    `qty=${tail.quantity.toFixed(2)} retain=${(retainPct * 100).toFixed(0)}% ` +
    `exit=${exitPrice.toFixed(8)} maxHold=${config.kolHunterTailMaxHoldSec}s ` +
    `mode=${liveTail ? 'live' : 'paper-shadow'}`
  );
}

/**
 * Paper ledger writer (`kol-paper-trades.jsonl`).
 *
 * Cohort dimension policy (F7 verification, 2026-04-26):
 *  - paper Kelly P1 의 cohort 는 `lane × armName/(kolEntryReason)/(convictionLevel)` 로 sub-구분.
 *    `kol-paper-arm-report.ts` 가 이 ledger 를 직접 읽어 `${arm}/${kolEntryReason}/${conviction}`
 *    형태의 arm key 를 생성한다 (sub-arm).
 *  - **live 이전 시 필수**: kol_hunter 가 Stage 4 SCALE 로 승격하여 `executed-buys.jsonl` 을
 *    쓰게 되면, 그 ledger entry 에도 `armName` 에 entryReason/conviction 을 인코딩하거나
 *    별도 필드를 추가해야 lane-edge-controller P1 의 cohort 가 이 차원을 보존한다.
 *    (현재 P0/P1 cohort 는 laneName × armName × discoverySource 만 — entryReason 차원은
 *    armName 인코딩으로 흡수한다.)
 */
/**
 * Paper / live ledger 의 공통 record schema (2026-04-30 A1 refactor).
 * 두 ledger 모두 DSR validator 입력 schema 정합 — paper-only / live-only 5-7 필드만 분기로 추가.
 */
function buildKolBaseLedgerRecord(
  pos: PaperPosition,
  exitPrice: number,
  reason: CloseReason,
  holdSec: number,
  mfePct: number,
  maePct: number,
  netSol: number,
  netPct: number,
  // 2026-05-01 (Codex H1 — live ledger fix): token-only override.
  //   live close 시 exitPrice = actualExitPrice (wallet-delta = receivedSol/qty) 인데
  //   token-only metric 은 정책 trigger 가 본 시장가격 기준이어야 함.
  //   appendLiveLedger 가 별도 tokenMarketExitPrice 전달 → 여기서 override.
  //   paper 호출 시 미전달 → exitPrice 그대로 (paper 는 시장가 = wallet-delta 동일).
  tokenMarketExitPrice?: number,
  tokenMarketSoldQuantity?: number,
): Record<string, unknown> {
  // 2026-05-01 (Sprint X F3 fix): paper ledger 도 token-only / wallet-based 분리 표기.
  //   paper 는 ATA rent 없음 → 두 값 동일이지만 schema 일관성 + 후속 analyzer 의 코드 단순화.
  const tokenEntryRefP = pos.entryPriceTokenOnly && pos.entryPriceTokenOnly > 0
    ? pos.entryPriceTokenOnly
    : pos.marketReferencePrice;
  const walletEntryRefP = pos.entryPriceWalletDelta && pos.entryPriceWalletDelta > 0
    ? pos.entryPriceWalletDelta
    : pos.entryPrice;
  const mfePctPeakTokenOnlyP = tokenEntryRefP > 0
    ? (pos.peakPrice - tokenEntryRefP) / tokenEntryRefP
    : 0;
  const mfePctPeakWalletBasedP = walletEntryRefP > 0
    ? (pos.peakPrice - walletEntryRefP) / walletEntryRefP
    : 0;
  // 2026-05-01 (Sprint Z — Codex 권고): paper ledger 도 netPct/maePct/netSol token-only 분리.
  //   paper 는 ATA rent 없음 → 두 값 동일이지만 schema 정합 + analyzer 코드 단순화.
  const maePctTokenOnlyP = tokenEntryRefP > 0
    ? (pos.troughPrice - tokenEntryRefP) / tokenEntryRefP
    : 0;
  // 2026-05-01 (Codex F4 fix): partial take 시 token-only netPct 도 합산 정합.
  //   기존: `(exitPrice - tokenEntryRefP) / tokenEntryRefP` 가 runner 전용 → partial 합산 안 함 →
  //         winner/PnL 분석 underreport. close path 의 effectiveNetPct 와 동일 정합 적용.
  //   수정: partial realized SOL 합산 → effectiveTicketSol 기준 netPct 산출.
  // 2026-05-01 (Codex H1 — live ledger fix): live 의 경우 tokenMarketExitPrice 사용.
  //   live close: exitPrice = actualExitPrice (wallet-delta) 인데 token-only metric 은 시장가 기반이어야 함.
  //   appendLiveLedger 가 별도 tokenMarketExitPrice 전달 → 여기서 override.
  const tokenExitPriceForMetric = tokenMarketExitPrice && tokenMarketExitPrice > 0
    ? tokenMarketExitPrice
    : exitPrice;
  const tokenSoldQty = tokenMarketSoldQuantity && tokenMarketSoldQuantity > 0
    ? tokenMarketSoldQuantity
    : pos.quantity;
  const partialRealizedTokenOnlyP = pos.partialTakeRealizedSol ?? 0;
  const partialLockedTicketTokenOnlyP = pos.partialTakeLockedTicketSol ?? 0;
  const runnerNetSolTokenOnlyP = (tokenExitPriceForMetric - tokenEntryRefP) * tokenSoldQty;
  const netSolTokenOnlyP = runnerNetSolTokenOnlyP + partialRealizedTokenOnlyP;
  const effectiveTicketTokenOnlyP =
    (pos.ticketSol ?? 0) + partialLockedTicketTokenOnlyP;
  const netPctTokenOnlyP = effectiveTicketTokenOnlyP > 0
    ? netSolTokenOnlyP / effectiveTicketTokenOnlyP
    : (tokenEntryRefP > 0 ? (tokenExitPriceForMetric - tokenEntryRefP) / tokenEntryRefP : 0);
  const exitTimeSec = pos.entryTimeSec + holdSec;
  const smartV3CopyableEdge = buildSmartV3CopyableEdgeForClose({
    pos,
    walletNetSol: netSol,
    tokenOnlyNetSol: netSolTokenOnlyP,
  });
  const smartV3PreT1Telemetry = buildSmartV3PreT1CloseTelemetry(
    pos,
    tokenExitPriceForMetric,
    mfePct,
  );
  const excursionTelemetryRecord = buildExcursionTelemetryRecord(pos.excursionTelemetry, {
    reason,
    maePctAtClose: maePctTokenOnlyP,
    elapsedSec: holdSec,
  });
  return {
    positionId: pos.positionId,
    strategy: LANE_STRATEGY,
    tokenMint: pos.tokenMint,
    ticketSol: pos.ticketSol,
    openedAt: new Date(pos.entryTimeSec * 1000).toISOString(),
    entryTimeSec: pos.entryTimeSec,
    exitTimeSec,
    entryPrice: pos.entryPrice,
    entryPriceTokenOnly: pos.entryPriceTokenOnly,
    entryPriceWalletDelta: pos.entryPriceWalletDelta,
    ataRentSol: pos.ataRentSol,
    swapInputSol: pos.swapInputSol,
    exitPrice,
    exitPriceTokenOnly: tokenExitPriceForMetric,  // live 시 시장가 (override), paper 시 exitPrice (wallet-delta = 시장가)
    marketReferencePrice: pos.marketReferencePrice,
    peakPrice: pos.peakPrice,
    troughPrice: pos.troughPrice,
    // Common aliases used by lane-specific reports. Keep canonical fields above intact.
    maxPrice: pos.peakPrice,
    minPrice: pos.troughPrice,
    mfePct,
    mfePctPeak: mfePct,
    mfePctPeakTokenOnly: mfePctPeakTokenOnlyP,
    mfePctPeakWalletBased: mfePctPeakWalletBasedP,
    maePct,
    maePctTokenOnly: maePctTokenOnlyP,
    ...excursionTelemetryRecord,
    netPct,
    netPctTokenOnly: netPctTokenOnlyP,
    netSol,
    netSolTokenOnly: netSolTokenOnlyP,
    holdSec,
    exitReason: reason,
    t1VisitAtSec: pos.t1VisitAtSec ?? null,
    t2VisitAtSec: pos.t2VisitAtSec ?? null,
    t3VisitAtSec: pos.t3VisitAtSec ?? null,
    partialTakeAtSec: pos.partialTakeAtSec ?? null,
    partialTakeT1AtSec: pos.partialTakeT1AtSec ?? null,
    partialTakeT1LiveFailedAtSec: pos.partialTakeT1LiveFailedAtSec ?? null,
    partialTakeT1LiveFailureCount: pos.partialTakeT1LiveFailureCount ?? 0,
    kols: pos.participatingKols,
    participatingKols: pos.participatingKols,
    entryParticipatingKols: pos.participatingKols,
    kolScore: pos.kolScore,
    // MISSION_CONTROL §Control 5 telemetry — arm identity + discovery context + parameter trace.
    lane: LANE_STRATEGY,
    armName: pos.armName,
    parameterVersion: pos.parameterVersion,
    profileArm: pos.profileArm ?? null,
    entryArm: pos.entryArm ?? pos.armName,
    exitArm: pos.exitArm ?? pos.armName,
    isShadowArm: pos.isShadowArm,
    parentPositionId: pos.parentPositionId ?? null,
    entryReason: pos.kolEntryReason,
    kolEntryReason: pos.kolEntryReason,
    convictionLevel: pos.kolConvictionLevel,
    kolConvictionLevel: pos.kolConvictionLevel,
    kolReinforcementCount: pos.kolReinforcementCount,
    detectorVersion: pos.detectorVersion,
    independentKolCount: pos.independentKolCount,
    survivalFlags: pos.survivalFlags,
    isShadowKol: pos.isShadowKol ?? false,
    tokenDecimals: pos.tokenDecimals ?? null,
    tokenDecimalsSource: pos.tokenDecimalsSource ?? null,
    entrySecurityEvidence: pos.entrySecurityEvidence ?? null,
    entrySellQuoteEvidence: pos.entrySellQuoteEvidence ?? null,
    tokenSecurityKnown: pos.entrySecurityEvidence?.tokenSecurityKnown ?? null,
    tokenSecurityData: pos.entrySecurityEvidence?.tokenSecurityData ?? null,
    securityClientPresent: pos.entrySecurityEvidence?.securityClientPresent ?? null,
    sellRouteKnown: pos.entrySellQuoteEvidence?.routeFound === true ? true : null,
    routeFound: pos.entrySellQuoteEvidence?.routeFound ?? null,
    exitLiquidityKnown: pos.entrySecurityEvidence?.exitLiquidityKnown ?? null,
    exitLiquidityData: pos.entrySecurityEvidence?.exitLiquidityData ?? null,
    rotationMonetizableEdge: pos.rotationMonetizableEdge ?? null,
    rotationMonetizablePass: pos.rotationMonetizableEdge?.pass ?? null,
    rotationMonetizableCostRatio: pos.rotationMonetizableEdge?.costRatio ?? null,
    wouldLivePassExecutionGuard: pos.rotationMonetizableEdge?.pass ?? null,
    liveCostShadowReason: pos.rotationMonetizableEdge
      ? (pos.rotationMonetizableEdge.pass ? 'rotation_monetizable_edge_pass' : pos.rotationMonetizableEdge.reason)
      : null,
    executionGuardReason: pos.executionGuardReason ?? null,
    executionGuardAction: pos.executionGuardAction ?? null,
    capitulationTelemetry: pos.capitulationTelemetry ?? null,
    capitulationEntryLowPrice: pos.capitulationEntryLowPrice ?? null,
    capitulationEntryLowAtMs: pos.capitulationEntryLowAtMs ?? null,
    capitulationRecoveryConfirmations: pos.capitulationRecoveryConfirmations ?? null,
    rotationMaeFastFail: reason === 'rotation_mae_fast_fail',
    smartV3MaeFastFail: reason === 'smart_v3_mae_fast_fail',
    smartV3LiveEligibleShadow: pos.smartV3LiveEligibleShadow ?? null,
    smartV3LiveBlockReason: pos.smartV3LiveBlockReason ?? null,
    smartV3LiveBlockFlags: pos.smartV3LiveBlockFlags ?? null,
    smartV3LiveEligibilityEvaluatedAtMs: pos.smartV3LiveEligibilityEvaluatedAtMs ?? null,
    liveEquivalenceCandidateId: pos.liveEquivalenceCandidateId ?? null,
    liveEquivalenceDecisionStage: pos.liveEquivalenceDecisionStage ?? null,
    liveEquivalenceLiveWouldEnter: pos.liveEquivalenceLiveWouldEnter ?? null,
    liveEquivalenceLiveBlockReason: pos.liveEquivalenceLiveBlockReason ?? null,
    liveEquivalenceLiveBlockFlags: pos.liveEquivalenceLiveBlockFlags ?? null,
    smartV3EntryComboKey: pos.smartV3EntryComboKey ?? null,
    smartV3LiveHardCutReentry: pos.smartV3LiveHardCutReentry ?? false,
    smartV3HardCutParentPositionId: pos.smartV3HardCutParentPositionId ?? null,
    smartV3HardCutAtMs: pos.smartV3HardCutAtMs ?? null,
    smartV3HardCutEntryPrice: pos.smartV3HardCutEntryPrice ?? null,
    smartV3HardCutExitPrice: pos.smartV3HardCutExitPrice ?? null,
    smartV3HardCutDiscountPct: pos.smartV3HardCutDiscountPct ?? null,
    smartV3CopyableEdge,
    smartV3CopyablePass: smartV3CopyableEdge?.pass ?? null,
    smartV3CopyableNetSol: smartV3CopyableEdge?.copyableNetSol ?? null,
    smartV3CopyableNetPct: smartV3CopyableEdge?.copyableNetPct ?? null,
    smartV3CopyableRequiredGrossMovePct: smartV3CopyableEdge?.requiredGrossMovePct ?? null,
    smartV3MaeRecoveryHold: pos.smartV3MaeRecoveryHold ?? false,
    smartV3MaeRecoveryHoldAtSec: pos.smartV3MaeRecoveryHoldAtSec ?? null,
    smartV3MaeRecoveryHoldUntilSec: pos.smartV3MaeRecoveryHoldUntilSec ?? null,
    smartV3MaeRecoveryHoldReason: pos.smartV3MaeRecoveryHoldReason ?? null,
    smartV3MfeStage: pos.smartV3MfeStage ?? null,
    smartV3MfeStageUpdatedAtSec: pos.smartV3MfeStageUpdatedAtSec ?? null,
    smartV3ProfitFloorPct: pos.smartV3ProfitFloorPct ?? null,
    smartV3ProfitFloorPrice: pos.smartV3ProfitFloorPrice ?? null,
    smartV3ProfitFloorExit: reason === 'smart_v3_mfe_floor_exit' || pos.smartV3ProfitFloorExit === true,
    smartV3ProfitFloorExitAtSec: pos.smartV3ProfitFloorExitAtSec ?? null,
    smartV3ProfitFloorExitNetPct: pos.smartV3ProfitFloorExitNetPct ?? null,
    smartV3ProfitFloorExitStage: pos.smartV3ProfitFloorExitStage ?? pos.smartV3MfeStage ?? null,
    ...smartV3PreT1Telemetry,
    closedAt: new Date(exitTimeSec * 1000).toISOString(),
    extras: buildKolLedgerExtras(
      pos,
      exitPrice,
      reason,
      holdSec,
      mfePct,
      maePct,
      netSol,
      netPct,
      netSolTokenOnlyP,
      netPctTokenOnlyP,
      smartV3CopyableEdge,
      excursionTelemetryRecord,
      smartV3PreT1Telemetry,
    ),
  };
}

function buildKolLedgerExtras(
  pos: PaperPosition,
  exitPrice: number,
  reason: CloseReason,
  holdSec: number,
  mfePct: number,
  maePct: number,
  netSol: number,
  netPct: number,
  netSolTokenOnly?: number,
  netPctTokenOnly?: number,
  smartV3CopyableEdge?: SmartV3CopyableEdgeEstimate | null,
  excursionTelemetryRecord?: Record<string, number | null>,
  smartV3PreT1Telemetry?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    mode: pos.isLive === true ? 'live' : 'paper',
    positionId: pos.positionId,
    tokenMint: pos.tokenMint,
    armName: pos.armName,
    profileArm: pos.profileArm ?? null,
    entryArm: pos.entryArm ?? pos.armName,
    exitArm: pos.exitArm ?? pos.armName,
    entryReason: pos.kolEntryReason,
    convictionLevel: pos.kolConvictionLevel,
    parameterVersion: pos.parameterVersion,
    parentPositionId: pos.parentPositionId ?? null,
    isShadowArm: pos.isShadowArm,
    isShadowKol: pos.isShadowKol ?? false,
    isTailPosition: pos.isTailPosition ?? false,
    detectorVersion: pos.detectorVersion,
    independentKolCount: pos.independentKolCount,
    kolScore: pos.kolScore,
    participatingKols: pos.participatingKols,
    survivalFlags: pos.survivalFlags,
    entrySecurityEvidence: pos.entrySecurityEvidence ?? null,
    entrySellQuoteEvidence: pos.entrySellQuoteEvidence ?? null,
    tokenSecurityKnown: pos.entrySecurityEvidence?.tokenSecurityKnown ?? null,
    securityClientPresent: pos.entrySecurityEvidence?.securityClientPresent ?? null,
    sellRouteKnown: pos.entrySellQuoteEvidence?.routeFound === true ? true : null,
    routeFound: pos.entrySellQuoteEvidence?.routeFound ?? null,
    exitLiquidityKnown: pos.entrySecurityEvidence?.exitLiquidityKnown ?? null,
    exitLiquidityData: pos.entrySecurityEvidence?.exitLiquidityData ?? null,
    exitReason: reason,
    holdSec,
    mfePct,
    maePct,
    netSol,
    netPct,
    netSolTokenOnly: netSolTokenOnly ?? null,
    netPctTokenOnly: netPctTokenOnly ?? null,
    smartV3CopyableEdge: smartV3CopyableEdge ?? null,
    smartV3CopyablePass: smartV3CopyableEdge?.pass ?? null,
    smartV3LiveEligibleShadow: pos.smartV3LiveEligibleShadow ?? null,
    smartV3LiveBlockReason: pos.smartV3LiveBlockReason ?? null,
    smartV3LiveBlockFlags: pos.smartV3LiveBlockFlags ?? null,
    smartV3LiveEligibilityEvaluatedAtMs: pos.smartV3LiveEligibilityEvaluatedAtMs ?? null,
    liveEquivalenceCandidateId: pos.liveEquivalenceCandidateId ?? null,
    liveEquivalenceDecisionStage: pos.liveEquivalenceDecisionStage ?? null,
    liveEquivalenceLiveWouldEnter: pos.liveEquivalenceLiveWouldEnter ?? null,
    liveEquivalenceLiveBlockReason: pos.liveEquivalenceLiveBlockReason ?? null,
    liveEquivalenceLiveBlockFlags: pos.liveEquivalenceLiveBlockFlags ?? null,
    smartV3EntryComboKey: pos.smartV3EntryComboKey ?? null,
    smartV3LiveHardCutReentry: pos.smartV3LiveHardCutReentry ?? false,
    smartV3HardCutParentPositionId: pos.smartV3HardCutParentPositionId ?? null,
    smartV3HardCutAtMs: pos.smartV3HardCutAtMs ?? null,
    smartV3HardCutEntryPrice: pos.smartV3HardCutEntryPrice ?? null,
    smartV3HardCutExitPrice: pos.smartV3HardCutExitPrice ?? null,
    smartV3HardCutDiscountPct: pos.smartV3HardCutDiscountPct ?? null,
    smartV3MaeRecoveryHold: pos.smartV3MaeRecoveryHold ?? false,
    smartV3MaeRecoveryHoldAtSec: pos.smartV3MaeRecoveryHoldAtSec ?? null,
    smartV3MaeRecoveryHoldUntilSec: pos.smartV3MaeRecoveryHoldUntilSec ?? null,
    smartV3MaeRecoveryHoldReason: pos.smartV3MaeRecoveryHoldReason ?? null,
    smartV3MfeStage: pos.smartV3MfeStage ?? null,
    smartV3MfeStageUpdatedAtSec: pos.smartV3MfeStageUpdatedAtSec ?? null,
    smartV3ProfitFloorPct: pos.smartV3ProfitFloorPct ?? null,
    smartV3ProfitFloorPrice: pos.smartV3ProfitFloorPrice ?? null,
    smartV3ProfitFloorExit: reason === 'smart_v3_mfe_floor_exit' || pos.smartV3ProfitFloorExit === true,
    smartV3ProfitFloorExitAtSec: pos.smartV3ProfitFloorExitAtSec ?? null,
    smartV3ProfitFloorExitNetPct: pos.smartV3ProfitFloorExitNetPct ?? null,
    smartV3ProfitFloorExitStage: pos.smartV3ProfitFloorExitStage ?? pos.smartV3MfeStage ?? null,
    ...(smartV3PreT1Telemetry ?? {}),
    ...(excursionTelemetryRecord ?? {}),
    entryPrice: pos.entryPrice,
    exitPrice,
    maxPrice: pos.peakPrice,
    minPrice: pos.troughPrice,
    t1VisitAtSec: pos.t1VisitAtSec ?? null,
    t2VisitAtSec: pos.t2VisitAtSec ?? null,
    t3VisitAtSec: pos.t3VisitAtSec ?? null,
    t1MfeOverride: pos.t1MfeOverride ?? null,
    t1TrailPctOverride: pos.t1TrailPctOverride ?? null,
    t1ProfitFloorMult: pos.t1ProfitFloorMult ?? null,
    probeFlatTimeoutSec: pos.probeFlatTimeoutSec ?? null,
    probeHardCutPctOverride: pos.probeHardCutPctOverride ?? null,
    rotationDoaWindowSecOverride: pos.rotationDoaWindowSecOverride ?? null,
    rotationDoaMinMfePctOverride: pos.rotationDoaMinMfePctOverride ?? null,
    rotationDoaMaxMaePctOverride: pos.rotationDoaMaxMaePctOverride ?? null,
    rotationAnchorKols: pos.rotationAnchorKols ?? null,
    rotationEntryAtMs: pos.rotationEntryAtMs ?? null,
    rotationAnchorPrice: pos.rotationAnchorPrice ?? null,
    rotationAnchorPriceSource: pos.rotationAnchorPriceSource ?? null,
    rotationFirstBuyAtMs: pos.rotationFirstBuyAtMs ?? null,
    rotationLastBuyAtMs: pos.rotationLastBuyAtMs ?? null,
    rotationLastBuyAgeMs: pos.rotationLastBuyAgeMs ?? null,
    rotationScore: pos.rotationScore ?? null,
    underfillReferenceSolAmount: pos.underfillReferenceSolAmount ?? null,
    underfillReferenceTokenAmount: pos.underfillReferenceTokenAmount ?? null,
    underfillReferencePrice: rotationUnderfillReferencePriceFromTelemetry({
      underfillReferenceSolAmount: pos.underfillReferenceSolAmount,
      underfillReferenceTokenAmount: pos.underfillReferenceTokenAmount,
    } as RotationV1TriggerResult['telemetry']) ?? null,
    rotationFlowExitEnabled: pos.rotationFlowExitEnabled ?? false,
    rotationFlowMetrics: pos.rotationFlowMetrics ?? null,
    rotationFlowDecision: pos.rotationFlowDecision ?? null,
    rotationFlowReducedAtSec: pos.rotationFlowReducedAtSec ?? null,
    rotationFlowResidualUntilSec: pos.rotationFlowResidualUntilSec ?? null,
    rotationFlowLastReducePct: pos.rotationFlowLastReducePct ?? null,
    rotationMonetizableEdge: pos.rotationMonetizableEdge ?? null,
    wouldLivePassExecutionGuard: pos.rotationMonetizableEdge?.pass ?? null,
    liveCostShadowReason: pos.rotationMonetizableEdge
      ? (pos.rotationMonetizableEdge.pass ? 'rotation_monetizable_edge_pass' : pos.rotationMonetizableEdge.reason)
      : null,
    executionGuardReason: pos.executionGuardReason ?? null,
    executionGuardAction: pos.executionGuardAction ?? null,
    capitulationTelemetry: pos.capitulationTelemetry ?? null,
    capitulationEntryLowPrice: pos.capitulationEntryLowPrice ?? null,
    capitulationEntryLowAtMs: pos.capitulationEntryLowAtMs ?? null,
    capitulationRecoveryConfirmations: pos.capitulationRecoveryConfirmations ?? null,
    rotationMaeFastFail: reason === 'rotation_mae_fast_fail',
    smartV3MaeFastFail: reason === 'smart_v3_mae_fast_fail',
  };
}

type KolTradeProjectionMode = 'paper' | 'live';

function kolTradeProjectionFileName(pos: PaperPosition, mode: KolTradeProjectionMode): string | null {
  if (isCapitulationReboundPosition(pos)) {
    return mode === 'paper' ? 'capitulation-rebound-paper-trades.jsonl' : null;
  }
  if (isRotationFamilyMarkoutPosition(pos)) {
    return mode === 'paper' ? 'rotation-v1-paper-trades.jsonl' : 'rotation-v1-live-trades.jsonl';
  }
  if (isSmartV3Position(pos)) {
    return mode === 'paper' ? 'smart-v3-paper-trades.jsonl' : 'smart-v3-live-trades.jsonl';
  }
  return null;
}

async function appendKolTradeProjection(
  dir: string,
  pos: PaperPosition,
  mode: KolTradeProjectionMode,
  record: Record<string, unknown>
): Promise<void> {
  const fileName = kolTradeProjectionFileName(pos, mode);
  if (!fileName) return;
  try {
    await appendFile(path.join(dir, fileName), JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    log.debug(`[KOL_HUNTER] ${mode} lane projection append failed (${fileName}): ${String(err)}`);
  }
}

/**
 * 2026-05-01 (Decu Quality Layer Phase B.6): observe-only token quality record.
 * Entry 직후 fire-and-forget — RPC / IPFS 호출 0 (현 sprint 는 KOL 메타만 기록,
 * holder/vamp/fee 는 별도 worker 나 follow-up sprint 에서 enrich).
 *
 * critical path 영향 0 — caller 가 await 안 함.
 */
async function recordTokenQualityObservation(pos: PaperPosition): Promise<void> {
  if (!config.tokenQualityObserverEnabled) return;

  // 2026-05-01 (Helius Stream B PR 2A close-out, QA F3 fix): holder risk flag wiring.
  //   gateCache 에 cache 된 tokenSecurityData (entry 시 survival gate 가 호출) 에서 top1/5/10/HHI 추출 →
  //   computeHolderRiskFlags 로 4 flag 산출. RPC 신규 호출 0.
  //   acceptance ("token-quality records are not empty for KOL candidates") 충족 입력.
  //   exitability (EXIT_LIQUIDITY_UNKNOWN/POOL_NOT_PREWARMED) + dev/vamp/fee enrichment 는 PR 3+ follow-up.
  const cached = gateCache?.get(pos.tokenMint);
  const sec = cached?.tokenSecurityData;
  // 2026-05-02: dev-quality attribution. 현재 OnchainSecurity path 는 creatorAddress 를
  // 대부분 제공하지 않지만, Birdeye/security enrichment 가 주입한 경우에는 즉시 report join 가능.
  // devWallet 은 creatorAddress 우선, 없으면 ownerAddress fallback. 둘 다 entry trigger 가 아니라
  // observe-only label 이며 security/sell quote/drift guard 를 우회하지 않는다.
  const creatorAddress = sec?.creatorAddress;
  const devWallet = sec?.creatorAddress ?? sec?.ownerAddress;
  const operatorDevStatus = resolveDevStatus(devWallet ?? creatorAddress);
  const riskFlags: string[] = [];
  let top1HolderPct: number | undefined;
  let top5HolderPct: number | undefined;
  let top10HolderPct: number | undefined;
  let holderHhi: number | undefined;
  let holderCountApprox: number | undefined;
  if (sec) {
    top1HolderPct = sec.top1HolderPct;
    top5HolderPct = sec.top5HolderPct;
    top10HolderPct = sec.top10HolderPct;
    holderHhi = sec.holderHhi;
    holderCountApprox = sec.holderCountApprox;
    riskFlags.push(...computeHolderRiskFlags({
      top1HolderPct: sec.top1HolderPct,
      top5HolderPct: sec.top5HolderPct,
      top10HolderPct: sec.top10HolderPct,
      holderHhi: sec.holderHhi,
      sampleSize: sec.holderCountApprox ?? 0,
    }));
  } else {
    // Token-2022 cache 미적중 — provenance flag (Helius Stream B 의 7 flag 중 1개)
    riskFlags.push('NO_HELIUS_PROVENANCE');
  }

  // 2026-05-01 (Helius Stream X3 + X1): exitability evidence — EXIT_LIQUIDITY_UNKNOWN / POOL_NOT_PREWARMED.
  //   pool registry inject 됐으면 (initKolHunter 옵션) registry 조회 → poolRegistry input 채움.
  //   sellQuote evidence 는 별도 sprint (sellQuoteProbe 결과 cache 필요). 현재는 registry only.
  //   registry 미주입 / 미적중 시 default emit (X3 minimal mode).
  let knownPoolCount = 0;
  let primaryPool: string | undefined;
  if (heliusPoolRegistry) {
    try {
      const pairs = await heliusPoolRegistry.getTokenPairs(pos.tokenMint);
      knownPoolCount = pairs.length;
      primaryPool = pairs[0]?.pairAddress;
    } catch {
      // fail-open — registry 호출 실패 시 default emit
    }
  }
  const exitEvidence = joinExitabilityEvidence({
    poolRegistry: heliusPoolRegistry
      ? { knownPoolCount, primaryPool }
      : undefined,
  });
  for (const f of exitEvidence.riskFlags) {
    if (!riskFlags.includes(f)) riskFlags.push(f);
  }

  const record: TokenQualityRecord = {
    schemaVersion: 'token-quality/v1',
    tokenMint: pos.tokenMint,
    observedAt: new Date().toISOString(),
    creatorAddress,
    devWallet,
    operatorDevStatus,
    // Stream B holder enrichment
    top1HolderPct,
    top5HolderPct,
    top10HolderPct,
    holderHhi,
    holderCountApprox,
    riskFlags,
    observationContext: {
      armName: pos.armName,
      parameterVersion: pos.parameterVersion,
      isLive: pos.isLive ?? false,
      isShadowArm: pos.isShadowArm,
      positionId: pos.positionId,
      entryPrice: pos.entryPrice,
      ticketSol: pos.ticketSol,
    },
  };
  await appendTokenQualityObservation(record, {
    enabled: config.tokenQualityObserverEnabled,
    observationTtlHours: config.tokenQualityObservationTtlHours,
    outputFile: path.join(config.realtimeDataDir, 'token-quality-observations.jsonl'),
  });
}

async function appendPaperLedger(
  pos: PaperPosition,
  exitPrice: number,
  reason: CloseReason,
  holdSec: number,
  mfePct: number,
  maePct: number,
  netSol: number,
  netPct: number
): Promise<void> {
  try {
    const dir = config.realtimeDataDir;
    await mkdir(dir, { recursive: true });
    const exitRouteProof = await resolveRotationPaperCloseSellQuoteEvidence(pos);
    const exitSellQuoteEvidence = exitRouteProof.evidence;
    // paper-only 필드 (t1*Override / probeFlatTimeoutSec) 추가.
    const record = {
      ...buildKolBaseLedgerRecord(pos, exitPrice, reason, holdSec, mfePct, maePct, netSol, netPct),
      paperCloseWriterSchemaVersion: PAPER_CLOSE_WRITER_SCHEMA_VERSION,
      rotationExitRouteProofSchemaVersion: isRotationFamilyMarkoutPosition(pos)
        ? ROTATION_EXIT_ROUTE_PROOF_SCHEMA_VERSION
        : null,
      exitSellQuoteEvidence,
      exitRouteFound: exitSellQuoteEvidence?.routeFound ?? null,
      exitSellRouteKnown: exitSellQuoteEvidence?.routeFound === true
        ? true
        : exitSellQuoteEvidence?.routeFound === false
          ? false
          : null,
      exitRouteProofSkipReason: exitRouteProof.skipReason,
      exitRouteProofSkipDetail: exitRouteProof.skipDetail,
      t1MfeOverride: pos.t1MfeOverride ?? null,
      t1TrailPctOverride: pos.t1TrailPctOverride ?? null,
      t1ProfitFloorMult: pos.t1ProfitFloorMult ?? null,
      probeFlatTimeoutSec: pos.probeFlatTimeoutSec ?? null,
      probeHardCutPctOverride: pos.probeHardCutPctOverride ?? null,
      rotationDoaWindowSecOverride: pos.rotationDoaWindowSecOverride ?? null,
      rotationDoaMinMfePctOverride: pos.rotationDoaMinMfePctOverride ?? null,
      rotationDoaMaxMaePctOverride: pos.rotationDoaMaxMaePctOverride ?? null,
      rotationAnchorKols: pos.rotationAnchorKols ?? null,
      rotationEntryAtMs: pos.rotationEntryAtMs ?? null,
      rotationAnchorPrice: pos.rotationAnchorPrice ?? null,
      rotationAnchorPriceSource: pos.rotationAnchorPriceSource ?? null,
      rotationFirstBuyAtMs: pos.rotationFirstBuyAtMs ?? null,
      rotationLastBuyAtMs: pos.rotationLastBuyAtMs ?? null,
      rotationLastBuyAgeMs: pos.rotationLastBuyAgeMs ?? null,
      rotationScore: pos.rotationScore ?? null,
      underfillReferenceSolAmount: pos.underfillReferenceSolAmount ?? null,
      underfillReferenceTokenAmount: pos.underfillReferenceTokenAmount ?? null,
      rotationFlowExitEnabled: pos.rotationFlowExitEnabled ?? false,
      rotationFlowMetrics: pos.rotationFlowMetrics ?? null,
      rotationFlowDecision: pos.rotationFlowDecision ?? null,
      rotationFlowReducedAtSec: pos.rotationFlowReducedAtSec ?? null,
      rotationFlowResidualUntilSec: pos.rotationFlowResidualUntilSec ?? null,
      rotationFlowLastReducePct: pos.rotationFlowLastReducePct ?? null,
      rotationMonetizableEdge: pos.rotationMonetizableEdge ?? null,
      capitulationTelemetry: pos.capitulationTelemetry ?? null,
      capitulationEntryLowPrice: pos.capitulationEntryLowPrice ?? null,
      capitulationEntryLowAtMs: pos.capitulationEntryLowAtMs ?? null,
      capitulationRecoveryConfirmations: pos.capitulationRecoveryConfirmations ?? null,
      markoutOffsetsSec: tradeMarkoutOffsetsSecForPosition(pos),
    };
    // 2026-04-28: inactive KOL paper trade 결과는 별도 ledger 로 분리. active 분포 무결성 유지.
    const fileName = pos.isShadowKol
      ? config.kolShadowPaperTradesFileName
      : 'kol-paper-trades.jsonl';
    await appendFile(path.join(dir, fileName), JSON.stringify(record) + '\n', 'utf8');
    await appendKolTradeProjection(dir, pos, 'paper', record);
  } catch (err) {
    log.debug(`[KOL_HUNTER] paper ledger append failed: ${String(err)}`);
  }
}

async function resolveRotationPaperCloseSellQuoteEvidence(
  pos: PaperPosition
): Promise<KolExitRouteProofResult> {
  if (!isRotationFamilyMarkoutPosition(pos) || pos.isLive === true) {
    return { evidence: null, skipReason: null, skipDetail: null };
  }
  try {
    const result = await checkKolSellQuoteSized(
      pos.tokenMint,
      pos.quantity,
      pos.ticketSol,
      pos.tokenDecimals,
      'kol-exit-sell-quote/v1'
    );
    const evidence = result.evidence ?? null;
    return {
      evidence,
      skipReason: exitRouteProofSkipReasonForEvidence(evidence),
      skipDetail: result.reason ?? evidence?.reason ?? result.flags.join(',') ?? null,
    };
  } catch (err) {
    return {
      evidence: null,
      skipReason: 'exit_route_proof_exception',
      skipDetail: String(err).slice(0, 160),
    };
  }
}

function exitRouteProofSkipReasonForEvidence(
  evidence: KolEntrySellQuoteEvidence | null
): KolExitRouteProofSkipReason | null {
  if (!evidence) return 'exit_route_proof_missing_evidence';
  if (!evidence.probeEnabled) return 'sell_quote_probe_disabled';
  if (evidence.reason === 'invalid_quantity') return 'invalid_quantity';
  if (evidence.reason === 'sell_quote_error' || evidence.quoteFailed === true) return 'sell_quote_error';
  if (evidence.routeFound == null) return 'route_found_unknown';
  return null;
}

/**
 * Live ledger writer (`kol-live-trades.jsonl`).
 *
 * 2026-04-30 (Sprint 1.B3): live trade 의 trade-level outcome 을 jsonl 로 기록.
 * Why: DSR validator (scripts/dsr-validator.ts) 가 paper-trades.jsonl 만 분석하던 한계 해소.
 *      live trades 는 wallet ground truth 기반이라 statistical validation 의 핵심 데이터.
 *      executed-buys/sells.jsonl 와는 별개 — 저쪽은 ledger integrity, 이쪽은 DSR 입력.
 * record format: paper ledger 와 호환 (DSR validator 가 동일 schema 로 처리 가능).
 */
async function appendLiveLedger(
  pos: PaperPosition,
  exitPrice: number,
  reason: CloseReason,
  holdSec: number,
  mfePct: number,
  maePct: number,
  netSol: number,
  netPct: number,
  exitTxSignature?: string,
  // 2026-05-01 (Codex H1 fix): token-only metric 은 시장가 (정책 trigger 가 본 가격) 기반.
  //   exitPrice (= actualExitPrice = receivedSol/qty wallet-delta) 와 분리.
  tokenMarketExitPrice?: number,
  tokenMarketSoldQuantity?: number,
  liveSellTelemetry?: {
    sellRetryUrgency: LiveSellRetryUrgency;
    sellRetryAttempts: number | null;
    sellRecoveredFromBalanceOnly: boolean | null;
    sellRetrySoldRatio: number | null;
    exitRequestedAtMs?: number;
    exitCompletedAtMs?: number;
    exitLatencyMs?: number;
    holdSecReal?: number;
  },
): Promise<void> {
  try {
    const dir = config.realtimeDataDir;
    await mkdir(dir, { recursive: true });
    // live-only 필드 (isLive / dbTradeId / tx signatures / ticketSol) 추가.
    const record = {
      ...buildKolBaseLedgerRecord(
        pos, exitPrice, reason, holdSec, mfePct, maePct, netSol, netPct,
        tokenMarketExitPrice, tokenMarketSoldQuantity
      ),
      isLive: true,
      dbTradeId: pos.dbTradeId ?? null,
      entryTxSignature: pos.entryTxSignature ?? null,
      exitTxSignature: exitTxSignature ?? null,
      ticketSol: pos.ticketSol,
      canaryLane: pos.canaryLane ?? null,
      sellRetryUrgency: liveSellTelemetry?.sellRetryUrgency ?? null,
      sellRetryAttempts: liveSellTelemetry?.sellRetryAttempts ?? null,
      sellRecoveredFromBalanceOnly: liveSellTelemetry?.sellRecoveredFromBalanceOnly ?? null,
      sellRetrySoldRatio: liveSellTelemetry?.sellRetrySoldRatio ?? null,
      exitRequestedAtMs: liveSellTelemetry?.exitRequestedAtMs ?? null,
      exitCompletedAtMs: liveSellTelemetry?.exitCompletedAtMs ?? null,
      exitLatencyMs: liveSellTelemetry?.exitLatencyMs ?? null,
      holdSecReal: liveSellTelemetry?.holdSecReal ?? holdSec,
    };
    await appendFile(path.join(dir, 'kol-live-trades.jsonl'), JSON.stringify(record) + '\n', 'utf8');
    await appendKolTradeProjection(dir, pos, 'live', record);
  } catch (err) {
    log.debug(`[KOL_HUNTER] live ledger append failed: ${String(err)}`);
  }
}

// ─── Live canary entry / close (Phase 5 P1-9~14, 2026-04-27) ─────────
// pure_ws live path 와 동일 패턴. Real Asset Guard, canary slot, DB persist, ledger 정합.
// triple-flag gate 통과 시에만 실행 (isLiveCanaryActive() in resolveStalk).

async function enterLivePosition(
  tokenMint: string,
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  survivalFlags: string[],
  ctx: BotContext,
  options: PaperEntryOptions = {}
): Promise<void> {
  const canaryLane = kolHunterCanaryLaneForOptions(options);
  if (!priceFeed) {
    log.warn(`[KOL_HUNTER_LIVE] priceFeed not initialized — fallback paper`);
    await enterPaperPosition(tokenMint, cand, score, survivalFlags, options);
    return;
  }

  // 2026-04-28 P0-2A inflight dedup: 동일 mint 동시 signal 시 enterLivePosition 2회 진입 차단.
  // executeBuy 2회 + DB duplicate row 위험 방지. pure_ws/cupsey 동일 패턴.
  if (inflightLiveEntry.has(tokenMint)) {
    log.debug(`[KOL_HUNTER_LIVE] inflight entry already in progress for ${tokenMint.slice(0, 12)} — skip`);
    return;
  }
  inflightLiveEntry.add(tokenMint);

  try {
  // 1. Entry reference price — paper feed 와 동일 (Jupiter probe quote).
  priceFeed.subscribe(tokenMint);
  // PaperPriceFeed 는 subscribe 시 즉시 1회 poll 한다. 캐시 hit 은 즉시 반환.
  // Periodic poll 은 기본 8s 로 유지해 paper feed 가 Jupiter budget 을 점유하지 않게 한다.
  const firstTick = await waitForFirstTick(tokenMint, 5_000);
  if (firstTick === null) {
    unsubscribePriceIfIdle(tokenMint);
    log.warn(`[KOL_HUNTER_LIVE] entry price timeout ${tokenMint.slice(0, 8)} — reject`);
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
      survivalReason: 'live_price_timeout',
      survivalFlags: ['LIVE_PRICE_TIMEOUT'],
    });
    return;
  }
  const freshReferenceCheck = await refreshLiveEntryReference(tokenMint, firstTick);
  if (freshReferenceCheck.rejected) {
    const reason = freshReferenceCheck.reason ?? 'live_fresh_reference_reject';
    const policyFlags = [
      ...survivalFlags,
      'LIVE_FRESH_REFERENCE_REJECT',
      reason.toUpperCase(),
    ];
    log.warn(
      `[KOL_HUNTER_LIVE_FRESH_REFERENCE_REJECT] ${tokenMint.slice(0, 8)} ${reason}. fallback paper.`
    );
    const decimals = freshReferenceCheck.tick.outputDecimals ?? firstTick.outputDecimals ?? undefined;
    emitKolLiveFallbackPolicy(tokenMint, score, policyFlags, {
      entryReason: options.entryReason,
      armName: options.parameterVersion ? armNameForVersion(options.parameterVersion) : undefined,
    });
    await enterPaperPosition(tokenMint, cand, score, policyFlags, {
      ...options,
      ...(
        options.liveEquivalenceCandidateId
          ? buildLiveEquivalenceOptionPatch({
              candidateId: options.liveEquivalenceCandidateId,
              stage: 'live_fresh_reference_reject',
              liveWouldEnter: false,
              reason,
              flags: policyFlags,
            })
          : {}
      ),
      tokenDecimals: options.tokenDecimals ?? decimals,
      tokenDecimalsSource: options.tokenDecimalsSource ?? (decimals == null ? undefined : 'jupiter_quote'),
      smartV3LiveEligibleShadow: options.smartV3LiveEligibleShadow === true ? false : options.smartV3LiveEligibleShadow,
      smartV3LiveBlockReason: options.smartV3LiveEligibleShadow === true
        ? 'live_fresh_reference_reject'
        : options.smartV3LiveBlockReason,
      smartV3LiveBlockFlags: options.smartV3LiveEligibleShadow === true
        ? Array.from(new Set([...(options.smartV3LiveBlockFlags ?? []), 'LIVE_FRESH_REFERENCE_REJECT', reason.toUpperCase()]))
        : options.smartV3LiveBlockFlags,
      smartV3LiveEligibilityEvaluatedAtMs: options.smartV3LiveEligibleShadow === true
        ? Date.now()
        : options.smartV3LiveEligibilityEvaluatedAtMs,
      skipPolicyEntry: true,
    });
    return;
  }
  const referenceTick = freshReferenceCheck.tick;
  const referencePrice = referenceTick.price;
  const referenceResolvedAtMs = Date.now();
  const referenceAgeMs = Math.max(0, referenceResolvedAtMs - referenceTick.timestamp);
  const signalToReferenceMs = Number.isFinite(cand.firstKolEntryMs)
    ? Math.max(0, referenceResolvedAtMs - cand.firstKolEntryMs)
    : undefined;
  const rotationUnderfillPretradeGuard = rotationUnderfillLivePretradeGuard(referencePrice, options);
  if (rotationUnderfillPretradeGuard) {
    const reason = rotationUnderfillPretradeGuard.reason;
    const policyFlags = [
      ...survivalFlags,
      'ROTATION_UNDERFILL_LIVE_PRETRADE_REJECT',
      reason.toUpperCase(),
    ];
    log.warn(
      `[KOL_HUNTER_ROTATION_UNDERFILL_LIVE_PRETRADE_REJECT] ${tokenMint.slice(0, 8)} ` +
      `${reason} liveRef=${referencePrice.toFixed(10)} ` +
      `kolRef=${rotationUnderfillPretradeGuard.referencePrice?.toFixed(10) ?? 'n/a'} ` +
      `discount=${rotationUnderfillPretradeGuard.discountPct != null
        ? (rotationUnderfillPretradeGuard.discountPct * 100).toFixed(2)
        : 'n/a'}% — fallback paper`
    );
    const decimals = referenceTick.outputDecimals ?? firstTick.outputDecimals ?? undefined;
    emitKolLiveFallbackPolicy(tokenMint, score, policyFlags, {
      entryReason: options.entryReason,
      armName: options.parameterVersion ? armNameForVersion(options.parameterVersion) : undefined,
    });
    await enterPaperPosition(tokenMint, cand, score, policyFlags, {
      ...options,
      ...(
        options.liveEquivalenceCandidateId
          ? buildLiveEquivalenceOptionPatch({
              candidateId: options.liveEquivalenceCandidateId,
              stage: 'rotation_underfill_live_fallback',
              liveWouldEnter: false,
              reason,
              flags: policyFlags,
            })
          : {}
      ),
      tokenDecimals: options.tokenDecimals ?? decimals,
      tokenDecimalsSource: options.tokenDecimalsSource ?? (decimals == null ? undefined : 'jupiter_quote'),
      executionGuardReason: reason,
      executionGuardAction: 'pretrade_reject',
      skipPolicyEntry: true,
    });
    unsubscribePriceIfIdle(tokenMint);
    return;
  }
  const entryParticipatingKols = options.entryParticipatingKols ?? score.participatingKols;
  const entryKolScore = options.entryKolScore ?? score.finalScore;
  const entryIndependentKolCount = options.entryIndependentKolCount ?? score.independentKolCount;
  const ticketSol = config.kolHunterTicketSol;
  const plannedQty = referencePrice > 0 ? ticketSol / referencePrice : 0;
  if (plannedQty <= 0) {
    unsubscribePriceIfIdle(tokenMint);
    return;
  }
  const liveEntryTokenDecimals = typeof options.tokenDecimals === 'number'
    ? options.tokenDecimals
    : referenceTick.outputDecimals ?? undefined;
  const liveSellSized = await checkKolSellQuoteSized(
    tokenMint,
    plannedQty,
    ticketSol,
    liveEntryTokenDecimals,
  );
  const liveSurvivalFlags = [
    ...survivalFlags,
    ...liveSellSized.flags,
  ];
  if (!liveSellSized.approved) {
    unsubscribePriceIfIdle(tokenMint);
    log.warn(
      `[KOL_HUNTER_LIVE_SELL_REJECT] ${tokenMint.slice(0, 8)} qty=${plannedQty.toFixed(2)} ` +
      `ticket=${ticketSol}SOL reason=${liveSellSized.reason ?? 'unknown'} ` +
      `flags=${liveSellSized.flags.join(',')}`
    );
    fireRejectObserver(tokenMint, 'stalk_expired_no_consensus', cand, score, {
      survivalReason: liveSellSized.reason ?? null,
      survivalFlags: liveSurvivalFlags,
      plannedQuantity: plannedQty,
      ticketSol,
      entryPrice: referencePrice,
      entryReason: options.entryReason,
      parameterVersion: options.parameterVersion,
      liveSellQuoteSized: true,
    });
    return;
  }

  // 2. Real Asset Guard — global canary slot.
  if (!acquireCanarySlot(canaryLane)) {
    log.debug(`[KOL_HUNTER_LIVE] canary slot full lane=${canaryLane} — defer ${tokenMint.slice(0, 8)}`);
    unsubscribePriceIfIdle(tokenMint);
    return;
  }
  let smartV3HardCutReentryAttempting = false;
  if (options.smartV3LiveHardCutReentry) {
    smartV3HardCutReentryAttempting = beginSmartV3LiveHardCutReentryAttempt(
      tokenMint,
      options.smartV3HardCutParentPositionId
    );
    if (!smartV3HardCutReentryAttempting) {
      log.warn(
        `[KOL_HUNTER_SMART_V3_HARDCUT_REENTRY_INFLIGHT_BLOCK] ${tokenMint.slice(0, 8)} ` +
        `parent=${options.smartV3HardCutParentPositionId ?? 'unknown'} — skip duplicate live buy`
      );
      releaseCanarySlot(canaryLane);
      unsubscribePriceIfIdle(tokenMint);
      return;
    }
  }

  // 3. executeBuy.
  let actualEntryPrice = referencePrice;
  let actualQuantity = plannedQty;
  let actualNotionalSol = referencePrice * plannedQty;  // 2026-04-29: RPC 측정 wallet delta (sendTradeOpen 전파)
  let entryTxSignature = 'KOL_LIVE_PENDING';
  let entrySlippageBps = 0;
  let partialFillDataMissing = false;
  let partialFillDataReason: PartialFillDataReason | undefined;
  let expectedInAmount: string | undefined;
  let actualInputAmount: string | undefined;
  let actualInputUiAmount: number | undefined;
  let inputDecimals: number | undefined;
  let expectedOutAmount: string | undefined;
  let actualOutAmount: string | undefined;
  let actualOutUiAmount: number | undefined;
  let outputDecimals: number | undefined;
  // 2026-05-01 (Sprint X): cost decomposition + token-only entry price.
  let swapInputUiAmount: number | undefined;
  let walletInputUiAmount: number | undefined;
  let ataRentSol: number | undefined;
  let networkFeeSol: number | undefined;
  let jitoTipSol: number | undefined;
  let entryPriceTokenOnly: number | undefined;
  let entryPriceWalletDelta: number | undefined;
  let entryFillOutputRatio: number | undefined;
  let swapQuoteEntryPrice: number | undefined;
  let swapQuoteEntryAdvantagePct: number | undefined;
  let referenceToSwapQuotePct: number | undefined;
  let entryAdvantageReason: string | null = null;
  let executionGuardReason: string | null = null;
  let executionGuardAction: PaperPosition['executionGuardAction'] = null;
  const nowSec = Math.floor(Date.now() / 1000);
  const positionId = `kolh-live-${tokenMint.slice(0, 8)}-${nowSec}`;
  const buyStartedAtMs = Date.now();
  let buyCompletedAtMs = buyStartedAtMs;
  let buyExecutionMs = 0;

  try {
    const buyExecutor = getKolHunterExecutor(ctx);
    const order: Order = {
      pairAddress: tokenMint,
      strategy: LANE_STRATEGY,
      side: 'BUY',
      price: referencePrice,
      quantity: plannedQty,
      stopLoss: referencePrice * (1 - config.kolHunterHardcutPct),
      takeProfit1: referencePrice * (1 + config.kolHunterT1Mfe),
      takeProfit2: referencePrice * (1 + config.kolHunterT2Mfe),
      timeStopMinutes: Math.ceil(config.kolHunterStalkWindowSec / 60),
    };
    const buyResult = await buyExecutor.executeBuy(order);
    const metrics = resolveActualEntryMetrics(order, buyResult);
    expectedInAmount = buyResult.expectedInAmount?.toString();
    actualInputAmount = buyResult.actualInputAmount?.toString();
    actualInputUiAmount = buyResult.actualInputUiAmount;
    inputDecimals = buyResult.inputDecimals;
    expectedOutAmount = buyResult.expectedOutAmount?.toString();
    actualOutAmount = buyResult.actualOutAmount?.toString();
    actualOutUiAmount = buyResult.actualOutUiAmount;
    outputDecimals = buyResult.outputDecimals;
    // 2026-05-01 (Sprint X): cost decomposition 전파 + token-only entry price 산출.
    swapInputUiAmount = buyResult.swapInputUiAmount;
    walletInputUiAmount = buyResult.walletInputUiAmount;
    ataRentSol = buyResult.ataRentSol;
    networkFeeSol = buyResult.networkFeeSol;
    jitoTipSol = buyResult.jitoTipSol;
    if (
      typeof buyResult.swapInputUiAmount === 'number' &&
      typeof buyResult.actualOutUiAmount === 'number' &&
      buyResult.actualOutUiAmount > 0 &&
      buyResult.swapInputUiAmount > 0
    ) {
      entryPriceTokenOnly = buyResult.swapInputUiAmount / buyResult.actualOutUiAmount;
    }
    if (
      typeof buyResult.walletInputUiAmount === 'number' &&
      typeof buyResult.actualOutUiAmount === 'number' &&
      buyResult.actualOutUiAmount > 0 &&
      buyResult.walletInputUiAmount > 0
    ) {
      entryPriceWalletDelta = buyResult.walletInputUiAmount / buyResult.actualOutUiAmount;
    }
    if (
      buyResult.actualOutAmount != null &&
      buyResult.expectedOutAmount != null &&
      buyResult.expectedOutAmount > 0n
    ) {
      entryFillOutputRatio = Number(buyResult.actualOutAmount) / Number(buyResult.expectedOutAmount);
    } else if (
      typeof buyResult.actualInputUiAmount === 'number' &&
      typeof buyResult.actualOutUiAmount === 'number' &&
      referencePrice > 0
    ) {
      const expectedQtyFromInput = buyResult.actualInputUiAmount / referencePrice;
      if (expectedQtyFromInput > 0) entryFillOutputRatio = buyResult.actualOutUiAmount / expectedQtyFromInput;
    }
    actualEntryPrice = metrics.entryPrice;
    actualQuantity = metrics.quantity;
    actualNotionalSol = metrics.actualEntryNotionalSol;
    if (
      buyResult.expectedInAmount != null &&
      buyResult.expectedOutAmount != null &&
      typeof inputDecimals === 'number' &&
      typeof outputDecimals === 'number' &&
      buyResult.expectedOutAmount > 0n
    ) {
      const expectedInUi = Number(buyResult.expectedInAmount) / Math.pow(10, inputDecimals);
      const expectedOutUi = Number(buyResult.expectedOutAmount) / Math.pow(10, outputDecimals);
      if (Number.isFinite(expectedInUi) && Number.isFinite(expectedOutUi) && expectedOutUi > 0) {
        swapQuoteEntryPrice = expectedInUi / expectedOutUi;
        referenceToSwapQuotePct = referencePrice > 0 ? swapQuoteEntryPrice / referencePrice - 1 : undefined;
        swapQuoteEntryAdvantagePct = actualEntryPrice > 0 ? actualEntryPrice / swapQuoteEntryPrice - 1 : undefined;
      }
    }
    entryTxSignature = buyResult.txSignature;
    entrySlippageBps = buyResult.slippageBps;
    if (smartV3HardCutReentryAttempting) {
      completeSmartV3LiveHardCutReentryAttempt(tokenMint, options.smartV3HardCutParentPositionId);
      smartV3HardCutReentryAttempting = false;
    }
    partialFillDataMissing = metrics.partialFillDataMissing;
    partialFillDataReason = metrics.partialFillDataReason;
    buyCompletedAtMs = Date.now();
    buyExecutionMs = buyCompletedAtMs - buyStartedAtMs;
    const qualityReasons: string[] = [];
    if (partialFillDataMissing) qualityReasons.push(partialFillDataReason ?? 'partial_fill_data_missing');
    entryAdvantageReason = liveExecutionQualityEntryAdvantageReason(referencePrice, actualEntryPrice);
    if (entryAdvantageReason) qualityReasons.push(entryAdvantageReason);
    if (
      config.kolHunterLiveExecutionQualityMaxBuyLagMs > 0 &&
      buyExecutionMs >= config.kolHunterLiveExecutionQualityMaxBuyLagMs
    ) {
      qualityReasons.push(`buy_execution_ms=${buyExecutionMs}`);
    }
    if (qualityReasons.length > 0) {
      markLiveExecutionQualityCooldown(tokenMint, qualityReasons.join('+'));
    }
    if (options.parameterVersion === config.kolHunterRotationUnderfillParameterVersion) {
      const underfillReferencePrice = rotationUnderfillReferencePriceFromOptions(options);
      if (underfillReferencePrice != null && underfillReferencePrice > 0) {
        const tokenOnlyEntryForDiscount = entryPriceTokenOnly ?? actualEntryPrice;
        const actualDiscountPct = 1 - tokenOnlyEntryForDiscount / underfillReferencePrice;
        if (actualDiscountPct < config.kolHunterRotationUnderfillMinDiscountPct) {
          const reason = `rotation_underfill_actual_discount_pct=${actualDiscountPct.toFixed(4)}`;
          markLiveExecutionQualityCooldown(tokenMint, reason);
          executionGuardReason = reason;
          executionGuardAction = 'telemetry_only';
          log.warn(
            `[KOL_HUNTER_ROTATION_UNDERFILL_ACTUAL_DISCOUNT_WARN] ${positionId} ` +
            `${reason} tokenOnlyEntry=${tokenOnlyEntryForDiscount.toFixed(10)} ` +
            `kolRef=${underfillReferencePrice.toFixed(10)} — telemetry only`
          );
        }
      }
    }
    log.info(
      `[KOL_HUNTER_LIVE_BUY] ${positionId} sig=${entryTxSignature.slice(0, 12)} ` +
      `slip=${entrySlippageBps}bps qty=${actualQuantity.toFixed(2)} buyMs=${buyExecutionMs}`
    );
  } catch (buyErr) {
    log.warn(`[KOL_HUNTER_LIVE_BUY] ${positionId} buy failed: ${buyErr}`);
    if (smartV3HardCutReentryAttempting) {
      releaseSmartV3LiveHardCutReentryAttempt(tokenMint, options.smartV3HardCutParentPositionId);
    }
    releaseCanarySlot(canaryLane);
    unsubscribePriceIfIdle(tokenMint);
    return;
  }

  // 4. DB persist (entryIntegrity halt 보호).
  const persistResult = await persistOpenTradeWithIntegrity({
    ctx,
    lane: canaryLane,
    tradeData: {
      pairAddress: tokenMint,
      strategy: LANE_STRATEGY,
      side: 'BUY',
      sourceLabel: `kol_hunter:${entryParticipatingKols.map((k) => k.id).join(',')}`,
      discoverySource: 'kol_discovery_v1',
      entryPrice: actualEntryPrice,
      plannedEntryPrice: referencePrice,
      quantity: actualQuantity,
      stopLoss: actualEntryPrice * (1 - config.kolHunterHardcutPct),
      takeProfit1: actualEntryPrice * (1 + config.kolHunterT1Mfe),
      takeProfit2: actualEntryPrice * (1 + config.kolHunterT2Mfe),
      trailingStop: undefined,
      highWaterMark: actualEntryPrice,
      timeStopAt: new Date((nowSec + config.kolHunterStalkWindowSec) * 1000),
      status: 'OPEN',
      txSignature: entryTxSignature,
      createdAt: new Date(nowSec * 1000),
      entrySlippageBps,
    },
    ledgerEntry: {
      signalId: positionId,
      positionId,
      txSignature: entryTxSignature,
      strategy: LANE_STRATEGY,
      wallet: 'main',
      pairAddress: tokenMint,
      plannedEntryPrice: referencePrice,
      actualEntryPrice,
      actualQuantity,
      expectedInAmount,
      actualInputAmount,
      actualInputUiAmount,
      inputDecimals,
      expectedOutAmount,
      actualOutAmount,
      actualOutUiAmount,
      outputDecimals,
      entryFillOutputRatio,
      swapQuoteEntryPrice,
      swapQuoteEntryAdvantagePct,
      referenceToSwapQuotePct,
      // 2026-05-01 (Sprint X measurement-only): cost decomposition + token-only entry price.
      swapInputUiAmount,
      walletInputUiAmount,
      ataRentSol,
      networkFeeSol,
      jitoTipSol,
      entryPriceTokenOnly,
      entryPriceWalletDelta,
      initialReferencePrice: firstTick.price,
      initialReferenceTimestampMs: firstTick.timestamp,
      freshReferencePrice: referenceTick.price,
      freshReferenceTimestampMs: referenceTick.timestamp,
      initialToFreshReferencePct: freshReferenceCheck.initialToFreshReferencePct,
      freshReferenceGuardEnabled: config.kolHunterLiveFreshReferenceGuardEnabled,
      referencePriceTimestampMs: referenceTick.timestamp,
      referenceResolvedAtMs,
      referenceAgeMs,
      signalToReferenceMs,
      executionGuardReason,
      executionGuardAction,
      buyStartedAtMs,
      buyCompletedAtMs,
      buyExecutionMs,
      slippageBps: entrySlippageBps,
      signalTimeSec: nowSec,
      signalPrice: referencePrice,
      partialFillDataMissing,
      partialFillDataReason,
      kolScore: entryKolScore,
      independentKolCount: entryIndependentKolCount,
      entryReason: options.entryReason,
      parameterVersion: options.parameterVersion,
      profileArm: options.profileArm ?? null,
      entryArm: options.entryArm ?? null,
      exitArm: options.exitArm ?? null,
      canaryLane,
      rotationAnchorKols: options.rotationAnchorKols ?? null,
      rotationAnchorPrice: options.rotationAnchorPrice ?? null,
      rotationFirstBuyAtMs: options.rotationFirstBuyAtMs ?? null,
      rotationLastBuyAtMs: options.rotationLastBuyAtMs ?? null,
      rotationLastBuyAgeMs: options.rotationLastBuyAgeMs ?? null,
      rotationScore: options.rotationScore ?? null,
      underfillReferenceSolAmount: options.underfillReferenceSolAmount ?? null,
      underfillReferenceTokenAmount: options.underfillReferenceTokenAmount ?? null,
      underfillReferencePrice: rotationUnderfillReferencePriceFromTelemetry(options.rotationTelemetry) ?? null,
      rotationFlowExitEnabled: options.rotationFlowExitEnabled ?? false,
      smartV3LiveHardCutReentry: options.smartV3LiveHardCutReentry ?? false,
      smartV3HardCutParentPositionId: options.smartV3HardCutParentPositionId ?? null,
      smartV3HardCutAtMs: options.smartV3HardCutAtMs ?? null,
      smartV3HardCutEntryPrice: options.smartV3HardCutEntryPrice ?? null,
      smartV3HardCutExitPrice: options.smartV3HardCutExitPrice ?? null,
      smartV3HardCutDiscountPct: options.smartV3HardCutDiscountPct ?? null,
    },
    notifierKey: 'kol_live_open_persist',
    buildNotifierMessage: (err) =>
      `${positionId} kol live buy persisted FAILED after tx=${entryTxSignature}: ${err} — NEW POSITIONS HALTED.`,
  });

  // 5. Build PaperPosition (with isLive=true).
  // 2026-04-28 fix: smart-v3 / swing-v2 main path 의 live wiring 을 위해 caller 가 전달한
  // options (paramVersion / entryReason / conviction / tokenDecimals) 사용. 옵션 미주입 시 v1
  // fallback default 유지 (기존 동작과 동일).
  const primaryVersion = options.parameterVersion ?? config.kolHunterParameterVersion;
  const armName = armNameForVersion(primaryVersion);
  const entryReason = options.entryReason ?? defaultEntryReasonForVersion(primaryVersion);
  const conviction = options.convictionLevel ?? defaultConvictionForVersion(primaryVersion);
  const dynamicExit = dynamicExitParamsForPosition(primaryVersion, entryReason);
  const liveDecimals = typeof options.tokenDecimals === 'number'
    ? options.tokenDecimals
    : referenceTick.outputDecimals ?? undefined;
  const liveDecimalsSource = options.tokenDecimalsSource;
  const liveTokenEntryPrice = entryPriceTokenOnly ?? actualEntryPrice;
  const liveWalletEntryPrice = entryPriceWalletDelta ?? actualEntryPrice;
  const position: PaperPosition = {
    positionId,
    tokenMint,
    state: 'PROBE',
    entryPrice: actualEntryPrice,
    // 2026-05-01 (Sprint X measurement-only): token-only / wallet-delta entry price 분리 저장.
    // entryPriceTokenOnly = swap input / qty (사명 §3 5x peak 측정 — paper/live 통일).
    // entryPriceWalletDelta = wallet delta / qty (실 wallet 손익 — Real Asset Guard).
    // 둘 중 swap 분해 실패 시 actualEntryPrice 로 fallback.
    entryPriceTokenOnly: liveTokenEntryPrice,
    entryPriceWalletDelta: liveWalletEntryPrice,
    ataRentSol,
    swapInputSol: swapInputUiAmount,
    entryTimeSec: nowSec,
    entryOpenedAtMs: buyCompletedAtMs,
    ticketSol,
    quantity: actualQuantity,
    // live strategy state-machine 은 paper 와 같은 token-only 가격 축을 쓴다.
    // wallet-delta/rent 는 entryPriceWalletDelta + wallet PnL 로 별도 보존한다.
    marketReferencePrice: liveTokenEntryPrice,
    peakPrice: liveTokenEntryPrice,
    troughPrice: liveTokenEntryPrice,
    lastPrice: liveTokenEntryPrice,
    participatingKols: entryParticipatingKols.map((k) => ({ ...k })),
    kolScore: entryKolScore,
    armName,
    parameterVersion: primaryVersion,
    profileArm: options.profileArm,
    entryArm: options.entryArm,
    exitArm: options.exitArm,
    canaryLane,
    isShadowArm: false,
    kolEntryReason: entryReason,
    kolConvictionLevel: conviction,
    t1MfeOverride: dynamicExit.t1Mfe,
    t1TrailPctOverride: dynamicExit.t1TrailPct,
    t1ProfitFloorMult: dynamicExit.t1ProfitFloorMult,
    probeFlatTimeoutSec: dynamicExit.probeFlatTimeoutSec,
    rotationAnchorKols: options.rotationAnchorKols,
    rotationEntryAtMs: options.rotationAnchorKols ? Date.now() : undefined,
    rotationAnchorPrice: options.rotationAnchorPrice,
    rotationFirstBuyAtMs: options.rotationFirstBuyAtMs,
    rotationLastBuyAtMs: options.rotationLastBuyAtMs,
    rotationLastBuyAgeMs: options.rotationLastBuyAgeMs,
    rotationScore: options.rotationScore,
    underfillReferenceSolAmount: options.underfillReferenceSolAmount,
    underfillReferenceTokenAmount: options.underfillReferenceTokenAmount,
    rotationFlowExitEnabled: options.rotationFlowExitEnabled === true ||
      primaryVersion === config.kolHunterRotationExitFlowParameterVersion ||
      primaryVersion === config.kolHunterRotationChaseTopupParameterVersion,
    executionGuardReason,
    executionGuardAction,
    smartV3LiveHardCutReentry: options.smartV3LiveHardCutReentry,
    smartV3LiveEligibleShadow: options.smartV3LiveEligibleShadow,
    smartV3LiveBlockReason: options.smartV3LiveBlockReason,
    smartV3LiveBlockFlags: options.smartV3LiveBlockFlags,
    smartV3LiveEligibilityEvaluatedAtMs: options.smartV3LiveEligibilityEvaluatedAtMs,
    liveEquivalenceCandidateId: options.liveEquivalenceCandidateId,
    liveEquivalenceDecisionStage: options.liveEquivalenceDecisionStage,
    liveEquivalenceLiveWouldEnter: options.liveEquivalenceLiveWouldEnter,
    liveEquivalenceLiveBlockReason: options.liveEquivalenceLiveBlockReason,
    liveEquivalenceLiveBlockFlags: options.liveEquivalenceLiveBlockFlags,
    smartV3EntryComboKey: options.smartV3EntryComboKey,
    smartV3HardCutParentPositionId: options.smartV3HardCutParentPositionId,
    smartV3HardCutAtMs: options.smartV3HardCutAtMs,
    smartV3HardCutEntryPrice: options.smartV3HardCutEntryPrice,
    smartV3HardCutExitPrice: options.smartV3HardCutExitPrice,
    smartV3HardCutDiscountPct: options.smartV3HardCutDiscountPct,
    kolReinforcementCount: 0,
    detectorVersion: config.kolHunterDetectorVersion,
    independentKolCount: entryIndependentKolCount,
    survivalFlags: [
      ...liveSurvivalFlags,
      `LIVE_DECIMALS_${liveDecimals ?? 'UNKNOWN'}`,
    ],
    tokenDecimals: liveDecimals,
    tokenDecimalsSource: liveDecimalsSource,
    entrySecurityEvidence: options.entrySecurityEvidence,
    entrySellQuoteEvidence: liveSellSized.evidence,
    isLive: true,
    dbTradeId: persistResult.dbTradeId ?? undefined,
    entryTxSignature,
    entrySlippageBps,
  };

  setActivePosition(position);
  emitKolPositionPolicy(position, 'entry', 'enter', {
    routeFound: true,
    entryAdvantagePct: actualEntryPrice / referencePrice - 1,
    swapQuoteEntryAdvantagePct,
    referenceToSwapQuotePct,
    buyExecutionMs,
  });
  // 2026-05-01 (F6 fix): Decu Quality Layer Phase B.6 — live entry record.
  //   enterPaperPosition 만 wired 였으나 live 도 동일 cohort 분석 필요. fire-and-forget.
  if (config.tokenQualityObserverEnabled && !position.isTailPosition) {
    void recordTokenQualityObservation(position).catch(() => {});
  }
  trackTradeMarkout(
    {
      anchorType: 'buy',
      positionId: position.positionId,
      tokenMint: position.tokenMint,
      anchorTxSignature: entryTxSignature,
      anchorAtMs: buyCompletedAtMs,
      anchorPrice: position.entryPriceTokenOnly ?? actualEntryPrice,
      anchorPriceKind: position.entryPriceTokenOnly ? 'entry_token_only' : 'wallet_delta_fallback',
      probeSolAmount: position.swapInputSol ?? ticketSol,
      tokenDecimals: position.tokenDecimals,
      signalSource: position.armName,
      extras: {
        mode: 'live',
        armName: position.armName,
        profileArm: position.profileArm ?? null,
        entryArm: position.entryArm ?? position.armName,
        exitArm: position.exitArm ?? position.armName,
        parameterVersion: position.parameterVersion,
        entryReason: position.kolEntryReason,
        convictionLevel: position.kolConvictionLevel,
        kolScore: position.kolScore,
        independentKolCount: position.independentKolCount,
        isShadowArm: position.isShadowArm,
        isShadowKol: position.isShadowKol ?? false,
        isTailPosition: position.isTailPosition ?? false,
        parentPositionId: position.parentPositionId ?? null,
        rotationAnchorKols: position.rotationAnchorKols ?? null,
        rotationEntryAtMs: position.rotationEntryAtMs ?? null,
        rotationAnchorPrice: position.rotationAnchorPrice ?? null,
        rotationFirstBuyAtMs: position.rotationFirstBuyAtMs ?? null,
        rotationLastBuyAtMs: position.rotationLastBuyAtMs ?? null,
        rotationLastBuyAgeMs: position.rotationLastBuyAgeMs ?? null,
        rotationScore: position.rotationScore ?? null,
        underfillReferenceSolAmount: position.underfillReferenceSolAmount ?? null,
        underfillReferenceTokenAmount: position.underfillReferenceTokenAmount ?? null,
        underfillReferencePrice: rotationUnderfillReferencePriceFromTelemetry({
          underfillReferenceSolAmount: position.underfillReferenceSolAmount,
          underfillReferenceTokenAmount: position.underfillReferenceTokenAmount,
        } as RotationV1TriggerResult['telemetry']) ?? null,
        rotationFlowExitEnabled: position.rotationFlowExitEnabled ?? false,
        executionGuardReason: position.executionGuardReason ?? null,
        executionGuardAction: position.executionGuardAction ?? null,
        entrySecurityEvidence: position.entrySecurityEvidence ?? null,
        entrySellQuoteEvidence: position.entrySellQuoteEvidence ?? null,
        tokenSecurityKnown: position.entrySecurityEvidence?.tokenSecurityKnown ?? null,
        securityClientPresent: position.entrySecurityEvidence?.securityClientPresent ?? null,
        sellRouteKnown: position.entrySellQuoteEvidence?.routeFound === true ? true : null,
        routeFound: position.entrySellQuoteEvidence?.routeFound ?? null,
        exitLiquidityKnown: position.entrySecurityEvidence?.exitLiquidityKnown ?? null,
        exitLiquidityData: position.entrySecurityEvidence?.exitLiquidityData ?? null,
        smartV3LiveHardCutReentry: position.smartV3LiveHardCutReentry ?? false,
        smartV3HardCutParentPositionId: position.smartV3HardCutParentPositionId ?? null,
        smartV3HardCutAtMs: position.smartV3HardCutAtMs ?? null,
        smartV3HardCutEntryPrice: position.smartV3HardCutEntryPrice ?? null,
        smartV3HardCutExitPrice: position.smartV3HardCutExitPrice ?? null,
        smartV3HardCutDiscountPct: position.smartV3HardCutDiscountPct ?? null,
      },
    },
    buildTradeMarkoutObserverConfig(position)
  );
  ensurePriceListener(tokenMint);

  if (entryAdvantageReason) {
    log.warn(
      `[KOL_HUNTER_LIVE_ENTRY_ADVANTAGE_EXIT] ${positionId} ${tokenMint.slice(0, 8)} ` +
      `${entryAdvantageReason} — emergency close before shadow/open notification`
    );
    // entry-quality emergency exit 도 일반 closePosition 과 동일하게 즉시 closing 상태로 전환한다.
    // 그렇지 않으면 async sell 진행 중 price tick 이 같은 live position 을 다시 close 할 수 있어
    // sell retry / balance-recovered 경로가 중복 close ledger 를 남긴다.
    const previousState = position.state;
    position.state = 'CLOSED';
    const closeRequestedSec = Math.floor(Date.now() / 1000);
    await closeLivePosition(
      position,
      referencePrice,
      'entry_advantage_emergency_exit',
      closeRequestedSec,
      0,
      0,
      previousState
    );
    return;
  }

  // 2026-04-28 fix: swing-v2 paper shadow 는 main arm 이 live 이더라도 paired observation
  // 으로 paper 진입 (실 자산 영향 없음). enterPaperPosition 의 logic 과 정합 (line 1103-1167).
  // 재귀 방지: primary 가 swing-v2 자기자신이 아닐 때만.
  if (
    primaryVersion !== config.kolHunterSwingV2ParameterVersion &&
    isSwingV2Eligible(score)
  ) {
    const swingShadowId = `${positionId}-swing-v2`;
    const swingPos: PaperPosition = {
      positionId: swingShadowId,
      tokenMint,
      state: 'PROBE',
      entryPrice: actualEntryPrice,
      entryTimeSec: nowSec,
      ticketSol,
      quantity: actualQuantity,
      marketReferencePrice: actualEntryPrice,
      peakPrice: actualEntryPrice,
      troughPrice: actualEntryPrice,
      lastPrice: actualEntryPrice,
      participatingKols: score.participatingKols.map((k) => ({ ...k })),
      kolScore: score.finalScore,
      armName: armNameForVersion(config.kolHunterSwingV2ParameterVersion),
      parameterVersion: config.kolHunterSwingV2ParameterVersion,
      isShadowArm: true,
      parentPositionId: positionId,
      kolEntryReason: defaultEntryReasonForVersion(config.kolHunterSwingV2ParameterVersion),
      kolConvictionLevel: defaultConvictionForVersion(config.kolHunterSwingV2ParameterVersion),
      smartV3LiveHardCutReentry: options.smartV3LiveHardCutReentry,
      smartV3HardCutParentPositionId: options.smartV3HardCutParentPositionId,
      smartV3HardCutAtMs: options.smartV3HardCutAtMs,
      smartV3HardCutEntryPrice: options.smartV3HardCutEntryPrice,
      smartV3HardCutExitPrice: options.smartV3HardCutExitPrice,
      smartV3HardCutDiscountPct: options.smartV3HardCutDiscountPct,
      kolReinforcementCount: 0,
      detectorVersion: config.kolHunterDetectorVersion,
      independentKolCount: score.independentKolCount,
      survivalFlags: [
        ...liveSurvivalFlags,
        `LIVE_PAIRED_PAPER_SHADOW`,
        `DECIMALS_${liveDecimalsSource?.toUpperCase() ?? 'UNKNOWN'}`,
      ],
      tokenDecimals: liveDecimals,
      tokenDecimalsSource: liveDecimalsSource,
      isLive: false,  // ← shadow 는 paper. main arm 만 live.
    };
    setActivePosition(swingPos);
    emitKolPositionPolicy(swingPos, 'entry', 'enter', { routeFound: true });
    // 2026-04-28 QA fix: paired shadow 도 paper_entry emit 해야 kolPaperNotifier 의
    // hourly digest + 5x anomaly alert 에 포함됨 (enterPaperPosition line 1216 와 정합).
    kolHunterEvents.emit('paper_entry', swingPos);
    log.info(
      `[KOL_HUNTER_SWING_V2] ${positionId} ${tokenMint.slice(0, 8)} (paired with LIVE main) ` +
      `kols=${score.independentKolCount} score=${score.finalScore.toFixed(2)} ` +
      `stalk=${config.kolHunterSwingV2StalkWindowSec}s trail=${(config.kolHunterSwingV2T1TrailPct * 100).toFixed(0)}% ` +
      `profitFloor=${config.kolHunterSwingV2T1ProfitFloorMult}x`
    );
  }
  if (primaryVersion === config.kolHunterSmartV3ParameterVersion) {
    const smartArmSpecs = buildSmartV3PaperArmSpecs(
      entryReason,
      resolveSmartV3NewPoolContext(tokenMint)
    );
    const addedArms: string[] = [];
    for (const spec of smartArmSpecs) {
      if (!spec.enabled) continue;
      const shadowPos: PaperPosition = {
        ...position,
        positionId: `${positionId}-${spec.suffix}`,
        armName: spec.armName,
        parameterVersion: spec.parameterVersion,
        isShadowArm: true,
        parentPositionId: positionId,
        isLive: false,
        dbTradeId: undefined,
        entryTxSignature: undefined,
        survivalFlags: [
          ...position.survivalFlags,
          'LIVE_PAIRED_PAPER_SHADOW',
        ],
      };
      applySmartV3PaperArmSpec(shadowPos, spec);
      setActivePosition(shadowPos);
      emitKolPositionPolicy(shadowPos, 'entry', 'enter', { routeFound: true });
      if (config.tokenQualityObserverEnabled && !shadowPos.isTailPosition) {
        void recordTokenQualityObservation(shadowPos).catch(() => {});
      }
      trackPaperPositionMarkout(
        shadowPos,
        'buy',
        shadowPos.entryPriceTokenOnly ?? shadowPos.entryPrice,
        shadowPos.swapInputSol ?? shadowPos.ticketSol,
        shadowPos.entryTimeSec * 1000,
        {
          eventType: 'paper_entry',
          survivalFlags: shadowPos.survivalFlags,
          smartV3LiveEligibleShadow: shadowPos.smartV3LiveEligibleShadow ?? null,
          smartV3LiveBlockReason: shadowPos.smartV3LiveBlockReason ?? null,
          smartV3LiveBlockFlags: shadowPos.smartV3LiveBlockFlags ?? null,
        }
      );
      kolHunterEvents.emit('paper_entry', shadowPos);
      addedArms.push(shadowPos.armName);
    }
    if (addedArms.length > 0) {
      log.info(
        `[KOL_HUNTER_SMART_V3_PAPER_ARMS] ${positionId} ${tokenMint.slice(0, 8)} ` +
        `(paired with LIVE main) arms=${addedArms.join(',')}`
      );
    }
  }

  if (persistResult.dbTradeId) {
    // 2026-04-28 P0-B fix: notifier fire-and-forget. Telegram 429 시 entry path 200-2000ms blocking 차단.
    // 신뢰도: notifier 실패는 trade 경제성에 영향 없음 (DB / wallet 은 이미 commit). log.warn 만 충분.
    void ctx.notifier.sendTradeOpen({
      tradeId: persistResult.dbTradeId,
      pairAddress: tokenMint,
      strategy: LANE_STRATEGY,
      side: 'BUY',
      // 2026-04-29: KOL signal prefetch 로 24h cache populate → notifier path RPC 0.
      tokenSymbol: lookupCachedSymbol(tokenMint) ?? undefined,
      price: actualEntryPrice,
      plannedEntryPrice: referencePrice,
      quantity: actualQuantity,
      sourceLabel: position.armName,
      discoverySource: 'kol_discovery_v1',
      stopLoss: actualEntryPrice * (1 - config.kolHunterHardcutPct),
      takeProfit1: actualEntryPrice * (1 + config.kolHunterT1Mfe),
      takeProfit2: actualEntryPrice * (1 + config.kolHunterT2Mfe),
      timeStopMinutes: Math.ceil(config.kolHunterStalkWindowSec / 60),
      // 2026-04-29: RPC 측정 wallet delta + partial-fill flag 전파.
      actualNotionalSol,
      partialFillDataMissing,
      partialFillDataReason,
      // 2026-05-01 (Sprint Y2): Telegram 알림 cost decomposition.
      swapInputSol: swapInputUiAmount,
      ataRentSol,
      networkFeeSol,
      jitoTipSol,
    }, entryTxSignature).catch((err) => {
      log.warn(`[KOL_HUNTER_LIVE_NOTIFY_OPEN_FAIL] ${positionId} ${err}`);
    });
  }

  log.info(
    `[KOL_HUNTER_LIVE_OPEN] ${positionId} ${tokenMint.slice(0, 8)} ` +
    `entry=${actualEntryPrice.toFixed(8)} qty=${actualQuantity.toFixed(2)} ticket=${ticketSol}SOL ` +
    `kols=${score.independentKolCount} score=${score.finalScore.toFixed(2)}`
  );
  kolHunterEvents.emit('paper_entry', position);
  } finally {
    // 2026-04-28 P0-2A: inflight dedup release (try block 시작 → 모든 return / throw 경로 cover).
    inflightLiveEntry.delete(tokenMint);
  }
}

async function closeLivePosition(
  pos: PaperPosition,
  exitPrice: number,
  reason: CloseReason,
  nowSec: number,
  mfePctAtClose: number,
  maePctAtClose: number,
  // 2026-04-28 F1 fix: closePosition 에서 mutation 전 capture 한 previousState 를 명시적 전달.
  // undefined 시 fallback 으로 pos.state 사용 (recovery 경로 등 기존 호출자 호환).
  callerPreviousState?: LaneTState
): Promise<void> {
  if (!botCtx) {
    log.error(`[KOL_HUNTER_LIVE_CLOSE] ${pos.positionId} no botCtx — cannot live close, falling back to paper close`);
    pos.isLive = false;
    closePosition(pos, exitPrice, reason, nowSec, mfePctAtClose, maePctAtClose);
    return;
  }
  const ctx = botCtx;
  const previousState = callerPreviousState ?? pos.state;
  let actualExitPrice = exitPrice;
  let executionSlippage = 0;
  let exitTxSignature = pos.entryTxSignature;
  let sellCompleted = false;
  let liveReceivedSol = 0;
  let effectiveReason: CloseReason = reason;
  const sellRetryUrgency = liveSellUrgencyForCloseReason(reason);
  let sellRetryAttempts: number | null = null;
  let sellRecoveredFromBalanceOnly: boolean | null = null;
  let sellRetrySoldRatio: number | null = null;
  const exitRequestedAtMs = Date.now();
  let exitCompletedAtMs = exitRequestedAtMs;
  let exitLatencyMs = 0;
  let liveHoldSec = Math.max(0, nowSec - pos.entryTimeSec);
  // 2026-05-01 (Phase D P0-3 fix): soldQuantity / isPriceKillParent 를 함수 scope 로 hoist.
  //   이전엔 try block scope 안에서만 사용 → DB closeTrade / canary / ledger / notifier 가
  //   pos.quantity 전체 기준으로 잘못 계산. partial sell 일관 정합 보장.
  let isPriceKillParent = false;
  let soldQuantity = pos.quantity;
  let sellExecutorForFailureProbe: ReturnType<typeof getKolHunterExecutor> | null = null;

  try {
    const sellExecutor = getKolHunterExecutor(ctx);
    sellExecutorForFailureProbe = sellExecutor;
    const initialBalanceProbe = await resolveLiveSellInitialTokenBalance({
      executor: sellExecutor,
      tokenMint: pos.tokenMint,
      context: `kol_hunter:${pos.positionId}`,
      reason,
      entryTxSignature: pos.entryTxSignature,
      entryTimeSec: pos.entryTimeSec,
    });
    const tokenBalance = initialBalanceProbe.balance;
    const solBefore = await sellExecutor.getBalance();
    if (tokenBalance > 0n) {
      // 2026-05-01 (Phase D): tail retain live — parent close 시 partial sell 분기.
      //   조건: tail retain live enabled + 현재 close 가 parent (not tail) + price kill reason
      //   sellAmount = tokenBalance × (1 - retainPct), 잔여 = tail position 의 별도 close 에서 처리.
      //   tail close (isTailPosition=true) 는 100% sell (tokenBalance 가 이미 잔여분).
      isPriceKillParent =
        config.kolHunterTailRetainLiveEnabled === true &&
        config.kolHunterTailRetainEnabled === true &&
        !pos.isTailPosition &&
        !isRotationFamilyMarkoutPosition(pos) &&
        isPriceKillReason(reason);
      const retainPct = isPriceKillParent ? config.kolHunterTailRetainPct : 0;
      const sellAmount = isPriceKillParent
        ? (tokenBalance * BigInt(Math.round((1 - retainPct) * 10000))) / 10000n
        : tokenBalance;
      const expectedRemainingBalance = tokenBalance > sellAmount ? tokenBalance - sellAmount : 0n;
      if (isPriceKillParent) {
        log.info(
          `[KOL_HUNTER_LIVE_PARTIAL_SELL] ${pos.positionId} reason=${reason} ` +
          `sellAmount=${sellAmount.toString()}/${tokenBalance.toString()} ` +
          `(${((1 - retainPct) * 100).toFixed(0)}% close, ${(retainPct * 100).toFixed(0)}% tail retain)`
        );
      }
      const sellExecution = await executeLiveSellWithImmediateRetries({
        executor: sellExecutor,
        tokenMint: pos.tokenMint,
        initialTokenBalance: tokenBalance,
        requestedSellAmount: sellAmount,
        expectedRemainingBalance,
        context: `kol_hunter:${pos.positionId}`,
        reason,
        syntheticSignature: `KOL_LIVE_SELL_BALANCE_RECOVERED_${pos.positionId}`,
        urgency: sellRetryUrgency,
        allowBalanceRecovered: initialBalanceProbe.source !== 'entry_tx_post_balance',
      });
      sellRetryAttempts = sellExecution.attempts;
      sellRecoveredFromBalanceOnly = sellExecution.recoveredFromBalanceOnly;
      sellRetrySoldRatio = sellExecution.soldRatio;
      const sellResult = sellExecution.sellResult;
      const solAfter = await sellExecutor.getBalance();
      const receivedSol = resolveSellReceivedSolFromSwapResult({
        balanceDeltaSol: solAfter - solBefore,
        sellResult,
        context: `kol_hunter:${pos.positionId}`,
      });
      liveReceivedSol = receivedSol;
      // 2026-04-29: 사명 §3 wallet ground truth — receivedSol 부호 무관 항상 wallet 기준 가격 사용.
      // 이전 (receivedSol > 0 만): sell 시 fees 가 sell 가치 초과하면 (Jito tip + Jupiter fee >
      //   received tokens 가치) actualExitPrice 가 trigger price 그대로 → DB pnl ↔ wallet 10x drift.
      //   8JH1J6p4 incident 의 PNL_DRIFT 0.0498 SOL 직접 원인.
      // 현재: 항상 receivedSol/qty 로 갱신 → DB/notification pnl = wallet delta 일치.
      // 2026-05-01 (Phase D): partial sell 정합 — actualExitPrice 는 sold 비중 기준.
      //   isPriceKillParent=true 면 pos.quantity 의 (1 - retainPct) 만 sold.
      //   tail position 의 close 는 pos.quantity 가 이미 retain 분이라 정상 100% 비중.
      //   wallet ground truth: receivedSol / soldQuantity → actualExitPrice 정확.
      // P0-3 fix: soldQuantity 는 함수 scope hoisted variable 에 할당 (DB / canary / ledger 일관).
      soldQuantity = pos.quantity * sellExecution.soldRatio;
      if (soldQuantity > 0) {
        actualExitPrice = receivedSol / soldQuantity;
      }
      exitCompletedAtMs = Date.now();
      exitLatencyMs = Math.max(0, exitCompletedAtMs - exitRequestedAtMs);
      liveHoldSec = Math.max(0, Math.floor(exitCompletedAtMs / 1000) - pos.entryTimeSec);
      executionSlippage = bpsToDecimal(sellResult.slippageBps);
      exitTxSignature = sellResult.txSignature;
      sellCompleted = true;
      log.info(
        `[KOL_HUNTER_LIVE_SELL] ${pos.positionId} sig=${sellResult.txSignature.slice(0, 12)} ` +
        `received=${receivedSol.toFixed(6)} SOL slip=${sellResult.slippageBps}bps ` +
        `${sellExecution.recoveredFromBalanceOnly ? 'balanceRecovered=true ' : ''}` +
        `${isPriceKillParent ? `partial=${(retainPct * 100).toFixed(0)}%-retained` : ''}`
      );
      // dbPnl / walletDelta 도 sold 비중 기준 — partial sell 의 pnl 정합.
      const solSpentNominal = pos.entryPrice * soldQuantity;
      const dbPnl = (actualExitPrice - pos.entryPrice) * soldQuantity;
      const walletDelta = receivedSol - solSpentNominal;
      const dbPnlDrift = dbPnl - walletDelta;
      if (Math.abs(dbPnlDrift) > 0.001) {
        log.warn(
          `[KOL_HUNTER_LIVE_PNL_DRIFT] ${pos.positionId} dbPnl=${dbPnl.toFixed(6)} ` +
          `walletDelta=${walletDelta.toFixed(6)} drift=${dbPnlDrift.toFixed(6)} SOL`
        );
      }
      const mfePctPeak = pos.marketReferencePrice > 0
        ? (pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice
        : 0;
      // 2026-05-01 (Sprint X): token-only / wallet-based MFE peak 분리.
      //   사명 §3 5x judgement = mfePctPeakTokenOnly >= 4.0 (paper/live 통일)
      //   wallet net loss/gain = walletDeltaSol 그대로 (Real Asset Guard 정합)
      const tokenEntryRef = pos.entryPriceTokenOnly && pos.entryPriceTokenOnly > 0
        ? pos.entryPriceTokenOnly
        : pos.marketReferencePrice;
      const walletEntryRef = pos.entryPriceWalletDelta && pos.entryPriceWalletDelta > 0
        ? pos.entryPriceWalletDelta
        : pos.entryPrice;
      const mfePctPeakTokenOnly = tokenEntryRef > 0
        ? (pos.peakPrice - tokenEntryRef) / tokenEntryRef
        : 0;
      const mfePctPeakWalletBased = walletEntryRef > 0
        ? (pos.peakPrice - walletEntryRef) / walletEntryRef
        : 0;
      // 2026-05-01 (Sprint Z — Codex 권고): netPct/maePct/exitPrice/netSol token-only 분리 측정.
      //   stop 정책 평가 시 wallet-delta 만 보면 ATA rent inflation 으로 정책이 보수적으로 보임.
      //   token-only 측정으로 사후 분석 (winner-kill / DSR / arm A/B) 정확. 정책 trigger 는 wallet-delta 그대로.
      // 2026-05-01 (H1 fix — Codex 권고): token-only 지표는 close 함수 인자 `exitPrice` 기반.
      //   이전: receivedSol / soldQuantity 사용 → sell fee + Jito tip + 향후 ATA refund 섞여서 "rent 제외 실현값"
      //   현재: 정책 trigger 가 보는 시장 가격 (exitPrice) 기준 → 순수 token 가격 변동만 측정
      // 2026-05-01 (M3 fix — Codex 권고): partial/tail 의 swapInputSol 비례 차감.
      //   parent partial close 시 sold 비중만 차감 (전체 swapInputSol 차감하면 손실 inflated).
      const soldRatio = pos.quantity > 0 ? soldQuantity / pos.quantity : 1;
      const swapInputSoldShare = pos.swapInputSol != null && pos.swapInputSol > 0
        ? pos.swapInputSol * soldRatio
        : null;
      const maePctTokenOnly = tokenEntryRef > 0
        ? (pos.troughPrice - tokenEntryRef) / tokenEntryRef
        : 0;
      const excursionTelemetryRecord = buildExcursionTelemetryRecord(pos.excursionTelemetry, {
        reason: effectiveReason,
        maePctAtClose: maePctTokenOnly,
        elapsedSec: liveHoldSec,
      });
      // exitPriceTokenOnly = 정책 trigger 가 본 시장 가격. wallet-delta 와 동일 단위지만 의미는 token 시장 가격.
      const exitPriceTokenOnly = exitPrice;
      const smartV3PreT1Telemetry = buildSmartV3PreT1CloseTelemetry(
        pos,
        exitPriceTokenOnly,
        mfePctAtClose,
      );
      const netPctTokenOnly = tokenEntryRef > 0
        ? (exitPrice - tokenEntryRef) / tokenEntryRef
        : 0;
      // netSolTokenOnly = (exitPrice - tokenEntryRef) × soldQuantity. 시장 가격 기반 손익 (rent / sell fee / tip 모두 제외).
      //   분해 실패 시 walletDelta fallback (보수적).
      const netSolTokenOnly = swapInputSoldShare != null
        ? (exitPrice - tokenEntryRef) * soldQuantity
        : walletDelta;
      await appendEntryLedger('sell', {
        positionId: pos.positionId,
        dbTradeId: pos.dbTradeId,
        txSignature: exitTxSignature,
        entryTxSignature: pos.entryTxSignature,
        strategy: LANE_STRATEGY,
        wallet: 'main',
        pairAddress: pos.tokenMint,
        exitReason: effectiveReason,
        receivedSol,
        actualExitPrice,
        slippageBps: sellResult.slippageBps,
        entryPrice: pos.entryPrice,
        holdSec: nowSec - pos.entryTimeSec,
        mfePctPeak,
        // 2026-05-01 (Sprint X): 분리 측정 ledger 전파.
        mfePctPeakTokenOnly,
        mfePctPeakWalletBased,
        // 2026-05-01 (Sprint Z): netPct/maePct/exit/netSol token-only 분리 측정.
        maePctTokenOnly,
        ...excursionTelemetryRecord,
        exitPriceTokenOnly,
        netPctTokenOnly,
        netSolTokenOnly,
        entryPriceTokenOnly: pos.entryPriceTokenOnly,
        entryPriceWalletDelta: pos.entryPriceWalletDelta,
        ataRentSol: pos.ataRentSol,
        swapInputSol: pos.swapInputSol,
        executionGuardReason: pos.executionGuardReason ?? null,
        executionGuardAction: pos.executionGuardAction ?? null,
        exitRequestedAtMs,
        exitCompletedAtMs,
        exitLatencyMs,
        holdSecReal: liveHoldSec,
        peakPrice: pos.peakPrice,
        troughPrice: pos.troughPrice,
        marketReferencePrice: pos.marketReferencePrice,
        sellRetryUrgency,
        sellRetryAttempts,
        sellRecoveredFromBalanceOnly,
        sellRetrySoldRatio,
        t1VisitAtSec: pos.t1VisitAtSec ?? null,
        t2VisitAtSec: pos.t2VisitAtSec ?? null,
        t3VisitAtSec: pos.t3VisitAtSec ?? null,
        closeState: pos.state,
        dbPnlSol: dbPnl,
        walletDeltaSol: walletDelta,
        dbPnlDriftSol: dbPnlDrift,
        solSpentNominal,
        kolScore: pos.kolScore,
        independentKolCount: pos.independentKolCount,
        armName: pos.armName,
        profileArm: pos.profileArm ?? null,
        entryArm: pos.entryArm ?? pos.armName,
        exitArm: pos.exitArm ?? pos.armName,
        parameterVersion: pos.parameterVersion,
        entryReason: pos.kolEntryReason,
        rotationAnchorKols: pos.rotationAnchorKols ?? null,
        rotationEntryAtMs: pos.rotationEntryAtMs ?? null,
        rotationAnchorPrice: pos.rotationAnchorPrice ?? null,
        rotationFirstBuyAtMs: pos.rotationFirstBuyAtMs ?? null,
        rotationLastBuyAtMs: pos.rotationLastBuyAtMs ?? null,
        rotationLastBuyAgeMs: pos.rotationLastBuyAgeMs ?? null,
        rotationScore: pos.rotationScore ?? null,
        rotationMaeFastFail: effectiveReason === 'rotation_mae_fast_fail',
        smartV3MaeFastFail: effectiveReason === 'smart_v3_mae_fast_fail',
        ...smartV3PreT1Telemetry,
      });
      trackTradeMarkout(
        {
          anchorType: 'sell',
          positionId: pos.positionId,
          tokenMint: pos.tokenMint,
          anchorTxSignature: exitTxSignature,
          anchorAtMs: Date.now(),
          anchorPrice: exitPriceTokenOnly,
          anchorPriceKind: 'exit_token_only',
          probeSolAmount: swapInputSoldShare ?? Math.max(0.000001, pos.ticketSol * soldRatio),
          tokenDecimals: pos.tokenDecimals,
          signalSource: pos.armName,
          extras: {
            mode: 'live',
            armName: pos.armName,
            profileArm: pos.profileArm ?? null,
            entryArm: pos.entryArm ?? pos.armName,
            exitArm: pos.exitArm ?? pos.armName,
            parameterVersion: pos.parameterVersion,
            entryReason: pos.kolEntryReason,
            convictionLevel: pos.kolConvictionLevel,
            kolScore: pos.kolScore,
            independentKolCount: pos.independentKolCount,
            isShadowArm: pos.isShadowArm,
            isShadowKol: pos.isShadowKol ?? false,
            isTailPosition: pos.isTailPosition ?? false,
            parentPositionId: pos.parentPositionId ?? null,
            exitReason: effectiveReason,
            closeState: pos.state,
            holdSec: liveHoldSec,
            exitRequestedAtMs,
            exitCompletedAtMs,
            exitLatencyMs,
            mfePctAtClose: mfePctAtClose,
            maePctAtClose: maePctAtClose,
            netSolTokenOnly,
            rotationAnchorKols: pos.rotationAnchorKols ?? null,
            rotationEntryAtMs: pos.rotationEntryAtMs ?? null,
            rotationAnchorPrice: pos.rotationAnchorPrice ?? null,
            rotationFirstBuyAtMs: pos.rotationFirstBuyAtMs ?? null,
            rotationLastBuyAtMs: pos.rotationLastBuyAtMs ?? null,
            rotationLastBuyAgeMs: pos.rotationLastBuyAgeMs ?? null,
            rotationScore: pos.rotationScore ?? null,
            rotationMaeFastFail: effectiveReason === 'rotation_mae_fast_fail',
            smartV3MaeFastFail: effectiveReason === 'smart_v3_mae_fast_fail',
            smartV3LiveHardCutReentry: pos.smartV3LiveHardCutReentry ?? false,
            smartV3HardCutParentPositionId: pos.smartV3HardCutParentPositionId ?? null,
            smartV3HardCutAtMs: pos.smartV3HardCutAtMs ?? null,
            smartV3HardCutEntryPrice: pos.smartV3HardCutEntryPrice ?? null,
            smartV3HardCutExitPrice: pos.smartV3HardCutExitPrice ?? null,
            smartV3HardCutDiscountPct: pos.smartV3HardCutDiscountPct ?? null,
            smartV3MaeRecoveryHold: pos.smartV3MaeRecoveryHold ?? false,
            smartV3MaeRecoveryHoldAtSec: pos.smartV3MaeRecoveryHoldAtSec ?? null,
            smartV3MaeRecoveryHoldUntilSec: pos.smartV3MaeRecoveryHoldUntilSec ?? null,
            smartV3MaeRecoveryHoldReason: pos.smartV3MaeRecoveryHoldReason ?? null,
            ...smartV3PreT1Telemetry,
          },
        },
        buildTradeMarkoutObserverConfig(pos)
      );
    } else {
      // ORPHAN_NO_BALANCE — 첫 0 balance 는 신뢰하지 않는다.
      // Fresh ATA 생성 직후 RPC account index lag 로 false orphan 이 발생할 수 있으므로
      // resolveLiveSellInitialTokenBalance 가 retry + entry tx postTokenBalances fallback 까지 확인한 뒤에만 도달.
      log.warn(
        `[KOL_HUNTER_LIVE_ORPHAN] ${pos.positionId} ${pos.tokenMint.slice(0, 12)} zero balance — ` +
        `force closing pnl=0 (previousReason=${reason} attempts=${initialBalanceProbe.attempts})`
      );
      effectiveReason = 'ORPHAN_NO_BALANCE';
      actualExitPrice = pos.entryPrice;
      sellCompleted = true;
      exitTxSignature = pos.entryTxSignature ?? 'ORPHAN_NO_TX';
      exitCompletedAtMs = Date.now();
      exitLatencyMs = Math.max(0, exitCompletedAtMs - exitRequestedAtMs);
      liveHoldSec = Math.max(0, Math.floor(exitCompletedAtMs / 1000) - pos.entryTimeSec);
      await ctx.notifier.sendCritical(
        'kol_live_orphan',
        `${pos.positionId} ${pos.tokenMint} zero balance at close — force closing 0 pnl`
      ).catch(() => {});
    }
  } catch (sellErr) {
    const zeroBalanceConfirm = sellExecutorForFailureProbe
      ? await confirmLiveSellZeroTokenBalance({
        executor: sellExecutorForFailureProbe,
        tokenMint: pos.tokenMint,
        context: `kol_hunter:${pos.positionId}`,
        reason,
        minZeroConfirmations: 2,
      })
      : null;
    if (zeroBalanceConfirm?.confirmedZero === true) {
      log.warn(
        `[KOL_HUNTER_LIVE_ORPHAN_AFTER_SELL_RETRY] ${pos.positionId} ${pos.tokenMint.slice(0, 12)} ` +
        `zero balance confirmed ${zeroBalanceConfirm.zeroConfirmations}/${zeroBalanceConfirm.attempts} ` +
        `after failed sell retries — force closing pnl=0 (previousReason=${reason})`
      );
      effectiveReason = 'ORPHAN_NO_BALANCE';
      actualExitPrice = pos.entryPrice;
      sellCompleted = true;
      exitTxSignature = pos.entryTxSignature ?? 'ORPHAN_NO_TX';
      sellRetryAttempts = liveSellRetryMaxAttempts();
      sellRecoveredFromBalanceOnly = true;
      sellRetrySoldRatio = 1;
      exitCompletedAtMs = Date.now();
      exitLatencyMs = Math.max(0, exitCompletedAtMs - exitRequestedAtMs);
      liveHoldSec = Math.max(0, Math.floor(exitCompletedAtMs / 1000) - pos.entryTimeSec);
      await ctx.notifier.sendCritical(
        'kol_live_orphan',
        `${pos.positionId} ${pos.tokenMint} zero balance confirmed after failed sell retries — force closing 0 pnl`
      ).catch(() => {});
    } else {
      log.warn(
        `[KOL_HUNTER_LIVE_SELL] ${pos.positionId} sell failed after ` +
        `${liveSellRetryMaxAttempts()} attempts: ${sellErr}`
      );
      // 2026-04-28 F1 fix: callerPreviousState 가 있으면 그걸 사용 (closePosition mutation 이전 값).
      // 없으면 기존 previousState fallback (recovery 경로 등 직접 호출자).
      pos.state = callerPreviousState ?? previousState;
      // 2026-04-28 F2 fix: critical notifier cooldown — 마지막 critical 발사 시각 비교.
      // cupsey/pure_ws/migration 패턴 동일. 이전 코드 (entryTimeSec >= 60s 비교) 는
      // entry 직후 60s 내 sell 실패 시 critical 미발사 → 운영자 무지각 위험.
      if (!pos.lastCloseFailureAtSec || nowSec - pos.lastCloseFailureAtSec >= 60) {
        pos.lastCloseFailureAtSec = nowSec;
        await ctx.notifier.sendCritical(
          'kol_live_close_failed',
          `${pos.positionId} ${pos.tokenMint} reason=${reason} sell failed after ` +
          `${liveSellRetryMaxAttempts()} attempts — OPEN 유지`
        ).catch(() => {});
      }
      return;
    }
  }
  void liveReceivedSol;

  pos.state = 'CLOSED';
  // 2026-05-01 (P0-3 fix): pnl 은 sold 비중 기준 — partial sell 시 retained tail 의 pnl 은
  //   tail position 의 별도 close 에서 산출. canary / DB / notifier / ledger 일관 적용.
  const rawPnl = (actualExitPrice - pos.entryPrice) * soldQuantity;
  const runnerPnl = rawPnl;  // live: round-trip cost 는 wallet delta 에 이미 반영됨
  // 2026-05-01/12 (codex F-A fix + live partial): partial take realized PnL 합산.
  //   live T1 partial / rotation reduce 모두 선행 부분실현이 있을 수 있으므로,
  //   runner close 에서 partial realized leg 를 합산한다.
  //   DB closeTrade.pnl / appendLiveLedger / markKolClosed / canary / sendTradeClose 모두 aggregatedPnl 사용.
  const partialNetSol = pos.partialTakeRealizedSol ?? 0;
  const partialTicketSol = pos.partialTakeLockedTicketSol ?? 0;
  const pnl = runnerPnl + partialNetSol;
  const soldTicketSol = pos.entryPrice * soldQuantity;
  const effectiveTicketSol = soldTicketSol + partialTicketSol;
  const pnlPct = effectiveTicketSol > 0
    ? pnl / effectiveTicketSol
    : (pos.entryPrice > 0 ? (actualExitPrice - pos.entryPrice) / pos.entryPrice : 0);
  const canaryLane = kolHunterCanaryLaneForPosition(pos);

  // DB closeTrade.
  let dbCloseSucceeded = false;
  try {
    if (pos.dbTradeId && sellCompleted) {
      const closeUpdated = await ctx.tradeStore.closeTrade({
        id: pos.dbTradeId,
        exitPrice: actualExitPrice,
        pnl,
        slippage: executionSlippage,
        exitReason: effectiveReason,
        exitSlippageBps: Math.round(executionSlippage * 10_000),
        decisionPrice: exitPrice,
      });
      dbCloseSucceeded = closeUpdated !== false;
    }
  } catch (err) {
    log.warn(`[KOL_HUNTER_LIVE_CLOSE_PERSIST] ${pos.positionId}: ${err}`);
    // 2026-04-27 fix: live sell 성공 후 DB close 실패 → wallet ↔ DB drift 누적 가능.
    // smart-v3/rotation canary 분리 이후에는 실제 canary sublane 을 멈춰야 재진입이 차단된다.
    // 운영자 reconciliation 후 resetEntryHalt(canaryLane) 로 해제 필요.
    triggerEntryHalt(canaryLane, `KOL live close persist failed for ${pos.positionId}: ${err}`);
    await ctx.notifier.sendCritical(
      'kol_live_close_persist',
      `${pos.positionId} ${pos.tokenMint} sell ok but DB close failed — ${canaryLane} NEW POSITIONS HALTED`
    ).catch(() => {});
  }
  void dbCloseSucceeded;

  log.info(
    `[KOL_HUNTER_LIVE_CLOSED] ${pos.positionId} reason=${effectiveReason} state=${previousState} ` +
    `pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(2)}%) ` +
    `hold=${liveHoldSec}s exitLatency=${exitLatencyMs}ms ` +
    `mfe=${(mfePctAtClose * 100).toFixed(2)}% mae=${(maePctAtClose * 100).toFixed(2)}%`
  );

  // 2026-04-29: 다른 lane (cupsey / pure_ws / migration) 과 동일하게 sendTradeClose 사용.
  //   - 이전: sendInfo 의 raw 문자열 (한 줄 [KOL_LIVE_CLOSE] ...) — 진입 알림과 포맷 불일치
  //   - 현재: 구조화된 Trade 객체 → notifier.sendTradeClose 가 OPEN 알림과 동일 톤 출력
  // dbCloseSucceeded 시에만 sendTradeClose. DB 미기록은 sendCritical 로 분리 (별도 reconcile 경로).
  // P0-B fix: fire-and-forget 유지 (Telegram 429 close path blocking 차단).
  const isLedgerOnlyLiveTailClose = pos.isLive === true && pos.isTailPosition === true && !pos.dbTradeId;
  if (dbCloseSucceeded && pos.dbTradeId) {
    const closedTrade: Trade = {
      id: pos.dbTradeId,
      pairAddress: pos.tokenMint,
      strategy: LANE_STRATEGY,
      side: 'BUY',
      // 2026-04-29: prefetch 시 populate. miss 시 messageFormatter 가 shortenAddress 로 fallback.
      tokenSymbol: lookupCachedSymbol(pos.tokenMint) ?? undefined,
      entryPrice: pos.entryPrice,
      plannedEntryPrice: pos.marketReferencePrice,
      exitPrice: actualExitPrice,
      // P0-3 fix: closedTrade.quantity 도 sold 비중 — DB / notifier 일관.
      quantity: soldQuantity,
      pnl,
      slippage: executionSlippage,
      txSignature: exitTxSignature,
      status: 'CLOSED',
      createdAt: new Date(pos.entryTimeSec * 1000),
      closedAt: new Date(),
      stopLoss: pos.entryPrice * (1 - config.kolHunterHardcutPct),
      takeProfit1: pos.entryPrice * (1 + config.kolHunterT1Mfe),
      takeProfit2: pos.entryPrice * (1 + config.kolHunterT2Mfe),
      highWaterMark: pos.peakPrice,
      timeStopAt: new Date((pos.entryTimeSec + config.kolHunterStalkWindowSec) * 1000),
      entrySlippageBps: pos.entrySlippageBps,
      exitSlippageBps: Math.round(executionSlippage * 10_000),
      // KOL hunter local CloseReason 은 utils/types CloseReason 과 별도 (probe_hard_cut 등).
      // notifier 는 string 만 활용하므로 안전한 cast — DB 도 enum 검증 없이 문자열 저장.
      exitReason: effectiveReason as unknown as Trade['exitReason'],
      decisionPrice: exitPrice,
      sourceLabel: pos.armName,
      discoverySource: 'kol_discovery_v1',
      // 2026-05-01 (Sprint Z+1): rent visibility 보조 — trade.pnl 자체는 wallet-delta 그대로.
      ataRentSol: pos.ataRentSol,
    };
    void ctx.notifier.sendTradeClose(closedTrade)
      .catch((err) => log.warn(`[KOL_HUNTER_LIVE_NOTIFY_CLOSE_FAIL] ${pos.positionId} ${err}`));
  } else if (isLedgerOnlyLiveTailClose) {
    log.info(
      `[KOL_HUNTER_LIVE_TAIL_LEDGER_ONLY_CLOSED] ${pos.positionId} ` +
      `reason=${effectiveReason} pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL ` +
      `hold=${liveHoldSec}s — DB row intentionally absent for retained tail`
    );
  } else {
    // DB 미기록 경로 — operator 가 manual reconcile 필요. 별도 critical 로 분리.
    void ctx.notifier.sendCritical(
      'kol_live_close_no_db',
      `${pos.positionId} ${pos.tokenMint.slice(0, 12)} reason=${effectiveReason} ` +
      `pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(6)} SOL (${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(2)}%) ` +
      `hold=${liveHoldSec}s [NO_DB_RECORD — manual reconcile]`
    ).catch(() => {});
  }

  deleteActivePosition(pos.positionId);
  // 2026-04-29 (Track 1): live close 도 same-token cooldown stamp.
  if (!pos.isShadowArm) {
    markTokenClosed(pos.tokenMint);
    maybeRegisterSmartV3LiveHardCutReentry(pos, exitPrice, effectiveReason);
    // 2026-04-29 (P0-2): KOL alpha decay tracking — live close 가 우선 신호 (real wallet delta).
    markKolClosed(pos.participatingKols.map((k) => k.id), pnl);
    markSmartV3ComboClosed(pos, pnl, 'live');
    markRotationLiveKolClosed(pos, pnl);
  }

  // 2026-04-30 (Sprint 1.B3): live trade outcome 을 jsonl 로 persist (DSR validator 입력).
  if (!pos.isShadowArm) {
    // 2026-05-01 (codex F-A fix): liveNetPct → pnlPct (aggregated, partial 합산 기준).
    //   paper appendPaperLedger 와 schema 정합 — DSR validator 입력 일관성.
    void appendLiveLedger(
      pos,
      actualExitPrice,
      effectiveReason,
      liveHoldSec,
      mfePctAtClose,
      maePctAtClose,
      pnl,
      pnlPct,
      exitTxSignature,
      // 2026-05-01 (Codex H1): token-only metric 은 정책 trigger 가 본 시장가 `exitPrice` 기반.
      //   actualExitPrice (= receivedSol/qty wallet-delta) 가 아닌 closeLivePosition 인자.
      exitPrice,
      soldQuantity,
      {
        sellRetryUrgency,
        sellRetryAttempts,
        sellRecoveredFromBalanceOnly,
        sellRetrySoldRatio,
        exitRequestedAtMs,
        exitCompletedAtMs,
        exitLatencyMs,
        holdSecReal: liveHoldSec,
      }
    ).catch(() => {});
  }

  // 2026-04-30 (Sprint 1.A4): live close → post-close observer.
  // paper close path 는 closePosition 안에서 trackRejectForMissedAlpha 직접 호출 중,
  // live 만 누락 → live close 도 동일 trajectory 측정 (winner-kill rate 산출 인프라).
  // shadow arm 은 fire 금지 (pure_ws 패턴 정합).
  if (!pos.isShadowArm) {
    trackKolClose({
      positionId: pos.positionId,
      tokenMint: pos.tokenMint,
      closeReason: effectiveReason,
      signalPrice: pos.marketReferencePrice,
      ticketSol: pos.ticketSol,
      tokenDecimals: pos.tokenDecimals,
      tokenDecimalsSource: pos.tokenDecimalsSource,
      state: pos.state,
      entryTimeSec: pos.entryTimeSec,
      nowSec: Math.floor(exitCompletedAtMs / 1000),
      mfePct: mfePctAtClose,
      maePct: maePctAtClose,
      entryPrice: pos.entryPrice,
      exitPrice: actualExitPrice,
      peakPrice: pos.peakPrice,
      troughPrice: pos.troughPrice,
      isLive: true,
      armName: pos.armName,
      t1VisitAtSec: pos.t1VisitAtSec,
      t2VisitAtSec: pos.t2VisitAtSec,
      t3VisitAtSec: pos.t3VisitAtSec,
      rotationAnchorKols: pos.rotationAnchorKols ?? null,
      rotationEntryAtMs: pos.rotationEntryAtMs ?? null,
      rotationAnchorPrice: pos.rotationAnchorPrice ?? null,
      rotationFirstBuyAtMs: pos.rotationFirstBuyAtMs ?? null,
      rotationLastBuyAtMs: pos.rotationLastBuyAtMs ?? null,
      rotationLastBuyAgeMs: pos.rotationLastBuyAgeMs ?? null,
      rotationScore: pos.rotationScore ?? null,
    });
  }
  unsubscribePriceIfIdle(pos.tokenMint);

  // Real Asset Guard feed: canary auto-halt + bleed budget.
  reportCanaryClose(canaryLane, pnl);
  releaseCanarySlot(canaryLane);
  if (config.dailyBleedBudgetEnabled) {
    const walletState = getWalletStopGuardState();
    const walletBaselineSol = walletState.lastBalanceSol > 0 && Number.isFinite(walletState.lastBalanceSol)
      ? walletState.lastBalanceSol
      : config.walletStopMinSol + 0.01;
    const bleedSol = pnl < 0 ? -pnl : 0;
    reportBleed(bleedSol, walletBaselineSol, {
      alpha: config.dailyBleedAlpha,
      minCapSol: config.dailyBleedMinCapSol,
      maxCapSol: config.dailyBleedMaxCapSol,
    });
  }

  const mfePctPeak = pos.marketReferencePrice > 0
    ? (pos.peakPrice - pos.marketReferencePrice) / pos.marketReferencePrice
    : 0;
  kolHunterEvents.emit('paper_close', {
    pos, reason: effectiveReason, exitPrice: actualExitPrice,
    netSol: pnl, netPct: pnlPct, mfePctPeak, holdSec: liveHoldSec,
  });
  void exitTxSignature;

  // 2026-05-01 (P0-2 fix): live parent close 후 tail sub-position spawn.
  //   이전엔 paper close path 의 closePosition 만 spawn → live 시 잔여 토큰 unmanaged orphan.
  //   조건: isPriceKillParent (위에서 partial sell 수행한 경우) 만 spawn.
  //   tail 자체는 spawnTailSubPosition 의 isLive 분기로 live 또는 paper 결정.
  if (isPriceKillParent && !pos.isShadowArm) {
    spawnTailSubPosition(pos, actualExitPrice, nowSec);
  }
}

// ─── Observer (reject side) ──────────────────────────────

function fireRejectObserver(
  tokenMint: string,
  reason: CloseReason,
  cand: PendingCandidate,
  score: KolDiscoveryScore,
  extras: Record<string, unknown> = {}
): void {
  const survivalFlags = extractStringArray(extras.survivalFlags);
  const skipPolicyEntry = extras.skipPolicyEntry === true;
  const signalPrice = typeof extras.signalPrice === 'number' && Number.isFinite(extras.signalPrice) && extras.signalPrice > 0
    ? extras.signalPrice
    : 0.01;
  const tokenDecimals = typeof extras.tokenDecimals === 'number' && Number.isFinite(extras.tokenDecimals)
    ? extras.tokenDecimals
    : undefined;
  const parameterVersion = typeof extras.parameterVersion === 'string' ? extras.parameterVersion : undefined;
  const observerArmName = typeof extras.armName === 'string'
    ? extras.armName
    : parameterVersion
      ? armNameForVersion(parameterVersion)
      : undefined;
  const observerSignalSource = typeof extras.signalSource === 'string'
    ? extras.signalSource
    : observerArmName;
  const survivalReason = typeof extras.survivalReason === 'string' ? extras.survivalReason : undefined;
  if (!skipPolicyEntry) {
    emitKolShadowPolicy({
      eventKind: 'reject',
      tokenMint,
      currentAction: 'block',
      isLive: false,
      isShadowArm: false,
      source: 'reject_observer',
      armName: observerArmName,
      entryReason: typeof extras.entryReason === 'string' ? extras.entryReason : undefined,
      rejectReason: reason,
      parameterVersion,
      signalSource: observerSignalSource,
      survivalReason,
      independentKolCount: score.independentKolCount,
      effectiveIndependentCount: score.effectiveIndependentCount,
      kolScore: score.finalScore,
      participatingKols: score.participatingKols,
      survivalFlags,
      recentJupiter429: currentRecentJupiter429(),
      routeFound: survivalFlags.includes('NO_SELL_ROUTE') ? false : undefined,
    });
  }

  // Pre-entry reject — 진입 안 된 pair 의 trajectory 관측
  trackRejectForMissedAlpha(
    {
      rejectCategory: 'viability', // pre-entry stalk expire 를 viability 류로 분류
      rejectReason: reason,
      tokenMint,
      lane: LANE_STRATEGY,
      signalPrice,
      probeSolAmount: config.kolHunterTicketSol,
      tokenDecimals,
      signalSource: `kol_hunter_stalk:${cand.kolTxs[0]?.kolId ?? 'unknown'}`,
      extras: {
        stalkDurationMs: Date.now() - cand.firstKolEntryMs,
        kolCount: cand.kolTxs.length,
        independentKolCount: score.independentKolCount,
        kolScore: score.finalScore,
        parameterVersion: config.kolHunterParameterVersion,
        detectorVersion: config.kolHunterDetectorVersion,
        ...extras,
      },
    },
    buildObserverConfig()
  );
}

// ─── Helpers ─────────────────────────────────────────────

function buildObserverConfig() {
  return {
    enabled: config.missedAlphaObserverEnabled,
    offsetsSec: config.missedAlphaObserverOffsetsSec,
    jitterPct: config.missedAlphaObserverJitterPct,
    maxInflight: config.missedAlphaObserverMaxInflight,
    dedupWindowSec: config.missedAlphaObserverDedupWindowSec,
    outputFile: path.join(config.realtimeDataDir, 'missed-alpha.jsonl'),
    jupiterApiUrl: config.jupiterApiUrl,
    jupiterApiKey: config.jupiterApiKey,
  };
}

function trackRecoveredKolClose(trade: Trade, closeReason: string): void {
  const entryTimeSec = Math.floor(trade.createdAt.getTime() / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  const signalPrice = trade.plannedEntryPrice ?? trade.entryPrice;
  const peakPrice = trade.highWaterMark ?? signalPrice;
  const troughPrice = Math.min(signalPrice, trade.entryPrice);
  const mfePct = signalPrice > 0 ? (peakPrice - signalPrice) / signalPrice : 0;
  const maePct = signalPrice > 0 ? (troughPrice - signalPrice) / signalPrice : 0;
  const ticketSol = trade.entryPrice * trade.quantity;

  trackKolClose({
    positionId: `kolh-recovery-${trade.id}`,
    tokenMint: trade.pairAddress,
    closeReason,
    signalPrice,
    ticketSol,
    state: 'RECOVERY_ORPHAN',
    entryTimeSec,
    nowSec,
    mfePct,
    maePct,
    entryPrice: trade.entryPrice,
    exitPrice: trade.entryPrice,
    peakPrice,
    troughPrice,
    isLive: true,
    armName: trade.sourceLabel ?? 'recovery',
  });
}

// ─── Recovery (2026-04-28, Sprint 2A) ────────────────────
//
// Why: 봇 크래시 / 재시작 시 DB 의 OPEN status kol_hunter trade 가 in-memory active map 에서
//   사라져 → tick stream 미수신 → 영구 OPEN row + 토큰 wallet orphan 위험.
// Pattern: cupsey / pure_ws recovery 와 동일.
//   1. DB getOpenTrades() filter strategy='kol_hunter'
//   2. live 모드: on-chain getTokenBalance == 0 → ORPHAN_NO_BALANCE 강제 close (재시도 spam 방지)
//      dust (< 1000 raw) → ORPHAN_DUST_BALANCE 강제 close
//   3. balance > 0: HWM 기준 inferredState (PROBE / RUNNER_T1 / T2 / T3) 추정 후 rehydrate
//      - participatingKols / kolScore / detectorVersion 일부 정보는 DB 미저장 → lost (best-effort)
//      - parameterVersion 도 DB 미저장 → kolHunterParameterVersion default 사용 (보수)
//      - marketReferencePrice = plannedEntryPrice ?? entryPrice (재시작 후 새 tick 자연 보정)
//   4. setActivePosition + ensurePriceListener + priceFeed.subscribe → tick 재개
export async function recoverKolHunterOpenPositions(ctx: BotContext): Promise<number> {
  if (!config.kolHunterEnabled) return 0;
  if (!priceFeed) {
    log.warn('[KOL_HUNTER_RECOVERY] priceFeed not initialized — skip recovery');
    return 0;
  }

  const openTrades = await ctx.tradeStore.getOpenTrades();
  const kolOpenTrades = openTrades.filter((t) => t.strategy === LANE_STRATEGY);
  let recovered = 0;

  for (const trade of kolOpenTrades) {
    // 1. orphan / dust 검사 (live 모드 필수). RPC 실패 시 보수적 fallback (in-memory load).
    if (ctx.tradingMode === 'live') {
      try {
        const probeExecutor = getKolHunterExecutor(ctx);
        const onchainBalance = await probeExecutor.getTokenBalance(trade.pairAddress);
        if (onchainBalance === 0n) {
          log.warn(
            `[KOL_HUNTER_RECOVERY_ORPHAN] trade=${trade.id.slice(0, 8)} pair=${trade.pairAddress.slice(0, 12)} ` +
            `zero token balance — closing DB with 0 pnl, skipping in-memory load`
          );
          const closePersisted = await ctx.tradeStore.closeTrade({
            id: trade.id,
            exitPrice: trade.entryPrice,
            pnl: 0,
            slippage: 0,
            exitReason: 'ORPHAN_NO_BALANCE',
            exitSlippageBps: undefined,
            decisionPrice: trade.entryPrice,
          }).then((updated) => updated !== false).catch((err) => {
            log.error(`[KOL_HUNTER_RECOVERY_ORPHAN] DB close failed for ${trade.id}: ${err}`);
            return false;
          });
          if (closePersisted) trackRecoveredKolClose(trade, 'ORPHAN_NO_BALANCE');
          await ctx.notifier.sendCritical(
            'kol_hunter_recovery_orphan',
            `KOL recovery: ${trade.id.slice(0, 8)} ${trade.pairAddress} zero balance — DB closed, not loaded`
          ).catch(() => {});
          continue;
        }
        if (onchainBalance > 0n && onchainBalance < 1000n) {
          log.warn(
            `[KOL_HUNTER_RECOVERY_DUST] trade=${trade.id.slice(0, 8)} pair=${trade.pairAddress.slice(0, 12)} ` +
            `dust balance ${onchainBalance.toString()} < 1000 raw — closing DB with 0 pnl`
          );
          const closePersisted = await ctx.tradeStore.closeTrade({
            id: trade.id,
            exitPrice: trade.entryPrice,
            pnl: 0,
            slippage: 0,
            exitReason: 'ORPHAN_DUST_BALANCE',
            exitSlippageBps: undefined,
            decisionPrice: trade.entryPrice,
          }).then((updated) => updated !== false).catch((err) => {
            log.error(`[KOL_HUNTER_RECOVERY_DUST] DB close failed for ${trade.id}: ${err}`);
            return false;
          });
          if (closePersisted) trackRecoveredKolClose(trade, 'ORPHAN_DUST_BALANCE');
          continue;
        }
      } catch (balanceErr) {
        log.warn(
          `[KOL_HUNTER_RECOVERY_ORPHAN] balance check failed for ${trade.pairAddress.slice(0, 12)}: ` +
          `${balanceErr} — falling back to in-memory load`
        );
      }
    }

    // 2. State 추정 — HWM 기준 (cupsey/pure_ws 동일 패턴).
    //    KOL T3 = 9x → safe peak 상한 entryPrice * 20 (outlier 보호).
    const highWaterMark = trade.highWaterMark ?? trade.entryPrice;
    const safePeak = Math.min(highWaterMark, trade.entryPrice * 20);
    const inferredState: LaneTState =
      safePeak >= trade.entryPrice * (1 + config.kolHunterT3Mfe) ? 'RUNNER_T3'
      : safePeak >= trade.entryPrice * (1 + config.kolHunterT2Mfe) ? 'RUNNER_T2'
      : safePeak >= trade.entryPrice * (1 + config.kolHunterT1Mfe) ? 'RUNNER_T1'
      : 'PROBE';

    const entryTimeSec = Math.floor(trade.createdAt.getTime() / 1000);
    const positionId = `kolh-recover-${trade.pairAddress.slice(0, 8)}-${entryTimeSec}`;
    const t2BreakevenLockPrice = (inferredState === 'RUNNER_T2' || inferredState === 'RUNNER_T3')
      ? trade.entryPrice * config.kolHunterT2BreakevenLockMult
      : undefined;

    // parameterVersion / kol metadata 는 DB 미저장 → default 로 fallback (best-effort).
    const recoveredVersion = config.kolHunterParameterVersion;
    const recoveredArmName = armNameForVersion(recoveredVersion);
    const recoveredEntryReason = defaultEntryReasonForVersion(recoveredVersion);
    const recoveredConviction = defaultConvictionForVersion(recoveredVersion);

    const marketReferencePrice = trade.plannedEntryPrice ?? trade.entryPrice;
    // ticketSol: 정책상 fixed 0.01 SOL 이지만 보수적으로 trade row 에서 역산.
    const recoveredTicketSol = trade.entryPrice * trade.quantity;

    const position: PaperPosition = {
      positionId,
      tokenMint: trade.pairAddress,
      state: inferredState,
      entryPrice: trade.entryPrice,
      // 2026-05-01 (Sprint X F1 fix): recovery path 도 명시적 hydrate.
      //   trade.entryPrice 는 wallet-delta 기반 (이미 commit 된 값). cost decomp 은 buy ledger
      //   에서 별도 hydrate 필요 (후속 sprint). 현 단계는 두 값 동일로 fallback — 측정 안전.
      entryPriceTokenOnly: trade.entryPrice,
      entryPriceWalletDelta: trade.entryPrice,
      entryTimeSec,
      ticketSol: recoveredTicketSol,
      quantity: trade.quantity,
      marketReferencePrice,
      peakPrice: safePeak,
      troughPrice: marketReferencePrice,
      lastPrice: marketReferencePrice,
      participatingKols: [],
      kolScore: 0,
      armName: recoveredArmName,
      parameterVersion: recoveredVersion,
      isShadowArm: false,
      kolEntryReason: recoveredEntryReason,
      kolConvictionLevel: recoveredConviction,
      kolReinforcementCount: 0,
      detectorVersion: config.kolHunterDetectorVersion,
      independentKolCount: 0,
      survivalFlags: ['RECOVERED_FROM_DB'],
      t2BreakevenLockPrice,
      isLive: ctx.tradingMode === 'live',
      dbTradeId: trade.id,
      entryTxSignature: trade.txSignature,
      entrySlippageBps: trade.entrySlippageBps,
      // 2026-05-01 (F1 fix): partial take marker — recovery 시 보수적으로 entryTimeSec 으로 set
      // 하여 재진입 후 추가 partial take 차단. 실제로 partial take 이미 발생했는지 DB 에는 정보 없음
      // (parent quantity 와 현 token balance 비교가 정확하나 schema 변경 필요).
      // 보수적 fallback — RUNNER_T1 이상 inferredState 만 marker set (PROBE 는 미발생 가정).
      partialTakeAtSec: (inferredState === 'RUNNER_T1' || inferredState === 'RUNNER_T2' || inferredState === 'RUNNER_T3')
        ? entryTimeSec
        : undefined,
      partialTakeT1AtSec: (inferredState === 'RUNNER_T1' || inferredState === 'RUNNER_T2' || inferredState === 'RUNNER_T3')
        ? entryTimeSec
        : undefined,
    };

    setActivePosition(position);
    ensurePriceListener(trade.pairAddress);
    priceFeed.subscribe(trade.pairAddress);
    recovered++;
    log.info(
      `[KOL_HUNTER_RECOVERED] ${positionId} trade=${trade.id.slice(0, 8)} ` +
      `state=${inferredState} pair=${trade.pairAddress.slice(0, 12)} live=${position.isLive}`
    );
  }

  return recovered;
}

// ─── Test utilities ──────────────────────────────────────

/** 테스트 전용: price feed override + 직접 시뮬레이션. */
export function __testInit(options: {
  priceFeed: PaperPriceFeed;
  ctx?: BotContext;
  securityClient?: OnchainSecurityClient;
  heliusPoolRegistry?: HeliusPoolRegistry;
}): void {
  stopKolHunter();
  setHeliusPoolRegistryForKolHunter(options.heliusPoolRegistry);
  initKolHunter({
    priceFeed: options.priceFeed,
    ctx: options.ctx,
    securityClient: options.securityClient,
    heliusPoolRegistry: options.heliusPoolRegistry,
  });
}

/** 테스트 전용: live canary triple-flag gate 평가 결과 노출. */
export function __testIsLiveCanaryActive(): boolean {
  return isLiveCanaryActive();
}

export function __testCanRouteSmartV3FastCanary(flags: string[]): boolean {
  return canRouteSmartV3FallbackToFastCanary({
    fallback: true,
    reason: 'smart_v3_live_quality_fallback',
    flags,
  });
}

export function __testCanRouteSmartV3FastFailLive(flags: string[]): boolean {
  return canRouteSmartV3FallbackToFastFailLive({
    fallback: true,
    reason: 'smart_v3_fast_fail_live_canary',
    flags,
  });
}

export function __testGetActive(): PaperPosition[] {
  return [...active.values()];
}

export function __testForceResolveStalk(tokenMint: string): Promise<void> {
  const cand = pending.get(tokenMint);
  if (cand?.smartV3) return resolveSmartV3NoTrigger(tokenMint);
  return resolveStalk(tokenMint);
}

export function __testTriggerTick(positionId: string, price: number): void {
  const pos = active.get(positionId);
  if (!pos) return;
  onPriceTick(positionId, {
    tokenMint: pos.tokenMint,
    price,
    outAmountUi: 0.01 / price,
    outputDecimals: 6,
    probeSolAmount: 0.01,
    timestamp: Date.now(),
  });
}

export function __testSetKolLiveSellRetryDelaysMs(delays?: readonly number[]): void {
  if (delays == null) {
    setLiveSellRetryDelaysMsForTests();
    setLiveSellInitialBalanceRetryDelaysMsForTests();
    setLiveSellZeroBalanceConfirmDelaysMsForTests();
    return;
  }
  setLiveSellInitialBalanceRetryDelaysMsForTests(delays);
  setLiveSellZeroBalanceConfirmDelaysMsForTests(delays);
  setLiveSellRetryDelaysMsForTests(delays, 'normal');
  setLiveSellRetryDelaysMsForTests(delays, 'hard_cut');
  setLiveSellRetryDelaysMsForTests(delays, 'structural');
}

export function __testRecordSmartV3ComboClose(
  kolIds: string[],
  pnlSol: number,
  mode: 'paper' | 'live' = 'paper'
): void {
  const key = smartV3ComboKey(kolIds);
  if (!key) return;
  pushSmartV3ComboCloseRecord(key, pnlSol, mode);
}

export function __testRecordRotationLiveKolClose(kolIds: string[], pnlSol: number): void {
  pushRotationLiveKolClose(kolIds, pnlSol, Date.now());
}
