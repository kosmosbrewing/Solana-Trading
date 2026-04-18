/**
 * Phase 2 test (DEX_TRADE.md, 2026-04-18): venue-specific bleed adapters.
 */
import {
  estimateBleed,
  bleedRaydium,
  bleedPumpSwap,
  bleedMeteora,
  bleedOrca,
  bleedUnknown,
  exceedsBleedBudget,
} from '../src/execution/bleedModel';

describe('bleedModel — venue adapters', () => {
  const baseInputs = {
    ticketSol: 0.01,
    priorityFeeSol: 0.0001,
    tipSol: 0,
    entrySlippageBps: 50,
    quickExitSlippageBps: 75,
  };

  it('raydium — fee 0.25% per side (0.5% round-trip) + slippage', () => {
    const b = bleedRaydium(baseInputs);
    // venueFee = 0.0025 * 0.01 * 2 = 0.00005
    expect(b.venue).toBe('raydium');
    expect(b.venueFeeSol).toBeCloseTo(0.00005, 9);
    // entry slippage = 50bps * 0.01 = 0.00005
    expect(b.entrySlippageSol).toBeCloseTo(0.00005, 9);
    // exit slippage = 75bps * 0.01 = 0.000075
    expect(b.quickExitSlippageSol).toBeCloseTo(0.000075, 9);
    expect(b.totalSol).toBeGreaterThan(0);
    expect(b.totalPct).toBeGreaterThan(0);
  });

  it('pumpswap — venue fee 1% per side (2% round-trip)', () => {
    const b = bleedPumpSwap(baseInputs);
    expect(b.venue).toBe('pumpswap');
    expect(b.venueFeeSol).toBeCloseTo(0.0002, 9); // 0.01 * 0.01 * 2
  });

  it('meteora — 0.3% per side', () => {
    const b = bleedMeteora(baseInputs);
    expect(b.venue).toBe('meteora');
    expect(b.venueFeeSol).toBeCloseTo(0.00006, 9);
  });

  it('orca — 0.3% per side', () => {
    const b = bleedOrca(baseInputs);
    expect(b.venue).toBe('orca');
    expect(b.venueFeeSol).toBeCloseTo(0.00006, 9);
  });

  it('unknown — conservative 0.5% per side fallback', () => {
    const b = bleedUnknown(baseInputs);
    expect(b.venue).toBe('unknown');
    expect(b.venueFeeSol).toBeCloseTo(0.0001, 9);
  });

  it('estimateBleed dispatches to correct adapter by name', () => {
    expect(estimateBleed('raydium', baseInputs).venue).toBe('raydium');
    expect(estimateBleed('pumpswap', baseInputs).venue).toBe('pumpswap');
    expect(estimateBleed('meteora', baseInputs).venue).toBe('meteora');
    expect(estimateBleed('orca', baseInputs).venue).toBe('orca');
    expect(estimateBleed('phoenix' as any, baseInputs).venue).toBe('unknown');
    expect(estimateBleed(undefined, baseInputs).venue).toBe('unknown');
  });

  it('default slippage applied when not provided', () => {
    const b = bleedRaydium({ ticketSol: 0.01 });
    // default 50bps entry, 75bps exit (1.5x)
    expect(b.entrySlippageSol).toBeCloseTo(0.00005, 9);
    expect(b.quickExitSlippageSol).toBeCloseTo(0.000075, 9);
  });

  it('priority fee + tip are counted twice (entry + exit)', () => {
    const b = bleedRaydium({
      ticketSol: 0.01,
      priorityFeeSol: 0.001,
      tipSol: 0.002,
    });
    expect(b.priorityFeeSol).toBeCloseTo(0.002, 9); // 0.001 * 2
    expect(b.tipSol).toBeCloseTo(0.004, 9); // 0.002 * 2
  });

  it('exceedsBleedBudget flags overruns correctly', () => {
    const b = bleedRaydium(baseInputs);
    expect(exceedsBleedBudget(b, 0.001)).toBe(false);
    expect(exceedsBleedBudget(b, 0.0001)).toBe(true);
  });

  it('pumpswap has higher round-trip than raydium for same ticket', () => {
    const ray = bleedRaydium(baseInputs);
    const pump = bleedPumpSwap(baseInputs);
    expect(pump.totalPct).toBeGreaterThan(ray.totalPct);
  });
});
