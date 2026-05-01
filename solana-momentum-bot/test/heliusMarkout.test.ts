/**
 * Helius Markout schema + script tests (2026-05-01, Stream E).
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  HELIUS_MARKOUT_SCHEMA_VERSION,
  DEFAULT_HORIZONS_SEC,
  COVERAGE_INCOMPLETE_THRESHOLD,
  appendHeliusMarkout,
  computeMarkoutMetrics,
  isMarkoutComplete,
  reached5x,
  type HeliusMarkoutRecord,
} from '../src/research/heliusMarkoutTypes';
import {
  extractCloseAnchors,
  extractRejectAnchors,
  parseSince,
  parseHorizons,
} from '../scripts/kol-helius-markout-backfill';

describe('helius-markout schema + writer', () => {
  it('schema version + horizons + threshold 동결', () => {
    expect(HELIUS_MARKOUT_SCHEMA_VERSION).toBe('helius-markout/v1');
    expect(DEFAULT_HORIZONS_SEC).toEqual([60, 300, 1800]);
    expect(COVERAGE_INCOMPLETE_THRESHOLD).toBe(0.70);
  });

  describe('appendHeliusMarkout (sidecar fail-open)', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), 'helius-markout-test-'));
    });
    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('정상 row append', async () => {
      const row: HeliusMarkoutRecord = {
        schemaVersion: HELIUS_MARKOUT_SCHEMA_VERSION,
        subjectType: 'close',
        subjectId: 'pos-test-1',
        tokenMint: 'TestMint',
        anchorTsMs: 1000,
        horizonsSec: [60, 300],
        source: 'historical_rpc',
        coveragePct: 1,
        parseFailedCount: 0,
        trueMfePct: 0.5,
        trueMaePct: -0.05,
        peakAtSec: 200,
        troughAtSec: 30,
        reached5xAfterExit: false,
        reached5xBeforeExit: false,
        estimatedCredits: 2,
      };
      const r = await appendHeliusMarkout(row, { ledgerDir: tmpDir });
      expect(r.appended).toBe(true);
      const content = await readFile(path.join(tmpDir, 'helius-markouts.jsonl'), 'utf8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.subjectId).toBe('pos-test-1');
      expect(parsed.schemaVersion).toBe(HELIUS_MARKOUT_SCHEMA_VERSION);
    });
  });

  describe('computeMarkoutMetrics — pure function', () => {
    it('빈 trajectory → coverage 0', () => {
      const r = computeMarkoutMetrics(1.0, [], 3);
      expect(r.coveragePct).toBe(0);
      expect(r.trueMfePct).toBeUndefined();
    });

    it('single point at horizon[0] (1/3) → coverage ≈ 0.333', () => {
      const r = computeMarkoutMetrics(1.0, [{ relativeSec: 60, price: 1.5 }], 3);
      expect(r.coveragePct).toBeCloseTo(0.333, 2);
      expect(r.trueMfePct).toBeCloseTo(0.5, 4);
      expect(r.trueMaePct).toBeCloseTo(0.5, 4); // single point — peak = trough
    });

    it('peak/trough 분리 (3 points) — anchor=1.0, peak=2.0, trough=0.5 → MFE=1.0, MAE=-0.5', () => {
      const r = computeMarkoutMetrics(1.0, [
        { relativeSec: 60, price: 1.5 },
        { relativeSec: 300, price: 2.0 },
        { relativeSec: 1800, price: 0.5 },
      ], 3);
      expect(r.trueMfePct).toBeCloseTo(1.0, 4);
      expect(r.trueMaePct).toBeCloseTo(-0.5, 4);
      expect(r.peakAtSec).toBe(300);
      expect(r.troughAtSec).toBe(1800);
      expect(r.coveragePct).toBe(1);
    });

    it('5x peak (anchor 1.0, peak 5.0) → mfe = 4.0', () => {
      const r = computeMarkoutMetrics(1.0, [{ relativeSec: 300, price: 5.0 }], 1);
      expect(r.trueMfePct).toBeCloseTo(4.0, 4);
    });

    it('anchor 0 또는 음수 → coverage 0', () => {
      expect(computeMarkoutMetrics(0, [{ relativeSec: 60, price: 1 }], 1).coveragePct).toBe(0);
      expect(computeMarkoutMetrics(-1, [{ relativeSec: 60, price: 1 }], 1).coveragePct).toBe(0);
    });

    it('invalid points (NaN price) skip → 유효 point 만 반영', () => {
      const r = computeMarkoutMetrics(1.0, [
        { relativeSec: 60, price: NaN },
        { relativeSec: 300, price: 2.0 },
      ], 2);
      expect(r.coveragePct).toBeCloseTo(0.5, 2);
      expect(r.trueMfePct).toBeCloseTo(1.0, 4);
    });
  });

  describe('reached5x classifier', () => {
    it.each([
      [3.99, false],
      [4.0, true],
      [4.01, true],
      [10, true],
      [-0.5, false],
      [undefined, false],
      [null, false],
      [NaN, false],
    ])('mfe %s → %s', (input, expected) => {
      expect(reached5x(input as number | null | undefined)).toBe(expected);
    });
  });

  describe('isMarkoutComplete', () => {
    it('coverage 0.69 → incomplete', () => {
      const row = { coveragePct: 0.69 } as HeliusMarkoutRecord;
      expect(isMarkoutComplete(row)).toBe(false);
    });

    it('coverage 0.70 → complete (boundary)', () => {
      const row = { coveragePct: 0.70 } as HeliusMarkoutRecord;
      expect(isMarkoutComplete(row)).toBe(true);
    });

    it('coverage 1.0 → complete', () => {
      const row = { coveragePct: 1.0 } as HeliusMarkoutRecord;
      expect(isMarkoutComplete(row)).toBe(true);
    });
  });
});

describe('kol-helius-markout-backfill — input parsers', () => {
  describe('parseSince', () => {
    it('7d → ~7일 전', () => {
      const t = parseSince('7d');
      expect(Date.now() - t).toBeGreaterThanOrEqual(7 * 86400000 - 100);
      expect(Date.now() - t).toBeLessThanOrEqual(7 * 86400000 + 100);
    });

    it('24h → 24시간 전', () => {
      const t = parseSince('24h');
      expect(Date.now() - t).toBeCloseTo(24 * 3600000, -3);
    });

    it('30m → 30분 전', () => {
      const t = parseSince('30m');
      expect(Date.now() - t).toBeCloseTo(30 * 60000, -2);
    });

    it('invalid format → throw', () => {
      expect(() => parseSince('7days')).toThrow();
      expect(() => parseSince('')).toThrow();
    });
  });

  describe('parseHorizons', () => {
    it("'60,300,1800' → [60,300,1800]", () => {
      expect(parseHorizons('60,300,1800')).toEqual([60, 300, 1800]);
    });

    it('whitespace 허용', () => {
      expect(parseHorizons('60, 300 ,1800')).toEqual([60, 300, 1800]);
    });

    it('invalid 값 skip', () => {
      expect(parseHorizons('60,abc,300,-100')).toEqual([60, 300]);
    });
  });

  describe('extractCloseAnchors', () => {
    it('paper trade row → close anchor + exitOffsetSec (QA F3 fix)', () => {
      const rows = [
        {
          positionId: 'pos1',
          tokenMint: 'M1',
          entryTimeSec: 1000,
          exitTimeSec: 1200,
          entryPrice: 0.001,
        },
      ];
      const anchors = extractCloseAnchors(rows);
      expect(anchors).toHaveLength(1);
      expect(anchors[0].subjectType).toBe('close');
      expect(anchors[0].subjectId).toBe('pos1');
      expect(anchors[0].anchorTsMs).toBe(1000_000);
      // QA F3: exitOffsetSec = exitTimeSec - entryTimeSec
      expect((anchors[0] as { exitOffsetSec?: number }).exitOffsetSec).toBe(200);
    });

    it('current KOL ledger row (closedAt + holdSec) → close anchor', () => {
      const rows = [
        {
          positionId: 'pos-ledger',
          tokenMint: 'M1',
          closedAt: '2026-05-01T00:10:00.000Z',
          holdSec: 180,
          entryPriceTokenOnly: 0.0012,
          entryPrice: 0.0013,
        },
      ];
      const anchors = extractCloseAnchors(rows);
      expect(anchors).toHaveLength(1);
      expect(anchors[0].subjectId).toBe('pos-ledger');
      expect(anchors[0].anchorTsMs).toBe(Date.parse('2026-05-01T00:07:00.000Z'));
      expect(anchors[0].anchorPrice).toBe(0.0012);
      expect((anchors[0] as { exitOffsetSec?: number }).exitOffsetSec).toBe(180);
    });

    it('필수 필드 누락 → skip', () => {
      const rows = [
        { positionId: 'pos1', tokenMint: 'M1', entryPrice: 0.001 }, // entryTimeSec 누락
      ];
      expect(extractCloseAnchors(rows)).toHaveLength(0);
    });

    it('entryPrice <= 0 → skip', () => {
      const rows = [
        { positionId: 'pos1', tokenMint: 'M1', entryTimeSec: 1, exitTimeSec: 2, entryPrice: 0 },
      ];
      expect(extractCloseAnchors(rows)).toHaveLength(0);
    });
  });

  describe('extractRejectAnchors', () => {
    it('missed-alpha row (signalPrice / timestamp) → reject anchor', () => {
      const rows = [
        {
          tokenMint: 'M1',
          signalPrice: 0.005,
          timestamp: 50_000,
        },
      ];
      const anchors = extractRejectAnchors(rows);
      expect(anchors).toHaveLength(1);
      expect(anchors[0].subjectType).toBe('reject');
      expect(anchors[0].anchorPrice).toBe(0.005);
    });

    it('missed-alpha current schema (rejectedAt ISO) → reject anchor', () => {
      const rows = [
        {
          eventId: 'ma-1',
          tokenMint: 'M1',
          signalPrice: 0.004,
          rejectedAt: '2026-05-01T00:00:30.000Z',
          probe: { firedAt: '2026-05-01T00:01:30.000Z' },
        },
      ];
      const anchors = extractRejectAnchors(rows);
      expect(anchors).toHaveLength(1);
      expect(anchors[0].subjectId).toBe('ma-1');
      expect(anchors[0].anchorTsMs).toBe(Date.parse('2026-05-01T00:00:30.000Z'));
      expect(anchors[0].anchorPrice).toBe(0.004);
    });

    it('signalPrice in extras → fallback', () => {
      const rows = [
        {
          tokenMint: 'M1',
          extras: { signalPrice: 0.001 },
          observedAtMs: 100_000,
          rejectId: 'rej-abc',
        },
      ];
      const anchors = extractRejectAnchors(rows);
      expect(anchors).toHaveLength(1);
      expect(anchors[0].anchorPrice).toBe(0.001);
      expect(anchors[0].subjectId).toBe('rej-abc');
    });
  });
});
