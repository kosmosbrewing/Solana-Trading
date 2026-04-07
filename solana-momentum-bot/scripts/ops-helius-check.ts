import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

type JsonObject = Record<string, unknown>;

interface CurrentSessionPointer {
  datasetDir?: string;
  startedAt?: string;
  tradingMode?: string;
}

interface AdmissionEntry {
  pool: string;
  observedNotifications: number;
  logParsed: number;
  fallbackParsed?: number;
  fallbackSkipped: number;
  blocked: boolean;
}

interface RuntimeDiagnosticEvent {
  type?: string;
  reason?: string;
  timestampMs?: number;
}

interface Args {
  hours: number;
  lines: number;
  processName: string;
}

interface AdmissionSummary {
  updatedAt?: string;
  poolCount: number;
  totals: {
    observed: number;
    logParsed: number;
    fallbackParsed: number;
    fallbackSkipped: number;
    blocked: number;
    parseRatePct: number;
    skippedRatePct: number;
  };
}

interface RuntimeSummary {
  latestTs: number;
  cutoffTs: number;
  interestingCounts: Map<string, number>;
}

interface Pm2Summary {
  counts: Record<string, number>;
  interestingLines: string[];
}

const ROOT = process.cwd();
const REALTIME_DIR = path.join(ROOT, 'data', 'realtime');
const CURRENT_SESSION_PATH = path.join(REALTIME_DIR, 'current-session.json');
const ADMISSION_PATH = path.join(ROOT, 'data', 'realtime-admission.json');
const RUNTIME_DIAGNOSTICS_PATH = path.join(REALTIME_DIR, 'runtime-diagnostics.json');
const ENV_PATH = path.join(ROOT, '.env');

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  printHeader('Helius Ops Check');
  printEnvSummary();
  printCurrentSession();
  const admission = printRealtimeAdmission();
  const runtime = printRuntimeDiagnostics(args.hours);
  const pm2 = printPm2LogSummary(args.processName, args.lines);
  printVerdict(admission, runtime, pm2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    hours: 2,
    lines: 4000,
    processName: 'momentum-bot',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if ((token === '--hours' || token === '-h') && next) {
      args.hours = Math.max(1, Number(next) || args.hours);
      index += 1;
      continue;
    }
    if ((token === '--lines' || token === '-l') && next) {
      args.lines = Math.max(100, Number(next) || args.lines);
      index += 1;
      continue;
    }
    if ((token === '--process' || token === '-p') && next) {
      args.processName = next;
      index += 1;
      continue;
    }
    if (token === '--help') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(
    [
      'Usage: ts-node scripts/ops-helius-check.ts [options]',
      '',
      'Options:',
      '  --hours, -h <n>     Runtime diagnostics window hours (default: 2)',
      '  --lines, -l <n>     PM2 log lines to scan (default: 4000)',
      '  --process, -p <id>  PM2 process name (default: momentum-bot)',
    ].join('\n')
  );
}

function printHeader(title: string): void {
  console.log(title);
  console.log('='.repeat(72));
}

function printSection(title: string): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(72));
}

function printEnvSummary(): void {
  printSection('1. Current Env');
  const env = readSimpleEnv(ENV_PATH);
  const keys = [
    'REALTIME_FALLBACK_CONCURRENCY',
    'REALTIME_FALLBACK_RPS',
    'REALTIME_FALLBACK_BATCH_SIZE',
    'REALTIME_SEED_BACKFILL_ENABLED',
    'REALTIME_DISABLE_SINGLE_TX_FALLBACK_ON_BATCH_UNSUPPORTED',
    'REALTIME_SEED_ALLOW_SINGLE_TX_FALLBACK',
    'REALTIME_MAX_SUBSCRIPTIONS',
    'REALTIME_TRIGGER_MODE',
  ];

  for (const key of keys) {
    console.log(`${key}=${env[key] ?? '(missing)'}`);
  }
}

function printCurrentSession(): void {
  printSection('2. Current Session');
  const pointer = readJson<CurrentSessionPointer>(CURRENT_SESSION_PATH);
  if (!pointer) {
    console.log(`missing: ${CURRENT_SESSION_PATH}`);
    return;
  }

  console.log(`startedAt=${pointer.startedAt ?? '(missing)'}`);
  console.log(`tradingMode=${pointer.tradingMode ?? '(missing)'}`);
  console.log(`datasetDir=${pointer.datasetDir ?? '(missing)'}`);
}

function printRealtimeAdmission(): AdmissionSummary | null {
  printSection('3. Realtime Admission Snapshot');
  const payload = readJson<{ updatedAt?: string; entries?: AdmissionEntry[] }>(ADMISSION_PATH);
  if (!payload || !Array.isArray(payload.entries)) {
    console.log(`missing: ${ADMISSION_PATH}`);
    return null;
  }

  const entries = payload.entries.map((entry) => {
    const observed = entry.observedNotifications ?? 0;
    const logParsed = entry.logParsed ?? 0;
    const fallbackParsed = entry.fallbackParsed ?? 0;
    const fallbackSkipped = entry.fallbackSkipped ?? 0;
    const parseRatePct = observed > 0 ? ((logParsed + fallbackParsed) / observed) * 100 : 0;
    const skippedRatePct = observed > 0 ? (fallbackSkipped / observed) * 100 : 0;
    return {
      pool: entry.pool,
      observed,
      logParsed,
      fallbackParsed,
      fallbackSkipped,
      blocked: entry.blocked ?? false,
      parseRatePct: round(parseRatePct),
      skippedRatePct: round(skippedRatePct),
    };
  }).sort((left, right) => right.observed - left.observed);

  const totals = entries.reduce((acc, entry) => {
    acc.observed += entry.observed;
    acc.logParsed += entry.logParsed;
    acc.fallbackParsed += entry.fallbackParsed;
    acc.fallbackSkipped += entry.fallbackSkipped;
    acc.blocked += entry.blocked ? 1 : 0;
    return acc;
  }, {
    observed: 0,
    logParsed: 0,
    fallbackParsed: 0,
    fallbackSkipped: 0,
    blocked: 0,
  });

  console.log(`updatedAt=${payload.updatedAt ?? '(missing)'}`);
  console.log(`pools=${entries.length}`);
  console.log(
    `totals observed=${totals.observed} logParsed=${totals.logParsed} ` +
    `fallbackParsed=${totals.fallbackParsed} fallbackSkipped=${totals.fallbackSkipped} blocked=${totals.blocked}`
  );
  console.log(
    `totals parseRatePct=${totals.observed > 0 ? round(((totals.logParsed + totals.fallbackParsed) / totals.observed) * 100) : 0} ` +
    `skippedRatePct=${totals.observed > 0 ? round((totals.fallbackSkipped / totals.observed) * 100) : 0}`
  );

  const top = entries.slice(0, 10);
  if (top.length === 0) {
    console.log('top10=(empty)');
    return {
      updatedAt: payload.updatedAt,
      poolCount: entries.length,
      totals: {
        ...totals,
        parseRatePct: totals.observed > 0 ? round(((totals.logParsed + totals.fallbackParsed) / totals.observed) * 100) : 0,
        skippedRatePct: totals.observed > 0 ? round((totals.fallbackSkipped / totals.observed) * 100) : 0,
      },
    };
  }

  for (const entry of top) {
    console.log(
      `${shortAddress(entry.pool)} observed=${entry.observed} parseRate=${entry.parseRatePct}% ` +
      `fallbackParsed=${entry.fallbackParsed} fallbackSkipped=${entry.fallbackSkipped} blocked=${entry.blocked}`
    );
  }

  return {
    updatedAt: payload.updatedAt,
    poolCount: entries.length,
    totals: {
      ...totals,
      parseRatePct: totals.observed > 0 ? round(((totals.logParsed + totals.fallbackParsed) / totals.observed) * 100) : 0,
      skippedRatePct: totals.observed > 0 ? round((totals.fallbackSkipped / totals.observed) * 100) : 0,
    },
  };
}

function printRuntimeDiagnostics(hours: number): RuntimeSummary | null {
  printSection(`4. Runtime Diagnostics Last ${hours}h`);
  const payload = readJson<{ events?: RuntimeDiagnosticEvent[] }>(RUNTIME_DIAGNOSTICS_PATH);
  if (!payload || !Array.isArray(payload.events)) {
    console.log(`missing: ${RUNTIME_DIAGNOSTICS_PATH}`);
    return null;
  }

  const events = payload.events.filter((event) => typeof event.timestampMs === 'number');
  const latestTs = events.reduce((max, event) => Math.max(max, event.timestampMs || 0), 0);
  const cutoffTs = latestTs - (hours * 60 * 60 * 1000);
  const recent = events.filter((event) => (event.timestampMs || 0) >= cutoffTs);

  const counts = new Map<string, number>();
  for (const event of recent) {
    const label = `${event.type ?? 'unknown'}${event.reason ? `:${event.reason}` : ''}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  console.log(`latestTs=${new Date(latestTs).toISOString()}`);
  console.log(`cutoffTs=${new Date(cutoffTs).toISOString()}`);

  const interesting = [...counts.entries()]
    .filter(([label]) => /rate_limit|capacity|candidate|risk_rejection|admission_skip|alias_miss|pre_watchlist_reject|trigger_stats/.test(label))
    .sort(([left], [right]) => left.localeCompare(right));

  if (interesting.length === 0) {
    console.log('interestingCounts=(empty)');
    return {
      latestTs,
      cutoffTs,
      interestingCounts: new Map<string, number>(),
    };
  }

  for (const [label, count] of interesting) {
    console.log(`${label}=${count}`);
  }

  return {
    latestTs,
    cutoffTs,
    interestingCounts: new Map<string, number>(interesting),
  };
}

function printPm2LogSummary(processName: string, lines: number): Pm2Summary | null {
  printSection('5. PM2 Log Summary');
  const logOutput = readPm2Logs(processName, lines);
  if (logOutput == null) {
    console.log(`pm2 logs unavailable for process=${processName}`);
    return null;
  }

  const patterns: Array<[string, RegExp]> = [
    ['helius_ws_active', /Helius WS subscriptions active/g],
    ['ws_silent', /WS silent/g],
    ['fallback_batch_failed', /Swap fallback batch failed/g],
    ['realtime_admission_blocked', /Realtime admission blocked/g],
    ['pool_discovered', /Helius pool discovered/g],
    ['rate_limited', /429|rate limited/g],
    ['fallback_word', /fallback/g],
    ['helius_ws_429', /Helius WS error .*429/g],
    ['fallback_batch_429', /Swap fallback batch failed: .*429/g],
    ['batch_unsupported', /Parsed transaction batch RPC unavailable/g],
  ];

  const counts: Record<string, number> = {};
  for (const [label, pattern] of patterns) {
    counts[label] = countMatches(logOutput, pattern);
    console.log(`${label}=${counts[label]}`);
  }

  console.log('fallbackSkippedReasonBreakdown=unavailable_from_current_artifacts');

  console.log('\nrecentInterestingLines=');
  const interestingLines = logOutput
    .split('\n')
    .filter((line) =>
      /Helius WS subscriptions active|WS silent|Swap fallback batch failed|Realtime admission blocked|Helius pool discovered|429|rate limited|fallback|Parsed transaction batch RPC unavailable/.test(line)
    )
    .slice(-30);

  if (interestingLines.length === 0) {
    console.log('(empty)');
    return { counts, interestingLines: [] };
  }

  for (const line of interestingLines) {
    console.log(line);
  }

  return { counts, interestingLines };
}

function printVerdict(
  admission: AdmissionSummary | null,
  runtime: RuntimeSummary | null,
  pm2: Pm2Summary | null
): void {
  printSection('6. Verdict');

  if (!admission) {
    console.log('verdict=insufficient_data');
    console.log('reason=missing realtime-admission snapshot');
    return;
  }

  const unsupportedDex = runtime?.interestingCounts.get('admission_skip:unsupported_dex') ?? 0;
  const noPairs = runtime?.interestingCounts.get('admission_skip:no_pairs') ?? 0;
  const idleEvicted = runtime?.interestingCounts.get('candidate_evicted:idle') ?? 0;
  const riskRejections = [...(runtime?.interestingCounts.entries() ?? [])]
    .filter(([label]) => label.startsWith('risk_rejection:'))
    .reduce((sum, [, count]) => sum + count, 0);

  const helius429 = (pm2?.counts.helius_ws_429 ?? 0) + (pm2?.counts.fallback_batch_429 ?? 0);
  const fallbackFailures = pm2?.counts.fallback_batch_failed ?? 0;
  const admissionBlocked = pm2?.counts.realtime_admission_blocked ?? 0;

  const parseRatePct = admission.totals.parseRatePct;
  const skippedRatePct = admission.totals.skippedRatePct;

  const primaryBottleneck =
    unsupportedDex + noPairs + idleEvicted + riskRejections > Math.max(10, helius429 + fallbackFailures + admissionBlocked)
      ? 'non_fallback_bottlenecks_dominate'
      : 'fallback_pressure_possible';

  let recommendation = 'hold_rps_and_investigate';
  if (
    parseRatePct < 5 &&
    skippedRatePct > 50 &&
    (helius429 >= 20 || fallbackFailures >= 10 || admissionBlocked >= 5) &&
    primaryBottleneck === 'fallback_pressure_possible'
  ) {
    recommendation = '2tps_canary_reasonable';
  }

  console.log(`primaryBottleneck=${primaryBottleneck}`);
  console.log(`parseRatePct=${parseRatePct}`);
  console.log(`skippedRatePct=${skippedRatePct}`);
  console.log(`helius429Signals=${helius429}`);
  console.log(`fallbackFailures=${fallbackFailures}`);
  console.log(`admissionBlocked=${admissionBlocked}`);
  console.log(`unsupportedDexSkips=${unsupportedDex}`);
  console.log(`noPairsSkips=${noPairs}`);
  console.log(`idleEvicted=${idleEvicted}`);
  console.log(`riskRejections=${riskRejections}`);
  console.log(`recommendation=${recommendation}`);

  if (recommendation === '2tps_canary_reasonable') {
    console.log('nextStep=raise REALTIME_FALLBACK_RPS from 1 to 2 for a short canary and re-run this script');
    return;
  }

  console.log('nextStep=do not change RPS first; inspect unsupported_dex / idle churn / risk rejection / price-path integrity first');
}

function readPm2Logs(processName: string, lines: number): string | null {
  try {
    return execFileSync(
      'pm2',
      ['logs', processName, '--lines', String(lines), '--nostream'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (error) {
    const pm2Error = error as { stdout?: unknown; stderr?: unknown } | undefined;
    const stdout = String(pm2Error?.stdout ?? '');
    const stderr = String(pm2Error?.stderr ?? '');
    const combined = `${stdout}\n${stderr}`.trim();
    return combined.length > 0 ? combined : null;
  }
}

function readSimpleEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    out[key] = value;
  }
  return out;
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function shortAddress(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function countMatches(input: string, pattern: RegExp): number {
  return (input.match(pattern) || []).length;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

main();
