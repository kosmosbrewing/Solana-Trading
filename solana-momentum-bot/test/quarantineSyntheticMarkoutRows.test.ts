/**
 * quarantine-synthetic-markout-rows tests (2026-06-10 edge audit).
 * 실 데이터는 건드리지 않는다 — 모든 검증은 mkdtemp fixture 로만 수행.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  BASE58_MINT_RE,
  isSyntheticMarkoutRow,
  quarantineSyntheticMarkoutRows,
} from '../scripts/quarantine-synthetic-markout-rows';

const REAL_MINT = 'vA8xka9xg5RDGZj79zfxVdDmtcd3BYpiBfVq6Jotdup';
const REAL_MINT_2 = 'So11111111111111111111111111111111111111112';

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

describe('quarantine-synthetic-markout-rows', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'quarantine-markout-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('base58 regex accepts real mints and rejects synthetic pair names', () => {
    expect(BASE58_MINT_RE.test(REAL_MINT)).toBe(true);
    expect(BASE58_MINT_RE.test(REAL_MINT_2)).toBe(true);
    expect(BASE58_MINT_RE.test('PAIR7')).toBe(false);
    expect(BASE58_MINT_RE.test('PAIR_SURVIVAL_MISSING_ALLOW')).toBe(false);
    // base58 제외 문자 (0, O, I, l) 포함 시 reject
    expect(BASE58_MINT_RE.test('O0Il'.repeat(10))).toBe(false);
    expect(isSyntheticMarkoutRow({ tokenMint: 'PAIR7' })).toBe(true);
    expect(isSyntheticMarkoutRow({})).toBe(true);
    expect(isSyntheticMarkoutRow({ tokenMint: REAL_MINT })).toBe(false);
  });

  it('moves synthetic rows to quarantine sidecar, rewrites originals, makes .bak backups', async () => {
    const anchorsFile = path.join(dir, 'trade-markout-anchors.jsonl');
    const markoutsFile = path.join(dir, 'trade-markouts.jsonl');
    await writeFile(anchorsFile, jsonl([
      { tokenMint: REAL_MINT, positionId: 'live-1' },
      { tokenMint: 'PAIR7', positionId: 'purews-PAIR7-1' },
      { tokenMint: REAL_MINT_2, positionId: 'live-2' },
      { tokenMint: 'PAIR_SURVIVAL_MISSING_ALLOW', positionId: 'purews-PAIR_SURV-1' },
    ]));
    await writeFile(markoutsFile, jsonl([
      { tokenMint: 'PAIR7', positionId: 'purews-PAIR7-1', horizonSec: 15 },
      { tokenMint: REAL_MINT, positionId: 'live-1', horizonSec: 30 },
    ]));

    const results = await quarantineSyntheticMarkoutRows({
      realtimeDir: dir,
      now: new Date('2026-06-10T05:00:00.000Z'),
    });

    const anchorsResult = results.find((r) => r.file === anchorsFile)!;
    expect(anchorsResult.totalRows).toBe(4);
    expect(anchorsResult.keptRows).toBe(2);
    expect(anchorsResult.quarantinedRows).toBe(2);
    expect(anchorsResult.backupPath).toBe(`${anchorsFile}.bak-20260610T050000Z`);

    const markoutsResult = results.find((r) => r.file === markoutsFile)!;
    expect(markoutsResult.quarantinedRows).toBe(1);
    expect(markoutsResult.keptRows).toBe(1);

    // 원본 재작성: 정상 mint 만 남는다
    const rewrittenAnchors = (await readFile(anchorsFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rewrittenAnchors.map((r) => r.tokenMint)).toEqual([REAL_MINT, REAL_MINT_2]);

    // quarantine sidecar 에 synthetic row 가 이동
    const quarantinedAnchors = (await readFile(
      path.join(dir, 'quarantine', 'trade-markout-anchors.synthetic.jsonl'), 'utf8'
    )).trim().split('\n').map((l) => JSON.parse(l));
    expect(quarantinedAnchors.map((r) => r.tokenMint)).toEqual(['PAIR7', 'PAIR_SURVIVAL_MISSING_ALLOW']);
    const quarantinedMarkouts = (await readFile(
      path.join(dir, 'quarantine', 'trade-markouts.synthetic.jsonl'), 'utf8'
    )).trim().split('\n').map((l) => JSON.parse(l));
    expect(quarantinedMarkouts).toHaveLength(1);
    expect(quarantinedMarkouts[0].tokenMint).toBe('PAIR7');

    // 백업은 원본 그대로 (4 rows)
    const backup = (await readFile(anchorsResult.backupPath!, 'utf8')).trim().split('\n');
    expect(backup).toHaveLength(4);
  });

  it('keeps unparseable lines in the original and counts them', async () => {
    const anchorsFile = path.join(dir, 'trade-markout-anchors.jsonl');
    await writeFile(
      anchorsFile,
      JSON.stringify({ tokenMint: 'PAIR7' }) + '\n' + '{broken json\n' + JSON.stringify({ tokenMint: REAL_MINT }) + '\n'
    );

    const results = await quarantineSyntheticMarkoutRows({ realtimeDir: dir });
    const anchorsResult = results.find((r) => r.file === anchorsFile)!;
    expect(anchorsResult.unparseableLines).toBe(1);
    expect(anchorsResult.quarantinedRows).toBe(1);
    expect(anchorsResult.keptRows).toBe(1);

    const rewritten = (await readFile(anchorsFile, 'utf8')).trim().split('\n');
    expect(rewritten).toContain('{broken json');
  });

  it('is a no-op (no backup, no rewrite) when there are no synthetic rows', async () => {
    const anchorsFile = path.join(dir, 'trade-markout-anchors.jsonl');
    const original = jsonl([{ tokenMint: REAL_MINT }]);
    await writeFile(anchorsFile, original);

    const results = await quarantineSyntheticMarkoutRows({ realtimeDir: dir });
    const anchorsResult = results.find((r) => r.file === anchorsFile)!;
    expect(anchorsResult.quarantinedRows).toBe(0);
    expect(anchorsResult.backupPath).toBeNull();
    expect(await readFile(anchorsFile, 'utf8')).toBe(original);
    const entries = await readdir(dir);
    expect(entries.some((name) => name.includes('.bak-'))).toBe(false);
    expect(entries).not.toContain('quarantine');
  });

  it('dry-run reports counts without touching any file', async () => {
    const anchorsFile = path.join(dir, 'trade-markout-anchors.jsonl');
    const original = jsonl([{ tokenMint: 'PAIR7' }, { tokenMint: REAL_MINT }]);
    await writeFile(anchorsFile, original);

    const results = await quarantineSyntheticMarkoutRows({ realtimeDir: dir, dryRun: true });
    const anchorsResult = results.find((r) => r.file === anchorsFile)!;
    expect(anchorsResult.quarantinedRows).toBe(1);
    expect(anchorsResult.backupPath).toBeNull();
    expect(await readFile(anchorsFile, 'utf8')).toBe(original);
    expect(await readdir(dir)).toEqual(['trade-markout-anchors.jsonl']);
  });

  it('skips missing ledger files', async () => {
    const results = await quarantineSyntheticMarkoutRows({ realtimeDir: dir });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.existed === false)).toBe(true);
  });
});
