import { PaperMetricsTracker } from '../src/reporting/paperMetrics';

describe('PaperMetricsTracker', () => {
  it('aggregates trades by discovery source', () => {
    const tracker = new PaperMetricsTracker();

    tracker.recordEntry({
      id: 't-1',
      pairAddress: 'pair-1',
      strategy: 'new_lp_sniper',
      sourceLabel: 'scanner_dex_boost',
      entryPrice: 1,
      quantity: 1,
      entryTime: new Date(),
    });
    tracker.recordExit('t-1', 1.5, 'TAKE_PROFIT_1');

    tracker.recordEntry({
      id: 't-2',
      pairAddress: 'pair-2',
      strategy: 'new_lp_sniper',
      sourceLabel: 'scanner_dex_token_profile',
      entryPrice: 2,
      quantity: 1,
      entryTime: new Date(),
    });
    tracker.recordExit('t-2', 1.5, 'STOP_LOSS');

    const summary = tracker.getSummary();
    expect(summary.tradesBySource.scanner_dex_boost).toEqual({
      count: 1,
      winRate: 1,
    });
    expect(summary.tradesBySource.scanner_dex_token_profile).toEqual({
      count: 1,
      winRate: 0,
    });

    const text = tracker.formatSummaryText();
    expect(text).toContain('Source:');
    expect(text).toContain('scanner_dex_boost: 1 trades, WR 100%');
    expect(text).toContain('scanner_dex_token_profile: 1 trades, WR 0%');
  });
});
