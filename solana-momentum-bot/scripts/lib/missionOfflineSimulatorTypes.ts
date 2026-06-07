export type MissionDecisionState =
  | 'KILL'
  | 'QUARANTINE'
  | 'RESEARCH_ONLY'
  | 'COLLECT_OFFLINE'
  | 'MICRO_CANARY_READY'
  | 'COMPOUNDING_CANDIDATE';

export type EvidenceRole =
  | 'live'
  | 'paper_mirror'
  | 'fallback_execution_safety'
  | 'research_arm'
  | 'shadow'
  | 'paper_research'
  | 'no_trade_markout'
  | 'diagnostic_only'
  | 'unknown_role';

export type JoinMethod =
  | 'decision_execution_plan'
  | 'candidate_id'
  | 'position_id'
  | 'parent_position_id'
  | 'tx_signature'
  | 'token_time'
  | 'unjoined';

export type NetSource = 'wallet_truth' | 'refund_adjusted' | 'paper_net';

export interface DataFileSummary {
  file: string;
  rows: number;
}

export interface RoleSummary {
  role: EvidenceRole;
  rows: number;
  netSol: number;
}

export interface JoinSummary {
  inputRows: number;
  eligibleRows: number;
  joinedRows: number;
  unjoinedRows: number;
  joinCoveragePct: number | null;
  promotionGradeJoinCoveragePct: number | null;
  joinMethodCounts: Record<JoinMethod, number>;
}

export interface BaselineReplaySummary {
  liveRows: number;
  liveNetSol: number;
  paperRows: number;
  paperNetSol: number;
  winRate: number | null;
  maxDrawdownSol: number;
  maxLossStreak: number;
  top5WinnerShare: number | null;
  top10WinnerShare: number | null;
  roleSummaries: RoleSummary[];
  joinSummary: JoinSummary;
}

export interface AdmissionVetoRow {
  reason: string;
  rows: number;
  removedNetSol: number;
  savedLossSol: number;
  missedRunner50Count: number;
  missedRunner5xCount: number;
  falseNegativeRate: number | null;
  netAfterVetoSol: number;
}

export interface AdmissionVetoCombinationRow extends AdmissionVetoRow {
  reasons: string[];
  maxLossStreakAfterVeto: number;
  decision: MissionDecisionState;
  decisionReasons: string[];
}

export interface ProbeFirstSummary {
  rows: number;
  baselineMedianT300Pct: number | null;
  simulatedMedianPct: number | null;
  baselinePositiveRate: number | null;
  simulatedPositiveRate: number | null;
  fail15Rows: number;
  pass30Rows: number;
  leakageVerdict: 'PASS';
}

export interface RotationBridgeSummary {
  rows: number;
  activeDays: number;
  refundAdjustedNetSol: number;
  walletStressNetSol: number;
  postCostPositiveRatio: number | null;
  maxLossStreak: number;
  top5WinnerShare: number | null;
  top10WinnerShare: number | null;
  executionPlanHashCoveragePct: number | null;
  routeProofCoveragePct: number | null;
  costAwareCoveragePct: number | null;
  comparableRoleCoveragePct: number | null;
  chronologicalSlices: ChronologicalSliceSummary[];
  candidateCohorts: RotationCandidateCohortSummary[];
  stressSource: string;
  decision: MissionDecisionState;
  reasons: string[];
}

export interface RotationCandidateCohortSummary {
  cohort: string;
  rows: number;
  activeDays: number;
  refundAdjustedNetSol: number;
  walletStressNetSol: number;
  postCostPositiveRatio: number | null;
  maxLossStreak: number;
  top5WinnerShare: number | null;
  top10WinnerShare: number | null;
  executionPlanHashCoveragePct: number | null;
  routeProofCoveragePct: number | null;
  costAwareCoveragePct: number | null;
  comparableRoleCoveragePct: number | null;
  failedChronologicalSlices: number;
  leakageVerdict: 'PASS' | 'FAIL';
  decision: MissionDecisionState;
  reasons: string[];
}

export interface ChronologicalSliceSummary {
  slice: string;
  start: string;
  end: string;
  rows: number;
  activeDays: number;
  walletStressNetSol: number;
  postCostPositiveRatio: number | null;
  maxLossStreak: number;
  verdict: 'PASS' | 'FAIL' | 'DATA_GAP';
  reasons: string[];
}

export interface SmartV3QuarantineSummary {
  rows: number;
  liveRows: number;
  netSol: number;
  runner50Count: number;
  runner5xCount: number;
  maxLossStreak: number;
  lossPer5xSol: number | null;
  decision: MissionDecisionState;
  reasons: string[];
}

export interface ApiCostSummaryRow {
  key: string;
  credits: number;
  requests: number;
  rows: number;
}

export interface ApiCostActionRow {
  feature: string;
  credits: number;
  sharePct: number | null;
  action: 'disable_or_hard_cap' | 'coalesce_or_cache' | 'budget_queue' | 'keep_with_metering';
  decision: MissionDecisionState;
  reason: string;
}

export interface ApiCostSummary {
  rows: number;
  estimatedCredits: number;
  byFeature: ApiCostSummaryRow[];
  byPurpose: ApiCostSummaryRow[];
  actions: ApiCostActionRow[];
  decision: MissionDecisionState;
  reasons: string[];
}

export interface MicroCanaryRuinSummary {
  sourceCohort: string;
  rows: number;
  windowSize: number;
  windows: number;
  positiveWindowRate: number | null;
  sleeveRuinRate: number | null;
  worstWindowNetSol: number | null;
  expectedWindowNetSol: number | null;
  decision: MissionDecisionState;
  reasons: string[];
}

export interface FinalDecisionRow {
  cohort: string;
  decision: MissionDecisionState;
  reasons: string[];
}

export interface MissionOfflineSimulatorReport {
  generatedAt: string;
  realtimeDir: string;
  reportsDir: string;
  protocol: string;
  dataFiles: DataFileSummary[];
  baseline: BaselineReplaySummary;
  admissionVeto: AdmissionVetoRow[];
  admissionVetoCombinations: AdmissionVetoCombinationRow[];
  probeFirst: ProbeFirstSummary;
  rotationBridge: RotationBridgeSummary;
  smartV3: SmartV3QuarantineSummary;
  apiCost: ApiCostSummary;
  microCanary: MicroCanaryRuinSummary;
  finalDecisions: FinalDecisionRow[];
}
