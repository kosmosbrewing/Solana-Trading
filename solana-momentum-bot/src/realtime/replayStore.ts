import { createReadStream } from 'fs';
import { access, appendFile, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { Candle } from '../utils/types';
import { ParsedSwap } from './types';
import { RealtimeSignalRecord } from '../reporting/realtimeMeasurement';
import { resolveRealtimeDatasetDir } from './persistenceLayout';

export interface StoredRealtimeSwap extends ParsedSwap {
  pairAddress: string;
  poolAddress: string;
  tokenMint?: string;
  tokenSymbol?: string;
}

export interface StoredMicroCandle extends Candle {
  poolAddress?: string;
  tokenMint?: string;
  tokenSymbol?: string;
}

export interface RealtimeReplayManifest {
  version: 1;
  exportedAt: string;
  start?: string;
  end?: string;
  counts: {
    swaps: number;
    candles: number;
    signals: number;
  };
}

export class RealtimeReplayStore {
  readonly datasetDir: string;

  constructor(baseDir: string) {
    this.datasetDir = resolveRealtimeDatasetDir(baseDir);
  }

  get swapsPath(): string {
    return path.join(this.datasetDir, 'raw-swaps.jsonl');
  }

  get candlesPath(): string {
    return path.join(this.datasetDir, 'micro-candles.jsonl');
  }

  get signalsPath(): string {
    return path.join(this.datasetDir, 'realtime-signals.jsonl');
  }

  get signalIntentsPath(): string {
    return path.join(this.datasetDir, 'signal-intents.jsonl');
  }

  async appendSwap(record: StoredRealtimeSwap): Promise<void> {
    await this.appendJsonLine(this.swapsPath, record);
  }

  async appendCandle(record: StoredMicroCandle): Promise<void> {
    await this.appendJsonLine(this.candlesPath, serializeCandle(record));
  }

  async appendSignal(record: RealtimeSignalRecord): Promise<void> {
    await this.appendJsonLine(this.signalsPath, record);
  }

  async appendSignalIntent(record: Omit<RealtimeSignalRecord, 'horizons' | 'summary'>): Promise<void> {
    await this.appendJsonLine(this.signalIntentsPath, record);
  }

  async loadSignalIntents(): Promise<Array<Omit<RealtimeSignalRecord, 'horizons' | 'summary'>>> {
    return loadJsonLines(this.signalIntentsPath, isSignalIntent);
  }

  async loadSwaps(filePath = this.swapsPath): Promise<StoredRealtimeSwap[]> {
    return loadJsonLines<StoredRealtimeSwap>(filePath, isStoredRealtimeSwap);
  }

  async loadCandles(filePath = this.candlesPath): Promise<StoredMicroCandle[]> {
    const rows = await loadJsonLines<Record<string, unknown>>(filePath, (value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'));
    return rows
      .map(deserializeCandle)
      .filter((row): row is StoredMicroCandle => row !== null);
  }

  async *streamCandles(filePath = this.candlesPath): AsyncGenerator<StoredMicroCandle> {
    for await (const row of streamJsonLines<Record<string, unknown>>(filePath, (value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'))) {
      const candle = deserializeCandle(row);
      if (candle) {
        yield candle;
      }
    }
  }

  async loadSignals(filePath = this.signalsPath): Promise<RealtimeSignalRecord[]> {
    return loadJsonLines<RealtimeSignalRecord>(filePath, isRealtimeSignalRecord);
  }

  async hasCandles(filePath = this.candlesPath): Promise<boolean> {
    return hasReadableFile(filePath);
  }

  async exportRange(outputDir: string, options: { start?: Date; end?: Date }): Promise<RealtimeReplayManifest> {
    const [swaps, candles, signals] = await Promise.all([
      this.loadSwaps(),
      this.loadCandles(),
      this.loadSignals(),
    ]);

    const filteredSwaps = swaps.filter((record) => inRange(record.timestamp * 1000, options.start, options.end));
    const filteredCandles = candles.filter((record) => inRange(record.timestamp.getTime(), options.start, options.end));
    const filteredSignals = signals.filter((record) => inRange(Date.parse(record.signalTimestamp), options.start, options.end));

    await mkdir(outputDir, { recursive: true });
    await writeJsonLines(path.join(outputDir, 'raw-swaps.jsonl'), filteredSwaps);
    await writeJsonLines(path.join(outputDir, 'micro-candles.jsonl'), filteredCandles.map(serializeCandle));
    await writeJsonLines(path.join(outputDir, 'realtime-signals.jsonl'), filteredSignals);

    const manifest: RealtimeReplayManifest = {
      version: 1,
      exportedAt: new Date().toISOString(),
      start: options.start?.toISOString(),
      end: options.end?.toISOString(),
      counts: {
        swaps: filteredSwaps.length,
        candles: filteredCandles.length,
        signals: filteredSignals.length,
      },
    };
    await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  }

  private async appendJsonLine(filePath: string, payload: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  }
}

export async function loadJsonLines<T>(
  filePath: string,
  guard: (value: unknown) => value is T
): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of streamJsonLines(filePath, guard)) {
    rows.push(row);
  }
  return rows;
}

export async function* streamJsonLines<T>(
  filePath: string,
  guard: (value: unknown) => value is T
): AsyncGenerator<T> {
  if (!(await hasReadableFile(filePath))) {
    return;
  }

  const input = createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const value = JSON.parse(trimmed) as unknown;
        if (guard(value)) {
          yield value;
        }
      } catch {
        continue;
      }
    }
  } finally {
    reader.close();
    input.destroy();
  }
}

export async function writeJsonLines(filePath: string, rows: unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await writeFile(filePath, body.length > 0 ? `${body}\n` : '', 'utf8');
}

function serializeCandle(candle: StoredMicroCandle): Record<string, unknown> {
  return {
    ...candle,
    timestamp: candle.timestamp.toISOString(),
  };
}

function deserializeCandle(value: Record<string, unknown>): StoredMicroCandle | null {
  if (typeof value.pairAddress !== 'string' || typeof value.timestamp !== 'string') return null;
  if (typeof value.intervalSec !== 'number') return null;
  return {
    pairAddress: value.pairAddress,
    timestamp: new Date(value.timestamp),
    intervalSec: value.intervalSec,
    open: Number(value.open),
    high: Number(value.high),
    low: Number(value.low),
    close: Number(value.close),
    volume: Number(value.volume),
    buyVolume: Number(value.buyVolume),
    sellVolume: Number(value.sellVolume),
    tradeCount: Number(value.tradeCount),
    poolAddress: typeof value.poolAddress === 'string' ? value.poolAddress : undefined,
    tokenMint: typeof value.tokenMint === 'string' ? value.tokenMint : undefined,
    tokenSymbol: typeof value.tokenSymbol === 'string' ? value.tokenSymbol : undefined,
  };
}

function isStoredRealtimeSwap(value: unknown): value is StoredRealtimeSwap {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.pairAddress === 'string'
    && typeof row.poolAddress === 'string'
    && typeof row.pool === 'string'
    && typeof row.signature === 'string'
    && typeof row.timestamp === 'number'
    && typeof row.side === 'string'
    && typeof row.priceNative === 'number'
    && typeof row.amountBase === 'number'
    && typeof row.amountQuote === 'number'
    && typeof row.slot === 'number';
}

function isRealtimeSignalRecord(value: unknown): value is RealtimeSignalRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.version === 1
    && typeof row.id === 'string'
    && typeof row.strategy === 'string'
    && typeof row.pairAddress === 'string'
    && typeof row.signalTimestamp === 'string'
    && typeof row.referencePrice === 'number'
    && Array.isArray(row.horizons);
}

function isSignalIntent(value: unknown): value is Omit<RealtimeSignalRecord, 'horizons' | 'summary'> {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.version === 1
    && typeof row.id === 'string'
    && typeof row.strategy === 'string'
    && typeof row.pairAddress === 'string'
    && typeof row.signalTimestamp === 'string'
    && typeof row.referencePrice === 'number';
}

function inRange(valueMs: number, start?: Date, end?: Date): boolean {
  if (!Number.isFinite(valueMs)) return false;
  if (start && valueMs < start.getTime()) return false;
  if (end && valueMs > end.getTime()) return false;
  return true;
}

async function hasReadableFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
