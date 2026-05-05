/**
 * Winner-Kill Rate Analyzer (2026-04-30, Sprint 1.B2)
 *
 * Why: KOL Hunter close 후 markout 데이터로 "5x 도달했는데 우리가 일찍 cut 한 비율" 측정.
 *      학술 리포트 (Kaminski-Lo / 외부 트레이더 리포트 §검증 프레임워크) 권고:
 *      win-rate 외 winner-kill rate 가 5x+ winner 목적함수 보호의 핵심 KPI.
 *
 * 입력: data/realtime/missed-alpha.jsonl
 *   - lane='kol_hunter' + extras.elapsedSecAtClose 가 있는 record 만 close-site (vs reject-site).
 *   - probe 가 close 시점 가격 vs T+offset 가격 → deltaPct 측정.
 *
 * 산출:
 *   - winner-kill rate: close 후 T+1800s 또는 T+7200s 시점 price 가 close price 대비 +N%
 *     (default +400% = 5x 도달) 인 close 의 비율
 *   - per-closeReason 분포 (probe_hard_cut / quick_reject / winner_trailing_t1 등)
 *   - per-armName 분포 (kol_hunter_smart_v3 / swing-v2 등)
 *   - paper vs live 분리 (extras.isLive)
 *   - top-N winner-kill events (eventId + close reason + max post-close mfe)
 *
 * 사용:
 *   npx ts-node scripts/winner-kill-analyzer.ts --window-days=7
 *   npx ts-node scripts/winner-kill-analyzer.ts --threshold=2.0  # 2x = +200%
 *   npx ts-node scripts/winner-kill-analyzer.ts --offset=7200 --threshold=4.0
 *
 * read-only — 거래 / 사이징 / 라이브 throttle 에 영향 없음.
 */
import { readFile } from 'fs/promises';
import path from 'path';

export interface ProbeLine {
  eventId: string;
  tokenMint: string;
  lane: string;
  rejectCategory: string;
  rejectReason: string;
  signalPrice: number;
  rejectedAt: string;
  extras?: Record<string, unknown>;
  probe: {
    offsetSec: number;
    firedAt: string;
    observedPrice: number | null;
    deltaPct: number | null;
    quoteStatus: string;
  };
}

export interface CloseEvent {
  eventId: string;
  tokenMint: string;
  closeReason: string;
  armName?: string;
  isLive: boolean;
  closedAt: number;
  exitPrice: number;
  signalPrice: number;
  mfePctAtClose: number;
  /** offsetSec → deltaPct (post-close trajectory). null 인 경우 quote 실패. */
  postCloseDelta: Map<number, number | null>;
}

interface AnalyzerArgs {
  inputPath: string;
  windowDays: number;
  /** 5x = 4.0 (+400%). 2x = 1.0 (+100%). default 4.0. */
  thresholdMfe: number;
  /** offsetSec — default 1800 (T+30분). 7200 = T+2시간. */
  targetOffsetSec: number;
}

function parseArgs(argv: string[]): AnalyzerArgs {
  let inputPath = path.resolve(process.cwd(), 'data/realtime/missed-alpha.jsonl');
  let windowDays = 7;
  let thresholdMfe = 4.0;
  let targetOffsetSec = 1800;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--in' || token === '--input') {
      inputPath = argv[++i];
    } else if (token.startsWith('--window-days=')) {
      windowDays = Number(token.split('=')[1]);
    } else if (token.startsWith('--threshold=')) {
      thresholdMfe = Number(token.split('=')[1]);
    } else if (token.startsWith('--offset=')) {
      targetOffsetSec = Number(token.split('=')[1]);
    }
  }
  if (!Number.isFinite(windowDays) || windowDays <= 0) windowDays = 7;
  if (!Number.isFinite(thresholdMfe) || thresholdMfe <= 0) thresholdMfe = 4.0;
  if (!Number.isFinite(targetOffsetSec) || targetOffsetSec <= 0) targetOffsetSec = 1800;
  return { inputPath, windowDays, thresholdMfe, targetOffsetSec };
}

export function isCloseEvent(line: ProbeLine): boolean {
  if (line.lane !== 'kol_hunter') return false;
  // 2026-04-30 (B1): rejectCategory==='kol_close' 가 가장 정확한 close-site 식별자.
  //   backward compat: 4-30 이전 데이터는 기존 enum (probe_hard_cut 등) + extras.elapsedSecAtClose
  //   로 식별. 두 path 모두 OR 로 허용 → 기존 jsonl 분석 호환성 유지.
  if (line.rejectCategory === 'kol_close') return true;
  return line.extras != null && typeof line.extras.elapsedSecAtClose === 'number';
}

export function aggregateCloseEvents(lines: ProbeLine[]): Map<string, CloseEvent> {
  const map = new Map<string, CloseEvent>();
  for (const line of lines) {
    if (!isCloseEvent(line)) continue;
    let evt = map.get(line.eventId);
    if (!evt) {
      const extras = line.extras ?? {};
      const exitPrice = typeof extras.exitPrice === 'number' ? extras.exitPrice : 0;
      const mfePctAtClose = typeof extras.mfePctAtClose === 'number' ? extras.mfePctAtClose : 0;
      const isLive = extras.isLive === true;
      const armName = typeof extras.armName === 'string' ? extras.armName : undefined;
      evt = {
        eventId: line.eventId,
        tokenMint: line.tokenMint,
        closeReason: line.rejectReason,
        armName,
        isLive,
        closedAt: Date.parse(line.rejectedAt),
        exitPrice,
        signalPrice: line.signalPrice,
        mfePctAtClose,
        postCloseDelta: new Map(),
      };
      map.set(line.eventId, evt);
    }
    evt.postCloseDelta.set(line.probe.offsetSec, line.probe.deltaPct);
  }
  return map;
}

export interface CohortStats {
  cohort: string;
  /** close-site events in this cohort, including pending/no-observation rows. */
  total: number;
  /** events with a valid target-offset post-close MFE denominator. */
  observedTargetTotal: number;
  winnerKills: number;
  rate: number;
  examples: Array<{ eventId: string; tokenMint: string; postMfe: number | null; closeReason: string }>;
}

export function computeCohort(events: CloseEvent[], targetOffsetSec: number, threshold: number, label: string): CohortStats {
  let winnerKills = 0;
  let observedTargetTotal = 0;
  const examples: CohortStats['examples'] = [];
  for (const evt of events) {
    const delta = evt.postCloseDelta.get(targetOffsetSec);
    if (delta == null) continue;
    // delta = (observed - signal) / signal. signal 은 entry 시점.
    // post-close mfe relative to exit price 측정 위해 변환:
    //   observedPrice = signalPrice * (1 + delta)
    //   postMfe = (observedPrice - exitPrice) / exitPrice
    if (evt.exitPrice <= 0 || evt.signalPrice <= 0) continue;
    observedTargetTotal += 1;
    const observedPrice = evt.signalPrice * (1 + delta);
    const postMfe = (observedPrice - evt.exitPrice) / evt.exitPrice;
    if (postMfe >= threshold) {
      winnerKills += 1;
      examples.push({ eventId: evt.eventId, tokenMint: evt.tokenMint, postMfe, closeReason: evt.closeReason });
    }
  }
  examples.sort((a, b) => (b.postMfe ?? 0) - (a.postMfe ?? 0));
  return {
    cohort: label,
    total: events.length,
    observedTargetTotal,
    winnerKills,
    rate: observedTargetTotal > 0 ? winnerKills / observedTargetTotal : 0,
    examples: examples.slice(0, 5),
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function renderMarkdown(args: AnalyzerArgs, cohorts: CohortStats[]): string {
  const lines: string[] = [];
  lines.push(`# Winner-Kill Rate Report (${new Date().toISOString()})`);
  lines.push('');
  lines.push(`- Input: ${args.inputPath}`);
  lines.push(`- Window: last ${args.windowDays} days`);
  lines.push(`- Threshold mfe: +${pct(args.thresholdMfe)} (5x default = 4.0)`);
  lines.push(`- Target offset: T+${args.targetOffsetSec}s`);
  lines.push('');
  lines.push('| Cohort | Total closes | Observed target | Winner-Kills | Rate |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const c of cohorts) {
    lines.push(`| ${c.cohort} | ${c.total} | ${c.observedTargetTotal} | ${c.winnerKills} | ${pct(c.rate)} |`);
  }
  lines.push('');
  for (const c of cohorts) {
    if (c.examples.length === 0) continue;
    lines.push(`### Top winner-kills — ${c.cohort}`);
    for (const ex of c.examples) {
      lines.push(`- ${ex.eventId} mint=${ex.tokenMint.slice(0, 12)} reason=${ex.closeReason} postMfe=${ex.postMfe == null ? 'n/a' : pct(ex.postMfe)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function runWinnerKillAnalyzer(args: AnalyzerArgs): Promise<string> {
  const text = await readFile(args.inputPath, 'utf8').catch(() => '');
  const cutoffMs = Date.now() - args.windowDays * 24 * 60 * 60 * 1000;
  const lines: ProbeLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const obj = JSON.parse(raw) as ProbeLine;
      if (!obj.rejectedAt) continue;
      if (Date.parse(obj.rejectedAt) < cutoffMs) continue;
      lines.push(obj);
    } catch {
      // malformed — skip
    }
  }
  const events = [...aggregateCloseEvents(lines).values()];
  const overall = computeCohort(events, args.targetOffsetSec, args.thresholdMfe, 'overall');
  const live = computeCohort(events.filter((e) => e.isLive), args.targetOffsetSec, args.thresholdMfe, 'live only');
  const paper = computeCohort(events.filter((e) => !e.isLive), args.targetOffsetSec, args.thresholdMfe, 'paper only');
  // per-closeReason cohort
  const byReason = new Map<string, CloseEvent[]>();
  for (const e of events) {
    const list = byReason.get(e.closeReason) ?? [];
    list.push(e);
    byReason.set(e.closeReason, list);
  }
  const reasonCohorts: CohortStats[] = [];
  for (const [reason, evts] of byReason.entries()) {
    if (evts.length < 3) continue; // 너무 작은 cohort 는 noise
    reasonCohorts.push(computeCohort(evts, args.targetOffsetSec, args.thresholdMfe, `reason=${reason}`));
  }
  reasonCohorts.sort((a, b) => b.rate - a.rate);
  return renderMarkdown(args, [overall, live, paper, ...reasonCohorts]);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  runWinnerKillAnalyzer(args).then((md) => {
    process.stdout.write(md + '\n');
  }).catch((err) => {
    process.stderr.write(`[winner-kill-analyzer] error: ${err}\n`);
    process.exit(1);
  });
}
