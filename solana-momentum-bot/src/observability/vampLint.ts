/**
 * Vamp / Metadata Lint (2026-05-01, Decu Quality Layer Phase B.3).
 *
 * ADR §4.4 정합. name/symbol typo / duplicate metadata / image hash 측정.
 *
 * 알고리즘 (ADR 명시):
 *   - name/symbol: ASCII confusable map 정규화 후 Damerau-Levenshtein normalized similarity
 *                  threshold ≥ 0.85
 *   - metadataUri: SHA256 exact match
 *   - imageUri: URI exact + fetched content SHA256
 *   - image content: pHash 8x8 DCT hamming distance ≤ 5
 *
 * 설계:
 *   - 모든 fetch 는 background batch — entry critical path 영향 0
 *   - IPFS / metadata fetch timeout 3s
 *   - fetch 실패 시 METADATA_BROKEN_URI flag (IPFS gateway 오류 보수적 강한 flag)
 *
 * 본 모듈은 pure function (string 비교 / hash 계산) 만 — 실제 IPFS fetch /
 * pHash 계산은 별도 worker 에서 (entry path 와 분리). pHash 의존성 (sharp + dct)
 * 은 npm dep 추가 시 supply chain 위험이라, 현재 sprint 는 placeholder + URI
 * exact match 만 우선 구현. 실 image content hash 는 follow-up sprint.
 */

// ─── ASCII Confusable Map (간단 normalize) ──────────────

/** 일반적 vamp typo map. O→0, I→1, l→1, E→3, S→5, A→4, B→8 등. */
const CONFUSABLE_MAP: Record<string, string> = {
  '0': 'o', 'O': 'o',
  '1': 'l', 'I': 'l', 'L': 'l', 'l': 'l',
  '3': 'e', 'E': 'e',
  '4': 'a', 'A': 'a',
  '5': 's', 'S': 's',
  '8': 'b', 'B': 'b',
};

/**
 * ASCII confusable normalize — 비교 전 typo 변형 통일.
 * 또한 whitespace 제거 + lowercase.
 */
export function normalizeForVampCompare(s: string): string {
  if (!s) return '';
  let out = '';
  for (const c of s) {
    out += CONFUSABLE_MAP[c] ?? c.toLowerCase();
  }
  return out.replace(/\s+/g, '');
}

/**
 * Damerau-Levenshtein distance (substitution / insertion / deletion / transposition).
 * O(m × n) DP.
 */
export function damerauLevenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const m = a.length;
  const n = b.length;
  // dp[i][j] = a[0..i] / b[0..j] 의 최소 edit distance
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,           // deletion
        dp[i][j - 1] + 1,           // insertion
        dp[i - 1][j - 1] + cost,    // substitution
      );
      // transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + cost);
      }
    }
  }
  return dp[m][n];
}

/**
 * Normalized similarity (0~1, 1 = identical).
 *   sim = 1 - distance / maxLen
 * ADR threshold: ≥ 0.85 → VAMP_*_SIMILAR flag.
 */
export function normalizedSimilarity(a: string, b: string): number {
  const an = normalizeForVampCompare(a);
  const bn = normalizeForVampCompare(b);
  if (!an && !bn) return 1;
  const maxLen = Math.max(an.length, bn.length);
  if (maxLen === 0) return 1;
  const dist = damerauLevenshteinDistance(an, bn);
  return 1 - dist / maxLen;
}

// ─── Vamp / Metadata Risk Flags ────────────────────────

export interface VampInput {
  name?: string;
  symbol?: string;
  imageUri?: string;
  metadataUri?: string;
}

export interface VampThresholds {
  /** name/symbol similarity 임계 (default 0.85) */
  similarityThreshold: number;
}

export const DEFAULT_VAMP_THRESHOLDS: VampThresholds = {
  similarityThreshold: 0.85,
};

/**
 * 단순 string-only check (sync, RPC / IPFS 호출 0).
 *   - name/symbol vs known token list 의 max similarity
 *   - metadataUri / imageUri exact duplicate
 *
 * known list 는 caller 가 in-memory cache 로 주입 (운영 중인 mints).
 * 본 함수는 단순 비교 — 실제 image content hash / IPFS fetch 는 별도 worker.
 */
export function lintVampMetadata(
  input: VampInput,
  knownTokens: Array<{ name?: string; symbol?: string; imageUri?: string; metadataUri?: string; tokenMint?: string }> = [],
  thresholds: VampThresholds = DEFAULT_VAMP_THRESHOLDS,
): {
  flags: string[];
  vampSimilarityScore?: number;
  matchedMint?: string;
} {
  const flags: string[] = [];
  let maxSim = 0;
  let matchedMint: string | undefined;

  // metadata / image URI duplicate
  for (const known of knownTokens) {
    if (
      input.metadataUri && known.metadataUri &&
      input.metadataUri === known.metadataUri
    ) {
      flags.push('VAMP_DUPLICATE_METADATA');
      matchedMint = known.tokenMint;
      break;
    }
  }
  for (const known of knownTokens) {
    if (
      input.imageUri && known.imageUri &&
      input.imageUri === known.imageUri
    ) {
      if (!flags.includes('VAMP_DUPLICATE_IMAGE')) {
        flags.push('VAMP_DUPLICATE_IMAGE');
        matchedMint = matchedMint ?? known.tokenMint;
      }
      break;
    }
  }

  // name / symbol similarity
  if (input.name) {
    for (const known of knownTokens) {
      if (!known.name) continue;
      const sim = normalizedSimilarity(input.name, known.name);
      if (sim > maxSim) {
        maxSim = sim;
        matchedMint = matchedMint ?? known.tokenMint;
      }
      if (sim >= thresholds.similarityThreshold && sim < 1) {
        if (!flags.includes('VAMP_NAME_SIMILAR')) flags.push('VAMP_NAME_SIMILAR');
      }
    }
  }
  if (input.symbol) {
    for (const known of knownTokens) {
      if (!known.symbol) continue;
      const sim = normalizedSimilarity(input.symbol, known.symbol);
      if (sim > maxSim) {
        maxSim = sim;
        matchedMint = matchedMint ?? known.tokenMint;
      }
      if (sim >= thresholds.similarityThreshold && sim < 1) {
        if (!flags.includes('VAMP_SYMBOL_SIMILAR')) flags.push('VAMP_SYMBOL_SIMILAR');
      }
    }
  }

  // metadata 누락 / broken URI
  if (!input.imageUri) flags.push('METADATA_MISSING_IMAGE');
  if (input.imageUri && !isLikelyValidUri(input.imageUri)) flags.push('METADATA_BROKEN_URI');

  return {
    flags,
    vampSimilarityScore: maxSim > 0 ? maxSim : undefined,
    matchedMint,
  };
}

/** 단순 URI 유효성 — http / https / ipfs / ar prefix. ADR R5 정합 (보수적 강한 flag). */
function isLikelyValidUri(uri: string): boolean {
  if (!uri || uri.length < 5) return false;
  return /^(https?:\/\/|ipfs:\/\/|ar:\/\/|arweave:\/\/)/i.test(uri);
}
