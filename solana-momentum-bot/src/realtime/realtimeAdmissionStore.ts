import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import { RealtimeAdmissionSnapshotEntry } from './realtimeAdmissionTracker';

interface RealtimeAdmissionStorePayload {
  version: 1;
  updatedAt: string;
  entries: RealtimeAdmissionSnapshotEntry[];
}

export class RealtimeAdmissionStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<RealtimeAdmissionSnapshotEntry[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RealtimeAdmissionStorePayload>;
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(isSnapshotEntry);
    } catch {
      return [];
    }
  }

  async save(entries: RealtimeAdmissionSnapshotEntry[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true });
    const payload: RealtimeAdmissionStorePayload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
    };
    await writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tempPath, this.filePath);
  }
}

function isSnapshotEntry(value: unknown): value is RealtimeAdmissionSnapshotEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.pool === 'string'
    && typeof candidate.observedNotifications === 'number'
    && typeof candidate.logParsed === 'number'
    && typeof candidate.fallbackSkipped === 'number'
    && typeof candidate.blocked === 'boolean';
}
