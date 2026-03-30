import { GateEvaluationResult } from '../gate';
import { BreakoutGrade, GateTraceSnapshot, Signal } from '../utils/types';

export function buildGateTraceSnapshot(
  gateResult: GateEvaluationResult,
  options: {
    postSizeExecution?: GateEvaluationResult['executionViability'];
  } = {}
): GateTraceSnapshot {
  const preGateExecution = buildExecutionTrace(gateResult.executionViability);
  const postSizeExecution = options.postSizeExecution
    ? buildExecutionTrace(options.postSizeExecution)
    : undefined;

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
      ...preGateExecution,
      preGate: preGateExecution,
      postSize: postSizeExecution,
    },
    sellImpactPct: gateResult.sellImpactPct,
  };
}

export function buildPositionSignalData(
  signal: Signal,
  gateResult: GateEvaluationResult,
  totalScore: number,
  grade: BreakoutGrade,
  postSizeExecution?: GateEvaluationResult['executionViability']
): Record<string, unknown> {
  return {
    signal: signal.meta,
    score: totalScore,
    grade,
    sourceLabel: signal.sourceLabel,
    attentionScore: gateResult.attentionScore?.attentionScore,
    attentionConfidence: gateResult.attentionScore?.confidence,
    breakoutScore: gateResult.breakoutScore,
    gateTrace: buildGateTraceSnapshot(gateResult, { postSizeExecution }),
  };
}

function buildExecutionTrace(
  execution: GateEvaluationResult['executionViability']
): GateTraceSnapshot['execution'] {
  return {
    rejected: execution.rejected,
    filterReason: execution.filterReason,
    effectiveRR: execution.effectiveRR,
    roundTripCost: execution.roundTripCost,
    sizeMultiplier: execution.sizeMultiplier,
    riskPct: execution.riskPct,
    rewardPct: execution.rewardPct,
    entryPriceImpactPct: execution.entryPriceImpactPct,
    exitPriceImpactPct: execution.exitPriceImpactPct,
    quantity: execution.quantity,
    notionalSol: execution.notionalSol,
  };
}
