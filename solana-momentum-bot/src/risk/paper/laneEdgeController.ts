/**
 * Lane Edge Controller — Kelly Controller P1 (2026-04-26)
 *
 * ADR: docs/design-docs/lane-edge-controller-kelly-2026-04-25.md §10 P1
 *
 * **REPORT-ONLY**: 본 controller 는 actual entry path 에 wired 되지 않는다.
 *                  emit 한 control output 은 운영자 보고서로만 사용. Phase P2 에서만 active wiring.
 *
 * Pipeline:
 *   reconciled outcomes (P0)
 *     → cohort 별 group (laneName × armName × cluster)
 *     → kellyEligible 만 metric 계산
 *     → Wilson LCB(win_rate) + bootstrap p10(rr) → conservative Kelly
 *     → control output (entry_mode / ticket_cap_sol / max_concurrent / cooldown_sec / reason)
 *
 * Hard constraints:
 *  - ticket_cap_sol 은 항상 lane hard lock 으로 clip — 자동 증가 없음 (ADR §7.1)
 *  - paperOnly outcome 은 P0 에서 이미 kellyEligible=false → 자동 제외
 *  - n < 30 cohort 는 Kelly skip (display-only)
 *  - n < 50 cohort 는 throttle 결정에 영향 금지 (preliminary)
 *  - wallet drift 발견 시 entry_mode=halted, Kelly=0 강제
 */
import type { LaneOutcomeRecord, LaneName } from '../laneOutcomeTypes';
import {
  wilsonLowerBound,
  bootstrapRewardRiskP10,
  conservativeKelly,
  rawKelly,
  mean,
  median,
  maxStreak,
  sum,
} from './laneEdgeStatistics';

export type EntryMode =
  | 'keep'              // n ≥ 100, conservative Kelly > 0 — normal live attempts
  | 'throttle'          // n ≥ 100, Kelly ≤ 0 — reduce max_concurrent
  | 'quarantine'        // n ≥ 100, Kelly ≤ 0 + 추가 신호 (drift / 연속 손실) — entry 차단
  | 'paper_only'        // 50 ≤ n < 100, expectancy ≤ 0 — live 차단
  | 'display_only'      // n < 50 — preliminary, 결정 영향 없음
  | 'halted';           // wallet mismatch / drift halt active — Kelly 강제 0

export interface CohortKey {
  laneName: LaneName;
  armName: string;
  /** kolCluster 가 있으면 우선, 없으면 discoverySource. P0/P1 한정 3 차원. */
  cluster: string;
}

export interface CohortMetrics {
  cohort: CohortKey;
  cohortKey: string;
  n: number;
  /** Wilson LCB 95% — n>=30 만 의미 있음. */
  winRate: number;
  winRateLcb: number;
  avgWinSol: number;
  avgLossSol: number;
  rewardRisk: number;       // mean(wins)/|mean(losses)|
  rewardRiskP10: number;    // bootstrap
  expectancySol: number;
  cashFlowSol: number;
  rawKelly: number;
  conservativeKelly: number;
  maxLossStreak: number;
  /**
   * runner_contribution = pnl_from_T2/T3 visited (positive only) / total winning pnl.
   * QA F4 (2026-04-26): 분모를 totalWinningPnl 로 정정 (음수 cashflow → 음수 비율 misleading 차단).
   * 정책: T2/T3 방문했지만 손실 close 한 trade 는 분자에서 제외 (runner failure 는 별도 metric 후보).
   */
  runnerContribution: number;
  /** preliminary flag — n < 50 시 throttle 결정에 영향 안 줌. */
  preliminary: boolean;
  /** display-only — n < 30. */
  displayOnly: boolean;
}

export interface ControlOutput {
  cohortKey: string;
  entryMode: EntryMode;
  /** 항상 lane hard lock 으로 clip. Kelly 양수여도 자동 증가 0. */
  ticketCapSol: number;
  /** 추천 max concurrent. lane 의 현재 cap 보다 작거나 같음. */
  maxConcurrent: number;
  /** per-pair cooldown 추천. 기존 값보다 길거나 같음 (Kelly 음수 시 늘림). */
  cooldownSec: number;
  reason: string;
}

export interface ControllerConfig {
  /** Lane 별 hard lock ticket. 기본 0.01. ticket_cap_sol output 의 ceiling. */
  laneHardLockTicketSol: Record<string, number>;
  /** Lane 별 default max concurrent. 기본 3. */
  laneDefaultMaxConcurrent: Record<string, number>;
  /** Lane 별 default cooldown sec. 기본 300. */
  laneDefaultCooldownSec: Record<string, number>;
  /** wallet drift halt 활성 시 모든 cohort 강제 halted. */
  walletDriftHaltActive: boolean;
  /** Bootstrap iterations. 기본 1000. */
  bootstrapIterations: number;
  /** Bootstrap seed (deterministic 재현). 기본 42. */
  bootstrapSeed: number;
  /** Wilson z-score (95%=1.96 / 98%=2.33). 기본 1.96. */
  wilsonZ: number;
  /**
   * QA F2/F7 (2026-04-26 보강): bootstrap 의 avgLoss=0 sample cap.
   * 기본 100 (Kelly clamp 1 으로 saturate). 운영 데이터 후 운영자 튜닝 가능.
   */
  bootstrapZeroLossRrCap: number;
}

export const DEFAULT_CONTROLLER_CONFIG: ControllerConfig = {
  laneHardLockTicketSol: {
    cupsey_flip_10s: 0.01,
    pure_ws_breakout: 0.01,
    kol_hunter: 0.01,
    migration_reclaim: 0.01,
  },
  laneDefaultMaxConcurrent: {
    cupsey_flip_10s: 3,
    pure_ws_breakout: 3,
    kol_hunter: 3,
    migration_reclaim: 3,
  },
  laneDefaultCooldownSec: {
    cupsey_flip_10s: 300,
    pure_ws_breakout: 300,
    kol_hunter: 1800,
    migration_reclaim: 300,
  },
  walletDriftHaltActive: false,
  bootstrapIterations: 1000,
  bootstrapSeed: 42,
  wilsonZ: 1.96,
  bootstrapZeroLossRrCap: 100,
};

// ─── Cohort grouping ───

export function buildCohortKeyFromRecord(record: LaneOutcomeRecord): CohortKey {
  // P0/P1 cohort: laneName × armName × (kolCluster or discoverySource)
  const cluster = record.discoverySource ?? 'na';
  return {
    laneName: record.laneName,
    armName: record.armName,
    cluster,
  };
}

export function cohortKeyToString(key: CohortKey): string {
  return `${key.laneName}|${key.armName}|${key.cluster}`;
}

/**
 * 입력 outcome 들을 cohort 별로 group.
 * **kellyEligible=false 는 자동 제외** (P0 에서 분류된 record 그대로 사용).
 */
export function groupByCohort(records: LaneOutcomeRecord[]): Map<string, LaneOutcomeRecord[]> {
  const groups = new Map<string, LaneOutcomeRecord[]>();
  for (const r of records) {
    if (!r.kellyEligible) continue; // 강제 제외
    const key = cohortKeyToString(buildCohortKeyFromRecord(r));
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  return groups;
}

// ─── Cohort metrics ───

export function computeCohortMetrics(
  records: LaneOutcomeRecord[],
  cfg: ControllerConfig = DEFAULT_CONTROLLER_CONFIG
): CohortMetrics {
  const cohort = records.length > 0
    ? buildCohortKeyFromRecord(records[0])
    : { laneName: 'unknown' as LaneName, armName: 'default', cluster: 'na' };
  const cohortKey = cohortKeyToString(cohort);
  const n = records.length;

  const pnls = records
    .map((r) => r.realizedPnlSol)
    .filter((v): v is number => typeof v === 'number');
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  // QA F3 (2026-04-26): pnl=0 trade 는 win/loss 어느 쪽도 아님.
  //   winRate 분모는 (wins + losses) 만 사용 — neutral trade 제외.
  //   n 은 cohort 의 trade 수 (전체) — 표본 임계 판정 (n<30/<50) 에는 그대로 사용.
  // n 과 (wins+losses) 가 다를 수 있다 — 본 차이는 보고서에 표시.
  const winsCount = wins.length;
  const lossesCount = losses.length;
  const decisiveTrades = winsCount + lossesCount;

  const winRate = decisiveTrades > 0 ? winsCount / decisiveTrades : 0;
  const winRateLcb = wilsonLowerBound(winsCount, decisiveTrades, cfg.wilsonZ);
  const avgWinSol = wins.length > 0 ? mean(wins) : 0;
  const avgLossSol = losses.length > 0 ? Math.abs(mean(losses)) : 0;
  const rewardRisk = avgLossSol > 0 ? avgWinSol / avgLossSol : (avgWinSol > 0 ? 100 : 0);
  const rewardRiskP10 = bootstrapRewardRiskP10(
    wins,
    losses.map((l) => Math.abs(l)),
    cfg.bootstrapIterations,
    cfg.bootstrapSeed,
    cfg.bootstrapZeroLossRrCap
  );
  const expectancySol = winRate * avgWinSol - (1 - winRate) * avgLossSol;
  const cashFlowSol = sum(pnls);
  const rawK = rawKelly(winRate, rewardRisk);
  const consK = conservativeKelly(winRateLcb, rewardRiskP10);

  const maxLossStreak = maxStreak(records, (r) => (r.realizedPnlSol ?? 0) < 0);

  // runner_contribution: T2/T3 방문 + positive close trade 의 pnl 합 / total winning pnl
  // QA F4 + Open Q2 (2026-04-26):
  //   - 분모: winners 의 합 (totalWinningPnl) — 음수 cashflow 시 misleading 차단
  //   - 분자: T2/T3 visit 했고 positive close 인 trade 만 — runner failure (방문 후 손실) 는 분자 제외
  //     (정책: ADR §6 의 "runner_contribution = pnl_from_T1_T2_T3 / total_pnl" 의 의도는 "기여도",
  //      손실 trade 는 contribution 아니라 failure → 별도 metric 후보)
  const totalWinningPnl = sum(wins);
  const runnerPnl = sum(
    records
      .filter((r) => (r.t2VisitAtSec != null || r.t3VisitAtSec != null) && (r.realizedPnlSol ?? 0) > 0)
      .map((r) => r.realizedPnlSol ?? 0)
  );
  const runnerContribution = totalWinningPnl > 0 ? runnerPnl / totalWinningPnl : 0;

  return {
    cohort,
    cohortKey,
    n,
    winRate,
    winRateLcb,
    avgWinSol,
    avgLossSol,
    rewardRisk,
    rewardRiskP10,
    expectancySol,
    cashFlowSol,
    rawKelly: rawK,
    conservativeKelly: consK,
    maxLossStreak,
    runnerContribution,
    preliminary: n < 50,
    displayOnly: n < 30,
  };
}

// ─── Control output (suggested policy) ───

/**
 * Cohort metrics → control action.
 * ADR §8 정책 표 준수.
 */
export function deriveControlOutput(
  metrics: CohortMetrics,
  cfg: ControllerConfig = DEFAULT_CONTROLLER_CONFIG
): ControlOutput {
  const lane = metrics.cohort.laneName;
  const hardLock = cfg.laneHardLockTicketSol[lane] ?? 0.01;
  const defaultConc = cfg.laneDefaultMaxConcurrent[lane] ?? 3;
  const defaultCooldown = cfg.laneDefaultCooldownSec[lane] ?? 300;

  // 항상 lane hard lock 으로 clip — 자동 증가 절대 없음 (ADR §7.1)
  const ticketCapSol = hardLock;

  // wallet drift halt — 모든 cohort halted, Kelly 무시
  if (cfg.walletDriftHaltActive) {
    return {
      cohortKey: metrics.cohortKey,
      entryMode: 'halted',
      ticketCapSol,
      maxConcurrent: 0,
      cooldownSec: defaultCooldown,
      reason: 'wallet_drift_halt_active — Kelly forced to 0 (ADR §8)',
    };
  }

  // n < 30 → display only
  if (metrics.displayOnly) {
    return {
      cohortKey: metrics.cohortKey,
      entryMode: 'display_only',
      ticketCapSol,
      maxConcurrent: defaultConc,
      cooldownSec: defaultCooldown,
      reason: `n=${metrics.n} < 30 — display only, no throttle effect`,
    };
  }

  // 30 ≤ n < 50 → preliminary, fixed ticket, normal concurrent
  if (metrics.preliminary) {
    return {
      cohortKey: metrics.cohortKey,
      entryMode: 'display_only',
      ticketCapSol,
      maxConcurrent: defaultConc,
      cooldownSec: defaultCooldown,
      reason: `n=${metrics.n} preliminary (< 50) — Kelly informational only`,
    };
  }

  // 50 ≤ n < 100 → expectancy 음수면 paper_only (live 차단)
  if (metrics.n < 100) {
    if (metrics.expectancySol <= 0) {
      return {
        cohortKey: metrics.cohortKey,
        entryMode: 'paper_only',
        ticketCapSol,
        maxConcurrent: Math.max(1, Math.floor(defaultConc / 2)),
        cooldownSec: defaultCooldown * 2,
        reason: `n=${metrics.n} expectancy=${metrics.expectancySol.toFixed(6)} ≤ 0 — paper_only (ADR §8)`,
      };
    }
    return {
      cohortKey: metrics.cohortKey,
      entryMode: 'keep',
      ticketCapSol,
      maxConcurrent: defaultConc,
      cooldownSec: defaultCooldown,
      reason: `n=${metrics.n} expectancy=${metrics.expectancySol.toFixed(6)} > 0 — keep, fixed ticket`,
    };
  }

  // n ≥ 100 → conservative Kelly 기반
  if (metrics.conservativeKelly <= 0) {
    // negative Kelly + 강한 신호 (e.g. consec loss ≥ 8) → quarantine
    const isQuarantine = metrics.maxLossStreak >= 8 || metrics.cashFlowSol < -0.3;
    if (isQuarantine) {
      return {
        cohortKey: metrics.cohortKey,
        entryMode: 'quarantine',
        ticketCapSol,
        maxConcurrent: 0,
        cooldownSec: defaultCooldown * 4,
        reason:
          `n=${metrics.n} consK=${metrics.conservativeKelly.toFixed(4)} ≤ 0 + ` +
          `streak=${metrics.maxLossStreak} cashflow=${metrics.cashFlowSol.toFixed(4)} — quarantine`,
      };
    }
    return {
      cohortKey: metrics.cohortKey,
      entryMode: 'throttle',
      ticketCapSol,
      maxConcurrent: Math.max(1, Math.floor(defaultConc / 2)),
      cooldownSec: defaultCooldown * 2,
      reason: `n=${metrics.n} consK=${metrics.conservativeKelly.toFixed(4)} ≤ 0 — throttle`,
    };
  }

  // n ≥ 100 + Kelly > 0 → keep. ticket 자동 증가 없음.
  // n ≥ 200 + log_growth > 0 일 때만 ticket cap 증가 후보 — 그러나 자동 unlock 금지 (별도 ADR).
  return {
    cohortKey: metrics.cohortKey,
    entryMode: 'keep',
    ticketCapSol,
    maxConcurrent: defaultConc,
    cooldownSec: defaultCooldown,
    reason:
      `n=${metrics.n} consK=${metrics.conservativeKelly.toFixed(4)} > 0 — keep, fixed ticket. ` +
      `cap unlock 은 Stage 4 SCALE + 별도 ADR 후만 (§7.1)`,
  };
}

// ─── Top-level: outcomes → controller report ───

export interface ControllerReport {
  generatedAt: string;
  totalOutcomes: number;
  eligibleOutcomes: number;
  cohorts: Array<CohortMetrics & ControlOutput>;
  /** 운영자가 매일 확인할 핵심 요약. */
  highlights: {
    bestCohortByConsK: string | null;
    worstCohortByConsK: string | null;
    quarantinedCohorts: string[];
    paperOnlyCohorts: string[];
  };
}

export function buildControllerReport(
  records: LaneOutcomeRecord[],
  cfg: Partial<ControllerConfig> = {}
): ControllerReport {
  const fullCfg: ControllerConfig = { ...DEFAULT_CONTROLLER_CONFIG, ...cfg };
  const groups = groupByCohort(records);
  const cohorts: Array<CohortMetrics & ControlOutput> = [];

  for (const [, recs] of groups) {
    const metrics = computeCohortMetrics(recs, fullCfg);
    const output = deriveControlOutput(metrics, fullCfg);
    cohorts.push({ ...metrics, ...output });
  }

  // sort by conservativeKelly desc — Kelly 동률 시 cohortKey 사전순 (stable, 결정적)
  // QA F9 (2026-04-26): JS sort 는 stable 보장되지만 비교 함수의 tie-breaker 가 명시적이어야
  //   동일 입력 → 동일 출력 (CI / report diff 검증 안전).
  cohorts.sort((a, b) => {
    const dk = b.conservativeKelly - a.conservativeKelly;
    if (dk !== 0) return dk;
    return a.cohortKey.localeCompare(b.cohortKey);
  });

  const eligibleOutcomes = records.filter((r) => r.kellyEligible).length;
  const quarantined = cohorts.filter((c) => c.entryMode === 'quarantine').map((c) => c.cohortKey);
  const paperOnly = cohorts.filter((c) => c.entryMode === 'paper_only').map((c) => c.cohortKey);
  const validForBest = cohorts.filter((c) => c.n >= 50);

  return {
    generatedAt: new Date().toISOString(),
    totalOutcomes: records.length,
    eligibleOutcomes,
    cohorts,
    highlights: {
      bestCohortByConsK: validForBest.length > 0 ? validForBest[0].cohortKey : null,
      worstCohortByConsK: validForBest.length > 0 ? validForBest[validForBest.length - 1].cohortKey : null,
      quarantinedCohorts: quarantined,
      paperOnlyCohorts: paperOnly,
    },
  };
}
