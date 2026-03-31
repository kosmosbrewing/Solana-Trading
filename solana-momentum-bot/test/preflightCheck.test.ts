import { runPreflightCheck } from '../src/orchestration/preflightCheck';

describe('runPreflightCheck', () => {
  it('blocks live mode when Jupiter API key is missing or wallet balance is too low', async () => {
    const dbPool = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [{
            strategy: 'volume_spike',
            pair_address: 'pair-1',
            entry_price: 1,
            stop_loss: 0.9,
            quantity: 1,
            pnl: 0.2,
            exit_reason: 'TAKE_PROFIT_1',
            closed_at: new Date('2026-03-31T00:00:00.000Z'),
          }],
        })
        .mockResolvedValueOnce({
          rows: [{ strategy: 'volume_spike', action: 'EXECUTED', filter_reason: null }],
        }),
    } as any;

    const result = await runPreflightCheck(dbPool, {
      tradingMode: 'live',
      minTrades: 1,
      minWinRate: 0.1,
      minRewardRisk: 0.1,
      requireJupiterApiKey: true,
      hasJupiterApiKey: false,
      minMainWalletBalanceSol: 0.05,
      mainWalletBalanceSol: 0.01,
      enforceGate: true,
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('JUPITER_API_KEY missing — live quote/execution likely to fail');
    expect(result.reasons).toContain('Main wallet balance 0.0100 SOL < 0.0500 SOL');
  });

  it('ignores corrupted closed trades when building live preflight stats', async () => {
    const dbPool = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rows: [
            {
              strategy: 'volume_spike',
              pair_address: 'pair-bad',
              entry_price: 1,
              stop_loss: 0,
              quantity: 1,
              pnl: -1,
              exit_reason: 'STOP_LOSS',
              closed_at: new Date('2026-03-31T00:00:00.000Z'),
            },
            {
              strategy: 'volume_spike',
              pair_address: 'pair-good',
              entry_price: 1,
              stop_loss: 0.95,
              quantity: 1,
              pnl: 0.2,
              exit_reason: 'TAKE_PROFIT_1',
              closed_at: new Date('2026-03-31T00:05:00.000Z'),
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ strategy: 'volume_spike', action: 'EXECUTED', filter_reason: null }],
        }),
    } as any;

    const result = await runPreflightCheck(dbPool, {
      tradingMode: 'live',
      minTrades: 1,
      minWinRate: 0.1,
      minRewardRisk: 0.1,
      requireJupiterApiKey: false,
      hasJupiterApiKey: false,
      minMainWalletBalanceSol: 0,
      mainWalletBalanceSol: 1,
      enforceGate: true,
    });

    expect(result.passed).toBe(true);
    expect(result.totalTrades).toBe(1);
    expect(result.winRate).toBe(1);
  });
});
