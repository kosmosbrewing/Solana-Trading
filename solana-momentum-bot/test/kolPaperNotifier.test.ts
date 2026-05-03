import {
  __resetDigestForTests,
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
});
