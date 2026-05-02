export const PURE_WS_BOTFLOW_EVENT_SCHEMA_VERSION = 'pure-ws-botflow-event/v1' as const;
export const PURE_WS_BOTFLOW_CANDIDATE_SCHEMA_VERSION = 'pure-ws-botflow-candidate/v1' as const;
export const PURE_WS_BOTFLOW_MARKOUT_SCHEMA_VERSION = 'pure-ws-botflow-markout/v1' as const;
export const PURE_WS_BOTFLOW_PAPER_SCHEMA_VERSION = 'pure-ws-botflow-paper/v1' as const;

export type PureWsBotflowSide = 'buy' | 'sell';
export type PureWsBotflowDecision = 'observe' | 'reject';
export type PureWsBotflowQuoteStatus = 'ok' | 'missing_price_trajectory' | 'bad_entry_price';
export type PureWsBotflowBotProfile = 'custom' | 'gygj_legacy' | 'mayhem_current';
export type PureWsBotflowWalletRole = 'custom_research' | 'legacy_community_sample' | 'official_mayhem_agent';
export type PureWsBotflowProvenanceConfidence = 'user_supplied' | 'community_claim_unverified' | 'official_current';
export type PureWsBotflowMayhemLifecycle = 'active_lt_24h' | 'completed' | 'unknown';

export interface EnhancedTokenTransferLike {
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount?: number;
  mint?: string;
}

export interface EnhancedAccountDataLike {
  account?: string;
  nativeBalanceChange?: number;
}

export interface EnhancedTransactionLike {
  signature?: string;
  timestamp?: number;
  type?: string;
  source?: string;
  feePayer?: string;
  tokenTransfers?: EnhancedTokenTransferLike[];
  accountData?: EnhancedAccountDataLike[];
}

export interface PureWsBotflowEvent {
  schemaVersion: typeof PURE_WS_BOTFLOW_EVENT_SCHEMA_VERSION;
  eventId: string;
  observedAt: string;
  timestampMs: number;
  txSignature: string;
  feePayer: string;
  source: string;
  txType: string;
  tokenMint: string;
  side: PureWsBotflowSide;
  tradingUser: string;
  counterparty: string;
  solAmount: number;
  tokenAmount: number;
  flowPriceSolPerToken: number;
}

export interface PureWsBotflowPricePoint {
  tokenMint: string;
  timestampMs: number;
  priceSol: number;
  source?: string;
}

export interface BotflowCandidateThresholds {
  minBuyCount: number;
  minSmallBuyCount: number;
  minGrossBuySol: number;
  minNetFlowSol: number;
  minBuySellRatio: number;
  smallBuyMaxSol: number;
}

export interface BuildBotflowCandidatesOptions {
  windowSecs: number[];
  thresholds: BotflowCandidateThresholds;
  source?: string;
  botProfile?: PureWsBotflowBotProfile;
  walletRole?: PureWsBotflowWalletRole;
  provenanceConfidence?: PureWsBotflowProvenanceConfidence;
  pairAgeByMint?: Map<string, number>;
  pairContextByMint?: Map<string, PureWsBotflowPairContext>;
  securityFlagsByMint?: Map<string, string[]>;
  qualityFlagsByMint?: Map<string, string[]>;
  estimatedRoundTripCostPct?: number;
}

export interface PureWsBotflowPairContext {
  tokenMint: string;
  pairAddress?: string;
  poolAddress?: string;
  dexId?: string;
  pairCreatedAtMs?: number;
  contextObservedAtMs?: number;
  knownPoolCount?: number;
  poolPrewarmSuccess?: boolean;
  poolPrewarmSkipReason?: string;
  mayhemMode?: boolean;
  mayhemAgentWalletSeen?: boolean;
  mayhemProgramSeen?: boolean;
  mayhemLifecycle?: PureWsBotflowMayhemLifecycle;
  securityFlags?: string[];
  qualityFlags?: string[];
}

export interface PureWsBotflowCandidate {
  schemaVersion: typeof PURE_WS_BOTFLOW_CANDIDATE_SCHEMA_VERSION;
  candidateId: string;
  observedAt: string;
  tokenMint: string;
  pairAddress?: string;
  poolAddress?: string;
  dexId?: string;
  pairAgeSec?: number;
  pairContextObservedAt?: string;
  pairContextAgeSec?: number;
  knownPoolCount?: number;
  poolPrewarmSuccess?: boolean;
  poolPrewarmSkipReason?: string;
  botProfile?: PureWsBotflowBotProfile;
  walletRole?: PureWsBotflowWalletRole;
  provenanceConfidence?: PureWsBotflowProvenanceConfidence;
  mayhemMode?: boolean;
  mayhemLifecycle?: PureWsBotflowMayhemLifecycle;
  source: string;
  windowSec: number;
  windowStartMs: number;
  windowEndMs: number;
  buyCount: number;
  sellCount: number;
  buySol: number;
  sellSol: number;
  netFlowSol: number;
  buySellRatio: number;
  smallBuyCount: number;
  topupCount: number;
  uniqueFeePayers: number;
  uniqueSubAccounts: number;
  sameFeePayerRepetition: number;
  lastBuyAgeMs?: number;
  lastSellAgeMs?: number;
  securityFlags: string[];
  qualityFlags: string[];
  estimatedRoundTripCostPct?: number;
  postCostDeltaEstimatePct?: number;
  flowAnchorPriceSol?: number;
  decision: PureWsBotflowDecision;
  rejectReason?: string;
}

export interface BuildBotflowMarkoutsOptions {
  horizonsSec: number[];
  roundTripCostPct: number;
  maxMarkoutLagMs?: number;
  pricePoints?: PureWsBotflowPricePoint[];
}

export interface PureWsBotflowMarkout {
  schemaVersion: typeof PURE_WS_BOTFLOW_MARKOUT_SCHEMA_VERSION;
  eventId: string;
  candidateId: string;
  observedAt: string;
  tokenMint: string;
  horizonSec: number;
  quoteStatus: PureWsBotflowQuoteStatus;
  entryPriceSol?: number;
  markoutPriceSol?: number;
  deltaPct?: number;
  postCostDeltaPct?: number;
  priceSource?: string;
  markoutLagMs?: number;
}

export type PureWsBotflowPaperExitReason =
  | 't2_take_profit'
  | 't1_take_profit'
  | 'hard_cut'
  | 'max_hold'
  | 'missing_entry_price'
  | 'missing_price_trajectory';

export interface PureWsBotflowPaperConfig {
  ticketSol: number;
  hardCutPostCostPct: number;
  t1GrossPct: number;
  t1PostCostPct: number;
  t2GrossPct: number;
  t2PostCostPct: number;
  maxHoldSec: number;
}

export interface PureWsBotflowPaperTrade {
  schemaVersion: typeof PURE_WS_BOTFLOW_PAPER_SCHEMA_VERSION;
  paperTradeId: string;
  candidateId: string;
  observedAt: string;
  tokenMint: string;
  entryAt: string;
  exitAt?: string;
  horizonSec?: number;
  ticketSol: number;
  entryPriceSol?: number;
  exitPriceSol?: number;
  deltaPct?: number;
  postCostDeltaPct?: number;
  simulatedNetSol?: number;
  exitReason: PureWsBotflowPaperExitReason;
  decisionContext: {
    windowSec: number;
    buyCount: number;
    sellCount: number;
    netFlowSol: number;
    pairAgeSec?: number;
    qualityFlags: string[];
  };
}
