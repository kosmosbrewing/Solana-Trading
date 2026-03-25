import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import type { RuntimeDiagnosticEvent } from './runtimeDiagnosticsTracker';

interface RuntimeDiagnosticsStorePayload {
  version: 1;
  updatedAt: string;
  events: RuntimeDiagnosticEvent[];
}

export class RuntimeDiagnosticsStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<RuntimeDiagnosticEvent[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RuntimeDiagnosticsStorePayload>;
      if (!Array.isArray(parsed.events)) return [];
      return parsed.events.filter(isRuntimeDiagnosticEvent);
    } catch {
      return [];
    }
  }

  async save(events: RuntimeDiagnosticEvent[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true });
    const payload: RuntimeDiagnosticsStorePayload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      events,
    };
    await writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tempPath, this.filePath);
  }
}

function isRuntimeDiagnosticEvent(value: unknown): value is RuntimeDiagnosticEvent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.type === 'string'
    && typeof candidate.timestampMs === 'number'
    && (candidate.tokenMint == null || typeof candidate.tokenMint === 'string')
    && (candidate.reason == null || typeof candidate.reason === 'string')
    && (candidate.source == null || typeof candidate.source === 'string')
    && (candidate.dexId == null || typeof candidate.dexId === 'string');
}
