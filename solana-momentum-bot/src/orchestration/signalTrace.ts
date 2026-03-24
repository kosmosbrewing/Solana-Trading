import { GateEvaluationResult } from '../gate';
import { BreakoutGrade, GateTraceSnapshot, Signal } from '../utils/types';

export function buildGateTraceSnapshot(
  gateResult: GateEvaluationResult
): GateTraceSnapshot {
  return {
    attentionScore: gateResult.attentionScore?.attentionScore,
    attentionConfidence: gateResult.attentionScore?.confidence,
    attentionSources: gateResult.attentionScore?.sources,
    rejected: gateResult.rejected,
    filterReason: gateResult.filterReason,
    gradeSizeMultiplier: gateResult.gradeSizeMultiplier,
    security: gateResult.securityGate
      ? {
        approved: gateResult.securityGate.approved,
        reason: gateResult.securityGate.reason,
        sizeMultiplier: gateResult.securityGate.sizeMultiplier,
        flags: gateResult.securityGate.flags,
      }
      : undefined,
    quote: gateResult.quoteGate
      ? {
        approved: gateResult.quoteGate.approved,
        reason: gateResult.quoteGate.reason,
        routeFound: gateResult.quoteGate.routeFound,
        priceImpactPct: gateResult.quoteGate.priceImpactPct,
        sizeMultiplier: gateResult.quoteGate.sizeMultiplier,
      }
      : undefined,
    execution: {
      rejected: gateResult.executionViability.rejected,
      filterReason: gateResult.executionViability.filterReason,
      effectiveRR: gateResult.executionViability.effectiveRR,
      roundTripCost: gateResult.executionViability.roundTripCost,
      sizeMultiplier: gateResult.executionViability.sizeMultiplier,
    },
    sellImpactPct: gateResult.sellImpactPct,
  };
}

export function buildPositionSignalData(
  signal: Signal,
  gateResult: GateEvaluationResult,
  totalScore: number,
  grade: BreakoutGrade
): Record<string, unknown> {
  return {
    signal: signal.meta,
    score: totalScore,
    grade,
    sourceLabel: signal.sourceLabel,
    attentionScore: gateResult.attentionScore?.attentionScore,
    attentionConfidence: gateResult.attentionScore?.confidence,
    breakoutScore: gateResult.breakoutScore,
    gateTrace: buildGateTraceSnapshot(gateResult),
  };
}
