/**
 * trade-markout-audit
 *
 * Usage:
 *   npx ts-node scripts/trade-markout-audit.ts --since 24h --realtime-dir data/realtime
 *   npx ts-node scripts/trade-markout-audit.ts --since 24h --md reports/trade-markout.md --json reports/trade-markout.json
 */
import { readFile } from 'fs/promises';
import path from 'path';
import {
  AuditReport,
  CountEntry,
  renderMarkdown,
  renderText,
  verdictFor,
  writeOutputFile,
} from './lib/tradeMarkoutAuditReport';

interface Args {
  realtimeDir: string;
  sinceMs: number;
  horizonsSec: number[];
  mdOut?: string;
  jsonOut?: string;
}

interface JsonRow {
  [key: string]: unknown;
}

interface ExpectedAnchor {
  key: string;
  anchorType: 'buy' | 'sell';
  atMs: number;
  mode: string;
  eventType: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    realtimeDir: path.resolve(process.cwd(), 'data/realtime'),
    sinceMs: Date.now() - 24 * 3600_000,
    horizonsSec: [30, 60, 300, 1800],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--realtime-dir') args.realtimeDir = path.resolve(argv[++i]);
    else if (arg === '--since') args.sinceMs = parseSince(argv[++i]);
    else if (arg === '--horizons') args.horizonsSec = parseHorizons(argv[++i]);
    else if (arg === '--md') args.mdOut = path.resolve(argv[++i]);
    else if (arg === '--json') args.jsonOut = path.resolve(argv[++i]);
  }
  return args;
}

function parseSince(raw: string): number {
  if (/^\d+h$/.test(raw)) return Date.now() - Number(raw.slice(0, -1)) * 3600_000;
  if (/^\d+d$/.test(raw)) return Date.now() - Number(raw.slice(0, -1)) * 86400_000;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`invalid --since: ${raw}`);
}

function parseHorizons(raw: string): number[] {
  const values = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) throw new Error(`invalid --horizons: ${raw}`);
  return [...new Set(values)].sort((a, b) => a - b);
}

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

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function countBy<T>(rows: T[], fn: (row: T) => string): CountEntry[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = fn(row) || '(missing)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
}

function markoutKey(row: JsonRow): string {
  return `${anchorKey(row)}:${String(row.horizonSec ?? '')}`;
}

function isOkMarkout(row: JsonRow): boolean {
  return str(row.quoteStatus) === 'ok' && num(row.observedPrice) != null && num(row.deltaPct) != null;
}

function anchorKey(row: JsonRow): string {
  const anchorId = str(row.anchorTxSignature) || String(secondMs(timeMs(row.anchorAt)) || 'na');
  return `${str(row.positionId)}:${str(row.anchorType)}:${anchorId}`;
}

function anchorKeyFromParts(positionId: string, anchorType: 'buy' | 'sell', atMs: number, txSignature?: string): string {
  const anchorId = txSignature || String(secondMs(atMs));
  return `${positionId}:${anchorType}:${anchorId}`;
}

function paperCloseAnchors(row: JsonRow): Array<{ anchorType: 'buy' | 'sell'; atMs: number; positionId: string }> {
  const closedAtMs = timeMs(row.closedAt);
  const holdSec = num(row.holdSec);
  const positionId = str(row.positionId);
  if (!positionId || !Number.isFinite(closedAtMs) || holdSec == null) return [];
  return [
    { positionId, anchorType: 'buy', atMs: secondMs(closedAtMs - holdSec * 1000) },
    { positionId, anchorType: 'sell', atMs: secondMs(closedAtMs) },
  ];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [anchorRows, buys, sells, paperCloses, shadowPaperCloses, partialTakes, markouts] = await Promise.all([
    readJsonl(path.join(args.realtimeDir, 'trade-markout-anchors.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'executed-buys.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'executed-sells.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'kol-paper-trades.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'kol-shadow-paper-trades.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'kol-partial-takes.jsonl')),
    readJsonl(path.join(args.realtimeDir, 'trade-markouts.jsonl')),
  ]);

  const recentBuys = buys.filter((row) => str(row.strategy) === 'kol_hunter' && timeMs(row.recordedAt) >= args.sinceMs);
  const recentSells = sells.filter((row) => str(row.strategy) === 'kol_hunter' && timeMs(row.recordedAt) >= args.sinceMs);
  const paperCloseAnchorsFromLedger = [...paperCloses, ...shadowPaperCloses]
    .filter((row) => str(row.strategy) === 'kol_hunter')
    .flatMap(paperCloseAnchors)
    .filter((anchor) => anchor.atMs >= args.sinceMs);
  const partialAnchors = partialTakes
    .filter((row) => str(row.strategy) === 'kol_hunter' && timeMs(row.promotedAt) >= args.sinceMs);
  const recentMarkouts = markouts.filter((row) => timeMs(row.recordedAt) >= args.sinceMs || timeMs(row.firedAt) >= args.sinceMs);

  const expectedAnchors = new Map<string, ExpectedAnchor>();
  for (const row of anchorRows) {
    const atMs = timeMs(row.anchorAt);
    const anchorType = str(row.anchorType);
    const positionId = str(row.positionId);
    if (!positionId || (anchorType !== 'buy' && anchorType !== 'sell') || atMs < args.sinceMs) continue;
    const key = anchorKey(row);
    const extras = typeof row.extras === 'object' && row.extras != null ? row.extras as JsonRow : {};
    expectedAnchors.set(key, {
      key,
      anchorType,
      atMs,
      mode: str(extras.mode) || 'unknown',
      eventType: str(extras.eventType) || `${str(extras.mode) || 'unknown'}_${anchorType}`,
    });
  }
  for (const row of recentBuys) {
    const positionId = str(row.positionId);
    const atMs = timeMs(row.buyCompletedAtMs) || timeMs(row.recordedAt);
    if (!positionId || !Number.isFinite(atMs)) continue;
    const key = anchorKeyFromParts(positionId, 'buy', atMs, str(row.txSignature));
    if (!expectedAnchors.has(key)) expectedAnchors.set(key, { key, anchorType: 'buy', atMs, mode: 'live', eventType: 'live_entry_fallback' });
  }
  for (const row of recentSells) {
    const positionId = str(row.positionId);
    const atMs = timeMs(row.recordedAt);
    if (!positionId || !Number.isFinite(atMs)) continue;
    const key = anchorKeyFromParts(positionId, 'sell', atMs, str(row.txSignature));
    if (!expectedAnchors.has(key)) expectedAnchors.set(key, { key, anchorType: 'sell', atMs, mode: 'live', eventType: 'live_exit_fallback' });
  }
  for (const anchor of paperCloseAnchorsFromLedger) {
    const key = anchorKeyFromParts(anchor.positionId, anchor.anchorType, anchor.atMs);
    if (!expectedAnchors.has(key)) expectedAnchors.set(key, {
      key,
      anchorType: anchor.anchorType,
      atMs: anchor.atMs,
      mode: 'paper',
      eventType: `paper_close_${anchor.anchorType}_fallback`,
    });
  }
  for (const row of partialAnchors) {
    const positionId = str(row.positionId);
    const atMs = timeMs(row.promotedAt);
    if (!positionId || !Number.isFinite(atMs)) continue;
    const key = anchorKeyFromParts(positionId, 'sell', atMs);
    if (!expectedAnchors.has(key)) expectedAnchors.set(key, { key, anchorType: 'sell', atMs, mode: 'paper', eventType: 'paper_partial_take_fallback' });
  }

  const latestByKey = new Map<string, JsonRow>();
  for (const row of recentMarkouts) {
    const key = markoutKey(row);
    const current = latestByKey.get(key);
    const rowOk = isOkMarkout(row);
    const currentOk = current ? isOkMarkout(current) : false;
    if (
      !current ||
      (rowOk && !currentOk) ||
      (rowOk === currentOk && timeMs(row.recordedAt) >= timeMs(current.recordedAt))
    ) {
      latestByKey.set(key, row);
    }
  }
  const expectedMarkoutKeys = new Set<string>();
  for (const anchor of expectedAnchors.values()) {
    for (const horizon of args.horizonsSec) expectedMarkoutKeys.add(`${anchor.key}:${horizon}`);
  }
  const latest = [...latestByKey.entries()]
    .filter(([key]) => expectedMarkoutKeys.size === 0 || expectedMarkoutKeys.has(key))
    .map(([, row]) => row);
  const latestOk = latest.filter(isOkMarkout);
  const expected = expectedMarkoutKeys.size;
  const rowCoverage = expected > 0 ? latest.length / expected : 0;
  const okCoverage = expected > 0 ? latestOk.length / expected : 0;
  const horizonCoverage = args.horizonsSec.map((horizonSec) => {
    const observedRows = latest.filter((row) => num(row.horizonSec) === horizonSec).length;
    const okRows = latestOk.filter((row) => num(row.horizonSec) === horizonSec).length;
    const expectedRows = expectedAnchors.size;
    return {
      horizonSec,
      expectedRows,
      observedRows,
      okRows,
      rowCoveragePct: expectedRows > 0 ? (observedRows / expectedRows) * 100 : 0,
      okCoveragePct: expectedRows > 0 ? (okRows / expectedRows) * 100 : 0,
      coveragePct: expectedRows > 0 ? (okRows / expectedRows) * 100 : 0,
    };
  });

  const bestAfterSell = latestOk
    .filter((row) => row.anchorType === 'sell')
    .sort((a, b) => (num(b.deltaPct) ?? -Infinity) - (num(a.deltaPct) ?? -Infinity))
    .slice(0, 10)
    .map((row) =>
      `${str(row.positionId).slice(0, 24)} ${str(row.tokenMint).slice(0, 8)} ` +
      `T+${row.horizonSec}s delta=${((num(row.deltaPct) ?? 0) * 100).toFixed(1)}%`
    );
  const worstAfterBuy = latestOk
    .filter((row) => row.anchorType === 'buy')
    .sort((a, b) => (num(a.deltaPct) ?? Infinity) - (num(b.deltaPct) ?? Infinity))
    .slice(0, 10)
    .map((row) =>
      `${str(row.positionId).slice(0, 24)} ${str(row.tokenMint).slice(0, 8)} ` +
      `T+${row.horizonSec}s delta=${((num(row.deltaPct) ?? 0) * 100).toFixed(1)}%`
    );

  const reportWithoutVerdict = {
    generatedAt: new Date().toISOString(),
    since: new Date(args.sinceMs).toISOString(),
    realtimeDir: args.realtimeDir,
    horizonsSec: args.horizonsSec,
    verdict: 'WATCH' as AuditReport['verdict'],
    summary: {
      anchors: expectedAnchors.size,
      anchorRows: anchorRows.length,
      fallbackLiveBuys: recentBuys.length,
      fallbackLiveSells: recentSells.length,
      expectedRows: expected,
      observedLatestRows: latest.length,
      okLatestRows: latestOk.length,
      rowCoveragePct: rowCoverage * 100,
      okCoveragePct: okCoverage * 100,
      coveragePct: okCoverage * 100,
      fiveXAfterSellRows: latestOk.filter((row) => row.anchorType === 'sell' && (num(row.deltaPct) ?? -Infinity) >= 4).length,
    },
    counts: {
      anchorMode: countBy([...expectedAnchors.values()], (row) => row.mode),
      anchorEvent: countBy([...expectedAnchors.values()], (row) => row.eventType),
      status: countBy(latest, (row) => str(row.quoteStatus)),
      anchorType: countBy(latest, (row) => str(row.anchorType)),
      quoteReason: countBy(latest, (row) => str(row.quoteReason)),
    },
    horizonCoverage,
    topAfterSellPositive: bestAfterSell,
    worstAfterBuy,
  };
  const report: AuditReport = {
    ...reportWithoutVerdict,
    verdict: verdictFor(reportWithoutVerdict),
  };

  console.log(renderText(report));
  if (args.mdOut) await writeOutputFile(args.mdOut, renderMarkdown(report));
  if (args.jsonOut) await writeOutputFile(args.jsonOut, JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(`[trade-markout-audit] fatal: ${String(err)}`);
  process.exitCode = 1;
});
