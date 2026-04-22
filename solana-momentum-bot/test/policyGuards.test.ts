/**
 * policyGuards tests (QA F5, 2026-04-21).
 * Why: behavioral drift 방지 장치 — ticket size 를 0.01 SOL 초과로 설정 시 강제 복원.
 */
jest.mock('../src/utils/logger', () => ({
  createModuleLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import {
  POLICY_TICKET_MAX_SOL,
  checkTicketPolicy,
  isValidTicketOverrideAck,
  enforceTicketPolicyForAllLanes,
} from '../src/utils/policyGuards';

describe('policyGuards — ticket size hard lock (F5)', () => {
  it('POLICY_TICKET_MAX_SOL is locked to 0.01 (const)', () => {
    expect(POLICY_TICKET_MAX_SOL).toBe(0.01);
  });

  // ─── isValidTicketOverrideAck ───

  describe('isValidTicketOverrideAck', () => {
    it('accepts correctly-formatted ack', () => {
      expect(isValidTicketOverrideAck('stage4_approved_2026_05_01')).toBe(true);
      expect(isValidTicketOverrideAck('stage4_approved_2027_12_31')).toBe(true);
    });

    it('rejects empty / null / undefined', () => {
      expect(isValidTicketOverrideAck(undefined)).toBe(false);
      expect(isValidTicketOverrideAck(null)).toBe(false);
      expect(isValidTicketOverrideAck('')).toBe(false);
    });

    it('rejects wrong prefix (stage1/2/3)', () => {
      expect(isValidTicketOverrideAck('stage1_approved_2026_05_01')).toBe(false);
      expect(isValidTicketOverrideAck('stage2_approved_2026_05_01')).toBe(false);
      expect(isValidTicketOverrideAck('stage3_approved_2026_05_01')).toBe(false);
    });

    it('rejects loose formats (quick bypass 시도)', () => {
      expect(isValidTicketOverrideAck('approved')).toBe(false);
      expect(isValidTicketOverrideAck('yes')).toBe(false);
      expect(isValidTicketOverrideAck('true')).toBe(false);
      expect(isValidTicketOverrideAck('stage4_approved')).toBe(false);
      expect(isValidTicketOverrideAck('stage4_approved_2026-05-01')).toBe(false); // dash format
      expect(isValidTicketOverrideAck('stage4_approved_20260501')).toBe(false);  // no separator
    });

    it('trims whitespace before match', () => {
      expect(isValidTicketOverrideAck('  stage4_approved_2026_05_01  ')).toBe(true);
    });
  });

  // ─── checkTicketPolicy ───

  describe('checkTicketPolicy', () => {
    it('allows ticket <= POLICY_TICKET_MAX_SOL without ack', () => {
      const r = checkTicketPolicy('pure_ws', 0.01, undefined);
      expect(r.violation).toBe(false);
      expect(r.effectiveTicketSol).toBe(0.01);
      expect(r.overrideAcknowledged).toBe(false);
    });

    it('allows ticket < POLICY_TICKET_MAX_SOL without ack', () => {
      const r = checkTicketPolicy('pure_ws', 0.005, undefined);
      expect(r.violation).toBe(false);
      expect(r.effectiveTicketSol).toBe(0.005);
    });

    it('handles floating-point edge (0.01 + 1e-12)', () => {
      const r = checkTicketPolicy('pure_ws', 0.01 + 1e-12, undefined);
      expect(r.violation).toBe(false);
      expect(r.effectiveTicketSol).toBeCloseTo(0.01, 9);
    });

    it('[F5 core] rejects ticket > max WITHOUT ack → reverts to 0.01', () => {
      const r = checkTicketPolicy('pure_ws', 0.05, undefined);
      expect(r.violation).toBe(true);
      expect(r.effectiveTicketSol).toBe(POLICY_TICKET_MAX_SOL);
      expect(r.configuredTicketSol).toBe(0.05);
      expect(r.ackProvided).toBe(false);
    });

    it('[F5 core] rejects ticket > max WITH INVALID ack → reverts', () => {
      const r = checkTicketPolicy('pure_ws', 0.05, 'yes');
      expect(r.violation).toBe(true);
      expect(r.effectiveTicketSol).toBe(POLICY_TICKET_MAX_SOL);
    });

    it('[F5 core] allows ticket > max WITH VALID ack (Stage 4 override)', () => {
      const r = checkTicketPolicy('pure_ws', 0.05, 'stage4_approved_2026_05_01');
      expect(r.violation).toBe(false);
      expect(r.effectiveTicketSol).toBe(0.05);
      expect(r.overrideAcknowledged).toBe(true);
      expect(r.ackProvided).toBe(true);
    });

    it('extreme ticket (1 SOL) without ack is still reverted to 0.01', () => {
      const r = checkTicketPolicy('migration', 1.0, undefined);
      expect(r.violation).toBe(true);
      expect(r.effectiveTicketSol).toBe(POLICY_TICKET_MAX_SOL);
    });
  });

  // ─── enforceTicketPolicyForAllLanes ───

  describe('enforceTicketPolicyForAllLanes', () => {
    it('all lanes within policy → no violation, no critical', () => {
      const results = enforceTicketPolicyForAllLanes([
        { lane: 'pure_ws', configuredTicketSol: 0.01, ackEnvName: 'A', ackEnvValue: undefined },
        { lane: 'cupsey', configuredTicketSol: 0.005, ackEnvName: 'B', ackEnvValue: undefined },
      ]);
      expect(results.every((r) => !r.violation)).toBe(true);
      expect(results.every((r) => !r.criticalMessage)).toBe(true);
    });

    it('[F5 regression] single lane violation emits criticalMessage + effective reverted', () => {
      const results = enforceTicketPolicyForAllLanes([
        { lane: 'pure_ws', configuredTicketSol: 0.10, ackEnvName: 'PUREWS_TICKET_OVERRIDE_ACK', ackEnvValue: undefined },
        { lane: 'cupsey', configuredTicketSol: 0.01, ackEnvName: 'CUPSEY_TICKET_OVERRIDE_ACK', ackEnvValue: undefined },
      ]);
      const violated = results.find((r) => r.lane === 'pure_ws');
      const safe = results.find((r) => r.lane === 'cupsey');
      expect(violated?.violation).toBe(true);
      expect(violated?.effectiveTicketSol).toBe(POLICY_TICKET_MAX_SOL);
      expect(violated?.criticalMessage).toMatch(/POLICY_VIOLATION/);
      expect(violated?.criticalMessage).toContain('PUREWS_TICKET_OVERRIDE_ACK');
      expect(safe?.violation).toBe(false);
    });

    it('[F5 regression] valid ack → no violation (운영자 정식 Stage 4 확대)', () => {
      const results = enforceTicketPolicyForAllLanes([
        {
          lane: 'pure_ws',
          configuredTicketSol: 0.05,
          ackEnvName: 'PUREWS_TICKET_OVERRIDE_ACK',
          ackEnvValue: 'stage4_approved_2026_05_15',
        },
      ]);
      expect(results[0].violation).toBe(false);
      expect(results[0].effectiveTicketSol).toBe(0.05);
      expect(results[0].overrideAcknowledged).toBe(true);
      expect(results[0].criticalMessage).toBeUndefined();
    });

    it('[F5 regression] invalid ack format does NOT bypass — reverts', () => {
      const results = enforceTicketPolicyForAllLanes([
        {
          lane: 'pure_ws',
          configuredTicketSol: 0.05,
          ackEnvName: 'PUREWS_TICKET_OVERRIDE_ACK',
          ackEnvValue: 'approved', // 형식 어긋남
        },
      ]);
      expect(results[0].violation).toBe(true);
      expect(results[0].effectiveTicketSol).toBe(POLICY_TICKET_MAX_SOL);
    });
  });
});
