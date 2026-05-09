import type {
  LiveAssetKolLiveTrade,
  LiveAssetLedgerBuy,
  LiveAssetLedgerSell,
  LiveAssetReconcileRow,
  LiveAssetReconcileSummary,
  LiveAssetStatus,
  LiveWalletTokenBalance,
} from './liveAssetReconcilerTypes';

export type {
  LiveAssetKolLiveTrade,
  LiveAssetLedgerBuy,
  LiveAssetLedgerSell,
  LiveAssetReconcileRow,
  LiveAssetReconcileSummary,
  LiveAssetStatus,
  LiveWalletTokenBalance,
} from './liveAssetReconcilerTypes';

interface MintContext {
  buys: LiveAssetLedgerBuy[];
  sells: LiveAssetLedgerSell[];
  liveTrades: LiveAssetKolLiveTrade[];
  wallet?: LiveWalletTokenBalance;
}

const ZERO_STATUS_COUNTS: Record<LiveAssetStatus, number> = {
  closed_but_balance_remaining: 0,
  open_with_balance: 0,
  open_but_zero_balance: 0,
  unknown_residual: 0,
  ok_zero: 0,
};

function mintFrom(row: { pairAddress?: string; tokenMint?: string }): string | null {
  const mint = row.pairAddress ?? row.tokenMint;
  return typeof mint === 'string' && mint.length > 0 ? mint : null;
}

function timeMs(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestByTime<T>(rows: T[], getTime: (row: T) => number): T | null {
  let latest: T | null = null;
  let latestMs = -1;
  for (const row of rows) {
    const ms = getTime(row);
    if (ms >= latestMs) {
      latest = row;
      latestMs = ms;
    }
  }
  return latest;
}

function addContext(map: Map<string, MintContext>, mint: string): MintContext {
  let ctx = map.get(mint);
  if (!ctx) {
    ctx = { buys: [], sells: [], liveTrades: [] };
    map.set(mint, ctx);
  }
  return ctx;
}

function chooseSymbol(ctx: MintContext): string | null {
  return (
    latestByTime(ctx.liveTrades, (row) => timeMs(row.closedAt ?? row.openedAt))?.tokenSymbol ??
    latestByTime(ctx.sells, (row) => timeMs(row.recordedAt))?.tokenSymbol ??
    latestByTime(ctx.buys, (row) => timeMs(row.recordedAt))?.tokenSymbol ??
    null
  );
}

function buildClosedEntrySet(ctx: MintContext): Set<string> {
  const closed = new Set<string>();
  for (const sell of ctx.sells) {
    if (sell.entryTxSignature) closed.add(sell.entryTxSignature);
  }
  for (const trade of ctx.liveTrades) {
    if (trade.entryTxSignature && isClosedLiveTrade(trade)) {
      closed.add(trade.entryTxSignature);
    }
  }
  return closed;
}

function isClosedLiveTrade(trade: LiveAssetKolLiveTrade): boolean {
  return Boolean(trade.closedAt || trade.exitTimeSec || trade.exitReason || trade.exitTxSignature);
}

function estimateEntryValueSol(ctx: MintContext, walletUiAmount: number): number | null {
  if (walletUiAmount <= 0) return null;
  const latestLive = latestByTime(ctx.liveTrades, (row) => timeMs(row.closedAt ?? row.openedAt));
  const livePrice = latestLive?.entryPriceTokenOnly ?? latestLive?.entryPrice;
  if (typeof livePrice === 'number' && livePrice > 0) return walletUiAmount * livePrice;

  const latestBuy = latestByTime(ctx.buys, (row) => timeMs(row.recordedAt));
  const buyPrice = latestBuy?.actualEntryPrice ?? latestBuy?.plannedEntryPrice;
  if (typeof buyPrice === 'number' && buyPrice > 0) return walletUiAmount * buyPrice;
  return null;
}

function classifyStatus(params: {
  walletRaw: bigint;
  openBuyCount: number;
  closedCount: number;
}): LiveAssetStatus {
  const { walletRaw, openBuyCount, closedCount } = params;
  if (walletRaw > 0n) {
    if (closedCount > 0 && openBuyCount === 0) return 'closed_but_balance_remaining';
    if (openBuyCount > 0) return 'open_with_balance';
    return 'unknown_residual';
  }
  if (openBuyCount > 0) return 'open_but_zero_balance';
  return 'ok_zero';
}

function recommendedAction(status: LiveAssetStatus): LiveAssetReconcileRow['recommendedAction'] {
  if (status === 'closed_but_balance_remaining') return 'operator_cleanup_review';
  if (status === 'open_with_balance') return 'watch_open_position';
  if (status === 'open_but_zero_balance' || status === 'unknown_residual') return 'manual_ledger_review';
  return 'none';
}

export function buildLiveAssetReconcileReport(input: {
  walletAddress: string;
  walletBalances: LiveWalletTokenBalance[];
  buys: LiveAssetLedgerBuy[];
  sells: LiveAssetLedgerSell[];
  liveTrades: LiveAssetKolLiveTrade[];
  generatedAt?: string;
}): LiveAssetReconcileSummary {
  const contexts = new Map<string, MintContext>();

  for (const balance of input.walletBalances) {
    addContext(contexts, balance.mint).wallet = balance;
  }
  for (const buy of input.buys) {
    const mint = mintFrom(buy);
    if (mint) addContext(contexts, mint).buys.push(buy);
  }
  for (const sell of input.sells) {
    const mint = mintFrom(sell);
    if (mint) addContext(contexts, mint).sells.push(sell);
  }
  for (const trade of input.liveTrades) {
    const mint = mintFrom(trade);
    if (mint) addContext(contexts, mint).liveTrades.push(trade);
  }

  const rows: LiveAssetReconcileRow[] = [];
  for (const [mint, ctx] of contexts) {
    const wallet = ctx.wallet ?? {
      mint,
      raw: '0',
      uiAmount: 0,
      decimals: 0,
      tokenAccounts: [],
    };
    let walletRaw = 0n;
    try {
      walletRaw = BigInt(wallet.raw);
    } catch {
      walletRaw = wallet.uiAmount > 0 ? 1n : 0n;
    }
    const closedEntryTxs = buildClosedEntrySet(ctx);
    const openBuys = ctx.buys.filter((buy) => buy.txSignature && !closedEntryTxs.has(buy.txSignature));
    const latestBuy = latestByTime(ctx.buys, (row) => timeMs(row.recordedAt));
    const latestLive = latestByTime(ctx.liveTrades, (row) => timeMs(row.closedAt ?? row.openedAt));
    const latestSell = latestByTime(ctx.sells, (row) => timeMs(row.recordedAt));
    const latestCloseAt = latestLive?.closedAt ?? latestSell?.recordedAt ?? null;
    const latestPositionId = latestLive?.positionId ?? latestSell?.positionId ?? latestBuy?.positionId ?? null;
    const latestEntryTxSignature = latestLive?.entryTxSignature ?? latestSell?.entryTxSignature ?? latestBuy?.txSignature ?? null;
    const latestExitTxSignature = latestLive?.exitTxSignature ?? latestSell?.txSignature ?? null;
    const latestExitReason = latestLive?.exitReason ?? latestSell?.exitReason ?? null;
    const status = classifyStatus({
      walletRaw,
      openBuyCount: openBuys.length,
      closedCount: closedEntryTxs.size,
    });

    rows.push({
      mint,
      symbol: chooseSymbol(ctx),
      status,
      walletRaw: wallet.raw,
      walletUiAmount: wallet.uiAmount,
      decimals: wallet.decimals,
      tokenAccounts: wallet.tokenAccounts,
      buyCount: ctx.buys.length,
      sellCount: ctx.sells.length,
      liveCloseCount: ctx.liveTrades.filter(isClosedLiveTrade).length,
      openBuyCount: openBuys.length,
      latestBuyAt: latestBuy?.recordedAt ?? null,
      latestCloseAt,
      latestPositionId,
      latestEntryTxSignature,
      latestExitTxSignature,
      latestExitReason,
      latestArmName: latestLive?.armName ?? null,
      estimatedEntryValueSol: estimateEntryValueSol(ctx, wallet.uiAmount),
      recommendedAction: recommendedAction(status),
    });
  }

  rows.sort((a, b) => {
    const statusRank = (row: LiveAssetReconcileRow) => {
      if (row.status === 'closed_but_balance_remaining') return 0;
      if (row.status === 'open_but_zero_balance') return 1;
      if (row.status === 'unknown_residual') return 2;
      if (row.status === 'open_with_balance') return 3;
      return 4;
    };
    return statusRank(a) - statusRank(b) || b.walletUiAmount - a.walletUiAmount;
  });

  const byStatus = { ...ZERO_STATUS_COUNTS };
  for (const row of rows) byStatus[row.status] += 1;
  const anomalyRows = rows.filter((row) =>
    row.status === 'closed_but_balance_remaining' ||
    row.status === 'open_but_zero_balance' ||
    row.status === 'unknown_residual'
  ).length;

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    walletAddress: input.walletAddress,
    totalRows: rows.length,
    anomalyRows,
    byStatus,
    rows,
  };
}
