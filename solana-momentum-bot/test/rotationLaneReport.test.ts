import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildRotationLaneReport,
  renderRotationLaneReportMarkdown,
} from '../scripts/rotation-lane-report';

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

describe('rotation-lane-report', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'rotation-lane-report-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports postCostDelta by subtracting the configured round-trip cost', async () => {
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        positionId: 'rot-pos-1',
        tokenMint: 'MintRotation111111111111111111111111111',
        signalSource: 'kol_hunter_rotation_v1',
        horizonSec: 60,
        quoteStatus: 'ok',
        deltaPct: 0.004,
        recordedAt: '2026-05-02T00:01:00.000Z',
        extras: { rotationAnchorKols: ['dv'] },
      },
      {
        anchorType: 'buy',
        positionId: 'rot-pos-2',
        tokenMint: 'MintRotation222222222222222222222222222',
        signalSource: 'kol_hunter_rotation_v1',
        horizonSec: 60,
        quoteStatus: 'ok',
        deltaPct: 0.02,
        recordedAt: '2026-05-02T00:02:00.000Z',
        extras: { rotationAnchorKols: ['dv'] },
      },
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        tokenMint: 'MintNoTrade11111111111111111111111111',
        lane: 'kol_hunter',
        rejectReason: 'rotation_v1_insufficient_price_response',
        signalSource: 'kol_hunter_rotation_v1',
        rejectedAt: '2026-05-02T00:03:00.000Z',
        extras: { eventType: 'rotation_no_trade', noTradeReason: 'insufficient_price_response' },
        probe: {
          offsetSec: 60,
          firedAt: '2026-05-02T00:04:00.000Z',
          deltaPct: 0.004,
          quoteStatus: 'ok',
        },
      },
    ]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [60],
      roundTripCostPct: 0.005,
    });

    const afterBuy60 = report.tradeMarkouts.afterBuy[0];
    expect(afterBuy60.positiveRows).toBe(2);
    expect(afterBuy60.positivePostCostRows).toBe(1);
    expect(afterBuy60.avgPostCostDeltaPct).toBeCloseTo(0.007);

    const noTrade60 = report.noTrade.byHorizon[0];
    expect(noTrade60.positiveRows).toBe(1);
    expect(noTrade60.positivePostCostRows).toBe(0);
    expect(noTrade60.medianPostCostDeltaPct).toBeCloseTo(-0.001);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('Round-trip cost assumption: 0.50%');
    expect(markdown).toContain('postCostDelta');
  });

  it('counts skipped rotation paper arms as no-trade markouts', async () => {
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        tokenMint: 'MintSkip111111111111111111111111111111',
        lane: 'kol_hunter',
        rejectReason: 'rotation_arm_skip_cost_response_too_low',
        signalSource: 'rotation_cost_guard_v1',
        rejectedAt: '2026-05-02T00:03:00.000Z',
        extras: {
          eventType: 'rotation_arm_skip',
          noTradeReason: 'rotation_cost_guard_v1_cost_response_too_low',
          armName: 'rotation_cost_guard_v1',
        },
        probe: {
          offsetSec: 15,
          firedAt: '2026-05-02T00:03:15.000Z',
          deltaPct: 0.02,
          quoteStatus: 'ok',
        },
      },
    ]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15],
      roundTripCostPct: 0.005,
    });

    expect(report.noTrade.totalRows).toBe(1);
    expect(report.noTrade.byHorizon[0].positivePostCostRows).toBe(1);
    expect(report.noTrade.byReason[0]).toMatchObject({
      reason: 'rotation_cost_guard_v1_cost_response_too_low',
      count: 1,
      okRows: 1,
      positivePostCostRows: 1,
    });
  });

  it('joins rotation T+60 markouts with token-quality dev candidate buckets', async () => {
    const candidateFile = path.join(dir, 'dev-candidates.json');
    await writeFile(candidateFile, JSON.stringify({
      version: 'candidate-v1',
      paper_only: true,
      generated_at: '2026-05-02',
      candidates: [
        {
          id: 'core_dev',
          addresses: ['DEV1'],
          lane: 'core',
          risk_class: 'low',
          status: 'candidate',
          source_tier: 'A',
        },
      ],
    }), 'utf8');
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        positionId: 'rot-pos-dev',
        tokenMint: 'MintRotationDev1111111111111111111111111',
        signalSource: 'kol_hunter_rotation_v1',
        horizonSec: 60,
        quoteStatus: 'ok',
        deltaPct: 0.03,
        recordedAt: '2026-05-02T00:01:00.000Z',
        extras: { rotationAnchorKols: ['decu'] },
      },
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([
      {
        schemaVersion: 'token-quality/v1',
        tokenMint: 'MintRotationDev1111111111111111111111111',
        observedAt: '2026-05-02T00:00:30.000Z',
        creatorAddress: 'DEV1',
        operatorDevStatus: 'watchlist',
        observationContext: { positionId: 'rot-pos-dev', armName: 'kol_hunter_rotation_v1' },
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [60],
      roundTripCostPct: 0.005,
      candidateFile,
    });

    const risk = report.byDevQuality.find((row) => row.bucket === 'DEV_CANDIDATE_RISK_LOW');
    const status = report.byDevQuality.find((row) => row.bucket === 'DEV_STATUS_WATCHLIST');
    expect(risk?.okRows).toBe(1);
    expect(risk?.medianPostCostDeltaPct60s).toBeCloseTo(0.025);
    expect(status?.positivePostCost60s).toBe(1);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Dev Quality T+60');
    expect(markdown).toContain('DEV_CANDIDATE_RISK_LOW');
    expect(markdown).toContain('DEV_STATUS_WATCHLIST');
  });

  it('summarizes rotation paper arms and rent-adjusted stress PnL', async () => {
    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_fast15_v1',
        parameterVersion: 'rotation-fast15-v1.0.0',
        kolEntryReason: 'rotation_v1',
        positionId: 'rot-fast-1',
        closedAt: '2026-05-02T00:01:00.000Z',
        exitReason: 'winner_trailing_t1',
        holdSec: 18,
        netSol: 0.002,
        netSolTokenOnly: 0.003,
      },
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        armName: 'rotation_cost_guard_v1',
        parameterVersion: 'rotation-cost-guard-v1.0.0',
        kolEntryReason: 'rotation_v1',
        positionId: 'rot-cost-1',
        closedAt: '2026-05-02T00:02:00.000Z',
        exitReason: 'probe_hard_cut',
        holdSec: 24,
        netSol: -0.001,
        netSolTokenOnly: 0.001,
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        positionId: 'rot-fast-1',
        tokenMint: 'MintRotationFast111111111111111111111111',
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: 0.03,
        recordedAt: '2026-05-02T00:01:15.000Z',
        extras: { armName: 'rotation_fast15_v1', entryReason: 'rotation_v1' },
      },
    ]));
    await writeFile(path.join(dir, 'token-quality-observations.jsonl'), jsonl([]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([]));

    const report = await buildRotationLaneReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-01T00:00:00.000Z'),
      horizonsSec: [15],
      roundTripCostPct: 0.005,
      assumedAtaRentSol: 0.001,
      assumedNetworkFeeSol: 0.0001,
    });

    const fast = report.paperTrades.byArm.find((row) => row.armName === 'rotation_fast15_v1');
    const cost = report.paperTrades.byArm.find((row) => row.armName === 'rotation_cost_guard_v1');
    expect(fast?.rows).toBe(1);
    expect(fast?.wins).toBe(1);
    expect(fast?.rentAdjustedNetSol).toBeCloseTo(0.0019);
    expect(cost?.rentAdjustedNetSol).toBeCloseTo(-0.0001);
    expect(report.tradeMarkouts.byArm[0].armName).toBe('rotation_fast15_v1');
    expect(report.tradeMarkouts.byArm[0].afterBuy[0].positivePostCostRows).toBe(1);

    const markdown = renderRotationLaneReportMarkdown(report);
    expect(markdown).toContain('## Paper Trades By Arm');
    expect(markdown).toContain('rotation_fast15_v1');
    expect(markdown).toContain('rent-adjusted stress');
    expect(markdown).toContain('## Markouts By Arm');
  });
});
