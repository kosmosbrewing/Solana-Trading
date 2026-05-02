import type { KolTx } from './types';

export interface PostDistributionGuardConfig {
  enabled: boolean;
  windowMs: number;
  minGrossSellSol: number;
  minDistinctSellKols: number;
  cancelQuarantineMs: number;
}

export interface PostDistributionGuardTelemetry {
  postDistributionRisk: boolean;
  blocked: boolean;
  reason: string;
  windowSec: number;
  buySol: number;
  sellSol: number;
  netSellSol: number;
  distinctBuyKols: number;
  distinctSellKols: number;
  freshIndependentBuyKols: number;
  secondsSinceLastSell: number | null;
  cancelQuarantineActive: boolean;
  priorKolSellCancelAgeSec: number | null;
}

export interface PostDistributionGuardResult {
  blocked: boolean;
  reason: string;
  flags: string[];
  telemetry: PostDistributionGuardTelemetry;
}

export interface PostDistributionGuardInput {
  tokenMint: string;
  nowMs: number;
  recentKolTxs: KolTx[];
  participatingKols: Array<{ id: string }>;
  config: PostDistributionGuardConfig;
  priorKolSellCancelAtMs?: number | null;
}

const FLAG_RISK = 'POST_DISTRIBUTION_SELL_WAVE';
const FLAG_CANCEL_QUARANTINE = 'POST_DISTRIBUTION_CANCEL_QUARANTINE';
const FLAG_BLOCK = 'POST_DISTRIBUTION_ENTRY_BLOCK';
const FLAG_PRIOR_CANCEL = 'PRIOR_KOL_SELL_CANCEL';

export function evaluatePostDistributionGuard(input: PostDistributionGuardInput): PostDistributionGuardResult {
  const cfg = input.config;
  const windowSec = Math.max(0, Math.round(cfg.windowMs / 1000));
  if (!cfg.enabled) {
    return result(false, 'disabled', [], emptyTelemetry('disabled', windowSec));
  }

  const windowStartMs = input.nowMs - cfg.windowMs;
  const rows = input.recentKolTxs.filter((tx) =>
    tx.tokenMint === input.tokenMint &&
    tx.timestamp >= windowStartMs &&
    tx.timestamp <= input.nowMs
  );

  let buySol = 0;
  let sellSol = 0;
  let lastSellMs: number | null = null;
  const buyKols = new Set<string>();
  const sellKols = new Set<string>();

  for (const tx of rows) {
    const solAmount = typeof tx.solAmount === 'number' && Number.isFinite(tx.solAmount)
      ? Math.max(0, tx.solAmount)
      : 0;
    if (tx.action === 'buy') {
      buySol += solAmount;
      buyKols.add(tx.kolId);
    } else if (tx.action === 'sell') {
      sellSol += solAmount;
      sellKols.add(tx.kolId);
      if (lastSellMs === null || tx.timestamp > lastSellMs) lastSellMs = tx.timestamp;
    }
  }

  const netSellSol = sellSol - buySol;
  const secondsSinceLastSell = lastSellMs === null
    ? null
    : Math.max(0, Math.floor((input.nowMs - lastSellMs) / 1000));
  const priorKolSellCancelAgeSec = input.priorKolSellCancelAtMs == null
    ? null
    : Math.max(0, Math.floor((input.nowMs - input.priorKolSellCancelAtMs) / 1000));
  const freshIndependentBuyKols = countFreshBuyKolsAfterLastSell(rows, input.participatingKols, lastSellMs);
  const cancelQuarantineActive =
    priorKolSellCancelAgeSec !== null &&
    cfg.cancelQuarantineMs > 0 &&
    priorKolSellCancelAgeSec * 1000 <= cfg.cancelQuarantineMs;
  const sellWave =
    sellSol >= cfg.minGrossSellSol &&
    sellKols.size >= cfg.minDistinctSellKols;
  const blocked = cancelQuarantineActive || sellWave;
  const reason = cancelQuarantineActive
    ? 'post_distribution_cancel_quarantine'
    : sellWave
      ? 'post_distribution_sell_wave'
      : 'no_post_distribution_risk';

  const telemetry: PostDistributionGuardTelemetry = {
    postDistributionRisk: blocked,
    blocked,
    reason,
    windowSec,
    buySol,
    sellSol,
    netSellSol,
    distinctBuyKols: buyKols.size,
    distinctSellKols: sellKols.size,
    freshIndependentBuyKols,
    secondsSinceLastSell,
    cancelQuarantineActive,
    priorKolSellCancelAgeSec,
  };

  const flags: string[] = [];
  if (sellWave) flags.push(FLAG_RISK);
  if (cancelQuarantineActive) flags.push(FLAG_CANCEL_QUARANTINE);
  if (telemetry.blocked) flags.push(FLAG_BLOCK);
  if (priorKolSellCancelAgeSec !== null && priorKolSellCancelAgeSec * 1000 <= cfg.cancelQuarantineMs) {
    flags.push(FLAG_PRIOR_CANCEL);
  }

  return result(telemetry.blocked, telemetry.reason, flags, telemetry);
}

function countFreshBuyKolsAfterLastSell(
  rows: KolTx[],
  participatingKols: Array<{ id: string }>,
  lastSellMs: number | null
): number {
  const participating = new Set(participatingKols.map((kol) => kol.id));
  const fresh = new Set<string>();
  for (const tx of rows) {
    if (tx.action !== 'buy') continue;
    if (!participating.has(tx.kolId)) continue;
    if (lastSellMs !== null && tx.timestamp <= lastSellMs) continue;
    fresh.add(tx.kolId);
  }
  return fresh.size;
}

function emptyTelemetry(reason: string, windowSec: number): PostDistributionGuardTelemetry {
  return {
    postDistributionRisk: false,
    blocked: false,
    reason,
    windowSec,
    buySol: 0,
    sellSol: 0,
    netSellSol: 0,
    distinctBuyKols: 0,
    distinctSellKols: 0,
    freshIndependentBuyKols: 0,
    secondsSinceLastSell: null,
    cancelQuarantineActive: false,
    priorKolSellCancelAgeSec: null,
  };
}

function result(
  blocked: boolean,
  reason: string,
  flags: string[],
  telemetry: PostDistributionGuardTelemetry
): PostDistributionGuardResult {
  return { blocked, reason, flags, telemetry };
}
