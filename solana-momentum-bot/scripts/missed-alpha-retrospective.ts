#!/usr/bin/env ts-node
/**
 * Missed Alpha Retrospective (2026-04-29)
 *
 * Why: missed-alpha.jsonl observer 가 T+30/60/300/1800/7200s 마다 reject 이후 Jupiter price
 *      delta 를 적재한다. 이 데이터를 분류별로 percentile / false-negative rate 로 집계해
 *      "우리가 옳게 cut 했는지" 정량 판정. mission-refinement §5 Stage 2 분모 (놓친 winner)
 *      를 산출하기 위한 retrospective.
 *
 * 입력: data/realtime/missed-alpha.jsonl
 *   한 줄 = 한 probe tick (eventId + offsetSec). 같은 eventId 가 여러 줄에 나뉘므로 먼저
 *   eventId 로 묶어서 timeseries 로 변환 후 분석.
 *
 * 산출:
 *   - per-rejectCategory cohort 의 p25/p50/p75 mfe @ 1800s, p50 mfe @ 7200s
 *   - falseNegRate (mfe ≥ +50%, "would-have-been winner" 비율)
 *   - fivexFalseNeg (mfe ≥ +400%, "5x winner" 차단 count)
 *   - overall falseNegRate + alertLevel 분기 (normal/warn/critical)
 *
 * Alert 발화:
 *   - alertLevel === 'critical' 시 data/realtime/missed-alpha-alert.json 생성.
 *     운영자 review 용 단순 hint — observer/script 가 trade 결정에 간섭하지 않는 원칙 유지.
 *
 * 사용:
 *   npx ts-node scripts/missed-alpha-retrospective.ts --window-days=7
 *   npx ts-node scripts/missed-alpha-retrospective.ts --window-days=1 \
 *     --reject-category=survival_concentration
 *   npx ts-node scripts/missed-alpha-retrospective.ts --in /custom/path.jsonl
 */
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

// ─── Public types (test 에서 직접 import) ────────────────────────────────

export interface ProbeRecord {
  eventId: string;
  tokenMint: string;
  lane: string;
  rejectCategory: string;
  rejectReason: string;
  signalPrice: number;
  rejectedAt: string; // ISO
  probe: {
    offsetSec: number;
    firedAt: string;
    observedPrice: number | null;
    deltaPct: number | null;
    quoteStatus: string;
    quoteReason?: string | null;
  };
}

/** Aggregated per-event view (한 reject 의 모든 offset probe 한 묶음). */
export interface EventTimeline {
  eventId: string;
  tokenMint: string;
  lane: string;
  rejectCategory: string;
  rejectReason: string;
  rejectedAtMs: number;
  /** offsetSec → deltaPct (관측 성공한 probe 만). */
  deltaByOffset: Map<number, number>;
}

export interface CategoryStat {
  count: number;
  /** mfe(1800s) percentile — observation 있는 event 만 분모. */
  p25_t1800_mfe: number | null;
  p50_t1800_mfe: number | null;
  p75_t1800_mfe: number | null;
  /** mfe(7200s) p50. */
  p50_t7200_mfe: number | null;
  /** mfe ≥ 50% (1800s 또는 7200s 둘 중 best) 비율 — would-have-been winner. */
  falseNegRate: number;
  /** mfe ≥ 400% (5x+ winner) count — 단순 카운트, 가장 critical signal. */
  fivexFalseNeg: number;
}

export interface RetroAnalysis {
  windowDays: number;
  totalRejects: number;
  byCategory: Map<string, CategoryStat>;
  overallFalseNegRate: number;
  alertLevel: 'normal' | 'warn' | 'critical';
}

// ─── Constants ────────────────────────────────────────────────────────────

const WOULD_BE_WINNER_THRESHOLD = 0.50; // mfe ≥ +50%
const FIVEX_WINNER_THRESHOLD = 4.00;   // mfe ≥ +400%
const ALERT_WARN_THRESHOLD = 0.10;     // 10%
const ALERT_CRITICAL_THRESHOLD = 0.15; // 15%

// ─── Pure functions (test target) ─────────────────────────────────────────

/**
 * jsonl raw text → ProbeRecord[]. malformed line silent skip.
 * 형식 자체가 malformed 인 줄은 무시 (observer 가 절대 throw 하지 않는 원칙의 대응).
 */
export function parseProbeJsonl(raw: string): ProbeRecord[] {
  const out: ProbeRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (
        obj &&
        typeof obj.eventId === 'string' &&
        typeof obj.tokenMint === 'string' &&
        typeof obj.rejectCategory === 'string' &&
        typeof obj.rejectedAt === 'string' &&
        obj.probe &&
        typeof obj.probe.offsetSec === 'number'
      ) {
        out.push(obj as ProbeRecord);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * eventId → EventTimeline. 같은 event 의 여러 offset probe 를 묶는다.
 * deltaPct === null 인 probe 는 deltaByOffset 에 미포함 (observation 실패).
 */
export function groupByEvent(records: ProbeRecord[]): Map<string, EventTimeline> {
  const map = new Map<string, EventTimeline>();
  for (const r of records) {
    let tl = map.get(r.eventId);
    if (!tl) {
      tl = {
        eventId: r.eventId,
        tokenMint: r.tokenMint,
        lane: r.lane,
        rejectCategory: r.rejectCategory,
        rejectReason: r.rejectReason,
        rejectedAtMs: Date.parse(r.rejectedAt),
        deltaByOffset: new Map(),
      };
      map.set(r.eventId, tl);
    }
    if (r.probe.deltaPct != null && Number.isFinite(r.probe.deltaPct)) {
      // 같은 (event, offset) 중복이면 last-wins (observer 는 1회만 fire 하지만 방어).
      tl.deltaByOffset.set(r.probe.offsetSec, r.probe.deltaPct);
    }
  }
  return map;
}

/**
 * sorted ascending values 에서 percentile (0..1) 산출. linear interpolation.
 * empty → null.
 */
export function percentile(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/** event 별 "best mfe" — 1800s, 7200s 둘 중 더 높은 것 (둘 다 없으면 null). */
function bestMfeFor(tl: EventTimeline): number | null {
  const a = tl.deltaByOffset.get(1800);
  const b = tl.deltaByOffset.get(7200);
  if (a == null && b == null) return null;
  if (a == null) return b!;
  if (b == null) return a;
  return Math.max(a, b);
}

export function computeCategoryStat(events: EventTimeline[]): CategoryStat {
  const t1800: number[] = [];
  const t7200: number[] = [];
  let wouldBeWinner = 0;
  let observedForWinnerCheck = 0;
  let fivex = 0;
  for (const tl of events) {
    const v1800 = tl.deltaByOffset.get(1800);
    const v7200 = tl.deltaByOffset.get(7200);
    if (v1800 != null) t1800.push(v1800);
    if (v7200 != null) t7200.push(v7200);
    const best = bestMfeFor(tl);
    if (best != null) {
      observedForWinnerCheck += 1;
      if (best >= WOULD_BE_WINNER_THRESHOLD) wouldBeWinner += 1;
      if (best >= FIVEX_WINNER_THRESHOLD) fivex += 1;
    }
  }
  t1800.sort((a, b) => a - b);
  t7200.sort((a, b) => a - b);
  return {
    count: events.length,
    p25_t1800_mfe: percentile(t1800, 0.25),
    p50_t1800_mfe: percentile(t1800, 0.50),
    p75_t1800_mfe: percentile(t1800, 0.75),
    p50_t7200_mfe: percentile(t7200, 0.50),
    falseNegRate: observedForWinnerCheck > 0 ? wouldBeWinner / observedForWinnerCheck : 0,
    fivexFalseNeg: fivex,
  };
}

/** falseNegRate → alert level. mission-refinement: critical 은 1주 지속 조건 (외부 판정). */
export function classifyAlertLevel(rate: number): 'normal' | 'warn' | 'critical' {
  if (rate >= ALERT_CRITICAL_THRESHOLD) return 'critical';
  if (rate >= ALERT_WARN_THRESHOLD) return 'warn';
  return 'normal';
}

export interface AnalyzeOptions {
  windowDays: number;
  /** 특정 category 만 분석하고 싶을 때 (others 는 byCategory 에 미포함). */
  rejectCategory?: string;
  /** 기본 false: close-site kol_close 는 winner-kill 전용 리포트에서 계산한다. */
  includeCloseSite?: boolean;
  /** test 용 fixed nowMs. */
  nowMs?: number;
}

export function analyze(
  records: ProbeRecord[],
  opts: AnalyzeOptions
): RetroAnalysis {
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffMs = nowMs - opts.windowDays * 24 * 60 * 60 * 1000;
  const events = [...groupByEvent(records).values()].filter((tl) => {
    if (!Number.isFinite(tl.rejectedAtMs)) return false;
    if (tl.rejectedAtMs < cutoffMs) return false;
    if (opts.rejectCategory && tl.rejectCategory !== opts.rejectCategory) return false;
    if (!opts.rejectCategory && opts.includeCloseSite !== true && tl.rejectCategory === 'kol_close') return false;
    return true;
  });

  const byCategory = new Map<string, CategoryStat>();
  const byCategoryEvents = new Map<string, EventTimeline[]>();
  for (const e of events) {
    const arr = byCategoryEvents.get(e.rejectCategory) ?? [];
    arr.push(e);
    byCategoryEvents.set(e.rejectCategory, arr);
  }
  for (const [cat, arr] of byCategoryEvents) {
    byCategory.set(cat, computeCategoryStat(arr));
  }

  // overall: 전 event 묶음 (category 무관) 의 falseNegRate.
  const overall = computeCategoryStat(events);

  return {
    windowDays: opts.windowDays,
    totalRejects: events.length,
    byCategory,
    overallFalseNegRate: overall.falseNegRate,
    alertLevel: classifyAlertLevel(overall.falseNegRate),
  };
}

// ─── Reporting ────────────────────────────────────────────────────────────

function fmtPct(x: number | null): string {
  if (x == null) return 'n/a';
  const sign = x >= 0 ? '+' : '';
  return `${sign}${(x * 100).toFixed(1)}%`;
}

export function buildMarkdown(report: RetroAnalysis, generatedAtIso: string): string {
  const lines: string[] = [];
  lines.push('# Missed Alpha Retrospective');
  lines.push('');
  lines.push(`> Generated: ${generatedAtIso}`);
  lines.push(`> Window: last ${report.windowDays} day(s)`);
  lines.push(`> Source: data/realtime/missed-alpha.jsonl`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`| 지표 | 값 |`);
  lines.push(`|------|-----|`);
  lines.push(`| total pre-entry rejects (events in window) | ${report.totalRejects} |`);
  lines.push(`| overall false-neg rate (mfe ≥ +50%) | ${fmtPct(report.overallFalseNegRate)} |`);
  lines.push(`| alert level | ${report.alertLevel.toUpperCase()} |`);
  lines.push('');
  lines.push('Alert 기준: normal < 10% / warn 10–15% / critical ≥ 15%');
  lines.push('');
  lines.push('## Per-category breakdown');
  lines.push('');
  lines.push(
    `| rejectCategory | n | p25 mfe @1800s | p50 mfe @1800s | p75 mfe @1800s | p50 mfe @7200s | falseNeg% | 5x+ count |`
  );
  lines.push(
    `|----------------|---|----------------|----------------|----------------|----------------|-----------|-----------|`
  );
  const sorted = [...report.byCategory.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [cat, s] of sorted) {
    lines.push(
      `| ${cat} | ${s.count} | ${fmtPct(s.p25_t1800_mfe)} | ${fmtPct(s.p50_t1800_mfe)} | ` +
      `${fmtPct(s.p75_t1800_mfe)} | ${fmtPct(s.p50_t7200_mfe)} | ${fmtPct(s.falseNegRate)} | ${s.fivexFalseNeg} |`
    );
  }
  lines.push('');
  lines.push('## 해석 (Stage 2 mission-refinement)');
  lines.push('');
  lines.push('- p50_t1800_mfe > 0 인 category 는 "reject 후 평균적으로 가격 상승" — cut 정확도 의심.');
  lines.push('- 5x+ count > 0 시 catastrophic miss — gate 임계 즉시 review.');
  lines.push('- alertLevel=critical 1주 지속 시 사람의 판단으로 gate 완화.');
  lines.push('');
  return lines.join('\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────

interface CliArgs {
  inputFile: string;
  windowDays: number;
  rejectCategory?: string;
  includeCloseSite?: boolean;
  alertOutFile: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    inputFile: 'data/realtime/missed-alpha.jsonl',
    windowDays: 7,
    alertOutFile: 'data/realtime/missed-alpha-alert.json',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--window-days=')) {
      const v = Number(a.slice('--window-days='.length));
      if (Number.isFinite(v) && v > 0) args.windowDays = v;
    } else if (a === '--window-days' && argv[i + 1]) {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) args.windowDays = v;
    } else if (a.startsWith('--reject-category=')) {
      args.rejectCategory = a.slice('--reject-category='.length);
    } else if (a === '--reject-category' && argv[i + 1]) {
      args.rejectCategory = argv[++i];
    } else if (a === '--include-close-site') {
      args.includeCloseSite = true;
    } else if (a === '--in' && argv[i + 1]) {
      args.inputFile = argv[++i];
    } else if (a.startsWith('--in=')) {
      args.inputFile = a.slice('--in='.length);
    } else if (a === '--alert-out' && argv[i + 1]) {
      args.alertOutFile = argv[++i];
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(process.cwd(), args.inputFile);

  let raw = '';
  try {
    raw = await readFile(inputPath, 'utf-8');
  } catch (err) {
    console.error(`[retro] failed to read ${inputPath}: ${String(err)}`);
    process.exit(1);
  }

  const records = parseProbeJsonl(raw);
  const report = analyze(records, {
    windowDays: args.windowDays,
    rejectCategory: args.rejectCategory,
    includeCloseSite: args.includeCloseSite,
  });

  const generatedAtIso = new Date().toISOString();
  const md = buildMarkdown(report, generatedAtIso);
  console.log(md);

  if (report.alertLevel === 'critical') {
    const alertPath = path.resolve(process.cwd(), args.alertOutFile);
    await mkdir(path.dirname(alertPath), { recursive: true });
    const payload = {
      generatedAt: generatedAtIso,
      windowDays: report.windowDays,
      totalRejects: report.totalRejects,
      overallFalseNegRate: report.overallFalseNegRate,
      alertLevel: report.alertLevel,
      byCategory: Object.fromEntries(
        [...report.byCategory.entries()].map(([k, v]) => [k, v])
      ),
      hint:
        'overallFalseNegRate ≥ 15% — operator review required. Single-day spike 는 noise 가능, ' +
        '1주 지속 시에만 gate 완화 검토 (mission-refinement Stage 2).',
    };
    await writeFile(alertPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.error(`\n[retro] CRITICAL alert written to ${alertPath}`);
  }
}

// ts-node 직접 실행 시에만 main() 호출 — test 가 import 시 부작용 없도록.
if (require.main === module) {
  main().catch((err) => {
    console.error('[retro] failed:', err);
    process.exit(1);
  });
}
