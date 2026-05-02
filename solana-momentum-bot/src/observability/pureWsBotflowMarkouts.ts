import {
  PURE_WS_BOTFLOW_MARKOUT_SCHEMA_VERSION,
  type BuildBotflowMarkoutsOptions,
  type PureWsBotflowCandidate,
  type PureWsBotflowEvent,
  type PureWsBotflowMarkout,
  type PureWsBotflowPricePoint,
  type PureWsBotflowQuoteStatus,
} from './pureWsBotflowTypes';

const DEFAULT_MAX_MARKOUT_LAG_MS = 2_000;

export function buildBotflowMarkouts(
  _events: PureWsBotflowEvent[],
  candidates: PureWsBotflowCandidate[],
  options: BuildBotflowMarkoutsOptions,
): PureWsBotflowMarkout[] {
  const priceByMint = groupBy(options.pricePoints ?? [], (point) => point.tokenMint);
  const maxLagMs = options.maxMarkoutLagMs ?? DEFAULT_MAX_MARKOUT_LAG_MS;
  const records: PureWsBotflowMarkout[] = [];
  for (const candidate of candidates.filter((row) => row.decision === 'observe')) {
    const prices = (priceByMint.get(candidate.tokenMint) ?? []).sort((a, b) => a.timestampMs - b.timestampMs);
    for (const horizonSec of options.horizonsSec) {
      records.push(buildMarkoutRow(candidate, prices, horizonSec, options.roundTripCostPct, maxLagMs));
    }
  }
  return records;
}

function buildMarkoutRow(
  candidate: PureWsBotflowCandidate,
  prices: PureWsBotflowPricePoint[],
  horizonSec: number,
  roundTripCostPct: number,
  maxLagMs: number,
): PureWsBotflowMarkout {
  const entryTargetMs = candidate.windowEndMs;
  const exitTargetMs = candidate.windowEndMs + horizonSec * 1000;
  const entry = findNearPrice(prices, entryTargetMs, maxLagMs);
  const exit = findNearPrice(prices, exitTargetMs, maxLagMs);
  const quoteStatus: PureWsBotflowQuoteStatus = !entry || entry.priceSol <= 0
    ? 'bad_entry_price'
    : exit
      ? 'ok'
      : 'missing_price_trajectory';
  const deltaPct = quoteStatus === 'ok' && exit
    ? (exit.priceSol / entry!.priceSol) - 1
    : undefined;
  return {
    schemaVersion: PURE_WS_BOTFLOW_MARKOUT_SCHEMA_VERSION,
    eventId: `pwbfm:${candidate.candidateId}:${horizonSec}`,
    candidateId: candidate.candidateId,
    observedAt: new Date(exitTargetMs).toISOString(),
    tokenMint: candidate.tokenMint,
    horizonSec,
    quoteStatus,
    entryPriceSol: entry?.priceSol,
    markoutPriceSol: exit?.priceSol,
    deltaPct,
    postCostDeltaPct: deltaPct == null ? undefined : deltaPct - roundTripCostPct,
    priceSource: exit?.source ?? entry?.source,
    markoutLagMs: exit ? exit.timestampMs - exitTargetMs : undefined,
  };
}

function findNearPrice(
  prices: PureWsBotflowPricePoint[],
  targetMs: number,
  maxLagMs: number,
): PureWsBotflowPricePoint | undefined {
  let best: PureWsBotflowPricePoint | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of prices) {
    const distance = Math.abs(point.timestampMs - targetMs);
    if (distance > maxLagMs) continue;
    if (distance < bestDistance || (distance === bestDistance && point.timestampMs >= targetMs)) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    out.set(key, [...(out.get(key) ?? []), item]);
  }
  return out;
}
