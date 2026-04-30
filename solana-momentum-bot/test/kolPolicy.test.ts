import { evaluateKolShadowPolicy, summarizeKolStyle } from '../src/kol/policy';
import type { KolPolicyInput } from '../src/kol/policyTypes';

const BASE: KolPolicyInput = {
  eventKind: 'entry',
  tokenMint: 'MINT11111111111111111111111111111111111111',
  currentAction: 'enter',
  isLive: false,
  independentKolCount: 2,
  effectiveIndependentCount: 2,
  kolScore: 6,
  participatingKols: [
    { id: 'pain', tier: 'S', timestamp: 1, style: 'swing' },
    { id: 'dunpa', tier: 'A', timestamp: 2, style: 'swing' },
  ],
  survivalFlags: ['CLEAN_TOKEN'],
};

describe('kol shadow policy', () => {
  it('summarizes single and mixed KOL style buckets', () => {
    expect(summarizeKolStyle(BASE.participatingKols)).toBe('swing');
    expect(summarizeKolStyle([
      { id: 'a', tier: 'S', style: 'scalper' },
      { id: 'b', tier: 'A', style: 'longhold' },
    ])).toBe('mixed');
  });

  it('blocks missing security data before entry', () => {
    const decision = evaluateKolShadowPolicy({
      ...BASE,
      survivalFlags: ['NO_SECURITY_DATA'],
    }, '2026-04-30T00:00:00.000Z');

    expect(decision.recommendedAction).toBe('block');
    expect(decision.confidence).toBe('high');
    expect(decision.bucket.securityBucket).toBe('missing_security');
  });

  it('downgrades single-KOL live entry to paper fallback', () => {
    const decision = evaluateKolShadowPolicy({
      ...BASE,
      isLive: true,
      independentKolCount: 1,
      effectiveIndependentCount: 1,
      participatingKols: [{ id: 'pain', tier: 'S', style: 'unknown' }],
    });

    expect(decision.recommendedAction).toBe('paper_fallback');
    expect(decision.divergence).toBe(true);
    expect(decision.bucket.independentKolBucket).toBe('single');
  });

  it('flags adverse live entry advantage as paper-fallback policy candidate', () => {
    const decision = evaluateKolShadowPolicy({
      ...BASE,
      isLive: true,
      entryAdvantagePct: 0.12,
    });

    expect(decision.recommendedAction).toBe('paper_fallback');
    expect(decision.confidence).toBe('medium');
    expect(decision.divergence).toBe(true);
    expect(decision.reasons[0]).toBe('adverse_entry_advantage_pct=0.120000');
    expect(decision.metrics.entryAdvantagePct).toBe(0.12);
  });

  it('treats severe adverse live entry advantage as high confidence', () => {
    const decision = evaluateKolShadowPolicy({
      ...BASE,
      isLive: true,
      entryAdvantagePct: 0.22,
    });

    expect(decision.recommendedAction).toBe('paper_fallback');
    expect(decision.confidence).toBe('high');
    expect(decision.reasons[0]).toBe('adverse_entry_advantage_pct=0.220000');
  });

  it('records live execution-quality fallback as high-confidence paper fallback', () => {
    const decision = evaluateKolShadowPolicy({
      ...BASE,
      isLive: true,
      survivalFlags: ['LIVE_EXEC_QUALITY_COOLDOWN'],
    });

    expect(decision.recommendedAction).toBe('paper_fallback');
    expect(decision.confidence).toBe('high');
    expect(decision.reasons).toContain('live_execution_quality_cooldown');
  });

  it('records live fresh-reference reject as high-confidence paper fallback', () => {
    const decision = evaluateKolShadowPolicy({
      ...BASE,
      isLive: true,
      survivalFlags: ['LIVE_FRESH_REFERENCE_REJECT'],
    });

    expect(decision.recommendedAction).toBe('paper_fallback');
    expect(decision.confidence).toBe('high');
    expect(decision.reasons).toContain('live_fresh_reference_reject');
  });

  it('treats sell-route failure as structural exit on close', () => {
    const decision = evaluateKolShadowPolicy({
      ...BASE,
      eventKind: 'close',
      currentAction: 'exit',
      closeReason: 'structural_kill_sell_route',
      routeFound: false,
    });

    expect(decision.recommendedAction).toBe('exit');
    expect(decision.confidence).toBe('high');
    expect(decision.bucket.liquidityBucket).toBe('no_route');
  });

  it('does not recommend block for close events with stale security flags', () => {
    const decision = evaluateKolShadowPolicy({
      ...BASE,
      eventKind: 'close',
      currentAction: 'exit',
      closeReason: 'probe_hard_cut',
      survivalFlags: ['NO_SECURITY_CLIENT'],
    });

    expect(decision.recommendedAction).toBe('exit');
    expect(decision.divergence).toBe(false);
    expect(decision.reasons).toContain('missing_security_data_close_context');
  });

  it('downweights scalper sell-follow instead of full exit', () => {
    const decision = evaluateKolShadowPolicy({
      ...BASE,
      eventKind: 'close',
      currentAction: 'exit',
      closeReason: 'insider_exit_full',
      participatingKols: [{ id: 'fast', tier: 'A', style: 'scalper' }],
    });

    expect(decision.recommendedAction).toBe('reduce');
    expect(decision.divergence).toBe(true);
    expect(decision.reasons).toContain('scalper_sell_follow_downweighted');
  });
});
