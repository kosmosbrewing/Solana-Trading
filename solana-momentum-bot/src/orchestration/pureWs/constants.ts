// Lane-wide constants shared across all pureWs modules.
// 단일 source of truth — strategy 라벨 변경 시 한 곳만 수정.

import { createModuleLogger } from '../../utils/logger';

export const LANE_STRATEGY: 'pure_ws_breakout' = 'pure_ws_breakout';
export const log = createModuleLogger('PureWsBreakout');
