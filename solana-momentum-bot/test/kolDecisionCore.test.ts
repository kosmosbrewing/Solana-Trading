import {
  buildKolExecutionGuardSnapshot,
  buildKolExecutionPlanSnapshot,
  buildLiveEquivalenceDecisionId,
  decisionActionForTrace,
  decisionIdForTrace,
  paperRoleForTrace,
  paperRoleForLiveEquivalence,
} from '../src/orchestration/kolDecisionCore';

describe('kolDecisionCore', () => {
  it('builds stable decision ids with normalized reasons', () => {
    expect(buildLiveEquivalenceDecisionId(
      'candidate-1',
      'yellow_zone',
      'block',
      'Single KOL live not enough!'
    )).toBe('candidate-1:yellow_zone:block:single_kol_live_not_enough_');
  });

  it('classifies paper roles from the same live-equivalence trace', () => {
    expect(paperRoleForLiveEquivalence('pre_execution_live_allowed', true)).toBe('mirror');
    expect(paperRoleForLiveEquivalence('default_paper', false)).toBe('research_arm');
    expect(paperRoleForLiveEquivalence('wallet_stop', false)).toBe('fallback_execution_safety');
    expect(paperRoleForTrace({
      liveEquivalenceDecisionStage: 'yellow_zone',
      liveEquivalenceLiveWouldEnter: false,
    }, { isShadowArm: false })).toBe('fallback_execution_safety');
    expect(paperRoleForTrace({
      paperRole: 'research_arm',
      liveEquivalenceDecisionStage: 'yellow_zone',
      liveEquivalenceLiveWouldEnter: false,
    }, { isShadowArm: true })).toBe('shadow');
  });

  it('derives action, decision id, and execution plan from one trace object', () => {
    const trace = {
      liveEquivalenceCandidateId: 'candidate-2',
      liveEquivalenceDecisionStage: 'live_fresh_reference_reject' as const,
      liveEquivalenceLiveWouldEnter: false,
      liveEquivalenceLiveBlockReason: 'fresh reference drift',
    };

    expect(decisionActionForTrace(trace)).toBe('block');
    expect(decisionIdForTrace(trace)).toBe(
      'candidate-2:live_fresh_reference_reject:block:fresh_reference_drift'
    );
    expect(buildKolExecutionPlanSnapshot({
      mode: 'paper',
      positionId: 'pos-1',
      trace,
      referencePrice: 0.001,
      ticketSol: 0.02,
      expectedQuantity: 20,
      tokenDecimals: 6,
      sellQuoteEvidence: { routeFound: true, reason: null },
    })).toEqual({
      schemaVersion: 'kol-execution-plan/v1',
      planId: 'candidate-2:live_fresh_reference_reject:block:fresh_reference_drift:paper:pos-1:plan',
      mode: 'paper',
      candidateId: 'candidate-2',
      decisionId: 'candidate-2:live_fresh_reference_reject:block:fresh_reference_drift',
      referencePrice: 0.001,
      ticketSol: 0.02,
      expectedQuantity: 20,
      tokenDecimals: 6,
      routeFound: true,
      sellQuoteReason: null,
      executionGuard: null,
    });
  });

  it('embeds execution guard snapshots in execution plans', () => {
    const guard = buildKolExecutionGuardSnapshot({
      guard: 'live_fresh_reference_reject',
      action: 'fallback_paper',
      reason: 'live_reference_drift_pct=0.6000',
      flags: ['LIVE_FRESH_REFERENCE_REJECT', 'LIVE_REFERENCE_DRIFT_PCT=0.6000'],
    });

    expect(buildKolExecutionPlanSnapshot({
      mode: 'paper',
      positionId: 'pos-guard',
      trace: {
        liveEquivalenceCandidateId: 'candidate-guard',
        liveEquivalenceDecisionStage: 'live_fresh_reference_reject',
        liveEquivalenceLiveWouldEnter: false,
      },
      referencePrice: 0.0016,
      ticketSol: 0.02,
      expectedQuantity: 12.5,
      executionGuard: guard,
    }).executionGuard).toEqual({
      schemaVersion: 'kol-execution-guard/v1',
      guard: 'live_fresh_reference_reject',
      action: 'fallback_paper',
      reason: 'live_reference_drift_pct=0.6000',
      flags: ['LIVE_FRESH_REFERENCE_REJECT', 'LIVE_REFERENCE_DRIFT_PCT=0.6000'],
    });
  });
});
