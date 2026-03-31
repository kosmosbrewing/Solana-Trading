import { createScannerBlacklistCheck } from '../src/scanner/scannerBlacklist';

describe('createScannerBlacklistCheck', () => {
  it('preloads the blacklist before returning the lookup function', async () => {
    const tradeStore = {
      getClosedTradesChronological: jest.fn().mockResolvedValue([
        ...Array.from({ length: 5 }, () => ({
          pairAddress: 'pair-weak',
          strategy: 'volume_spike' as const,
          entryPrice: 1,
          stopLoss: 0.9,
          quantity: 1,
          pnl: -0.2,
        })),
      ]),
    };

    const blacklistCheck = await createScannerBlacklistCheck(tradeStore as never);

    expect(tradeStore.getClosedTradesChronological).toHaveBeenCalledTimes(1);
    expect(blacklistCheck('pair-weak')).toBe(true);
    expect(blacklistCheck('pair-good')).toBe(false);
  });
});
