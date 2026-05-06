import {
  __resetDigestForTests,
  flushKolHourlyDigest,
  initKolPaperNotifier,
  stopKolPaperNotifier,
} from '../src/orchestration/kolPaperNotifier';
import { kolHunterEvents } from '../src/orchestration/kolSignalHandler';
import { config } from '../src/utils/config';

function override(key: string, value: unknown): void {
  Object.defineProperty(config, key, { value, writable: true, configurable: true });
}

describe('kolPaperNotifier', () => {
  beforeEach(() => {
    stopKolPaperNotifier();
    __resetDigestForTests();
    override('kolHunterRotationPaperNotifyEnabled', true);
    override('kolHunterRotationPaperRareMfePct', 0.30);
  });

  afterEach(() => {
    stopKolPaperNotifier();
    jest.restoreAllMocks();
  });

  it('sends immediate rare alert for rotation paper MFE events', async () => {
    const notifier = {
      sendInfo: jest.fn<Promise<void>, [string, string?]>(async () => {}),
    };
    initKolPaperNotifier(notifier as any);

    kolHunterEvents.emit('paper_close', {
      pos: {
        positionId: 'rot-paper-1',
        tokenMint: 'MintRotationRare111111111111111111111',
        armName: 'rotation_fast15_v1',
        parameterVersion: 'rotation-fast15-v1.0.0',
        kolEntryReason: 'rotation_v1',
        kolConvictionLevel: 'MEDIUM_HIGH',
        isShadowKol: false,
        parentPositionId: 'rot-parent-1',
      },
      reason: 'winner_trailing_t1',
      exitPrice: 0.011,
      netSol: 0.002,
      netPct: 0.10,
      mfePctPeak: 0.32,
      holdSec: 18,
    });

    await Promise.resolve();

    expect(notifier.sendInfo).toHaveBeenCalledTimes(1);
    expect(notifier.sendInfo.mock.calls[0][0]).toContain('[ROTATION PAPER RARE]');
    expect(notifier.sendInfo.mock.calls[0][1]).toBe('kol_rotation_paper_rare');
  });

  it('includes smart-v3 live-eligible paper subset in the digest', async () => {
    const notifier = {
      sendInfo: jest.fn<Promise<void>, [string, string?]>(async () => {}),
    };
    initKolPaperNotifier(notifier as any);

    const basePos = {
      positionId: 'smart-paper-1',
      tokenMint: 'MintSmartLiveEligible111111111111111',
      armName: 'kol_hunter_smart_v3',
      parameterVersion: 'smart-v3.0.0',
      kolEntryReason: 'velocity',
      kolConvictionLevel: 'MEDIUM_HIGH',
      isShadowKol: false,
      isLive: false,
      smartV3LiveEligibleShadow: true,
    };

    kolHunterEvents.emit('paper_entry', basePos);
    kolHunterEvents.emit('paper_close', {
      pos: basePos,
      reason: 'winner_trailing_t1',
      exitPrice: 0.011,
      netSol: 0.0015,
      netPct: 0.15,
      mfePctPeak: 0.25,
      holdSec: 45,
    });

    await flushKolHourlyDigest(notifier as any);

    expect(notifier.sendInfo).toHaveBeenCalledTimes(1);
    expect(notifier.sendInfo.mock.calls[0][0]).toContain('smart-v3 live-eligible paper: 1e/1c (net +0.0015 SOL)');
    expect(notifier.sendInfo.mock.calls[0][1]).toBe('kol_hourly_digest');
  });

  it('includes smart-v3 paper comparison arms in the digest', async () => {
    const notifier = {
      sendInfo: jest.fn<Promise<void>, [string, string?]>(async () => {}),
    };
    initKolPaperNotifier(notifier as any);

    const fastFailPos = {
      positionId: 'smart-fast-fail-1',
      tokenMint: 'MintSmartFastFail111111111111111111',
      armName: 'smart_v3_fast_fail',
      parameterVersion: 'smart-v3-fast-fail-v1.0.0',
      kolEntryReason: 'velocity',
      kolConvictionLevel: 'MEDIUM_HIGH',
      isShadowKol: false,
      isLive: false,
    };
    const runnerPos = {
      positionId: 'smart-runner-1',
      tokenMint: 'MintSmartRunner11111111111111111111',
      armName: 'smart_v3_runner_relaxed',
      parameterVersion: 'smart-v3-runner-relaxed-v1.0.0',
      kolEntryReason: 'velocity',
      kolConvictionLevel: 'MEDIUM_HIGH',
      isShadowKol: false,
      isLive: false,
    };

    kolHunterEvents.emit('paper_entry', fastFailPos);
    kolHunterEvents.emit('paper_entry', runnerPos);
    kolHunterEvents.emit('paper_close', {
      pos: fastFailPos,
      reason: 'probe_hard_cut',
      exitPrice: 0.009,
      netSol: -0.001,
      netPct: -0.10,
      mfePctPeak: 0.02,
      holdSec: 30,
    });
    kolHunterEvents.emit('paper_close', {
      pos: runnerPos,
      reason: 'winner_trailing_t1',
      exitPrice: 0.012,
      netSol: 0.002,
      netPct: 0.20,
      mfePctPeak: 0.35,
      holdSec: 90,
    });

    await flushKolHourlyDigest(notifier as any);

    const message = notifier.sendInfo.mock.calls[0][0];
    expect(message).toContain('smart_v3_fast_fail: 1e/1c (net -0.0010 SOL)');
    expect(message).toContain('smart_v3_runner_relaxed: 1e/1c (net +0.0020 SOL)');
  });
});
