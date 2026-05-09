import {
  buildLiveAssetReconcileReport,
  type LiveAssetKolLiveTrade,
  type LiveAssetLedgerBuy,
  type LiveAssetLedgerSell,
  type LiveWalletTokenBalance,
} from '../src/observability/liveAssetReconciler';

const WALLET = 'wallet';

function report(input: {
  walletBalances?: LiveWalletTokenBalance[];
  buys?: LiveAssetLedgerBuy[];
  sells?: LiveAssetLedgerSell[];
  liveTrades?: LiveAssetKolLiveTrade[];
}) {
  return buildLiveAssetReconcileReport({
    walletAddress: WALLET,
    walletBalances: input.walletBalances ?? [],
    buys: input.buys ?? [],
    sells: input.sells ?? [],
    liveTrades: input.liveTrades ?? [],
    generatedAt: '2026-05-09T00:00:00.000Z',
  });
}

describe('liveAssetReconciler', () => {
  it('flags DWA-style false orphan as closed_but_balance_remaining', () => {
    const summary = report({
      walletBalances: [{
        mint: 'DWA',
        raw: '211163020012',
        uiAmount: 211_163.020012,
        decimals: 6,
        tokenAccounts: ['ata-DWA'],
      }],
      buys: [{
        positionId: 'kolh-live-DWA',
        txSignature: 'BUY_DWA',
        pairAddress: 'DWA',
        actualQuantity: 211_163.020012,
        actualEntryPrice: 1.05e-7,
        recordedAt: '2026-05-09T06:15:52.000Z',
      }],
      liveTrades: [{
        positionId: 'kolh-live-DWA',
        tokenMint: 'DWA',
        entryTxSignature: 'BUY_DWA',
        exitTxSignature: 'BUY_DWA',
        exitReason: 'ORPHAN_NO_BALANCE',
        armName: 'rotation_underfill_v1',
        entryPriceTokenOnly: 9.47e-8,
        closedAt: '2026-05-09T06:15:53.000Z',
      }],
    });

    expect(summary.anomalyRows).toBe(1);
    expect(summary.byStatus.closed_but_balance_remaining).toBe(1);
    expect(summary.rows[0]).toEqual(expect.objectContaining({
      mint: 'DWA',
      status: 'closed_but_balance_remaining',
      latestExitReason: 'ORPHAN_NO_BALANCE',
      recommendedAction: 'operator_cleanup_review',
    }));
    expect(summary.rows[0].estimatedEntryValueSol).toBeCloseTo(0.019998, 5);
  });

  it('classifies open buy with wallet balance as open_with_balance', () => {
    const summary = report({
      walletBalances: [{
        mint: 'OPEN',
        raw: '1000',
        uiAmount: 1000,
        decimals: 0,
        tokenAccounts: ['ata-open'],
      }],
      buys: [{
        positionId: 'pos-open',
        txSignature: 'BUY_OPEN',
        pairAddress: 'OPEN',
        actualEntryPrice: 0.00001,
        recordedAt: '2026-05-09T01:00:00.000Z',
      }],
    });

    expect(summary.rows[0].status).toBe('open_with_balance');
    expect(summary.anomalyRows).toBe(0);
    expect(summary.rows[0].recommendedAction).toBe('watch_open_position');
  });

  it('classifies open buy with zero wallet balance as open_but_zero_balance', () => {
    const summary = report({
      buys: [{
        positionId: 'pos-zero',
        txSignature: 'BUY_ZERO',
        pairAddress: 'ZERO',
        recordedAt: '2026-05-09T01:00:00.000Z',
      }],
    });

    expect(summary.rows[0].status).toBe('open_but_zero_balance');
    expect(summary.anomalyRows).toBe(1);
  });

  it('classifies wallet residual without matching ledger as unknown_residual', () => {
    const summary = report({
      walletBalances: [{
        mint: 'UNKNOWN',
        raw: '42',
        uiAmount: 42,
        decimals: 0,
        tokenAccounts: ['ata-unknown'],
      }],
    });

    expect(summary.rows[0].status).toBe('unknown_residual');
    expect(summary.anomalyRows).toBe(1);
  });

  it('marks closed zero-balance rows as ok_zero', () => {
    const sells: LiveAssetLedgerSell[] = [{
      positionId: 'pos-ok',
      entryTxSignature: 'BUY_OK',
      txSignature: 'SELL_OK',
      pairAddress: 'OK',
      exitReason: 'winner_trailing_t1',
      recordedAt: '2026-05-09T01:01:00.000Z',
    }];
    const summary = report({
      buys: [{
        positionId: 'pos-ok',
        txSignature: 'BUY_OK',
        pairAddress: 'OK',
        recordedAt: '2026-05-09T01:00:00.000Z',
      }],
      sells,
    });

    expect(summary.rows[0].status).toBe('ok_zero');
    expect(summary.anomalyRows).toBe(0);
  });
});

