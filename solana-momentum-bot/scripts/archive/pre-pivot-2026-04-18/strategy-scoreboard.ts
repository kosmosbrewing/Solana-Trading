#!/usr/bin/env ts-node

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { Notifier } from '../src/notifier/notifier';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface SweepTopResult {
  rank: number;
  params: Record<string, number>;
  avgSharpe: number;
  avgPnlPct: number;
  avgWinRate: number;
  avgPF: number;
  avgMaxDD: number;
  avgExpectancyR: number;
  edgeScore: number;
  stageScore: number;
  stageDecision: string;
  edgeGateStatus: string;
  edgeGateReasons: string[];
  totalTrades: number;
  positiveTokens: number;
  totalTokens: number;
  positiveRatio: number;
}

interface SweepFile {
  strategy: string;
  objective: string;
  tokenCount: number;
  elapsedSec: number;
  topResults: SweepTopResult[];
}

interface AutoProfileRow {
  generatedAt: string;
  profileName: string;
  profileTag: string;
  totalTrades: number;
  avgPF: number;
  avgExpectancyR: number;
  totalPnlPct: number;
  edgeScore: number;
  stageScore: number;
  stageDecision: string;
  edgeGateStatus: string;
  edgeGateReasons: string[];
}

interface ScoreboardPairing {
  strategy: string;
  strategyDecision: string;
  strategyEdge: number;
  profileName: string;
  profileDecision: string;
  profileEdge: number;
  pairingScore: number;
  status: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const sweepDir = path.resolve(getArg(args, '--sweep-dir') || path.resolve(__dirname, '../results'));
  const autoDir = path.resolve(getArg(args, '--auto-dir') || path.resolve(__dirname, '../results'));
  const top = numArg(args, '--top', 5);
  const json = args.includes('--json');
  const telegram = args.includes('--telegram');

  const latestSweeps = loadLatestSweepResults(sweepDir);
  const latestProfiles = loadLatestAutoProfiles(autoDir);
  const pairings = buildPairings(latestSweeps, latestProfiles)
    .sort((a, b) => b.pairingScore - a.pairingScore)
    .slice(0, top);

  if (json) {
    console.log(JSON.stringify({
      sweepDir,
      autoDir,
      latestSweeps,
      latestProfiles,
      pairings,
    }, null, 2));
    return;
  }

  printStrategyTable(latestSweeps, sweepDir);
  printProfileTable(latestProfiles, autoDir);
  printPairings(pairings);

  if (telegram) {
    await sendTelegramDigest(latestSweeps, latestProfiles, pairings);
  }
}

function loadLatestSweepResults(dir: string): Array<{
  file: string;
  generatedAt: string;
  strategy: string;
  objective: string;
  top: SweepTopResult;
}> {
  if (!fs.existsSync(dir)) return [];

  const grouped = new Map<string, { file: string; generatedAt: string; parsed: SweepFile }>();

  for (const file of fs.readdirSync(dir).filter(name => /^multi-sweep-.*\.json$/.test(name))) {
    const filePath = path.join(dir, file);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SweepFile;
    if (!parsed.topResults || parsed.topResults.length === 0) continue;
    const generatedAt = extractTimestamp(file);
    const current = grouped.get(parsed.strategy);
    if (!current || generatedAt > current.generatedAt) {
      grouped.set(parsed.strategy, { file, generatedAt, parsed });
    }
  }

  return [...grouped.values()]
    .map(item => ({
      file: item.file,
      generatedAt: item.generatedAt,
      strategy: item.parsed.strategy,
      objective: item.parsed.objective,
      top: item.parsed.topResults[0],
    }))
    .sort((a, b) => b.top.edgeScore - a.top.edgeScore);
}

function loadLatestAutoProfiles(dir: string): AutoProfileRow[] {
  if (!fs.existsSync(dir)) return [];

  const latestByTag = new Map<string, AutoProfileRow>();

  for (const file of fs.readdirSync(dir).filter(name => /^auto-backtest-.*\.json$/.test(name))) {
    const filePath = path.join(dir, file);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as any;
    const generatedAt = parsed.generatedAt || extractTimestamp(file);
    for (const profile of parsed.profiles || []) {
      const row: AutoProfileRow = {
        generatedAt,
        profileName: profile.profile.name,
        profileTag: profile.profile.tag,
        totalTrades: profile.aggregate.totalTrades,
        avgPF: profile.aggregate.avgPF,
        avgExpectancyR: profile.aggregate.avgExpectancyR,
        totalPnlPct: profile.aggregate.totalPnlPct,
        edgeScore: profile.aggregate.edgeScore,
        stageScore: profile.aggregate.stageScore,
        stageDecision: profile.aggregate.stageDecision,
        edgeGateStatus: profile.aggregate.edgeGateStatus,
        edgeGateReasons: profile.aggregate.edgeGateReasons,
      };
      const current = latestByTag.get(row.profileTag);
      if (!current || row.generatedAt > current.generatedAt) {
        latestByTag.set(row.profileTag, row);
      }
    }
  }

  return [...latestByTag.values()].sort((a, b) => b.edgeScore - a.edgeScore);
}

function buildPairings(
  sweeps: Array<{ strategy: string; top: SweepTopResult }>,
  profiles: AutoProfileRow[]
): ScoreboardPairing[] {
  const pairings: ScoreboardPairing[] = [];

  for (const sweep of sweeps) {
    for (const profile of profiles) {
      const pairingScore = (sweep.top.edgeScore * 0.6) + (profile.edgeScore * 0.4);
      pairings.push({
        strategy: sweep.strategy,
        strategyDecision: sweep.top.stageDecision,
        strategyEdge: sweep.top.edgeScore,
        profileName: profile.profileName,
        profileDecision: profile.stageDecision,
        profileEdge: profile.edgeScore,
        pairingScore,
        status: derivePairingStatus(sweep.top.stageDecision, profile.stageDecision, sweep.top.edgeGateStatus, profile.edgeGateStatus),
      });
    }
  }

  return pairings;
}

function derivePairingStatus(
  strategyDecision: string,
  profileDecision: string,
  strategyGate: string,
  profileGate: string
): string {
  if (strategyGate !== 'pass' || profileGate !== 'pass') return 'blocked';
  if (strategyDecision === 'keep' && profileDecision === 'keep') return 'deploy';
  if (strategyDecision === 'keep' || profileDecision === 'keep') return 'watch';
  return 'retune';
}

function printStrategyTable(
  sweeps: Array<{ file: string; generatedAt: string; strategy: string; objective: string; top: SweepTopResult }>,
  dir: string
): void {
  console.log(`\nStrategy Scoreboard`);
  console.log(`Sweep dir: ${dir}`);
  console.log('='.repeat(118));
  console.log([
    pad('Strategy', 16),
    pad('When', 17),
    pad('Edge', 7),
    pad('Decision', 13),
    pad('PF', 8),
    pad('ExpR', 8),
    pad('PnL%', 8),
    pad('Trades', 8),
    pad('+Token', 8),
  ].join(' '));
  console.log('-'.repeat(118));

  for (const sweep of sweeps) {
    console.log([
      pad(sweep.strategy, 16),
      pad(shortTime(sweep.generatedAt), 17),
      pad(sweep.top.edgeScore.toFixed(1), 7),
      pad(sweep.top.stageDecision, 13),
      pad(sweep.top.avgPF.toFixed(2), 8),
      pad(sweep.top.avgExpectancyR.toFixed(2), 8),
      pad(formatPct(sweep.top.avgPnlPct), 8),
      pad(String(sweep.top.totalTrades), 8),
      pad(formatPct(sweep.top.positiveRatio), 8),
    ].join(' '));
  }
}

function printProfileTable(profiles: AutoProfileRow[], dir: string): void {
  console.log(`\nProfile Scoreboard`);
  console.log(`Auto dir: ${dir}`);
  console.log('='.repeat(108));
  console.log([
    pad('Profile', 20),
    pad('When', 17),
    pad('Edge', 7),
    pad('Decision', 13),
    pad('AvgPF', 8),
    pad('ExpR', 8),
    pad('PnL%', 8),
    pad('Trades', 8),
  ].join(' '));
  console.log('-'.repeat(108));

  for (const profile of profiles) {
    console.log([
      pad(profile.profileName, 20),
      pad(shortTime(profile.generatedAt), 17),
      pad(profile.edgeScore.toFixed(1), 7),
      pad(profile.stageDecision, 13),
      pad(profile.avgPF.toFixed(2), 8),
      pad(profile.avgExpectancyR.toFixed(2), 8),
      pad(formatPct(profile.totalPnlPct), 8),
      pad(String(profile.totalTrades), 8),
    ].join(' '));
  }
}

function printPairings(pairings: ScoreboardPairing[]): void {
  console.log(`\nRecommended Pairings`);
  console.log('='.repeat(120));
  console.log([
    pad('#', 4),
    pad('Strategy', 16),
    pad('Profile', 20),
    pad('Score', 8),
    pad('Status', 8),
    pad('Strat', 13),
    pad('Prof', 13),
  ].join(' '));
  console.log('-'.repeat(120));

  for (let i = 0; i < pairings.length; i++) {
    const pairing = pairings[i];
    console.log([
      pad(`#${i + 1}`, 4),
      pad(pairing.strategy, 16),
      pad(pairing.profileName, 20),
      pad(pairing.pairingScore.toFixed(1), 8),
      pad(pairing.status, 8),
      pad(pairing.strategyDecision, 13),
      pad(pairing.profileDecision, 13),
    ].join(' '));
  }
}

async function sendTelegramDigest(
  sweeps: Array<{ strategy: string; top: SweepTopResult }>,
  profiles: AutoProfileRow[],
  pairings: ScoreboardPairing[]
): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID || '';
  const notifier = new Notifier(botToken, chatId);
  await notifier.sendTradeAlert(buildTelegramMessage(sweeps, profiles, pairings));
}

function buildTelegramMessage(
  sweeps: Array<{ strategy: string; top: SweepTopResult }>,
  profiles: AutoProfileRow[],
  pairings: ScoreboardPairing[]
): string {
  const lines: string[] = [
    `<b>Strategy Scoreboard</b>`,
    `${new Date().toISOString().slice(0, 10)} | strategies ${sweeps.length} | profiles ${profiles.length}`,
    '',
  ];

  if (sweeps.length > 0) {
    const bestStrategy = sweeps[0];
    lines.push(
      `<b>Best Strategy</b>`,
      `- ${escapeHtml(bestStrategy.strategy)} | Edge ${bestStrategy.top.edgeScore.toFixed(1)} | ` +
      `PF ${bestStrategy.top.avgPF.toFixed(2)} | ExpR ${bestStrategy.top.avgExpectancyR.toFixed(2)} | ${escapeHtml(bestStrategy.top.stageDecision)}`,
      '',
    );
  }

  if (profiles.length > 0) {
    const bestProfile = profiles[0];
    lines.push(
      `<b>Best Profile</b>`,
      `- ${escapeHtml(bestProfile.profileName)} | Edge ${bestProfile.edgeScore.toFixed(1)} | ` +
      `PF ${bestProfile.avgPF.toFixed(2)} | ExpR ${bestProfile.avgExpectancyR.toFixed(2)} | ${escapeHtml(bestProfile.stageDecision)}`,
      '',
    );
  }

  lines.push(`<b>Top Pairings</b>`);
  if (pairings.length === 0) {
    lines.push(`- no pairings`);
  } else {
    for (const pairing of pairings.slice(0, 3)) {
      lines.push(
        `- ${escapeHtml(pairing.strategy)} + ${escapeHtml(pairing.profileName)} ` +
        `| score ${pairing.pairingScore.toFixed(1)} | ${escapeHtml(pairing.status)}`
      );
    }
  }

  const blocked = pairings.filter(pairing => pairing.status === 'blocked');
  if (blocked.length > 0) {
    lines.push('', `<b>Blocked</b>`);
    for (const pairing of blocked.slice(0, 3)) {
      lines.push(
        `- ${escapeHtml(pairing.strategy)} + ${escapeHtml(pairing.profileName)} ` +
        `| strat=${escapeHtml(pairing.strategyDecision)} / profile=${escapeHtml(pairing.profileDecision)}`
      );
    }
  }

  return lines.join('\n');
}

function extractTimestamp(file: string): string {
  const match = file.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  return match ? match[1].replace(/-(\d{2})-(\d{2})$/, ':$1:$2') : '';
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

function shortTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

function pad(value: string, len: number): string {
  return value.length >= len ? value.slice(0, len) : value.padEnd(len);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function printHelp(): void {
  console.log(`
Usage:
  npx ts-node scripts/strategy-scoreboard.ts [options]

Options:
  --sweep-dir <path>   multi-sweep JSON directory (default: ./results)
  --auto-dir <path>    auto-backtest summary directory (default: ./results)
  --top <n>            top pairings to print (default: 5)
  --json               print machine-readable output
  --telegram           send digest to Telegram using BOT_TOKEN/CHAT_ID
  `);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
