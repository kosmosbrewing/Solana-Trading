import { readFile } from 'fs/promises';
import type { PureWsBotflowPricePoint } from './pureWsBotflowTypes';

export async function loadPureWsBotflowPricePoints(filePath: string): Promise<PureWsBotflowPricePoint[]> {
  if (!filePath) return [];
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.split('\n').map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const tokenMint = stringField(row, 'tokenMint') ?? stringField(row, 'mint');
        const timestampMs = timeFieldMs(row, 'timestampMs')
          ?? timeFieldMs(row, 'timestamp')
          ?? timeFieldMs(row, 'observedAt')
          ?? timeFieldMs(row, 'recordedAt');
        const priceSol = numberField(row, 'priceSol')
          ?? numberField(row, 'priceSolPerToken')
          ?? numberField(row, 'price');
        if (!tokenMint || timestampMs == null || priceSol == null || priceSol <= 0) return [];
        return [{
          tokenMint,
          timestampMs,
          priceSol,
          source: stringField(row, 'source') ?? 'price_file',
        } satisfies PureWsBotflowPricePoint];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value ? value : undefined;
}

function numberField(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timeFieldMs(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
