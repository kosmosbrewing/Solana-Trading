/* eslint-disable no-console */
/**
 * Parameter Change Log (MISSION_CONTROL §Control 5, 2026-04-25)
 *
 * Why: §Control 5 마지막 단락 — "Adaptive changes require a change log: change_id, changed_at,
 *      arm, hypothesis, old_value, new_value, reason, minimum_sample_before_next_change.
 *      Without this log, the result is an anecdote, not an experiment."
 *
 * 본 도구는 lane 파라미터를 바꿀 때마다 한 줄을 append-only JSONL 로 기록하고,
 * 이후 canary-eval / daily-review 가 같은 change_id 로 파라미터 분포를 분리해서 평가할 수 있게 한다.
 *
 * 파일: `data/kol/parameter-changes.jsonl` (KOL lane 변경) + `data/parameter-changes.jsonl` (전역).
 *
 * 사용 (record):
 *   npx ts-node scripts/parameter-change-log.ts record \
 *     --arm kol_hunter --param T1_MFE --old 0.50 --new 0.30 \
 *     --hypothesis "T1 +30% 로 낮추면 T1 visit 수 증가 + 5x+ 후보 sampling 확률 ↑" \
 *     --reason "3주 backtest 결과 6,275 entries 중 T1 visit 5건만 → threshold 너무 빡빡" \
 *     --min-sample 50
 *
 * 사용 (list):
 *   npx ts-node scripts/parameter-change-log.ts list [--arm kol_hunter] [--since 2026-04-25T00:00:00Z]
 *
 * 사용 (current — arm 별 현재 파라미터 view):
 *   npx ts-node scripts/parameter-change-log.ts current [--arm kol_hunter]
 */
import { appendFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

interface ChangeRecord {
  changeId: string;
  changedAt: string;
  arm: string;
  param: string;
  oldValue: string | number | null;
  newValue: string | number | null;
  hypothesis: string;
  reason: string;
  minimumSampleBeforeNextChange: number;
  parameterVersion?: string;
  authorTag?: string;
}

const DEFAULT_LOG_FILE = 'data/parameter-changes.jsonl';
const KOL_LOG_FILE = 'data/kol/parameter-changes.jsonl';

function logFileForArm(arm: string): string {
  return arm.startsWith('kol_') ? KOL_LOG_FILE : DEFAULT_LOG_FILE;
}

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function requireArg(args: string[], flag: string, label: string): string {
  const value = getArg(args, flag);
  if (value === undefined || value === '') {
    throw new Error(`Missing required arg: ${flag} (${label})`);
  }
  return value;
}

function parseValue(raw: string | undefined): string | number | null {
  if (raw === undefined) return null;
  const num = Number(raw);
  return Number.isFinite(num) && raw.trim() !== '' && !isNaN(num) ? num : raw;
}

async function recordChange(args: string[]): Promise<void> {
  const arm = requireArg(args, '--arm', 'lane / strategy id');
  const param = requireArg(args, '--param', 'parameter name');
  const oldRaw = getArg(args, '--old');
  const newRaw = requireArg(args, '--new', 'new value');
  const hypothesis = requireArg(args, '--hypothesis', 'hypothesis text');
  const reason = requireArg(args, '--reason', 'reason text');
  const minSampleRaw = getArg(args, '--min-sample');
  const parameterVersion = getArg(args, '--version');
  const authorTag = getArg(args, '--author');

  const record: ChangeRecord = {
    changeId: `chg-${Date.now()}-${randomBytes(4).toString('hex')}`,
    changedAt: new Date().toISOString(),
    arm,
    param,
    oldValue: parseValue(oldRaw),
    newValue: parseValue(newRaw),
    hypothesis,
    reason,
    minimumSampleBeforeNextChange: minSampleRaw ? Number(minSampleRaw) : 50,
    parameterVersion,
    authorTag,
  };

  const file = path.resolve(logFileForArm(arm));
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(record) + '\n', 'utf8');
  console.log(`[parameter-change-log] recorded ${record.changeId} → ${file}`);
  console.log(JSON.stringify(record, null, 2));
}

async function readChanges(file: string): Promise<ChangeRecord[]> {
  if (!existsSync(file)) return [];
  const raw = await readFile(file, 'utf8');
  const records: ChangeRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      console.warn(`[parameter-change-log] skip malformed line: ${line.slice(0, 80)}`);
    }
  }
  return records;
}

async function listChanges(args: string[]): Promise<void> {
  const armFilter = getArg(args, '--arm');
  const sinceRaw = getArg(args, '--since');
  const since = sinceRaw ? new Date(sinceRaw) : null;

  const files = armFilter
    ? [logFileForArm(armFilter)]
    : [DEFAULT_LOG_FILE, KOL_LOG_FILE];

  const all: ChangeRecord[] = [];
  for (const file of files) {
    const records = await readChanges(path.resolve(file));
    all.push(...records);
  }

  const filtered = all
    .filter((r) => !armFilter || r.arm === armFilter)
    .filter((r) => !since || new Date(r.changedAt) >= since)
    .sort((a, b) => a.changedAt.localeCompare(b.changedAt));

  if (filtered.length === 0) {
    console.log('(no changes recorded)');
    return;
  }

  for (const r of filtered) {
    console.log(`[${r.changeId}] ${r.changedAt} arm=${r.arm} param=${r.param}`);
    console.log(`  ${String(r.oldValue)} → ${String(r.newValue)}`);
    console.log(`  hypothesis: ${r.hypothesis}`);
    console.log(`  reason: ${r.reason}`);
    console.log(`  min_sample: ${r.minimumSampleBeforeNextChange}`);
    if (r.parameterVersion) console.log(`  version: ${r.parameterVersion}`);
    if (r.authorTag) console.log(`  author: ${r.authorTag}`);
    console.log('');
  }
}

async function currentState(args: string[]): Promise<void> {
  const armFilter = getArg(args, '--arm');
  const files = armFilter
    ? [logFileForArm(armFilter)]
    : [DEFAULT_LOG_FILE, KOL_LOG_FILE];

  const all: ChangeRecord[] = [];
  for (const file of files) {
    all.push(...(await readChanges(path.resolve(file))));
  }
  const filtered = all.filter((r) => !armFilter || r.arm === armFilter);
  // Last value per (arm, param)
  const latest = new Map<string, ChangeRecord>();
  for (const r of filtered.sort((a, b) => a.changedAt.localeCompare(b.changedAt))) {
    latest.set(`${r.arm}:${r.param}`, r);
  }
  if (latest.size === 0) {
    console.log('(no parameter state)');
    return;
  }
  console.log('arm\tparam\tcurrent\tchanged_at\tchange_id');
  for (const r of latest.values()) {
    console.log(`${r.arm}\t${r.param}\t${String(r.newValue)}\t${r.changedAt}\t${r.changeId}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'record':
      await recordChange(rest);
      break;
    case 'list':
      await listChanges(rest);
      break;
    case 'current':
      await currentState(rest);
      break;
    default:
      console.error('Usage:');
      console.error('  parameter-change-log.ts record --arm <arm> --param <name> --old <v> --new <v> --hypothesis "..." --reason "..." [--min-sample 50]');
      console.error('  parameter-change-log.ts list [--arm <arm>] [--since <iso>]');
      console.error('  parameter-change-log.ts current [--arm <arm>]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
