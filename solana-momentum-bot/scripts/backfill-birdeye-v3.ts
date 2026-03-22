#!/usr/bin/env ts-node
/**
 * Birdeye OHLCV V3 batch backfill -> CSV
 *
 * 실행:
 *   npx ts-node scripts/backfill-birdeye-v3.ts --pool-file data/pools-batch-seed-2026-03-22.txt --days 90
 *   npx ts-node scripts/backfill-birdeye-v3.ts <pair_address> --days 30
 */
import * as fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { BirdeyeClient } from '../src/ingester/birdeyeClient';
import { Candle, CandleInterval } from '../src/utils/types';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const INTERVAL_MAP: Record<string, { interval: CandleInterval; sec: number }> = {
  '1m': { interval: '1m', sec: 60 },
  '5m': { interval: '5m', sec: 300 },
  '15m': { interval: '15m', sec: 900 },
  '1h': { interval: '1H', sec: 3600 },
  '4h': { interval: '4H', sec: 14400 },
};

const MAX_V3_RECORDS = 5000;

async function main() {
  const args = process.argv.slice(2);
  const pairAddress = args.find(a => !a.startsWith('--'));
  const poolFile = getArg(args, '--pool-file');
  const intervalStr = (getArg(args, '--interval') || '5m').toLowerCase();
  const days = Number(getArg(args, '--days') || '90');
  const outputDir = getArg(args, '--output') || path.resolve(__dirname, '../data');
  const sleepMs = Number(getArg(args, '--sleep-ms') || '250');

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

  const addresses = loadAddresses(pairAddress, poolFile);
  if (addresses.length === 0) {
    console.error('No pair addresses provided. Use <pair_address> or --pool-file <path>.');
    process.exit(1);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const client = new BirdeyeClient(apiKey);
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 24 * 3600;
  const chunkSec = (MAX_V3_RECORDS - 1) * mapping.sec;

  console.log(`Birdeye V3 backfill | pairs=${addresses.length} | interval=${mapping.interval} | days=${days}`);

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];
    console.log(`\n[${i + 1}/${addresses.length}] ${address}`);

    try {
      const candles = await fetchRange(client, address, mapping.interval, from, now, chunkSec);
      if (candles.length === 0) {
        console.log('  no candles');
        continue;
      }

      const filename = `${address}_${mapping.sec}.csv`;
      const filepath = path.join(outputDir, filename);
      saveCsv(filepath, candles);

      const start = candles[0].timestamp.toISOString().slice(0, 16).replace('T', ' ');
      const end = candles[candles.length - 1].timestamp.toISOString().slice(0, 16).replace('T', ' ');
      console.log(`  saved ${candles.length} candles -> ${filename}`);
      console.log(`  range ${start} -> ${end}`);
    } catch (error) {
      console.error(`  failed: ${error instanceof Error ? error.message : error}`);
    }

    if (i + 1 < addresses.length) {
      await sleep(sleepMs);
    }
  }
}

async function fetchRange(
  client: BirdeyeClient,
  address: string,
  interval: CandleInterval,
  from: number,
  to: number,
  chunkSec: number
): Promise<Candle[]> {
  const merged = new Map<number, Candle>();
  let cursor = from;

  while (cursor <= to) {
    const chunkTo = Math.min(cursor + chunkSec, to);
    const candles = await client.getOHLCVV3Pair(address, interval, cursor, chunkTo);

    for (const candle of candles) {
      merged.set(candle.timestamp.getTime(), candle);
    }

    console.log(`  fetched ${candles.length} candles (${new Date(cursor * 1000).toISOString().slice(0, 10)})`);

    if (chunkTo >= to) break;
    cursor = chunkTo + intervalToSec(interval);
    await sleep(200);
  }

  return [...merged.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

function loadAddresses(pairAddress?: string, poolFile?: string): string[] {
  if (pairAddress) return [pairAddress];
  if (!poolFile) return [];

  const filePath = path.resolve(poolFile);
  if (!fs.existsSync(filePath)) {
    console.error(`Pool file not found: ${filePath}`);
    process.exit(1);
  }

  return fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.split('#')[0].trim())
    .filter(Boolean)
    .map(line => line.split(/[,\s]+/)[0])
    .filter(Boolean);
}

function saveCsv(filepath: string, candles: Candle[]): void {
  const header = 'timestamp,open,high,low,close,volume,trade_count,buy_volume,sell_volume';
  const rows = candles.map(c => [
    Math.floor(c.timestamp.getTime() / 1000),
    c.open,
    c.high,
    c.low,
    c.close,
    c.volume,
    c.tradeCount,
    c.buyVolume,
    c.sellVolume,
  ].join(','));
  fs.writeFileSync(filepath, [header, ...rows].join('\n') + '\n', 'utf-8');
}

function intervalToSec(interval: CandleInterval): number {
  return Object.values(INTERVAL_MAP).find(v => v.interval === interval)?.sec || 300;
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  console.error('Birdeye v3 backfill failed:', error);
  process.exit(1);
});
