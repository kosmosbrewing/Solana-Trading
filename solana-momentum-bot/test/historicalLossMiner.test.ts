import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildHistoricalLossReport,
  renderHistoricalLossReport,
} from '../scripts/historical-loss-miner';

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function closeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    closedAt: '2026-05-16T00:00:00.000Z',
    armName: 'rotation_underfill_exit_flow_v1',
    exitReason: 'rotation_dead_on_arrival',
    netSol: -0.002,
    netSolTokenOnly: -0.0018,
    mfePctPeak: 0,
    survivalFlags: ['EXIT_LIQUIDITY_UNKNOWN', 'DECIMALS_SECURITY_CLIENT'],
    ...overrides,
  };
}

describe('historical-loss-miner', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'historical-loss-miner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('surfaces repeated zero-MFE wallet-loss buckets without treating decimals provenance as actionable', async () => {
    await writeFile(path.join(dir, 'rotation-v1-live-trades.jsonl'), jsonl([
      closeRow({
        positionId: 'loss-1',
        netSol: -0.002,
        survivalFlags: ['ROTATION_V1_SMALL_BUYS_4', 'LIVE_GATE_KOL_CANARY_DISABLED'],
        extras: { survivalFlags: ['ROTATION_V1_SMALL_BUYS_4'] },
      }),
      closeRow({
        positionId: 'loss-2',
        netSol: -0.003,
        survivalFlags: ['ROTATION_V1_SMALL_BUYS_4', 'LIVE_GATE_KOL_CANARY_DISABLED'],
      }),
      closeRow({
        positionId: 'loss-3',
        netSol: -0.004,
        survivalFlags: ['ROTATION_V1_SMALL_BUYS_4', 'LIVE_GATE_KOL_CANARY_DISABLED'],
      }),
      closeRow({
        positionId: 'winner',
        exitReason: 'winner_trailing_t1',
        netSol: 0.01,
        netSolTokenOnly: 0.012,
        mfePctPeak: 0.5,
        survivalFlags: ['EXIT_LIQUIDITY_UNKNOWN', 'DECIMALS_SECURITY_CLIENT'],
      }),
      closeRow({
        positionId: 'actual-5x',
        armName: 'kol_hunter_smart_v3',
        exitReason: 'winner_trailing_t1',
        netSol: -0.002,
        netSolTokenOnly: 0.02,
        mfePctPeak: 4.2,
        survivalFlags: ['SMART_V3_FRESH_KOLS_2'],
      }),
      closeRow({
        positionId: 'false-positive-loss',
        closedAt: '2026-05-15T13:00:00.000Z',
        exitReason: 'probe_flat_cut',
        netSol: -0.003,
        netSolTokenOnly: -0.002,
        survivalFlags: ['ROTATION_V1_SMALL_BUYS_3', 'ROTATION_V1_SCORE_0.80', 'ROTATION_V1_KOLS_1'],
      }),
      closeRow({
        positionId: 'false-positive-loss-2',
        closedAt: '2026-05-13T00:00:00.000Z',
        exitReason: 'probe_flat_cut',
        netSol: -0.002,
        netSolTokenOnly: -0.002,
        survivalFlags: ['ROTATION_V1_SMALL_BUYS_3', 'ROTATION_V1_SCORE_0.80', 'ROTATION_V1_KOLS_1'],
      }),
      closeRow({
        positionId: 'fresh-false-positive-winner',
        closedAt: '2026-05-15T14:00:00.000Z',
        exitReason: 'probe_flat_cut',
        netSol: 0.001,
        netSolTokenOnly: 0.001,
        survivalFlags: ['ROTATION_V1_SMALL_BUYS_3', 'ROTATION_V1_SCORE_0.80'],
      }),
      closeRow({
        positionId: 'false-positive-winner',
        exitReason: 'probe_flat_cut',
        netSol: 0.001,
        netSolTokenOnly: 0.001,
        survivalFlags: ['ROTATION_V1_SMALL_BUYS_3'],
      }),
    ]));
    await writeFile(path.join(dir, 'smart-v3-live-trades.jsonl'), jsonl([
      closeRow({
        positionId: 'hard-cut-1',
        armName: 'kol_hunter_smart_v3',
        exitReason: 'probe_hard_cut',
        netSol: -0.006,
        netSolTokenOnly: -0.004,
        survivalFlags: ['SMART_V3_FRESH_KOLS_2', 'SMART_V3_LAST_BUY_AGE_3S'],
      }),
      closeRow({
        positionId: 'hard-cut-2',
        armName: 'kol_hunter_smart_v3',
        exitReason: 'probe_hard_cut',
        netSol: -0.005,
        netSolTokenOnly: -0.003,
        survivalFlags: ['SMART_V3_FRESH_KOLS_2', 'SMART_V3_LAST_BUY_AGE_3S'],
      }),
    ]));

    const report = await buildHistoricalLossReport({
      realtimeDir: dir,
      nowMs: Date.parse('2026-05-16T12:00:00.000Z'),
      freshWindowSpecs: ['24h', '3d', '7d'],
      minRows: 2,
      maxP90Mfe: 0.03,
    });

    expect(report.cutCandidates.find((row) =>
      row.bucketType === 'exit' && row.label === 'rotation_dead_on_arrival'
    )).toMatchObject({
      rows: 3,
      walletNetSol: -0.009,
      actual5xRows: 0,
      recommendedAction: 'rotation_pre_entry_doa_block_or_paper_fallback',
    });
    expect(report.postCloseDiagnosticCandidates.find((row) =>
      row.bucketType === 'exit' && row.label === 'rotation_dead_on_arrival'
    )).toMatchObject({
      rows: 3,
      walletNetSol: -0.009,
    });
    expect(report.diagnosticProxyCandidates.find((row) =>
      row.diagnosticLabel === 'rotation_dead_on_arrival' &&
      row.proxyLabel === 'ROTATION_V1_SMALL_BUYS_4'
    )).toMatchObject({
      diagnosticBucketType: 'exit',
      lane: 'rotation',
      diagnosticRows: 3,
      proxyRows: 3,
      targetProxyRows: 3,
      diagnosticCoveragePct: 1,
      walletNetSol: -0.009,
      savedLossSol: 0.009,
      missedWinnerRows: 0,
      missedActual5xRows: 0,
      verdict: 'READY_FOR_FRESH_SHADOW',
      nextAction: 'track as paper-shadow diagnostic proxy; require fresh rows before live review',
    });
    expect(report.preEntryProxyCandidates.find((row) =>
      row.label === 'ROTATION_V1_SMALL_BUYS_4'
    )).toMatchObject({
      rows: 3,
      walletNetSol: -0.009,
      recommendedAction: 'paper_shadow_pre_entry_proxy_gate',
    });
    expect(report.preEntryProxyCandidates.find((row) =>
      row.label === 'rotation_dead_on_arrival'
    )).toBeUndefined();
    expect(report.preEntryProxyCandidates.find((row) =>
      row.label === 'LIVE_GATE_KOL_CANARY_DISABLED'
    )).toBeUndefined();
    expect(report.paperShadowGateQueue.find((row) =>
      row.label === 'ROTATION_V1_SMALL_BUYS_4'
    )).toMatchObject({
      lane: 'rotation',
      historicalRows: 3,
      historicalWalletNetSol: -0.009,
      historicalWalletWins: 0,
      historicalActual5xRows: 0,
      verdict: 'READY_FOR_FRESH_SHADOW',
      nextAction: 'add report-only paper shadow block counter and compare saved loss vs missed winner',
    });
    expect(report.paperShadowBlockCounters.find((row) =>
      row.label === 'ROTATION_V1_SMALL_BUYS_4'
    )).toMatchObject({
      lane: 'rotation',
      shadowBlockedRows: 3,
      blockedWalletNetSol: -0.009,
      savedLossSol: 0.009,
      missedWinnerRows: 0,
      missedWinnerSol: 0,
      missedActual5xRows: 0,
      shadowNetImpactSol: 0.009,
      verdict: 'WAIT_FRESH_ROWS',
      nextAction: 'keep collecting fresh paper shadow rows',
    });
    expect(report.paperShadowBlockCounters.find((row) =>
      row.label === 'ROTATION_V1_SMALL_BUYS_3'
    )).toMatchObject({
      shadowBlockedRows: 4,
      savedLossSol: 0.005,
      missedWinnerRows: 2,
      missedWinnerSol: 0.002,
      shadowNetImpactSol: 0.003,
      verdict: 'REJECT_FALSE_POSITIVES',
      nextAction: 'split or discard before any block',
    });
    expect(report.conjunctiveProxySplits.find((row) =>
      row.label === 'ROTATION_V1_SMALL_BUYS_3 + ROTATION_V1_SCORE_0.80'
    )).toBeUndefined();
    expect(report.conjunctiveProxySplits.find((row) =>
      row.label === 'ROTATION_V1_SMALL_BUYS_3 + ROTATION_V1_KOLS_1'
    )).toMatchObject({
      rows: 2,
      walletNetSol: -0.005,
      missedWinnerRows: 0,
      verdict: 'READY_FOR_FRESH_SHADOW',
      nextAction: 'track conjunctive paper shadow block counter',
    });
    expect(report.cutCandidates.find((row) =>
      row.bucketType === 'arm_exit' && row.label === 'kol_hunter_smart_v3::probe_hard_cut'
    )).toMatchObject({
      rows: 2,
      walletNetSol: -0.011,
      recommendedAction: 'tighten_pre_entry_or_hardcut_admission',
    });
    expect(report.counterfactuals.find((row) =>
      row.label === 'counterfactual:smart_v3_low_mfe_probe_hard_cut'
    )).toMatchObject({
      rows: 2,
      walletNetSol: -0.011,
      actual5xRows: 0,
    });
    expect(report.smartV3AdmissionCandidates.find((row) =>
      row.proxyLabel === 'SMART_V3_LAST_BUY_AGE_3S'
    )).toMatchObject({
      targetRows: 2,
      proxyRows: 2,
      targetProxyRows: 2,
      targetCoveragePct: 1,
      walletNetSol: -0.011,
      savedLossSol: 0.011,
      missedWinnerRows: 0,
      missedT2Rows: 0,
      missedActual5xRows: 0,
      verdict: 'READY_FOR_FRESH_SHADOW',
      nextAction: 'track as smart-v3 paper-only no-trade shadow; require fresh rows before live review',
    });
    expect(report.smartV3AdmissionCandidates.find((row) =>
      row.proxyLabel === 'SMART_V3_FRESH_KOLS_2'
    )).toMatchObject({
      missedActual5xRows: 1,
      verdict: 'REJECT_TAIL_KILL',
    });
    expect(report.paperShadowDecisionLedger.find((row) =>
      row.kind === 'smart_v3_admission' && row.label === 'SMART_V3_LAST_BUY_AGE_3S'
    )).toMatchObject({
      lane: 'smart_v3',
      state: 'PAPER_SHADOW_ONLY',
      rows: 2,
      savedLossSol: 0.011,
      missedWinnerRows: 0,
      missedT2Rows: 0,
      missedActual5xRows: 0,
      netImpactSol: 0.011,
      sourceVerdict: 'READY_FOR_FRESH_SHADOW',
    });
    expect(report.paperShadowDecisionLedger.find((row) =>
      row.kind === 'conjunctive_split' && row.label === 'ROTATION_V1_SMALL_BUYS_3 + ROTATION_V1_KOLS_1'
    )).toMatchObject({
      state: 'WAIT_FRESH',
      rows: 2,
      savedLossSol: 0.005,
      missedActual5xRows: 0,
    });
    expect(report.promotionPackets.find((row) =>
      row.kind === 'smart_v3_admission' && row.label === 'SMART_V3_LAST_BUY_AGE_3S'
    )).toMatchObject({
      verdict: 'PAPER_SHADOW_ONLY',
      rows: 2,
      netImpactSol: 0.011,
      blockers: ['fresh validation required'],
      nextAction: 'keep report-only paper shadow and collect fresh validation rows',
    });
    expect(report.promotionPackets.find((row) =>
      row.kind === 'conjunctive_split' && row.label === 'ROTATION_V1_SMALL_BUYS_3 + ROTATION_V1_KOLS_1'
    )).toMatchObject({
      verdict: 'WAIT_FRESH_ROWS',
      blockers: ['fresh rows required'],
      nextAction: 'do not promote; wait for fresh/current-session rows',
    });
    expect(report.promotionWatchlist).toMatchObject({
      readyForLiveReview: 0,
      primaryAction: 'keep paper-shadow only; collect fresh validation rows',
    });
    expect(report.promotionWatchlist.rows.find((row) =>
      row.queue === 'paper_shadow'
    )).toMatchObject({
      queue: 'paper_shadow',
      verdict: 'PAPER_SHADOW_ONLY',
    });
    expect(report.promotionWatchlist.rows.find((row) =>
      row.label === 'ROTATION_V1_SMALL_BUYS_3 + ROTATION_V1_KOLS_1'
    )).toMatchObject({
      queue: 'wait_fresh',
      verdict: 'WAIT_FRESH_ROWS',
    });
    expect(report.paperShadowFreshCounters.find((row) =>
      row.window === '24h' &&
      row.kind === 'smart_v3_admission' &&
      row.label === 'SMART_V3_LAST_BUY_AGE_3S'
    )).toMatchObject({
      rows: 2,
      requiredRows: 30,
      rowsRemaining: 28,
      netImpactSol: 0.011,
      savedLossSol: 0.011,
      missedWinnerRows: 0,
      missedT2Rows: 0,
      missedActual5xRows: 0,
      verdict: 'WAIT_FRESH_ROWS',
      nextAction: 'keep paper-shadow only; collect fresh rows',
    });
    expect(report.paperShadowFreshReadiness.find((row) =>
      row.kind === 'smart_v3_admission' && row.label === 'SMART_V3_LAST_BUY_AGE_3S'
    )).toMatchObject({
      bestWindow: '24h',
      rows: 2,
      requiredRows: 30,
      rowsRemaining: 28,
      netImpactSol: 0.011,
      missedWinnerRows: 0,
      missedT2Rows: 0,
      missedActual5xRows: 0,
      verdict: 'WAIT_FRESH_ROWS',
      nextAction: 'keep paper-shadow only; collect fresh rows',
    });
    expect(report.paperShadowFreshCounters.find((row) =>
      row.window === '24h' &&
      row.kind === 'conjunctive_split' &&
      row.label === 'ROTATION_V1_SMALL_BUYS_3 + ROTATION_V1_KOLS_1'
    )).toMatchObject({
      rows: 1,
      netImpactSol: 0.003,
      verdict: 'WAIT_FRESH_ROWS',
    });
    expect(report.paperShadowFreshReadiness.find((row) =>
      row.kind === 'conjunctive_split' && row.label === 'ROTATION_V1_SMALL_BUYS_3 + ROTATION_V1_KOLS_1'
    )).toMatchObject({
      bestWindow: '7d',
      rows: 2,
      rowsRemaining: 28,
      netImpactSol: 0.005,
      verdict: 'WAIT_FRESH_ROWS',
    });
    expect(report.counterfactuals.find((row) =>
      row.label === 'counterfactual:zero_mfe_wallet_loss'
    )).toMatchObject({
      rows: 7,
      actual5xRows: 0,
    });
    expect(report.freshSplitValidations.find((row) =>
      row.window === '24h' && row.label === 'ROTATION_V1_SMALL_BUYS_3 + ROTATION_V1_KOLS_1'
    )).toMatchObject({
      rows: 1,
      walletNetSol: -0.003,
      verdict: 'WAIT_FRESH_ROWS',
      nextAction: 'keep collecting fresh split rows',
    });
    expect(report.freshSplitValidations.find((row) =>
      row.window === '3d' && row.label === 'ROTATION_V1_SMALL_BUYS_3 + ROTATION_V1_KOLS_1'
    )).toMatchObject({
      rows: 1,
      walletNetSol: -0.003,
      missedWinnerRows: 0,
      verdict: 'WAIT_FRESH_ROWS',
    });
    expect(report.freshSplitValidations.find((row) =>
      row.window === '7d' && row.label === 'ROTATION_V1_SMALL_BUYS_3 + ROTATION_V1_KOLS_1'
    )).toMatchObject({
      rows: 2,
      walletNetSol: -0.005,
      missedWinnerRows: 0,
      verdict: 'WAIT_FRESH_ROWS',
      nextAction: 'keep collecting fresh split rows',
    });
    expect(report.freshSplitReadiness.find((row) =>
      row.label === 'ROTATION_V1_SMALL_BUYS_3 + ROTATION_V1_KOLS_1'
    )).toMatchObject({
      lane: 'rotation',
      requiredRows: 30,
      bestWindow: '7d',
      bestWindowRows: 2,
      rowsRemaining: 28,
      walletNetSol: -0.005,
      savedLossSol: 0.005,
      missedWinnerRows: 0,
      missedActual5xRows: 0,
      verdict: 'WAIT_FRESH_ROWS',
      nextAction: 'continue collecting fresh rows',
    });
    expect(report.cutCandidates.find((row) => row.label === 'DECIMALS_SECURITY_CLIENT')).toBeUndefined();
    expect(report.cutCandidates.find((row) => row.label.includes('winner_trailing_t1'))).toBeUndefined();

    const markdown = renderHistoricalLossReport(report);
    expect(markdown).toContain('Historical Loss Miner');
    expect(markdown).toContain('Paper Shadow Gate Queue');
    expect(markdown).toContain('Paper Shadow Block Counters');
    expect(markdown).toContain('Conjunctive Proxy Splits');
    expect(markdown).toContain('Fresh Split Validation');
    expect(markdown).toContain('Fresh Split Readiness');
    expect(markdown).toContain('Diagnostic To Pre-Entry Proxy Candidates');
    expect(markdown).toContain('Smart V3 Loser Admission Candidates');
    expect(markdown).toContain('Paper Shadow Decision Ledger');
    expect(markdown).toContain('Promotion Watchlist');
    expect(markdown).toContain('Primary action: keep paper-shadow only; collect fresh validation rows');
    expect(markdown).toContain('Paper Shadow Fresh Readiness');
    expect(markdown).toContain('Paper Shadow Fresh Counters');
    expect(markdown).toContain('Promotion Packets');
    expect(markdown).toContain('remaining');
    expect(markdown).toContain('track conjunctive paper shadow block counter');
    expect(markdown).toContain('saved loss');
    expect(markdown).toContain('require >=30 fresh rows');
    expect(markdown).toContain('Pre-Entry Proxy Candidates');
    expect(markdown).toContain('Post-close diagnostics explain loss modes');
    expect(markdown).toContain('rotation_pre_entry_doa_block_or_paper_fallback');
  });
});
