// 진입점 — 모든 도메인 section 을 단일 `config` 객체로 조립.
// 외부 호출은 `import { config } from '../utils/config'` 그대로 사용 (utils/config.ts shim).
// section 추가 시: 새 파일 → 여기 spread → utils/config.ts 변경 불필요.

import { dexTradeDetector } from './dexTradeDetector';
import { infraSecrets } from './infraSecrets';
import { kolHunter } from './kolHunter';
import { operationalToggles } from './operationalToggles';
import { pairAndSession } from './pairAndSession';
import { survivalAndDrift } from './survivalAndDrift';
import { tradingParamsOverrides } from './tradingParamsOverrides';
import { walletAndCanary } from './walletAndCanary';

export type { TradingMode } from './helpers';

export const config = {
  ...infraSecrets,
  ...operationalToggles,
  ...survivalAndDrift,
  ...pairAndSession,
  ...kolHunter,
  ...dexTradeDetector,
  ...walletAndCanary,
  ...tradingParamsOverrides,
} as const;
