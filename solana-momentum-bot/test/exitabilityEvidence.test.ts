/**
 * exitabilityEvidence join tests (2026-05-01, Helius Stream B).
 */

import {
  joinExitabilityEvidence,
} from '../src/observability/exitabilityEvidence';

describe('joinExitabilityEvidence — 3 evidence join (observe-only)', () => {
  describe('reason 분기', () => {
    it('evidence 0 (모든 입력 미공급) → insufficient_evidence + EXIT_LIQUIDITY_UNKNOWN + POOL_NOT_PREWARMED', () => {
      const r = joinExitabilityEvidence({});
      expect(r.reason).toBe('insufficient_evidence');
      expect(r.sellRouteKnown).toBe(false);
      expect(r.poolKnown).toBe(false);
      expect(r.recentSwapCoverage).toBe('unknown');
      expect(r.riskFlags).toContain('EXIT_LIQUIDITY_UNKNOWN');
      expect(r.riskFlags).toContain('POOL_NOT_PREWARMED');
      expect(r.exitLiquidityUsd).toBeNull();
    });

    it('quote received + pool known + active swaps → evidence_complete + flags 0', () => {
      const r = joinExitabilityEvidence({
        sellQuote: { received: true, estimatedSolOut: 0.05 },
        poolRegistry: { knownPoolCount: 2, primaryPool: 'PoolXYZ' },
        recentSwapCoverage: { windowSec: 300, swapCount: 10 },
      });
      expect(r.reason).toBe('evidence_complete');
      expect(r.sellRouteKnown).toBe(true);
      expect(r.poolKnown).toBe(true);
      expect(r.recentSwapCoverage).toBe('active');
      expect(r.riskFlags).toEqual([]);
    });

    it('pool only (no quote) → pool_only_no_quote, sellRouteKnown=true (pool fallback)', () => {
      const r = joinExitabilityEvidence({
        sellQuote: { received: false, failureReason: 'no_route' },
        poolRegistry: { knownPoolCount: 1 },
      });
      expect(r.reason).toBe('pool_only_no_quote');
      expect(r.sellRouteKnown).toBe(true); // pool 만 있어도 route 인정
      expect(r.poolKnown).toBe(true);
      expect(r.riskFlags).not.toContain('POOL_NOT_PREWARMED');
    });

    it('quote only (no pool) → quote_only_no_pool, POOL_NOT_PREWARMED', () => {
      const r = joinExitabilityEvidence({
        sellQuote: { received: true, estimatedSolOut: 0.01 },
        poolRegistry: { knownPoolCount: 0 },
      });
      expect(r.reason).toBe('quote_only_no_pool');
      expect(r.sellRouteKnown).toBe(true);
      expect(r.poolKnown).toBe(false);
      expect(r.riskFlags).toContain('POOL_NOT_PREWARMED');
      expect(r.riskFlags).not.toContain('EXIT_LIQUIDITY_UNKNOWN');
    });

    it('sparse_activity (1-4 swaps) → sparse_activity reason', () => {
      const r = joinExitabilityEvidence({
        sellQuote: { received: false },
        poolRegistry: { knownPoolCount: 0 },
        recentSwapCoverage: { windowSec: 300, swapCount: 3 },
      });
      expect(r.recentSwapCoverage).toBe('sparse');
      expect(r.reason).toBe('sparse_activity');
      expect(r.sellRouteKnown).toBe(false);
      expect(r.riskFlags).toContain('EXIT_LIQUIDITY_UNKNOWN');
    });

    it('no_recent_activity (0 swaps) → no_recent_activity reason', () => {
      const r = joinExitabilityEvidence({
        sellQuote: { received: false },
        poolRegistry: { knownPoolCount: 0 },
        recentSwapCoverage: { windowSec: 300, swapCount: 0 },
      });
      expect(r.recentSwapCoverage).toBe('none');
      expect(r.reason).toBe('no_recent_activity');
    });
  });

  describe('coverage 분류', () => {
    it.each([
      [0, 'none'],
      [1, 'sparse'],
      [4, 'sparse'],
      [5, 'active'],
      [100, 'active'],
    ])('swapCount %d → %s', (count, expected) => {
      const r = joinExitabilityEvidence({
        recentSwapCoverage: { windowSec: 300, swapCount: count },
      });
      expect(r.recentSwapCoverage).toBe(expected);
    });

    it('NaN swapCount → unknown', () => {
      const r = joinExitabilityEvidence({
        recentSwapCoverage: { windowSec: 300, swapCount: NaN },
      });
      expect(r.recentSwapCoverage).toBe('unknown');
    });
  });

  describe('exitLiquidityUsd null 보장 (Stream B step 3 정책)', () => {
    it('quote estimatedSolOut 0.05 + 활발한 swap 있어도 USD null 유지 (price source 미invent)', () => {
      const r = joinExitabilityEvidence({
        sellQuote: { received: true, estimatedSolOut: 0.05 },
        poolRegistry: { knownPoolCount: 3 },
        recentSwapCoverage: { windowSec: 300, swapCount: 50 },
      });
      expect(r.exitLiquidityUsd).toBeNull();
    });
  });

  describe('riskFlags 산출', () => {
    it('sellRouteKnown=false + poolKnown=false → 양 flag', () => {
      const r = joinExitabilityEvidence({
        sellQuote: { received: false },
        poolRegistry: { knownPoolCount: 0 },
      });
      expect(r.riskFlags).toContain('EXIT_LIQUIDITY_UNKNOWN');
      expect(r.riskFlags).toContain('POOL_NOT_PREWARMED');
    });

    it('insufficient_evidence (입력 0) → 양 flag', () => {
      const r = joinExitabilityEvidence({});
      expect(r.riskFlags.length).toBe(2);
    });

    it('evidence_complete → flag 0', () => {
      const r = joinExitabilityEvidence({
        sellQuote: { received: true },
        poolRegistry: { knownPoolCount: 1 },
        recentSwapCoverage: { windowSec: 300, swapCount: 10 },
      });
      expect(r.riskFlags.length).toBe(0);
    });
  });
});
