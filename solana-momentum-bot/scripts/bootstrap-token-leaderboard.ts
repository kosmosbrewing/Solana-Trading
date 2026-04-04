/* eslint-disable no-console */

import fs from 'fs';
import path from 'path';

interface TokenSummary {
  tokenMint: string;
  tokenSymbol?: string;
  pairAddress: string;
  signals: number;
  executed: number;
  gateRejected: number;
  totalAdjustedReturnPct: number;
  totalEstimatedPnlSol: number;
}

interface SessionDetails {
  session: string;
  sessionLabel: string;
  tokenSummaries: TokenSummary[];
}

interface ProfileDetails {
  profileId: string;
  volumeMultiplier: number;
  minBuyRatio: number;
  volumeLookback: number;
  sessions: SessionDetails[];
}

interface DetailsFile {
  config: {
    fixedNotionalSol?: number;
    estimatedCostPct?: number;
    gateMode?: string;
    horizonSec?: number;
  };
  profiles: ProfileDetails[];
}

interface AggregateToken {
  tokenMint: string;
  tokenSymbol: string;
  pairAddress: string;
  sessions: number;
  signals: number;
  executed: number;
  gateRejected: number;
  totalAdjustedReturnPct: number;
  totalEstimatedPnlSol: number;
}

interface ComparisonRow {
  tokenMint: string;
  tokenSymbol: string;
  bestProfileId: string;
  bestPnlSol: number;
  worstProfileId: string;
  worstPnlSol: number;
  spreadPnlSol: number;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    printHelp();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const inputPath = requireArg(args, '--input');
  const topN = numArg(args, '--top', 10);
  const minSignals = numArg(args, '--min-signals', 5);
  const minSessions = numArg(args, '--min-sessions', 2);
  const profileFilter = getArg(args, '--profile');
  const sessionFilter = getArg(args, '--session');
  const saveBasename = getArg(args, '--save');

  const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8')) as DetailsFile;
  const profiles = input.profiles.filter((profile) => !profileFilter || profile.profileId === profileFilter);
  if (profiles.length === 0) {
    throw new Error(`No profiles matched --profile=${profileFilter}`);
  }

  const reports = profiles.map((profile) => buildProfileReport(profile, sessionFilter, topN, minSignals, minSessions));
  const comparisons = profiles.length > 1 ? buildComparisonReport(reports, topN, minSignals) : [];

  for (const report of reports) {
    printProfileReport(report, input.config, sessionFilter);
  }
  if (comparisons.length > 0) {
    printComparisonTable('Profile Spread', comparisons);
  }

  if (saveBasename) {
    const resultsDir = path.resolve('results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const jsonPath = path.join(resultsDir, `${saveBasename}.json`);
    const mdPath = path.join(resultsDir, `${saveBasename}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: path.resolve(inputPath),
      config: input.config,
      reports,
      comparisons,
    }, null, 2), 'utf8');
    fs.writeFileSync(mdPath, renderMarkdown(reports, comparisons, input.config, sessionFilter), 'utf8');
    console.log(`\nSaved: ${mdPath}`);
    console.log(`Saved: ${jsonPath}`);
  }
}

function buildProfileReport(
  profile: ProfileDetails,
  sessionFilter: string | undefined,
  topN: number,
  minSignals: number,
  minSessions: number
) {
  const tokens = new Map<string, AggregateToken>();
  for (const session of profile.sessions) {
    if (sessionFilter && session.session !== sessionFilter && session.sessionLabel !== sessionFilter) continue;
    for (const token of session.tokenSummaries) {
      const key = token.tokenMint || token.pairAddress;
      const current = tokens.get(key) ?? {
        tokenMint: token.tokenMint || '',
        tokenSymbol: token.tokenSymbol || '',
        pairAddress: token.pairAddress,
        sessions: 0,
        signals: 0,
        executed: 0,
        gateRejected: 0,
        totalAdjustedReturnPct: 0,
        totalEstimatedPnlSol: 0,
      };
      current.sessions += 1;
      current.signals += token.signals;
      current.executed += token.executed;
      current.gateRejected += token.gateRejected;
      current.totalAdjustedReturnPct += token.totalAdjustedReturnPct;
      current.totalEstimatedPnlSol += token.totalEstimatedPnlSol;
      tokens.set(key, current);
    }
  }

  const ranked = Array.from(tokens.values()).sort((a, b) => b.totalEstimatedPnlSol - a.totalEstimatedPnlSol);
  const blacklist = ranked
    .filter((row) => row.signals >= minSignals && row.totalEstimatedPnlSol < 0)
    .sort((a, b) => a.totalEstimatedPnlSol - b.totalEstimatedPnlSol)
    .slice(0, topN);
  const reentry = ranked
    .filter((row) => row.signals >= minSignals && row.sessions >= minSessions && row.totalEstimatedPnlSol > 0)
    .slice(0, topN);

  return {
    profileId: profile.profileId,
    volumeMultiplier: profile.volumeMultiplier,
    minBuyRatio: profile.minBuyRatio,
    volumeLookback: profile.volumeLookback,
    top: ranked.slice(0, topN),
    bottom: [...ranked].reverse().slice(0, topN),
    blacklist,
    reentry,
  };
}

function buildComparisonReport(
  reports: Array<ReturnType<typeof buildProfileReport>>,
  topN: number,
  minSignals: number
): ComparisonRow[] {
  const perToken = new Map<string, Array<{ profileId: string; tokenSymbol: string; pnlSol: number; signals: number }>>();
  for (const report of reports) {
    for (const row of [...report.top, ...report.bottom, ...report.blacklist, ...report.reentry]) {
      const key = row.tokenMint || row.pairAddress;
      const current = perToken.get(key) ?? [];
      if (!current.some((item) => item.profileId === report.profileId)) {
        current.push({
          profileId: report.profileId,
          tokenSymbol: row.tokenSymbol || '',
          pnlSol: row.totalEstimatedPnlSol,
          signals: row.signals,
        });
        perToken.set(key, current);
      }
    }
  }

  return Array.from(perToken.entries())
    .map(([tokenMint, rows]) => {
      const eligible = rows.filter((row) => row.signals >= minSignals);
      if (eligible.length < 2) return undefined;
      const sorted = [...eligible].sort((a, b) => b.pnlSol - a.pnlSol);
      return {
        tokenMint,
        tokenSymbol: sorted[0].tokenSymbol,
        bestProfileId: sorted[0].profileId,
        bestPnlSol: sorted[0].pnlSol,
        worstProfileId: sorted[sorted.length - 1].profileId,
        worstPnlSol: sorted[sorted.length - 1].pnlSol,
        spreadPnlSol: sorted[0].pnlSol - sorted[sorted.length - 1].pnlSol,
      };
    })
    .filter((row): row is ComparisonRow => Boolean(row))
    .sort((a, b) => b.spreadPnlSol - a.spreadPnlSol)
    .slice(0, topN);
}

function printProfileReport(
  report: ReturnType<typeof buildProfileReport>,
  config: DetailsFile['config'],
  sessionFilter?: string
) {
  console.log(`\nBootstrap Token Leaderboard — ${report.profileId}`);
  console.log(`  vm=${report.volumeMultiplier} lookback=${report.volumeLookback} buyRatio=${report.minBuyRatio}`);
  console.log(`  notional=${config.fixedNotionalSol ?? 0} SOL cost=${config.estimatedCostPct ?? 0} gate=${config.gateMode ?? 'off'} horizon=${config.horizonSec ?? 0}s`);
  if (sessionFilter) console.log(`  session=${sessionFilter}`);
  console.log('');
  printTokenTable('Top Tokens', report.top);
  console.log('');
  printTokenTable('Bottom Tokens', report.bottom);
  console.log('');
  printTokenTable('Blacklist Candidates', report.blacklist);
  console.log('');
  printTokenTable('Reentry Candidates', report.reentry);
}

function printTokenTable(title: string, rows: AggregateToken[]) {
  console.log(title);
  console.log('┌──────────────┬─────────┬──────────┬────────────┬──────────┐');
  console.log('│ Token        │ Signals │ Sessions │ estPnL SOL │ adjRet % │');
  console.log('├──────────────┼─────────┼──────────┼────────────┼──────────┤');
  for (const row of rows) {
    const label = shorten(row.tokenSymbol || row.tokenMint || row.pairAddress, 12);
    const adjustedPct = `${row.totalAdjustedReturnPct >= 0 ? '+' : ''}${(row.totalAdjustedReturnPct * 100).toFixed(2)}%`;
    const estimatedSol = `${row.totalEstimatedPnlSol >= 0 ? '+' : ''}${row.totalEstimatedPnlSol.toFixed(4)}`;
    console.log(
      `│ ${pad(label, 12)} │ ${pad(row.signals, 7, 'right')} │ ${pad(row.sessions, 8, 'right')} │ ${pad(estimatedSol, 10, 'right')} │ ${pad(adjustedPct, 8, 'right')} │`
    );
  }
  if (rows.length === 0) {
    console.log(`│ ${pad('-', 12)} │ ${pad('-', 7, 'right')} │ ${pad('-', 8, 'right')} │ ${pad('-', 10, 'right')} │ ${pad('-', 8, 'right')} │`);
  }
  console.log('└──────────────┴─────────┴──────────┴────────────┴──────────┘');
}

function printComparisonTable(title: string, rows: ComparisonRow[]) {
  console.log(`\n${title}`);
  console.log('┌──────────────┬────────────────────┬────────────┬────────────────────┬────────────┬────────────┐');
  console.log('│ Token        │ Best Profile       │ Best SOL   │ Worst Profile      │ Worst SOL  │ Spread SOL │');
  console.log('├──────────────┼────────────────────┼────────────┼────────────────────┼────────────┼────────────┤');
  for (const row of rows) {
    console.log(
      `│ ${pad(shorten(row.tokenSymbol || row.tokenMint, 12), 12)} │ ${pad(row.bestProfileId, 18)} │ ${pad(row.bestPnlSol.toFixed(4), 10, 'right')} │ ${pad(row.worstProfileId, 18)} │ ${pad(row.worstPnlSol.toFixed(4), 10, 'right')} │ ${pad(row.spreadPnlSol.toFixed(4), 10, 'right')} │`
    );
  }
  console.log('└──────────────┴────────────────────┴────────────┴────────────────────┴────────────┴────────────┘');
}

function renderMarkdown(
  reports: Array<ReturnType<typeof buildProfileReport>>,
  comparisons: ComparisonRow[],
  config: DetailsFile['config'],
  sessionFilter?: string
) {
  const lines = ['# Bootstrap Token Leaderboard', '', `- fixedNotionalSol=${config.fixedNotionalSol ?? 0}`];
  if (sessionFilter) lines.push(`- session=${sessionFilter}`);
  lines.push('');
  for (const report of reports) {
    lines.push(`## ${report.profileId}`, '');
    lines.push(`- vm=${report.volumeMultiplier}`);
    lines.push(`- lookback=${report.volumeLookback}`);
    lines.push(`- minBuyRatio=${report.minBuyRatio}`, '');
    appendMarkdownTokenTable(lines, 'top', report.top);
    appendMarkdownTokenTable(lines, 'bottom', report.bottom);
    appendMarkdownTokenTable(lines, 'blacklist', report.blacklist);
    appendMarkdownTokenTable(lines, 'reentry', report.reentry);
  }
  if (comparisons.length > 0) {
    lines.push('## Profile Spread', '', '| Token | Best Profile | Best SOL | Worst Profile | Worst SOL | Spread SOL |', '|---|---|---:|---|---:|---:|');
    for (const row of comparisons) {
      lines.push(`| ${row.tokenSymbol || row.tokenMint} | ${row.bestProfileId} | ${row.bestPnlSol.toFixed(4)} | ${row.worstProfileId} | ${row.worstPnlSol.toFixed(4)} | ${row.spreadPnlSol.toFixed(4)} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function appendMarkdownTokenTable(lines: string[], group: string, rows: AggregateToken[]) {
  lines.push(`### ${group}`, '', '| Token | Signals | Sessions | estPnL SOL | adjRet % |', '|---|---:|---:|---:|---:|');
  for (const row of rows) {
    lines.push(`| ${row.tokenSymbol || row.tokenMint || row.pairAddress} | ${row.signals} | ${row.sessions} | ${row.totalEstimatedPnlSol.toFixed(4)} | ${(row.totalAdjustedReturnPct * 100).toFixed(2)}% |`);
  }
  if (rows.length === 0) lines.push('| - | - | - | - | - |');
  lines.push('');
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function requireArg(args: string[], flag: string): string {
  const value = getArg(args, flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function numArg(args: string[], flag: string, fallback: number): number {
  const raw = getArg(args, flag);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number for ${flag}: ${raw}`);
  return parsed;
}

function pad(value: string | number, width: number, align: 'left' | 'right' = 'left') {
  const text = String(value);
  return align === 'right' ? text.padStart(width) : text.padEnd(width);
}

function shorten(value: string, width: number) {
  return value.length <= width ? value : `${value.slice(0, width - 3)}...`;
}

function printHelp() {
  console.log(`
Usage:
  npx ts-node scripts/bootstrap-token-leaderboard.ts --input <details.json> [options]

Options:
  --input <path>       Detail JSON generated by bootstrap-replay-report.sh
  --profile <id>       Filter a single profile id
  --session <id|label> Filter a single session id or label
  --top <n>            Number of rows per section (default: 10)
  --min-signals <n>    Minimum signals for blacklist/reentry/comparison (default: 5)
  --min-sessions <n>   Minimum sessions for reentry candidates (default: 2)
  --save <basename>    Save markdown/json under results/
`);
}

main();
