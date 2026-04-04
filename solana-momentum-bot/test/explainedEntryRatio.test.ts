import { computeExplainedEntryRatio } from '../src/reporting/sourceOutcome';

describe('computeExplainedEntryRatio', () => {
  it('returns zero ratio for empty array', () => {
    const result = computeExplainedEntryRatio([]);
    expect(result.total).toBe(0);
    expect(result.ratio).toBe(0);
    expect(result.meetsMeasurementTarget).toBe(false);
  });

  it('counts trades with sourceLabel as explained', () => {
    const trades = [
      { sourceLabel: 'trigger_momentum' },
      { sourceLabel: 'strategy_volume_spike' },
      { sourceLabel: undefined },
      { sourceLabel: 'unknown' },
    ];
    const result = computeExplainedEntryRatio(trades);
    expect(result.total).toBe(4);
    expect(result.explained).toBe(2);
    expect(result.unexplained).toBe(2);
    expect(result.ratio).toBe(0.5);
    expect(result.meetsMeasurementTarget).toBe(false);
  });

  it('meets target when ratio >= 0.9', () => {
    const trades = Array.from({ length: 10 }, (_, i) => ({
      sourceLabel: i < 9 ? 'trigger_momentum' : undefined,
    }));
    const result = computeExplainedEntryRatio(trades);
    expect(result.ratio).toBe(0.9);
    expect(result.meetsMeasurementTarget).toBe(true);
  });

  it('treats missing sourceLabel as unexplained', () => {
    const trades = [{}] as Array<{ sourceLabel?: string }>;
    const result = computeExplainedEntryRatio(trades);
    expect(result.explained).toBe(0);
    expect(result.unexplained).toBe(1);
  });

  it('all explained gives ratio 1.0', () => {
    const trades = [
      { sourceLabel: 'trigger_volume_mcap_spike' },
      { sourceLabel: 'strategy_fib_pullback' },
    ];
    const result = computeExplainedEntryRatio(trades);
    expect(result.ratio).toBe(1);
    expect(result.meetsMeasurementTarget).toBe(true);
  });
});
