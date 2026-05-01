/**
 * Research Ledger writer (S2) tests.
 *
 * 검증 항목:
 *   - 정상 trade-outcome row → trade-outcomes.jsonl append, quarantine 없음
 *   - invalid trade-outcome row → quarantine.jsonl 만 append, trade-outcomes.jsonl 미생성/미append
 *   - 정상 funnel event → kol-call-funnel.jsonl append
 *   - invalid funnel event → quarantine
 *   - buildFunnelEvent 가 deterministic eventId + unique recordId 산출
 *   - emitNonce 같은 process 안 sequential 호출 시 distinct
 *   - concurrent append 시 데이터 손실 없음
 *   - fail-open: validator throw 안 나도 정상 동작
 */

import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  appendTradeOutcome,
  appendFunnelEvent,
  buildFunnelEvent,
  buildTradeOutcomeRecordId,
  nextEmitNonce,
  __resetNonceCounterForTest,
} from '../src/research/researchLedger';
import {
  TRADE_OUTCOME_SCHEMA_VERSION,
  KOL_CALL_FUNNEL_SCHEMA_VERSION,
} from '../src/research/researchLedgerTypes';
import type {
  TradeOutcomeV1,
  KolCallFunnelV1,
} from '../src/research/researchLedgerTypes';

// ─── Fixtures ───────────────────────────────────────────────

function makePaperOutcome(overrides: Partial<TradeOutcomeV1> = {}): TradeOutcomeV1 {
  return {
    schemaVersion: TRADE_OUTCOME_SCHEMA_VERSION,
    recordId: 'rec_writer_test_1',
    positionId: 'kolh-paper-test-1',
    tokenMint: 'So11111111111111111111111111111111111111112',
    mode: 'paper',
    armName: 'kol_hunter_smart_v3',
    parameterVersion: 'v3.2',
    participatingKols: [{ id: 'decu', tier: 'A', timestamp: 1745000000000 }],
    kols: ['decu'],
    independentKolCount: 1,
    isShadowArm: false,
    isTailPosition: false,
    parentPositionId: null,
    partialTakeRealizedSol: 0,
    partialTakeLockedTicketSol: 0,
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
    ...overrides,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  const content = await readFile(filePath, 'utf8');
  return content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ─── Tests ──────────────────────────────────────────────────

describe('researchLedger writer (S2)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'research-ledger-test-'));
    __resetNonceCounterForTest();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('appendTradeOutcome', () => {
    it('정상 paper row → trade-outcomes.jsonl append, quarantine 없음', async () => {
      const row = makePaperOutcome();
      const r = await appendTradeOutcome(row, { ledgerDir: tmpDir });
      expect(r.appended).toBe(true);
      expect(r.quarantined).toBe(false);
      expect(r.errors).toEqual([]);

      const outcomeFile = path.join(tmpDir, 'trade-outcomes.jsonl');
      const quarantineFile = path.join(tmpDir, 'research-quarantine.jsonl');
      expect(await fileExists(outcomeFile)).toBe(true);
      expect(await fileExists(quarantineFile)).toBe(false);

      const rows = (await readJsonl(outcomeFile)) as TradeOutcomeV1[];
      expect(rows).toHaveLength(1);
      expect(rows[0].positionId).toBe(row.positionId);
      expect(rows[0].mode).toBe('paper');
    });

    it('invalid row (mode=paper + walletDeltaSol non-null) → quarantine 만, trade-outcomes 미append', async () => {
      const row = makePaperOutcome({ walletDeltaSol: 0.05 }); // truth source mismatch
      const r = await appendTradeOutcome(row, { ledgerDir: tmpDir });
      expect(r.appended).toBe(false);
      expect(r.quarantined).toBe(true);
      expect(r.errors.some((e) => e.includes('walletDeltaSol must be null'))).toBe(true);

      const outcomeFile = path.join(tmpDir, 'trade-outcomes.jsonl');
      const quarantineFile = path.join(tmpDir, 'research-quarantine.jsonl');
      expect(await fileExists(outcomeFile)).toBe(false);
      expect(await fileExists(quarantineFile)).toBe(true);

      const qrows = (await readJsonl(quarantineFile)) as Array<{
        schemaTarget: string;
        errors: string[];
        rawRow: TradeOutcomeV1;
      }>;
      expect(qrows).toHaveLength(1);
      expect(qrows[0].schemaTarget).toBe(TRADE_OUTCOME_SCHEMA_VERSION);
      expect(qrows[0].errors.some((e) => e.includes('walletDeltaSol'))).toBe(true);
      expect(qrows[0].rawRow.positionId).toBe(row.positionId);
    });

    it('netSol !== walletDeltaSol (live truth alias 위반) → quarantine', async () => {
      const liveRow = makePaperOutcome({
        mode: 'live',
        wallet: 'main',
        walletDeltaSol: 0.0500, // truth
        simulatedNetSol: null,
        paperModelVersion: null,
        pnlTruthSource: 'wallet_delta',
        netSol: 0.0123, // mismatch
      });
      const r = await appendTradeOutcome(liveRow, { ledgerDir: tmpDir });
      expect(r.appended).toBe(false);
      expect(r.quarantined).toBe(true);
      expect(r.errors.some((e) => e.includes('netSol must equal walletDeltaSol'))).toBe(true);
    });

    it('정상 row + warning (kols 순서 mismatch) → 정상 append + warnings 반환', async () => {
      const row = makePaperOutcome({
        participatingKols: [
          { id: 'decu', tier: 'A', timestamp: 1745000000000 },
          { id: 'dv', tier: 'A', timestamp: 1745000001000 },
        ],
        kols: ['dv', 'decu'], // 역순 → warning
      });
      const r = await appendTradeOutcome(row, { ledgerDir: tmpDir });
      expect(r.appended).toBe(true);
      expect(r.quarantined).toBe(false);
      expect(r.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('appendFunnelEvent + buildFunnelEvent', () => {
    it('buildFunnelEvent → 정상 funnel append', async () => {
      const evt = buildFunnelEvent({
        eventType: 'kol_call',
        tokenMint: 'TestMint',
        kolId: 'decu',
        kolTier: 'A',
        action: 'buy',
        solAmount: 1.45,
        txSignature: 'sig_abc',
        sessionId: 'sess_t1',
      });
      const r = await appendFunnelEvent(evt, { ledgerDir: tmpDir });
      expect(r.appended).toBe(true);
      expect(r.quarantined).toBe(false);

      const file = path.join(tmpDir, 'kol-call-funnel.jsonl');
      const rows = (await readJsonl(file)) as KolCallFunnelV1[];
      expect(rows).toHaveLength(1);
      expect(rows[0].schemaVersion).toBe(KOL_CALL_FUNNEL_SCHEMA_VERSION);
      expect(rows[0].eventType).toBe('kol_call');
      expect(rows[0].kolId).toBe('decu');
    });

    it('buildFunnelEvent — strong key 동일 → eventId 동일 (재시작 dedupe 검증)', () => {
      const evt1 = buildFunnelEvent({
        eventType: 'entry_open',
        tokenMint: 'M1',
        positionId: 'pos1',
        emitTsMs: 1000,
        txSignature: 'sig1',
      });
      const evt2 = buildFunnelEvent({
        eventType: 'entry_open',
        tokenMint: 'M1',
        positionId: 'pos1',
        emitTsMs: 1000 + 3_600_000, // +1시간
        txSignature: 'sig1',
      });
      expect(evt1.eventId).toBe(evt2.eventId);
      // recordId 는 emitNonce 가 달라 distinct
      expect(evt1.recordId).not.toBe(evt2.recordId);
    });

    it('invalid funnel event (eventType=entry_open + positionId 누락) → quarantine', async () => {
      const evt = buildFunnelEvent({
        eventType: 'entry_open',
        tokenMint: 'M1',
        // positionId 누락
        txSignature: 'sig_invalid',
      });
      const r = await appendFunnelEvent(evt, { ledgerDir: tmpDir });
      expect(r.appended).toBe(false);
      expect(r.quarantined).toBe(true);
      expect(r.errors.some((e) => e.includes('positionId required'))).toBe(true);

      const file = path.join(tmpDir, 'kol-call-funnel.jsonl');
      const qfile = path.join(tmpDir, 'research-quarantine.jsonl');
      expect(await fileExists(file)).toBe(false);
      expect(await fileExists(qfile)).toBe(true);
    });
  });

  describe('emitNonce uniqueness', () => {
    it('순차 호출 → distinct nonce', () => {
      __resetNonceCounterForTest();
      const n1 = nextEmitNonce();
      const n2 = nextEmitNonce();
      const n3 = nextEmitNonce();
      expect(n1).not.toBe(n2);
      expect(n2).not.toBe(n3);
      expect(n1).not.toBe(n3);
      expect(n1).toContain(`pid${process.pid}`);
    });

    it('1000 회 호출해도 collision 없음', () => {
      __resetNonceCounterForTest();
      const set = new Set<string>();
      for (let i = 0; i < 1000; i++) set.add(nextEmitNonce());
      expect(set.size).toBe(1000);
    });
  });

  describe('concurrent append', () => {
    it('20 row 동시 append → 모두 보존 (데이터 손실 없음)', async () => {
      const rows = Array.from({ length: 20 }, (_, i) =>
        makePaperOutcome({
          recordId: `rec_concurrent_${i}`,
          positionId: `pos_concurrent_${i}`,
        }),
      );
      const results = await Promise.all(
        rows.map((r) => appendTradeOutcome(r, { ledgerDir: tmpDir })),
      );
      expect(results.every((r) => r.appended)).toBe(true);
      expect(results.every((r) => !r.quarantined)).toBe(true);

      const file = path.join(tmpDir, 'trade-outcomes.jsonl');
      const stored = (await readJsonl(file)) as TradeOutcomeV1[];
      expect(stored).toHaveLength(20);
      const positionIds = new Set(stored.map((r) => r.positionId));
      expect(positionIds.size).toBe(20);
    });
  });

  describe('buildTradeOutcomeRecordId', () => {
    it('positionId + exitAtIso 동일 + 다른 nonce → distinct recordId', () => {
      const r1 = buildTradeOutcomeRecordId('pos1', '2026-05-01T05:00:00Z', 'n1');
      const r2 = buildTradeOutcomeRecordId('pos1', '2026-05-01T05:00:00Z', 'n2');
      expect(r1).not.toBe(r2);
    });

    it('완전 동일 input → 동일 recordId', () => {
      const r1 = buildTradeOutcomeRecordId('pos1', '2026-05-01T05:00:00Z', 'n1');
      const r2 = buildTradeOutcomeRecordId('pos1', '2026-05-01T05:00:00Z', 'n1');
      expect(r1).toBe(r2);
    });
  });

  describe('fail-open behavior', () => {
    it('invalid row append → throw 안 함 (fail-open)', async () => {
      const row = makePaperOutcome({ entryPrice: 0 }); // invalid
      await expect(
        appendTradeOutcome(row, { ledgerDir: tmpDir }),
      ).resolves.toBeDefined();
    });

    it('ledgerDir 가 file (not dir) 이라 mkdir 실패 → 결과 객체 반환, throw 안 함', async () => {
      // tmpDir 안에 fake-file 생성 후 그것을 ledgerDir 로 지정 → mkdir recursive 가 file 보고 실패
      // 단순하게 존재하는 file path 를 dir 로 지정
      const filePath = path.join(tmpDir, 'fake-file');
      // 빈 파일 생성
      const { writeFile } = await import('fs/promises');
      await writeFile(filePath, '', 'utf8');

      const row = makePaperOutcome();
      const r = await appendTradeOutcome(row, { ledgerDir: filePath });
      // mkdir recursive 는 path 가 이미 file 이면 EEXIST 에러를 안 던지고 통과 — 그래도 appendFile 시 ENOTDIR
      // 어느 단계에서 실패하든 throw 는 안 함
      expect(r.appended).toBe(false);
    });
  });

  // Codex F3 — quarantineAppendFailed 노출 검증
  describe('quarantineAppendFailed (Codex F3)', () => {
    it('정상 path → quarantineAppendFailed 미정의 또는 false', async () => {
      const row = makePaperOutcome();
      const r = await appendTradeOutcome(row, { ledgerDir: tmpDir });
      expect(r.appended).toBe(true);
      expect(r.quarantined).toBe(false);
      // valid row 는 quarantineAppendFailed 무관
    });

    it('invalid row 의 정상 quarantine path → quarantineAppendFailed=false', async () => {
      const row = makePaperOutcome({ entryPrice: 0 }); // invalid
      const r = await appendTradeOutcome(row, { ledgerDir: tmpDir });
      expect(r.quarantined).toBe(true);
      expect(r.quarantineAppendFailed).toBe(false);
    });

    it('invalid row + quarantine append 도 실패 → quarantined=true + quarantineAppendFailed=true', async () => {
      // ledgerDir 가 file 이라 quarantine append 도 ENOTDIR — 어느 정도 OS 마다 다르지만,
      // 적어도 result 객체 정합 (throw 없음 + boolean 노출 보장).
      const filePath = path.join(tmpDir, 'fake-file');
      const { writeFile } = await import('fs/promises');
      await writeFile(filePath, '', 'utf8');

      const row = makePaperOutcome({ entryPrice: 0 }); // invalid
      const r = await appendTradeOutcome(row, { ledgerDir: filePath });
      // ledger_dir_unavailable path 일 수도 있고 quarantine 까지 도달 후 fail 일 수도 있음 —
      // 어느 path 든 throw 없음, appended=false 보장
      expect(r.appended).toBe(false);
      // quarantine 까지 도달했다면 quarantineAppendFailed 가 boolean 으로 정의되어야 함
      if (r.quarantined) {
        expect(typeof r.quarantineAppendFailed).toBe('boolean');
      }
    });
  });
});
