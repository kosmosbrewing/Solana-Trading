import { CandleInterval } from '../utils/types';

export interface DirectionalVolumeBucket {
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
}

type RawBirdeyeTrade = Record<string, unknown>;
type TradeSide = 'buy' | 'sell';
type BirdeyeInterval = Exclude<CandleInterval, '5s' | '15s'>;

const INTERVAL_TO_SECONDS: Record<BirdeyeInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1H': 3600,
  '4H': 14400,
};

const TIMESTAMP_KEYS = ['blockUnixTime', 'block_unix_time', 'unixTime', 'txTime', 'timestamp'];
const SIDE_KEYS = ['side', 'txType', 'tx_type', 'type'];
const VOLUME_KEYS = ['volumeUSD', 'volumeUsd', 'volume_usd', 'amountUSD', 'amountUsd', 'valueUsd', 'value'];

export function buildDirectionalVolumeBuckets(
  trades: RawBirdeyeTrade[],
  intervalType: CandleInterval
): Map<number, DirectionalVolumeBucket> {
  const intervalSec = INTERVAL_TO_SECONDS[intervalType as BirdeyeInterval];
  if (!intervalSec) return new Map();
  const buckets = new Map<number, DirectionalVolumeBucket>();

  for (const trade of trades) {
    const timestamp = readTradeTimestamp(trade);
    const side = readTradeSide(trade);
    const volumeUsd = readTradeVolumeUsd(trade);

    if (timestamp === undefined || side === undefined || volumeUsd === undefined || volumeUsd <= 0) {
      continue;
    }

    const bucketUnixTime = Math.floor(timestamp / intervalSec) * intervalSec;
    const bucket = buckets.get(bucketUnixTime) || { buyVolume: 0, sellVolume: 0, tradeCount: 0 };

    if (side === 'buy') bucket.buyVolume += volumeUsd;
    else bucket.sellVolume += volumeUsd;
    bucket.tradeCount += 1;

    buckets.set(bucketUnixTime, bucket);
  }

  return buckets;
}

function readTradeTimestamp(trade: RawBirdeyeTrade): number | undefined {
  for (const key of TIMESTAMP_KEYS) {
    const value = readNumber(trade[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readTradeSide(trade: RawBirdeyeTrade): TradeSide | undefined {
  for (const key of SIDE_KEYS) {
    const value = trade[key];
    if (typeof value !== 'string') continue;

    const normalized = value.toLowerCase();
    if (normalized.includes('buy')) return 'buy';
    if (normalized.includes('sell')) return 'sell';
  }
  return undefined;
}

function readTradeVolumeUsd(trade: RawBirdeyeTrade): number | undefined {
  for (const key of VOLUME_KEYS) {
    const value = readNumber(trade[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}
