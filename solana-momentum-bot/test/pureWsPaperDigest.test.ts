import { mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { flushPureWsPaperDigest, __resetPureWsPaperDigestForTests } from '../src/orchestration/pureWs/paperDigest';
import { resetPureWsLaneStateForTests } from '../src/orchestration/pureWsBreakoutHandler';
import { config } from '../src/utils/config';

function override(key: string, value: unknown): void {
  Object.defineProperty(config, key, { value, writable: true, configurable: true });
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

describe('pure_ws paper digest', () => {
  const startMs = Date.parse('2026-05-03T00:00:00.000Z');
  const endMs = startMs + 15 * 60_000;

  beforeEach(() => {
    resetPureWsLaneStateForTests();
    __resetPureWsPaperDigestForTests(startMs);
    jest.spyOn(Date, 'now').mockReturnValue(endMs);
    override('pureWsPaperNotifyEnabled', true);
    override('pureWsPaperDigestEnabled', true);
    override('pureWsPaperMarkoutOffsetsSec', [15, 30, 60, 180, 300, 1800]);
    override('defaultAmmFeePct', 0.0025);
    override('defaultMevMarginPct', 0.002);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts entries from buy anchors and uses only matured anchors as markout denominators', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'purews-digest-'));
    override('realtimeDataDir', dir);
    const entryAnchorAt = endMs - 20_000;
    const oldSellAnchorAt = startMs - 1_200_000; // T+1800 matures inside this digest window.

    await writeFile(path.join(dir, 'pure-ws-paper-trades.jsonl'), '', 'utf8');
    await writeFile(path.join(dir, 'trade-markout-anchors.jsonl'), jsonl([
      {
        positionId: 'p-entry',
        anchorType: 'buy',
        anchorAt: new Date(entryAnchorAt).toISOString(),
        signalSource: 'pure_ws_breakout',
        extras: { lane: 'pure_ws', discoverySource: 'gecko_new_pool' },
      },
      {
        positionId: 'p-tail',
        anchorType: 'sell',
        anchorAt: new Date(oldSellAnchorAt).toISOString(),
        signalSource: 'pure_ws_breakout',
        extras: { lane: 'pure_ws', discoverySource: 'gecko_new_pool' },
      },
    ]), 'utf8');
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        positionId: 'p-entry',
        anchorType: 'buy',
        anchorAt: new Date(entryAnchorAt).toISOString(),
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: 0.02,
        recordedAt: new Date(entryAnchorAt + 16_000).toISOString(),
        signalSource: 'pure_ws_breakout',
        extras: { lane: 'pure_ws', discoverySource: 'gecko_new_pool' },
      },
      {
        positionId: 'p-tail',
        anchorType: 'sell',
        anchorAt: new Date(oldSellAnchorAt).toISOString(),
        horizonSec: 1800,
        quoteStatus: 'ok',
        deltaPct: 1.2,
        recordedAt: new Date(startMs + 605_000).toISOString(),
        signalSource: 'pure_ws_breakout',
        extras: { lane: 'pure_ws', discoverySource: 'gecko_new_pool' },
      },
    ]), 'utf8');
    const notifier = {
      sendInfo: jest.fn<Promise<void>, [string, string?]>(async () => {}),
    };

    await flushPureWsPaperDigest(notifier as any);

    expect(notifier.sendInfo).toHaveBeenCalledTimes(1);
    const message = notifier.sendInfo.mock.calls[0][0] as string;
    expect(message).toContain('entries 1 · closes 0');
    expect(message).toContain('T+15s ok 1/1');
    expect(message).toContain('T+30s ok 0/0');
    expect(message).toContain('T+1800s ok 1/1');
    expect(message).toContain('after-sell tail: p-tail');
  });
});
