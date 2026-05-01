/**
 * Research Ledger schema v1 — fixture + validator tests (S1).
 *
 * ADR: docs/design-docs/research-ledger-unification-2026-05-01.md
 *
 * 검증 항목:
 *   - 4 fixture (paper / live / shadow / tail) round-trip JSON parse + validator pass
 *   - 필수 필드 누락 시 invalid + 정확한 error 사유
 *   - mode-conditional (paper vs live) pnlTruthSource / walletDeltaSol / simulatedNetSol 일관성
 *   - eventId 결정성 (Codex M1 — 동일 input → 동일 hash, 다른 emitNonce 라도 같은 eventId)
 *   - eventType-conditional positionId / rejectCategory 필수
 *   - recordId / eventId / emitNonce 3-key 분리
 */

import {
  validateTradeOutcome,
  validateFunnelRecord,
  computeEventId,
  computeRecordId,
} from '../src/research/researchLedgerValidator';
import type {
  TradeOutcomeV1,
  KolCallFunnelV1,
} from '../src/research/researchLedgerTypes';
import {
  TRADE_OUTCOME_SCHEMA_VERSION,
  KOL_CALL_FUNNEL_SCHEMA_VERSION,
} from '../src/research/researchLedgerTypes';

// ─── Fixtures ───────────────────────────────────────────────

const PAPER_FIXTURE: TradeOutcomeV1 = {
  schemaVersion: TRADE_OUTCOME_SCHEMA_VERSION,
  recordId: 'rec_paper_abc123',
  positionId: 'kolh-paper-1',
  sessionId: 'sess_2026_05_01_a',
  tokenMint: 'So11111111111111111111111111111111111111112',
  mode: 'paper',
  armName: 'kol_hunter_smart_v3',
  parameterVersion: 'v3.2',
  participatingKols: [
    { id: 'decu', tier: 'A', timestamp: 1745000000000 },
    { id: 'dv', tier: 'A', timestamp: 1745000001000 },
  ],
  kols: ['decu', 'dv'],
  independentKolCount: 2,
  effectiveIndependentCount: 1.5,
  kolEntryReason: 'pullback',
  kolConvictionLevel: 'HIGH',
  kolReinforcementCount: 1,
  isShadowArm: false,
  isTailPosition: false,
  parentPositionId: null,
  partialTakeRealizedSol: 0,
  partialTakeLockedTicketSol: 0,
  partialTakeAtSec: null,
  ticketSol: 0.02,
  effectiveTicketSol: 0.02,
  entryPrice: 0.00000123,
  exitPrice: 0.00000180,
  walletDeltaSol: null,
  simulatedNetSol: 0.0114,
  paperModelVersion: 'paperRoundTripCost-v1',
  pnlTruthSource: 'paper_simulation',
  netSol: 0.0114,
  netPct: 0.57,
  mfePctPeak: 1.5,
  maePct: -0.05,
  holdSec: 176,
  exitReason: 'winner_trailing_t1',
  t1Visited: true,
  t2Visited: false,
  t3Visited: false,
  t1VisitAtSec: 1745000050,
  t2VisitAtSec: null,
  t3VisitAtSec: null,
  actual5xPeak: false,
  survivalFlags: [],
  entryAtIso: '2026-05-01T05:00:00.000Z',
  exitAtIso: '2026-05-01T05:02:56.000Z',
  entryTimeSec: 1745000000,
  exitTimeSec: 1745000176,
};

const LIVE_FIXTURE: TradeOutcomeV1 = {
  schemaVersion: TRADE_OUTCOME_SCHEMA_VERSION,
  recordId: 'rec_live_xyz789',
  positionId: 'kolh-live-1',
  sessionId: 'sess_2026_05_01_a',
  tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  mode: 'live',
  wallet: 'main',
  armName: 'kol_hunter_smart_v3',
  parameterVersion: 'v3.2',
  participatingKols: [
    { id: 'decu', tier: 'A', timestamp: 1745001000000 },
  ],
  kols: ['decu'],
  independentKolCount: 1,
  kolEntryReason: 'velocity',
  kolConvictionLevel: 'MEDIUM',
  isShadowArm: false,
  isTailPosition: false,
  parentPositionId: null,
  partialTakeRealizedSol: 0.0035,
  partialTakeLockedTicketSol: 0.006,
  partialTakeAtSec: 1745001120,
  ticketSol: 0.02,
  actualInputSol: 0.0218,
  receivedSol: 0.029,
  solSpentNominal: 0.014,
  effectiveTicketSol: 0.02,
  entryPrice: 0.00000123,
  exitPrice: 0.00000175,
  entrySlippageBps: 45,
  exitSlippageBps: 38,
  walletDeltaSol: 0.0123,
  simulatedNetSol: null,
  paperModelVersion: null,
  pnlTruthSource: 'wallet_delta',
  netSol: 0.0123,
  netPct: 0.55,
  dbPnlSol: 0.0125,
  dbPnlDriftSol: -0.0002,
  entryPriceSource: 'jupiter_quote',
  exitPriceSource: 'wallet_delta',
  trajectoryPriceSource: 'helius_ws',
  entryTxSignature: 'sig_entry_abc',
  exitTxSignature: 'sig_exit_def',
  dbTradeId: 'trade_uuid_001',
  mfePctPeak: 1.8,
  maePct: -0.04,
  holdSec: 240,
  exitReason: 'partial_take_then_runner_close',
  t1Visited: true,
  t2Visited: true,
  t3Visited: false,
  t1VisitAtSec: 1745001100,
  t2VisitAtSec: 1745001180,
  t3VisitAtSec: null,
  actual5xPeak: false,
  survivalFlags: ['NO_FREEZE_AUTH'],
  entryAtIso: '2026-05-01T05:50:00.000Z',
  exitAtIso: '2026-05-01T05:54:00.000Z',
  entryTimeSec: 1745001000,
  exitTimeSec: 1745001240,
};

const SHADOW_FIXTURE: TradeOutcomeV1 = {
  ...PAPER_FIXTURE,
  recordId: 'rec_shadow_111',
  positionId: 'kolh-paper-1-shadow',
  isShadowArm: true,
  parentPositionId: 'kolh-paper-1',
  armName: 'kol_hunter_smart_v3_shadow_b',
};

const TAIL_FIXTURE: TradeOutcomeV1 = {
  ...PAPER_FIXTURE,
  recordId: 'rec_tail_222',
  positionId: 'kolh-paper-1-tail',
  isTailPosition: true,
  parentPositionId: 'kolh-paper-1',
  ticketSol: 0.003,
  effectiveTicketSol: 0.003,
  entryPrice: 0.00000180, // tail 의 entry = parent close
  exitPrice: 0.0000023,
  netSol: 0.0006,
  simulatedNetSol: 0.0006,
  netPct: 0.18,
  mfePctPeak: 0.28,
  maePct: -0.10,
  holdSec: 600,
  exitReason: 'tail_max_hold',
  t1Visited: false,
  t1VisitAtSec: null,
};

// ─── Tests ──────────────────────────────────────────────────

describe('researchLedgerValidator — trade-outcome/v1', () => {
  describe('fixture round-trip', () => {
    it('paper fixture validates + JSON round-trip 보존', () => {
      const r = validateTradeOutcome(PAPER_FIXTURE);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
      const parsed = JSON.parse(JSON.stringify(PAPER_FIXTURE));
      expect(parsed.schemaVersion).toBe(TRADE_OUTCOME_SCHEMA_VERSION);
      expect(parsed.pnlTruthSource).toBe('paper_simulation');
      expect(parsed.simulatedNetSol).toBe(0.0114);
      expect(parsed.walletDeltaSol).toBeNull();
    });

    it('live fixture validates + tx signature / wallet 보존', () => {
      const r = validateTradeOutcome(LIVE_FIXTURE);
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
      expect(LIVE_FIXTURE.entryTxSignature).toBeDefined();
      expect(LIVE_FIXTURE.exitTxSignature).toBeDefined();
      expect(LIVE_FIXTURE.dbTradeId).toBeDefined();
      expect(LIVE_FIXTURE.wallet).toBe('main');
      expect(LIVE_FIXTURE.actualInputSol).toBeGreaterThan(LIVE_FIXTURE.ticketSol);
    });

    it('shadow fixture validates (isShadowArm + parentPositionId)', () => {
      const r = validateTradeOutcome(SHADOW_FIXTURE);
      expect(r.valid).toBe(true);
      expect(SHADOW_FIXTURE.isShadowArm).toBe(true);
      expect(SHADOW_FIXTURE.parentPositionId).toBe('kolh-paper-1');
    });

    it('tail fixture validates (isTailPosition + parentPositionId + own ticket size)', () => {
      const r = validateTradeOutcome(TAIL_FIXTURE);
      expect(r.valid).toBe(true);
      expect(TAIL_FIXTURE.isTailPosition).toBe(true);
      expect(TAIL_FIXTURE.parentPositionId).toBe('kolh-paper-1');
    });

    it('partial take 합산 fixture (Codex F-A 보존 — partialTakeRealizedSol/LockedTicketSol)', () => {
      const r = validateTradeOutcome(LIVE_FIXTURE);
      expect(r.valid).toBe(true);
      expect(LIVE_FIXTURE.partialTakeRealizedSol).toBeGreaterThan(0);
      expect(LIVE_FIXTURE.partialTakeLockedTicketSol).toBeGreaterThan(0);
      expect(LIVE_FIXTURE.partialTakeAtSec).toBeDefined();
    });
  });

  describe('필수 필드 누락 검증', () => {
    it('positionId 누락 → invalid', () => {
      const bad = { ...PAPER_FIXTURE, positionId: undefined as unknown as string };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain('missing required field: positionId');
    });

    it('schemaVersion 잘못된 값 → invalid', () => {
      const bad = { ...PAPER_FIXTURE, schemaVersion: 'trade-outcome/v2' as 'trade-outcome/v1' };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.startsWith('schemaVersion must be'))).toBe(true);
    });

    it('partialTakeRealizedSol 누락 → invalid (Codex M2 보존)', () => {
      const bad = { ...PAPER_FIXTURE, partialTakeRealizedSol: undefined as unknown as number };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain('partialTakeRealizedSol must be number (0 if no partial)');
    });

    it('parentPositionId 미존재 (undefined) → invalid (null 은 허용)', () => {
      const bad = { ...PAPER_FIXTURE };
      delete (bad as Partial<TradeOutcomeV1>).parentPositionId;
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain('parentPositionId must be present (null if non-tail)');
    });
  });

  describe('mode-conditional 일관성 (Codex M2)', () => {
    it("mode='live' + walletDeltaSol=null → invalid", () => {
      const bad = { ...LIVE_FIXTURE, walletDeltaSol: null };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("mode='live' → walletDeltaSol non-null required");
    });

    it("mode='live' + pnlTruthSource='paper_simulation' → invalid", () => {
      const bad = { ...LIVE_FIXTURE, pnlTruthSource: 'paper_simulation' as const };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("pnlTruthSource must be 'wallet_delta'"))).toBe(true);
    });

    it("mode='paper' + simulatedNetSol=null → invalid", () => {
      const bad = { ...PAPER_FIXTURE, simulatedNetSol: null };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("mode='paper' → simulatedNetSol non-null required");
    });

    it("mode='paper' + paperModelVersion=null → invalid", () => {
      const bad = { ...PAPER_FIXTURE, paperModelVersion: null };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("mode='paper' → paperModelVersion non-null required");
    });

    it("mode='paper' + walletDeltaSol non-null → invalid (Codex M3 — error 강제)", () => {
      const bad = { ...PAPER_FIXTURE, walletDeltaSol: 0.01 };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("mode='paper' → walletDeltaSol must be null (truth source mismatch)");
    });

    it("mode='live' + simulatedNetSol non-null → invalid (Codex M3)", () => {
      const bad = { ...LIVE_FIXTURE, simulatedNetSol: 0.01 };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("mode='live' → simulatedNetSol must be null (truth source mismatch)");
    });

    it("Codex M2 — mode='live' + netSol !== walletDeltaSol → invalid", () => {
      const bad = { ...LIVE_FIXTURE, netSol: 0.0123, walletDeltaSol: 0.0500 };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('netSol must equal walletDeltaSol'))).toBe(true);
    });

    it("Codex M2 — mode='paper' + netSol !== simulatedNetSol → invalid", () => {
      const bad = { ...PAPER_FIXTURE, netSol: 0.0114, simulatedNetSol: 0.0500 };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('netSol must equal simulatedNetSol'))).toBe(true);
    });

    it("mode='unknown' → invalid", () => {
      const bad = { ...PAPER_FIXTURE, mode: 'unknown' as unknown as 'paper' };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.startsWith('mode must be'))).toBe(true);
    });
  });

  describe('participatingKols / kols derived 정합', () => {
    it('participatingKols 누락 → invalid', () => {
      const bad = { ...PAPER_FIXTURE };
      delete (bad as Partial<TradeOutcomeV1>).participatingKols;
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain('participatingKols must be array');
    });

    it('kols 와 participatingKols 순서 불일치 → warning', () => {
      const bad = { ...PAPER_FIXTURE, kols: ['dv', 'decu'] }; // 역순
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(true); // warning, valid
      expect(r.warnings.some((w) => w.includes('derived alias'))).toBe(true);
    });
  });

  describe('5x peak 정합', () => {
    it('mfePctPeak 5.0 + actual5xPeak=false → warning', () => {
      const bad = { ...PAPER_FIXTURE, mfePctPeak: 5.0, actual5xPeak: false };
      const r = validateTradeOutcome(bad);
      expect(r.warnings.some((w) => w.includes('actual5xPeak'))).toBe(true);
    });
  });

  // ─── Codex M4 보정 — deeper validation ───
  describe('deeper validation (Codex M4)', () => {
    it('NaN netSol → invalid', () => {
      const bad = { ...PAPER_FIXTURE, netSol: NaN };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('netSol must be finite'))).toBe(true);
    });

    it('Infinity exitPrice → invalid', () => {
      const bad = { ...PAPER_FIXTURE, exitPrice: Infinity };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('exitPrice must be finite'))).toBe(true);
    });

    it('negative effectiveTicketSol → invalid (Codex F5: > 0 강제)', () => {
      const bad = { ...PAPER_FIXTURE, effectiveTicketSol: -0.01 };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('effectiveTicketSol must be > 0'))).toBe(true);
    });

    it('zero ticketSol → invalid (Codex F5: > 0 강제)', () => {
      const bad = { ...PAPER_FIXTURE, ticketSol: 0 };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('ticketSol must be > 0'))).toBe(true);
    });

    it('zero effectiveTicketSol → invalid (Codex F5)', () => {
      const bad = { ...PAPER_FIXTURE, effectiveTicketSol: 0 };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('effectiveTicketSol must be > 0'))).toBe(true);
    });

    it('entryPrice <= 0 → invalid', () => {
      const bad = { ...PAPER_FIXTURE, entryPrice: 0 };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('entryPrice must be > 0'))).toBe(true);
    });

    it('빈 문자열 positionId → invalid', () => {
      const bad = { ...PAPER_FIXTURE, positionId: '' };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('positionId must be non-empty'))).toBe(true);
    });

    it("invalid participatingKols.tier ('Z') → invalid", () => {
      const bad: Partial<TradeOutcomeV1> = {
        ...PAPER_FIXTURE,
        participatingKols: [{ id: 'decu', tier: 'Z' as 'A', timestamp: 1745000000000 }],
        kols: ['decu'],
      };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("tier must be 'S'|'A'|'B'"))).toBe(true);
    });

    it('participatingKols[i].timestamp 0 → invalid', () => {
      const bad: Partial<TradeOutcomeV1> = {
        ...PAPER_FIXTURE,
        participatingKols: [{ id: 'decu', tier: 'A', timestamp: 0 }],
        kols: ['decu'],
      };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('timestamp must be positive'))).toBe(true);
    });

    it('survivalFlags 가 string[] 아님 (요소 non-string) → invalid', () => {
      const bad: Partial<TradeOutcomeV1> = {
        ...PAPER_FIXTURE,
        survivalFlags: ['valid', 123 as unknown as string, 'also_valid'],
      };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('survivalFlags[1] must be string'))).toBe(true);
    });

    it('survivalFlags 가 array 자체가 아님 (object) → invalid (Codex F2 보정)', () => {
      const bad: Partial<TradeOutcomeV1> = {
        ...PAPER_FIXTURE,
        survivalFlags: { foo: 'bar' } as unknown as string[],
      };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('survivalFlags must be array'))).toBe(true);
    });

    it('survivalFlags 가 string → invalid (Codex F2)', () => {
      const bad: Partial<TradeOutcomeV1> = {
        ...PAPER_FIXTURE,
        survivalFlags: 'flat_string' as unknown as string[],
      };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('survivalFlags must be array'))).toBe(true);
    });

    it('independentKolCount NaN → invalid', () => {
      const bad = { ...PAPER_FIXTURE, independentKolCount: NaN };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('independentKolCount must be finite'))).toBe(true);
    });
  });

  // ─── Codex S2.5 P2-1 — boolean 타입 강제 ───
  describe('boolean 타입 강제 (Codex S2.5 P2-1)', () => {
    const booleanFields: Array<keyof TradeOutcomeV1> = [
      'isShadowArm', 'isTailPosition',
      't1Visited', 't2Visited', 't3Visited',
      'actual5xPeak',
    ];
    it.each(booleanFields)("%s = 'false' (string) → invalid", (field) => {
      const bad = { ...PAPER_FIXTURE, [field]: 'false' } as Partial<TradeOutcomeV1>;
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes(`${String(field)} must be boolean`))).toBe(true);
    });

    it("isTailPosition = 0 (number) → invalid", () => {
      const bad = { ...PAPER_FIXTURE, isTailPosition: 0 as unknown as boolean };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes('isTailPosition must be boolean'))).toBe(true);
    });

    it('actual5xPeak = null → 위 required missing 으로 invalid', () => {
      const bad = { ...PAPER_FIXTURE, actual5xPeak: null as unknown as boolean };
      const r = validateTradeOutcome(bad);
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e === 'missing required field: actual5xPeak')).toBe(true);
    });
  });

  // ─── Codex M5 보정 — T1/T2/T3 visit 정합 loop ───
  describe('T1/T2/T3 visit 정합 (Codex M5)', () => {
    it('T2Visited=true + t2VisitAtSec=null → warning', () => {
      const bad = { ...PAPER_FIXTURE, t2Visited: true, t2VisitAtSec: null };
      const r = validateTradeOutcome(bad);
      expect(r.warnings.some((w) => w.includes('T2 t2Visited=true but t2VisitAtSec is null'))).toBe(true);
    });

    it('T3Visited=false + t3VisitAtSec=set → warning', () => {
      const bad = { ...PAPER_FIXTURE, t3Visited: false, t3VisitAtSec: 1745001234 };
      const r = validateTradeOutcome(bad);
      expect(r.warnings.some((w) => w.includes('T3 t3Visited=false but t3VisitAtSec is set'))).toBe(true);
    });
  });
});

// ─── Funnel ─────────────────────────────────────────────────

describe('researchLedgerValidator — kol-call-funnel/v1', () => {
  const FUNNEL_FIXTURE: KolCallFunnelV1 = {
    schemaVersion: KOL_CALL_FUNNEL_SCHEMA_VERSION,
    recordId: 'rec_funnel_001',
    eventId: 'event_abc',
    emitNonce: 'nonce_xyz_1',
    emitTsMs: 1745000123456,
    sessionId: 'sess_2026_05_01_a',
    eventType: 'kol_call',
    tokenMint: 'So11111111111111111111111111111111111111112',
    kolId: 'decu',
    kolTier: 'A',
    walletAddress: 'BCagckXeMChUKrHEd6fKFA1uiWDtcmCXMsqaheLiUPJd',
    action: 'buy',
    solAmount: 1.45,
    isShadowKol: false,
    txSignature: 'sig_kol_buy_abc',
  };

  it('kol_call fixture validates', () => {
    const r = validateFunnelRecord(FUNNEL_FIXTURE);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("eventType='entry_open' + positionId 누락 → invalid", () => {
    const bad: Partial<KolCallFunnelV1> = {
      ...FUNNEL_FIXTURE,
      eventType: 'entry_open',
      // positionId 일부러 누락
    };
    delete (bad as Partial<KolCallFunnelV1>).positionId;
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("eventType='entry_open' → positionId required (non-empty string)");
  });

  it("eventType='survival_reject' + rejectCategory 누락 → invalid", () => {
    const bad: Partial<KolCallFunnelV1> = {
      ...FUNNEL_FIXTURE,
      eventType: 'survival_reject',
    };
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("eventType='survival_reject' → rejectCategory required (non-empty string)");
  });

  // Codex S2.5 P2-2 — truthy non-string 차단
  it("eventType='entry_open' + positionId=123 (truthy non-string) → invalid", () => {
    const bad: Partial<KolCallFunnelV1> = {
      ...FUNNEL_FIXTURE,
      eventType: 'entry_open',
      positionId: 123 as unknown as string,
    };
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("eventType='entry_open' → positionId required (non-empty string)");
  });

  it("eventType='survival_reject' + rejectCategory={} (truthy object) → invalid", () => {
    const bad: Partial<KolCallFunnelV1> = {
      ...FUNNEL_FIXTURE,
      eventType: 'survival_reject',
      rejectCategory: {} as unknown as string,
    };
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("eventType='survival_reject' → rejectCategory required (non-empty string)");
  });

  it("eventType='entry_open' + positionId='' (empty string) → invalid", () => {
    const bad: Partial<KolCallFunnelV1> = {
      ...FUNNEL_FIXTURE,
      eventType: 'entry_open',
      positionId: '',
    };
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("eventType='entry_open' → positionId required (non-empty string)");
  });

  it('eventId === emitNonce → warning (Codex M1 — 3-key 분리 위반)', () => {
    const bad: Partial<KolCallFunnelV1> = {
      ...FUNNEL_FIXTURE,
      eventId: 'same_value',
      emitNonce: 'same_value',
    };
    const r = validateFunnelRecord(bad);
    expect(r.warnings.some((w) => w.includes('eventId === emitNonce'))).toBe(true);
  });

  it('필수 필드 (recordId / eventId / emitNonce) 누락 → invalid', () => {
    const bad: Partial<KolCallFunnelV1> = { ...FUNNEL_FIXTURE };
    delete bad.recordId;
    delete bad.eventId;
    delete bad.emitNonce;
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('missing required field: recordId');
    expect(r.errors).toContain('missing required field: eventId');
    expect(r.errors).toContain('missing required field: emitNonce');
  });

  // Codex M4 — funnel deeper validation
  it('빈 문자열 recordId → invalid', () => {
    const bad: Partial<KolCallFunnelV1> = { ...FUNNEL_FIXTURE, recordId: '' };
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('recordId must be non-empty'))).toBe(true);
  });

  it('emitTsMs 0 → invalid', () => {
    const bad: Partial<KolCallFunnelV1> = { ...FUNNEL_FIXTURE, emitTsMs: 0 };
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('emitTsMs must be positive'))).toBe(true);
  });

  it("kolTier 'Z' → invalid", () => {
    const bad: Partial<KolCallFunnelV1> = { ...FUNNEL_FIXTURE, kolTier: 'Z' as 'A' };
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("kolTier must be 'S'|'A'|'B'"))).toBe(true);
  });

  it('solAmount NaN → invalid', () => {
    const bad: Partial<KolCallFunnelV1> = { ...FUNNEL_FIXTURE, solAmount: NaN };
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('solAmount must be finite'))).toBe(true);
  });

  // Codex F1 — eventType enum 강제
  it("eventType 'bogus_event' → invalid (Codex F1)", () => {
    const bad: Partial<KolCallFunnelV1> = {
      ...FUNNEL_FIXTURE,
      eventType: 'bogus_event' as 'kol_call',
    };
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('eventType must be one of'))).toBe(true);
  });

  // Codex F1 — action enum 강제
  it("action 'transfer' → invalid (Codex F1)", () => {
    const bad: Partial<KolCallFunnelV1> = {
      ...FUNNEL_FIXTURE,
      action: 'transfer' as 'buy',
    };
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("action must be 'buy' | 'sell'"))).toBe(true);
  });

  // Codex F5 — solAmount < 0 차단
  it('negative solAmount → invalid (Codex F5)', () => {
    const bad: Partial<KolCallFunnelV1> = { ...FUNNEL_FIXTURE, solAmount: -1.5 };
    const r = validateFunnelRecord(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('solAmount must be >= 0'))).toBe(true);
  });
});

// ─── Codex M1 — eventId determinism ───────────────────────

describe('computeEventId — Codex M1 (S1.5) deterministic dedupe', () => {
  it('weak key (no sig/positionId) — 동일 1초 버킷 → 동일 hash', () => {
    const id1 = computeEventId({
      eventType: 'survival_reject',
      tokenMint: 'XYZ',
      emitTsMs: 1745000123456,
      rejectCategory: 'NO_SECURITY_DATA',
    });
    const id2 = computeEventId({
      eventType: 'survival_reject',
      tokenMint: 'XYZ',
      emitTsMs: 1745000123999, // 같은 1초 버킷
      rejectCategory: 'NO_SECURITY_DATA',
    });
    expect(id1).toBe(id2);
  });

  it('weak key — 다른 1초 버킷 → 다른 hash', () => {
    const id1 = computeEventId({
      eventType: 'survival_reject',
      tokenMint: 'XYZ',
      emitTsMs: 1745000122999,
      rejectCategory: 'NO_SECURITY_DATA',
    });
    const id2 = computeEventId({
      eventType: 'survival_reject',
      tokenMint: 'XYZ',
      emitTsMs: 1745000123000,
      rejectCategory: 'NO_SECURITY_DATA',
    });
    expect(id1).not.toBe(id2);
  });

  it('다른 eventType → 다른 hash', () => {
    const id1 = computeEventId({ eventType: 'kol_call', tokenMint: 'XYZ', emitTsMs: 1 });
    const id2 = computeEventId({ eventType: 'pending_open', tokenMint: 'XYZ', emitTsMs: 1 });
    expect(id1).not.toBe(id2);
  });

  // Codex M1 (S1.5) 보정 핵심: strong key 있으면 bucket 무관 — 재시작 dedupe 보장.
  it('strong key (txSignature) — 1시간 차이 timestamp 라도 동일 hash (재시작 dedupe)', () => {
    const id1 = computeEventId({
      eventType: 'entry_open',
      tokenMint: 'XYZ',
      emitTsMs: 1000,
      txSignature: 'sig_abc',
      positionId: 'pos1',
    });
    const id2 = computeEventId({
      eventType: 'entry_open',
      tokenMint: 'XYZ',
      emitTsMs: 1000 + 3_600_000, // +1시간
      txSignature: 'sig_abc',
      positionId: 'pos1',
    });
    expect(id1).toBe(id2);
  });

  it('strong key (positionId only) — bucket 무관 동일', () => {
    const id1 = computeEventId({
      eventType: 'position_close',
      tokenMint: 'XYZ',
      emitTsMs: 1000,
      positionId: 'pos1',
    });
    const id2 = computeEventId({
      eventType: 'position_close',
      tokenMint: 'XYZ',
      emitTsMs: 999_999_999,
      positionId: 'pos1',
    });
    expect(id1).toBe(id2);
  });

  it('strong key — 다른 positionId → 다른 hash', () => {
    const id1 = computeEventId({ eventType: 'entry_open', tokenMint: 'XYZ', emitTsMs: 1, positionId: 'pos1' });
    const id2 = computeEventId({ eventType: 'entry_open', tokenMint: 'XYZ', emitTsMs: 1, positionId: 'pos2' });
    expect(id1).not.toBe(id2);
  });

  it('weak key vs strong key — 같은 cosmetic input 이라도 다른 hash (bucket 포함 여부 다름)', () => {
    const weak = computeEventId({ eventType: 'kol_call', tokenMint: 'XYZ', emitTsMs: 1000 });
    const strong = computeEventId({ eventType: 'kol_call', tokenMint: 'XYZ', emitTsMs: 1000, txSignature: 'sig' });
    expect(weak).not.toBe(strong);
  });
});

// ─── recordId — eventId+emitNonce 조합 ────────────────────

describe('computeRecordId — eventId + emitNonce', () => {
  it('동일 eventId 라도 emitNonce 다르면 distinct recordId', () => {
    const eventId = 'same_event';
    const r1 = computeRecordId(eventId, 'nonce1');
    const r2 = computeRecordId(eventId, 'nonce2');
    expect(r1).not.toBe(r2);
  });

  it('완전 동일 input → 동일 recordId (이론적으로 collision rate ~0 — 실제로는 nonce process-local 이라 발생 안 함)', () => {
    const r1 = computeRecordId('e1', 'n1');
    const r2 = computeRecordId('e1', 'n1');
    expect(r1).toBe(r2);
  });
});
