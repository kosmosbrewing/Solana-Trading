import {
  buildHeartbeatPerformanceSummary,
  buildHeartbeatRegimeSummary,
  buildHeartbeatTradingSummary,
} from '../src/reporting/heartbeatSummary';
import { PaperMetricsSummary } from '../src/reporting/paperMetrics';

describe('heartbeat reporting helpers', () => {
  it('includes balance, pnl, and trade counts in trading summary', () => {
    const text = buildHeartbeatTradingSummary({
      tradingMode: 'paper',
      windowHours: 4,
      balanceSol: 1.0321,
      pnl: 0.0214,
      enteredTrades: 7,
      closedTrades: 5,
      openTrades: 2,
    });

    expect(text).toContain('📊 Paper · 최근 4h');
    expect(text).toContain('잔액 1.0321 SOL (손익 +0.0214 SOL)');
    expect(text).toContain('진입 7 · 종료 5 · 오픈 2');
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

  it('omits mae and mfe line when the source summary cannot compute excursion metrics', () => {
    const summary: PaperMetricsSummary = {
      totalTrades: 2,
      wins: 1,
      losses: 1,
      winRate: 0.5,
      avgMaePct: Number.NaN,
      avgMfePct: Number.NaN,
      falsePositiveRate: 0.5,
      avgPriceImpactPct: 0,
      avgQuoteDecayPct: 0,
      avgTimeToFillMs: 0,
      tradesByRegime: {},
      tradesBySource: {},
      tp1HitRate: 0.5,
    };

    const text = buildHeartbeatPerformanceSummary(summary);
    expect(text).toContain('전적 1W 1L (50%)');
    expect(text).toContain('오진 50% · TP1 50%');
    expect(text).not.toContain('역행');
    expect(text).not.toContain('순행');
  });

  it('formats regime summary in localized Korean labels', () => {
    const text = buildHeartbeatRegimeSummary({
      regime: 'risk_on',
      sizeMultiplier: 1,
      solTrendBullish: false,
      breadthPct: 0.5,
      followThroughPct: 0.5,
      updatedAt: new Date('2026-04-04T00:00:00.000Z'),
    });

    expect(text).toContain('🔍 시장: 🟢 위험선호 (1x)');
    expect(text).toContain('SOL 🔴약세 · 확산 50% · 후속 50%');
  });

  it('uses Korean labels for risk_off and neutral regimes', () => {
    const riskOff = buildHeartbeatRegimeSummary({
      regime: 'risk_off',
      sizeMultiplier: 0.5,
      solTrendBullish: true,
      breadthPct: 0.1,
      followThroughPct: 0.2,
      updatedAt: new Date(),
    });
    expect(riskOff).toContain('🔴 위험회피');
    expect(riskOff).toContain('SOL 🟢강세');

    const neutral = buildHeartbeatRegimeSummary({
      regime: 'neutral',
      sizeMultiplier: 0.7,
      solTrendBullish: true,
      breadthPct: 0.3,
      followThroughPct: 0.3,
      updatedAt: new Date(),
    });
    expect(neutral).toContain('🟡 중립');
  });
});
