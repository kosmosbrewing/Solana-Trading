/**
 * Birdeye 캔들 데이터 수집 → CSV 저장
 *
 * 실행:
 *   npx ts-node scripts/fetch-candles.ts <pair_address> [--interval 5m] [--days 7] [--output ./data]
 */
import * as fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { BirdeyeClient } from '../src/ingester/birdeyeClient';
import { CandleInterval } from '../src/utils/types';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const INTERVAL_MAP: Record<string, { interval: CandleInterval; sec: number }> = {
  '1m': { interval: '1m', sec: 60 },
  '5m': { interval: '5m', sec: 300 },
  '15m': { interval: '15m', sec: 900 },
  '1h': { interval: '1H', sec: 3600 },
};

async function main() {
  const args = process.argv.slice(2);
  const pairAddress = args.find(a => !a.startsWith('--'));
  if (!pairAddress) {
    console.error('Usage: npx ts-node scripts/fetch-candles.ts <pair_address> [--interval 5m] [--days 7] [--output ./data]');
    process.exit(1);
  }

  const intervalStr = getArg(args, '--interval') || '5m';
  const days = Number(getArg(args, '--days') || '7');
  const outputDir = getArg(args, '--output') || path.resolve(__dirname, '../data');

  const mapping = INTERVAL_MAP[intervalStr];
  if (!mapping) {
    console.error(`Invalid interval: ${intervalStr}. Use: ${Object.keys(INTERVAL_MAP).join(', ')}`);
    process.exit(1);
  }

  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    console.error('BIRDEYE_API_KEY not set in .env');
    process.exit(1);
  }

  const client = new BirdeyeClient(apiKey);

  // Calculate time range
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 24 * 3600;

  console.log(`Fetching ${intervalStr} candles for ${pairAddress}`);
  console.log(`  Period: ${days} days (${new Date(from * 1000).toISOString()} → now)`);

  // Fetch in chunks (Birdeye API limits ~1000 candles per call)
  const maxCandlesPerCall = 1000;
  const intervalSec = mapping.sec;
  const chunkDuration = maxCandlesPerCall * intervalSec;

  const allRows: string[] = [];
  let cursor = from;

  while (cursor < now) {
    const chunkEnd = Math.min(cursor + chunkDuration, now);
    try {
      const candles = await client.getOHLCV(
        pairAddress,
        mapping.interval,
        cursor,
        chunkEnd
      );

      for (const c of candles) {
        allRows.push(
          [
            Math.floor(c.timestamp.getTime() / 1000),
            c.open, c.high, c.low, c.close, c.volume, c.tradeCount,
          ].join(',')
        );
      }

      console.log(`  Fetched ${candles.length} candles (${new Date(cursor * 1000).toISOString().slice(0, 10)})`);
    } catch (error) {
      console.error(`  Error fetching chunk: ${error}`);
    }

    cursor = chunkEnd;

    // Rate limiting
    await sleep(200);
  }

  // Deduplicate by timestamp
  const seen = new Set<string>();
  const uniqueRows = allRows.filter(row => {
    const ts = row.split(',')[0];
    if (seen.has(ts)) return false;
    seen.add(ts);
    return true;
  });

  // Write CSV
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filename = `${pairAddress}_${intervalStr}.csv`;
  const filepath = path.join(outputDir, filename);

  const header = 'timestamp,open,high,low,close,volume,trade_count';
  fs.writeFileSync(filepath, [header, ...uniqueRows].join('\n') + '\n');

  console.log(`\nSaved ${uniqueRows.length} candles to ${filepath}`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  console.error('Fetch failed:', error);
  process.exit(1);
});
