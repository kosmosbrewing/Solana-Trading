import { evaluatePostDistributionGuard } from '../src/kol/postDistributionGuard';
import type { KolTx } from '../src/kol/types';

const MINT = 'MintPostDistribution111111111111111111111111';
const NOW = 1_700_000_000_000;
const CFG = {
  enabled: true,
  windowMs: 300_000,
  minGrossSellSol: 2,
  minDistinctSellKols: 2,
  cancelQuarantineMs: 600_000,
};

function tx(kolId: string, action: 'buy' | 'sell', solAmount: number, ageSec: number): KolTx {
  return {
    kolId,
    walletAddress: `wallet_${kolId}`,
    tier: 'A',
    tokenMint: MINT,
    action,
    timestamp: NOW - ageSec * 1000,
    txSignature: `sig_${kolId}_${action}_${ageSec}`,
    solAmount,
  };
}

describe('post distribution guard', () => {
  it('blocks when recent sell wave has net sell >= threshold and >=2 seller KOLs', () => {
    const result = evaluatePostDistributionGuard({
      tokenMint: MINT,
      nowMs: NOW,
      recentKolTxs: [
        tx('alice', 'sell', 1.6, 120),
        tx('bob', 'sell', 1.4, 110),
        tx('carol', 'buy', 0.3, 30),
      ],
      participatingKols: [{ id: 'carol' }, { id: 'dave' }],
      config: CFG,
    });

    expect(result.blocked).toBe(true);
    expect(result.flags).toEqual(expect.arrayContaining([
      'POST_DISTRIBUTION_SELL_WAVE',
      'POST_DISTRIBUTION_ENTRY_BLOCK',
    ]));
    expect(result.telemetry.netSellSol).toBeCloseTo(2.7, 6);
    expect(result.telemetry.distinctSellKols).toBe(2);
  });

  it('does not let large earlier buys dilute a gross sell wave', () => {
    const result = evaluatePostDistributionGuard({
      tokenMint: MINT,
      nowMs: NOW,
      recentKolTxs: [
        tx('early_buy', 'buy', 5, 240),
        tx('alice', 'sell', 1.1, 120),
        tx('bob', 'sell', 1.1, 110),
      ],
      participatingKols: [{ id: 'carol' }, { id: 'dave' }],
      config: CFG,
    });

    expect(result.blocked).toBe(true);
    expect(result.telemetry.sellSol).toBeCloseTo(2.2, 6);
    expect(result.telemetry.netSellSol).toBeLessThan(0);
  });

  it('does not block a single seller KOL even when net sell is large', () => {
    const result = evaluatePostDistributionGuard({
      tokenMint: MINT,
      nowMs: NOW,
      recentKolTxs: [
        tx('alice', 'sell', 10, 60),
        tx('carol', 'buy', 0.2, 10),
      ],
      participatingKols: [{ id: 'carol' }, { id: 'dave' }],
      config: CFG,
    });

    expect(result.blocked).toBe(false);
    expect(result.reason).toBe('no_post_distribution_risk');
  });

  it('does not unlock a sell wave just because two KOLs buy after the last sell', () => {
    const result = evaluatePostDistributionGuard({
      tokenMint: MINT,
      nowMs: NOW,
      recentKolTxs: [
        tx('alice', 'sell', 1.5, 180),
        tx('bob', 'sell', 1.5, 175),
        tx('carol', 'buy', 0.4, 120),
        tx('dave', 'buy', 0.4, 100),
      ],
      participatingKols: [{ id: 'carol' }, { id: 'dave' }],
      config: CFG,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('post_distribution_sell_wave');
    expect(result.flags).toContain('POST_DISTRIBUTION_ENTRY_BLOCK');
    expect(result.telemetry.freshIndependentBuyKols).toBe(2);
    expect(result.telemetry.secondsSinceLastSell).toBe(175);
  });

  it('hard-blocks prior smart-v3 sell cancel during quarantine', () => {
    const result = evaluatePostDistributionGuard({
      tokenMint: MINT,
      nowMs: NOW,
      recentKolTxs: [tx('carol', 'buy', 0.3, 20)],
      participatingKols: [{ id: 'carol' }, { id: 'dave' }],
      config: CFG,
      priorKolSellCancelAtMs: NOW - 60_000,
    });

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('post_distribution_cancel_quarantine');
    expect(result.flags).toContain('PRIOR_KOL_SELL_CANCEL');
    expect(result.flags).toContain('POST_DISTRIBUTION_CANCEL_QUARANTINE');
    expect(result.flags).toContain('POST_DISTRIBUTION_ENTRY_BLOCK');
  });

  it('does not block old smart-v3 sell cancels outside quarantine', () => {
    const result = evaluatePostDistributionGuard({
      tokenMint: MINT,
      nowMs: NOW,
      recentKolTxs: [tx('carol', 'buy', 0.3, 20)],
      participatingKols: [{ id: 'carol' }, { id: 'dave' }],
      config: CFG,
      priorKolSellCancelAtMs: NOW - 700_000,
    });

    expect(result.blocked).toBe(false);
    expect(result.flags).not.toContain('PRIOR_KOL_SELL_CANCEL');
    expect(result.flags).not.toContain('POST_DISTRIBUTION_ENTRY_BLOCK');
  });
});
