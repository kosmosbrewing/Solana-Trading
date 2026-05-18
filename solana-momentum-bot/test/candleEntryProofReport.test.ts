import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { buildCandleEntryProofReport } from '../scripts/lib/candleEntryProofReport';

async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

describe('candle entry proof report', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'candle-entry-proof-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('joins buy anchors to 5s candles and evaluates paper-only arms', async () => {
    const realtimeDir = path.join(dir, 'realtime');
    const sessionsDir = path.join(realtimeDir, 'sessions');
    const sessionDir = path.join(sessionsDir, '2026-05-12T00-00-00-000Z-live');
    const tokenMint = 'Token111111111111111111111111111111111111111';
    const anchorAt = '2026-05-12T00:01:00.000Z';
    const anchorPrice = 1;
    await writeJsonl(path.join(realtimeDir, 'trade-markout-anchors.jsonl'), [{
      positionId: 'kolh-rotation-test-1',
      anchorType: 'buy',
      tokenMint,
      anchorAt,
      anchorPrice,
      signalSource: 'rotation_underfill_exit_flow_v1',
      extras: { independentKolCount: 1, mode: 'paper' },
    }]);
    await writeJsonl(path.join(realtimeDir, 'trade-markouts.jsonl'), [{
      positionId: 'kolh-rotation-test-1',
      anchorType: 'buy',
      anchorAt,
      horizonSec: 300,
      deltaPct: 0.05,
      quoteStatus: 'ok',
    }]);
    const candles = [
      ...Array.from({ length: 12 }, (_, index) => ({
        tokenMint,
        intervalSec: 5,
        timestamp: new Date(Date.parse(anchorAt) - (60 - index * 5) * 1000).toISOString(),
        open: 1 + index * 0.001,
        high: 1 + index * 0.0015,
        low: 1 + index * 0.0005,
        close: 1 + index * 0.001,
        buyVolume: 2,
        sellVolume: 1,
        tradeCount: 1,
      })),
      { tokenMint, intervalSec: 5, timestamp: '2026-05-12T00:01:15.000Z', open: 1.01, high: 1.03, low: 1.0, close: 1.02, buyVolume: 2, sellVolume: 1, tradeCount: 1 },
      { tokenMint, intervalSec: 5, timestamp: '2026-05-12T00:01:30.000Z', open: 1.02, high: 1.05, low: 1.01, close: 1.04, buyVolume: 2, sellVolume: 1, tradeCount: 1 },
      { tokenMint, intervalSec: 5, timestamp: '2026-05-12T00:06:00.000Z', open: 1.04, high: 1.08, low: 1.02, close: 1.06, buyVolume: 2, sellVolume: 1, tradeCount: 1 },
    ];
    await writeJsonl(path.join(sessionDir, 'micro-candles.jsonl'), candles);

    const report = await buildCandleEntryProofReport({
      realtimeDir,
      sessionsDir,
      horizonsSec: [15, 30, 60, 300],
      preWindowsSec: [20, 60],
      roundTripCostPct: 0.005,
      minRows: 1,
    });

    expect(report.buyAnchors).toBe(1);
    expect(report.anchorsWithPre60).toBe(1);
    expect(report.anchorsWithOutcome300).toBe(1);
    expect(report.anchorsWithFullCoverage).toBe(1);
    expect(report.fullCoverage).toBe(1);
    expect(report.coverageGroups.find((row) => row.groupBy === 'family' && row.group === 'rotation')?.fullCoverage).toBe(1);
    expect(report.evaluations.find((row) => row.arm === 'rotation_prestable_admission_v2')?.rows).toBe(1);
    expect(report.evaluations.find((row) => row.arm === 'rotation_pass30_trail_v1')?.rows).toBe(1);
  });

  it('classifies candle coverage gaps per anchor', async () => {
    const realtimeDir = path.join(dir, 'realtime');
    const sessionsDir = path.join(realtimeDir, 'sessions');
    await writeJsonl(path.join(realtimeDir, 'trade-markout-anchors.jsonl'), [
      {
        positionId: 'missing-candles',
        anchorType: 'buy',
        tokenMint: 'Missing11111111111111111111111111111111111111',
        anchorAt: '2026-05-12T00:01:00.000Z',
        anchorPrice: 1,
        signalSource: 'rotation_underfill_exit_flow_v1',
        extras: { independentKolCount: 1, mode: 'paper' },
      },
    ]);
    await writeJsonl(path.join(realtimeDir, 'trade-markouts.jsonl'), []);
    await writeJsonl(path.join(sessionsDir, '2026-05-12T00-00-00-000Z-live', 'micro-candles.jsonl'), []);

    const report = await buildCandleEntryProofReport({
      realtimeDir,
      sessionsDir,
      horizonsSec: [15, 30, 60, 300],
      preWindowsSec: [20, 60],
      roundTripCostPct: 0.005,
      minRows: 1,
    });

    expect(report.anchorsWithFullCoverage).toBe(0);
    expect(report.coverageGroups.find((row) => row.groupBy === 'family' && row.group === 'rotation')?.topReasons[0]).toMatchObject({
      reason: 'no_token_candles',
      count: 1,
    });
  });
});
