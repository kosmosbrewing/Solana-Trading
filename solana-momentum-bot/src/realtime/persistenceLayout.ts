import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'fs';
import { mkdir, rename, writeFile } from 'fs/promises';
import path from 'path';
import { TradingMode } from '../utils/config';

const DATASET_FILES = [
  'raw-swaps.jsonl',
  'micro-candles.jsonl',
  'realtime-signals.jsonl',
] as const;

interface CurrentSessionPointer {
  version: 1;
  datasetDir: string;
  startedAt: string;
  tradingMode: TradingMode;
}

export interface RealtimePersistenceLayout {
  rootDir: string;
  datasetDir: string;
  sessionsDir: string;
  runtimeDiagnosticsPath: string;
  currentSessionPath: string;
}

export async function prepareRealtimePersistenceLayout(
  rootDir: string,
  options: { tradingMode: TradingMode; startedAt?: Date }
): Promise<RealtimePersistenceLayout> {
  const startedAt = options.startedAt ?? new Date();
  const resolvedRootDir = path.resolve(rootDir);
  const sessionsDir = path.join(resolvedRootDir, 'sessions');
  const runtimeDiagnosticsPath = path.join(resolvedRootDir, 'runtime-diagnostics.json');
  const currentSessionPath = path.join(resolvedRootDir, 'current-session.json');

  await mkdir(resolvedRootDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await migrateLegacyDatasetIfPresent(resolvedRootDir, sessionsDir, startedAt);

  const sessionName = `${formatSessionTimestamp(startedAt)}-${options.tradingMode}`;
  const datasetDir = path.join(sessionsDir, sessionName);
  await mkdir(datasetDir, { recursive: true });

  const pointer: CurrentSessionPointer = {
    version: 1,
    datasetDir,
    startedAt: startedAt.toISOString(),
    tradingMode: options.tradingMode,
  };
  await writeFile(currentSessionPath, JSON.stringify(pointer, null, 2), 'utf8');

  return {
    rootDir: resolvedRootDir,
    datasetDir,
    sessionsDir,
    runtimeDiagnosticsPath,
    currentSessionPath,
  };
}

export function resolveRealtimeDatasetDir(rootDir: string): string {
  const resolvedRootDir = path.resolve(rootDir);
  if (hasDatasetFiles(resolvedRootDir)) {
    return resolvedRootDir;
  }

  const pointedDir = readCurrentSessionPointer(resolvedRootDir);
  if (pointedDir && hasDatasetCandidate(pointedDir)) {
    return pointedDir;
  }

  const sessionsDir = path.join(resolvedRootDir, 'sessions');
  if (!existsSync(sessionsDir)) {
    return resolvedRootDir;
  }

  const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(sessionsDir, entry.name))
    .filter((dirPath) => hasDatasetCandidate(dirPath))
    .sort(compareSessionDirs);
  const latestSession = sessionDirs[0];

  return latestSession ?? resolvedRootDir;
}

async function migrateLegacyDatasetIfPresent(
  rootDir: string,
  sessionsDir: string,
  startedAt: Date
): Promise<void> {
  const legacyFiles = DATASET_FILES
    .map((fileName) => path.join(rootDir, fileName))
    .filter((filePath) => existsSync(filePath));
  if (legacyFiles.length === 0) {
    return;
  }

  const legacyDir = path.join(sessionsDir, `legacy-${formatSessionTimestamp(startedAt)}`);
  await mkdir(legacyDir, { recursive: true });
  for (const filePath of legacyFiles) {
    await rename(filePath, path.join(legacyDir, path.basename(filePath)));
  }
}

function hasDatasetFiles(dirPath: string): boolean {
  return DATASET_FILES.some((fileName) => existsSync(path.join(dirPath, fileName)));
}

function hasDatasetCandidate(dirPath: string): boolean {
  if (!existsSync(dirPath)) {
    return false;
  }
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readCurrentSessionPointer(rootDir: string): string | null {
  const pointerPath = path.join(rootDir, 'current-session.json');
  if (!existsSync(pointerPath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(pointerPath, 'utf8')) as Partial<CurrentSessionPointer>;
    if (typeof raw.datasetDir !== 'string' || raw.datasetDir.length === 0) {
      return null;
    }
    return path.isAbsolute(raw.datasetDir)
      ? raw.datasetDir
      : path.resolve(rootDir, raw.datasetDir);
  } catch {
    return null;
  }
}

function formatSessionTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-');
}

function compareSessionDirs(left: string, right: string): number {
  const leftMeta = parseSessionDir(path.basename(left));
  const rightMeta = parseSessionDir(path.basename(right));
  if (leftMeta.priority !== rightMeta.priority) {
    return rightMeta.priority - leftMeta.priority;
  }
  return rightMeta.sortKey.localeCompare(leftMeta.sortKey);
}

function parseSessionDir(name: string): { priority: number; sortKey: string } {
  if (name.startsWith('legacy-')) {
    return {
      priority: 0,
      sortKey: name.slice('legacy-'.length),
    };
  }
  return {
    priority: 1,
    sortKey: name,
  };
}

export function ensureRealtimeDir(rootDir: string): string {
  const resolvedRootDir = path.resolve(rootDir);
  mkdirSync(resolvedRootDir, { recursive: true });
  return resolvedRootDir;
}
