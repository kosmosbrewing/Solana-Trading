import {
  buildKolPosteriorCoverage,
  buildKolTransferPosteriorReport,
  buildTradeCandidates,
  computeKolPosteriorMetrics,
  loadKolPosteriorCoverageTargets,
  loadKolPosteriorCoverageTargetsWithStatus,
  renderKolTransferPosteriorMarkdown,
} from '../scripts/kol-transfer-posterior-report';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

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
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kol-transfer-posterior-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

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

  it('reports active KOL posterior coverage as ok, stale, or missing', async () => {
    const dbPath = path.join(tmpDir, 'wallets.json');
    await writeFile(dbPath, JSON.stringify({
      kols: [
        { id: 'fresh', addresses: ['wallet-fresh'], tier: 'A', is_active: true, trading_style: 'scalper' },
        { id: 'stale', addresses: ['wallet-stale'], tier: 'A', is_active: true, trading_style: 'scalper' },
        { id: 'missing', addresses: ['wallet-missing'], tier: 'A', is_active: true, trading_style: 'scalper' },
        { id: 'inactive', addresses: ['wallet-inactive'], tier: 'A', is_active: false, trading_style: 'scalper' },
      ],
    }), 'utf8');

    const targets = await loadKolPosteriorCoverageTargets(dbPath);
    const rows = [
      row({
        kolId: 'fresh_legacy_alias',
        kolAddress: 'wallet-fresh',
        walletDirection: 'out',
        transfer: { ...row({}).transfer, signature: 'sig-fresh', blockTime: 1_000, mint: SOL, uiAmount: '1' },
      }),
      row({
        kolId: 'fresh_legacy_alias',
        kolAddress: 'wallet-fresh',
        walletDirection: 'in',
        transfer: { ...row({}).transfer, signature: 'sig-fresh', blockTime: 1_000, mint: 'mint-fresh', uiAmount: '100' },
      }),
      row({
        kolId: 'stale',
        kolAddress: 'wallet-stale',
        walletDirection: 'out',
        transfer: { ...row({}).transfer, signature: 'sig-stale', blockTime: 500, mint: SOL, uiAmount: '1' },
      }),
    ];

    const coverage = buildKolPosteriorCoverage(rows, targets, 900);
    expect(coverage.find((item) => item.kolId === 'fresh')).toMatchObject({
      status: 'ok',
      rowsSince: 2,
      candidatesSince: 1,
      rotationCandidate: true,
    });
    expect(coverage.find((item) => item.kolId === 'stale')).toMatchObject({
      status: 'stale',
      rowsAll: 1,
      rowsSince: 0,
    });
    expect(coverage.find((item) => item.kolId === 'missing')).toMatchObject({
      status: 'missing',
      rowsAll: 0,
    });
    expect(coverage.some((item) => item.kolId === 'inactive')).toBe(false);

    const report = buildKolTransferPosteriorReport(rows, {
      input: 'data/research/kol-transfers.jsonl',
      kolDbPath: dbPath,
      sinceSec: 900,
      coverageTargets: targets,
    });
    expect(report.coverageSummary).toMatchObject({
      targets: 3,
      ok: 1,
      stale: 1,
      missing: 1,
      rotationTargets: 3,
      rotationOk: 1,
      rotationStale: 1,
      rotationMissing: 1,
    });
    const md = renderKolTransferPosteriorMarkdown(report);
    expect(md).toContain('## Coverage');
    expect(md).toContain('| stale | A | - | scalper | yes | stale |');
  });

  it('reports coverage load failures explicitly', async () => {
    const missingPath = path.join(tmpDir, 'missing-wallets.json');
    const load = await loadKolPosteriorCoverageTargetsWithStatus(missingPath);
    expect(load.status).toBe('load_failed');
    expect(load.targets).toEqual([]);

    const report = buildKolTransferPosteriorReport([], {
      input: 'data/research/kol-transfers.jsonl',
      kolDbPath: missingPath,
      coverageLoadStatus: load.status,
      coverageLoadError: load.error,
    });
    const md = renderKolTransferPosteriorMarkdown(report);
    expect(md).toContain('## Coverage');
    expect(md).toContain('status: load_failed');
    expect(md).toContain('Coverage targets were not loaded');
  });
});
