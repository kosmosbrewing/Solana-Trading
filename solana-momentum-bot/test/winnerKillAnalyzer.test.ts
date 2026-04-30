/**
 * winner-kill-analyzer pure function tests (2026-04-30, Sprint 1.B2 회귀 가드).
 *
 * Why: B2 sprint 가 실데이터 smoke test 만 한 한계 — edge case (빈 input / 단일 event /
 *      threshold 경계) 가 별도 검증 안 됨. 학술 §검증 권고의 winner-kill rate 메트릭
 *      신뢰성 확보가 핵심. 5x winner 분포의 statistical 측정은 반드시 정확해야 함.
 */
import {
  isCloseEvent,
  aggregateCloseEvents,
  computeCohort,
  type ProbeLine,
  type CloseEvent,
} from '../scripts/winner-kill-analyzer';

function probeLine(overrides: Partial<ProbeLine> = {}): ProbeLine {
  return {
    eventId: 'evt-1',
    tokenMint: 'mint1',
    lane: 'kol_hunter',
    rejectCategory: 'probe_hard_cut',
    rejectReason: 'probe_hard_cut',
    signalPrice: 0.001,
    rejectedAt: new Date('2026-04-30T00:00:00Z').toISOString(),
    extras: { elapsedSecAtClose: 30, exitPrice: 0.0009, mfePctAtClose: 0, isLive: false },
    probe: { offsetSec: 1800, firedAt: '2026-04-30T00:30:00Z', observedPrice: null, deltaPct: null, quoteStatus: 'ok' },
    ...overrides,
  };
}

function closeEvent(overrides: Partial<CloseEvent> = {}): CloseEvent {
  return {
    eventId: 'evt-1',
    tokenMint: 'mint1',
    closeReason: 'probe_hard_cut',
    armName: undefined,
    isLive: false,
    closedAt: Date.parse('2026-04-30T00:00:00Z'),
    exitPrice: 0.0009,
    signalPrice: 0.001,
    mfePctAtClose: 0,
    postCloseDelta: new Map(),
    ...overrides,
  };
}

describe('winner-kill-analyzer', () => {
  describe('isCloseEvent', () => {
    it('lane=kol_hunter + extras.elapsedSecAtClose 있으면 true', () => {
      expect(isCloseEvent(probeLine())).toBe(true);
    });

    it('lane!=kol_hunter 이면 false (다른 lane 의 close 는 별도 분석)', () => {
      expect(isCloseEvent(probeLine({ lane: 'pure_ws_breakout' }))).toBe(false);
    });

    it('extras 자체가 없으면 false (reject-side 이벤트)', () => {
      expect(isCloseEvent(probeLine({ extras: undefined as unknown as Record<string, unknown> }))).toBe(false);
    });

    it('extras.elapsedSecAtClose 가 number 가 아니면 false', () => {
      expect(isCloseEvent(probeLine({ extras: { isLive: true } }))).toBe(false);
    });

    it('extras.elapsedSecAtClose=0 도 valid (즉시 close 케이스)', () => {
      expect(isCloseEvent(probeLine({ extras: { elapsedSecAtClose: 0 } }))).toBe(true);
    });

    // 2026-04-30 (B1 회귀): rejectCategory='kol_close' 만으로도 식별 가능.
    it('B1: rejectCategory=kol_close 면 extras 없어도 close 로 식별 (신규 schema)', () => {
      expect(isCloseEvent(probeLine({
        rejectCategory: 'kol_close',
        extras: undefined as unknown as Record<string, unknown>,
      }))).toBe(true);
    });
  });

  describe('aggregateCloseEvents', () => {
    it('빈 입력 → 빈 Map', () => {
      expect(aggregateCloseEvents([]).size).toBe(0);
    });

    it('non-close (reject) 이벤트는 무시', () => {
      const reject = probeLine({ extras: undefined as unknown as Record<string, unknown> });
      expect(aggregateCloseEvents([reject]).size).toBe(0);
    });

    it('동일 eventId 의 여러 offset probe 한 CloseEvent 로 묶임', () => {
      const t1 = probeLine({
        probe: { offsetSec: 60, firedAt: '', observedPrice: 0.0011, deltaPct: 0.10, quoteStatus: 'ok' },
      });
      const t2 = probeLine({
        probe: { offsetSec: 1800, firedAt: '', observedPrice: 0.005, deltaPct: 4.0, quoteStatus: 'ok' },
      });
      const map = aggregateCloseEvents([t1, t2]);
      expect(map.size).toBe(1);
      const evt = map.get('evt-1')!;
      expect(evt.postCloseDelta.size).toBe(2);
      expect(evt.postCloseDelta.get(60)).toBe(0.10);
      expect(evt.postCloseDelta.get(1800)).toBe(4.0);
    });

    it('extras 의 isLive / armName 이 정확히 추출됨', () => {
      const line = probeLine({
        extras: {
          elapsedSecAtClose: 60,
          exitPrice: 0.0008,
          mfePctAtClose: 0.02,
          isLive: true,
          armName: 'kol_hunter_smart_v3',
        },
      });
      const evt = aggregateCloseEvents([line]).get('evt-1')!;
      expect(evt.isLive).toBe(true);
      expect(evt.armName).toBe('kol_hunter_smart_v3');
      expect(evt.exitPrice).toBe(0.0008);
      expect(evt.mfePctAtClose).toBe(0.02);
    });

    it('extras 일부 필드 누락 시 default fallback (exitPrice=0, isLive=false)', () => {
      const line = probeLine({ extras: { elapsedSecAtClose: 30 } });
      const evt = aggregateCloseEvents([line]).get('evt-1')!;
      expect(evt.exitPrice).toBe(0);
      expect(evt.isLive).toBe(false);
      expect(evt.armName).toBeUndefined();
    });
  });

  describe('computeCohort', () => {
    it('빈 events → rate=0, total=0', () => {
      const stat = computeCohort([], 1800, 4.0, 'empty');
      expect(stat.total).toBe(0);
      expect(stat.observedTargetTotal).toBe(0);
      expect(stat.winnerKills).toBe(0);
      expect(stat.rate).toBe(0);
    });

    it('post-close mfe 가 threshold 충족 → winner-kill +1', () => {
      // signalPrice=0.001, exitPrice=0.0008 (-20% close).
      // delta=4.0 (T+1800 가격이 signal 대비 +400% 상승 = 0.005)
      // observedPrice=0.005, postMfe = (0.005 - 0.0008) / 0.0008 = 5.25 ≥ 4.0 → winner-kill
      const evt = closeEvent({ exitPrice: 0.0008 });
      evt.postCloseDelta.set(1800, 4.0);
      const stat = computeCohort([evt], 1800, 4.0, 'test');
      expect(stat.total).toBe(1);
      expect(stat.observedTargetTotal).toBe(1);
      expect(stat.winnerKills).toBe(1);
      expect(stat.rate).toBe(1.0);
      expect(stat.examples[0].postMfe).toBeCloseTo(5.25, 1);
    });

    it('post-close mfe 가 threshold 미달 → winner-kill 0', () => {
      const evt = closeEvent({ exitPrice: 0.0009 });
      evt.postCloseDelta.set(1800, 0.5); // observed=0.0015, postMfe=0.667 < 4.0
      const stat = computeCohort([evt], 1800, 4.0, 'test');
      expect(stat.winnerKills).toBe(0);
    });

    it('exitPrice <= 0 인 event 는 skip (zero division 방지)', () => {
      const evt = closeEvent({ exitPrice: 0 });
      evt.postCloseDelta.set(1800, 4.0);
      const stat = computeCohort([evt], 1800, 4.0, 'test');
      expect(stat.total).toBe(1);
      expect(stat.observedTargetTotal).toBe(0);
      expect(stat.winnerKills).toBe(0); // skip
    });

    it('targetOffsetSec 에 해당하는 probe 없으면 skip', () => {
      const evt = closeEvent({ exitPrice: 0.0008 });
      evt.postCloseDelta.set(60, 4.0); // 60s 만 있고 1800s 없음
      const stat = computeCohort([evt], 1800, 4.0, 'test');
      expect(stat.total).toBe(1);
      expect(stat.observedTargetTotal).toBe(0);
      expect(stat.winnerKills).toBe(0);
    });

    it('uses observed target rows as winner-kill denominator', () => {
      const observed = closeEvent({ eventId: 'observed', exitPrice: 0.0008 });
      observed.postCloseDelta.set(1800, 4.0);
      const scheduledOnly = closeEvent({ eventId: 'scheduled-only', exitPrice: 0.0008 });
      scheduledOnly.postCloseDelta.set(0, null);

      const stat = computeCohort([observed, scheduledOnly], 1800, 4.0, 'target-denominator');

      expect(stat.total).toBe(2);
      expect(stat.observedTargetTotal).toBe(1);
      expect(stat.winnerKills).toBe(1);
      expect(stat.rate).toBe(1);
    });

    it('examples top 5 기준 정렬 (postMfe 내림차순)', () => {
      const evts: CloseEvent[] = [];
      // 7 winner-kill event 생성 (postMfe 5x ~ 11x 분포)
      for (let i = 0; i < 7; i++) {
        const evt = closeEvent({
          eventId: `evt-${i}`,
          tokenMint: `mint-${i}`,
          exitPrice: 0.0008,
        });
        evt.postCloseDelta.set(1800, 4.0 + i); // delta 4..10 → postMfe 5.25 ~ 12.25
        evts.push(evt);
      }
      const stat = computeCohort(evts, 1800, 4.0, 'top5');
      expect(stat.winnerKills).toBe(7);
      expect(stat.examples).toHaveLength(5);
      expect(stat.examples[0].postMfe).toBeGreaterThan(stat.examples[4].postMfe!);
    });

    it('threshold 경계값 — postMfe == threshold 도 winner-kill', () => {
      // signalPrice=0.001, exitPrice=0.0001 (-90% close).
      // delta=0.5 → observedPrice=0.0015, postMfe = (0.0015 - 0.0001) / 0.0001 = 14.0 >= 4.0
      const evt = closeEvent({ exitPrice: 0.0001 });
      evt.postCloseDelta.set(1800, 0.5);
      const stat = computeCohort([evt], 1800, 4.0, 'edge');
      expect(stat.winnerKills).toBe(1);
    });
  });
});
