import type { KolTradingStyle } from './types';
import type {
  KolPolicyAction,
  KolPolicyBucket,
  KolPolicyConfidence,
  KolPolicyDayQualityBucket,
  KolPolicyDecision,
  KolPolicyIndependentBucket,
  KolPolicyInput,
  KolPolicyLiquidityBucket,
  KolPolicyParticipant,
  KolPolicySecurityBucket,
  KolPolicyStyleBucket,
} from './policyTypes';

const MISSING_SECURITY_FLAGS = ['NO_SECURITY_DATA', 'NO_SECURITY_CLIENT'];
const UNSAFE_SECURITY_FLAGS = [
  'HONEYPOT',
  'FREEZABLE',
  'TRANSFER_FEE',
  'DANGEROUS_EXT',
  'MINTABLE',
  'HIGH_CONCENTRATION',
  'LOW_EXIT_LIQUIDITY',
  'UNCLEAN_TOKEN',
];
const NO_ROUTE_FLAGS = ['NO_SELL_ROUTE', 'SELL_NO_ROUTE', 'NO_ROUTE'];
const HIGH_IMPACT_FLAGS = ['SELL_IMPACT', 'HIGH_IMPACT'];
const STRUCTURAL_CLOSE_REASONS = ['structural_kill_sell_route', 'ORPHAN_NO_BALANCE'];
const SELL_FOLLOW_REASONS = ['insider_exit_full', 'smart_v3_kol_sell_cancel'];
const LIVE_ADVERSE_ENTRY_ADVANTAGE_REVIEW_PCT = 0.05;
const LIVE_EXECUTION_QUALITY_FALLBACK_FLAGS = ['LIVE_EXEC_QUALITY_COOLDOWN'];
const LIVE_FRESH_REFERENCE_FALLBACK_FLAGS = ['LIVE_FRESH_REFERENCE_REJECT'];

function includesFlag(flags: string[], needles: string[]): boolean {
  return flags.some((flag) => needles.some((needle) => flag === needle || flag.startsWith(`${needle}:`)));
}

function finiteNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function summarizeKolStyle(participants: KolPolicyParticipant[]): KolPolicyStyleBucket {
  const styles = new Set<KolTradingStyle>();
  for (const p of participants) {
    if (p.style && p.style !== 'unknown') styles.add(p.style);
  }
  if (styles.size === 0) return 'unknown';
  if (styles.size === 1) return [...styles][0];
  return 'mixed';
}

function bucketIndependent(count: number | undefined): KolPolicyIndependentBucket {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return 'unknown';
  if (count <= 1) return 'single';
  if (count <= 3) return 'multi_2_3';
  return 'multi_4_plus';
}

function bucketSecurity(flags: string[]): KolPolicySecurityBucket {
  if (includesFlag(flags, MISSING_SECURITY_FLAGS)) return 'missing_security';
  if (includesFlag(flags, UNSAFE_SECURITY_FLAGS)) return 'unsafe';
  return 'clean_or_unknown';
}

function bucketLiquidity(input: KolPolicyInput): KolPolicyLiquidityBucket {
  const flags = input.survivalFlags ?? [];
  if (input.routeFound === false || includesFlag(flags, NO_ROUTE_FLAGS)) return 'no_route';
  if ((input.sellImpactPct ?? 0) >= 0.10 || includesFlag(flags, HIGH_IMPACT_FLAGS)) return 'high_impact';
  return 'route_ok_or_unknown';
}

function bucketDayQuality(input: KolPolicyInput): KolPolicyDayQualityBucket {
  if ((input.recentJupiter429 ?? 0) >= 20) return 'stressed';
  return 'unknown';
}

export function buildKolPolicyBucket(input: KolPolicyInput): KolPolicyBucket {
  return {
    eventKind: input.eventKind,
    style: summarizeKolStyle(input.participatingKols),
    entryReason: input.entryReason ?? 'unknown',
    independentKolBucket: bucketIndependent(input.independentKolCount),
    securityBucket: bucketSecurity(input.survivalFlags ?? []),
    liquidityBucket: bucketLiquidity(input),
    dayQualityBucket: bucketDayQuality(input),
  };
}

function chooseAction(input: KolPolicyInput, bucket: KolPolicyBucket): {
  action: KolPolicyAction;
  confidence: KolPolicyConfidence;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (input.eventKind === 'close') {
    if (bucket.liquidityBucket === 'no_route') {
      return { action: 'exit', confidence: 'high', reasons: ['sell_route_missing'] };
    }
    if (bucket.liquidityBucket === 'high_impact') {
      return { action: 'exit', confidence: 'medium', reasons: ['sell_impact_high'] };
    }
    if (STRUCTURAL_CLOSE_REASONS.includes(input.closeReason ?? '')) {
      return { action: 'exit', confidence: 'high', reasons: ['structural_close_reason'] };
    }
    if (bucket.securityBucket === 'missing_security') reasons.push('missing_security_data_close_context');
    if (bucket.securityBucket === 'unsafe') reasons.push('unsafe_security_flags_close_context');
    if (SELL_FOLLOW_REASONS.includes(input.closeReason ?? '')) {
      if (bucket.style === 'scalper') {
        return { action: 'reduce', confidence: 'medium', reasons: ['scalper_sell_follow_downweighted'] };
      }
      if (bucket.style === 'longhold' || bucket.style === 'swing') {
        return { action: 'exit', confidence: 'medium', reasons: [`${bucket.style}_sell_follow`] };
      }
      reasons.push('unknown_or_mixed_sell_follow_conservative');
    }
    return { action: input.currentAction, confidence: 'low', reasons: reasons.length > 0 ? reasons : ['close_policy_pass_through'] };
  }

  if (input.eventKind === 'entry') {
    if (input.isLive && (input.independentKolCount ?? 0) < 2) {
      return { action: 'paper_fallback', confidence: 'high', reasons: ['single_kol_live_not_enough'] };
    }
    if (input.isLive && includesFlag(input.survivalFlags ?? [], LIVE_EXECUTION_QUALITY_FALLBACK_FLAGS)) {
      return {
        action: 'paper_fallback',
        confidence: 'high',
        reasons: ['live_execution_quality_cooldown'],
      };
    }
    if (input.isLive && includesFlag(input.survivalFlags ?? [], LIVE_FRESH_REFERENCE_FALLBACK_FLAGS)) {
      return {
        action: 'paper_fallback',
        confidence: 'high',
        reasons: ['live_fresh_reference_reject'],
      };
    }
    if (
      input.isLive &&
      typeof input.entryAdvantagePct === 'number' &&
      Number.isFinite(input.entryAdvantagePct) &&
      input.entryAdvantagePct >= LIVE_ADVERSE_ENTRY_ADVANTAGE_REVIEW_PCT
    ) {
      return {
        action: 'paper_fallback',
        confidence: input.entryAdvantagePct >= 0.2 ? 'high' : 'medium',
        reasons: [`adverse_entry_advantage_pct=${input.entryAdvantagePct.toFixed(6)}`],
      };
    }
    if (input.isLive && bucket.dayQualityBucket === 'stressed') {
      return { action: 'paper_fallback', confidence: 'medium', reasons: ['jupiter_rate_limit_stress'] };
    }
    if (bucket.securityBucket === 'missing_security') {
      return { action: 'block', confidence: 'high', reasons: ['missing_security_data'] };
    }
    if (bucket.securityBucket === 'unsafe') {
      return { action: 'block', confidence: 'high', reasons: ['unsafe_security_flags'] };
    }
    if (bucket.liquidityBucket === 'no_route') {
      return { action: 'block', confidence: 'high', reasons: ['sell_route_missing'] };
    }
    if (bucket.liquidityBucket === 'high_impact') {
      return {
        action: 'paper_fallback',
        confidence: 'medium',
        reasons: ['sell_impact_high'],
      };
    }
    return { action: input.currentAction, confidence: 'low', reasons: ['entry_policy_pass_through'] };
  }

  if (bucket.securityBucket === 'missing_security') {
    return { action: 'block', confidence: 'high', reasons: ['missing_security_data'] };
  }
  if (bucket.securityBucket === 'unsafe') {
    return { action: 'block', confidence: 'high', reasons: ['unsafe_security_flags'] };
  }
  if (bucket.liquidityBucket === 'no_route') {
    return { action: 'block', confidence: 'high', reasons: ['sell_route_missing'] };
  }
  if (bucket.liquidityBucket === 'high_impact') {
    return {
      action: 'block',
      confidence: 'medium',
      reasons: ['sell_impact_high'],
    };
  }

  return { action: input.currentAction, confidence: 'low', reasons: ['reject_policy_observed'] };
}

export function evaluateKolShadowPolicy(input: KolPolicyInput, generatedAt = new Date().toISOString()): KolPolicyDecision {
  const bucket = buildKolPolicyBucket(input);
  const chosen = chooseAction(input, bucket);
  const flags = input.survivalFlags ?? [];
  return {
    schemaVersion: 'kol-policy-shadow/v1',
    generatedAt,
    eventKind: input.eventKind,
    tokenMint: input.tokenMint,
    bucket,
    currentAction: input.currentAction,
    recommendedAction: chosen.action,
    divergence: chosen.action !== input.currentAction,
    confidence: chosen.confidence,
    reasons: chosen.reasons,
    riskFlags: flags,
    metrics: {
      isLive: input.isLive,
      isShadowArm: input.isShadowArm ?? false,
      independentKolCount: finiteNumber(input.independentKolCount),
      effectiveIndependentCount: finiteNumber(input.effectiveIndependentCount),
      kolScore: finiteNumber(input.kolScore),
      mfePct: finiteNumber(input.mfePct),
      maePct: finiteNumber(input.maePct),
      peakDriftPct: finiteNumber(input.peakDriftPct),
      holdSec: finiteNumber(input.holdSec),
      walletSol: finiteNumber(input.walletSol),
      recentJupiter429: finiteNumber(input.recentJupiter429),
      routeFound: typeof input.routeFound === 'boolean' ? input.routeFound : null,
      sellImpactPct: finiteNumber(input.sellImpactPct),
      entryAdvantagePct: finiteNumber(input.entryAdvantagePct),
      swapQuoteEntryAdvantagePct: finiteNumber(input.swapQuoteEntryAdvantagePct),
      referenceToSwapQuotePct: finiteNumber(input.referenceToSwapQuotePct),
      buyExecutionMs: finiteNumber(input.buyExecutionMs),
    },
    context: {
      armName: input.armName ?? null,
      entryReason: input.entryReason ?? null,
      closeReason: input.closeReason ?? null,
      rejectReason: input.rejectReason ?? null,
      source: input.source ?? null,
      parameterVersion: input.parameterVersion ?? null,
      signalSource: input.signalSource ?? null,
      survivalReason: input.survivalReason ?? null,
      participatingKols: input.participatingKols,
      survivalFlags: flags,
    },
  };
}
