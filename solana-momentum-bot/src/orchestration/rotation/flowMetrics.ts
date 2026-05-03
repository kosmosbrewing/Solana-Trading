import type { KolTx } from '../../kol/types';

export type RotationFlowRiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface RotationFlowMetricsConfig {
  sellPressureWindowSec: number;
  freshTopupSec: number;
  chaseStepPct: number;
}

export interface RotationFlowMetrics {
  anchorBuySolBeforeFirstSell: number;
  anchorSellSol30: number;
  sellPressure30: number;
  firstAnchorSellAtMs: number | null;
  lastAnchorBuyAtMs: number | null;
  postEntryBuySol: number;
  postEntryTopupCount: number;
  chaseTopupCount: number;
  topupStrength: number;
  chaseTopupStrength: number;
  freshTopup: boolean;
  flowRiskLevel: RotationFlowRiskLevel;
}

export function kolTxFillPrice(tx: KolTx): number | null {
  const solAmount = typeof tx.solAmount === 'number' && Number.isFinite(tx.solAmount)
    ? tx.solAmount
    : 0;
  const tokenAmount = typeof tx.tokenAmount === 'number' && Number.isFinite(tx.tokenAmount)
    ? tx.tokenAmount
    : 0;
  if (tx.action !== 'buy' || solAmount <= 0 || tokenAmount <= 0) return null;
  return solAmount / tokenAmount;
}

function solAmount(tx: KolTx): number {
  const value = tx.solAmount;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function riskLevel(pressure: number): RotationFlowRiskLevel {
  if (pressure >= 1.2) return 'critical';
  if (pressure >= 0.8) return 'high';
  if (pressure >= 0.5) return 'medium';
  if (pressure >= 0.2) return 'low';
  return 'none';
}

export function buildRotationFlowMetrics(input: {
  rows: KolTx[];
  tokenMint: string;
  anchorKolIds: string[];
  entryAtMs: number;
  nowMs: number;
  config: RotationFlowMetricsConfig;
}): RotationFlowMetrics {
  const anchors = new Set(input.anchorKolIds.map((id) => id.toLowerCase()));
  const anchorRows = input.rows
    .filter((tx) =>
      tx.tokenMint === input.tokenMint &&
      anchors.has(tx.kolId.toLowerCase()) &&
      tx.timestamp <= input.nowMs
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  const buys = anchorRows.filter((tx) => tx.action === 'buy');
  // Wallet tracker timestamps can be block-time derived while entryAtMs is local wall-clock.
  // A small tolerance keeps same-turn sell events from being dropped by millisecond skew.
  const sellStartMs = input.entryAtMs - 5_000;
  const sells = anchorRows.filter((tx) => tx.action === 'sell' && tx.timestamp >= sellStartMs);
  const firstSell = sells[0];
  const firstAnchorSellAtMs = firstSell?.timestamp ?? null;
  const sellWindowEndMs = firstSell
    ? firstSell.timestamp + input.config.sellPressureWindowSec * 1000
    : input.nowMs;
  const anchorBuySolBeforeFirstSell = buys
    .filter((tx) => firstSell == null || tx.timestamp < firstSell.timestamp)
    .reduce((sum, tx) => sum + solAmount(tx), 0);
  const anchorSellSol30 = sells
    .filter((tx) => firstSell != null && tx.timestamp >= firstSell.timestamp && tx.timestamp <= sellWindowEndMs)
    .reduce((sum, tx) => sum + solAmount(tx), 0);
  const sellPressure30 = anchorBuySolBeforeFirstSell > 0
    ? anchorSellSol30 / anchorBuySolBeforeFirstSell
    : 0;
  const postEntryBuys = buys.filter((tx) => tx.timestamp >= input.entryAtMs);
  const postEntryBuySol = postEntryBuys.reduce((sum, tx) => sum + solAmount(tx), 0);
  const lastAnchorBuyAtMs = buys.length > 0 ? buys[buys.length - 1].timestamp : null;
  const freshTopupStartMs = input.nowMs - input.config.freshTopupSec * 1000;
  const freshTopup = postEntryBuys.some((tx) => tx.timestamp >= freshTopupStartMs);

  let chaseTopupCount = 0;
  let chaseTopupSol = 0;
  let previousPrice: number | null = null;
  for (const tx of buys) {
    const price = kolTxFillPrice(tx);
    if (price == null) continue;
    if (previousPrice != null && tx.timestamp >= input.entryAtMs) {
      const step = price / previousPrice - 1;
      if (step >= input.config.chaseStepPct) {
        chaseTopupCount += 1;
        chaseTopupSol += solAmount(tx);
      }
    }
    previousPrice = price;
  }

  return {
    anchorBuySolBeforeFirstSell,
    anchorSellSol30,
    sellPressure30,
    firstAnchorSellAtMs,
    lastAnchorBuyAtMs,
    postEntryBuySol,
    postEntryTopupCount: postEntryBuys.length,
    chaseTopupCount,
    topupStrength: anchorBuySolBeforeFirstSell > 0 ? postEntryBuySol / anchorBuySolBeforeFirstSell : 0,
    chaseTopupStrength: anchorBuySolBeforeFirstSell > 0 ? chaseTopupSol / anchorBuySolBeforeFirstSell : 0,
    freshTopup,
    flowRiskLevel: riskLevel(sellPressure30),
  };
}

export function buildRotationChaseTopupMetrics(input: {
  buys: KolTx[];
  entryAtMs: number;
  chaseStepPct: number;
}): {
  chaseTopupCount: number;
  chaseTopupSol: number;
  maxStepPct: number;
} {
  const sorted = [...input.buys].sort((a, b) => a.timestamp - b.timestamp);
  let previousPrice: number | null = null;
  let chaseTopupCount = 0;
  let chaseTopupSol = 0;
  let maxStepPct = 0;
  for (const tx of sorted) {
    const price = kolTxFillPrice(tx);
    if (price == null) continue;
    if (previousPrice != null && tx.timestamp >= input.entryAtMs) {
      const step = price / previousPrice - 1;
      maxStepPct = Math.max(maxStepPct, step);
      if (step >= input.chaseStepPct) {
        chaseTopupCount += 1;
        chaseTopupSol += solAmount(tx);
      }
    }
    previousPrice = price;
  }
  return { chaseTopupCount, chaseTopupSol, maxStepPct };
}
