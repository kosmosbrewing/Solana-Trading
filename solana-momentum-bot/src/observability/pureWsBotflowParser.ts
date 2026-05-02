import {
  PURE_WS_BOTFLOW_EVENT_SCHEMA_VERSION,
  type EnhancedTransactionLike,
  type PureWsBotflowEvent,
  type PureWsBotflowSide,
} from './pureWsBotflowTypes';

export function parseBotflowEventsFromEnhancedTransactions(
  txs: EnhancedTransactionLike[],
  options: { feePayerAddress?: string; minSolAmount?: number; marketAccounts?: string[]; requireFeePayerMatch?: boolean } = {},
): PureWsBotflowEvent[] {
  const minSolAmount = options.minSolAmount ?? 0.00001;
  const marketAccounts = new Set(options.marketAccounts ?? []);
  const events: PureWsBotflowEvent[] = [];
  for (const tx of txs) {
    const timestampMs = typeof tx.timestamp === 'number' ? tx.timestamp * 1000 : NaN;
    const txSignature = tx.signature ?? '';
    if (!Number.isFinite(timestampMs) || !txSignature) continue;

    const feePayer = tx.feePayer ?? options.feePayerAddress ?? '';
    if (options.requireFeePayerMatch && options.feePayerAddress && feePayer !== options.feePayerAddress) continue;
    const nativeByAccount = new Map<string, number>();
    for (const account of tx.accountData ?? []) {
      if (!account.account || typeof account.nativeBalanceChange !== 'number') continue;
      nativeByAccount.set(account.account, account.nativeBalanceChange / 1e9);
    }

    for (const [transferIndex, transfer] of (tx.tokenTransfers ?? []).entries()) {
      const event = parseTokenTransferEvent(transfer, nativeByAccount, {
        feePayer,
        marketAccounts,
        minSolAmount,
        timestampMs,
        tx,
        txSignature,
        transferIndex,
      });
      if (event) events.push(event);
    }
  }
  return events.sort((a, b) => a.timestampMs - b.timestampMs || a.eventId.localeCompare(b.eventId));
}

function parseTokenTransferEvent(
  transfer: NonNullable<EnhancedTransactionLike['tokenTransfers']>[number],
  nativeByAccount: Map<string, number>,
  ctx: {
    feePayer: string;
    marketAccounts: Set<string>;
    minSolAmount: number;
    timestampMs: number;
    tx: EnhancedTransactionLike;
    txSignature: string;
    transferIndex: number;
  },
): PureWsBotflowEvent | null {
  const tokenMint = transfer.mint ?? '';
  const fromUser = transfer.fromUserAccount ?? '';
  const toUser = transfer.toUserAccount ?? '';
  const tokenAmount = transfer.tokenAmount ?? 0;
  if (!tokenMint || !fromUser || !toUser || tokenAmount <= 0) return null;

  const fromSolDelta = nativeByAccount.get(fromUser) ?? 0;
  const toSolDelta = nativeByAccount.get(toUser) ?? 0;
  const buyByReceiver = ctx.marketAccounts.has(fromUser) && toSolDelta < -ctx.minSolAmount;
  const sellBySender = ctx.marketAccounts.has(toUser) && fromSolDelta > ctx.minSolAmount;
  const side: PureWsBotflowSide | null = buyByReceiver ? 'buy' : sellBySender ? 'sell' : null;
  if (!side) return null;

  const tradingUser = side === 'buy' ? toUser : fromUser;
  const counterparty = side === 'buy' ? fromUser : toUser;
  const solAmount = Math.abs(side === 'buy' ? toSolDelta : fromSolDelta);
  if (solAmount < ctx.minSolAmount) return null;

  return {
    schemaVersion: PURE_WS_BOTFLOW_EVENT_SCHEMA_VERSION,
    eventId: `pwbfe:${ctx.txSignature}:${ctx.transferIndex}`,
    observedAt: new Date(ctx.timestampMs).toISOString(),
    timestampMs: ctx.timestampMs,
    txSignature: ctx.txSignature,
    feePayer: ctx.feePayer,
    source: ctx.tx.source ?? 'unknown',
    txType: ctx.tx.type ?? 'unknown',
    tokenMint,
    side,
    tradingUser,
    counterparty,
    solAmount,
    tokenAmount,
    flowPriceSolPerToken: solAmount / tokenAmount,
  };
}
