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
  coveragePct: number;
}

export interface AuditReport {
  generatedAt: string;
  since: string;
  realtimeDir: string;
  horizonsSec: number[];
  verdict: 'OK' | 'WATCH' | 'PAUSE_REVIEW' | 'INVESTIGATE';
  summary: {
    anchors: number;
    anchorRows: number;
    fallbackLiveBuys: number;
    fallbackLiveSells: number;
    expectedRows: number;
    observedLatestRows: number;
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

export function verdictFor(report: Pick<AuditReport, 'summary'>): AuditReport['verdict'] {
  if (report.summary.fiveXAfterSellRows > 0) return 'PAUSE_REVIEW';
  if (report.summary.expectedRows === 0) return 'WATCH';
  if (report.summary.coveragePct < 50) return 'INVESTIGATE';
  if (report.summary.coveragePct < 80) return 'WATCH';
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
    `- horizons=${report.horizonsSec.join(',')}s`,
    `- anchors=${report.summary.anchors} anchorRows=${report.summary.anchorRows} fallbackLiveBuys=${report.summary.fallbackLiveBuys} fallbackLiveSells=${report.summary.fallbackLiveSells}`,
    `- anchorMode=${formatCounts(report.counts.anchorMode)}`,
    `- anchorEvent=${formatCounts(report.counts.anchorEvent, 8)}`,
    `- expectedRows=${report.summary.expectedRows} observedLatestRows=${report.summary.observedLatestRows} coverage=${formatPct(report.summary.coveragePct)}`,
    `- status=${formatCounts(report.counts.status)}`,
    `- anchorType=${formatCounts(report.counts.anchorType)}`,
    `- quoteReason=${formatCounts(report.counts.quoteReason, 8)}`,
  ];
  if (report.horizonCoverage.length > 0) {
    lines.push('', 'Coverage by horizon:');
    for (const row of report.horizonCoverage) {
      lines.push(`- T+${row.horizonSec}s expected=${row.expectedRows} observed=${row.observedRows} coverage=${formatPct(row.coveragePct)}`);
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
    `| coverage | ${formatPct(report.summary.coveragePct)} |`,
    `| fiveXAfterSellRows | ${report.summary.fiveXAfterSellRows} |`,
    '',
    '## Horizon Coverage',
    '',
    '| horizon | expected | observed | coverage |',
    '|---:|---:|---:|---:|',
  ];
  for (const row of report.horizonCoverage) {
    lines.push(`| T+${row.horizonSec}s | ${row.expectedRows} | ${row.observedRows} | ${formatPct(row.coveragePct)} |`);
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
