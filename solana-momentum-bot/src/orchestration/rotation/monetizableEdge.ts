import { estimateBleed, type Venue } from '../../execution/bleedModel';

export interface RotationMonetizableEdgeConfig {
  enabled: boolean;
  maxCostRatio: number;
  assumedAtaRentSol: number;
  priorityFeeSol: number;
  tipSol: number;
  entrySlippageBps: number;
  quickExitSlippageBps: number;
}

export interface RotationMonetizableEdgeEstimate {
  schemaVersion: 'rotation-monetizable-edge/v1';
  shadowOnly: true;
  pass: boolean;
  reason: 'cost_ratio_ok' | 'cost_ratio_exceeded' | 'invalid_ticket';
  ticketSol: number;
  venue: Venue;
  maxCostRatio: number;
  walletDragRatio: number;
  costRatio: number;
  irreversibleCostSol: number;
  totalCostSol: number;
  ataRentSol: number;
  recoverableRentSol: number;
  walletDragSol: number;
  bleedTotalSol: number;
  baseFeeSol: number;
  priorityFeeSol: number;
  tipSol: number;
  venueFeeSol: number;
  entrySlippageSol: number;
  quickExitSlippageSol: number;
  requiredGrossMovePct: number;
}

function normalizeVenue(value: string | undefined): Venue {
  if (value === 'raydium' || value === 'pumpswap' || value === 'meteora' || value === 'orca') return value;
  return 'unknown';
}

export function buildRotationMonetizableEdgeEstimate(input: {
  ticketSol: number;
  venue?: string;
  config: RotationMonetizableEdgeConfig;
}): RotationMonetizableEdgeEstimate | null {
  if (!input.config.enabled) return null;
  const ticketSol = input.ticketSol;
  const venue = normalizeVenue(input.venue);
  if (!Number.isFinite(ticketSol) || ticketSol <= 0) {
    return {
      schemaVersion: 'rotation-monetizable-edge/v1',
      shadowOnly: true,
      pass: false,
      reason: 'invalid_ticket',
      ticketSol,
      venue,
      maxCostRatio: input.config.maxCostRatio,
      walletDragRatio: Infinity,
      costRatio: Infinity,
      irreversibleCostSol: Infinity,
      totalCostSol: Infinity,
      ataRentSol: input.config.assumedAtaRentSol,
      recoverableRentSol: input.config.assumedAtaRentSol,
      walletDragSol: Infinity,
      bleedTotalSol: Infinity,
      baseFeeSol: 0,
      priorityFeeSol: 0,
      tipSol: 0,
      venueFeeSol: 0,
      entrySlippageSol: 0,
      quickExitSlippageSol: 0,
      requiredGrossMovePct: Infinity,
    };
  }

  const bleed = estimateBleed(venue, {
    ticketSol,
    priorityFeeSol: input.config.priorityFeeSol,
    tipSol: input.config.tipSol,
    entrySlippageBps: input.config.entrySlippageBps,
    quickExitSlippageBps: input.config.quickExitSlippageBps,
  });
  const recoverableRentSol = Math.max(0, input.config.assumedAtaRentSol);
  const irreversibleCostSol = bleed.totalSol;
  const walletDragSol = recoverableRentSol + irreversibleCostSol;
  const costRatio = irreversibleCostSol / ticketSol;
  const walletDragRatio = walletDragSol / ticketSol;
  const pass = costRatio <= input.config.maxCostRatio;
  return {
    schemaVersion: 'rotation-monetizable-edge/v1',
    shadowOnly: true,
    pass,
    reason: pass ? 'cost_ratio_ok' : 'cost_ratio_exceeded',
    ticketSol,
    venue,
    maxCostRatio: input.config.maxCostRatio,
    walletDragRatio,
    costRatio,
    irreversibleCostSol,
    totalCostSol: irreversibleCostSol,
    ataRentSol: recoverableRentSol,
    recoverableRentSol,
    walletDragSol,
    bleedTotalSol: bleed.totalSol,
    baseFeeSol: bleed.baseFeeSol,
    priorityFeeSol: bleed.priorityFeeSol,
    tipSol: bleed.tipSol,
    venueFeeSol: bleed.venueFeeSol,
    entrySlippageSol: bleed.entrySlippageSol,
    quickExitSlippageSol: bleed.quickExitSlippageSol,
    requiredGrossMovePct: costRatio,
  };
}
