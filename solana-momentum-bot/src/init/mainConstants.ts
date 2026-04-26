// index.ts main() bootstrap helpers + tunable constants.
// 모듈 레벨 — main() local closure 와 무관. config 만 의존.

import { config } from '../utils/config';

export const SCANNER_INGESTER_QUEUE_GAP_MS = 10_000;
export const REGIME_SOL_CACHE_TTL_MS = 60 * 60 * 1000;
export const REALTIME_ADMISSION_MIN_OBSERVED = 50;
export const REALTIME_ADMISSION_MIN_PARSE_RATE_PCT = 1;
export const REALTIME_ADMISSION_MIN_SKIPPED_RATE_PCT = 90;
export const REALTIME_TRIGGER_SEED_BUFFER_BARS = 4;

export function buildHeliusWsUrl(): string {
  if (config.heliusWsUrl) return config.heliusWsUrl;
  if (config.solanaRpcUrl.startsWith('https://')) {
    return `wss://${config.solanaRpcUrl.slice('https://'.length)}`;
  }
  if (config.solanaRpcUrl.startsWith('http://')) {
    return `ws://${config.solanaRpcUrl.slice('http://'.length)}`;
  }
  return config.solanaRpcUrl;
}

export function getRealtimeSeedLookbackSec(): number {
  const primaryLookbackBars = Math.max(
    config.realtimeVolumeSurgeLookback,
    config.realtimePriceBreakoutLookback
  ) + 1;
  const primaryLookbackSec =
    (primaryLookbackBars + REALTIME_TRIGGER_SEED_BUFFER_BARS) * config.realtimePrimaryIntervalSec;
  const confirmLookbackSec =
    (config.realtimeConfirmMinBars + 1) * config.realtimeConfirmIntervalSec;
  return Math.max(primaryLookbackSec, confirmLookbackSec);
}

export function formatRealtimeEligibilityContext(
  pairs: Array<{ dexId: string; quoteToken?: { address: string; symbol?: string } }>
): string {
  const dexIds = [...new Set(pairs.map((pair) => pair.dexId).filter(Boolean))].slice(0, 3);
  const quoteSymbols = [
    ...new Set(
      pairs
        .map((pair) => pair.quoteToken?.symbol ?? pair.quoteToken?.address)
        .filter((value): value is string => Boolean(value))
    ),
  ].slice(0, 3);
  const parts = [];
  if (dexIds.length > 0) parts.push(`dexId=${dexIds.join('|')}`);
  if (quoteSymbols.length > 0) parts.push(`quote=${quoteSymbols.join('|')}`);
  return parts.join(' ');
}
