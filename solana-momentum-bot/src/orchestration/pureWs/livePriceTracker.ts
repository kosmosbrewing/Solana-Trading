// 2026-04-25 Phase 2 P1-1/P1-2: live reverse-quote tracker singleton (lazy init).
// Why: candle MFE 가 burst pump 를 못 잡는 케이스 (CATCOIN +99% peak=0%). Jupiter token→SOL
// quote 로 보조 MFE 측정 → T1 promotion 판단 보강. config.pureWsLivePriceTrackerEnabled 로 gate.

import { LivePriceTracker } from '../../observability/livePriceTracker';
import { config } from '../../utils/config';

let livePriceTracker: LivePriceTracker | null = null;

export function getOrInitLivePriceTracker(): LivePriceTracker {
  if (!livePriceTracker) {
    livePriceTracker = new LivePriceTracker({
      jupiterApiUrl: config.jupiterApiUrl,
      jupiterApiKey: config.jupiterApiKey,
      pollIntervalMs: config.pureWsLivePriceTrackerPollMs ?? 12_000,
    });
  }
  return livePriceTracker;
}

export function getPureWsLivePriceTracker(): LivePriceTracker | null {
  return livePriceTracker;
}

export function resetPureWsLivePriceTrackerForTests(): void {
  livePriceTracker?.stopAll();
  livePriceTracker = null;
}
