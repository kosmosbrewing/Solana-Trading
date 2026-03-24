import os from 'os';
import path from 'path';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { RealtimeReplayStore } from '../src/realtime';
import { buildRealtimeShadowReport } from '../src/reporting';

describe('buildRealtimeShadowReport', () => {
  it('summarizes dataset counts, reasons, and admission snapshot', async () => {
    const datasetDir = await mkdtemp(path.join(os.tmpdir(), 'shadow-report-'));
    const store = new RealtimeReplayStore(datasetDir);

    await store.appendSwap({
      pairAddress: 'PAIR-1',
      poolAddress: 'PAIR-1',
      pool: 'PAIR-1',
      signature: 'sig-1',
      timestamp: 1711065600,
      side: 'buy',
      priceNative: 1,
      amountBase: 10,
      amountQuote: 10,
      slot: 1,
      source: 'logs',
    });
    await store.appendCandle({
      pairAddress: 'PAIR-1',
      timestamp: new Date('2026-03-22T00:00:00.000Z'),
      intervalSec: 5,
      open: 1,
      high: 1.02,
      low: 0.99,
      close: 1.01,
      volume: 10,
      buyVolume: 6,
      sellVolume: 4,
      tradeCount: 3,
      tokenMint: 'PAIR-1',
    });
    await store.appendSignal({
      version: 1,
      id: 'signal-1',
      source: 'runtime',
      strategy: 'volume_spike',
      pairAddress: 'PAIR-1',
      poolAddress: 'PAIR-1',
      tokenMint: 'PAIR-1',
      signalTimestamp: '2026-03-22T00:00:00.000Z',
      referencePrice: 1,
      estimatedCostPct: 0,
      trigger: {
        primaryIntervalSec: 5,
        confirmIntervalSec: 5,
        primaryCandleCloseSec: 100,
      },
      gate: {
        startedAt: '2026-03-22T00:00:00.000Z',
        endedAt: '2026-03-22T00:00:00.050Z',
        latencyMs: 50,
        rejected: false,
      },
      processing: {
        startedAt: '2026-03-22T00:00:00.050Z',
        endedAt: '2026-03-22T00:00:00.120Z',
        latencyMs: 70,
        status: 'execution_viability_rejected',
        filterReason: 'poor_execution_viability',
      },
      context: {
        discoveryTimestamp: '2026-03-21T23:59:00.000Z',
        triggerWarmupLatencyMs: 60000,
      },
      horizons: [
        {
          horizonSec: 30,
          observedAt: '2026-03-22T00:00:30.000Z',
          price: 1.03,
          returnPct: 0.03,
          adjustedReturnPct: 0.03,
          mfePct: 0.04,
          maePct: -0.01,
        },
      ],
      summary: {
        completedAt: '2026-03-22T00:00:30.000Z',
        maxObservedSec: 30,
        mfePct: 0.04,
        maePct: -0.01,
      },
    });

    const metaDir = await mkdtemp(path.join(os.tmpdir(), 'shadow-report-meta-'));
    const admissionPath = path.join(metaDir, 'realtime-admission.json');
    await mkdir(metaDir, { recursive: true });
    await writeFile(admissionPath, JSON.stringify({
      version: 1,
      updatedAt: '2026-03-22T00:10:00.000Z',
      entries: [
        {
          pool: 'PAIR-1',
          observedNotifications: 60,
          logParsed: 40,
          fallbackSkipped: 5,
          blocked: false,
        },
        {
          pool: 'PAIR-BLOCKED',
          observedNotifications: 100,
          logParsed: 0,
          fallbackSkipped: 97,
          blocked: true,
        },
      ],
    }, null, 2), 'utf8');

    const report = await buildRealtimeShadowReport({
      datasetDir,
      horizonSec: 30,
      admissionSnapshotPath: admissionPath,
    });

    expect(report.counts).toEqual({ swaps: 1, candles: 1, signals: 1 });
    expect(report.summary.totalSignals).toBe(1);
    expect(report.summary.avgTriggerWarmupLatencyMs).toBe(60000);
    expect(report.statusCounts).toEqual([
      { status: 'execution_viability_rejected', count: 1 },
    ]);
    expect(report.reasonCounts).toEqual([
      { reason: 'poor_execution_viability', count: 1 },
    ]);
    expect(report.latestSignal?.pairAddress).toBe('PAIR-1');
    expect(report.latestSignal?.adjustedReturnPct).toBeCloseTo(0.03, 6);
    expect(report.admission).toEqual({
      trackedPools: 2,
      allowedPools: 1,
      blockedPools: 1,
      blockedDetails: [
        {
          pool: 'PAIR-BLOCKED',
          observedNotifications: 100,
          parseRatePct: 0,
          skippedRatePct: 97,
        },
      ],
    });
  });
});
