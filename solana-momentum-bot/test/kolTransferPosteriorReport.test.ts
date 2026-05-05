import {
  buildKolTransferPosteriorReport,
  buildTradeCandidates,
  computeKolPosteriorMetrics,
  renderKolTransferPosteriorMarkdown,
} from '../scripts/kol-transfer-posterior-report';

const SOL = 'So11111111111111111111111111111111111111111';

function row(overrides: Partial<any>): any {
  return {
    schemaVersion: 'kol-transfer-backfill/v1',
    kolId: 'decu',
    kolAddress: 'wallet-a',
    kolTier: 'S',
    laneRole: 'copy_core',
    tradingStyle: 'scalper',
    walletDirection: 'out',
    transfer: {
      signature: 'sig-buy-1',
      slot: 1,
      blockTime: 100,
      type: 'transfer',
      mint: SOL,
      amount: '1000000000',
      uiAmount: '1',
      decimals: 9,
    },
    ...overrides,
  };
}

describe('kol-transfer-posterior-report', () => {
  it('reconstructs buy and sell candidates from transfer rows', () => {
    const rows = [
      row({ walletDirection: 'out', transfer: { ...row({}).transfer, signature: 'sig-buy-1', mint: SOL, uiAmount: '1' } }),
      row({ walletDirection: 'in', transfer: { ...row({}).transfer, signature: 'sig-buy-1', mint: 'mint-a', uiAmount: '1000', decimals: 6 } }),
      row({ walletDirection: 'out', transfer: { ...row({}).transfer, signature: 'sig-sell-1', blockTime: 220, mint: 'mint-a', uiAmount: '1000', decimals: 6 } }),
      row({ walletDirection: 'in', transfer: { ...row({}).transfer, signature: 'sig-sell-1', blockTime: 220, mint: SOL, uiAmount: '1.2' } }),
    ];

    const candidates = buildTradeCandidates(rows);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ side: 'buy', solOut: 1, tokenMints: ['mint-a'] });
    expect(candidates[1]).toMatchObject({ side: 'sell', solIn: 1.2, tokenMints: ['mint-a'] });
  });

  it('computes KOL posterior metrics for rotation-style behavior', () => {
    const rows = [
      row({ walletDirection: 'out', transfer: { ...row({}).transfer, signature: 'sig-buy-1', blockTime: 100, mint: SOL, uiAmount: '0.5' } }),
      row({ walletDirection: 'in', transfer: { ...row({}).transfer, signature: 'sig-buy-1', blockTime: 100, mint: 'mint-a', uiAmount: '1000', decimals: 6 } }),
      row({ walletDirection: 'out', transfer: { ...row({}).transfer, signature: 'sig-buy-2', blockTime: 140, mint: SOL, uiAmount: '0.4' } }),
      row({ walletDirection: 'in', transfer: { ...row({}).transfer, signature: 'sig-buy-2', blockTime: 140, mint: 'mint-a', uiAmount: '800', decimals: 6 } }),
      row({ walletDirection: 'out', transfer: { ...row({}).transfer, signature: 'sig-sell-1', blockTime: 260, mint: 'mint-a', uiAmount: '1800', decimals: 6 } }),
      row({ walletDirection: 'in', transfer: { ...row({}).transfer, signature: 'sig-sell-1', blockTime: 260, mint: SOL, uiAmount: '1.1' } }),
    ];

    const candidates = buildTradeCandidates(rows);
    const metrics = computeKolPosteriorMetrics(rows, candidates)[0];
    expect(metrics.buyCandidates).toBe(2);
    expect(metrics.sellCandidates).toBe(1);
    expect(metrics.uniqueBuyMints).toBe(1);
    expect(metrics.sameMintReentryRatio).toBe(1);
    expect(metrics.quickSellRatio).toBe(1);
    expect(metrics.medianBuySol).toBe(0.45);
    expect(metrics.rotationFitScore).toBeGreaterThan(metrics.smartV3FitScore);
  });

  it('renders markdown without making policy claims', () => {
    const report = buildKolTransferPosteriorReport([], { input: 'data/research/kol-transfers.jsonl' });
    const md = renderKolTransferPosteriorMarkdown(report);
    expect(md).toContain('Diagnostic only');
    expect(md).toContain('KOL Posterior');
  });

  it('dedupes append-only backfill rows by eventId before scoring', () => {
    const duplicate = row({
      eventId: 'wallet-a:sig-buy-1:ix:inner:So11111111111111111111111111111111111111111:1000000000',
      walletDirection: 'out',
      transfer: { ...row({}).transfer, signature: 'sig-buy-1', mint: SOL, uiAmount: '1' },
    });
    const tokenLeg = row({
      eventId: 'wallet-a:sig-buy-1:ix:inner:mint-a:1000',
      walletDirection: 'in',
      transfer: { ...row({}).transfer, signature: 'sig-buy-1', mint: 'mint-a', uiAmount: '1000', decimals: 6 },
    });

    const report = buildKolTransferPosteriorReport([duplicate, duplicate, tokenLeg, tokenLeg], {
      input: 'data/research/kol-transfers.jsonl',
    });

    expect(report.rows).toBe(2);
    expect(report.candidates).toBe(1);
    expect(report.metrics[0].buyCandidates).toBe(1);
    expect(report.metrics[0].medianBuySol).toBe(1);
  });
});
