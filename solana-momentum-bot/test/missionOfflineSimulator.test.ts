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
