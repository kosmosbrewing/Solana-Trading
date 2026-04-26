#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';

interface AutoBacktestProfileSummary {
  profile: {
    name: string;
    tag: string;
  };
  aggregate: {
    totalTrades: number;
    avgPF: number;
    avgWR: number;
    avgExpectancyR: number;
    totalPnlPct: number;
    maxDD: number;
    positivePoolRatio: number;
    edgeScore: number;
    stageScore: number;
    stageDecision: string;
    edgeGateStatus: string;
    edgeGateReasons: string[];
  };
}

interface AutoBacktestSummaryFile {
  generatedAt: string;
  mode: string;
  sweep: boolean;
  requestedProfile: string;
  requestedTop: number;
  input: {
    manualPool: string | null;
    poolFile: string | null;
    csvDir: string;
    minTvl: number;
    minVol: number;
    minAge: number;
    days: number;
    balance: number;
    totalPools: number;
  };
  profiles: AutoBacktestProfileSummary[];
}

interface FlattenedProfileRow {
  file: string;
  generatedAt: string;
  mode: string;
  totalPools: number;
  profileName: string;
  profileTag: string;
  totalTrades: number;
  avgPF: number;
  avgWR: number;
  avgExpectancyR: number;
  totalPnlPct: number;
  maxDD: number;
  positivePoolRatio: number;
  edgeScore: number;
  stageScore: number;
  stageDecision: string;
  edgeGateStatus: string;
  edgeGateReasons: string[];
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const dir = path.resolve(getArg(args, '--dir') || path.resolve(__dirname, '../results'));
  const latest = numArg(args, '--latest', 10);
  const profileFilter = getArg(args, '--profile');
  const json = args.includes('--json');

  const summaries = loadSummaries(dir);
  const rows = summaries
    .flatMap(summary => summary.profiles.map(profile => flattenProfile(summary, profile)))
    .filter(row => !profileFilter || row.profileTag === profileFilter || row.profileName === profileFilter);

  if (json) {
    console.log(JSON.stringify({ dir, fileCount: summaries.length, rows }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`No auto-backtest summaries found in ${dir}`);
    return;
  }

  const latestRows = [...rows]
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    .slice(0, latest);

  printLatestRuns(latestRows, dir);
  printProfileLeaderboard(latestRows);
  printProfileTrends(rows);
  printRecommendation(rows);
}

function loadSummaries(dir: string): AutoBacktestSummaryFile[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .filter(file => /^auto-backtest-.*\.json$/.test(file))
    .sort()
    .map(file => {
      const filePath = path.join(dir, file);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AutoBacktestSummaryFile;
      return {
        ...parsed,
        profiles: parsed.profiles.map(profile => ({
          ...profile,
          profile: { ...profile.profile, name: profile.profile.name || file, tag: profile.profile.tag || '?' },
        })),
      };
    });
}

function flattenProfile(
  summary: AutoBacktestSummaryFile,
  profile: AutoBacktestProfileSummary
): FlattenedProfileRow {
  return {
    file: `${summary.requestedProfile}@${summary.generatedAt}`,
    generatedAt: summary.generatedAt,
    mode: summary.mode,
    totalPools: summary.input.totalPools,
    profileName: profile.profile.name,
    profileTag: profile.profile.tag,
    totalTrades: profile.aggregate.totalTrades,
    avgPF: profile.aggregate.avgPF,
    avgWR: profile.aggregate.avgWR,
    avgExpectancyR: profile.aggregate.avgExpectancyR,
    totalPnlPct: profile.aggregate.totalPnlPct,
    maxDD: profile.aggregate.maxDD,
    positivePoolRatio: profile.aggregate.positivePoolRatio,
    edgeScore: profile.aggregate.edgeScore,
    stageScore: profile.aggregate.stageScore,
    stageDecision: profile.aggregate.stageDecision,
    edgeGateStatus: profile.aggregate.edgeGateStatus,
    edgeGateReasons: profile.aggregate.edgeGateReasons,
  };
}

function printLatestRuns(rows: FlattenedProfileRow[], dir: string): void {
  console.log(`\nAuto-Backtest Report`);
  console.log(`Dir: ${dir}`);
  console.log(`Rows: ${rows.length}`);
  console.log('='.repeat(128));
  console.log([
    pad('When', 17),
    pad('Profile', 20),
    pad('Pools', 6),
    pad('Trades', 8),
    pad('AvgPF', 8),
    pad('ExpR', 8),
    pad('PnL%', 8),
    pad('Edge', 7),
    pad('Decision', 13),
    pad('Gate', 7),
  ].join(' '));
  console.log('-'.repeat(128));

  for (const row of rows) {
    console.log([
      pad(shortTime(row.generatedAt), 17),
      pad(row.profileName, 20),
      pad(String(row.totalPools), 6),
      pad(String(row.totalTrades), 8),
      pad(row.avgPF.toFixed(2), 8),
      pad(row.avgExpectancyR.toFixed(2), 8),
      pad(formatPct(row.totalPnlPct), 8),
      pad(row.edgeScore.toFixed(1), 7),
      pad(row.stageDecision, 13),
      pad(row.edgeGateStatus, 7),
    ].join(' '));
  }
}

function printProfileLeaderboard(rows: FlattenedProfileRow[]): void {
  const latestByProfile = new Map<string, FlattenedProfileRow>();

  for (const row of [...rows].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))) {
    if (!latestByProfile.has(row.profileTag)) {
      latestByProfile.set(row.profileTag, row);
    }
  }

  const ranked = [...latestByProfile.values()].sort((a, b) => {
    if (b.edgeScore !== a.edgeScore) return b.edgeScore - a.edgeScore;
    if (b.avgPF !== a.avgPF) return b.avgPF - a.avgPF;
    return b.totalPnlPct - a.totalPnlPct;
  });

  console.log(`\nLatest Profile Leaderboard`);
  console.log('='.repeat(96));
  console.log([
    pad('#', 4),
    pad('Profile', 20),
    pad('Edge', 7),
    pad('Stage', 7),
    pad('Decision', 13),
    pad('AvgPF', 8),
    pad('ExpR', 8),
    pad('PnL%', 8),
    pad('+Pool', 8),
  ].join(' '));
  console.log('-'.repeat(96));

  for (let i = 0; i < ranked.length; i++) {
    const row = ranked[i];
    console.log([
      pad(`#${i + 1}`, 4),
      pad(row.profileName, 20),
      pad(row.edgeScore.toFixed(1), 7),
      pad(row.stageScore.toFixed(1), 7),
      pad(row.stageDecision, 13),
      pad(row.avgPF.toFixed(2), 8),
      pad(row.avgExpectancyR.toFixed(2), 8),
      pad(formatPct(row.totalPnlPct), 8),
      pad(formatPct(row.positivePoolRatio), 8),
    ].join(' '));
  }
}

function printProfileTrends(rows: FlattenedProfileRow[]): void {
  const grouped = groupByProfile(rows);
  const trends = [...grouped.entries()]
    .map(([_, profileRows]) => {
      const sorted = [...profileRows].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
      return {
        latest: sorted[0],
        previous: sorted[1],
      };
    })
    .filter(item => item.previous);

  if (trends.length === 0) {
    return;
  }

  console.log(`\nProfile Trends`);
  console.log('='.repeat(104));
  console.log([
    pad('Profile', 20),
    pad('Latest', 17),
    pad('Prev', 17),
    pad('dEdge', 8),
    pad('dPnL%', 8),
    pad('dExpR', 8),
    pad('Decision', 13),
  ].join(' '));
  console.log('-'.repeat(104));

  for (const { latest, previous } of trends) {
    console.log([
      pad(latest.profileName, 20),
      pad(shortTime(latest.generatedAt), 17),
      pad(shortTime(previous.generatedAt), 17),
      pad(signed(latest.edgeScore - previous.edgeScore, 1), 8),
      pad(signedPct(latest.totalPnlPct - previous.totalPnlPct), 8),
      pad(signed(latest.avgExpectancyR - previous.avgExpectancyR, 2), 8),
      pad(latest.stageDecision, 13),
    ].join(' '));
  }
}

function printRecommendation(rows: FlattenedProfileRow[]): void {
  const latestByProfile = [...groupByProfile(rows).values()]
    .map(profileRows => [...profileRows].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0])
    .sort((a, b) => {
      if (b.edgeScore !== a.edgeScore) return b.edgeScore - a.edgeScore;
      if (b.avgPF !== a.avgPF) return b.avgPF - a.avgPF;
      return b.totalPnlPct - a.totalPnlPct;
    });

  if (latestByProfile.length === 0) {
    return;
  }

  const best = latestByProfile[0];
  const risks = latestByProfile.filter(row =>
    row.edgeGateStatus !== 'pass' || row.stageDecision === 'reject' || row.stageDecision === 'reject_gate'
  );

  console.log(`\nRecommendation`);
  console.log('='.repeat(96));
  console.log(
    `Best latest profile: ${best.profileName} | Edge ${best.edgeScore.toFixed(1)} | ` +
    `PF ${best.avgPF.toFixed(2)} | ExpR ${best.avgExpectancyR.toFixed(2)} | ` +
    `${best.stageDecision}`
  );

  if (risks.length === 0) {
    console.log('Risk summary: no immediate gate failures in latest profile snapshots.');
    return;
  }

  console.log('Risk summary:');
  for (const risk of risks) {
    const reasons = risk.edgeGateReasons.length > 0 ? ` (${risk.edgeGateReasons.join(', ')})` : '';
    console.log(
      `- ${risk.profileName}: ${risk.stageDecision} | gate ${risk.edgeGateStatus}${reasons}`
    );
  }
}

function groupByProfile(rows: FlattenedProfileRow[]): Map<string, FlattenedProfileRow[]> {
  const grouped = new Map<string, FlattenedProfileRow[]>();
  for (const row of rows) {
    const key = row.profileTag || row.profileName;
    const current = grouped.get(key) || [];
    current.push(row);
    grouped.set(key, current);
  }
  return grouped;
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function numArg(args: string[], flag: string, fallback: number): number {
  const raw = getArg(args, flag);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    console.error(`Invalid number for ${flag}: "${raw}"`);
    process.exit(1);
  }
  return parsed;
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function signedPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function shortTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

function pad(value: string, len: number): string {
  return value.length >= len ? value.slice(0, len) : value.padEnd(len);
}

function printHelp(): void {
  console.log(`
Usage:
  npx ts-node scripts/auto-backtest-report.ts [options]

Options:
  --dir <path>        summary JSON directory (default: ./results)
  --latest <n>        number of latest rows to print (default: 10)
  --profile <name>    filter by profile tag or name
  --json              print raw machine-readable rows
  `);
}

main();
