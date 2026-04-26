#!/usr/bin/env ts-node
/**
 * Reconcile Lane Outcomes — Kelly Controller P0 (2026-04-26)
 *
 * ADR: docs/design-docs/lane-edge-controller-kelly-2026-04-25.md §10 P0
 *
 * 사용:
 *   npm run lane:reconcile -- --overwrite           # 첫 실행 / 전체 재구축
 *   npm run lane:reconcile -- --since 2026-04-26T00:00:00Z --overwrite
 *   npm run lane:reconcile -- --md reports/lane-reconcile-2026-04-26.md --overwrite
 *
 * QA F12 (2026-04-26): default append 모드는 같은 입력 2회 실행 시 record 중복.
 *   운영 cron 에서 사용하려면 항상 --overwrite 권장 (idempotent). append 모드는
 *   ledger 가 incremental 로 자라는 환경에서만 의미.
 *
 * 출력:
 *   - data/realtime/lane-outcomes-reconciled.jsonl  (append-only, P1 input)
 *   - reports/lane-reconcile-{date}.md              (--md 옵션 시)
 *   - stdout summary
 *
 * Exit code:
 *   0: P0 gate met (kellyEligibleRatio >= 0.95)
 *   1: P0 gate not met
 *   2: fatal
 */
import { readFile, writeFile, mkdir, appendFile } from 'fs/promises';
import path from 'path';
import {
  reconcileLaneOutcomes,
  type BuyLedgerRecord,
  type SellLedgerRecord,
} from '../src/risk/laneOutcomeReconciler';
import type { LaneOutcomeRecord, ReconcileSummary } from '../src/risk/laneOutcomeTypes';

interface CliArgs {
  ledgerDir: string;
  outputFile: string;
  since?: Date;
  mdOut?: string;
  /** 이미 존재하는 reconciled.jsonl 에 append 할지 (default true), or overwrite */
  overwrite: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sinceRaw = get('--since');
  const ledgerDir = get('--ledger-dir') ?? path.resolve(process.cwd(), 'data/realtime');
  return {
    ledgerDir,
    outputFile: get('--out') ?? path.join(ledgerDir, 'lane-outcomes-reconciled.jsonl'),
    since: sinceRaw ? new Date(sinceRaw) : undefined,
    mdOut: get('--md'),
    overwrite: argv.includes('--overwrite'),
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

function within(since: Date | undefined, recordedAt?: string): boolean {
  if (!since) return true;
  if (!recordedAt) return true;
  return new Date(recordedAt).getTime() >= since.getTime();
}

function formatMd(summary: ReconcileSummary, sample: LaneOutcomeRecord[]): string {
  const lines: string[] = [];
  lines.push(`# Lane Outcome Reconcile Report — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push('> Kelly Controller P0 (Accounting Eligibility)');
  lines.push('> ADR: `docs/design-docs/lane-edge-controller-kelly-2026-04-25.md`');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total records: ${summary.totalRecords}`);
  lines.push(`- Kelly eligible: ${(summary.kellyEligibleRatio * 100).toFixed(2)}%`);
  lines.push(`- **P0 gate met (≥ 95%): ${summary.p0GateMet ? '✅' : '❌'}**`);
  lines.push('');
  lines.push('## By status');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('|--------|-------|');
  for (const [status, count] of Object.entries(summary.byStatus)) {
    lines.push(`| ${status} | ${count} |`);
  }
  lines.push('');
  lines.push('## By lane');
  lines.push('');
  lines.push('| Lane | Records |');
  lines.push('|------|---------|');
  for (const [lane, count] of Object.entries(summary.byLane).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${lane} | ${count} |`);
  }
  lines.push('');
  lines.push('## Top 10 ineligible records (Kelly 계산 제외)');
  lines.push('');
  const ineligible = sample.filter((r) => !r.kellyEligible).slice(0, 10);
  if (ineligible.length === 0) {
    lines.push('(없음 — 모든 record kelly_eligible=true)');
  } else {
    lines.push('| Position | Lane | Status | Reason |');
    lines.push('|----------|------|--------|--------|');
    for (const r of ineligible) {
      lines.push(`| ${r.positionId.slice(0, 16)} | ${r.laneName} | ${r.reconcileStatus} | ${r.walletTruthSource} |`);
    }
  }
  lines.push('');
  lines.push('## Next');
  lines.push('');
  if (summary.p0GateMet) {
    lines.push('- P0 gate 통과. Option 5 Phase 2 shadow eval `GO` 판정 후 P1 (LaneEdgeController report-only) 진행 가능.');
  } else {
    lines.push('- P0 gate **미통과** (≥ 95% 필요). 이전 ledger 정합 작업 필요:');
    if (summary.byStatus.duplicate_buy > 0) lines.push(`  - duplicate buy ${summary.byStatus.duplicate_buy} 건 — handler 의 in-flight mutex 점검`);
    if (summary.byStatus.orphan_sell > 0) lines.push(`  - orphan sell ${summary.byStatus.orphan_sell} 건 — buy ledger 누락 또는 entryTxSignature 불일치`);
    if (summary.byStatus.open_row_stale > 0) lines.push(`  - open row stale ${summary.byStatus.open_row_stale} 건 — handler 의 close path 실패 가능`);
    if (summary.byStatus.wallet_drift > 0) lines.push(`  - wallet drift ${summary.byStatus.wallet_drift} 건 — comparator 와 receivedSol gap 점검`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`[lane-reconcile] ledgerDir=${args.ledgerDir}`);

  const buys = await readJsonl<BuyLedgerRecord>(path.join(args.ledgerDir, 'executed-buys.jsonl'));
  const sells = await readJsonl<SellLedgerRecord>(path.join(args.ledgerDir, 'executed-sells.jsonl'));
  console.log(`[lane-reconcile] read ${buys.length} buys, ${sells.length} sells`);

  const filteredBuys = buys.filter((b) => within(args.since, b.recordedAt));
  const filteredSells = sells.filter((s) => within(args.since, s.recordedAt));

  const { records, summary } = reconcileLaneOutcomes(filteredBuys, filteredSells);
  console.log(`[lane-reconcile] produced ${records.length} outcome records`);
  console.log(`[lane-reconcile] kelly_eligible: ${(summary.kellyEligibleRatio * 100).toFixed(2)}%`);
  console.log(`[lane-reconcile] by status:`, summary.byStatus);
  console.log(`[lane-reconcile] P0 gate met: ${summary.p0GateMet ? 'YES' : 'NO'}`);

  // Write jsonl
  await mkdir(path.dirname(args.outputFile), { recursive: true });
  if (args.overwrite) {
    await writeFile(args.outputFile, '', 'utf8');
  }
  for (const r of records) {
    await appendFile(args.outputFile, JSON.stringify(r) + '\n', 'utf8');
  }
  console.log(`[lane-reconcile] wrote ${records.length} records → ${args.outputFile}`);

  // Markdown report
  if (args.mdOut) {
    await mkdir(path.dirname(args.mdOut), { recursive: true });
    await writeFile(args.mdOut, formatMd(summary, records), 'utf8');
    console.log(`[lane-reconcile] md report → ${args.mdOut}`);
  }

  process.exit(summary.p0GateMet ? 0 : 1);
}

main().catch((err) => {
  console.error('[lane-reconcile] fatal:', err);
  process.exit(2);
});
