import {
  buildRotationChaseTopupMetrics,
  buildRotationFlowMetrics,
} from '../src/orchestration/rotation/flowMetrics';
import {
  decideRotationFlowExit,
  decideRotationFlowPriceKill,
} from '../src/orchestration/rotation/flowExitPolicy';
import { buildRotationMonetizableEdgeEstimate } from '../src/orchestration/rotation/monetizableEdge';
import type { KolTx } from '../src/kol/types';

function tx(partial: Partial<KolTx> & Pick<KolTx, 'kolId' | 'action' | 'timestamp'>): KolTx {
  return {
    kolId: partial.kolId,
    walletAddress: `wallet_${partial.kolId}`,
    tier: partial.tier ?? 'A',
    tokenMint: partial.tokenMint ?? 'MintRotationFlow111111111111111111111',
    action: partial.action,
    timestamp: partial.timestamp,
    txSignature: `${partial.action}_${partial.kolId}_${partial.timestamp}`,
    solAmount: partial.solAmount,
    tokenAmount: partial.tokenAmount,
  };
}

describe('rotation flow metrics', () => {
  const cfg = {
    sellPressureWindowSec: 30,
    freshTopupSec: 60,
    chaseStepPct: 0.015,
  };

  it('computes sellPressure30 from anchor sell size over pre-sell buy inventory', () => {
    const metrics = buildRotationFlowMetrics({
      rows: [
        tx({ kolId: 'decu', action: 'buy', timestamp: 1_000, solAmount: 1.0, tokenAmount: 1_000 }),
        tx({ kolId: 'decu', action: 'buy', timestamp: 2_000, solAmount: 0.2, tokenAmount: 180 }),
        tx({ kolId: 'decu', action: 'sell', timestamp: 7_000, solAmount: 0.9 }),
        tx({ kolId: 'decu', action: 'sell', timestamp: 12_000, solAmount: 0.3 }),
      ],
      tokenMint: 'MintRotationFlow111111111111111111111',
      anchorKolIds: ['decu'],
      entryAtMs: 5_000,
      nowMs: 20_000,
      config: cfg,
    });

    expect(metrics.anchorBuySolBeforeFirstSell).toBeCloseTo(1.2);
    expect(metrics.anchorSellSol30).toBeCloseTo(1.2);
    expect(metrics.sellPressure30).toBeCloseTo(1.0);
    expect(metrics.flowRiskLevel).toBe('high');
  });

  it('detects chase top-up when a later buy pays materially higher fill price', () => {
    const buys = [
      tx({ kolId: 'dv', action: 'buy', timestamp: 1_000, solAmount: 1, tokenAmount: 1_000 }),
      tx({ kolId: 'dv', action: 'buy', timestamp: 2_000, solAmount: 0.2, tokenAmount: 190 }),
    ];
    const chase = buildRotationChaseTopupMetrics({
      buys,
      entryAtMs: 1_000,
      chaseStepPct: 0.015,
    });

    expect(chase.chaseTopupCount).toBe(1);
    expect(chase.chaseTopupSol).toBeCloseTo(0.2);
    expect(chase.maxStepPct).toBeGreaterThan(0.04);
  });

  it('treats freshTopup as post-entry anchor buying only', () => {
    const metrics = buildRotationFlowMetrics({
      rows: [
        tx({ kolId: 'dv', action: 'buy', timestamp: 1_000, solAmount: 1, tokenAmount: 1_000 }),
        tx({ kolId: 'dv', action: 'buy', timestamp: 1_400, solAmount: 0.2, tokenAmount: 190 }),
      ],
      tokenMint: 'MintRotationFlow111111111111111111111',
      anchorKolIds: ['dv'],
      entryAtMs: 1_500,
      nowMs: 2_000,
      config: cfg,
    });

    expect(metrics.postEntryBuySol).toBe(0);
    expect(metrics.postEntryTopupCount).toBe(0);
    expect(metrics.freshTopup).toBe(false);
  });

  it('maps sell pressure to hold/reduce/full-exit decisions', () => {
    const policy = {
      lightReducePressure: 0.2,
      strongReducePressure: 0.5,
      fullExitPressure: 0.8,
      criticalExitPressure: 1.2,
      lightReducePct: 0.35,
      strongReducePct: 0.75,
      residualHoldSec: 75,
    };
    const base = {
      anchorBuySolBeforeFirstSell: 1,
      anchorSellSol30: 0,
      sellPressure30: 0,
      firstAnchorSellAtMs: null,
      lastAnchorBuyAtMs: null,
      postEntryBuySol: 0,
      postEntryTopupCount: 0,
      chaseTopupCount: 0,
      topupStrength: 0,
      chaseTopupStrength: 0,
      freshTopup: false,
      flowRiskLevel: 'none' as const,
    };

    expect(decideRotationFlowExit({ ...base, sellPressure30: 0.1 }, policy).action).toBe('hold');
    expect(decideRotationFlowExit({ ...base, sellPressure30: 0.3 }, policy).action).toBe('reduce_light');
    expect(decideRotationFlowExit({ ...base, sellPressure30: 0.6 }, policy).action).toBe('reduce_strong');
    expect(decideRotationFlowExit({ ...base, sellPressure30: 0.9 }, policy).action).toBe('close_full');
    expect(decideRotationFlowPriceKill({ ...base, sellPressure30: 0.1, freshTopup: true }, policy).action)
      .toBe('reduce_strong');
  });
});

describe('rotation monetizable edge', () => {
  it('fails small tickets when ATA rent and execution drag exceed the cost-ratio ceiling', () => {
    const estimate = buildRotationMonetizableEdgeEstimate({
      ticketSol: 0.02,
      venue: 'pumpswap',
      config: {
        enabled: true,
        maxCostRatio: 0.06,
        assumedAtaRentSol: 0.00207408,
        priorityFeeSol: 0.0001,
        tipSol: 0,
        entrySlippageBps: 50,
        quickExitSlippageBps: 75,
      },
    });

    expect(estimate).toBeTruthy();
    expect(estimate?.pass).toBe(false);
    expect(estimate?.reason).toBe('cost_ratio_exceeded');
    expect(estimate?.costRatio).toBeGreaterThan(0.06);
    expect(estimate?.requiredGrossMovePct).toBeCloseTo(estimate?.costRatio ?? 0);
  });

  it('returns null when shadow estimation is disabled', () => {
    expect(buildRotationMonetizableEdgeEstimate({
      ticketSol: 0.02,
      venue: 'raydium',
      config: {
        enabled: false,
        maxCostRatio: 0.06,
        assumedAtaRentSol: 0.00207408,
        priorityFeeSol: 0.0001,
        tipSol: 0,
        entrySlippageBps: 50,
        quickExitSlippageBps: 75,
      },
    })).toBeNull();
  });
});
