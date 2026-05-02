import { appendFile, mkdir, readFile } from 'fs/promises';
import path from 'path';

export async function appendPureWsBotflowJsonl(file: string, records: unknown[], keyField: string): Promise<void> {
  if (records.length === 0) return;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const existing = await readExistingKeys(file, keyField);
    const fresh = records.filter((record) => {
      const key = readRecordKey(record, keyField);
      return !key || !existing.has(key);
    });
    if (fresh.length === 0) return;
    await appendFile(file, fresh.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  } catch (err) {
    console.warn(`[pure-ws-botflow-report] WARN append failed file=${file}: ${String(err)}`);
  }
}

async function readExistingKeys(file: string, keyField: string): Promise<Set<string>> {
  try {
    const raw = await readFile(file, 'utf8');
    const keys = raw.split('\n').map((line) => {
      try {
        return readRecordKey(JSON.parse(line), keyField);
      } catch {
        return undefined;
      }
    }).filter((key): key is string => Boolean(key));
    return new Set(keys);
  } catch {
    return new Set();
  }
}

function readRecordKey(record: unknown, keyField: string): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const value = (record as Record<string, unknown>)[keyField];
  return typeof value === 'string' && value ? value : undefined;
}
