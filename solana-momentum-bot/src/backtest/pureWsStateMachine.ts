/**
 * Pure WS Breakout State Machine — Pure backtest replay logic (DB/executor 의존 없음).
 *
 * Why: production pureWsBreakoutHandler.ts (1,676줄) 의 PROBE → T1 → T2 → T3 tiered runner
 * state transition 을 순수 함수로 추출하여 candle replay 백테스트에서 재사용.
 * cupseyStateMachine.ts 의 pattern 을 따르되 **STALK 제거 + immediate PROBE + tiered runner** 로 대체.
 *
 * Entry-price idealization: live 는 entryDriftGuard + Jupiter fill slippage 를 거치지만
 * backtest 는 signal price = entry price 로 가정. 결과는 **upper bound** 로 해석.
 */

import { tradingParams } from '../utils/tradingParams';

// ─── Config ───

export interface PureWsReplayConfig {
  probeWindowSec: number;
  probeHardCutPct: number;
  probeFlatBandPct: number;
  probeTrailingPct: number;
  t1MfeThreshold: number;
  t1TrailingPct: number;
  t2MfeThreshold: number;
  t2TrailingPct: number;
  t2BreakevenLockMultiplier: number;
  t3MfeThreshold: number;
  t3TrailingPct: number;
  maxConcurrent: number;
  maxPeakMultiplier: number;
  roundTripCostPct: number;
}

export function defaultPureWsReplayConfig(): PureWsReplayConfig {
  const c = tradingParams.pureWsLane;
  const liq = tradingParams.liquidity;
  return {
    probeWindowSec: c.pureWsProbeWindowSec,
    probeHardCutPct: c.pureWsProbeHardCutPct,
    probeFlatBandPct: c.pureWsProbeFlatBandPct,
    probeTrailingPct: c.pureWsProbeTrailingPct,
    t1MfeThreshold: c.pureWsT1MfeThreshold,
    t1TrailingPct: c.pureWsT1TrailingPct,
    t2MfeThreshold: c.pureWsT2MfeThreshold,
    t2TrailingPct: c.pureWsT2TrailingPct,
    t2BreakevenLockMultiplier: c.pureWsT2BreakevenLockMultiplier,
    t3MfeThreshold: c.pureWsT3MfeThreshold,
    t3TrailingPct: c.pureWsT3TrailingPct,
    maxConcurrent: c.pureWsMaxConcurrent,
    maxPeakMultiplier: c.pureWsMaxPeakMultiplier,
    roundTripCostPct: liq.defaultAmmFeePct + liq.defaultMevMarginPct,
  };
}

// ─── Trade Result ───

export interface PureWsTradeResult {
  id: string;
  pairAddress: string;
  signalPrice: number;
  signalTimeSec: number;
  entryPrice: number;
  entryTimeSec: number;
  exitPrice: number;
  exitTimeSec: number;
  holdSec: number;
  rawPnlPct: number;
  netPnlPct: number;
  exitReason: string;
  mfePct: number;
  maePct: number;
  // Visit tracking — live P2-4 와 동일 스키마, net return 과 별개로 MFE peak 도달 여부 기록
  t1VisitAtSec: number | null;
  t2VisitAtSec: number | null;
  t3VisitAtSec: number | null;
  closeState: PureWsReplayState;
}

// ─── Internal Position State ───

export type PureWsReplayState = 'PROBE' | 'T1' | 'T2' | 'T3';

export interface PureWsReplayPosition {
  id: string;
  pairAddress: string;
  signalPrice: number;
  signalTimeSec: number;
  entryPrice: number;
  entryTimeSec: number;
  state: PureWsReplayState;
  peakPrice: number;
  troughPrice: number;
  t1VisitAtSec: number | null;
  t2VisitAtSec: number | null;
  t3VisitAtSec: number | null;
}

// ─── Core Functions ───

export function tryOpenPureWsPosition(
  positions: PureWsReplayPosition[],
  signal: { pairAddress: string; price: number },
  timeSec: number,
  config: PureWsReplayConfig
): PureWsReplayPosition | null {
  if (positions.some((p) => p.pairAddress === signal.pairAddress)) return null;
  if (positions.length >= config.maxConcurrent) return null;

  const pos: PureWsReplayPosition = {
    id: `pure_ws-${signal.pairAddress.slice(0, 8)}-${timeSec}`,
    pairAddress: signal.pairAddress,
    signalPrice: signal.price,
    signalTimeSec: timeSec,
    entryPrice: signal.price,
    entryTimeSec: timeSec,
    state: 'PROBE',
    peakPrice: signal.price,
    troughPrice: signal.price,
    t1VisitAtSec: null,
    t2VisitAtSec: null,
    t3VisitAtSec: null,
  };
  positions.push(pos);
  return pos;
}

export function tickPureWsPositions(
  positions: PureWsReplayPosition[],
  pairAddress: string,
  price: number,
  timeSec: number,
  config: PureWsReplayConfig,
  completedTrades: PureWsTradeResult[]
): void {
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    if (pos.pairAddress !== pairAddress) continue;
    if (price <= 0) continue;

    const result = tickSinglePosition(pos, price, timeSec, config);
    if (result) {
      completedTrades.push(result);
      positions.splice(i, 1);
    }
  }
}

function tickSinglePosition(
  pos: PureWsReplayPosition,
  price: number,
  timeSec: number,
  config: PureWsReplayConfig
): PureWsTradeResult | null {
  // HWM peak sanity — entry × 15 이상 움직임은 bad-fill/rug 로 간주, peak 갱신 거부
  const maxPeak = pos.entryPrice * config.maxPeakMultiplier;
  if (price > pos.peakPrice && price <= maxPeak) {
    pos.peakPrice = price;
  }
  if (price < pos.troughPrice) pos.troughPrice = price;

  const elapsed = timeSec - pos.entryTimeSec;
  const mfePct = (pos.peakPrice - pos.entryPrice) / pos.entryPrice;
  const maePct = (pos.troughPrice - pos.entryPrice) / pos.entryPrice;
  const currentPct = (price - pos.entryPrice) / pos.entryPrice;

  switch (pos.state) {
    case 'PROBE': {
      // Hard cut (loser quick cut)
      if (maePct <= -config.probeHardCutPct) {
        return buildResult(pos, price, timeSec, 'PROBE_HARD_CUT', config);
      }
      // Promote to T1
      if (mfePct >= config.t1MfeThreshold) {
        pos.state = 'T1';
        pos.t1VisitAtSec = timeSec;
        return null;
      }
      // Window timeout
      if (elapsed >= config.probeWindowSec) {
        // Flat vs trail decision
        if (Math.abs(currentPct) < config.probeFlatBandPct) {
          return buildResult(pos, price, timeSec, 'PROBE_REJECT_TIMEOUT', config);
        }
        return buildResult(pos, price, timeSec, 'PROBE_FLAT_CUT', config);
      }
      // Trailing stop within PROBE window (partial recovery protection)
      const probeTrail = pos.peakPrice * (1 - config.probeTrailingPct);
      if (mfePct > 0 && price <= probeTrail) {
        return buildResult(pos, price, timeSec, 'PROBE_TRAIL', config);
      }
      return null;
    }

    case 'T1': {
      // Promote to T2
      if (mfePct >= config.t2MfeThreshold) {
        pos.state = 'T2';
        pos.t2VisitAtSec = timeSec;
        return null;
      }
      const t1Trail = pos.peakPrice * (1 - config.t1TrailingPct);
      if (price <= t1Trail) {
        return buildResult(pos, price, timeSec, 'T1_TRAIL', config);
      }
      return null;
    }

    case 'T2': {
      // Promote to T3
      if (mfePct >= config.t3MfeThreshold) {
        pos.state = 'T3';
        pos.t3VisitAtSec = timeSec;
        return null;
      }
      // trail OR breakeven lock — whichever is HIGHER (never close below lock)
      const t2Trail = pos.peakPrice * (1 - config.t2TrailingPct);
      const lockPrice = pos.entryPrice * config.t2BreakevenLockMultiplier;
      const effectiveStop = Math.max(t2Trail, lockPrice);
      if (price <= effectiveStop) {
        return buildResult(pos, price, timeSec, 'T2_TRAIL', config);
      }
      return null;
    }

    case 'T3': {
      // No time stop — only trail
      const t3Trail = pos.peakPrice * (1 - config.t3TrailingPct);
      if (price <= t3Trail) {
        return buildResult(pos, price, timeSec, 'T3_TRAIL', config);
      }
      return null;
    }
  }
}

export function forcePureWsCloseAll(
  positions: PureWsReplayPosition[],
  lastPrices: Map<string, number>,
  timeSec: number,
  config: PureWsReplayConfig,
  completedTrades: PureWsTradeResult[]
): void {
  for (const pos of positions) {
    const price = lastPrices.get(pos.pairAddress) ?? pos.entryPrice;
    completedTrades.push(buildResult(pos, price, timeSec, 'DATA_END', config));
  }
  positions.length = 0;
}

// ─── Helper ───

function buildResult(
  pos: PureWsReplayPosition,
  exitPrice: number,
  exitTimeSec: number,
  exitReason: string,
  config: PureWsReplayConfig
): PureWsTradeResult {
  const rawPnlPct = (exitPrice - pos.entryPrice) / pos.entryPrice;
  const netPnlPct = rawPnlPct - config.roundTripCostPct;
  const holdSec = exitTimeSec - pos.entryTimeSec;
  const mfePct = (pos.peakPrice - pos.entryPrice) / pos.entryPrice;
  const maePct = (pos.troughPrice - pos.entryPrice) / pos.entryPrice;
  return {
    id: pos.id,
    pairAddress: pos.pairAddress,
    signalPrice: pos.signalPrice,
    signalTimeSec: pos.signalTimeSec,
    entryPrice: pos.entryPrice,
    entryTimeSec: pos.entryTimeSec,
    exitPrice,
    exitTimeSec,
    holdSec,
    rawPnlPct,
    netPnlPct,
    exitReason,
    mfePct,
    maePct,
    t1VisitAtSec: pos.t1VisitAtSec,
    t2VisitAtSec: pos.t2VisitAtSec,
    t3VisitAtSec: pos.t3VisitAtSec,
    closeState: pos.state,
  };
}
