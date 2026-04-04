/**
 * Mission Score — MEASUREMENT.md Level 1 자동 계산
 *
 * 5개 컴포넌트 (100점 만점) + Composite Score
 */

export interface MissionScoreInput {
  /** 설명된 진입 비율 (0~1) */
  explainedEntryRatio: number;
  /** 이벤트 기반 진입 비율 (0~1) — context→trigger 일관성 proxy */
  eventEntryPct: number;
  /** 설명 없는 급등 추격 억제 점수 (0~1, 1=완벽 억제) */
  unexplainedSuppressionRate: number;
  /** Safety discipline 점수 (0~1, 1=위반 없음) */
  safetyDiscipline: number;
  /** Traceability 점수 (0~1, 1=역추적 완벽) */
  traceability: number;
}

export interface MissionScoreResult {
  total: number;
  components: {
    /** 25pts: 설명된 진입 비율 */
    contextClarity: number;
    /** 20pts: Context→Trigger 일관성 */
    eventAlignment: number;
    /** 20pts: 설명 없는 급등 추격 억제 */
    unexplainedSuppression: number;
    /** 20pts: Safety discipline */
    safetyDiscipline: number;
    /** 15pts: Traceability */
    traceability: number;
  };
}

const WEIGHTS = {
  contextClarity: 25,
  eventAlignment: 20,
  unexplainedSuppression: 20,
  safetyDiscipline: 20,
  traceability: 15,
} as const;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function computeMissionScore(input: MissionScoreInput): MissionScoreResult {
  const components = {
    contextClarity: clamp01(input.explainedEntryRatio) * WEIGHTS.contextClarity,
    eventAlignment: clamp01(input.eventEntryPct) * WEIGHTS.eventAlignment,
    unexplainedSuppression: clamp01(input.unexplainedSuppressionRate) * WEIGHTS.unexplainedSuppression,
    safetyDiscipline: clamp01(input.safetyDiscipline) * WEIGHTS.safetyDiscipline,
    traceability: clamp01(input.traceability) * WEIGHTS.traceability,
  };

  const total = components.contextClarity
    + components.eventAlignment
    + components.unexplainedSuppression
    + components.safetyDiscipline
    + components.traceability;

  return { total, components };
}

// ─── Composite Score ─────────────────────────────────
export interface CompositeScoreResult {
  composite: number;
  mission: number;
  execution: number;
  edge: number;
}

/**
 * Composite = Mission*0.40 + Execution*0.25 + Edge*0.35
 * MEASUREMENT.md 기준 가중치
 */
export function computeCompositeScore(
  mission: number,
  execution: number,
  edge: number
): CompositeScoreResult {
  const composite = mission * 0.40 + execution * 0.25 + edge * 0.35;
  return { composite, mission, execution, edge };
}
