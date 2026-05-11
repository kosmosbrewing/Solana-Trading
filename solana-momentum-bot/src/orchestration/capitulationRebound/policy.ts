export type CapitulationReboundReason =
  | 'disabled'
  | 'paper_disabled'
  | 'already_entered'
  | 'missing_price'
  | 'hard_veto'
  | 'kol_score_too_low'
  | 'sell_wave'
  | 'post_low_sell'
  | 'post_bounce_sell'
  | 'drawdown_too_shallow'
  | 'drawdown_too_deep'
  | 'bounce_not_confirmed'
  | 'rr_too_low'
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

export interface CapitulationReboundRrPolicyConfig extends CapitulationReboundPolicyConfig {
  minRr: number;
  stopBufferPct: number;
  targetPct: number;
  maxPostLowSellSol: number;
  maxPostLowSellKols: number;
  maxPostBounceSellSol: number;
  maxPostBounceSellKols: number;
}

export interface CapitulationReboundPolicyInput {
  alreadyEntered: boolean;
  currentPrice: number;
  peakPrice: number;
  lowPrice: number;
  kolScore: number;
  preEntrySellSol: number;
  preEntrySellKols: number;
  preLowSellSol?: number;
  preLowSellKols?: number;
  postLowSellSol?: number;
  postLowSellKols?: number;
  postBounceSellSol?: number;
  postBounceSellKols?: number;
  recoveryConfirmations: number;
  survivalFlags: string[];
  config: CapitulationReboundPolicyConfig;
}

export interface CapitulationReboundRrPolicyInput
  extends Omit<CapitulationReboundPolicyInput, 'config'> {
  config: CapitulationReboundRrPolicyConfig;
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
  preLowSellSol?: number;
  preLowSellKols?: number;
  postLowSellSol?: number;
  postLowSellKols?: number;
  postBounceSellSol?: number;
  postBounceSellKols?: number;
  kolScore: number;
  hardVetoFlags: string[];
  reboundScore: number;
  entryPrice?: number;
  invalidationPrice?: number;
  targetPrice?: number;
  riskPct?: number;
  rewardPct?: number;
  rr?: number;
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

function finiteNonNegative(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : 0;
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
    preLowSellSol: finiteNonNegative(input.preLowSellSol),
    preLowSellKols: finiteNonNegative(input.preLowSellKols),
    postLowSellSol: finiteNonNegative(input.postLowSellSol),
    postLowSellKols: finiteNonNegative(input.postLowSellKols),
    postBounceSellSol: finiteNonNegative(input.postBounceSellSol),
    postBounceSellKols: finiteNonNegative(input.postBounceSellKols),
    kolScore: input.kolScore,
    hardVetoFlags,
    reboundScore,
  };
}

function rrTelemetry(input: CapitulationReboundRrPolicyInput): CapitulationReboundTelemetry {
  const telemetry = emptyTelemetry(input);
  const entryPrice = telemetry.currentPrice;
  const stopBufferPct = Math.max(0, input.config.stopBufferPct);
  const targetPct = Math.max(0, input.config.targetPct);
  const invalidationPrice = telemetry.lowPrice > 0 ? telemetry.lowPrice * (1 - stopBufferPct) : 0;
  const targetPrice = entryPrice > 0 ? entryPrice * (1 + targetPct) : 0;
  const riskPct = entryPrice > 0 && invalidationPrice > 0
    ? Math.max(0, 1 - invalidationPrice / entryPrice)
    : 0;
  const rewardPct = entryPrice > 0 && targetPrice > 0 ? Math.max(0, targetPrice / entryPrice - 1) : 0;
  const rr = riskPct > 0 ? rewardPct / riskPct : 0;
  return {
    ...telemetry,
    entryPrice,
    invalidationPrice,
    targetPrice,
    riskPct,
    rewardPct,
    rr,
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

export function evaluateCapitulationReboundRrPolicy(
  input: CapitulationReboundRrPolicyInput
): CapitulationReboundDecision {
  const cfg = input.config;
  if (!cfg.enabled) return decision(input, 'disabled', []);
  if (!cfg.paperEnabled) return decision(input, 'paper_disabled', []);
  if (input.alreadyEntered) return decision(input, 'already_entered', []);
  if (!finitePositive(input.currentPrice) || !finitePositive(input.peakPrice) || !finitePositive(input.lowPrice)) {
    return decision(input, 'missing_price', ['CAPITULATION_RR_MISSING_PRICE']);
  }

  const hardVetoFlags = input.survivalFlags.filter(isCapitulationHardVetoFlag);
  if (hardVetoFlags.length > 0) {
    return decision(input, 'hard_veto', ['CAPITULATION_RR_HARD_VETO', ...hardVetoFlags]);
  }
  if (input.kolScore < cfg.minKolScore) {
    return decision(input, 'kol_score_too_low', [`CAPITULATION_RR_KOL_SCORE_${input.kolScore.toFixed(2)}`]);
  }
  if (
    finiteNonNegative(input.postLowSellSol) > cfg.maxPostLowSellSol ||
    finiteNonNegative(input.postLowSellKols) > cfg.maxPostLowSellKols
  ) {
    return decision(input, 'post_low_sell', [
      'CAPITULATION_RR_POST_LOW_SELL',
      `CAPITULATION_RR_POST_LOW_SELL_SOL_${finiteNonNegative(input.postLowSellSol).toFixed(2)}`,
      `CAPITULATION_RR_POST_LOW_SELL_KOLS_${finiteNonNegative(input.postLowSellKols)}`,
    ]);
  }
  if (
    finiteNonNegative(input.postBounceSellSol) > cfg.maxPostBounceSellSol ||
    finiteNonNegative(input.postBounceSellKols) > cfg.maxPostBounceSellKols
  ) {
    return decision(input, 'post_bounce_sell', [
      'CAPITULATION_RR_POST_BOUNCE_SELL',
      `CAPITULATION_RR_POST_BOUNCE_SELL_SOL_${finiteNonNegative(input.postBounceSellSol).toFixed(2)}`,
      `CAPITULATION_RR_POST_BOUNCE_SELL_KOLS_${finiteNonNegative(input.postBounceSellKols)}`,
    ]);
  }

  const telemetry = rrTelemetry(input);
  if (telemetry.drawdownFromPeakPct < cfg.minDrawdownPct) {
    return {
      triggered: false,
      reason: 'drawdown_too_shallow',
      flags: [`CAPITULATION_RR_DD_${telemetry.drawdownFromPeakPct.toFixed(4)}`],
      telemetry,
    };
  }
  if (telemetry.drawdownFromPeakPct > cfg.maxDrawdownPct) {
    return {
      triggered: false,
      reason: 'drawdown_too_deep',
      flags: [`CAPITULATION_RR_DD_${telemetry.drawdownFromPeakPct.toFixed(4)}`],
      telemetry,
    };
  }
  if (
    telemetry.bounceFromLowPct < cfg.minBouncePct ||
    input.recoveryConfirmations < cfg.requiredRecoveryConfirmations
  ) {
    return {
      triggered: false,
      reason: 'bounce_not_confirmed',
      flags: [
        `CAPITULATION_RR_BOUNCE_${telemetry.bounceFromLowPct.toFixed(4)}`,
        `CAPITULATION_RR_RECOVERY_CONFIRMATIONS_${input.recoveryConfirmations}`,
      ],
      telemetry,
    };
  }
  if (!Number.isFinite(telemetry.rr) || (telemetry.rr ?? 0) < cfg.minRr) {
    return {
      triggered: false,
      reason: 'rr_too_low',
      flags: [
        `CAPITULATION_RR_${(telemetry.rr ?? 0).toFixed(3)}`,
        `CAPITULATION_RR_MIN_${cfg.minRr.toFixed(3)}`,
      ],
      telemetry,
    };
  }

  return {
    triggered: true,
    reason: 'triggered',
    flags: [
      'CAPITULATION_REBOUND_RR_V1',
      `CAPITULATION_RR_DD_${telemetry.drawdownFromPeakPct.toFixed(4)}`,
      `CAPITULATION_RR_BOUNCE_${telemetry.bounceFromLowPct.toFixed(4)}`,
      `CAPITULATION_RR_RECOVERY_CONFIRMATIONS_${input.recoveryConfirmations}`,
      `CAPITULATION_RR_${(telemetry.rr ?? 0).toFixed(3)}`,
      `CAPITULATION_RR_SCORE_${telemetry.reboundScore.toFixed(3)}`,
    ],
    telemetry,
  };
}
