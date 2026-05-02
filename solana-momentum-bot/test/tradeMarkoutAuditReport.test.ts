import {
  AuditReport,
  renderMarkdown,
  renderText,
  verdictFor,
} from '../scripts/lib/tradeMarkoutAuditReport';

function baseReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    generatedAt: '2026-05-02T00:00:00.000Z',
    since: '2026-05-01T00:00:00.000Z',
    realtimeDir: 'data/realtime',
    horizonsSec: [30],
    verdict: 'WATCH',
    summary: {
      anchors: 10,
      anchorRows: 10,
      fallbackLiveBuys: 0,
      fallbackLiveSells: 0,
      expectedRows: 10,
      observedLatestRows: 10,
      okLatestRows: 4,
      rowCoveragePct: 100,
      okCoveragePct: 40,
      coveragePct: 40,
      fiveXAfterSellRows: 0,
    },
    counts: {
      anchorMode: [{ key: 'live', count: 10 }],
      anchorEvent: [{ key: 'live_entry', count: 10 }],
      status: [{ key: 'ok', count: 4 }, { key: 'rate_limited', count: 6 }],
      anchorType: [{ key: 'buy', count: 10 }],
      quoteReason: [{ key: 'observer_inflight_cap', count: 6 }],
    },
    horizonCoverage: [{
      horizonSec: 30,
      expectedRows: 10,
      observedRows: 10,
      okRows: 4,
      rowCoveragePct: 100,
      okCoveragePct: 40,
      coveragePct: 40,
    }],
    topAfterSellPositive: [],
    worstAfterBuy: [],
    ...overrides,
  };
}

describe('tradeMarkoutAuditReport', () => {
  it('bases the verdict on ok coverage instead of row coverage', () => {
    expect(verdictFor(baseReport())).toBe('INVESTIGATE');
  });

  it('renders row coverage and ok coverage separately', () => {
    const report = baseReport();

    expect(renderText(report)).toContain('rowCoverage=100.0% okCoverage=40.0%');
    expect(renderMarkdown(report)).toContain('| rowCoverage | 100.0% |');
    expect(renderMarkdown(report)).toContain('| okCoverage | 40.0% |');
  });
});
