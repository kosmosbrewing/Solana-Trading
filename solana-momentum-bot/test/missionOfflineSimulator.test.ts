import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { buildMissionOfflineSimulatorReport } from '../scripts/lib/missionOfflineSimulator';
import { parseMissionOfflineSimulatorArgs } from '../scripts/lib/missionOfflineSimulatorArgs';
import { renderMissionOfflineSimulatorReport } from '../scripts/lib/missionOfflineSimulatorRenderer';

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

describe('mission-offline-simulator', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'mission-offline-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('builds a mission reassessment report without network dependencies', async () => {
    await writeFile(path.join(dir, 'kol-live-trades.jsonl'), jsonl([
      {
        positionId: 'kolh-live-1',
        status: 'closed',
        isLive: true,
        tokenMint: 'mint-a',
        armName: 'kol_hunter_smart_v3',
        exitReason: 'probe_hard_cut',
        netSol: -0.01,
        mfePctPeak: 0.1,
        ticketSol: 0.02,
        closedAt: '2026-05-01T00:00:00.000Z',
      },
      {
        positionId: 'kolh-live-2',
        status: 'closed',
        isLive: true,
        tokenMint: 'mint-b',
        armName: 'kol_hunter_smart_v3',
        exitReason: 'winner_trailing_t1',
        netSol: 0.02,
        mfePctPeak: 4.5,
        ticketSol: 0.02,
        closedAt: '2026-05-01T00:01:00.000Z',
      },
      {
        positionId: 'kolh-live-3',
        status: 'closed',
        isLive: true,
        tokenMint: 'mint-c',
        armName: 'kol_hunter_smart_v3',
        exitReason: 'entry_advantage_emergency_exit',
        netSol: -0.02,
        mfePctPeak: 0,
        ticketSol: 0.02,
        closedAt: '2026-05-01T00:02:00.000Z',
      },
    ]));
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), jsonl([
      {
        positionId: 'rot-1',
        status: 'closed',
        paperRole: 'fallback_execution_safety',
        armName: 'rotation_underfill_cost_aware_exit_v2',
        executionPlanHash: 'plan-1',
        routeProof: true,
        tokenMint: 'rot-a',
        refundAdjustedNetSol: 0.01,
        netSol: 0.01,
        ticketSol: 0.02,
        closedAt: '2026-05-01T00:03:00.000Z',
      },
      {
        positionId: 'rot-2',
        status: 'closed',
        paperRole: 'fallback_execution_safety',
        armName: 'rotation_underfill_cost_aware_exit_v2',
        executionPlanHash: 'plan-2',
        routeProof: true,
        tokenMint: 'rot-b',
        refundAdjustedNetSol: 0.008,
        netSol: 0.008,
        ticketSol: 0.02,
        closedAt: '2026-05-02T00:03:00.000Z',
      },
      {
        positionId: 'rot-3',
        status: 'closed',
        paperRole: 'fallback_execution_safety',
        armName: 'rotation_underfill_cost_aware_exit_v2',
        executionPlanHash: 'plan-3',
        routeProof: true,
        tokenMint: 'rot-c',
        refundAdjustedNetSol: 0.004,
        netSol: 0.004,
        ticketSol: 0.02,
        closedAt: '2026-05-03T00:03:00.000Z',
      },
    ]));
    await writeFile(path.join(dir, 'trade-markout-anchors.jsonl'), jsonl([
      {
        positionId: 'a1',
        anchorType: 'buy',
        anchorAt: '2026-05-01T00:00:00.000Z',
        tokenMint: 'a1',
        signalSource: 'kol_hunter_rotation_v1',
        extras: { mode: 'paper' },
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      { positionId: 'a1', anchorType: 'buy', anchorAt: '2026-05-01T00:00:00.000Z', horizonSec: 15, quoteStatus: 'ok', deltaPct: -0.01 },
      { positionId: 'a1', anchorType: 'buy', anchorAt: '2026-05-01T00:00:00.000Z', horizonSec: 30, quoteStatus: 'ok', deltaPct: -0.02 },
      { positionId: 'a1', anchorType: 'buy', anchorAt: '2026-05-01T00:00:00.000Z', horizonSec: 300, quoteStatus: 'ok', deltaPct: -0.2 },
    ]));
    await writeFile(path.join(dir, 'helius-credit-usage.jsonl'), jsonl([
      { timestamp: '2026-05-01T00:00:00.000Z', feature: 'helius_ws_fallback_single', purpose: 'runtime_fallback', estimatedCredits: 100, requestCount: 100 },
      { timestamp: '2026-05-01T00:00:01.000Z', feature: 'wallet_manager', purpose: 'runtime_wallet_balance', estimatedCredits: 1, requestCount: 1 },
    ]));

    const report = await buildMissionOfflineSimulatorReport({
      realtimeDir: dir,
      reportsDir: path.join(dir, 'reports'),
      minRows: 3,
      minActiveDays: 3,
      stressCostPct: 0.005,
      minStressCostSol: 0.0001,
      top5WinnerShareCap: 1,
      top10WinnerShareCap: 1,
      sleeveLossCapSol: 0.02,
      microCanaryCloseTarget: 2,
    });

    expect(report.baseline.liveNetSol).toBeCloseTo(-0.01);
    expect(report.admissionVeto.find((row) => row.reason === 'probe_hard_cut')?.savedLossSol).toBeCloseTo(0.01);
    expect(report.admissionVetoCombinations[0].reason).toContain('probe_hard_cut');
    expect(report.rotationBridge.decision).toBe('MICRO_CANARY_READY');
    expect(report.rotationBridge.candidateCohorts.some((row) => row.cohort === 'v2_route_cost_comparable')).toBe(true);
    expect(report.smartV3.decision).toBe('QUARANTINE');
    expect(report.apiCost.reasons.join(' ')).toContain('dominant feature');
    expect(report.apiCost.actions.find((row) => row.feature === 'helius_ws_fallback_single')?.decision).toBe('KILL');
    expect(report.finalDecisions.find((row) => row.cohort === 'broad_live_canary')?.decision).toBe('KILL');
  });

  it('counts projection ledger duplicates once via positionId dedup', async () => {
    // 왜: smart-v3/rotation-v1 projection ledger 는 kol aggregate ledger 의 positionId
    // 부분집합을 같은 row 로 복제한다 (2026-06-10 edge audit M1). aggregate row 1회만
    // 계상되어야 하며, intra-file 재기록도 한 번만 남아야 한다.
    const liveBase = {
      status: 'closed',
      isLive: true,
      armName: 'rotation_underfill_v1',
      mfePctPeak: 0,
      ticketSol: 0.02,
    };
    await writeFile(path.join(dir, 'kol-live-trades.jsonl'), jsonl([
      { ...liveBase, positionId: 'live-1', tokenMint: 'mint-a', exitReason: 'probe_hard_cut', netSol: -0.01, closedAt: '2026-05-01T00:00:00.000Z' },
      // intra-file 재기록 (kol-live 328 rows / 325 unique 실측 사례): first-wins 로 1회만.
      { ...liveBase, positionId: 'live-1', tokenMint: 'mint-a', exitReason: 'rotation_dead_on_arrival', netSol: -0.01, closedAt: '2026-05-01T00:00:10.000Z' },
      { ...liveBase, positionId: 'live-2', tokenMint: 'mint-b', armName: 'kol_hunter_smart_v3', exitReason: 'winner_trailing_t1', netSol: 0.03, mfePctPeak: 4.5, closedAt: '2026-05-01T00:01:00.000Z' },
    ]));
    await writeFile(path.join(dir, 'rotation-v1-live-trades.jsonl'), jsonl([
      // aggregate 와 동일 positionId 의 projection copy — net 이중 계상 금지.
      { ...liveBase, positionId: 'live-1', tokenMint: 'mint-a', exitReason: 'probe_hard_cut', netSol: -0.01, closedAt: '2026-05-01T00:00:00.000Z' },
      // projection 에만 있는 positionId 는 정상 계상.
      { ...liveBase, positionId: 'live-3', tokenMint: 'mint-c', exitReason: 'winner_trailing_t1', netSol: -0.005, closedAt: '2026-05-01T00:02:00.000Z' },
    ]));
    const paperBase = {
      status: 'closed',
      paperRole: 'paper_research',
      armName: 'kol_hunter_smart_v3',
      ticketSol: 0.02,
    };
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([
      { ...paperBase, positionId: 'pap-1', tokenMint: 'mint-p', netSol: 0.02, closedAt: '2026-05-01T00:03:00.000Z' },
    ]));
    await writeFile(path.join(dir, 'smart-v3-paper-trades.jsonl'), jsonl([
      { ...paperBase, positionId: 'pap-1', tokenMint: 'mint-p', netSol: 0.02, closedAt: '2026-05-01T00:03:00.000Z' },
    ]));

    const report = await buildMissionOfflineSimulatorReport({
      realtimeDir: dir,
      reportsDir: path.join(dir, 'reports'),
      minRows: 3,
      minActiveDays: 3,
      stressCostPct: 0.005,
      minStressCostSol: 0.0001,
      top5WinnerShareCap: 1,
      top10WinnerShareCap: 1,
      sleeveLossCapSol: 0.02,
      microCanaryCloseTarget: 2,
    });

    // live: live-1(-0.01, 1회) + live-2(+0.03) + live-3(-0.005) = +0.015 (이중 계상 시 -0.005).
    expect(report.baseline.liveRows).toBe(3);
    expect(report.baseline.liveNetSol).toBeCloseTo(0.015, 6);
    // paper: pap-1 은 aggregate 1회만 (이중 계상 시 rows 2 / net 0.04).
    expect(report.baseline.paperRows).toBe(1);
    expect(report.baseline.paperNetSol).toBeCloseTo(0.02, 6);

    // veto 시뮬레이션도 dedup 행 기준: probe_hard_cut 1건, intra-file 재기록의
    // rotation_dead_on_arrival 은 계상되지 않아야 한다 (first-wins).
    const probeVeto = report.admissionVeto.find((row) => row.reason === 'probe_hard_cut');
    expect(probeVeto?.rows).toBe(1);
    expect(probeVeto?.savedLossSol).toBeCloseTo(0.01, 6);
    expect(report.admissionVeto.find((row) => row.reason === 'rotation_dead_on_arrival')).toBeUndefined();

    // 파일별 raw/dedup row 수가 리포트에 기록되어 audit 가능해야 한다.
    const fileSummary = (file: string) => report.dataFiles.find((row) => row.file === `data/realtime/${file}`);
    expect(fileSummary('kol-live-trades.jsonl')).toMatchObject({ rawRows: 3, dedupRows: 2 });
    expect(fileSummary('rotation-v1-live-trades.jsonl')).toMatchObject({ rawRows: 2, dedupRows: 1 });
    expect(fileSummary('kol-paper-trades.jsonl')).toMatchObject({ rawRows: 1, dedupRows: 1 });
    expect(fileSummary('smart-v3-paper-trades.jsonl')).toMatchObject({ rawRows: 1, dedupRows: 0 });

    const markdown = renderMissionOfflineSimulatorReport(report);
    expect(markdown).toContain('### Dedup');
    expect(markdown).toContain('trade ledger rows raw/dedup: 7 / 4 (duplicates removed: 3)');
  });

  it('parses args and renders promotion guardrails', () => {
    const args = parseMissionOfflineSimulatorArgs([
      '--realtime-dir', dir,
      '--reports-dir', path.join(dir, 'reports'),
      '--min-rows', '10',
      '--micro-canary-close-target', '5',
    ]);
    expect(args.realtimeDir).toBe(path.resolve(dir));
    expect(args.minRows).toBe(10);
    expect(args.microCanaryCloseTarget).toBe(5);

    const markdown = renderMissionOfflineSimulatorReport({
      generatedAt: '2026-05-22T00:00:00.000Z',
      realtimeDir: dir,
      reportsDir: path.join(dir, 'reports'),
      protocol: 'protocol.md',
      dataFiles: [],
      baseline: {
        liveRows: 0,
        liveNetSol: 0,
        paperRows: 0,
        paperNetSol: 0,
        winRate: null,
        maxDrawdownSol: 0,
        maxLossStreak: 0,
        top5WinnerShare: null,
        top10WinnerShare: null,
        roleSummaries: [],
        joinSummary: {
          inputRows: 0,
          eligibleRows: 0,
          joinedRows: 0,
          unjoinedRows: 0,
          joinCoveragePct: null,
          promotionGradeJoinCoveragePct: null,
          joinMethodCounts: {
            decision_execution_plan: 0,
            candidate_id: 0,
            position_id: 0,
            parent_position_id: 0,
            tx_signature: 0,
            token_time: 0,
            unjoined: 0,
          },
        },
      },
      admissionVeto: [],
      admissionVetoCombinations: [],
      probeFirst: {
        rows: 0,
        baselineMedianT300Pct: null,
        simulatedMedianPct: null,
        baselinePositiveRate: null,
        simulatedPositiveRate: null,
        fail15Rows: 0,
        pass30Rows: 0,
        leakageVerdict: 'PASS',
      },
      rotationBridge: {
        rows: 0,
        activeDays: 0,
        refundAdjustedNetSol: 0,
        walletStressNetSol: 0,
        postCostPositiveRatio: null,
        maxLossStreak: 0,
        top5WinnerShare: null,
        top10WinnerShare: null,
        executionPlanHashCoveragePct: null,
        routeProofCoveragePct: null,
        costAwareCoveragePct: null,
        comparableRoleCoveragePct: null,
        chronologicalSlices: [],
        candidateCohorts: [],
        stressSource: 'none',
        decision: 'COLLECT_OFFLINE',
        reasons: ['rows 0 < 100'],
      },
      smartV3: {
        rows: 0,
        liveRows: 0,
        netSol: 0,
        runner50Count: 0,
        runner5xCount: 0,
        maxLossStreak: 0,
        lossPer5xSol: null,
        decision: 'QUARANTINE',
        reasons: ['no 5x MFE rows'],
      },
      apiCost: {
        rows: 0,
        estimatedCredits: 0,
        byFeature: [],
        byPurpose: [],
        actions: [],
        decision: 'QUARANTINE',
        reasons: ['no helius credit ledger rows'],
      },
      microCanary: {
        sourceCohort: 'rotation',
        rows: 0,
        windowSize: 5,
        windows: 0,
        positiveWindowRate: null,
        sleeveRuinRate: null,
        worstWindowNetSol: null,
        expectedWindowNetSol: null,
        decision: 'COLLECT_OFFLINE',
        reasons: ['rows 0 < window size 5'],
      },
      finalDecisions: [],
    });
    expect(markdown).toContain('Offline-only');
    expect(markdown).toContain('Unknown role is non-promotable');
  });
});
