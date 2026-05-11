import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildCapitulationReboundReport,
  renderCapitulationReboundReportMarkdown,
  resolveSinceMs,
} from '../scripts/capitulation-rebound-report';

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

describe('capitulation-rebound-report', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'capitulation-report-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('summarizes paper closes and post-cost T+ markouts', async () => {
    await writeFile(path.join(dir, 'capitulation-rebound-paper-trades.jsonl'), jsonl([
      {
        positionId: 'cap-pos-1',
        armName: 'kol_hunter_capitulation_rebound_v1',
        openedAt: '2026-05-08T00:00:00.000Z',
        closedAt: '2026-05-08T00:00:20.000Z',
        netSol: 0.001,
        netSolTokenOnly: 0.001,
        mfePct: 0.12,
        maePct: -0.02,
        holdSec: 20,
        exitReason: 'winner_trailing_t1',
      },
      {
        positionId: 'cap-pos-2',
        armName: 'kol_hunter_capitulation_rebound_v1',
        openedAt: '2026-05-08T00:05:00.000Z',
        closedAt: '2026-05-08T00:05:16.000Z',
        netSol: -0.0005,
        netSolTokenOnly: -0.0005,
        mfePct: 0.01,
        maePct: -0.04,
        holdSec: 16,
        exitReason: 'capitulation_no_reaction',
      },
    ]));
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        anchorType: 'buy',
        positionId: 'cap-pos-1',
        signalSource: 'kol_hunter_capitulation_rebound_v1',
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: 0.02,
        recordedAt: '2026-05-08T00:00:15.000Z',
      },
      {
        anchorType: 'buy',
        positionId: 'cap-pos-2',
        signalSource: 'kol_hunter_capitulation_rebound_v1',
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: 0.002,
        recordedAt: '2026-05-08T00:05:15.000Z',
      },
      {
        anchorType: 'sell',
        positionId: 'cap-pos-1',
        signalSource: 'kol_hunter_capitulation_rebound_v1',
        horizonSec: 30,
        quoteStatus: 'ok',
        deltaPct: 0.05,
        recordedAt: '2026-05-08T00:00:50.000Z',
      },
      {
        anchorType: 'buy',
        positionId: 'cap-rr-pos-1',
        signalSource: 'kol_hunter_capitulation_rebound_rr_v1',
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: 0.03,
        recordedAt: '2026-05-08T00:15:15.000Z',
      },
    ]));
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        rejectReason: 'capitulation_rebound_bounce_not_confirmed',
        signalSource: 'kol_hunter_capitulation_rebound_v1',
        rejectedAt: '2026-05-08T00:10:00.000Z',
        extras: { eventType: 'capitulation_rebound_no_trade', noTradeReason: 'bounce_not_confirmed' },
        probe: { offsetSec: 15, firedAt: '2026-05-08T00:10:15.000Z', quoteStatus: 'ok', deltaPct: 0.01 },
      },
      {
        rejectReason: 'capitulation_rebound_rr_too_low',
        signalSource: 'kol_hunter_capitulation_rebound_rr_v1',
        rejectedAt: '2026-05-08T00:20:00.000Z',
        extras: { eventType: 'capitulation_rebound_no_trade', noTradeReason: 'rr_too_low' },
        probe: { offsetSec: 15, firedAt: '2026-05-08T00:20:15.000Z', quoteStatus: 'ok', deltaPct: 0.02 },
      },
    ]));

    const report = await buildCapitulationReboundReport({
      realtimeDir: dir,
      sinceMs: Date.parse('2026-05-08T00:00:00.000Z'),
      horizonsSec: [15, 30],
      roundTripCostPct: 0.005,
    });

    expect(report.paperTrades.rows).toBe(2);
    expect(report.paperTrades.wins).toBe(1);
    expect(report.tradeMarkouts.afterBuy[0].positivePostCostRows).toBe(2);
    expect(report.noTrade.rows).toBe(2);
    expect(report.noTrade.byHorizon[0].positivePostCostRows).toBe(2);
    expect(renderCapitulationReboundReportMarkdown(report)).toContain('Capitulation Rebound V1 Paper Report');
  });

  it('parses sync-style relative since windows', () => {
    const now = Date.parse('2026-05-08T12:00:00.000Z');
    expect(resolveSinceMs('24h', 72, now)).toBe(Date.parse('2026-05-07T12:00:00.000Z'));
    expect(resolveSinceMs('7d', 72, now)).toBe(Date.parse('2026-05-01T12:00:00.000Z'));
    expect(resolveSinceMs('30m', 72, now)).toBe(Date.parse('2026-05-08T11:30:00.000Z'));
    expect(resolveSinceMs('2026-05-08T00:00:00.000Z', 72, now)).toBe(Date.parse('2026-05-08T00:00:00.000Z'));
  });
});
