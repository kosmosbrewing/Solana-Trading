#!/usr/bin/env ts-node
/**
 * Winner-Kill Classifier (2026-05-01, Phase A.1).
 *
 * Why: Phase 2 partial-take (tail retain) 의 정량 근거 산출. winner-kill 1건의 close
 *      이유가 'price kill' (가격 단순 -10% trigger) 인지 'structural kill' (sellability
 *      또는 honeypot/rug) 인지 'insider kill' (KOL exit) 인지 자동 라벨링.
 *
 * 학술 정합:
 *   - Kaminski-Lo (2014): stop 의 alpha 는 persistence 시장에서만 양수.
 *     price kill 은 IID 시장에선 winner truncation. → tail retain 권고.
 *   - Taleb (2007) convexity: fat-tail payoff 는 single survival 이 100건 small loss 능가.
 *   - structural kill 은 항상 100% close 유지 (sellability / Real Asset Guard 정합).
 *
 * 입력: data/realtime/missed-alpha.jsonl (kol_hunter close-site events).
 * 산출: 라벨별 winner-kill 분포 → 'tail retain 의 maximum upside / risk' 추정.
 *
 * 사용:
 *   npx ts-node scripts/winner-kill-classifier.ts --window-days=7 --threshold=4.0
 *   npx ts-node scripts/winner-kill-classifier.ts --offset=7200 --threshold=2.0
 *
 * read-only — 거래 / 사이징 / 라이브 throttle 에 영향 없음.
 */
import { readFile } from 'fs/promises';
import path from 'path';
import {
  isCloseEvent,
  aggregateCloseEvents,
  type ProbeLine,
  type CloseEvent,
} from './winner-kill-analyzer';

/** Close reason → kill category 분류. tail retain 정책의 입력. */
export type KillCategory =
  | 'price'         // probe_hard_cut / probe_flat_cut / probe_reject_timeout / quick_reject — tail retain 가능
  | 'structural'    // structural_kill_sell_route / hold_phase_sentinel_degraded_exit — 100% close 유지
  | 'insider'       // insider_exit_full — multi-KOL count 분기로 별도 정책 가능
  | 'winner'        // winner_trailing_t1/t2/t3 — 정상 trail
  | 'orphan'        // ORPHAN_NO_BALANCE
  | 'other';

export function classifyKillCategory(closeReason: string): KillCategory {
  switch (closeReason) {
    case 'probe_hard_cut':
    case 'probe_flat_cut':
    case 'probe_reject_timeout':
    case 'quick_reject_classifier_exit':
      return 'price';
    case 'structural_kill_sell_route':
    case 'hold_phase_sentinel_degraded_exit':
      return 'structural';
    case 'insider_exit_full':
      return 'insider';
    case 'winner_trailing_t1':
    case 'winner_trailing_t2':
    case 'winner_trailing_t3':
    case 'winner_breakeven':
      return 'winner';
    case 'ORPHAN_NO_BALANCE':
      return 'orphan';
    default:
      return 'other';
  }
}

interface ClassifierArgs {
  inputPath: string;
  windowDays: number;
  thresholdMfe: number;
  targetOffsetSec: number;
}

function parseArgs(argv: string[]): ClassifierArgs {
  let inputPath = path.resolve(process.cwd(), 'data/realtime/missed-alpha.jsonl');
  let windowDays = 7;
  let thresholdMfe = 4.0;
  let targetOffsetSec = 1800;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--in' || t === '--input') inputPath = argv[++i];
    else if (t.startsWith('--window-days=')) windowDays = Number(t.split('=')[1]);
    else if (t.startsWith('--threshold=')) thresholdMfe = Number(t.split('=')[1]);
    else if (t.startsWith('--offset=')) targetOffsetSec = Number(t.split('=')[1]);
  }
  if (!Number.isFinite(windowDays) || windowDays <= 0) windowDays = 7;
  if (!Number.isFinite(thresholdMfe) || thresholdMfe <= 0) thresholdMfe = 4.0;
  if (!Number.isFinite(targetOffsetSec) || targetOffsetSec <= 0) targetOffsetSec = 1800;
  return { inputPath, windowDays, thresholdMfe, targetOffsetSec };
}

interface CategoryStats {
  category: KillCategory;
  total: number;
  observedTarget: number;
  winnerKills: number;
  rate: number;
  /** winner-kill 의 평균 postMfe (capture 가능 upside) */
  avgPostMfe: number;
  examples: Array<{ eventId: string; mint: string; closeReason: string; postMfe: number }>;
}

export function classifyEvents(
  events: CloseEvent[],
  targetOffsetSec: number,
  thresholdMfe: number,
): Map<KillCategory, CategoryStats> {
  const map = new Map<KillCategory, CategoryStats>();
  for (const evt of events) {
    const cat = classifyKillCategory(evt.closeReason);
    let stat = map.get(cat);
    if (!stat) {
      stat = { category: cat, total: 0, observedTarget: 0, winnerKills: 0, rate: 0, avgPostMfe: 0, examples: [] };
      map.set(cat, stat);
    }
    stat.total += 1;
    const delta = evt.postCloseDelta.get(targetOffsetSec);
    if (delta == null) continue;
    if (evt.exitPrice <= 0 || evt.signalPrice <= 0) continue;
    stat.observedTarget += 1;
    const observedPrice = evt.signalPrice * (1 + delta);
    const postMfe = (observedPrice - evt.exitPrice) / evt.exitPrice;
    if (postMfe >= thresholdMfe) {
      stat.winnerKills += 1;
      stat.examples.push({ eventId: evt.eventId, mint: evt.tokenMint, closeReason: evt.closeReason, postMfe });
    }
  }
  for (const stat of map.values()) {
    stat.rate = stat.observedTarget > 0 ? stat.winnerKills / stat.observedTarget : 0;
    if (stat.examples.length > 0) {
      stat.avgPostMfe = stat.examples.reduce((s, e) => s + e.postMfe, 0) / stat.examples.length;
      stat.examples.sort((a, b) => b.postMfe - a.postMfe);
      stat.examples = stat.examples.slice(0, 5);
    }
  }
  return map;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function renderMarkdown(args: ClassifierArgs, byCategory: Map<KillCategory, CategoryStats>): string {
  const lines: string[] = [];
  lines.push(`# Winner-Kill Category Classifier (${new Date().toISOString()})`);
  lines.push('');
  lines.push(`- Window: last ${args.windowDays} days`);
  lines.push(`- Threshold mfe: +${pct(args.thresholdMfe)}`);
  lines.push(`- Target offset: T+${args.targetOffsetSec}s`);
  lines.push('');
  lines.push('## Tail-retain policy 영향 매트릭스');
  lines.push('');
  lines.push('| Category | Total | Obs.Target | Winner-Kills | Rate | Avg postMfe | Tail Retain 권고 |');
  lines.push('|---|---:|---:|---:|---:|---:|:---:|');
  const order: KillCategory[] = ['price', 'structural', 'insider', 'winner', 'orphan', 'other'];
  let priceWinnerKills = 0;
  let structuralWinnerKills = 0;
  let totalWinnerKills = 0;
  for (const cat of order) {
    const s = byCategory.get(cat);
    if (!s) continue;
    const advice = cat === 'price' ? '✅ 권고'
      : cat === 'insider' ? '⚠ 조건부 (multi-KOL)'
      : cat === 'structural' ? '❌ 금지 (Real Asset Guard)'
      : '—';
    const avg = s.examples.length > 0 ? pct(s.avgPostMfe) : 'n/a';
    lines.push(`| ${cat} | ${s.total} | ${s.observedTarget} | ${s.winnerKills} | ${pct(s.rate)} | ${avg} | ${advice} |`);
    totalWinnerKills += s.winnerKills;
    if (cat === 'price') priceWinnerKills = s.winnerKills;
    if (cat === 'structural') structuralWinnerKills = s.winnerKills;
  }
  lines.push('');

  // Phase B/C 진입 정량 근거
  const priceShare = totalWinnerKills > 0 ? priceWinnerKills / totalWinnerKills : 0;
  const structuralShare = totalWinnerKills > 0 ? structuralWinnerKills / totalWinnerKills : 0;
  lines.push('## Phase B/C 진입 결정');
  lines.push('');
  lines.push(`- price-kill 비중: ${pct(priceShare)} (${priceWinnerKills}/${totalWinnerKills})`);
  lines.push(`- structural-kill 비중: ${pct(structuralShare)} (${structuralWinnerKills}/${totalWinnerKills})`);
  lines.push('');
  if (priceShare >= 0.5) {
    lines.push(`✅ **Phase C 진입 권고** — price-kill 비중 ≥ 50%, tail retain 정책의 maximum upside 가 의미 있음`);
  } else if (priceShare < 0.3) {
    lines.push(`❌ **제안 재고** — price-kill 비중 < 30%. 대부분 structural/insider 라 tail retain 효과 제한`);
  } else {
    lines.push(`⚠ **데이터 부족** — 추가 1주 baseline 측정 후 재평가`);
  }
  lines.push('');

  // Top winner-kill examples per category
  for (const cat of order) {
    const s = byCategory.get(cat);
    if (!s || s.examples.length === 0) continue;
    lines.push(`### Top winner-kills — ${cat}`);
    for (const ex of s.examples) {
      lines.push(`- ${ex.eventId} mint=${ex.mint.slice(0, 12)} reason=${ex.closeReason} postMfe=${pct(ex.postMfe)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function runWinnerKillClassifier(args: ClassifierArgs): Promise<string> {
  const text = await readFile(args.inputPath, 'utf8').catch(() => '');
  const cutoffMs = Date.now() - args.windowDays * 24 * 60 * 60 * 1000;
  const lines: ProbeLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const obj = JSON.parse(raw) as ProbeLine;
      if (!obj.rejectedAt) continue;
      if (Date.parse(obj.rejectedAt) < cutoffMs) continue;
      if (!isCloseEvent(obj)) continue;
      lines.push(obj);
    } catch {
      // skip malformed
    }
  }
  const events = [...aggregateCloseEvents(lines).values()];
  const byCategory = classifyEvents(events, args.targetOffsetSec, args.thresholdMfe);
  return renderMarkdown(args, byCategory);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  runWinnerKillClassifier(args).then((md) => {
    process.stdout.write(md + '\n');
  }).catch((err) => {
    process.stderr.write(`[winner-kill-classifier] error: ${err}\n`);
    process.exit(1);
  });
}
