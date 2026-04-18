/**
 * Phase 3 test (DEX_TRADE.md, 2026-04-18): ruin probability monte carlo.
 */
import {
  fifoPair,
  blockBootstrap,
  runSingle,
  simulate,
} from '../scripts/ruinProbability';

describe('ruinProbability', () => {
  describe('fifoPair', () => {
    it('pairs buy → sell via entryTxSignature + strategy', () => {
      const buys = [
        { strategy: 'pure_ws_breakout', txSignature: 'b1', actualEntryPrice: 1.0, actualQuantity: 100 },
        { strategy: 'pure_ws_breakout', txSignature: 'b2', actualEntryPrice: 1.0, actualQuantity: 100 },
      ];
      const sells = [
        { strategy: 'pure_ws_breakout', entryTxSignature: 'b1', receivedSol: 150 }, // +50
        { strategy: 'pure_ws_breakout', entryTxSignature: 'b2', receivedSol: 50 },  // -50
      ];
      const pnls = fifoPair(buys, sells);
      expect(pnls).toHaveLength(2);
      expect(pnls[0]).toBeCloseTo(50, 5);
      expect(pnls[1]).toBeCloseTo(-50, 5);
    });

    it('filters by strategy', () => {
      const buys = [
        { strategy: 'cupsey_flip_10s', txSignature: 'c1', actualEntryPrice: 1, actualQuantity: 100 },
        { strategy: 'pure_ws_breakout', txSignature: 'p1', actualEntryPrice: 1, actualQuantity: 100 },
      ];
      const sells = [
        { strategy: 'cupsey_flip_10s', entryTxSignature: 'c1', receivedSol: 110 },
        { strategy: 'pure_ws_breakout', entryTxSignature: 'p1', receivedSol: 120 },
      ];
      const cupseyOnly = fifoPair(buys, sells, 'cupsey_flip_10s');
      expect(cupseyOnly).toHaveLength(1);
      expect(cupseyOnly[0]).toBeCloseTo(10, 5);
    });
  });

  describe('blockBootstrap', () => {
    it('returns requested number of trades', () => {
      const pnls = [-0.001, 0.002, -0.0005, 0.003];
      const sampled = blockBootstrap(pnls, 20, 2);
      expect(sampled).toHaveLength(20);
    });

    it('empty pnls returns empty array', () => {
      const sampled = blockBootstrap([], 10, 2);
      expect(sampled).toEqual([]);
    });

    it('preserves block continuity (block size 3)', () => {
      const pnls = [1, 2, 3, 4, 5, 6, 7, 8];
      // 여러 run 에서 블록으로 추출되면 평균은 대략 pnl 평균
      const sampled = blockBootstrap(pnls, 100, 3);
      const mean = sampled.reduce((a, b) => a + b, 0) / sampled.length;
      const popMean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
      expect(Math.abs(mean - popMean)).toBeLessThan(1); // sample mean ~ population
    });
  });

  describe('runSingle', () => {
    it('tracks max drawdown + ruin detection', () => {
      const pnls = [-0.5, -0.5, -0.5, -0.5]; // guaranteed ruin from 1.07
      const result = runSingle(pnls, {
        startSol: 1.07,
        ruinSol: 0.3,
        tradesPerRun: 4,
        blockSize: 1,
      });
      expect(result.ruined).toBe(true);
      expect(result.ruinTradeIdx).not.toBeNull();
      expect(result.endingWallet).toBeLessThan(1.07);
    });

    it('no ruin when pnl 전부 양수', () => {
      const pnls = [0.01, 0.01, 0.01];
      const result = runSingle(pnls, {
        startSol: 1.07,
        ruinSol: 0.3,
        tradesPerRun: 10,
        blockSize: 1,
      });
      expect(result.ruined).toBe(false);
      expect(result.endingWallet).toBeGreaterThan(1.07);
    });
  });

  describe('simulate — aggregate monte carlo', () => {
    it('positive expectancy distribution → low ruin probability', () => {
      const pnls = [-0.001, 0.002, -0.001, 0.002, 0.005]; // mean +0.0014
      const report = simulate(pnls, {
        ledgerDir: '',
        startSol: 1.0,
        ruinThresholdSol: 0.3,
        runs: 500,
        tradesPerRun: 100,
        blockSize: 3,
      } as any);
      expect(report.ruinProbability).toBeLessThan(0.1);
      expect(report.medianEndingWallet).toBeGreaterThan(1.0);
    });

    it('negative expectancy → high ruin probability', () => {
      const pnls = [-0.05, -0.03, -0.04, -0.02]; // all negative
      const report = simulate(pnls, {
        ledgerDir: '',
        startSol: 1.0,
        ruinThresholdSol: 0.3,
        runs: 500,
        tradesPerRun: 50,
        blockSize: 2,
      } as any);
      expect(report.ruinProbability).toBeGreaterThan(0.9); // 거의 항상 ruin
    });
  });
});
