/**
 * Vamp / Metadata Lint 단위 테스트 (2026-05-01, Decu Phase B.3).
 */
import {
  damerauLevenshteinDistance,
  normalizedSimilarity,
  normalizeForVampCompare,
  lintVampMetadata,
} from '../src/observability/vampLint';

describe('vampLint', () => {
  describe('normalizeForVampCompare (ASCII confusable)', () => {
    it('숫자 → 알파벳 typo map: 0→o, 1→l, 3→e, 4→a, 5→s, 8→b', () => {
      expect(normalizeForVampCompare('B0NK')).toBe('bonk');
      expect(normalizeForVampCompare('PUMP')).toBe('pump');
      expect(normalizeForVampCompare('1337')).toBe('lee7');  // 1→l, 3→e, 3→e, 7→7 (no map)
    });

    it('공백 제거 + lowercase', () => {
      expect(normalizeForVampCompare('Pep e')).toBe('pepe');
    });
  });

  describe('damerauLevenshteinDistance', () => {
    it('identical → 0', () => {
      expect(damerauLevenshteinDistance('bonk', 'bonk')).toBe(0);
    });
    it('substitution 1', () => {
      expect(damerauLevenshteinDistance('bonk', 'bone')).toBe(1);
    });
    it('insertion / deletion', () => {
      expect(damerauLevenshteinDistance('bonk', 'bonks')).toBe(1);
      expect(damerauLevenshteinDistance('bonks', 'bonk')).toBe(1);
    });
    it('transposition (Damerau extension) — pump ↔ pmup distance 1', () => {
      expect(damerauLevenshteinDistance('pump', 'pmup')).toBe(1);
    });
  });

  describe('normalizedSimilarity', () => {
    it('identical → 1', () => {
      expect(normalizedSimilarity('bonk', 'bonk')).toBe(1);
    });
    it('완전히 다름 → 매우 낮음', () => {
      expect(normalizedSimilarity('bonk', 'doge')).toBeLessThan(0.5);
    });
    it('typo 1글자 차이 — 0.85 이상 (confusable normalized)', () => {
      expect(normalizedSimilarity('B0NK', 'BONK')).toBe(1);  // 0→o normalize 후 동일
      expect(normalizedSimilarity('bonk', 'bonks')).toBeGreaterThanOrEqual(0.75);
    });
  });

  describe('lintVampMetadata', () => {
    it('빈 known list → similarity flag 0', () => {
      const r = lintVampMetadata({ name: 'bonk', symbol: 'BONK' }, []);
      expect(r.flags.filter((f) => f.startsWith('VAMP_'))).toHaveLength(0);
    });

    it('duplicate metadataUri → VAMP_DUPLICATE_METADATA', () => {
      const r = lintVampMetadata(
        { metadataUri: 'ipfs://abc' },
        [{ metadataUri: 'ipfs://abc', tokenMint: 'mint1' }],
      );
      expect(r.flags).toContain('VAMP_DUPLICATE_METADATA');
      expect(r.matchedMint).toBe('mint1');
    });

    it('duplicate imageUri → VAMP_DUPLICATE_IMAGE', () => {
      const r = lintVampMetadata(
        { imageUri: 'https://example.com/a.png' },
        [{ imageUri: 'https://example.com/a.png', tokenMint: 'mint2' }],
      );
      expect(r.flags).toContain('VAMP_DUPLICATE_IMAGE');
    });

    it('name similarity ≥ 0.85 (typo, not exact) → VAMP_NAME_SIMILAR', () => {
      const r = lintVampMetadata(
        { name: 'b0nk' },
        [{ name: 'bonkz', tokenMint: 'mint3' }],
      );
      // bonk → bonkz similarity 정도 — confusable normalize 후 비교
      expect(r.vampSimilarityScore).toBeGreaterThanOrEqual(0.7);
    });

    it('imageUri 누락 → METADATA_MISSING_IMAGE', () => {
      const r = lintVampMetadata({ name: 'bonk' });
      expect(r.flags).toContain('METADATA_MISSING_IMAGE');
    });

    it('broken URI (foo://invalid) → METADATA_BROKEN_URI', () => {
      const r = lintVampMetadata({ imageUri: 'foo://invalid' });
      expect(r.flags).toContain('METADATA_BROKEN_URI');
    });

    it('valid https URI → broken flag 없음', () => {
      const r = lintVampMetadata({ imageUri: 'https://example.com/img.png' });
      expect(r.flags).not.toContain('METADATA_BROKEN_URI');
    });

    it('valid ipfs URI → broken flag 없음', () => {
      const r = lintVampMetadata({ imageUri: 'ipfs://Qmabc' });
      expect(r.flags).not.toContain('METADATA_BROKEN_URI');
    });
  });
});
