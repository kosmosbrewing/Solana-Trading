/**
 * Missed Alpha Retrospective tests (2026-04-29)
 *
 * 검증 영역:
 *  - parseProbeJsonl: malformed line skip
 *  - groupByEvent + percentile: p25/p50/p75 정확 산출
 *  - analyze: window-days 필터 + rejectCategory 필터
 *  - falseNegRate + alertLevel 분기 (normal/warn/critical)
 *  - test 가 import 시 main() 부작용 없음
 */
import {
  parseProbeJsonl,
  groupByEvent,
  computeCategoryStat,
  classifyAlertLevel,
  analyze,
  percentile,
  type ProbeRecord,
} from '../scripts/missed-alpha-retrospective';

function buildRecord(p: {
  eventId: string;
  rejectCategory: string;
  rejectedAt: string;
  offsetSec: number;
  deltaPct: number | null;
  tokenMint?: string;
}): ProbeRecord {
  return {
    eventId: p.eventId,
    tokenMint: p.tokenMint ?? 'Mint11111111',
    lane: 'pure_ws_breakout',
    rejectCategory: p.rejectCategory,
    rejectReason: 'test',
    signalPrice: 0.001,
    rejectedAt: p.rejectedAt,
    probe: {
      offsetSec: p.offsetSec,
      firedAt: p.rejectedAt,
      observedPrice: p.deltaPct == null ? null : 0.001 * (1 + p.deltaPct),
      deltaPct: p.deltaPct,
      quoteStatus: p.deltaPct == null ? 'no_route' : 'ok',
    },
  };
}

describe('missedAlphaRetrospective', () => {
  describe('parseProbeJsonl', () => {
    it('skips malformed lines and returns valid records', () => {
      const raw = [
        JSON.stringify({
          eventId: 'e1',
          tokenMint: 'm1',
          lane: 'l',
          rejectCategory: 'survival',
          rejectReason: 'r',
          signalPrice: 1,
          rejectedAt: '2026-04-29T00:00:00.000Z',
          probe: { offsetSec: 60, firedAt: 'x', observedPrice: 1, deltaPct: 0.1, quoteStatus: 'ok' },
        }),
        '{not json',
        '',
        JSON.stringify({ partial: 'object' }),
      ].join('\n');
      const out = parseProbeJsonl(raw);
      expect(out.length).toBe(1);
      expect(out[0].eventId).toBe('e1');
    });
  });

  describe('percentile', () => {
    it('returns null for empty', () => {
      expect(percentile([], 0.5)).toBeNull();
    });
    it('linear interpolation for p25/p50/p75', () => {
      const arr = [0, 0.1, 0.2, 0.3, 0.4]; // n=5
      expect(percentile(arr, 0.5)).toBeCloseTo(0.2, 5);
      expect(percentile(arr, 0.25)).toBeCloseTo(0.1, 5);
      expect(percentile(arr, 0.75)).toBeCloseTo(0.3, 5);
    });
  });

  describe('classifyAlertLevel', () => {
    it('normal under 10%, warn 10-15%, critical ≥ 15%', () => {
      expect(classifyAlertLevel(0.05)).toBe('normal');
      expect(classifyAlertLevel(0.099)).toBe('normal');
      expect(classifyAlertLevel(0.10)).toBe('warn');
      expect(classifyAlertLevel(0.149)).toBe('warn');
      expect(classifyAlertLevel(0.15)).toBe('critical');
      expect(classifyAlertLevel(0.50)).toBe('critical');
    });
  });

  describe('groupByEvent + computeCategoryStat', () => {
    it('aggregates probes by eventId and computes per-category percentile + falseNegRate', () => {
      // 4 events all in 'survival' category. mfe@1800: [-0.1, +0.2, +0.6, +5.0]
      // → falseNeg (≥+50%): events 3,4 / 4 = 50% ; 5x: event 4 = 1
      const isoNow = '2026-04-29T00:00:00.000Z';
      const records: ProbeRecord[] = [
        buildRecord({ eventId: 'e1', rejectCategory: 'survival', rejectedAt: isoNow, offsetSec: 1800, deltaPct: -0.1 }),
        buildRecord({ eventId: 'e2', rejectCategory: 'survival', rejectedAt: isoNow, offsetSec: 1800, deltaPct: 0.2 }),
        buildRecord({ eventId: 'e3', rejectCategory: 'survival', rejectedAt: isoNow, offsetSec: 1800, deltaPct: 0.6 }),
        buildRecord({ eventId: 'e4', rejectCategory: 'survival', rejectedAt: isoNow, offsetSec: 1800, deltaPct: 5.0 }),
        // 7200 only on e4 (best-mfe 검증, 같은 event 라 falseNeg double-count 없음)
        buildRecord({ eventId: 'e4', rejectCategory: 'survival', rejectedAt: isoNow, offsetSec: 7200, deltaPct: 6.0 }),
      ];
      const events = [...groupByEvent(records).values()];
      expect(events.length).toBe(4);
      const stat = computeCategoryStat(events);
      expect(stat.count).toBe(4);
      expect(stat.p50_t1800_mfe).toBeCloseTo(0.4, 5); // median of [-0.1,0.2,0.6,5.0] = (0.2+0.6)/2
      expect(stat.falseNegRate).toBeCloseTo(0.5, 5);
      expect(stat.fivexFalseNeg).toBe(1);
      expect(stat.p50_t7200_mfe).toBeCloseTo(6.0, 5);
    });
  });

  describe('analyze (window + category filter + alert)', () => {
    const nowMs = Date.parse('2026-04-29T00:00:00.000Z');
    const inWindow = '2026-04-28T12:00:00.000Z';   // 12h ago
    const outOfWindow = '2026-04-20T00:00:00.000Z'; // 9d ago

    it('filters out events older than windowDays', () => {
      const records: ProbeRecord[] = [
        buildRecord({ eventId: 'old', rejectCategory: 'survival', rejectedAt: outOfWindow, offsetSec: 1800, deltaPct: 1.0 }),
        buildRecord({ eventId: 'new', rejectCategory: 'survival', rejectedAt: inWindow, offsetSec: 1800, deltaPct: -0.1 }),
      ];
      const r = analyze(records, { windowDays: 7, nowMs });
      expect(r.totalRejects).toBe(1);
      expect(r.byCategory.get('survival')?.count).toBe(1);
    });

    it('honors rejectCategory filter', () => {
      const records: ProbeRecord[] = [
        buildRecord({ eventId: 'a', rejectCategory: 'survival', rejectedAt: inWindow, offsetSec: 1800, deltaPct: 0.0 }),
        buildRecord({ eventId: 'b', rejectCategory: 'entry_drift', rejectedAt: inWindow, offsetSec: 1800, deltaPct: 0.0 }),
      ];
      const r = analyze(records, { windowDays: 7, nowMs, rejectCategory: 'survival' });
      expect(r.totalRejects).toBe(1);
      expect(r.byCategory.has('entry_drift')).toBe(false);
    });

    it('excludes kol_close from default reject retrospective but includes it when explicitly filtered', () => {
      const records: ProbeRecord[] = [
        buildRecord({ eventId: 'pre-entry', rejectCategory: 'survival', rejectedAt: inWindow, offsetSec: 1800, deltaPct: -0.1 }),
        buildRecord({ eventId: 'post-close', rejectCategory: 'kol_close', rejectedAt: inWindow, offsetSec: 1800, deltaPct: 5.0 }),
      ];

      const defaultReport = analyze(records, { windowDays: 7, nowMs });
      expect(defaultReport.totalRejects).toBe(1);
      expect(defaultReport.byCategory.has('kol_close')).toBe(false);
      expect(defaultReport.overallFalseNegRate).toBe(0);

      const closeReport = analyze(records, { windowDays: 7, nowMs, rejectCategory: 'kol_close' });
      expect(closeReport.totalRejects).toBe(1);
      expect(closeReport.byCategory.get('kol_close')?.fivexFalseNeg).toBe(1);
    });

    it('classifies alert level — critical when falseNegRate ≥ 15%', () => {
      // 10 events, 2 winners (≥+50%) → 20% falseNeg → critical
      const records: ProbeRecord[] = [];
      for (let i = 0; i < 10; i += 1) {
        const delta = i < 2 ? 1.0 : -0.05;
        records.push(buildRecord({
          eventId: `e${i}`,
          rejectCategory: 'survival',
          rejectedAt: inWindow,
          offsetSec: 1800,
          deltaPct: delta,
        }));
      }
      const r = analyze(records, { windowDays: 7, nowMs });
      expect(r.overallFalseNegRate).toBeCloseTo(0.2, 5);
      expect(r.alertLevel).toBe('critical');
    });

    it('classifies alert level — normal when no winners', () => {
      const records: ProbeRecord[] = [];
      for (let i = 0; i < 10; i += 1) {
        records.push(buildRecord({
          eventId: `e${i}`,
          rejectCategory: 'survival',
          rejectedAt: inWindow,
          offsetSec: 1800,
          deltaPct: -0.1,
        }));
      }
      const r = analyze(records, { windowDays: 7, nowMs });
      expect(r.overallFalseNegRate).toBe(0);
      expect(r.alertLevel).toBe('normal');
    });
  });
});
