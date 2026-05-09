import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

type JsonRecord = Record<string, unknown>;

interface Args {
  realtimeDir: string;
  sinceMs: number;
  md?: string;
  json?: string;
}

interface SummaryBucket {
  rows: number;
  liveWouldEnter: number;
  liveAttempted: number;
  blocked: number;
  paperCloses: number;
  paperWins: number;
  paperNetSol: number;
  paperNetSolTokenOnly: number;
  paperAvgMfePct: number | null;
  liveCloses: number;
  liveNetSol: number;
}

function parseArgs(argv: string[]): Args {
  let realtimeDir = 'data/realtime';
  let since = '24h';
  let md: string | undefined;
  let json: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--realtime-dir' && next) {
      realtimeDir = next;
      i += 1;
    } else if (arg === '--since' && next) {
      since = next;
      i += 1;
    } else if (arg === '--md' && next) {
      md = next;
      i += 1;
    } else if (arg === '--json' && next) {
      json = next;
      i += 1;
    }
  }
  return {
    realtimeDir,
    sinceMs: Date.now() - parseDurationMs(since),
    md,
    json,
  };
}

function parseDurationMs(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([mhd])$/i);
  if (!match) return 24 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return 24 * 60 * 60 * 1000;
  if (unit === 'm') return amount * 60 * 1000;
  if (unit === 'h') return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

async function readJsonl(file: string): Promise<JsonRecord[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === 'object' ? parsed as JsonRecord : null;
        } catch {
          return null;
        }
      })
      .filter((row): row is JsonRecord => row !== null);
  } catch {
    return [];
  }
}

function rowTimeMs(row: JsonRecord): number {
  const candidates = [
    row.generatedAt,
    row.closedAt,
    row.openedAt,
    row.entryAt,
    row.createdAt,
  ];
  for (const value of candidates) {
    if (typeof value === 'string') {
      const ts = Date.parse(value);
      if (Number.isFinite(ts)) return ts;
    }
  }
  if (typeof row.exitTimeSec === 'number') return row.exitTimeSec * 1000;
  if (typeof row.entryTimeSec === 'number') return row.entryTimeSec * 1000;
  return 0;
}

function str(row: JsonRecord, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(row: JsonRecord, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(row: JsonRecord, key: string): boolean {
  return row[key] === true;
}

function countBy(rows: JsonRecord[], key: string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = str(row, key) ?? String(row[key] ?? 'unknown');
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function dedupeTradeRows(rows: JsonRecord[]): JsonRecord[] {
  const seen = new Set<string>();
  const out: JsonRecord[] = [];
  for (const row of rows) {
    const key = str(row, 'positionId') ?? `${str(row, 'tokenMint') ?? 'unknown'}:${rowTimeMs(row)}:${str(row, 'exitReason') ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function addOutcome(bucket: SummaryBucket, row: JsonRecord, mode: 'paper' | 'live'): void {
  const netSol = num(row, 'netSol') ?? 0;
  if (mode === 'paper') {
    bucket.paperCloses += 1;
    bucket.paperNetSol += netSol;
    bucket.paperNetSolTokenOnly += num(row, 'netSolTokenOnly') ?? netSol;
    if (netSol > 0) bucket.paperWins += 1;
  } else {
    bucket.liveCloses += 1;
    bucket.liveNetSol += netSol;
  }
}

function emptyBucket(): SummaryBucket {
  return {
    rows: 0,
    liveWouldEnter: 0,
    liveAttempted: 0,
    blocked: 0,
    paperCloses: 0,
    paperWins: 0,
    paperNetSol: 0,
    paperNetSolTokenOnly: 0,
    paperAvgMfePct: null,
    liveCloses: 0,
    liveNetSol: 0,
  };
}

function pct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function sol(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}

async function buildReport(args: Args): Promise<{ md: string; json: JsonRecord }> {
  const realtimeDir = args.realtimeDir;
  const equivalence = (await readJsonl(path.join(realtimeDir, 'kol-live-equivalence.jsonl')))
    .filter((row) => rowTimeMs(row) >= args.sinceMs);
  const paperFiles = [
    'kol-paper-trades.jsonl',
    'smart-v3-paper-trades.jsonl',
    'rotation-v1-paper-trades.jsonl',
    'capitulation-rebound-paper-trades.jsonl',
  ];
  const liveFiles = [
    'kol-live-trades.jsonl',
    'smart-v3-live-trades.jsonl',
    'rotation-v1-live-trades.jsonl',
  ];
  const paperRows = dedupeTradeRows(
    (await Promise.all(paperFiles.map((file) => readJsonl(path.join(realtimeDir, file)))))
      .flat()
      .filter((row) => rowTimeMs(row) >= args.sinceMs)
  );
  const liveRows = dedupeTradeRows(
    (await Promise.all(liveFiles.map((file) => readJsonl(path.join(realtimeDir, file)))))
      .flat()
      .filter((row) => rowTimeMs(row) >= args.sinceMs)
  );

  const paperByCandidate = new Map<string, JsonRecord[]>();
  for (const row of paperRows) {
    const candidateId = str(row, 'liveEquivalenceCandidateId');
    if (!candidateId) continue;
    const rows = paperByCandidate.get(candidateId) ?? [];
    rows.push(row);
    paperByCandidate.set(candidateId, rows);
  }
  const liveByCandidate = new Map<string, JsonRecord[]>();
  for (const row of liveRows) {
    const candidateId = str(row, 'liveEquivalenceCandidateId');
    if (!candidateId) continue;
    const rows = liveByCandidate.get(candidateId) ?? [];
    rows.push(row);
    liveByCandidate.set(candidateId, rows);
  }

  const byArm = new Map<string, SummaryBucket>();
  const mfeByArm = new Map<string, number[]>();
  for (const row of equivalence) {
    const arm = str(row, 'armName') ?? 'unknown';
    const bucket = byArm.get(arm) ?? emptyBucket();
    bucket.rows += 1;
    if (bool(row, 'liveWouldEnter')) bucket.liveWouldEnter += 1;
    if (bool(row, 'liveAttempted')) bucket.liveAttempted += 1;
    if (!bool(row, 'liveWouldEnter')) bucket.blocked += 1;
    const candidateId = str(row, 'candidateId');
    if (candidateId) {
      for (const paper of paperByCandidate.get(candidateId) ?? []) {
        addOutcome(bucket, paper, 'paper');
        const mfe = num(paper, 'mfePctPeakTokenOnly') ?? num(paper, 'mfePct') ?? null;
        if (mfe != null) {
          const arr = mfeByArm.get(arm) ?? [];
          arr.push(mfe);
          mfeByArm.set(arm, arr);
        }
      }
      for (const live of liveByCandidate.get(candidateId) ?? []) {
        addOutcome(bucket, live, 'live');
      }
    }
    byArm.set(arm, bucket);
  }
  for (const [arm, values] of mfeByArm.entries()) {
    const bucket = byArm.get(arm);
    if (!bucket || values.length === 0) continue;
    bucket.paperAvgMfePct = values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  const verdict =
    equivalence.length === 0 && paperRows.length > 0
      ? 'INVESTIGATE'
      : equivalence.length === 0
        ? 'WATCH'
        : 'OK';

  const armRows = [...byArm.entries()]
    .sort((a, b) => b[1].rows - a[1].rows || a[0].localeCompare(b[0]));
  const lines = [
    `# KOL Live Equivalence Report`,
    '',
    `- verdict: ${verdict}`,
    `- generatedAt: ${new Date().toISOString()}`,
    `- since: ${new Date(args.sinceMs).toISOString()}`,
    `- equivalence rows: ${equivalence.length}`,
    `- paper closes with candidateId: ${paperRows.filter((row) => str(row, 'liveEquivalenceCandidateId')).length}`,
    `- live closes with candidateId: ${liveRows.filter((row) => str(row, 'liveEquivalenceCandidateId')).length}`,
    '',
    '## Decision Stages',
    '',
    '| stage | count |',
    '|---|---:|',
    ...countBy(equivalence, 'decisionStage').slice(0, 20).map(([key, count]) => `| ${key} | ${count} |`),
    '',
    '## Live Block Reasons',
    '',
    '| reason | count |',
    '|---|---:|',
    ...countBy(equivalence.filter((row) => !bool(row, 'liveWouldEnter')), 'liveBlockReason')
      .slice(0, 20)
      .map(([key, count]) => `| ${key} | ${count} |`),
    '',
    '## Arm Summary',
    '',
    '| arm | rows | liveWould | attempted | blocked | paper W/L | paper net | token-only net | avg MFE | live closes | live net |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...armRows.map(([arm, bucket]) => {
      const losses = bucket.paperCloses - bucket.paperWins;
      return `| ${arm} | ${bucket.rows} | ${bucket.liveWouldEnter} | ${bucket.liveAttempted} | ${bucket.blocked} | ${bucket.paperWins}/${losses} | ${sol(bucket.paperNetSol)} | ${sol(bucket.paperNetSolTokenOnly)} | ${pct(bucket.paperAvgMfePct)} | ${bucket.liveCloses} | ${sol(bucket.liveNetSol)} |`;
    }),
    '',
  ];

  return {
    md: lines.join('\n'),
    json: {
      verdict,
      generatedAt: new Date().toISOString(),
      since: new Date(args.sinceMs).toISOString(),
      equivalenceRows: equivalence.length,
      paperRowsWithCandidateId: paperRows.filter((row) => str(row, 'liveEquivalenceCandidateId')).length,
      liveRowsWithCandidateId: liveRows.filter((row) => str(row, 'liveEquivalenceCandidateId')).length,
      decisionStages: Object.fromEntries(countBy(equivalence, 'decisionStage')),
      liveBlockReasons: Object.fromEntries(countBy(equivalence.filter((row) => !bool(row, 'liveWouldEnter')), 'liveBlockReason')),
      arms: Object.fromEntries(armRows),
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildReport(args);
  if (args.md) {
    await mkdir(path.dirname(args.md), { recursive: true });
    await writeFile(args.md, report.md, 'utf8');
  }
  if (args.json) {
    await mkdir(path.dirname(args.json), { recursive: true });
    await writeFile(args.json, JSON.stringify(report.json, null, 2) + '\n', 'utf8');
  }
  if (!args.md && !args.json) {
    process.stdout.write(report.md + '\n');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export { buildReport, parseArgs };
