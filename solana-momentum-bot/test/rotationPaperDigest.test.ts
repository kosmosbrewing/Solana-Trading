import { mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { flushRotationPaperDigest, __resetRotationPaperDigestForTests } from '../src/orchestration/rotationPaperDigest';
import { config } from '../src/utils/config';

function override(key: string, value: unknown): void {
  Object.defineProperty(config, key, { value, writable: true, configurable: true });
}

function jsonl(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

describe('rotation paper digest', () => {
  const startMs = Date.parse('2026-05-03T00:00:00.000Z');
  const endMs = startMs + 15 * 60_000;

  beforeEach(() => {
    __resetRotationPaperDigestForTests(startMs);
    jest.spyOn(Date, 'now').mockReturnValue(endMs);
    override('kolHunterRotationPaperNotifyEnabled', true);
    override('kolHunterRotationPaperDigestEnabled', true);
    override('kolHunterRotationV1MarkoutOffsetsSec', [15, 30, 60]);
    override('kolHunterRotationPaperRareAfterSellPct', 0.50);
    override('defaultAmmFeePct', 0.0025);
    override('defaultMevMarginPct', 0.002);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('summarizes rotation paper closes, T+ markout coverage, and skipped-arm false negatives', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rotation-digest-'));
    override('realtimeDataDir', dir);
    const buyAt = startMs + 10_000;
    const sellAt = startMs + 20_000;

    await writeFile(path.join(dir, 'kol-paper-trades.jsonl'), jsonl([
      {
        strategy: 'kol_hunter',
        lane: 'kol_hunter',
        positionId: 'rot-fast-1',
        tokenMint: 'MintRotationFast111111111111111111111',
        armName: 'rotation_fast15_v1',
        parameterVersion: 'rotation-fast15-v1.0.0',
        kolEntryReason: 'rotation_v1',
        closedAt: new Date(startMs + 60_000).toISOString(),
        exitReason: 'winner_trailing_t1',
        holdSec: 18,
        netSol: 0.002,
        netSolTokenOnly: 0.003,
        mfePctPeak: 0.32,
      },
    ]), 'utf8');
    await writeFile(path.join(dir, 'trade-markout-anchors.jsonl'), jsonl([
      {
        positionId: 'rot-fast-1',
        anchorType: 'buy',
        anchorAt: new Date(buyAt).toISOString(),
        signalSource: 'rotation_fast15_v1',
        extras: { mode: 'paper', entryReason: 'rotation_v1', armName: 'rotation_fast15_v1' },
      },
      {
        positionId: 'rot-fast-1',
        anchorType: 'sell',
        anchorAt: new Date(sellAt).toISOString(),
        signalSource: 'rotation_fast15_v1',
        extras: { mode: 'paper', entryReason: 'rotation_v1', armName: 'rotation_fast15_v1' },
      },
    ]), 'utf8');
    await writeFile(path.join(dir, 'trade-markouts.jsonl'), jsonl([
      {
        positionId: 'rot-fast-1',
        anchorType: 'buy',
        anchorAt: new Date(buyAt).toISOString(),
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: 0.02,
        recordedAt: new Date(buyAt + 16_000).toISOString(),
        signalSource: 'rotation_fast15_v1',
        extras: { mode: 'paper', entryReason: 'rotation_v1', armName: 'rotation_fast15_v1' },
      },
      {
        positionId: 'rot-fast-1',
        anchorType: 'sell',
        anchorAt: new Date(sellAt).toISOString(),
        horizonSec: 15,
        quoteStatus: 'ok',
        deltaPct: 0.60,
        recordedAt: new Date(sellAt + 16_000).toISOString(),
        signalSource: 'rotation_fast15_v1',
        extras: { mode: 'paper', entryReason: 'rotation_v1', armName: 'rotation_fast15_v1' },
      },
    ]), 'utf8');
    await writeFile(path.join(dir, 'missed-alpha.jsonl'), jsonl([
      {
        eventId: 'skip-cost-1',
        tokenMint: 'MintSkip111111111111111111111111111111',
        lane: 'kol_hunter',
        rejectReason: 'rotation_arm_skip_cost_response_too_low',
        signalSource: 'rotation_cost_guard_v1',
        rejectedAt: new Date(startMs + 30_000).toISOString(),
        extras: {
          eventType: 'rotation_arm_skip',
          noTradeReason: 'rotation_cost_guard_v1_cost_response_too_low',
          armName: 'rotation_cost_guard_v1',
        },
        probe: { offsetSec: 0, quoteStatus: 'scheduled' },
      },
      {
        eventId: 'skip-cost-1',
        tokenMint: 'MintSkip111111111111111111111111111111',
        lane: 'kol_hunter',
        rejectReason: 'rotation_arm_skip_cost_response_too_low',
        signalSource: 'rotation_cost_guard_v1',
        rejectedAt: new Date(startMs + 30_000).toISOString(),
        extras: {
          eventType: 'rotation_arm_skip',
          noTradeReason: 'rotation_cost_guard_v1_cost_response_too_low',
          armName: 'rotation_cost_guard_v1',
        },
        probe: {
          offsetSec: 15,
          firedAt: new Date(startMs + 45_000).toISOString(),
          quoteStatus: 'ok',
          deltaPct: 0.02,
        },
      },
    ]), 'utf8');
    const notifier = {
      sendInfo: jest.fn<Promise<void>, [string, string?]>(async () => {}),
    };

    await flushRotationPaperDigest(notifier as any);

    expect(notifier.sendInfo).toHaveBeenCalledTimes(1);
    const message = notifier.sendInfo.mock.calls[0][0] as string;
    expect(message).toContain('ROTATION PAPER 오늘 요약');
    expect(message).toContain('KST 00:00→09:00');
    expect(message).toContain('- 00-08 · close 0건');
    expect(message).toContain('- 09:00 · close 1건 (1W/0L) net +0.0020');
    expect(message).toContain('· 합계 close 1건 (1W/0L) net +0.0020 SOL');
    expect(message).toContain('· PAPER open 0건 · entries 1건 · skips 1건');
    expect(notifier.sendInfo.mock.calls[0][1]).toBe('kol_rotation_paper_digest');
  });

  it('can force a startup baseline digest even when no new window events exist', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rotation-digest-empty-'));
    override('realtimeDataDir', dir);
    await writeFile(path.join(dir, 'rotation-v1-paper-trades.jsonl'), '', 'utf8');
    const notifier = {
      sendInfo: jest.fn<Promise<void>, [string, string?]>(async () => {}),
    };

    await flushRotationPaperDigest(notifier as any, { force: true });

    expect(notifier.sendInfo).toHaveBeenCalledTimes(1);
    const message = notifier.sendInfo.mock.calls[0][0] as string;
    expect(message).toContain('ROTATION PAPER 오늘 요약');
    expect(message).toContain('· 합계 close 0건 (해당 구간 PAPER 거래 없음)');
  });
});
