interface EdgeLikeTrade {
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  pnl: number;
}

export interface EdgeInputSanitizerResult<T> {
  trades: T[];
  droppedCount: number;
  keptCount: number;
}

const MAX_REASONABLE_RISK_PCT = 0.9;

export function sanitizeEdgeLikeTrades<T extends EdgeLikeTrade>(
  trades: T[]
): EdgeInputSanitizerResult<T> {
  const sanitized = trades.filter(isValidEdgeLikeTrade);
  return {
    trades: sanitized,
    droppedCount: trades.length - sanitized.length,
    keptCount: sanitized.length,
  };
}

export function isValidEdgeLikeTrade(trade: EdgeLikeTrade): boolean {
  if (!Number.isFinite(trade.entryPrice) || trade.entryPrice <= 0) return false;
  if (!Number.isFinite(trade.stopLoss) || trade.stopLoss <= 0) return false;
  if (!Number.isFinite(trade.quantity) || trade.quantity <= 0) return false;
  if (!Number.isFinite(trade.pnl)) return false;

  // Why: 현재 전략은 long-only라 stop-loss는 entry 아래에 있어야 한다.
  if (trade.stopLoss >= trade.entryPrice) return false;

  const plannedRiskPct = Math.abs(trade.entryPrice - trade.stopLoss) / trade.entryPrice;
  if (!Number.isFinite(plannedRiskPct) || plannedRiskPct <= 0) return false;

  // Why: 90%+ risk는 정상 모멘텀 주문식으로 보기 어렵고, price corruption 잔재일 가능성이 높다.
  return plannedRiskPct < MAX_REASONABLE_RISK_PCT;
}
