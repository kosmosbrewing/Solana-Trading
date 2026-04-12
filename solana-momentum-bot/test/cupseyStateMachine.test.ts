import {
  CupseyReplayConfig,
  CupseyReplayPosition,
  CupseyTradeResult,
  defaultCupseyReplayConfig,
  tryOpenCupseyPosition,
  tickCupseyPositions,
  forceCloseAll,
} from '../src/backtest/cupseyStateMachine';

function makeConfig(overrides: Partial<CupseyReplayConfig> = {}): CupseyReplayConfig {
  return {
    stalkWindowSec: 20,
    stalkDropPct: 0.005,
    stalkMaxDropPct: 0.015,
    probeWindowSec: 45,
    probeMfeThreshold: 0.020,
    probeHardCutPct: 0.008,
    winnerMaxHoldSec: 720,
    winnerTrailingPct: 0.040,
    winnerBreakevenPct: 0.005,
    maxConcurrent: 5,
    roundTripCostPct: 0.0045,
    ...overrides,
  };
}

describe('cupseyStateMachine', () => {
  describe('defaultCupseyReplayConfig', () => {
    it('returns valid config from tradingParams', () => {
      const config = defaultCupseyReplayConfig();
      expect(config.stalkWindowSec).toBe(20);
      expect(config.stalkDropPct).toBe(0.005);
      expect(config.probeMfeThreshold).toBe(0.020);
      expect(config.winnerBreakevenPct).toBe(0.005);
      expect(config.winnerTrailingPct).toBe(0.040);
      expect(config.winnerMaxHoldSec).toBe(720);
      expect(config.probeWindowSec).toBe(45);
      expect(config.roundTripCostPct).toBeGreaterThan(0);
    });
  });

  describe('tryOpenCupseyPosition', () => {
    it('creates STALK position on new signal', () => {
      const positions: CupseyReplayPosition[] = [];
      const config = makeConfig();
      const result = tryOpenCupseyPosition(
        positions,
        { pairAddress: 'AAAA1111', price: 1.0 },
        1000,
        config
      );
      expect(result).not.toBeNull();
      expect(result!.state).toBe('STALK');
      expect(result!.signalPrice).toBe(1.0);
      expect(positions).toHaveLength(1);
    });

    it('rejects duplicate pair', () => {
      const positions: CupseyReplayPosition[] = [];
      const config = makeConfig();
      tryOpenCupseyPosition(positions, { pairAddress: 'AAAA1111', price: 1.0 }, 1000, config);
      const result = tryOpenCupseyPosition(positions, { pairAddress: 'AAAA1111', price: 1.1 }, 1005, config);
      expect(result).toBeNull();
      expect(positions).toHaveLength(1);
    });

    it('rejects when max concurrent reached', () => {
      const positions: CupseyReplayPosition[] = [];
      const config = makeConfig({ maxConcurrent: 1 });
      tryOpenCupseyPosition(positions, { pairAddress: 'AAAA1111', price: 1.0 }, 1000, config);
      const result = tryOpenCupseyPosition(positions, { pairAddress: 'BBBB2222', price: 2.0 }, 1005, config);
      expect(result).toBeNull();
      expect(positions).toHaveLength(1);
    });
  });

  describe('STALK transitions', () => {
    it('STALK → PROBE on pullback', () => {
      const positions: CupseyReplayPosition[] = [];
      const config = makeConfig({ stalkDropPct: 0.01 });
      const completed: CupseyTradeResult[] = [];

      tryOpenCupseyPosition(positions, { pairAddress: 'PAIR', price: 100 }, 1000, config);

      // Price drops 1% → triggers STALK → PROBE
      tickCupseyPositions(positions, 'PAIR', 99.0, 1005, config, completed);
      expect(completed).toHaveLength(0);
      expect(positions[0].state).toBe('PROBE');
      expect(positions[0].entryPrice).toBe(99.0);
      expect(positions[0].entryTimeSec).toBe(1005);
    });

    it('STALK → STALK_TIMEOUT on no pullback', () => {
      const positions: CupseyReplayPosition[] = [];
      const config = makeConfig({ stalkWindowSec: 10 });
      const completed: CupseyTradeResult[] = [];

      tryOpenCupseyPosition(positions, { pairAddress: 'PAIR', price: 100 }, 1000, config);

      // Price stays flat past window
      tickCupseyPositions(positions, 'PAIR', 100.5, 1010, config, completed);
      expect(completed).toHaveLength(1);
      expect(completed[0].exitReason).toBe('STALK_TIMEOUT');
      expect(completed[0].stalkSkip).toBe(true);
      expect(completed[0].entryPrice).toBe(0);
      expect(positions).toHaveLength(0);
    });

    it('STALK → STALK_CRASH on deep drop', () => {
      const positions: CupseyReplayPosition[] = [];
      const config = makeConfig({ stalkMaxDropPct: 0.01 });
      const completed: CupseyTradeResult[] = [];

      tryOpenCupseyPosition(positions, { pairAddress: 'PAIR', price: 100 }, 1000, config);

      // Price crashes -2%
      tickCupseyPositions(positions, 'PAIR', 98.0, 1005, config, completed);
      expect(completed).toHaveLength(1);
      expect(completed[0].exitReason).toBe('STALK_CRASH');
      expect(completed[0].stalkSkip).toBe(true);
    });
  });

  describe('PROBE transitions', () => {
    function setupProbePosition(config: CupseyReplayConfig): {
      positions: CupseyReplayPosition[];
      completed: CupseyTradeResult[];
    } {
      const positions: CupseyReplayPosition[] = [];
      const completed: CupseyTradeResult[] = [];
      // Create and move to PROBE
      tryOpenCupseyPosition(positions, { pairAddress: 'PAIR', price: 100 }, 1000, config);
      // Why: stalkDropPct + 0.001 to avoid floating-point boundary issues
      tickCupseyPositions(positions, 'PAIR', 100 * (1 - config.stalkDropPct - 0.001), 1002, config, completed);
      expect(positions[0].state).toBe('PROBE');
      return { positions, completed };
    }

    it('PROBE → WINNER on MFE threshold', () => {
      const config = makeConfig({ probeMfeThreshold: 0.005 });
      const { positions, completed } = setupProbePosition(config);
      const entryPrice = positions[0].entryPrice;

      // Price rises above MFE threshold
      tickCupseyPositions(positions, 'PAIR', entryPrice * 1.006, 1010, config, completed);
      expect(positions[0].state).toBe('WINNER');
      expect(completed).toHaveLength(0);
    });

    it('PROBE → REJECT_HARD_CUT on MAE', () => {
      const config = makeConfig({ probeHardCutPct: 0.01 });
      const { positions, completed } = setupProbePosition(config);
      const entryPrice = positions[0].entryPrice;

      // Price drops below hard cut
      tickCupseyPositions(positions, 'PAIR', entryPrice * 0.989, 1010, config, completed);
      expect(completed).toHaveLength(1);
      expect(completed[0].exitReason).toBe('REJECT_HARD_CUT');
      expect(completed[0].stalkSkip).toBe(false);
      expect(completed[0].netPnlPct).toBeLessThan(0);
    });

    it('PROBE → REJECT_TIMEOUT on expiry', () => {
      const config = makeConfig({ probeWindowSec: 10 });
      const { positions, completed } = setupProbePosition(config);
      const entryPrice = positions[0].entryPrice;
      const entryTime = positions[0].entryTimeSec;

      // No momentum, just flat until timeout
      tickCupseyPositions(positions, 'PAIR', entryPrice * 1.0001, entryTime + 10, config, completed);
      expect(completed).toHaveLength(1);
      expect(completed[0].exitReason).toBe('REJECT_TIMEOUT');
    });
  });

  describe('WINNER transitions', () => {
    function setupWinnerPosition(config: CupseyReplayConfig): {
      positions: CupseyReplayPosition[];
      completed: CupseyTradeResult[];
      entryPrice: number;
      entryTime: number;
    } {
      const positions: CupseyReplayPosition[] = [];
      const completed: CupseyTradeResult[] = [];
      tryOpenCupseyPosition(positions, { pairAddress: 'PAIR', price: 100 }, 1000, config);
      // STALK → PROBE (margin beyond threshold)
      tickCupseyPositions(positions, 'PAIR', 100 * (1 - config.stalkDropPct - 0.001), 1002, config, completed);
      const entryPrice = positions[0].entryPrice;
      const entryTime = positions[0].entryTimeSec;
      // PROBE → WINNER (margin beyond threshold)
      tickCupseyPositions(positions, 'PAIR', entryPrice * (1 + config.probeMfeThreshold + 0.001), 1010, config, completed);
      expect(positions[0].state).toBe('WINNER');
      return { positions, completed, entryPrice, entryTime };
    }

    it('WINNER → WINNER_TIME_STOP on max hold', () => {
      const config = makeConfig({ winnerMaxHoldSec: 60 });
      const { positions, completed, entryPrice, entryTime } = setupWinnerPosition(config);

      tickCupseyPositions(positions, 'PAIR', entryPrice * 1.01, entryTime + 60, config, completed);
      expect(completed).toHaveLength(1);
      expect(completed[0].exitReason).toBe('WINNER_TIME_STOP');
    });

    it('WINNER → WINNER_TRAILING on drop from peak', () => {
      const config = makeConfig({ winnerTrailingPct: 0.02 });
      const { positions, completed, entryPrice } = setupWinnerPosition(config);

      // Push price up to create peak
      tickCupseyPositions(positions, 'PAIR', entryPrice * 1.05, 1020, config, completed);
      expect(positions[0].peakPrice).toBeCloseTo(entryPrice * 1.05, 4);

      // Drop 2% from peak → trailing triggers
      tickCupseyPositions(positions, 'PAIR', entryPrice * 1.05 * 0.979, 1030, config, completed);
      expect(completed).toHaveLength(1);
      expect(completed[0].exitReason).toBe('WINNER_TRAILING');
      expect(completed[0].netPnlPct).toBeGreaterThan(0);
    });

    it('WINNER → WINNER_BREAKEVEN when price returns to entry after high MFE', () => {
      // Why: winnerTrailingPct 을 넉넉히 설정해야 trailing 보다 breakeven 이 먼저 발동
      const config = makeConfig({ winnerBreakevenPct: 0.001, probeMfeThreshold: 0.005, winnerTrailingPct: 0.10 });
      const { positions, completed, entryPrice } = setupWinnerPosition(config);

      // Push MFE well above 2× probeMfeThreshold
      tickCupseyPositions(positions, 'PAIR', entryPrice * 1.02, 1020, config, completed);
      // Drop back to breakeven level — trailing stop at peak*0.90 is far below, so breakeven fires
      tickCupseyPositions(positions, 'PAIR', entryPrice * 1.001, 1030, config, completed);
      expect(completed).toHaveLength(1);
      expect(completed[0].exitReason).toBe('WINNER_BREAKEVEN');
    });
  });

  describe('forceCloseAll', () => {
    it('closes all remaining positions with DATA_END', () => {
      const config = makeConfig();
      const positions: CupseyReplayPosition[] = [];
      const completed: CupseyTradeResult[] = [];

      tryOpenCupseyPosition(positions, { pairAddress: 'PAIR_A', price: 100 }, 1000, config);
      // Move to PROBE
      tickCupseyPositions(positions, 'PAIR_A', 100 * (1 - config.stalkDropPct), 1002, config, completed);

      tryOpenCupseyPosition(positions, { pairAddress: 'PAIR_B', price: 50 }, 1003, config);

      const lastPrices = new Map([['PAIR_A', 101.0], ['PAIR_B', 49.0]]);
      forceCloseAll(positions, lastPrices, 2000, completed);

      expect(positions).toHaveLength(0);
      expect(completed).toHaveLength(2);
      expect(completed.every(t => t.exitReason === 'DATA_END')).toBe(true);
    });
  });

  describe('cost deduction', () => {
    it('netPnlPct accounts for roundTripCostPct', () => {
      const config = makeConfig({ roundTripCostPct: 0.005, probeHardCutPct: 0.01 });
      const positions: CupseyReplayPosition[] = [];
      const completed: CupseyTradeResult[] = [];

      tryOpenCupseyPosition(positions, { pairAddress: 'PAIR', price: 100 }, 1000, config);
      // STALK → PROBE (margin beyond threshold)
      tickCupseyPositions(positions, 'PAIR', 100 * (1 - config.stalkDropPct - 0.001), 1002, config, completed);
      expect(positions[0].state).toBe('PROBE');
      const entry = positions[0].entryPrice;

      // Drop beyond hard cut → REJECT_HARD_CUT
      tickCupseyPositions(positions, 'PAIR', entry * (1 - config.probeHardCutPct - 0.001), 1010, config, completed);
      expect(completed).toHaveLength(1);

      const trade = completed[0];
      // netPnlPct = rawPnlPct - roundTripCostPct
      expect(trade.netPnlPct).toBeCloseTo(trade.rawPnlPct - 0.005, 6);
    });
  });
});
