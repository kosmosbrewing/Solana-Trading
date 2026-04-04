import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import path from 'path';
import type { RuntimeDiagnosticEvent } from './runtimeDiagnosticsTracker';

/** pair → candle count, UTC-day scoped */
export interface CapSuppressSnapshot {
  utcDay: number; // Math.floor(Date.now() / 86_400_000)
  stats: Record<string, number>; // pairAddress → candle count
}

interface RuntimeDiagnosticsStorePayload {
  version: 1;
  updatedAt: string;
  events: RuntimeDiagnosticEvent[];
  capSuppress?: CapSuppressSnapshot;
}

export class RuntimeDiagnosticsStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<{ events: RuntimeDiagnosticEvent[]; capSuppress?: CapSuppressSnapshot }> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RuntimeDiagnosticsStorePayload>;
      const events = Array.isArray(parsed.events) ? parsed.events.filter(isRuntimeDiagnosticEvent) : [];
      return { events, capSuppress: isCapSuppressSnapshot(parsed.capSuppress) ? parsed.capSuppress : undefined };
    } catch {
      return { events: [] };
    }
  }

  async save(events: RuntimeDiagnosticEvent[], capSuppress?: CapSuppressSnapshot): Promise<void> {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true });
    const payload: RuntimeDiagnosticsStorePayload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      events,
      capSuppress,
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

function isCapSuppressSnapshot(value: unknown): value is CapSuppressSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.utcDay !== 'number' || !Number.isInteger(candidate.utcDay) || candidate.utcDay < 0) {
    return false;
  }
  if (!candidate.stats || typeof candidate.stats !== 'object' || Array.isArray(candidate.stats)) return false;
  return Object.entries(candidate.stats as Record<string, unknown>).every(
    ([pair, count]) => typeof count === 'number' && pair.length > 0 && Number.isFinite(count) && count >= 0
  );
}
