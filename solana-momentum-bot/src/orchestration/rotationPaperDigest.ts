// rotation-v1 paper digest.
// 파일 기반 요약만 수행해 Telegram 실패가 KOL 진입/종료 경로에 영향을 주지 않게 한다.

import { readFile } from 'fs/promises';
import path from 'path';
import type { Notifier } from '../notifier';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { getActiveKolHunterPositionsSnapshot, type PaperPosition } from './kolSignalHandler';

const log = createModuleLogger('RotationPaperDigest');
const ROTATION_PAPER_TRADES_FILE = 'rotation-v1-paper-trades.jsonl';
const KOL_PAPER_TRADES_FILE = 'kol-paper-trades.jsonl';

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

async function readRotationPaperTrades(): Promise<JsonRow[]> {
  const projected = await readJsonl(path.join(config.realtimeDataDir, ROTATION_PAPER_TRADES_FILE));
  if (projected.length > 0) return projected;
  return readJsonl(path.join(config.realtimeDataDir, KOL_PAPER_TRADES_FILE));
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): JsonRow {
  return typeof value === 'object' && value != null ? value as JsonRow : {};
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
  return obj(row.extras);
}

function rowArmName(row: JsonRow): string {
  const extras = extrasOf(row);
  return str(row.armName) ||
    str(row.signalSource) ||
    str(extras.armName) ||
    str(row.parameterVersion) ||
    str(extras.parameterVersion) ||
    '(unknown)';
}

function isRotationArmValue(value: string): boolean {
  return value === 'kol_hunter_rotation_v1' ||
    value.startsWith('rotation_') ||
    value.startsWith('rotation-') ||
    value.includes('rotation_v1');
}

function isRotationPaperTrade(row: JsonRow): boolean {
  if (str(row.strategy) !== 'kol_hunter' && str(row.lane) !== 'kol_hunter') return false;
  if (isRotationArmValue(rowArmName(row))) return true;
  if (str(row.kolEntryReason) === 'rotation_v1' || str(row.entryReason) === 'rotation_v1') return true;
  return str(row.parameterVersion).startsWith('rotation-');
}

function isRotationSidecarRow(row: JsonRow): boolean {
  const extras = extrasOf(row);
  if (isRotationArmValue(rowArmName(row))) return true;
  if (str(extras.entryReason) === 'rotation_v1') return true;
  return Array.isArray(extras.rotationAnchorKols) && extras.rotationAnchorKols.length > 0;
}

function isPaperSidecarRow(row: JsonRow): boolean {
  const extras = extrasOf(row);
  return str(extras.mode) === 'paper' || str(row.mode) === 'paper';
}

function isRotationPaperPosition(pos: PaperPosition): boolean {
  return pos.kolEntryReason === 'rotation_v1' ||
    pos.armName === 'kol_hunter_rotation_v1' ||
    pos.armName.startsWith('rotation_') ||
    pos.parameterVersion.startsWith('rotation-');
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

function eventKey(row: JsonRow): string {
  return str(row.eventId) || `${str(row.tokenMint)}:${str(row.rejectReason)}:${timeMs(row.rejectedAt)}`;
}

export async function flushRotationPaperDigest(notifier: Notifier): Promise<void> {
  if (!config.kolHunterRotationPaperNotifyEnabled || !config.kolHunterRotationPaperDigestEnabled) return;
  const nowMs = Date.now();
  const startedMs = windowStartedMs;
  windowStartedMs = nowMs;

  const [trades, anchors, markouts, missedAlpha] = await Promise.all([
    readRotationPaperTrades(),
    readJsonl(path.join(config.realtimeDataDir, 'trade-markout-anchors.jsonl')),
    readJsonl(path.join(config.realtimeDataDir, 'trade-markouts.jsonl')),
    readJsonl(path.join(config.realtimeDataDir, 'missed-alpha.jsonl')),
  ]);

  const rotationAnchors = anchors.filter((row) => isRotationSidecarRow(row) && isPaperSidecarRow(row));
  const rotationMarkouts = markouts.filter((row) => isRotationSidecarRow(row) && isPaperSidecarRow(row));
  const closed = trades.filter((row) => {
    const closedAt = timeMs(row.closedAt);
    return isRotationPaperTrade(row) && inWindow(closedAt, startedMs, nowMs);
  });
  const entries = uniqueByKey(
    rotationAnchors.filter((row) => str(row.anchorType) === 'buy' && inWindow(timeMs(row.anchorAt), startedMs, nowMs)),
    anchorKey
  );
  const windowMarkouts = rotationMarkouts.filter((row) => inWindow(timeMs(row.recordedAt), startedMs, nowMs));
  const openPaper = getActiveKolHunterPositionsSnapshot().filter((pos) =>
    pos.state !== 'CLOSED' &&
    pos.isLive !== true &&
    isRotationPaperPosition(pos)
  );
  const rotationSkipRows = missedAlpha.filter((row) => extrasOf(row).eventType === 'rotation_arm_skip');
  const skipMarkers = uniqueByKey(
    rotationSkipRows.filter((row) => (num(obj(row.probe).offsetSec) ?? 0) === 0 && inWindow(timeMs(row.rejectedAt), startedMs, nowMs)),
    eventKey
  );
  const windowSkipProbes = rotationSkipRows.filter((row) =>
    (num(obj(row.probe).offsetSec) ?? 0) > 0 &&
    inWindow(timeMs(obj(row.probe).firedAt), startedMs, nowMs)
  );

  if (
    closed.length === 0 &&
    entries.length === 0 &&
    openPaper.length === 0 &&
    windowMarkouts.length === 0 &&
    skipMarkers.length === 0 &&
    windowSkipProbes.length === 0
  ) {
    return;
  }

  const dayClosed = trades.filter((row) => isRotationPaperTrade(row));
  const lines = [buildPaperTodayDigest('ROTATION', dayClosed, nowMs)];
  lines.push(`· PAPER open ${openPaper.length}건 · entries ${entries.length}건 · skips ${skipMarkers.length}건`);

  try {
    await notifier.sendInfo(lines.join('\n'), 'kol_rotation_paper_digest');
  } catch (err) {
    log.warn(`rotation paper digest send failed: ${err}`);
  }
}

export function __resetRotationPaperDigestForTests(nowMs = Date.now()): void {
  windowStartedMs = nowMs;
}
