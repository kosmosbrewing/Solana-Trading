import {
  executeLiveSellWithImmediateRetries,
  setLiveSellRetryDelaysMsForTests,
} from '../src/executor/liveSellRetry';

describe('executeLiveSellWithImmediateRetries', () => {
  beforeEach(() => {
    setLiveSellRetryDelaysMsForTests([0, 0, 0, 0, 0]);
  });

  afterEach(() => {
    setLiveSellRetryDelaysMsForTests();
  });

  it('recovers when the first failed sell already removed the expected token balance', async () => {
    const executor = {
      executeSell: jest.fn().mockRejectedValueOnce(new Error('confirm timeout')),
      getTokenBalance: jest.fn().mockResolvedValueOnce(0n),
    };

    const result = await executeLiveSellWithImmediateRetries({
      executor,
      tokenMint: 'mint',
      initialTokenBalance: 1_000n,
      requestedSellAmount: 1_000n,
      expectedRemainingBalance: 0n,
      context: 'test:balance_recovered',
      reason: 'hard_cut',
      syntheticSignature: 'SYNTHETIC_RECOVERED',
    });

    expect(executor.executeSell).toHaveBeenCalledTimes(1);
    expect(executor.getTokenBalance).toHaveBeenCalledTimes(1);
    expect(result.recoveredFromBalanceOnly).toBe(true);
    expect(result.sellResult.txSignature).toBe('SYNTHETIC_RECOVERED');
    expect(result.soldRatio).toBe(1);
    expect(result.soldRaw).toBe(1_000n);
  });

  it('sells only the remaining requested amount after a partial on-chain sell', async () => {
    const executor = {
      executeSell: jest.fn()
        .mockRejectedValueOnce(new Error('confirm timeout after partial'))
        .mockResolvedValueOnce({
          txSignature: 'SELL_OK',
          expectedOutAmount: 1n,
          slippageBps: 12,
        }),
      getTokenBalance: jest.fn().mockResolvedValueOnce(600n),
    };

    const result = await executeLiveSellWithImmediateRetries({
      executor,
      tokenMint: 'mint',
      initialTokenBalance: 1_000n,
      requestedSellAmount: 1_000n,
      expectedRemainingBalance: 0n,
      context: 'test:partial_retry',
      reason: 'hard_cut',
      syntheticSignature: 'SYNTHETIC_RECOVERED',
    });

    expect(executor.executeSell).toHaveBeenNthCalledWith(1, 'mint', 1_000n);
    expect(executor.executeSell).toHaveBeenNthCalledWith(2, 'mint', 600n);
    expect(result.recoveredFromBalanceOnly).toBe(false);
    expect(result.sellResult.txSignature).toBe('SELL_OK');
    expect(result.soldRatio).toBe(1);
    expect(result.soldRaw).toBe(1_000n);
  });

  it('uses the selected urgency profile and reports it in the execution result', async () => {
    setLiveSellRetryDelaysMsForTests([0, 0, 0, 0, 0], 'hard_cut');
    const executor = {
      executeSell: jest.fn()
        .mockRejectedValueOnce(new Error('route timeout'))
        .mockResolvedValueOnce({
          txSignature: 'SELL_HARD_CUT_OK',
          expectedOutAmount: 1n,
          slippageBps: 18,
        }),
      getTokenBalance: jest.fn().mockResolvedValueOnce(1_000n),
    };

    const result = await executeLiveSellWithImmediateRetries({
      executor,
      tokenMint: 'mint',
      initialTokenBalance: 1_000n,
      requestedSellAmount: 1_000n,
      expectedRemainingBalance: 0n,
      context: 'test:hard_cut_urgency',
      reason: 'probe_hard_cut',
      syntheticSignature: 'SYNTHETIC_RECOVERED',
      urgency: 'hard_cut',
    });

    expect(result.urgency).toBe('hard_cut');
    expect(result.attempts).toBe(2);
    expect(result.sellResult.txSignature).toBe('SELL_HARD_CUT_OK');
  });

  it('does not convert zero balance into synthetic success when balance recovery is disabled', async () => {
    const executor = {
      executeSell: jest.fn().mockRejectedValue(new Error('sell failed')),
      getTokenBalance: jest.fn().mockResolvedValue(0n),
    };

    await expect(executeLiveSellWithImmediateRetries({
      executor,
      tokenMint: 'mint',
      initialTokenBalance: 1_000n,
      requestedSellAmount: 1_000n,
      expectedRemainingBalance: 0n,
      context: 'test:no_balance_recovery',
      reason: 'emergency_dump',
      syntheticSignature: 'SYNTHETIC_RECOVERED',
      retryCount: 1,
      allowBalanceRecovered: false,
    })).rejects.toThrow('balance recovered disabled');

    expect(executor.executeSell).toHaveBeenCalledTimes(1);
    expect(executor.getTokenBalance).toHaveBeenCalledTimes(1);
  });
});
