export type CapitulationReboundReason =
  | 'disabled'
  | 'paper_disabled'
  | 'already_entered'
  | 'missing_price'
  | 'hard_veto'
  | 'kol_score_too_low'
  | 'sell_wave'
  | 'drawdown_too_shallow'
  | 'drawdown_too_deep'
  | 'bounce_not_confirmed'
  | 'triggered';

export interface CapitulationReboundPolicyConfig {
  enabled: boolean;
  paperEnabled: boolean;
  minKolScore: number;
  minDrawdownPct: number;
  maxDrawdownPct: number;
  minBouncePct: number;
  requiredRecoveryConfirmations: number;
  maxRecentSellSol: number;
  maxRecentSellKols: number;
}

export interface CapitulationReboundPolicyInput {
  alreadyEntered: boolean;
  currentPrice: number;
  peakPrice: number;
  lowPrice: number;
  kolScore: number;
  preEntrySellSol: number;
  preEntrySellKols: number;
  recoveryConfirmations: number;
  survivalFlags: string[];
  config: CapitulationReboundPolicyConfig;
}

export interface CapitulationReboundTelemetry {
  currentPrice: number;
  peakPrice: number;
  lowPrice: number;
  drawdownFromPeakPct: number;
  bounceFromLowPct: number;
  recoveryConfirmations: number;
  preEntrySellSol: number;
  preEntrySellKols: number;
  kolScore: number;
  hardVetoFlags: string[];
  reboundScore: number;
}

export interface CapitulationReboundDecision {
  triggered: boolean;
  reason: CapitulationReboundReason;
  flags: string[];
  telemetry: CapitulationReboundTelemetry;
}

const HARD_VETO_FLAG_PATTERNS = [
  'NO_SELL_ROUTE',
  'SELL_NO_ROUTE',
  'NO_ROUTE',
  'EXIT_LIQUIDITY_UNKNOWN',
  'NO_SECURITY_DATA',
  'TOKEN_QUALITY_UNKNOWN',
  'TOKEN_2022',
  'UNCLEAN_TOKEN',
  'RUG',
  'LP_REMOVED',
  'HOLDER_TOP1_HIGH',
  'HOLDER_TOP5_HIGH',
  'HOLDER_TOP10_HIGH',
  'HOLDER_HHI_HIGH',
] as const;

export function isCapitulationHardVetoFlag(flag: string): boolean {
  const upper = flag.toUpperCase();
  return HARD_VETO_FLAG_PATTERNS.some((pattern) => upper.includes(pattern)) ||
    upper.startsWith('EXT_') ||
    upper.includes('HIGH_CONCENTRATION');
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function emptyTelemetry(input: CapitulationReboundPolicyInput): CapitulationReboundTelemetry {
  const peak = finitePositive(input.peakPrice) ? input.peakPrice : 0;
  const low = finitePositive(input.lowPrice) ? input.lowPrice : 0;
  const current = finitePositive(input.currentPrice) ? input.currentPrice : 0;
  const drawdownFromPeakPct = peak > 0 && low > 0 ? 1 - low / peak : 0;
  const bounceFromLowPct = low > 0 && current > 0 ? current / low - 1 : 0;
  const hardVetoFlags = input.survivalFlags.filter(isCapitulationHardVetoFlag);
  const reboundScore = buildReboundScore({
    drawdownFromPeakPct,
    bounceFromLowPct,
    recoveryConfirmations: input.recoveryConfirmations,
    requiredRecoveryConfirmations: input.config.requiredRecoveryConfirmations,
    kolScore: input.kolScore,
    preEntrySellSol: input.preEntrySellSol,
    hardVetoCount: hardVetoFlags.length,
  });
  return {
    currentPrice: current,
    peakPrice: peak,
    lowPrice: low,
    drawdownFromPeakPct,
    bounceFromLowPct,
    recoveryConfirmations: input.recoveryConfirmations,
    preEntrySellSol: input.preEntrySellSol,
    preEntrySellKols: input.preEntrySellKols,
    kolScore: input.kolScore,
    hardVetoFlags,
    reboundScore,
  };
}

function decision(
  input: CapitulationReboundPolicyInput,
  reason: CapitulationReboundReason,
  flags: string[],
  triggered = false
): CapitulationReboundDecision {
  return {
    triggered,
    reason,
    flags,
    telemetry: emptyTelemetry(input),
  };
}

function buildReboundScore(input: {
  drawdownFromPeakPct: number;
  bounceFromLowPct: number;
  recoveryConfirmations: number;
  requiredRecoveryConfirmations: number;
  kolScore: number;
  preEntrySellSol: number;
  hardVetoCount: number;
}): number {
  const shock = Math.min(1, Math.max(0, input.drawdownFromPeakPct / 0.5));
  const bounce = Math.min(1, Math.max(0, input.bounceFromLowPct / 0.15));
  const quote = input.requiredRecoveryConfirmations <= 0
    ? 1
    : Math.min(1, input.recoveryConfirmations / input.requiredRecoveryConfirmations);
  const attention = Math.min(1, Math.max(0, input.kolScore / 5));
  const sellPenalty = Math.min(0.4, Math.max(0, input.preEntrySellSol) * 0.05);
  const vetoPenalty = Math.min(0.5, input.hardVetoCount * 0.2);
  return Math.max(0, Math.min(1, 0.25 * attention + 0.25 * shock + 0.30 * quote + 0.20 * bounce - sellPenalty - vetoPenalty));
}

export function evaluateCapitulationReboundPolicy(
  input: CapitulationReboundPolicyInput
): CapitulationReboundDecision {
  const cfg = input.config;
  if (!cfg.enabled) return decision(input, 'disabled', []);
  if (!cfg.paperEnabled) return decision(input, 'paper_disabled', []);
  if (input.alreadyEntered) return decision(input, 'already_entered', []);
  if (!finitePositive(input.currentPrice) || !finitePositive(input.peakPrice) || !finitePositive(input.lowPrice)) {
    return decision(input, 'missing_price', ['CAPITULATION_MISSING_PRICE']);
  }

  const hardVetoFlags = input.survivalFlags.filter(isCapitulationHardVetoFlag);
  if (hardVetoFlags.length > 0) {
    return decision(input, 'hard_veto', ['CAPITULATION_HARD_VETO', ...hardVetoFlags]);
  }
  if (input.kolScore < cfg.minKolScore) {
    return decision(input, 'kol_score_too_low', [`CAPITULATION_KOL_SCORE_${input.kolScore.toFixed(2)}`]);
  }
  if (
    input.preEntrySellSol > cfg.maxRecentSellSol ||
    input.preEntrySellKols > cfg.maxRecentSellKols
  ) {
    return decision(input, 'sell_wave', [
      'CAPITULATION_SELL_WAVE',
      `CAPITULATION_SELL_SOL_${input.preEntrySellSol.toFixed(2)}`,
      `CAPITULATION_SELL_KOLS_${input.preEntrySellKols}`,
    ]);
  }

  const telemetry = emptyTelemetry(input);
  if (telemetry.drawdownFromPeakPct < cfg.minDrawdownPct) {
    return decision(input, 'drawdown_too_shallow', [
      `CAPITULATION_DD_${telemetry.drawdownFromPeakPct.toFixed(4)}`,
    ]);
  }
  if (telemetry.drawdownFromPeakPct > cfg.maxDrawdownPct) {
    return decision(input, 'drawdown_too_deep', [
      `CAPITULATION_DD_${telemetry.drawdownFromPeakPct.toFixed(4)}`,
    ]);
  }
  if (
    telemetry.bounceFromLowPct < cfg.minBouncePct ||
    input.recoveryConfirmations < cfg.requiredRecoveryConfirmations
  ) {
    return decision(input, 'bounce_not_confirmed', [
      `CAPITULATION_BOUNCE_${telemetry.bounceFromLowPct.toFixed(4)}`,
      `CAPITULATION_RECOVERY_CONFIRMATIONS_${input.recoveryConfirmations}`,
    ]);
  }

  return decision(input, 'triggered', [
    'CAPITULATION_REBOUND_V1',
    `CAPITULATION_DD_${telemetry.drawdownFromPeakPct.toFixed(4)}`,
    `CAPITULATION_BOUNCE_${telemetry.bounceFromLowPct.toFixed(4)}`,
    `CAPITULATION_RECOVERY_CONFIRMATIONS_${input.recoveryConfirmations}`,
    `CAPITULATION_SCORE_${telemetry.reboundScore.toFixed(3)}`,
  ], true);
}
