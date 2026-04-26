// In-memory position registry + funnel counters. 모든 entry/tick/close/recovery 가
// 이 singleton Map/state 를 공유한다. 외부에서 직접 수정 금지 — getter 만 사용.
// 단, addPureWsPositionForTests 는 테스트 셋업용 escape hatch.

import type { PureWsPosition } from './types';

export const activePositions = new Map<string, PureWsPosition>();

export function getActivePureWsPositions(): ReadonlyMap<string, PureWsPosition> {
  return activePositions;
}

export interface PureWsFunnelStats {
  signalsReceived: number;
  gatePass: number;
  entry: number;
  txSuccess: number;
  dbPersisted: number;
  notifierOpenSent: number;
  closedTrades: number;
  winnersT1: number;
  winnersT2: number;
  winnersT3: number;
  sessionStartAt: Date;
}

export const funnelStats: PureWsFunnelStats = {
  signalsReceived: 0, gatePass: 0, entry: 0,
  txSuccess: 0, dbPersisted: 0, notifierOpenSent: 0, closedTrades: 0,
  winnersT1: 0, winnersT2: 0, winnersT3: 0,
  sessionStartAt: new Date(),
};

export function getPureWsFunnelStats(): Readonly<PureWsFunnelStats> {
  return funnelStats;
}

export function addPureWsPositionForTests(pos: PureWsPosition): void {
  activePositions.set(pos.tradeId, pos);
}
