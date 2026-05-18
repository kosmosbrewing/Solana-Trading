#!/usr/bin/env ts-node
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { parseMissionEntryArgs } from './lib/missionEntryReportArgs';
import { buildMissionEntryReport } from './lib/missionEntryReport';
import { renderMissionEntryReport } from './lib/missionEntryReportRenderer';

export {
  buildMissionEntryReport,
  parseMissionEntryArgs,
  renderMissionEntryReport,
};

async function writeOutput(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function main(): Promise<void> {
  const args = parseMissionEntryArgs(process.argv.slice(2));
  const report = await buildMissionEntryReport(args);
  const markdown = renderMissionEntryReport(report);
  if (args.jsonOut) await writeOutput(args.jsonOut, JSON.stringify(report, null, 2) + '\n');
  if (args.mdOut) await writeOutput(args.mdOut, markdown);
  if (!args.jsonOut && !args.mdOut) process.stdout.write(markdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
