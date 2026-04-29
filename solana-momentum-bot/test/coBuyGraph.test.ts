/**
 * KOL Co-Buy Graph & Community Detection tests (Option 5, 2026-04-29)
 *
 * Why: same-community KOL chain forward dedup. simple anti-correlation 60s 만으로는 부족.
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  buildCoBuyGraph,
  detectCommunities,
  effectiveIndependentCount,
  DEFAULT_COBUY_GRAPH_CONFIG,
} from '../src/kol/coBuyGraph';
import type { KolTx } from '../src/kol/types';

const NOW = Date.now();

function buy(kolId: string, mint: string, offsetMs: number, tier: 'S' | 'A' | 'B' = 'A'): KolTx {
  return {
    kolId,
    walletAddress: `wallet_${kolId}`,
    tier,
    tokenMint: mint,
    action: 'buy',
    timestamp: NOW - offsetMs,
    txSignature: `sig_${kolId}_${mint}_${offsetMs}`,
    solAmount: 0.1,
  };
}

describe('kol/coBuyGraph', () => {
  describe('buildCoBuyGraph', () => {
    it('빈 입력 → edges=[] communities=[]', () => {
      const { edges, communities } = buildCoBuyGraph([]);
      expect(edges).toHaveLength(0);
      expect(communities).toHaveLength(0);
    });

    it('동일 mint 의 same-community 5명 (3+2) 시나리오', () => {
      // Group X: x1, x2, x3 — 4 mints 에 모두 함께 진입 (≥3 threshold pass)
      // Group Y: y1, y2 — 4 mints 에 함께 진입
      // X 와 Y 는 같은 mint 진입 없음 → 독립 community.
      const txs: KolTx[] = [];
      const mintsX = ['MX1', 'MX2', 'MX3', 'MX4'];
      const mintsY = ['MY1', 'MY2', 'MY3', 'MY4'];
      mintsX.forEach((mint, i) => {
        const base = i * 60_000; // 1분 spacing — windowMs(5분) 안에서 stale 안 되도록
        txs.push(buy('x1', mint, base));
        txs.push(buy('x2', mint, base + 1_000));
        txs.push(buy('x3', mint, base + 2_000));
      });
      mintsY.forEach((mint, i) => {
        const base = i * 60_000;
        txs.push(buy('y1', mint, base));
        txs.push(buy('y2', mint, base + 1_000));
      });

      const { edges, communities } = buildCoBuyGraph(txs, { minEdgeWeight: 3 });

      // Group X edges: x1-x2, x1-x3, x2-x3 each weight 4 (mint 4개)
      // Group Y edge: y1-y2 weight 4
      expect(edges.length).toBe(4);
      // 모두 weight = 4 (mint 4개)
      expect(edges.every((e) => e.weight === 4)).toBe(true);

      expect(communities).toHaveLength(2);
      const x = communities.find((c) => c.members.includes('x1'))!;
      const y = communities.find((c) => c.members.includes('y1'))!;
      expect(x.members.sort()).toEqual(['x1', 'x2', 'x3']);
      expect(y.members.sort()).toEqual(['y1', 'y2']);
    });

    it('threshold 미달 edge 는 제거 — minEdgeWeight=3 일 때 weight 2 edge 누락', () => {
      const txs: KolTx[] = [];
      // a-b 는 2 mint 만 함께 (weight=2 → 미달)
      ['M1', 'M2'].forEach((m, i) => {
        const t = i * 60_000;
        txs.push(buy('a', m, t));
        txs.push(buy('b', m, t + 1_000));
      });
      // c-d 는 3 mint 함께 (weight=3 → pass)
      ['M3', 'M4', 'M5'].forEach((m, i) => {
        const t = i * 60_000;
        txs.push(buy('c', m, t));
        txs.push(buy('d', m, t + 1_000));
      });

      const { edges, communities } = buildCoBuyGraph(txs, { minEdgeWeight: 3 });
      expect(edges.find((e) => e.kolA === 'a' || e.kolB === 'a')).toBeUndefined();
      const cd = edges.find(
        (e) => (e.kolA === 'c' && e.kolB === 'd') || (e.kolA === 'd' && e.kolB === 'c')
      );
      expect(cd).toBeDefined();
      expect(cd!.weight).toBe(3);

      // c, d 는 community / a, b 는 isolated → community 1개만 등장
      expect(communities).toHaveLength(1);
      expect(communities[0].members.sort()).toEqual(['c', 'd']);
    });

    it('windowMs 밖 co-buy 는 무시 — A 진입 후 6분 뒤 B 진입은 co-buy 아님', () => {
      const txs: KolTx[] = [];
      // 3 mint 에 a, b 가 모두 진입하지만 매번 6분 간격 → window(5분) 밖
      ['M1', 'M2', 'M3'].forEach((m, i) => {
        const base = i * 60 * 60 * 1000; // 1h spacing — mint 끼리 간섭 방지
        txs.push(buy('a', m, base));
        txs.push(buy('b', m, base + 6 * 60 * 1000));
      });
      const { edges } = buildCoBuyGraph(txs, { windowMs: 5 * 60 * 1000, minEdgeWeight: 1 });
      expect(edges).toHaveLength(0);
    });

    it('동일 KOL 의 multi-buy 는 weight 부풀림 없음 (1회만 count)', () => {
      const txs: KolTx[] = [];
      // mint M1 에 a 가 3번 buy / b 가 2번 buy → 그래도 co-buy weight = 1 (mint 1개)
      txs.push(buy('a', 'M1', 0));
      txs.push(buy('a', 'M1', 1_000));
      txs.push(buy('a', 'M1', 2_000));
      txs.push(buy('b', 'M1', 1_500));
      txs.push(buy('b', 'M1', 2_500));
      const { edges } = buildCoBuyGraph(txs, { minEdgeWeight: 1 });
      expect(edges).toHaveLength(1);
      expect(edges[0].weight).toBe(1);
    });

    it('sell 액션은 graph 에서 제외', () => {
      const txs: KolTx[] = [
        { ...buy('a', 'M1', 0), action: 'sell' },
        { ...buy('b', 'M1', 1_000), action: 'sell' },
      ];
      const { edges } = buildCoBuyGraph(txs, { minEdgeWeight: 1 });
      expect(edges).toHaveLength(0);
    });
  });

  describe('detectCommunities', () => {
    it('chained edges → single community (transitive closure)', () => {
      const communities = detectCommunities([
        { kolA: 'a', kolB: 'b', weight: 5 },
        { kolA: 'b', kolB: 'c', weight: 5 },
        { kolA: 'c', kolB: 'd', weight: 5 },
      ]);
      expect(communities).toHaveLength(1);
      expect(communities[0].members.sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('disjoint edges → multiple communities', () => {
      const communities = detectCommunities([
        { kolA: 'a', kolB: 'b', weight: 5 },
        { kolA: 'c', kolB: 'd', weight: 5 },
      ]);
      expect(communities).toHaveLength(2);
    });
  });

  describe('effectiveIndependentCount', () => {
    it('빈 kolIds → 0', () => {
      expect(effectiveIndependentCount([], [])).toBe(0);
    });

    it('모두 같은 community → N_eff = 1.0', () => {
      const communities = [{ communityId: 'a', members: ['a', 'b', 'c'] }];
      expect(effectiveIndependentCount(['a', 'b', 'c'], communities)).toBeCloseTo(1.0, 6);
    });

    it('모두 독립 (community 미발견) → N_eff = N', () => {
      // 어떤 KOL 도 community 에 등장 안 함 → 각각 1
      expect(effectiveIndependentCount(['a', 'b', 'c'], [])).toBeCloseTo(3.0, 6);
    });

    it('mixed: 3 명 community + 2 독립 → 1.0 + 2 = 3.0', () => {
      const communities = [{ communityId: 'a', members: ['a', 'b', 'c'] }];
      const neff = effectiveIndependentCount(['a', 'b', 'c', 'd', 'e'], communities);
      expect(neff).toBeCloseTo(3.0, 6);
    });

    it('두 community (3+2) 모두 참여 → 1.0 + 1.0 = 2.0', () => {
      const communities = [
        { communityId: 'a', members: ['a', 'b', 'c'] },
        { communityId: 'd', members: ['d', 'e'] },
      ];
      const neff = effectiveIndependentCount(['a', 'b', 'c', 'd', 'e'], communities);
      expect(neff).toBeCloseTo(2.0, 6);
    });

    it('일부만 참여 (community 멤버 일부) → 정확히 합산', () => {
      // community {a,b,c}, kolIds = [a, b] → 1/3 + 1/3 = 0.667
      const communities = [{ communityId: 'a', members: ['a', 'b', 'c'] }];
      const neff = effectiveIndependentCount(['a', 'b'], communities);
      expect(neff).toBeCloseTo(2 / 3, 6);
    });
  });

  describe('DEFAULT_COBUY_GRAPH_CONFIG', () => {
    it('default windowMs=5min / minEdgeWeight=3', () => {
      expect(DEFAULT_COBUY_GRAPH_CONFIG.windowMs).toBe(5 * 60 * 1000);
      expect(DEFAULT_COBUY_GRAPH_CONFIG.minEdgeWeight).toBe(3);
    });
  });
});
