export type LiveAssetStatus =
  | 'closed_but_balance_remaining'
  | 'open_with_balance'
  | 'open_but_zero_balance'
  | 'unknown_residual'
  | 'ok_zero';

export interface LiveAssetLedgerBuy {
  positionId?: string;
  txSignature?: string;
  strategy?: string;
  pairAddress?: string;
  tokenMint?: string;
  tokenSymbol?: string;
  actualQuantity?: number;
  actualOutUiAmount?: number;
  actualEntryPrice?: number;
  plannedEntryPrice?: number;
  recordedAt?: string;
}

export interface LiveAssetLedgerSell {
  positionId?: string;
  txSignature?: string;
  entryTxSignature?: string;
  strategy?: string;
  pairAddress?: string;
  tokenMint?: string;
  tokenSymbol?: string;
  exitReason?: string;
  recordedAt?: string;
}

export interface LiveAssetKolLiveTrade {
  positionId?: string;
  tokenMint?: string;
  pairAddress?: string;
  tokenSymbol?: string;
  entryTxSignature?: string;
  exitTxSignature?: string;
  exitReason?: string;
  armName?: string;
  openedAt?: string;
  closedAt?: string;
  entryTimeSec?: number;
  exitTimeSec?: number;
  entryPrice?: number;
  entryPriceTokenOnly?: number;
  quantity?: number;
  ticketSol?: number;
  netSol?: number;
}

export interface LiveWalletTokenBalance {
  mint: string;
  raw: string;
  uiAmount: number;
  decimals: number;
  tokenAccounts: string[];
}

export interface LiveAssetReconcileRow {
  mint: string;
  symbol: string | null;
  status: LiveAssetStatus;
  walletRaw: string;
  walletUiAmount: number;
  decimals: number;
  tokenAccounts: string[];
  buyCount: number;
  sellCount: number;
  liveCloseCount: number;
  openBuyCount: number;
  latestBuyAt: string | null;
  latestCloseAt: string | null;
  latestPositionId: string | null;
  latestEntryTxSignature: string | null;
  latestExitTxSignature: string | null;
  latestExitReason: string | null;
  latestArmName: string | null;
  estimatedEntryValueSol: number | null;
  recommendedAction: 'operator_cleanup_review' | 'watch_open_position' | 'manual_ledger_review' | 'none';
}

export interface LiveAssetReconcileSummary {
  generatedAt: string;
  walletAddress: string;
  totalRows: number;
  anomalyRows: number;
  byStatus: Record<LiveAssetStatus, number>;
  rows: LiveAssetReconcileRow[];
}
