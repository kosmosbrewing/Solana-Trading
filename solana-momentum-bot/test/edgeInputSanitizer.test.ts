import {
  sanitizeEdgeLikeTrades,
  isValidEdgeLikeTrade,
  validateEdgeLikeTradeReason,
} from '../src/reporting/edgeInputSanitizer';

// Phase B1 — CRITICAL_LIVE 원장 정합성 sanitizer 검증

describe('edgeInputSanitizer (Phase B1)', () => {
  const baseTrade = {
    entryPrice: 1.0,
    stopLoss: 0.95,
    quantity: 10,
    pnl: 0.2,
  };

  it('accepts healthy trades with no optional context', () => {
    expect(isValidEdgeLikeTrade(baseTrade)).toBe(true);
    expect(validateEdgeLikeTradeReason(baseTrade)).toBeNull();
  });

  it('rejects trades where stopLoss >= entry', () => {
    const trade = { ...baseTrade, stopLoss: 1.05 };
    expect(validateEdgeLikeTradeReason(trade)).toBe('stop_above_entry');
  });

  it('rejects trades where plannedRisk >= 90%', () => {
    const trade = { ...baseTrade, stopLoss: 0.05 }; // 95% risk
    expect(validateEdgeLikeTradeReason(trade)).toBe('risk_pct_too_high');
  });

  it('rejects trades whose planned vs actual entry ratio is outside [0.5, 2.0]', () => {
    // BTW 케이스 재현: planned=0.815, entry=0.00000122
    const trade = {
      ...baseTrade,
      entryPrice: 0.00000122,
      stopLoss: 0.00000100,
      plannedEntryPrice: 0.81549236,
    };
    expect(validateEdgeLikeTradeReason(trade)).toBe('planned_entry_ratio_corrupt');
  });

  it('accepts trades within planned ratio band', () => {
    const trade = {
      ...baseTrade,
      entryPrice: 1.05,
      stopLoss: 0.95,
      plannedEntryPrice: 1.0,
    };
    expect(validateEdgeLikeTradeReason(trade)).toBeNull();
  });

  it('rejects TAKE_PROFIT_1 with negative PnL (P0-C contamination)', () => {
    const trade = { ...baseTrade, pnl: -0.05, exitReason: 'TAKE_PROFIT_1' };
    expect(validateEdgeLikeTradeReason(trade)).toBe('tp_negative_pnl');
  });

  it('rejects TAKE_PROFIT_2 with negative PnL', () => {
    const trade = { ...baseTrade, pnl: -0.05, exitReason: 'TAKE_PROFIT_2' };
    expect(validateEdgeLikeTradeReason(trade)).toBe('tp_negative_pnl');
  });

  it('accepts TAKE_PROFIT_2 with positive PnL', () => {
    const trade = { ...baseTrade, pnl: 0.15, exitReason: 'TAKE_PROFIT_2' };
    expect(validateEdgeLikeTradeReason(trade)).toBeNull();
  });

  it('accepts STOP_LOSS with negative PnL (normal losing trade)', () => {
    const trade = { ...baseTrade, pnl: -0.05, exitReason: 'STOP_LOSS' };
    expect(validateEdgeLikeTradeReason(trade)).toBeNull();
  });

  it('returns drop reason breakdown via sanitizeEdgeLikeTrades', () => {
    const trades = [
      { ...baseTrade },
      { ...baseTrade, stopLoss: 1.05 }, // stop_above_entry
      { ...baseTrade, pnl: -0.1, exitReason: 'TAKE_PROFIT_2' }, // tp_negative_pnl
      { ...baseTrade, entryPrice: 0.001, plannedEntryPrice: 1.0, stopLoss: 0.0005 }, // planned_entry_ratio_corrupt
    ];

    const result = sanitizeEdgeLikeTrades(trades);
    expect(result.keptCount).toBe(1);
    expect(result.droppedCount).toBe(3);
    expect(result.dropReasonCounts).toMatchObject({
      stop_above_entry: 1,
      tp_negative_pnl: 1,
      planned_entry_ratio_corrupt: 1,
    });
  });

  it('preserves backward compat with old EdgeLikeTrade shape (no optional fields)', () => {
    const trades = [baseTrade, { ...baseTrade, pnl: -0.1 }];
    const result = sanitizeEdgeLikeTrades(trades);
    expect(result.keptCount).toBe(2);
    expect(result.droppedCount).toBe(0);
  });
});
