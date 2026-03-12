import * as fs from 'fs';
import * as readline from 'readline';
import { Candle } from '../utils/types';
import { CandleDataSource } from './types';

/**
 * CSV 캔들 데이터 로더 — DB 없이 백테스트 가능
 *
 * 지원 포맷:
 * 1. timestamp,open,high,low,close,volume[,trade_count]
 * 2. date,open,high,low,close,volume[,trade_count]
 *
 * timestamp: Unix seconds 또는 ISO 8601
 */
export class CsvLoader implements CandleDataSource {
  constructor(private baseDir: string) {}

  async load(pairAddress: string, intervalSec: number): Promise<Candle[]> {
    // Try multiple naming conventions
    const candidates = [
      `${pairAddress}_${intervalSec}.csv`,
      `${pairAddress}_${this.intervalLabel(intervalSec)}.csv`,
      `${pairAddress}.csv`,
    ];

    for (const filename of candidates) {
      const filepath = `${this.baseDir}/${filename}`;
      if (fs.existsSync(filepath)) {
        return this.parseFile(filepath, pairAddress, intervalSec);
      }
    }

    throw new Error(
      `No CSV found for ${pairAddress} (interval=${intervalSec}s). ` +
      `Tried: ${candidates.join(', ')} in ${this.baseDir}`
    );
  }

  async parseFile(
    filepath: string,
    pairAddress: string,
    intervalSec: number
  ): Promise<Candle[]> {
    const candles: Candle[] = [];
    const stream = fs.createReadStream(filepath, 'utf-8');
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let headerSkipped = false;

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Skip header row
      if (!headerSkipped && /^[a-zA-Z]/.test(trimmed)) {
        headerSkipped = true;
        continue;
      }
      headerSkipped = true;

      const cols = trimmed.split(',').map(s => s.trim());
      if (cols.length < 6) continue;

      const timestamp = this.parseTimestamp(cols[0]);
      if (!timestamp) continue;

      const open = Number(cols[1]);
      const high = Number(cols[2]);
      const low = Number(cols[3]);
      const close = Number(cols[4]);
      const volume = Number(cols[5]);
      const tradeCount = cols[6] ? Number(cols[6]) : 0;
      const buyVolume = cols[7] ? Number(cols[7]) : 0;
      const sellVolume = cols[8] ? Number(cols[8]) : 0;

      if ([open, high, low, close, volume].some(Number.isNaN)) continue;

      candles.push({
        pairAddress,
        timestamp,
        intervalSec,
        open,
        high,
        low,
        close,
        volume,
        buyVolume: Number.isNaN(buyVolume) ? 0 : buyVolume,
        sellVolume: Number.isNaN(sellVolume) ? 0 : sellVolume,
        tradeCount,
      });
    }

    // Sort by timestamp ascending
    candles.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return candles;
  }

  private parseTimestamp(raw: string): Date | null {
    // Unix seconds (10 digits) or milliseconds (13 digits)
    const num = Number(raw);
    if (!Number.isNaN(num) && num > 0) {
      return new Date(num < 1e12 ? num * 1000 : num);
    }
    // ISO 8601 or other date string
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  private intervalLabel(sec: number): string {
    if (sec === 60) return '1m';
    if (sec === 300) return '5m';
    if (sec === 900) return '15m';
    if (sec === 3600) return '1h';
    return `${sec}s`;
  }
}
