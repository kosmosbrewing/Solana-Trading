/**
 * KOL Scoring tests (Option 5 Phase 1a)
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { computeKolDiscoveryScore, DEFAULT_KOL_SCORING_CONFIG } from '../src/kol/scoring';
import type { KolTx } from '../src/kol/types';

const MINT_A = 'MintA111111111111111111111111111111111111A';
const MINT_B = 'MintB111111111111111111111111111111111111B';
const NOW = Date.now();

function buy(kolId: string, tier: 'S' | 'A' | 'B', offsetMs: number, mint = MINT_A): KolTx {
  return {
    kolId,
    walletAddress: `wallet_${kolId}`,
    tier,
    tokenMint: mint,
    action: 'buy',
    timestamp: NOW - offsetMs,
    txSignature: `sig_${kolId}_${offsetMs}`,
    solAmount: 0.1,
  };
}

describe('kol/scoring', () => {
  it('빈 feed → empty score', () => {
    const s = computeKolDiscoveryScore(MINT_A, [], NOW);
    expect(s.independentKolCount).toBe(0);
    expect(s.finalScore).toBe(0);
  });

  it('단일 KOL buy → tier S 가중치 적용', () => {
    const s = computeKolDiscoveryScore(MINT_A, [buy('pain', 'S', 0)], NOW);
    expect(s.independentKolCount).toBe(1);
    expect(s.weightedScore).toBe(3.0); // S tier
    expect(s.consensusBonus).toBe(1.0); // single
    // time decay ≈ 1 (elapsed 0)
    expect(s.finalScore).toBeCloseTo(4.0, 1);
  });

  it('동일 KOL 다중 wallet 은 1명으로 집계', () => {
    const txs = [
      buy('pain', 'S', 0),
      { ...buy('pain', 'S', 1000), walletAddress: 'wallet_pain_sub' },
    ];
    const s = computeKolDiscoveryScore(MINT_A, txs, NOW);
    expect(s.independentKolCount).toBe(1);
    expect(s.weightedScore).toBe(3.0);
  });

  it('Anti-correlation: 60s 내 연속 진입 = 이전 KOL 만 유지', () => {
    // 3 KOL 이 10s, 20s, 30s 에 진입 → 모두 60s 안 → 첫 1명만 independent
    const txs = [
      buy('pain', 'S', 30_000),
      buy('dunpa', 'A', 20_000),
      buy('euris', 'A', 10_000),
    ];
    const s = computeKolDiscoveryScore(MINT_A, txs, NOW);
    expect(s.independentKolCount).toBe(1);
  });

  it('Anti-correlation: 60s 초과 간격이면 독립 판단으로 간주', () => {
    // 3 KOL 이 180s, 120s, 60s 에 진입 → 각각 60s+ 간격
    const txs = [
      buy('pain', 'S', 180_000),
      buy('dunpa', 'A', 120_000),
      buy('euris', 'A', 60_000),
    ];
    const s = computeKolDiscoveryScore(MINT_A, txs, NOW);
    expect(s.independentKolCount).toBe(3);
    expect(s.weightedScore).toBe(3.0 + 1.0 + 1.0);
    expect(s.consensusBonus).toBe(3.0); // small (2-4)
  });

  it('5명+ multi-KOL → large consensus bonus', () => {
    const txs = [
      buy('k1', 'A', 360_000),
      buy('k2', 'A', 300_000),
      buy('k3', 'A', 240_000),
      buy('k4', 'A', 180_000),
      buy('k5', 'A', 120_000),
    ];
    const s = computeKolDiscoveryScore(MINT_A, txs, NOW);
    expect(s.independentKolCount).toBe(5);
    expect(s.consensusBonus).toBe(DEFAULT_KOL_SCORING_CONFIG.consensusBonus.large);
  });

  it('시간 감쇠 — 반감기 6h', () => {
    const sixHoursMs = 6 * 60 * 60 * 1000;
    const s = computeKolDiscoveryScore(MINT_A, [buy('pain', 'S', sixHoursMs)], NOW);
    expect(s.timeDecay).toBeCloseTo(0.5, 2);
    expect(s.finalScore).toBeCloseTo((3.0 + 1.0) * 0.5, 1);
  });

  it('다른 tokenMint 의 buy 는 스코어에 포함 안 됨', () => {
    const txs = [buy('pain', 'S', 0, MINT_B)];
    const s = computeKolDiscoveryScore(MINT_A, txs, NOW);
    expect(s.independentKolCount).toBe(0);
  });

  it('Sell 액션은 스코어에서 제외', () => {
    const txs: KolTx[] = [
      { ...buy('pain', 'S', 0), action: 'sell' },
    ];
    const s = computeKolDiscoveryScore(MINT_A, txs, NOW);
    expect(s.independentKolCount).toBe(0);
  });

  it('windowMs 외의 오래된 tx 는 제외', () => {
    const oldMs = 48 * 60 * 60 * 1000; // 48h
    const s = computeKolDiscoveryScore(
      MINT_A,
      [buy('pain', 'S', oldMs)],
      NOW,
      { windowMs: 24 * 60 * 60 * 1000 }
    );
    expect(s.independentKolCount).toBe(0);
  });
});
