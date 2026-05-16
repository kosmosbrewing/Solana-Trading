import type { KolTier, KolTradingStyle } from './types';

export type KolPolicyEventKind = 'entry' | 'close' | 'reject';
export type KolPolicyAction = 'enter' | 'block' | 'paper_fallback' | 'hold' | 'reduce' | 'exit';
export type KolPolicyConfidence = 'low' | 'medium' | 'high';
export type KolPolicyStyleBucket = KolTradingStyle | 'mixed';
export type KolPolicyIndependentBucket = 'single' | 'multi_2_3' | 'multi_4_plus' | 'unknown';
export type KolPolicySecurityBucket = 'clean_or_unknown' | 'missing_security' | 'unsafe';
export type KolPolicyLiquidityBucket = 'route_ok_or_unknown' | 'no_route' | 'high_impact';
export type KolPolicyDayQualityBucket = 'normal' | 'stressed' | 'unknown';

export interface KolPolicyParticipant {
  id: string;
  tier: KolTier;
  timestamp?: number;
  style?: KolTradingStyle;
}

export interface KolPolicyBucket {
  eventKind: KolPolicyEventKind;
  style: KolPolicyStyleBucket;
  entryReason: string;
  independentKolBucket: KolPolicyIndependentBucket;
  securityBucket: KolPolicySecurityBucket;
  liquidityBucket: KolPolicyLiquidityBucket;
  dayQualityBucket: KolPolicyDayQualityBucket;
}

export interface KolPolicyInput {
  eventKind: KolPolicyEventKind;
  tokenMint: string;
  currentAction: KolPolicyAction;
  isLive: boolean;
  isShadowArm?: boolean;
  armName?: string;
  entryReason?: string;
  closeReason?: string;
  rejectReason?: string;
  source?: string;
  parameterVersion?: string;
  signalSource?: string;
  survivalReason?: string;
  independentKolCount?: number;
  effectiveIndependentCount?: number;
  kolScore?: number;
  participatingKols: KolPolicyParticipant[];
  survivalFlags?: string[];
  routeFound?: boolean;
  sellImpactPct?: number;
  entryAdvantagePct?: number;
  swapQuoteEntryAdvantagePct?: number;
  referenceToSwapQuotePct?: number;
  buyExecutionMs?: number;
  mfePct?: number;
  maePct?: number;
  peakDriftPct?: number;
  holdSec?: number;
  walletSol?: number;
  recentJupiter429?: number;
}

export interface KolPolicyDecision {
  schemaVersion: 'kol-policy-shadow/v1';
  generatedAt: string;
  eventKind: KolPolicyEventKind;
  tokenMint: string;
  bucket: KolPolicyBucket;
  currentAction: KolPolicyAction;
  recommendedAction: KolPolicyAction;
  divergence: boolean;
  confidence: KolPolicyConfidence;
  reasons: string[];
  riskFlags: string[];
  metrics: {
    isLive: boolean;
    isShadowArm: boolean;
    independentKolCount: number | null;
    effectiveIndependentCount: number | null;
    kolScore: number | null;
    mfePct: number | null;
    maePct: number | null;
    peakDriftPct: number | null;
    holdSec: number | null;
    walletSol: number | null;
    recentJupiter429: number | null;
    routeFound: boolean | null;
    sellImpactPct: number | null;
    entryAdvantagePct: number | null;
    swapQuoteEntryAdvantagePct: number | null;
    referenceToSwapQuotePct: number | null;
    buyExecutionMs: number | null;
  };
  context: {
    armName: string | null;
    entryReason: string | null;
    closeReason: string | null;
    rejectReason: string | null;
    source?: string | null;
    parameterVersion?: string | null;
    signalSource?: string | null;
    survivalReason?: string | null;
    participatingKols: KolPolicyParticipant[];
    survivalFlags: string[];
  };
}
