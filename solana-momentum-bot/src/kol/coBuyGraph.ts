/**
 * KOL Co-Buy Graph & Community Detection (Option 5, 2026-04-29)
 *
 * Why
 *   현재 `kolAntiCorrelationMs=60s` simple time-dedup 만 적용. 같은 community 의 KOL 들이
 *   chain forward 시 효과적 dedup 안 됨 (예: alpha → squad 들이 시차를 두고 추격).
 *   co-buy graph 기반 community detection 으로 N_eff (effective independent count) 산출.
 *
 * Algorithm (first-pass)
 *   1) 모든 KOL pair 에 대해 windowMs 윈도우 내 동일 mint co-buy count 측정.
 *   2) weight ≥ minEdgeWeight 인 edge 만 유지.
 *   3) Connected components = communities (Louvain 의 단순화 — graph dense 하지 않으므로 OK).
 *   4) N_eff = Σ (1 / |community|) over communities containing kolIds.
 *   추후 modularity-based Louvain 으로 upgrade 가능.
 *
 * 복잡도
 *   O(n × k²) 허용. n = tx count, k = unique KOL count (≤ 50 expected).
 *   실제 구현은 mint→KOL 시간순 list 로 묶어 O(Σ_mint k_mint² + E) → 통상 더 작다.
 *
 * Pure functions only — testable, no I/O.
 *
 * 사용처
 *   - `kol/scoring.ts`: KolDiscoveryScore.effectiveIndependentCount 산출
 *   - `scripts/kol-community-analyzer.ts`: 운영자 review 용 dump
 */
import type { KolTx } from './types';

export interface CoBuyEdge {
  /** sorted lexicographically (kolA <= kolB) — undirected edge canonical key */
  kolA: string;
  kolB: string;
  /** windowMs 내 동일 mint co-buy 발생 횟수 */
  weight: number;
}

export interface KolCommunity {
  /** 알파벳 정렬된 첫 멤버를 id 로 사용 (deterministic, stable) */
  communityId: string;
  /** 정렬된 멤버 KOL id 목록 */
  members: string[];
}

export interface CoBuyGraphConfig {
  /** Co-buy 윈도우 (ms). 기본 5분 — 같은 mint 에 5분 내 진입한 두 KOL 은 1회 co-buy. */
  windowMs: number;
  /** Edge weight 최소 임계 (≥). 미만은 noise 로 폐기. 기본 3. */
  minEdgeWeight: number;
}

export const DEFAULT_COBUY_GRAPH_CONFIG: CoBuyGraphConfig = {
  windowMs: 5 * 60 * 1000,
  minEdgeWeight: 3,
};

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Co-buy graph 빌드 + community 추출.
 *
 * 입력은 buy 액션만 의미 있음 (sell 은 무시). recentKolTxs 는 시간 정렬 안 되어도 됨.
 * 동일 KOL 이 같은 mint 를 여러 번 buy 하면 "최초 진입 시간"만 count (multi-buy 부풀림 방지).
 */
export function buildCoBuyGraph(
  recentKolTxs: KolTx[],
  config: Partial<CoBuyGraphConfig> = {}
): { edges: CoBuyEdge[]; communities: KolCommunity[] } {
  const cfg = { ...DEFAULT_COBUY_GRAPH_CONFIG, ...config };

  // Step 1: mint 별 KOL → "최초 buy timestamp" 맵 구성.
  // Why: 동일 KOL 의 multi-buy 가 같은 community pair 의 weight 를 부풀리는 것을 방지.
  const buysByMint = new Map<string, Map<string, number>>();
  for (const tx of recentKolTxs) {
    if (tx.action !== 'buy') continue;
    if (!tx.tokenMint || !tx.kolId) continue;
    let perKol = buysByMint.get(tx.tokenMint);
    if (!perKol) {
      perKol = new Map();
      buysByMint.set(tx.tokenMint, perKol);
    }
    const prev = perKol.get(tx.kolId);
    if (prev === undefined || tx.timestamp < prev) {
      perKol.set(tx.kolId, tx.timestamp);
    }
  }

  // Step 2: mint 별로 windowMs 내 KOL pair 의 co-buy count 누적.
  const edgeWeights = new Map<string, number>(); // key = "kolA||kolB" (sorted)
  for (const perKol of buysByMint.values()) {
    if (perKol.size < 2) continue;
    const entries = [...perKol.entries()].sort((a, b) => a[1] - b[1]); // by timestamp asc
    // pair-wise sweep — k_mint 작으므로 O(k_mint^2) 허용.
    for (let i = 0; i < entries.length; i += 1) {
      const [kolA, tA] = entries[i];
      for (let j = i + 1; j < entries.length; j += 1) {
        const [kolB, tB] = entries[j];
        if (tB - tA > cfg.windowMs) break; // sorted — 더 뒤는 모두 window 밖
        const key = pairKey(kolA, kolB);
        edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
      }
    }
  }

  // Step 3: threshold 적용 후 edge 목록 확정.
  const edges: CoBuyEdge[] = [];
  for (const [key, weight] of edgeWeights.entries()) {
    if (weight < cfg.minEdgeWeight) continue;
    const [kolA, kolB] = unpairKey(key);
    edges.push({ kolA, kolB, weight });
  }
  edges.sort((a, b) => (b.weight - a.weight) || a.kolA.localeCompare(b.kolA));

  // Step 4: connected components.
  const communities = detectCommunities(edges);

  return { edges, communities };
}

/**
 * Connected components on edge list — Louvain 의 단순화.
 *
 * Note: 본 함수는 edges 에 등장하는 KOL 만 community 화 한다.
 *   isolated KOL (어떤 edge 도 없음) 은 별도 community 로 취급되지 않음 →
 *   `effectiveIndependentCount` 가 미발견 KOL 을 "size 1 community" 로 가정하여 처리한다.
 */
export function detectCommunities(edges: CoBuyEdge[]): KolCommunity[] {
  // Union-Find
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) {
      const p = parent.get(root);
      if (p === undefined) {
        parent.set(root, root);
        return root;
      }
      root = p;
    }
    // path compression
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // deterministic tie-break — lexicographically smaller as root
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const e of edges) {
    if (!parent.has(e.kolA)) parent.set(e.kolA, e.kolA);
    if (!parent.has(e.kolB)) parent.set(e.kolB, e.kolB);
    union(e.kolA, e.kolB);
  }

  // Bucket members by root.
  const buckets = new Map<string, string[]>();
  for (const node of parent.keys()) {
    const root = find(node);
    let bucket = buckets.get(root);
    if (!bucket) {
      bucket = [];
      buckets.set(root, bucket);
    }
    bucket.push(node);
  }

  // 결과 정렬 (deterministic — 테스트/diff 안정).
  const communities: KolCommunity[] = [];
  for (const members of buckets.values()) {
    members.sort();
    communities.push({ communityId: members[0], members });
  }
  communities.sort((a, b) => a.communityId.localeCompare(b.communityId));
  return communities;
}

/**
 * Effective independent count.
 *
 * 정의: 각 KOL 이 속한 community 의 inverse size 의 합.
 *   - 같은 community 의 KOL k 명 → 합산 기여 = k × (1/k) = 1
 *   - 어떤 community 에도 없는 KOL → 기여 = 1 (독립으로 간주)
 * 결과: community 가 모두 size 1 이거나 미발견 → kolIds.length (기존 independentKolCount 와 동일).
 *      모든 KOL 이 같은 community → 1.
 *
 * 입력 kolIds 는 unique 가정 (호출 측이 sortedUnique). 중복 시 단순 합산되어 부풀려질 수 있음.
 */
export function effectiveIndependentCount(
  kolIds: string[],
  communities: KolCommunity[]
): number {
  if (kolIds.length === 0) return 0;
  // KOL → community size lookup
  const sizeOf = new Map<string, number>();
  for (const c of communities) {
    for (const m of c.members) {
      sizeOf.set(m, c.members.length);
    }
  }
  let neff = 0;
  for (const id of kolIds) {
    const size = sizeOf.get(id);
    if (size && size > 0) {
      neff += 1 / size;
    } else {
      // 어떤 community 에도 없음 → 독립 1 명.
      neff += 1;
    }
  }
  return neff;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function pairKey(a: string, b: string): string {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

function unpairKey(key: string): [string, string] {
  const idx = key.indexOf('||');
  return [key.slice(0, idx), key.slice(idx + 2)];
}
