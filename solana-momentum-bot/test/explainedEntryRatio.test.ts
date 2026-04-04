import { computeExplainedEntryRatio } from '../src/reporting/sourceOutcome';

describe('computeExplainedEntryRatio', () => {
  it('returns zero ratio for empty array', () => {
    const result = computeExplainedEntryRatio([]);
    expect(result.total).toBe(0);
    expect(result.ratio).toBe(0);
    expect(result.meetsMeasurementTarget).toBe(false);
  });

  it('falls back to sourceLabel when discoverySource is absent', () => {
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

  it('prefers discoverySource over sourceLabel semantics', () => {
    const trades = [
      { discoverySource: 'gecko_trending', sourceLabel: 'trigger_momentum' },
      { discoverySource: 'dex_boost', sourceLabel: 'strategy_volume_spike' },
      { discoverySource: undefined, sourceLabel: 'trigger_volume_mcap_spike' },
      { discoverySource: 'unknown', sourceLabel: 'unknown' },
    ];
    const result = computeExplainedEntryRatio(trades);
    expect(result.total).toBe(4);
    expect(result.explained).toBe(3);
    expect(result.unexplained).toBe(1);
    expect(result.ratio).toBe(0.75);
  });

  it('meets target when ratio >= 0.9', () => {
    const trades = Array.from({ length: 10 }, (_, i) => ({
      discoverySource: i < 9 ? 'gecko_trending' : undefined,
    }));
    const result = computeExplainedEntryRatio(trades);
    expect(result.ratio).toBe(0.9);
    expect(result.meetsMeasurementTarget).toBe(true);
  });

  it('treats missing attribution as unexplained', () => {
    const trades = [{}] as Array<{ discoverySource?: string; sourceLabel?: string }>;
    const result = computeExplainedEntryRatio(trades);
    expect(result.explained).toBe(0);
    expect(result.unexplained).toBe(1);
  });

  it('all explained gives ratio 1.0', () => {
    const trades = [
      { discoverySource: 'dex_boost' },
      { discoverySource: 'gecko_new_pool' },
    ];
    const result = computeExplainedEntryRatio(trades);
    expect(result.ratio).toBe(1);
    expect(result.meetsMeasurementTarget).toBe(true);
  });
});
