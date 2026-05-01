/**
 * winner-kill-classifier 단위 테스트 (2026-05-01, Phase A.1).
 *
 * 회귀 가드: closeReason → KillCategory 매핑이 tail-retain 정책의 입력. 잘못된 분류는
 * structural kill 도 tail retain → Real Asset Guard 위반 가능. 정확한 분류 보장 필수.
 */
import {
  classifyKillCategory,
  classifyEvents,
  type KillCategory,
} from '../scripts/winner-kill-classifier';
import type { CloseEvent } from '../scripts/winner-kill-analyzer';

function closeEvent(overrides: Partial<CloseEvent> = {}): CloseEvent {
  return {
    eventId: 'evt-1',
    tokenMint: 'mint1',
    closeReason: 'probe_hard_cut',
    armName: undefined,
    isLive: false,
    closedAt: Date.parse('2026-05-01T00:00:00Z'),
    exitPrice: 0.0008,
    signalPrice: 0.001,
    mfePctAtClose: 0,
    postCloseDelta: new Map(),
    ...overrides,
  };
}

describe('winner-kill-classifier', () => {
  describe('classifyKillCategory', () => {
    it('probe_hard_cut → price (tail retain 가능)', () => {
      expect(classifyKillCategory('probe_hard_cut')).toBe('price');
    });

    it('probe_flat_cut / probe_reject_timeout / quick_reject → price', () => {
      expect(classifyKillCategory('probe_flat_cut')).toBe('price');
      expect(classifyKillCategory('probe_reject_timeout')).toBe('price');
      expect(classifyKillCategory('quick_reject_classifier_exit')).toBe('price');
    });

    it('structural_kill_sell_route → structural (Real Asset Guard, tail retain 금지)', () => {
      expect(classifyKillCategory('structural_kill_sell_route')).toBe('structural');
    });

    it('hold_phase_sentinel_degraded_exit → structural (sellability 기반)', () => {
      expect(classifyKillCategory('hold_phase_sentinel_degraded_exit')).toBe('structural');
    });

    it('insider_exit_full → insider (multi-KOL 분기 별도)', () => {
      expect(classifyKillCategory('insider_exit_full')).toBe('insider');
    });

    it('winner_trailing_t1/t2/t3 → winner', () => {
      expect(classifyKillCategory('winner_trailing_t1')).toBe('winner');
      expect(classifyKillCategory('winner_trailing_t2')).toBe('winner');
      expect(classifyKillCategory('winner_trailing_t3')).toBe('winner');
    });

    it('ORPHAN_NO_BALANCE → orphan', () => {
      expect(classifyKillCategory('ORPHAN_NO_BALANCE')).toBe('orphan');
    });

    it('unknown reason → other', () => {
      expect(classifyKillCategory('mystery_reason')).toBe('other');
    });
  });

  describe('classifyEvents', () => {
    it('빈 events → 빈 Map', () => {
      const map = classifyEvents([], 1800, 4.0);
      expect(map.size).toBe(0);
    });

    it('카테고리별 분리 + winner-kill 카운트', () => {
      // price kill (winner-kill)
      const priceKill = closeEvent({
        eventId: 'price-kill',
        closeReason: 'probe_hard_cut',
        exitPrice: 0.0001,
      });
      priceKill.postCloseDelta.set(1800, 0.5); // observedPrice=0.0015, postMfe=14 ≥ 4.0
      // structural kill (no observed target)
      const structural = closeEvent({
        eventId: 'structural',
        closeReason: 'structural_kill_sell_route',
        exitPrice: 0.0009,
      });
      structural.postCloseDelta.set(1800, -0.9); // postMfe negative
      // insider (winner-kill)
      const insider = closeEvent({
        eventId: 'insider',
        closeReason: 'insider_exit_full',
        exitPrice: 0.0001,
      });
      insider.postCloseDelta.set(1800, 0.5); // postMfe=14 ≥ 4.0

      const map = classifyEvents([priceKill, structural, insider], 1800, 4.0);
      expect(map.get('price')!.winnerKills).toBe(1);
      expect(map.get('structural')!.winnerKills).toBe(0);
      expect(map.get('insider')!.winnerKills).toBe(1);
    });

    it('avg postMfe 계산 — winner-kill examples 평균', () => {
      const e1 = closeEvent({
        eventId: 'e1',
        closeReason: 'probe_hard_cut',
        exitPrice: 0.0001,
      });
      e1.postCloseDelta.set(1800, 0.5); // postMfe=14
      const e2 = closeEvent({
        eventId: 'e2',
        closeReason: 'probe_hard_cut',
        exitPrice: 0.0001,
      });
      e2.postCloseDelta.set(1800, 1.0); // observedPrice=0.002, postMfe=19
      const map = classifyEvents([e1, e2], 1800, 4.0);
      const stat = map.get('price')!;
      expect(stat.winnerKills).toBe(2);
      expect(stat.avgPostMfe).toBeCloseTo(16.5, 0); // (14 + 19) / 2
    });

    it('exitPrice<=0 인 event 는 observed target 카운트 안 함', () => {
      const evt = closeEvent({ closeReason: 'probe_hard_cut', exitPrice: 0 });
      evt.postCloseDelta.set(1800, 4.0);
      const map = classifyEvents([evt], 1800, 4.0);
      const stat = map.get('price')!;
      expect(stat.total).toBe(1);
      expect(stat.observedTarget).toBe(0);
      expect(stat.winnerKills).toBe(0);
    });
  });
});
