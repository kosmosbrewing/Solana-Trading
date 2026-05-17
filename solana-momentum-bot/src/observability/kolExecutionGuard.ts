import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import type { KolExecutionGuardSnapshot } from '../orchestration/kolDecisionCore';

export const KOL_EXECUTION_GUARD_ROW_SCHEMA_VERSION = 'kol-execution-guard-row/v1' as const;
export const KOL_EXECUTION_GUARD_FILE = 'kol-execution-guards.jsonl' as const;

export interface KolExecutionGuardRow {
  schemaVersion: typeof KOL_EXECUTION_GUARD_ROW_SCHEMA_VERSION;
  generatedAt: string;
  tokenMint: string;
  positionId?: string | null;
  mode: 'paper' | 'live';
  candidateId?: string | null;
  decisionId?: string | null;
  parameterVersion?: string | null;
  entryReason?: string | null;
  canaryLane?: string | null;
  survivalFlags?: string[];
  executionGuard: KolExecutionGuardSnapshot;
  source: 'runtime';
}

export async function appendKolExecutionGuard(
  row: KolExecutionGuardRow,
  options: { realtimeDir: string } | { outputFile: string }
): Promise<void> {
  const outputFile =
    'outputFile' in options
      ? options.outputFile
      : path.join(options.realtimeDir, KOL_EXECUTION_GUARD_FILE);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await appendFile(outputFile, JSON.stringify(row) + '\n', 'utf8');
}
