#!/usr/bin/env ts-node
/**
 * Lane Edge Report — Kelly Controller P1 (2026-04-26)
 *
 * ADR: docs/design-docs/lane-edge-controller-kelly-2026-04-25.md §10 P1
 *
 * 입력: data/realtime/lane-outcomes-reconciled.jsonl (P0 산출물)
 * 출력:
 *   - reports/kelly-cohort-{date}.md (사람 읽기)
 *   - reports/kelly-cohort-{date}.json (다음 sprint 입력)
 *   - stdout summary
 *
 * **REPORT-ONLY**: 본 스크립트는 운영 entry path 에 영향 없음. 매일 cron 실행 안전.
 *
 * 사용:
 *   npm run lane:edge-report                                   # 오늘 날짜 report
 *   npm run lane:edge-report -- --md reports/kelly-2026-04-26.md
 *   npm run lane:edge-report -- --json reports/kelly-2026-04-26.json
 *   npm run lane:edge-report -- --in custom/path.jsonl
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import {
  buildControllerReport,
  type ControllerReport,
} from '../src/risk/paper/laneEdgeController';
import type { LaneOutcomeRecord } from '../src/risk/laneOutcomeTypes';

interface CliArgs {
  inputFile: string;
  mdOut?: string;
  jsonOut?: string;
  walletDriftHaltActive: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const today = new Date().toISOString().slice(0, 10);
  return {
    inputFile: get('--in') ?? path.resolve(process.cwd(), 'data/realtime/lane-outcomes-reconciled.jsonl'),
    mdOut: get('--md') ?? path.resolve(process.cwd(), `reports/kelly-cohort-${today}.md`),
    jsonOut: get('--json') ?? path.resolve(process.cwd(), `reports/kelly-cohort-${today}.json`),
    walletDriftHaltActive: argv.includes('--wallet-drift-halt'),
  };
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l) as T; } catch { return null; }
      })
      .filter((x): x is T => x !== null);
  } catch {
    return [];
  }
}

function fmtPct(v: number, digits = 2): string {
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtSol(v: number): string {
  return v.toFixed(6);
}

function formatMarkdown(r: ControllerReport): string {
  const lines: string[] = [];
  lines.push(`# Lane Edge Report — ${r.generatedAt.slice(0, 10)}`);
  lines.push('');
  lines.push('> Kelly Controller P1 (Report-only). ADR: `docs/design-docs/lane-edge-controller-kelly-2026-04-25.md`');
  lines.push('> **이 보고서는 entry path 에 영향 없음.** 매일 cron 실행 안전.');
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`- Generated: ${r.generatedAt}`);
  lines.push(`- Total outcomes: ${r.totalOutcomes}`);
  lines.push(`- Kelly eligible: ${r.eligibleOutcomes} (${r.totalOutcomes > 0 ? fmtPct(r.eligibleOutcomes / r.totalOutcomes) : '0%'})`);
  lines.push(`- Cohorts: ${r.cohorts.length}`);
  lines.push('');

  lines.push('## Highlights');
  lines.push('');
  lines.push(`- Best cohort (consK, n≥50): ${r.highlights.bestCohortByConsK ?? 'n/a'}`);
  lines.push(`- Worst cohort (consK, n≥50): ${r.highlights.worstCohortByConsK ?? 'n/a'}`);
  if (r.highlights.quarantinedCohorts.length > 0) {
    lines.push(`- Quarantined: ${r.highlights.quarantinedCohorts.join(', ')}`);
  }
  if (r.highlights.paperOnlyCohorts.length > 0) {
    lines.push(`- Paper-only: ${r.highlights.paperOnlyCohorts.join(', ')}`);
  }
  lines.push('');

  lines.push('## Cohorts (sorted by conservative Kelly desc)');
  lines.push('');
  lines.push('| Cohort | n | winRate | LCB | RR | RR-p10 | E(SOL) | rawK | consK | mode | reason |');
  lines.push('|--------|---|---------|-----|----|--------|--------|------|-------|------|--------|');
  for (const c of r.cohorts) {
    const cohortShort = c.cohortKey.length > 60 ? c.cohortKey.slice(0, 57) + '...' : c.cohortKey;
    lines.push(
      `| ${cohortShort} | ${c.n} | ${fmtPct(c.winRate)} | ${fmtPct(c.winRateLcb)} | ` +
      `${c.rewardRisk.toFixed(2)} | ${c.rewardRiskP10.toFixed(2)} | ${fmtSol(c.expectancySol)} | ` +
      `${c.rawKelly.toFixed(4)} | ${c.conservativeKelly.toFixed(4)} | ${c.entryMode} | ${c.reason.slice(0, 80)} |`
    );
  }
  lines.push('');

  lines.push('## Notes');
  lines.push('');
  lines.push('- **paperOnly outcomes 자동 제외** (P0 reconciler 가 kellyEligible=false 부여 — ADR §3 준수).');
  lines.push('- **ticket_cap_sol 자동 증가 없음** — 항상 lane hard lock (0.01) 으로 clip (ADR §7.1).');
  lines.push('- **n < 30 cohort**: display only — 결정 영향 없음.');
  lines.push('- **n < 50 cohort**: preliminary — Kelly 정보용, throttle 미반영.');
  lines.push('- **n ≥ 100 + consK ≤ 0**: throttle / quarantine.');
  lines.push('- **Conservative Kelly 양수 + n ≥ 200 + log_growth > 0**: ticket cap unlock 후보 — 별도 ADR 필수 (Stage 4 SCALE + 운영자 ack).');
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`[lane-edge-report] in=${args.inputFile}`);

  const records = await readJsonl<LaneOutcomeRecord>(args.inputFile);
  console.log(`[lane-edge-report] read ${records.length} reconciled outcomes`);

  if (records.length === 0) {
    console.log('[lane-edge-report] no records — run `npm run lane:reconcile -- --overwrite` first');
    process.exit(2);
  }

  const report = buildControllerReport(records, {
    walletDriftHaltActive: args.walletDriftHaltActive,
  });

  console.log(`[lane-edge-report] cohorts: ${report.cohorts.length} (eligible=${report.eligibleOutcomes}/${report.totalOutcomes})`);
  console.log(`[lane-edge-report] best: ${report.highlights.bestCohortByConsK ?? 'n/a'}`);
  if (report.highlights.quarantinedCohorts.length > 0) {
    console.log(`[lane-edge-report] quarantined: ${report.highlights.quarantinedCohorts.join(', ')}`);
  }

  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, formatMarkdown(report), 'utf8');
    console.log(`[lane-edge-report] md → ${args.mdOut}`);
  }
  if (args.jsonOut) {
    await mkdir(path.dirname(args.jsonOut), { recursive: true });
    await writeFile(args.jsonOut, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[lane-edge-report] json → ${args.jsonOut}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[lane-edge-report] fatal:', err);
  process.exit(3);
});
