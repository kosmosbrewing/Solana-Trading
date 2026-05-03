// Test helper — 모든 in-memory pure_ws lane state 를 초기화한다.
// jest 테스트 setup 에서 호출. production 코드에서 호출 금지.
//
// 추가 state 가 생기면 여기 한 곳에 모아 둬야 stale state 누수가 안 생긴다.

import { resetPairQuarantineForTests } from '../../risk/pairQuarantineTracker';
import { resetTokenSessionTrackerForTests } from '../tokenSessionTracker';
import { activePositions, funnelStats } from './positionState';
import { pairOutcomeCooldownByPair, v1LastEntrySecByPair, v2LastTriggerSecByPair } from './cooldowns';
import { inflightEntryByPair } from './inflight';
import { clearTokenSessionConfigured } from './tokenSession';
import { clearPairQuarantineConfigured } from './pairQuarantine';
import { resetPureWsPaperParamArmsForTests } from './paperParamArms';

export function resetPureWsLaneStateForTests(): void {
  activePositions.clear();
  v2LastTriggerSecByPair.clear();
  v1LastEntrySecByPair.clear();
  pairOutcomeCooldownByPair.clear();
  inflightEntryByPair.clear();
  // Phase 3 — token session in-memory state 도 초기화.
  clearTokenSessionConfigured();
  resetTokenSessionTrackerForTests();
  // Phase 4 — pair quarantine state 초기화.
  clearPairQuarantineConfigured();
  resetPairQuarantineForTests();
  resetPureWsPaperParamArmsForTests();
  funnelStats.signalsReceived = 0;
  funnelStats.gatePass = 0;
  funnelStats.entry = 0;
  funnelStats.txSuccess = 0;
  funnelStats.dbPersisted = 0;
  funnelStats.notifierOpenSent = 0;
  funnelStats.closedTrades = 0;
  funnelStats.winnersT1 = 0;
  funnelStats.winnersT2 = 0;
  funnelStats.winnersT3 = 0;
  funnelStats.sessionStartAt = new Date();
}
