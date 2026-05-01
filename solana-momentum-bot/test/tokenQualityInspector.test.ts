/**
 * Token Quality Inspector 단위 테스트 (2026-05-01, Decu Phase B.1).
 */
import { mkdir, readFile, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  appendTokenQualityObservation,
  isObservationDeduped,
  resetTokenQualityInspectorState,
  __testInjectObservation,
  buildDedupKey,
  type TokenQualityRecord,
} from '../src/observability/tokenQualityInspector';

function makeRecord(mint: string, positionId = `pos-${mint}`): TokenQualityRecord {
  return {
    schemaVersion: 'token-quality/v1',
    tokenMint: mint,
    observedAt: new Date().toISOString(),
    riskFlags: [],
    observationContext: { positionId, armName: 'kol_hunter_smart_v3', isLive: false, isShadowArm: false },
  };
}

describe('tokenQualityInspector', () => {
  let tmpDir: string;
  let outputFile: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `tqi-test-${Date.now()}-${Math.random()}`);
    await mkdir(tmpDir, { recursive: true });
    outputFile = path.join(tmpDir, 'token-quality-observations.jsonl');
    resetTokenQualityInspectorState();
  });

  afterEach(async () => {
    resetTokenQualityInspectorState();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('buildDedupKey', () => {
    it('positionId 있으면 pos: prefix', () => {
      expect(buildDedupKey({ tokenMint: 'm', positionId: 'pos-123' })).toBe('pos:pos-123');
    });
    it('positionId 없으면 mint + cohort 조합', () => {
      expect(buildDedupKey({
        tokenMint: 'mint1',
        armName: 'kol_hunter_smart_v3',
        isLive: true,
        isShadowArm: false,
      })).toBe('mint:mint1|arm:kol_hunter_smart_v3|live:1|shadow:0');
    });
    it('paper / live / shadow 분리 — 같은 mint 도 다른 key', () => {
      const base = { tokenMint: 'mint1', armName: 'kol_hunter_smart_v3' };
      const paper = buildDedupKey({ ...base, isLive: false, isShadowArm: false });
      const live = buildDedupKey({ ...base, isLive: true, isShadowArm: false });
      const shadow = buildDedupKey({ ...base, isLive: false, isShadowArm: true });
      expect(paper).not.toBe(live);
      expect(paper).not.toBe(shadow);
      expect(live).not.toBe(shadow);
    });
  });

  describe('isObservationDeduped', () => {
    it('cache miss → false', () => {
      expect(isObservationDeduped('pos:p1')).toBe(false);
    });

    it('inject 후 24h 안 → true', () => {
      __testInjectObservation('pos:p1', Date.now());
      expect(isObservationDeduped('pos:p1', 24)).toBe(true);
    });

    it('TTL 초과 → false', () => {
      __testInjectObservation('pos:p1', Date.now() - 25 * 3600 * 1000);
      expect(isObservationDeduped('pos:p1', 24)).toBe(false);
    });
  });

  describe('appendTokenQualityObservation', () => {
    it('disabled → false (write 0)', async () => {
      const ok = await appendTokenQualityObservation(makeRecord('mint1'), {
        enabled: false,
        outputFile,
      });
      expect(ok).toBe(false);
    });

    it('outputFile 미설정 → false', async () => {
      const ok = await appendTokenQualityObservation(makeRecord('mint1'), {
        enabled: true,
        outputFile: '',
      });
      expect(ok).toBe(false);
    });

    it('정상 write → true + 파일에 1 record', async () => {
      const rec = makeRecord('mint1');
      const ok = await appendTokenQualityObservation(rec, {
        enabled: true,
        outputFile,
      });
      expect(ok).toBe(true);
      const content = await readFile(outputFile, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.tokenMint).toBe('mint1');
      expect(parsed.schemaVersion).toBe('token-quality/v1');
    });

    it('동일 positionId 즉시 재호출 → dedup hit (false)', async () => {
      await appendTokenQualityObservation(makeRecord('mint1'), { enabled: true, outputFile });
      const ok = await appendTokenQualityObservation(makeRecord('mint1'), { enabled: true, outputFile });
      expect(ok).toBe(false);
    });

    // 2026-05-01 (codex F1 회귀): 같은 mint 도 paper/live/shadow cohort 별도 record.
    it('codex F1: 같은 mint 의 paper/live/shadow 는 dedup 안 됨 (cohort 분리 보장)', async () => {
      const paper: TokenQualityRecord = {
        schemaVersion: 'token-quality/v1', tokenMint: 'mint1', observedAt: new Date().toISOString(), riskFlags: [],
        observationContext: { positionId: 'pos-paper', isLive: false, isShadowArm: false, armName: 'a' },
      };
      const live: TokenQualityRecord = {
        ...paper,
        observationContext: { positionId: 'pos-live', isLive: true, isShadowArm: false, armName: 'a' },
      };
      const shadow: TokenQualityRecord = {
        ...paper,
        observationContext: { positionId: 'pos-shadow', isLive: false, isShadowArm: true, armName: 'a' },
      };
      const r1 = await appendTokenQualityObservation(paper, { enabled: true, outputFile });
      const r2 = await appendTokenQualityObservation(live, { enabled: true, outputFile });
      const r3 = await appendTokenQualityObservation(shadow, { enabled: true, outputFile });
      expect(r1).toBe(true);
      expect(r2).toBe(true);  // 같은 mint 지만 다른 positionId → 정상 record
      expect(r3).toBe(true);
      const lines = (await readFile(outputFile, 'utf8')).split('\n').filter((l) => l.trim());
      expect(lines).toHaveLength(3);
    });

    it('다른 mint → 재기록 (dedup 무관)', async () => {
      await appendTokenQualityObservation(makeRecord('mint1'), { enabled: true, outputFile });
      const ok = await appendTokenQualityObservation(makeRecord('mint2'), { enabled: true, outputFile });
      expect(ok).toBe(true);
      const lines = (await readFile(outputFile, 'utf8')).split('\n').filter((l) => l.trim());
      expect(lines).toHaveLength(2);
    });

    it('write 실패 → false (silent, throw 안 함)', async () => {
      // 디렉토리가 아닌 파일을 outputFile 의 부모로 만들어 write 실패 유도
      const ok = await appendTokenQualityObservation(makeRecord('mint1'), {
        enabled: true,
        outputFile: '/nonexistent/deep/path/file.jsonl',
      });
      expect(ok).toBe(false);
    });
  });
});
