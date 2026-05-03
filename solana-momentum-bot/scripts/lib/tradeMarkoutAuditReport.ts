import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

export interface CountEntry {
  key: string;
  count: number;
}

export interface HorizonCoverage {
  horizonSec: number;
  expectedRows: number;
  observedRows: number;
  okRows: number;
  positivePostCostRows: number;
  medianDeltaPct: number | null;
  medianPostCostDeltaPct: number | null;
  rowCoveragePct: number;
  okCoveragePct: number;
  /** Backward-compatible alias for okCoveragePct. */
  coveragePct: number;
}

export interface AuditReport {
  generatedAt: string;
  since: string;
  realtimeDir: string;
  lane?: 'kol_hunter' | 'pure_ws' | 'all';
  horizonsSec: number[];
  verdict: 'OK' | 'WATCH' | 'PAUSE_REVIEW' | 'INVESTIGATE';
  summary: {
    anchors: number;
    anchorRows: number;
    fallbackLiveBuys: number;
    fallbackLiveSells: number;
    expectedRows: number;
    observedLatestRows: number;
    okLatestRows: number;
    rowCoveragePct: number;
    okCoveragePct: number;
    /** Backward-compatible alias for okCoveragePct. */
    coveragePct: number;
    fiveXAfterSellRows: number;
  };
  counts: {
    anchorMode: CountEntry[];
    anchorEvent: CountEntry[];
    status: CountEntry[];
    anchorType: CountEntry[];
    quoteReason: CountEntry[];
  };
  horizonCoverage: HorizonCoverage[];
  topAfterSellPositive: string[];
  worstAfterBuy: string[];
}

export function formatCounts(counts: CountEntry[], limit = counts.length): string {
  return counts.slice(0, limit).map((entry) => `${entry.key}:${entry.count}`).join(', ') || 'none';
}

export function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatNullablePct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function verdictFor(report: Pick<AuditReport, 'summary'>): AuditReport['verdict'] {
  if (report.summary.fiveXAfterSellRows > 0) return 'PAUSE_REVIEW';
  if (report.summary.expectedRows === 0) return 'WATCH';
  const okCoveragePct = report.summary.okCoveragePct ?? report.summary.coveragePct;
  if (okCoveragePct < 50) return 'INVESTIGATE';
  if (okCoveragePct < 80) return 'WATCH';
  return 'OK';
}

export async function writeOutputFile(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
}

export function renderText(report: AuditReport): string {
  const lines = [
    `Trade Markout Audit since ${report.since}`,
    `- verdict=${report.verdict}`,
    `- lane=${report.lane ?? 'kol_hunter'}`,
    `- horizons=${report.horizonsSec.join(',')}s`,
    `- anchors=${report.summary.anchors} anchorRows=${report.summary.anchorRows} fallbackLiveBuys=${report.summary.fallbackLiveBuys} fallbackLiveSells=${report.summary.fallbackLiveSells}`,
    `- anchorMode=${formatCounts(report.counts.anchorMode)}`,
    `- anchorEvent=${formatCounts(report.counts.anchorEvent, 8)}`,
    `- expectedRows=${report.summary.expectedRows} observedLatestRows=${report.summary.observedLatestRows} ` +
      `okLatestRows=${report.summary.okLatestRows} rowCoverage=${formatPct(report.summary.rowCoveragePct)} ` +
      `okCoverage=${formatPct(report.summary.okCoveragePct)}`,
    `- status=${formatCounts(report.counts.status)}`,
    `- anchorType=${formatCounts(report.counts.anchorType)}`,
    `- quoteReason=${formatCounts(report.counts.quoteReason, 8)}`,
  ];
  if (report.horizonCoverage.length > 0) {
    lines.push('', 'Coverage by horizon:');
    for (const row of report.horizonCoverage) {
      lines.push(
        `- T+${row.horizonSec}s expected=${row.expectedRows} observed=${row.observedRows} ok=${row.okRows} ` +
        `postCostPositive=${row.positivePostCostRows}/${row.okRows} ` +
        `median=${formatNullablePct(row.medianDeltaPct)} postCostMedian=${formatNullablePct(row.medianPostCostDeltaPct)} ` +
        `rowCoverage=${formatPct(row.rowCoveragePct)} okCoverage=${formatPct(row.okCoveragePct)}`
      );
    }
  }
  if (report.topAfterSellPositive.length > 0) {
    lines.push('', 'Top after-sell positive markouts:');
    for (const line of report.topAfterSellPositive) lines.push(`- ${line}`);
  }
  if (report.worstAfterBuy.length > 0) {
    lines.push('', 'Worst after-buy markouts:');
    for (const line of report.worstAfterBuy) lines.push(`- ${line}`);
  }
  lines.push('', `One-line verdict: ${report.verdict}`);
  return lines.join('\n');
}

export function renderMarkdown(report: AuditReport): string {
  const lines = [
    '# Trade Markout Audit',
    '',
    `- generatedAt: ${report.generatedAt}`,
    `- since: ${report.since}`,
    `- realtimeDir: \`${report.realtimeDir}\``,
    `- lane: \`${report.lane ?? 'kol_hunter'}\``,
    `- horizons: ${report.horizonsSec.map((horizon) => `T+${horizon}s`).join(', ')}`,
    `- one-line verdict: **${report.verdict}**`,
    '',
    '## Summary',
    '',
    '| metric | value |',
    '|---|---:|',
    `| anchors | ${report.summary.anchors} |`,
    `| anchorRows | ${report.summary.anchorRows} |`,
    `| fallbackLiveBuys | ${report.summary.fallbackLiveBuys} |`,
    `| fallbackLiveSells | ${report.summary.fallbackLiveSells} |`,
    `| expectedRows | ${report.summary.expectedRows} |`,
    `| observedLatestRows | ${report.summary.observedLatestRows} |`,
    `| okLatestRows | ${report.summary.okLatestRows} |`,
    `| rowCoverage | ${formatPct(report.summary.rowCoveragePct)} |`,
    `| okCoverage | ${formatPct(report.summary.okCoveragePct)} |`,
    `| fiveXAfterSellRows | ${report.summary.fiveXAfterSellRows} |`,
    '',
    '## Horizon Coverage',
    '',
    '| horizon | expected | observed | ok | pc+ | median | pc median | rowCoverage | okCoverage |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.horizonCoverage) {
    lines.push(
      `| T+${row.horizonSec}s | ${row.expectedRows} | ${row.observedRows} | ${row.okRows} | ` +
      `${row.positivePostCostRows}/${row.okRows} | ${formatNullablePct(row.medianDeltaPct)} | ` +
      `${formatNullablePct(row.medianPostCostDeltaPct)} | ${formatPct(row.rowCoveragePct)} | ${formatPct(row.okCoveragePct)} |`
    );
  }
  lines.push(
    '',
    '## Counts',
    '',
    '| axis | values |',
    '|---|---|',
    `| anchorMode | ${formatCounts(report.counts.anchorMode)} |`,
    `| anchorEvent | ${formatCounts(report.counts.anchorEvent, 12)} |`,
    `| status | ${formatCounts(report.counts.status)} |`,
    `| anchorType | ${formatCounts(report.counts.anchorType)} |`,
    `| quoteReason | ${formatCounts(report.counts.quoteReason, 12)} |`,
    '',
    '## Top After-sell Positive Markouts',
    '',
  );
  if (report.topAfterSellPositive.length === 0) {
    lines.push('- none');
  } else {
    for (const line of report.topAfterSellPositive) lines.push(`- ${line}`);
  }
  lines.push('', '## Worst After-buy Markouts', '');
  if (report.worstAfterBuy.length === 0) {
    lines.push('- none');
  } else {
    for (const line of report.worstAfterBuy) lines.push(`- ${line}`);
  }
  lines.push('', `One-line verdict: ${report.verdict}`);
  return lines.join('\n');
}
