/**
 * Helius Credit Cost catalog tests (2026-05-01, Stream A).
 *
 * 검증:
 *   - Standard RPC vs Enhanced API getParsedTransaction cost 분리 (1 vs 100)
 *   - WSS metering (2 credits / 0.1 MB)
 *   - getProgramAccounts = 10 credits
 *   - getTransactionsForAddress = 50 credits
 *   - Sender = 0 credits
 *   - fallback estimate per surface
 */

import {
  HELIUS_COST_CATALOG_VERSION,
  getCostByMethod,
  getCostByMethodAndSurface,
  estimateCostFallback,
  estimateWssCredits,
  listCatalog,
  DEFAULT_STANDARD_RPC_COST,
  DEFAULT_ENHANCED_FALLBACK_COST,
} from '../src/observability/heliusCreditCost';

describe('heliusCreditCost catalog', () => {
  describe('Standard RPC vs Enhanced API 분리', () => {
    it('getParsedTransaction (Standard RPC) = 1 credit', () => {
      const c = getCostByMethodAndSurface('getParsedTransaction', 'standard_rpc');
      expect(c).toBeDefined();
      expect(c?.creditsPerCall).toBe(1);
      expect(c?.surface).toBe('standard_rpc');
    });

    it('parseTransactions (Enhanced API) = 100 credits', () => {
      const c = getCostByMethodAndSurface('parseTransactions', 'enhanced_tx');
      expect(c).toBeDefined();
      expect(c?.creditsPerCall).toBe(100);
      expect(c?.surface).toBe('enhanced_tx');
    });

    it("getCostByMethod default 는 surface 미지정 — first match 반환", () => {
      const c = getCostByMethod('getParsedTransaction');
      expect(c).toBeDefined();
      // standard_rpc 가 먼저 등록 → first match
      expect(c?.surface).toBe('standard_rpc');
    });
  });

  describe('expensive sweep methods', () => {
    it('getProgramAccounts = 10 credits (broad sweep)', () => {
      const c = getCostByMethodAndSurface('getProgramAccounts', 'standard_rpc');
      expect(c?.creditsPerCall).toBe(10);
    });

    it('getTransactionsForAddress = 50 credits (Wallet API)', () => {
      const c = getCostByMethodAndSurface('getTransactionsForAddress', 'wallet_api');
      expect(c?.creditsPerCall).toBe(50);
    });
  });

  describe('cheap APIs', () => {
    it('Priority Fee API = 1 credit', () => {
      const c = getCostByMethodAndSurface('getPriorityFeeEstimate', 'priority_fee');
      expect(c?.creditsPerCall).toBe(1);
    });

    it('Sender = 0 credits (execution feature)', () => {
      const c = getCostByMethodAndSurface('sender_send', 'sender');
      expect(c?.creditsPerCall).toBe(0);
    });

    it('Webhook event = 1 credit', () => {
      const c = getCostByMethodAndSurface('webhook_event', 'webhook');
      expect(c?.creditsPerCall).toBe(1);
    });

    it('DAS API = 10 credits', () => {
      const c = getCostByMethodAndSurface('getAsset', 'das');
      expect(c?.creditsPerCall).toBe(10);
    });
  });

  describe('estimateWssCredits — metered byte', () => {
    it('1 byte → 2 credits (1 bucket of 0.1MB)', () => {
      expect(estimateWssCredits(1)).toBe(2);
    });

    it('exactly 100 KB (102400 bytes) → 2 credits', () => {
      expect(estimateWssCredits(100 * 1024)).toBe(2);
    });

    it('100 KB + 1 byte → 4 credits (2 buckets)', () => {
      expect(estimateWssCredits(100 * 1024 + 1)).toBe(4);
    });

    it('1 MB (1,048,576 B) → 22 credits (11 buckets, ceil of 10.24)', () => {
      // 1 MB = 1024×1024 = 1,048,576 bytes; 102,400 per bucket; ceil(10.24)=11 buckets × 2 = 22
      expect(estimateWssCredits(1024 * 1024)).toBe(22);
    });

    it('exactly 1,000,000 B → 20 credits (10 buckets, ceil of 9.77)', () => {
      // 1,000,000 / 102,400 = 9.766... → ceil 10 × 2 = 20
      expect(estimateWssCredits(1_000_000)).toBe(20);
    });

    it('0 bytes → 0 credits', () => {
      expect(estimateWssCredits(0)).toBe(0);
    });

    it('negative / NaN / Infinity → 0 credits (fail-safe)', () => {
      expect(estimateWssCredits(-100)).toBe(0);
      expect(estimateWssCredits(NaN)).toBe(0);
      expect(estimateWssCredits(Infinity)).toBe(0);
    });
  });

  describe('estimateCostFallback', () => {
    it("standard_rpc → DEFAULT_STANDARD_RPC_COST (1)", () => {
      expect(estimateCostFallback('standard_rpc')).toBe(DEFAULT_STANDARD_RPC_COST);
      expect(DEFAULT_STANDARD_RPC_COST).toBe(1);
    });

    it("enhanced_tx → DEFAULT_ENHANCED_FALLBACK_COST (100)", () => {
      expect(estimateCostFallback('enhanced_tx')).toBe(DEFAULT_ENHANCED_FALLBACK_COST);
      expect(DEFAULT_ENHANCED_FALLBACK_COST).toBe(100);
    });

    it('das → 10', () => {
      expect(estimateCostFallback('das')).toBe(10);
    });

    it('wallet_api → 50', () => {
      expect(estimateCostFallback('wallet_api')).toBe(50);
    });

    it('priority_fee → 1', () => {
      expect(estimateCostFallback('priority_fee')).toBe(1);
    });

    it('sender → 0', () => {
      expect(estimateCostFallback('sender')).toBe(0);
    });

    it('wss → 0 (byte 기반 별도 계산)', () => {
      expect(estimateCostFallback('wss')).toBe(0);
    });
  });

  describe('catalog 정합성', () => {
    it("HELIUS_COST_CATALOG_VERSION = 'helius-cost-catalog/v1'", () => {
      expect(HELIUS_COST_CATALOG_VERSION).toBe('helius-cost-catalog/v1');
    });

    it('catalog 가 비어있지 않음', () => {
      expect(listCatalog().length).toBeGreaterThan(0);
    });

    it('모든 catalog entry 가 method + surface + creditsPerCall 보유', () => {
      for (const entry of listCatalog()) {
        expect(entry.method.length).toBeGreaterThan(0);
        expect(entry.surface).toBeDefined();
        expect(typeof entry.creditsPerCall).toBe('number');
        expect(Number.isFinite(entry.creditsPerCall)).toBe(true);
        expect(entry.creditsPerCall).toBeGreaterThanOrEqual(0);
      }
    });

    it('미등록 method → undefined', () => {
      const c = getCostByMethodAndSurface('nonExistentMethod', 'standard_rpc');
      expect(c).toBeUndefined();
    });
  });
});
