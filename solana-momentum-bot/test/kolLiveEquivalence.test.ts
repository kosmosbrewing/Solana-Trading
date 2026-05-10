import { mkdtemp, readFile, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  appendKolLiveEquivalence,
  KOL_LIVE_EQUIVALENCE_SCHEMA_VERSION,
} from '../src/observability/kolLiveEquivalence';
import { buildReport } from '../scripts/kol-live-equivalence-report';

describe('kol live equivalence observability', () => {
  it('appends fail-open sidecar rows as jsonl', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kol-live-equivalence-'));
    await appendKolLiveEquivalence({
      schemaVersion: KOL_LIVE_EQUIVALENCE_SCHEMA_VERSION,
      generatedAt: '2026-05-09T00:00:00.000Z',
      candidateId: 'mint:rotation-underfill:arm:1',
      tokenMint: 'mint',
      entrySignalLabel: 'rotation-underfill',
      armName: 'rotation_underfill_v1',
      parameterVersion: 'rotation-underfill-v1.0.0',
      entryReason: 'rotation_v1',
      convictionLevel: 'MEDIUM_HIGH',
      paperWouldEnter: true,
      liveWouldEnter: false,
      liveAttempted: false,
      decisionStage: 'yellow_zone',
      liveBlockReason: 'single_kol_live_not_enough',
      liveBlockFlags: ['SINGLE_KOL_LIVE_NOT_ENOUGH'],
      paperOnlyReason: null,
      isShadowKol: false,
      isLiveCanaryActive: true,
      hasBotContext: true,
      independentKolCount: 1,
      effectiveIndependentKolCount: 1,
      kolScore: 5,
      participatingKols: [{ id: 'kol', tier: 'S', timestamp: 1 }],
      survivalFlags: ['SINGLE_KOL_LIVE_NOT_ENOUGH'],
      source: 'runtime',
    }, { realtimeDir: dir });

    const raw = await readFile(path.join(dir, 'kol-live-equivalence.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(expect.objectContaining({
      candidateId: 'mint:rotation-underfill:arm:1',
      liveBlockReason: 'single_kol_live_not_enough',
    }));
  });

  it('joins candidate id to paper outcomes in the report', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kol-live-equivalence-report-'));
    await writeFile(path.join(dir, 'kol-live-equivalence.jsonl'), JSON.stringify({
      schemaVersion: KOL_LIVE_EQUIVALENCE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      candidateId: 'candidate-1',
      tokenMint: 'mint',
      entrySignalLabel: 'rotation-underfill',
      armName: 'rotation_underfill_v1',
      parameterVersion: 'rotation-underfill-v1.0.0',
      entryReason: 'rotation_v1',
      convictionLevel: 'MEDIUM_HIGH',
      paperWouldEnter: true,
      liveWouldEnter: false,
      liveAttempted: false,
      decisionStage: 'yellow_zone',
      liveBlockReason: 'single_kol_live_not_enough',
      liveBlockFlags: ['SINGLE_KOL_LIVE_NOT_ENOUGH'],
      paperOnlyReason: null,
      isShadowKol: false,
      isLiveCanaryActive: true,
      hasBotContext: true,
      independentKolCount: 1,
      effectiveIndependentKolCount: 1,
      kolScore: 5,
      participatingKols: [],
      survivalFlags: ['SINGLE_KOL_LIVE_NOT_ENOUGH'],
      source: 'runtime',
    }) + '\n', 'utf8');
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), JSON.stringify({
      positionId: 'pos-1',
      liveEquivalenceCandidateId: 'candidate-1',
      closedAt: new Date().toISOString(),
      armName: 'rotation_underfill_v1',
      netSol: 0.01,
      netSolTokenOnly: 0.012,
      mfePctPeakTokenOnly: 0.25,
    }) + '\n', 'utf8');

    const report = await buildReport({
      realtimeDir: dir,
      sinceMs: Date.now() - 60_000,
    });

    expect(report.json.verdict).toBe('OK');
    expect(report.md).toContain('| rotation_underfill_v1 | 1 | 0 | 0 | 1 | 1/0 | +0.0100 | +0.0120 | 25.0% | 0 | +0.0000 |');
  });

  it('groups promoted underfill + exit-flow rows by profile arm', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kol-live-equivalence-profile-'));
    await writeFile(path.join(dir, 'kol-live-equivalence.jsonl'), JSON.stringify({
      schemaVersion: KOL_LIVE_EQUIVALENCE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      candidateId: 'candidate-profile-1',
      tokenMint: 'mint',
      entrySignalLabel: 'rotation-underfill',
      armName: 'rotation_underfill_v1',
      profileArm: 'rotation_underfill_exit_flow_v1',
      entryArm: 'rotation_underfill_v1',
      exitArm: 'rotation_exit_kol_flow_v1',
      parameterVersion: 'rotation-underfill-v1.0.0',
      entryReason: 'rotation_v1',
      convictionLevel: 'MEDIUM_HIGH',
      paperWouldEnter: true,
      liveWouldEnter: true,
      liveAttempted: true,
      decisionStage: 'pre_execution_live_allowed',
      liveBlockReason: null,
      liveBlockFlags: [],
      paperOnlyReason: null,
      isShadowKol: false,
      isLiveCanaryActive: true,
      hasBotContext: true,
      independentKolCount: 1,
      effectiveIndependentKolCount: 1,
      kolScore: 5,
      participatingKols: [],
      survivalFlags: [],
      source: 'runtime',
    }) + '\n', 'utf8');
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), JSON.stringify({
      positionId: 'pos-profile-1',
      liveEquivalenceCandidateId: 'candidate-profile-1',
      closedAt: new Date().toISOString(),
      armName: 'rotation_exit_kol_flow_v1',
      profileArm: 'rotation_underfill_exit_flow_v1',
      entryArm: 'rotation_underfill_v1',
      exitArm: 'rotation_exit_kol_flow_v1',
      netSol: 0.02,
      netSolTokenOnly: 0.021,
      mfePctPeakTokenOnly: 0.30,
    }) + '\n', 'utf8');

    const report = await buildReport({
      realtimeDir: dir,
      sinceMs: Date.now() - 60_000,
    });

    expect(report.md).toContain('| rotation_underfill_exit_flow_v1 | 1 | 1 | 1 | 0 | 1/0 | +0.0200 | +0.0210 | 30.0% | 0 | +0.0000 |');
    expect(report.md).not.toContain('| rotation_underfill_v1 | 1 |');
  });
});
