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

  // 2026-04-07 — P1c fake-fill fallback 필터
  // Jupiter Ultra 가 outputAmountResult=0 을 반환 → currentPrice fallback 으로 인해
  // 양수 PnL 을 가진 fake-fill 이 edge input 오염을 일으키던 경로를 차단한다.
  describe('fake_fill_slippage filter (P1c)', () => {
    it('drops trades with exitAnomalyReason even when PnL is positive', () => {
      const trade = {
        ...baseTrade,
        pnl: 0.35,
        exitAnomalyReason: 'fake_fill_no_received(closeTrade),slippage_saturated=10000bps',
      };
      expect(validateEdgeLikeTradeReason(trade)).toBe('fake_fill_slippage');
    });

    it('drops trades with exit slippage >= 9000bps regardless of PnL sign', () => {
      const winningFakeFill = { ...baseTrade, pnl: 0.42, exitSlippageBps: 10000 };
      const losingFakeFill = { ...baseTrade, pnl: -0.1, exitSlippageBps: 9500 };
      expect(validateEdgeLikeTradeReason(winningFakeFill)).toBe('fake_fill_slippage');
      expect(validateEdgeLikeTradeReason(losingFakeFill)).toBe('fake_fill_slippage');
    });

    it('keeps trades with exit slippage just below the 9000bps floor', () => {
      const trade = { ...baseTrade, exitSlippageBps: 8999 };
      expect(validateEdgeLikeTradeReason(trade)).toBeNull();
    });

    it('precedes tp_negative_pnl check so winning fake fills are not missed', () => {
      // exitReason TAKE_PROFIT_1 + negative PnL would normally be tp_negative_pnl,
      // but slippage saturation is a more fundamental contamination signal.
      const trade = {
        ...baseTrade,
        pnl: -0.08,
        exitReason: 'TAKE_PROFIT_1',
        exitSlippageBps: 10000,
      };
      expect(validateEdgeLikeTradeReason(trade)).toBe('fake_fill_slippage');
    });

    it('surfaces fake_fill_slippage in sanitizeEdgeLikeTrades drop breakdown', () => {
      const trades = [
        { ...baseTrade },
        { ...baseTrade, pnl: 0.3, exitSlippageBps: 10000 },
        { ...baseTrade, pnl: 0.15, exitAnomalyReason: 'fake_fill_no_received(tp1_partial)' },
      ];
      const result = sanitizeEdgeLikeTrades(trades);
      expect(result.keptCount).toBe(1);
      expect(result.droppedCount).toBe(2);
      expect(result.dropReasonCounts).toMatchObject({ fake_fill_slippage: 2 });
    });
  });
});
