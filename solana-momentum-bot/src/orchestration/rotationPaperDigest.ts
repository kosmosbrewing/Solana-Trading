// rotation-v1 paper digest.
// 파일 기반 요약만 수행해 Telegram 실패가 KOL 진입/종료 경로에 영향을 주지 않게 한다.

import { readFile } from 'fs/promises';
import path from 'path';
import type { Notifier } from '../notifier';
import { config } from '../utils/config';
import { createModuleLogger } from '../utils/logger';
import { getActiveKolHunterPositionsSnapshot, type PaperPosition } from './kolSignalHandler';

const log = createModuleLogger('RotationPaperDigest');

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

function pct(value: number | null): string {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function sol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(6)}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function uniqSortedSeconds(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
}

function rotationDigestHorizons(): number[] {
  return uniqSortedSeconds([
    ...(config.kolHunterRotationV1MarkoutOffsetsSec ?? [15, 30, 60]),
    300,
    1800,
  ]);
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

function armShort(raw: string): string {
  return raw
    .replace(/^kol_hunter_rotation_/, 'rotation_')
    .replace(/^kol_hunter_/, '')
    .replace(/^rotation_/, 'rot_')
    .replace(/_v1$/, '');
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

function countBy(rows: JsonRow[], keyFn: (row: JsonRow) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyFn(row) || '(missing)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
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
    readJsonl(path.join(config.realtimeDataDir, 'kol-paper-trades.jsonl')),
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

  const net = closed.reduce((sum, row) => sum + (num(row.netSol) ?? 0), 0);
  const tokenNet = closed.reduce((sum, row) => sum + (num(row.netSolTokenOnly) ?? num(row.netSol) ?? 0), 0);
  const wins = closed.filter((row) => (num(row.netSol) ?? 0) > 0).length;
  const losses = closed.filter((row) => (num(row.netSol) ?? 0) < 0).length;
  const medHold = median(closed.map((row) => num(row.holdSec)).filter((value): value is number => value != null));
  const arms = countBy([...entries, ...closed], rowArmName)
    .slice(0, 5)
    .map(([key, count]) => `${armShort(key)}:${count}`)
    .join(', ') || 'none';
  const exits = countBy(closed, (row) => str(row.exitReason) || '(unknown)')
    .slice(0, 4)
    .map(([key, count]) => `${key}:${count}`)
    .join(', ') || 'none';

  const topMfe = [...closed]
    .sort((a, b) => (num(b.mfePctPeak) ?? -Infinity) - (num(a.mfePctPeak) ?? -Infinity))
    .slice(0, 3)
    .map((row) =>
      `${str(row.tokenMint).slice(0, 8)} ${armShort(rowArmName(row))} ` +
      `MFE ${pct(num(row.mfePctPeak))} net ${sol(num(row.netSol) ?? 0)}`
    );

  const roundTripCost = config.defaultAmmFeePct + config.defaultMevMarginPct;
  const markoutLines = rotationDigestHorizons().map((horizonSec) => {
    const maturedAnchors = uniqueByKey(
      rotationAnchors.filter((row) => {
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
      rotationMarkouts.filter((row) => expectedKeys.has(markoutKey(row))),
      markoutKey
    );
    const ok = rows.filter(isOkMarkout);
    const postCost = ok.map((row) => (num(row.deltaPct) ?? 0) - roundTripCost);
    const positivePostCost = postCost.filter((value) => value > 0).length;
    return `T+${horizonSec}s ok ${ok.length}/${expectedKeys.size} pc+ ${positivePostCost}/${ok.length} med ${pct(median(postCost))}`;
  });

  const skipOk = windowSkipProbes.filter((row) => str(obj(row.probe).quoteStatus) === 'ok' && num(obj(row.probe).deltaPct) != null);
  const skipPostCost = skipOk.map((row) => (num(obj(row.probe).deltaPct) ?? 0) - roundTripCost);
  const skipPositive = skipPostCost.filter((value) => value > 0).length;
  const afterSellTail = windowMarkouts
    .filter((row) =>
      str(row.anchorType) === 'sell' &&
      isOkMarkout(row) &&
      (num(row.deltaPct) ?? 0) >= config.kolHunterRotationPaperRareAfterSellPct
    )
    .sort((a, b) => (num(b.deltaPct) ?? -Infinity) - (num(a.deltaPct) ?? -Infinity))
    .slice(0, 3)
    .map((row) => `${str(row.positionId).slice(0, 18)} T+${num(row.horizonSec) ?? '?'} ${pct(num(row.deltaPct))}`);

  const startKst = new Date(startedMs + 9 * 3600_000).toISOString().slice(11, 16);
  const endKst = new Date(nowMs + 9 * 3600_000).toISOString().slice(11, 16);
  const lines = [
    `[ROTATION PAPER ${startKst}-${endKst} KST]`,
    `entries ${entries.length} · closes ${closed.length} · open ${openPaper.length} · skips ${skipMarkers.length}`,
    `W/L ${wins}/${losses} · net ${sol(net)} SOL · token ${sol(tokenNet)} SOL · medHold ${medHold == null ? 'n/a' : `${Math.round(medHold)}s`}`,
    `arms ${arms}`,
    `exits ${exits}`,
  ];
  if (topMfe.length > 0) {
    lines.push(`top MFE: ${topMfe.join(' | ')}`);
  }
  if (skipMarkers.length > 0 || windowSkipProbes.length > 0) {
    lines.push(`arm-skip FN: pc+ ${skipPositive}/${skipOk.length} · probes ${windowSkipProbes.length}`);
  }
  if (afterSellTail.length > 0) {
    lines.push(`after-sell tail: ${afterSellTail.join(' | ')}`);
  }
  lines.push(`markout: ${markoutLines.join(' | ')}`);

  try {
    await notifier.sendInfo(lines.join('\n'), 'kol_rotation_paper_digest');
  } catch (err) {
    log.warn(`rotation paper digest send failed: ${err}`);
  }
}

export function __resetRotationPaperDigestForTests(nowMs = Date.now()): void {
  windowStartedMs = nowMs;
}
