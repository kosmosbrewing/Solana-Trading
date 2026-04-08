#!/usr/bin/env ts-node
/**
 * Fresh Funnel Audit
 *
 * Why: Phase 1 cohort instrumentation 의 검증 진입점.
 *   "fresh 토큰이 어느 funnel 단계에서 떨어지고 있는가?" 를
 *   runtime-diagnostics 이벤트만으로 cross-tab 집계한다.
 *
 *   본 스크립트는 runtime behavior 를 바꾸지 않는다. 단지 기록된 JSON 이벤트를 읽어
 *   cohort × funnel_stage 단계별 drop rate 와 Top drop reason 을 출력한다.
 *
 * Inputs (read-only):
 *   - data/realtime/runtime-diagnostics.json (RuntimeDiagnosticsStore persist 파일)
 *
 * Usage:
 *   npx ts-node scripts/analysis/fresh-funnel-audit.ts \
 *     [--path data/realtime/runtime-diagnostics.json] \
 *     [--hours 24] \
 *     [--top 5]
 */

import fs from 'fs';
import path from 'path';
import type { Cohort } from '../../src/scanner/cohort';
import { COHORT_ORDER } from '../../src/scanner/cohort';

interface RuntimeDiagnosticEventLite {
  type: string;
  timestampMs: number;
  tokenMint?: string;
  reason?: string;
  detail?: string;
  source?: string;
  dexId?: string;
  cohort?: Cohort;
}

interface RuntimeDiagnosticsFile {
  version?: number;
  updatedAt?: string;
  events?: RuntimeDiagnosticEventLite[];
}

type FunnelStage =
  | 'candidate_seen'
  | 'pre_watchlist_reject'
  | 'admission_skip'
  | 'candidate_evicted'
  | 'signal_not_in_watchlist'
  | 'risk_rejection';

const FUNNEL_STAGES: FunnelStage[] = [
  'candidate_seen',
  'pre_watchlist_reject',
  'admission_skip',
  'candidate_evicted',
  'signal_not_in_watchlist',
  'risk_rejection',
];

const FUNNEL_EVENT_TYPES: Record<FunnelStage, string> = {
  candidate_seen: 'realtime_candidate_seen',
  pre_watchlist_reject: 'pre_watchlist_reject',
  admission_skip: 'admission_skip',
  candidate_evicted: 'candidate_evicted',
  signal_not_in_watchlist: 'signal_not_in_watchlist',
  risk_rejection: 'risk_rejection',
};

interface Args {
  filePath: string;
  hours: number;
  topReasons: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    filePath: path.resolve('data/realtime/runtime-diagnostics.json'),
    hours: 24,
    topReasons: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === '--path' && i + 1 < argv.length) {
      args.filePath = path.resolve(argv[++i]);
    } else if (current === '--hours' && i + 1 < argv.length) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) args.hours = value;
    } else if (current === '--top' && i + 1 < argv.length) {
      const value = Number(argv[++i]);
      if (Number.isInteger(value) && value > 0) args.topReasons = value;
    } else if (current === '--help' || current === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: ts-node scripts/analysis/fresh-funnel-audit.ts [options]

Options:
  --path <file>    runtime-diagnostics.json path (default: data/realtime/runtime-diagnostics.json)
  --hours <n>      window size in hours (default: 24)
  --top <n>        top-N drop reasons per stage (default: 5)
  -h, --help       show this help

Examples:
  npx ts-node scripts/analysis/fresh-funnel-audit.ts --hours 24
`);
}

function loadEvents(filePath: string): RuntimeDiagnosticEventLite[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Runtime diagnostics file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as RuntimeDiagnosticsFile;
  if (!parsed.events || !Array.isArray(parsed.events)) {
    throw new Error(`Malformed runtime-diagnostics file: events array missing in ${filePath}`);
  }
  return parsed.events.filter(
    (event): event is RuntimeDiagnosticEventLite =>
      typeof event?.type === 'string' && typeof event?.timestampMs === 'number'
  );
}

function inferWindowEnd(events: RuntimeDiagnosticEventLite[]): number {
  // Why: 로그가 과거인 경우 Date.now() 기준 잘림 → 실제 관측 기간이 0 가 됨.
  //      기록된 가장 최근 timestamp 기준으로 window 를 잡는다.
  const latest = events.reduce((max, event) => Math.max(max, event.timestampMs), 0);
  return latest > 0 ? latest : Date.now();
}

function cohortOf(event: RuntimeDiagnosticEventLite): Cohort {
  return event.cohort ?? 'unknown';
}

function buildStageMatrix(events: RuntimeDiagnosticEventLite[]): Record<FunnelStage, Record<Cohort, number>> {
  const matrix: Record<FunnelStage, Record<Cohort, number>> = {
    candidate_seen: { fresh: 0, mid: 0, mature: 0, unknown: 0 },
    pre_watchlist_reject: { fresh: 0, mid: 0, mature: 0, unknown: 0 },
    admission_skip: { fresh: 0, mid: 0, mature: 0, unknown: 0 },
    candidate_evicted: { fresh: 0, mid: 0, mature: 0, unknown: 0 },
    signal_not_in_watchlist: { fresh: 0, mid: 0, mature: 0, unknown: 0 },
    risk_rejection: { fresh: 0, mid: 0, mature: 0, unknown: 0 },
  };
  const stageByType: Record<string, FunnelStage> = {};
  for (const stage of FUNNEL_STAGES) {
    stageByType[FUNNEL_EVENT_TYPES[stage]] = stage;
  }
  for (const event of events) {
    const stage = stageByType[event.type];
    if (!stage) continue;
    matrix[stage][cohortOf(event)]++;
  }
  return matrix;
}

function buildReasonBreakdown(
  events: RuntimeDiagnosticEventLite[],
  cohort: Cohort,
  stage: FunnelStage,
  topN: number
): Array<{ reason: string; count: number }> {
  const eventType = FUNNEL_EVENT_TYPES[stage];
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== eventType) continue;
    if (cohortOf(event) !== cohort) continue;
    // Why: cohort 라벨 'unknown' 과 혼동되지 않도록 reason-fallback 은 별도 문자열 사용.
    const key = event.reason || event.detail || '(no_reason)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([reason, count]) => ({ reason, count }));
}

function formatMatrix(
  matrix: Record<FunnelStage, Record<Cohort, number>>
): string {
  const header = ['stage', ...COHORT_ORDER].join(' | ');
  const divider = ['---', ...COHORT_ORDER.map(() => '---')].join(' | ');
  const rows = FUNNEL_STAGES.map((stage) => {
    const cells = [stage, ...COHORT_ORDER.map((cohort) => matrix[stage][cohort].toString())];
    return cells.join(' | ');
  });
  return [`| ${header} |`, `| ${divider} |`, ...rows.map((row) => `| ${row} |`)].join('\n');
}

function formatDropRates(matrix: Record<FunnelStage, Record<Cohort, number>>): string {
  const lines: string[] = [];
  lines.push('\n## Drop rates (relative to candidate_seen per cohort)');
  lines.push('');
  for (const cohort of COHORT_ORDER) {
    const seen = matrix.candidate_seen[cohort];
    if (seen === 0) {
      lines.push(`- ${cohort}: candidate_seen=0 (skipped)`);
      continue;
    }
    const parts: string[] = [`seen=${seen}`];
    for (const stage of FUNNEL_STAGES) {
      if (stage === 'candidate_seen') continue;
      const count = matrix[stage][cohort];
      const pct = ((count / seen) * 100).toFixed(1);
      parts.push(`${stage}=${count} (${pct}%)`);
    }
    lines.push(`- ${cohort}: ${parts.join(' | ')}`);
  }
  return lines.join('\n');
}

function formatTopReasons(
  events: RuntimeDiagnosticEventLite[],
  topN: number
): string {
  const lines: string[] = [];
  lines.push('\n## Top drop reasons by cohort × stage');
  for (const cohort of COHORT_ORDER) {
    lines.push('');
    lines.push(`### cohort=${cohort}`);
    let anyPrinted = false;
    for (const stage of FUNNEL_STAGES) {
      if (stage === 'candidate_seen') continue;
      const rows = buildReasonBreakdown(events, cohort, stage, topN);
      if (rows.length === 0) continue;
      anyPrinted = true;
      const formatted = rows.map((row) => `${row.reason}=${row.count}`).join(', ');
      lines.push(`- ${stage}: ${formatted}`);
    }
    if (!anyPrinted) {
      lines.push('- (no drops in this cohort)');
    }
  }
  return lines.join('\n');
}

function formatVerdict(
  matrix: Record<FunnelStage, Record<Cohort, number>>
): string {
  const freshSeen = matrix.candidate_seen.fresh;
  const freshRejected =
    matrix.pre_watchlist_reject.fresh +
    matrix.admission_skip.fresh +
    matrix.candidate_evicted.fresh;
  const freshRejectRate = freshSeen > 0 ? (freshRejected / freshSeen) * 100 : null;

  const lines: string[] = [];
  lines.push('\n## Verdict');
  if (freshSeen === 0) {
    lines.push('- fresh cohort candidate_seen=0 → 신생 pair 가 pipeline 에 전혀 도달하지 못함.');
    lines.push('  · Phase 1 instrumentation 확인 필요: listingSourceAdapter / candidateFilter 에 cohort 태깅 누락?');
  } else {
    lines.push(`- fresh candidate_seen=${freshSeen}, funnel drop=${freshRejected} (${(freshRejectRate ?? 0).toFixed(1)}%)`);
    if ((freshRejectRate ?? 0) >= 80) {
      lines.push('  · 80%+ drop → Phase 2 (lane rewire, admission relaxation) 진입 정당화됨.');
    } else if ((freshRejectRate ?? 0) >= 50) {
      lines.push('  · 50-80% drop → Phase 2 진입 전 top reason 기준으로 타겟팅 완화 필요.');
    } else {
      lines.push('  · <50% drop → fresh 는 통과하고 있다. edge/execution 쪽 회귀 여부 의심.');
    }
  }
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const allEvents = loadEvents(args.filePath);
  const windowEnd = inferWindowEnd(allEvents);
  const cutoffMs = windowEnd - args.hours * 3_600_000;
  const recent = allEvents.filter((event) => event.timestampMs >= cutoffMs);

  const matrix = buildStageMatrix(recent);

  const lines: string[] = [];
  lines.push(`# Fresh Funnel Audit`);
  lines.push('');
  lines.push(`- file: ${args.filePath}`);
  lines.push(`- window: last ${args.hours}h (ending ${new Date(windowEnd).toISOString()})`);
  lines.push(`- events total: ${allEvents.length}, in window: ${recent.length}`);
  lines.push('');
  lines.push('## Stage × Cohort counts');
  lines.push('');
  lines.push(formatMatrix(matrix));
  lines.push(formatDropRates(matrix));
  lines.push(formatTopReasons(recent, args.topReasons));
  lines.push(formatVerdict(matrix));
  console.log(lines.join('\n'));
}

try {
  main();
} catch (err) {
  console.error(`[fresh-funnel-audit] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
