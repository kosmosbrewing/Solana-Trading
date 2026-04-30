import {
  buildKolPolicyReport,
  parsePolicyDecisionRows,
  renderKolPolicyReportMarkdown,
} from '../scripts/kol-policy-report';
import type { KolPolicyDecision } from '../src/kol/policyTypes';

function decision(overrides: Partial<KolPolicyDecision> = {}): KolPolicyDecision {
  return {
    schemaVersion: 'kol-policy-shadow/v1',
    generatedAt: '2026-04-30T00:00:00.000Z',
    eventKind: 'entry',
    tokenMint: 'MINT11111111111111111111111111111111111111',
    bucket: {
      eventKind: 'entry',
      style: 'swing',
      entryReason: 'velocity',
      independentKolBucket: 'single',
      securityBucket: 'clean_or_unknown',
      liquidityBucket: 'route_ok_or_unknown',
      dayQualityBucket: 'unknown',
    },
    currentAction: 'enter',
    recommendedAction: 'paper_fallback',
    divergence: true,
    confidence: 'high',
    reasons: ['single_kol_live_not_enough'],
    riskFlags: ['LIVE_MIN_KOL'],
    metrics: {
      isLive: true,
      isShadowArm: false,
      independentKolCount: 1,
      effectiveIndependentCount: 1,
      kolScore: 4,
      mfePct: null,
      maePct: null,
      peakDriftPct: null,
      holdSec: null,
      walletSol: null,
      recentJupiter429: 0,
      routeFound: true,
      sellImpactPct: null,
      entryAdvantagePct: null,
      swapQuoteEntryAdvantagePct: null,
      referenceToSwapQuotePct: null,
      buyExecutionMs: null,
    },
    context: {
      armName: 'kol_hunter_smart_v3',
      entryReason: 'velocity',
      closeReason: null,
      rejectReason: null,
      participatingKols: [{ id: 'pain', tier: 'S', style: 'swing' }],
      survivalFlags: ['LIVE_MIN_KOL'],
    },
    ...overrides,
  };
}

describe('kol-policy-report', () => {
  it('parses valid policy jsonl rows and skips corrupt rows', () => {
    const rows = parsePolicyDecisionRows([
      JSON.stringify(decision()),
      '{bad json',
      JSON.stringify({ schemaVersion: 'other' }),
    ].join('\n'));

    expect(rows).toHaveLength(1);
    expect(rows[0].recommendedAction).toBe('paper_fallback');
  });

  it('summarizes divergences by action and bucket', () => {
    const report = buildKolPolicyReport([
      decision(),
      decision({
        generatedAt: '2026-04-29T23:59:00.000Z',
        eventKind: 'close',
        currentAction: 'exit',
        recommendedAction: 'reduce',
        confidence: 'medium',
        reasons: ['scalper_sell_follow_downweighted'],
        bucket: {
          eventKind: 'close',
          style: 'scalper',
          entryReason: 'velocity',
          independentKolBucket: 'multi_2_3',
          securityBucket: 'clean_or_unknown',
          liquidityBucket: 'route_ok_or_unknown',
          dayQualityBucket: 'unknown',
        },
      }),
    ], {
      nowMs: Date.parse('2026-04-30T00:01:00.000Z'),
      windowHours: 24,
      inputPath: 'data/realtime/kol-policy-decisions.jsonl',
    });

    expect(report.total).toBe(2);
    expect(report.divergences).toBe(2);
    expect(report.highConfidenceDivergences).toBe(1);
    expect(report.byRecommendedAction.map((r) => r.bucket)).toContain('paper_fallback');
    expect(report.byEntryAdvantage.map((r) => r.bucket)).toContain('entry/unknown');
    expect(report.topReasons[0].key).toBe('scalper_sell_follow_downweighted');
  });

  it('summarizes adverse entry-advantage policy divergences', () => {
    const report = buildKolPolicyReport([
      decision({
        reasons: ['adverse_entry_advantage_pct=0.120000'],
        confidence: 'medium',
        metrics: {
          ...decision().metrics,
          entryAdvantagePct: 0.12,
        },
      }),
      decision({
        tokenMint: 'MINT22222222222222222222222222222222222222',
        confidence: 'high',
        reasons: ['adverse_entry_advantage_pct=0.250000'],
        metrics: {
          ...decision().metrics,
          entryAdvantagePct: 0.25,
        },
      }),
    ], {
      nowMs: Date.parse('2026-04-30T00:01:00.000Z'),
      windowHours: 24,
    });

    expect(report.byEntryAdvantage.find((row) => row.bucket === 'entry/adverse_5..20%')?.divergences).toBe(1);
    expect(report.byEntryAdvantage.find((row) => row.bucket === 'entry/adverse>=20%')?.highConfidenceDivergences).toBe(1);
    expect(report.topReasons.some((row) => row.key === 'adverse_entry_advantage_pct=0.250000')).toBe(true);
  });

  it('renders markdown with high-confidence samples', () => {
    const report = buildKolPolicyReport([decision()], {
      nowMs: Date.parse('2026-04-30T00:01:00.000Z'),
      windowHours: 24,
    });
    const md = renderKolPolicyReportMarkdown(report);

    expect(md).toContain('# KOL Policy Shadow Report');
    expect(md).toContain('High-confidence divergences: 1');
    expect(md).toContain('## By Entry Advantage');
    expect(md).toContain('single_kol_live_not_enough');
  });
});
