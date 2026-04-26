// Public API barrel — pure_ws_breakout lane 외부 진입점.
// src/orchestration/pureWsBreakoutHandler.ts 가 본 파일을 re-export 한다 (backward compat).

// Core flow
export { handlePureWsSignal } from './entryFlow';
export { updatePureWsPositions } from './tickMonitor';
export { recoverPureWsOpenPositions } from './recovery';
export { scanPureWsV2Burst } from './v2Scanner';

// Wallet helpers
export { resolvePureWsWalletLabel } from './wallet';

// Read-only state accessors
export { getActivePureWsPositions, getPureWsFunnelStats } from './positionState';
export { getPureWsLivePriceTracker } from './livePriceTracker';
export {
  getPureWsV2Telemetry,
  logPureWsV2TelemetrySummary,
} from './v2Telemetry';

// Test helpers
export { addPureWsPositionForTests } from './positionState';
export { resetPureWsLaneStateForTests } from './resetState';
export { resetInflightEntryForTests } from './inflight';
export { resetPureWsLivePriceTrackerForTests } from './livePriceTracker';
export { resetPureWsV2TelemetryForTests } from './v2Telemetry';
export { resetPureWsV2CooldownForTests } from './cooldowns';

// Re-export — 외부에서 본 모듈을 통해 import 하던 코드 보호 (2026-04-26 H2-followup 이전 패턴).
export { uiAmountToRaw } from '../../utils/units';
