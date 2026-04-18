/**
 * Phase 2 test (DEX_TRADE.md, 2026-04-18): probe viability floor.
 */
import { checkProbeViabilityFloor } from '../src/gate/probeViabilityFloor';

const defaultConfig = {
  minTicketSol: 0.005,
  maxBleedPct: 0.06,
  maxSellImpactPct: 0,
  remainingDailyBudgetSol: 1.0,
};

describe('probeViabilityFloor', () => {
  it('allows probe when all checks pass (raydium ticket 0.01)', () => {
    const result = checkProbeViabilityFloor(
      { venue: 'raydium', ticketSol: 0.01 },
      defaultConfig
    );
    expect(result.allow).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('rejects ticket_too_small', () => {
    const result = checkProbeViabilityFloor(
      { venue: 'raydium', ticketSol: 0.001 },
      defaultConfig
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('ticket_too_small');
  });

  it('rejects bleed_over_probe_cap for expensive venue + tight cap', () => {
    const result = checkProbeViabilityFloor(
      { venue: 'pumpswap', ticketSol: 0.01 },
      { ...defaultConfig, maxBleedPct: 0.01 } // 1% cap very tight
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('bleed_over_probe_cap');
  });

  it('rejects daily_bleed_budget_exhausted when budget=0', () => {
    const result = checkProbeViabilityFloor(
      { venue: 'raydium', ticketSol: 0.01 },
      { ...defaultConfig, remainingDailyBudgetSol: 0 }
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('daily_bleed_budget_exhausted');
  });

  it('rejects when expected bleed > remaining daily budget', () => {
    const result = checkProbeViabilityFloor(
      { venue: 'pumpswap', ticketSol: 0.01 },
      { ...defaultConfig, remainingDailyBudgetSol: 0.00001 } // below expected bleed
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('daily_bleed_budget_exhausted');
  });

  it('rejects sell_impact_too_high when configured', () => {
    const result = checkProbeViabilityFloor(
      { venue: 'raydium', ticketSol: 0.01, sellImpactPct: 0.05 },
      { ...defaultConfig, maxSellImpactPct: 0.03 }
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('sell_impact_too_high');
  });

  it('allows sell_impact check bypassed when config=0', () => {
    const result = checkProbeViabilityFloor(
      { venue: 'raydium', ticketSol: 0.01, sellImpactPct: 0.99 },
      { ...defaultConfig, maxSellImpactPct: 0 }
    );
    expect(result.allow).toBe(true);
    expect(result.reason).toBe('ok');
  });

  it('returns bleed breakdown for observability', () => {
    const result = checkProbeViabilityFloor(
      { venue: 'raydium', ticketSol: 0.01 },
      defaultConfig
    );
    expect(result.bleed.venue).toBe('raydium');
    expect(result.bleed.ticketSol).toBe(0.01);
    expect(result.bleed.totalSol).toBeGreaterThan(0);
  });
});
