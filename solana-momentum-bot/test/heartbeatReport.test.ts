import {
  buildHeartbeatPerformanceSummary,
  buildHeartbeatRegimeSummary,
  buildHeartbeatTradingSummary,
} from '../src/orchestration/reporting';
import { PaperMetricsSummary } from '../src/reporting/paperMetrics';

describe('heartbeat reporting helpers', () => {
  it('includes balance, pnl, and trade counts in trading summary', () => {
    const text = buildHeartbeatTradingSummary({
      tradingMode: 'paper',
      balanceSol: 1.0321,
      dailyPnl: 0.0214,
      totalTrades: 7,
      closedTrades: 5,
      openTrades: 2,
    });

    expect(text).toContain('📊 Paper · 24h');
    expect(text).toContain('잔액 1.0321 SOL | 손익 +0.0214 SOL');
    expect(text).toContain('오늘 거래 7건 | 종료 5건 | 오픈 2건');
  });

  it('omits performance block when there are no closed trades', () => {
    const summary: PaperMetricsSummary = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgMaePct: 0,
      avgMfePct: 0,
      falsePositiveRate: 0,
      avgPriceImpactPct: 0,
      avgQuoteDecayPct: 0,
      avgTimeToFillMs: 0,
      tradesByRegime: {},
      tradesBySource: {},
      tp1HitRate: 0,
    };

    expect(buildHeartbeatPerformanceSummary(summary)).toBeUndefined();
  });

  it('formats regime summary in the existing compact style', () => {
    const text = buildHeartbeatRegimeSummary({
      regime: 'risk_on',
      sizeMultiplier: 1,
      solTrendBullish: false,
      breadthPct: 0.5,
      followThroughPct: 0.5,
      updatedAt: new Date('2026-04-04T00:00:00.000Z'),
    });

    expect(text).toContain('🔍 시장: 🟢 risk_on (1x)');
    expect(text).toContain('SOL 🔴약세 | 확산 50% | 후속 50%');
  });
});
