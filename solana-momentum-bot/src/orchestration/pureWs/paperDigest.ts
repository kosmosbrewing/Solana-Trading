// pure_ws paper digest.
// Reads append-only ledgers on a timer so notification failures never affect trading.

import { readFile } from 'fs/promises';
import path from 'path';
import type { Notifier } from '../../notifier';
import { config } from '../../utils/config';
import { createModuleLogger } from '../../utils/logger';
import { getActivePureWsPositions } from './positionState';
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

interface PaperHourlyLine {
  kstHour: number;
  closed: number;
  winners: number;
  losers: number;
  netSol: number;
}

function kstDayStartMs(nowMs: number): number {
  const kst = new Date(nowMs + 9 * 3600_000);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600_000;
}

function kstHourOf(ms: number): number {
  return (new Date(ms).getUTCHours() + 9) % 24;
}

function signSol4(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

function formatPaperHour(hour: number): string {
  return hour.toString().padStart(2, '0');
}

function formatZeroRange(start: PaperHourlyLine, end: PaperHourlyLine): string {
  if (start.kstHour === end.kstHour) return `- ${formatPaperHour(start.kstHour)}:00 · close 0건`;
  return `- ${formatPaperHour(start.kstHour)}-${formatPaperHour(end.kstHour)} · close 0건`;
}

function formatPaperHourlyLines(lines: PaperHourlyLine[]): string[] {
  const out: string[] = [];
  let quietStart: PaperHourlyLine | null = null;
  let quietEnd: PaperHourlyLine | null = null;
  const flushQuiet = () => {
    if (quietStart && quietEnd) out.push(formatZeroRange(quietStart, quietEnd));
    quietStart = null;
    quietEnd = null;
  };

  for (const line of lines) {
    if (line.closed === 0) {
      quietStart ??= line;
      quietEnd = line;
      continue;
    }
    flushQuiet();
    out.push(
      `- ${formatPaperHour(line.kstHour)}:00 · close ${line.closed}건 ` +
      `(${line.winners}W/${line.losers}L) net ${signSol4(line.netSol)}`
    );
  }
  flushQuiet();
  return out;
}

function buildPaperTodayDigest(label: string, closedRows: JsonRow[], nowMs: number): string {
  const dayStartMs = kstDayStartMs(nowMs);
  const endHour = kstHourOf(nowMs);
  const hours: PaperHourlyLine[] = [];
  for (let hour = 0; hour <= endHour; hour += 1) {
    hours.push({ kstHour: hour, closed: 0, winners: 0, losers: 0, netSol: 0 });
  }

  for (const row of closedRows) {
    const closedAt = timeMs(row.closedAt);
    if (!Number.isFinite(closedAt) || closedAt < dayStartMs || closedAt >= nowMs) continue;
    const bucket = hours[kstHourOf(closedAt)];
    if (!bucket) continue;
    const net = num(row.netSol) ?? 0;
    bucket.closed += 1;
    bucket.netSol += net;
    if (net > 0) bucket.winners += 1;
    else bucket.losers += 1;
  }

  const totalClosed = hours.reduce((sum, line) => sum + line.closed, 0);
  const totalWinners = hours.reduce((sum, line) => sum + line.winners, 0);
  const totalLosers = hours.reduce((sum, line) => sum + line.losers, 0);
  const totalNet = hours.reduce((sum, line) => sum + line.netSol, 0);
  const aggregate = totalClosed > 0
    ? `· 합계 close ${totalClosed}건 (${totalWinners}W/${totalLosers}L) net ${signSol4(totalNet)} SOL`
    : `· 합계 close 0건 (해당 구간 PAPER 거래 없음)`;

  return [
    `⚪ 📊 <b>${label} PAPER 오늘 요약</b> KST 00:00→${formatPaperHour(endHour)}:00`,
    ...formatPaperHourlyLines(hours),
    aggregate,
  ].join('\n');
}

export async function flushPureWsPaperDigest(
  notifier: Notifier,
  options: { force?: boolean } = {}
): Promise<void> {
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

  if (
    !options.force &&
    closed.length === 0 &&
    entries.length === 0 &&
    openPaper.length === 0 &&
    windowMarkouts.length === 0
  ) {
    return;
  }

  const dayClosed = trades.filter((row) => isPureWsNewPairLedgerRow(row));
  const lines = [buildPaperTodayDigest('PURE_WS', dayClosed, nowMs)];
  lines.push(`· PAPER open ${openPaper.length}건 · entries ${entries.length}건`);

  try {
    await notifier.sendInfo(lines.join('\n'), 'pure_ws_paper_digest');
  } catch (err) {
    log.warn(`pure_ws paper digest send failed: ${err}`);
  }
}

export function __resetPureWsPaperDigestForTests(nowMs = Date.now()): void {
  windowStartedMs = nowMs;
}
