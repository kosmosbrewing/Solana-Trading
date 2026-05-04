// pure_ws paper digest.
// Reads append-only ledgers on a timer so notification failures never affect trading.

import { readFile } from 'fs/promises';
import path from 'path';
import type { Notifier } from '../../notifier';
import { config } from '../../utils/config';
import { createModuleLogger } from '../../utils/logger';
import { getActivePureWsPositions } from './positionState';
import { pureWsPaperMarkoutOffsetsSec } from './markout';
import { isPureWsNewPairLedgerRow } from './sourceGate';

const log = createModuleLogger('PureWsPaperDigest');

interface JsonRow {
  [key: string]: unknown;
}

let windowStartedMs = Date.now();

async function readJsonl(file: string): Promise<JsonRow[]> {
  try {
    const raw = await readFile(file, 'utf8');
    return raw.split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonRow];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timeMs(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function secondMs(value: number): number {
  return Math.floor(value / 1000) * 1000;
}

function pct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function sol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)}`;
}

function countBy(rows: JsonRow[], field: string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = str(row[field]) || '(missing)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function extrasOf(row: JsonRow): JsonRow {
  return typeof row.extras === 'object' && row.extras != null ? row.extras as JsonRow : {};
}

function isPureWsSidecarRow(row: JsonRow): boolean {
  const extras = extrasOf(row);
  const lane = str(extras.lane) || str(row.lane);
  const source = str(row.signalSource);
  const strategy = str(row.strategy) || str(extras.strategy);
  return lane === 'pure_ws' || source === 'pure_ws_breakout' || source === 'pure_ws_swing_v2' || strategy.startsWith('pure_ws');
}

function isOkMarkout(row: JsonRow): boolean {
  return str(row.quoteStatus) === 'ok' && num(row.deltaPct) != null;
}

function inWindow(valueMs: number, startedMs: number, nowMs: number): boolean {
  return Number.isFinite(valueMs) && valueMs >= startedMs && valueMs < nowMs;
}

function anchorKey(row: JsonRow): string {
  const txSignature = str(row.anchorTxSignature);
  if (txSignature) return `${str(row.positionId)}:${str(row.anchorType)}:${txSignature}`;
  const anchorAt = timeMs(row.anchorAt);
  const anchorId = Number.isFinite(anchorAt) ? String(secondMs(anchorAt)) : 'na';
  return `${str(row.positionId)}:${str(row.anchorType)}:${anchorId}`;
}

function markoutKey(row: JsonRow): string {
  return `${anchorKey(row)}:${String(num(row.horizonSec) ?? '')}`;
}

function uniqueByKey(rows: JsonRow[], keyFn: (row: JsonRow) => string): JsonRow[] {
  const seen = new Set<string>();
  const out: JsonRow[] = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function latestRowsByKey(rows: JsonRow[], keyFn: (row: JsonRow) => string): JsonRow[] {
  const latest = new Map<string, JsonRow>();
  for (const row of rows) {
    const key = keyFn(row);
    const current = latest.get(key);
    if (!current || timeMs(row.recordedAt) >= timeMs(current.recordedAt)) {
      latest.set(key, row);
    }
  }
  return [...latest.values()];
}

function armShort(raw: string): string {
  return raw.replace(/^pure_ws_/, '').replace(/^breakout$/, 'primary');
}

export async function flushPureWsPaperDigest(notifier: Notifier): Promise<void> {
  if (!config.pureWsPaperNotifyEnabled || !config.pureWsPaperDigestEnabled) return;
  const nowMs = Date.now();
  const startedMs = windowStartedMs;
  windowStartedMs = nowMs;

  const [trades, anchors, markouts] = await Promise.all([
    readJsonl(path.join(config.realtimeDataDir, 'pure-ws-paper-trades.jsonl')),
    readJsonl(path.join(config.realtimeDataDir, 'trade-markout-anchors.jsonl')),
    readJsonl(path.join(config.realtimeDataDir, 'trade-markouts.jsonl')),
  ]);
  const pureWsAnchors = anchors.filter((row) => isPureWsSidecarRow(row) && isPureWsNewPairLedgerRow(row));
  const pureWsMarkouts = markouts.filter((row) => isPureWsSidecarRow(row) && isPureWsNewPairLedgerRow(row));
  const closed = trades.filter((row) => {
    const closedAt = timeMs(row.closedAt);
    return isPureWsNewPairLedgerRow(row) && Number.isFinite(closedAt) && closedAt >= startedMs && closedAt < nowMs;
  });
  const entries = uniqueByKey(
    pureWsAnchors.filter((row) => str(row.anchorType) === 'buy' && inWindow(timeMs(row.anchorAt), startedMs, nowMs)),
    anchorKey
  );
  const windowMarkouts = pureWsMarkouts.filter((row) => inWindow(timeMs(row.recordedAt), startedMs, nowMs));
  const openPaper = [...getActivePureWsPositions().values()].filter((pos) =>
    pos.state !== 'CLOSED' &&
    isPureWsNewPairLedgerRow(pos) &&
    (pos.executionMode === 'paper' || pos.isShadowArm === true || pos.paperOnlyReason != null)
  );

  if (closed.length === 0 && entries.length === 0 && openPaper.length === 0 && windowMarkouts.length === 0) return;

  const net = closed.reduce((sum, row) => sum + (num(row.netSol) ?? 0), 0);
  const wins = closed.filter((row) => (num(row.netSol) ?? 0) > 0).length;
  const losses = closed.filter((row) => (num(row.netSol) ?? 0) < 0).length;
  const avgHold = median(closed.map((row) => num(row.holdSec)).filter((v): v is number => v != null));
  const byArm = countBy(closed, 'armName')
    .slice(0, 3)
    .map(([key, count]) => `${armShort(key)}:${count}`)
    .join(', ') || 'none';
  const byExit = countBy(closed, 'exitReason')
    .slice(0, 4)
    .map(([key, count]) => `${key}:${count}`)
    .join(', ') || 'none';

  const topMfe = [...closed]
    .sort((a, b) => (num(b.mfePctPeak) ?? -Infinity) - (num(a.mfePctPeak) ?? -Infinity))
    .slice(0, 3)
    .map((row) =>
      `${str(row.tokenSymbol) || str(row.pairAddress).slice(0, 8)} ` +
      `${armShort(str(row.armName))} MFE ${pct(num(row.mfePctPeak))} net ${sol(num(row.netSol) ?? 0)}`
    );

  const roundTripCost = config.defaultAmmFeePct + config.defaultMevMarginPct;
  const markoutLines = pureWsPaperMarkoutOffsetsSec().map((horizonSec) => {
    const maturedAnchors = uniqueByKey(
      pureWsAnchors.filter((row) => {
        const anchorAt = timeMs(row.anchorAt);
        const targetMs = anchorAt + horizonSec * 1000;
        return (
          (str(row.anchorType) === 'buy' || str(row.anchorType) === 'sell') &&
          Number.isFinite(anchorAt) &&
          targetMs >= startedMs &&
          targetMs < nowMs
        );
      }),
      anchorKey
    );
    const expectedKeys = new Set(maturedAnchors.map((row) => `${anchorKey(row)}:${horizonSec}`));
    const rows = latestRowsByKey(
      pureWsMarkouts.filter((row) => expectedKeys.has(markoutKey(row))),
      markoutKey
    );
    const ok = rows.filter(isOkMarkout);
    const postCost = ok
      .map((row) => (num(row.deltaPct) ?? 0) - roundTripCost);
    const positivePostCost = postCost.filter((value) => value > 0).length;
    const expected = expectedKeys.size;
    return `T+${horizonSec}s ok ${ok.length}/${expected} pc+ ${positivePostCost}/${ok.length} med ${pct(median(postCost))}`;
  });
  const afterSellTail = windowMarkouts
    .filter((row) =>
      str(row.anchorType) === 'sell' &&
      isOkMarkout(row) &&
      (num(row.deltaPct) ?? 0) >= config.pureWsPaperRareAfterSellPct
    )
    .sort((a, b) => (num(b.deltaPct) ?? -Infinity) - (num(a.deltaPct) ?? -Infinity))
    .slice(0, 3)
    .map((row) => `${str(row.positionId).slice(0, 18)} T+${num(row.horizonSec) ?? '?'} ${pct(num(row.deltaPct))}`);

  const startKst = new Date(startedMs + 9 * 3600_000).toISOString().slice(11, 16);
  const endKst = new Date(nowMs + 9 * 3600_000).toISOString().slice(11, 16);
  const lines = [
    `[PURE_WS PAPER ${startKst}-${endKst} KST]`,
    `entries ${entries.length} · closes ${closed.length} · open ${openPaper.length}`,
    `W/L ${wins}/${losses} · net ${sol(net)} SOL · medHold ${avgHold == null ? 'n/a' : `${Math.round(avgHold)}s`}`,
    `arms ${byArm}`,
    `exits ${byExit}`,
  ];
  if (topMfe.length > 0) {
    lines.push(`top MFE: ${topMfe.join(' | ')}`);
  }
  if (afterSellTail.length > 0) {
    lines.push(`after-sell tail: ${afterSellTail.join(' | ')}`);
  }
  lines.push(`markout: ${markoutLines.join(' | ')}`);

  try {
    await notifier.sendInfo(lines.join('\n'), 'pure_ws_paper_digest');
  } catch (err) {
    log.warn(`pure_ws paper digest send failed: ${err}`);
  }
}

export function __resetPureWsPaperDigestForTests(nowMs = Date.now()): void {
  windowStartedMs = nowMs;
}
