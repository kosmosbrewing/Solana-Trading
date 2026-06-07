#!/usr/bin/env ts-node
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { parseMissionOfflineSimulatorArgs } from './lib/missionOfflineSimulatorArgs';
import { buildMissionOfflineSimulatorReport } from './lib/missionOfflineSimulator';
import { renderMissionOfflineSimulatorReport } from './lib/missionOfflineSimulatorRenderer';

export {
  buildMissionOfflineSimulatorReport,
  parseMissionOfflineSimulatorArgs,
  renderMissionOfflineSimulatorReport,
};

async function writeOutput(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function main(): Promise<void> {
  const args = parseMissionOfflineSimulatorArgs(process.argv.slice(2));
  const report = await buildMissionOfflineSimulatorReport(args);
  const markdown = renderMissionOfflineSimulatorReport(report);
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
