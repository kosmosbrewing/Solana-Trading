/**
 * Cupsey State Machine — Pure backtest replay logic (DB/executor 의존 없음)
 *
 * Why: production cupseyLaneHandler.ts 의 STALK→PROBE→WINNER state transition 을
 * 순수 함수로 추출하여 candle replay 백테스트에서 재사용.
 * cupsey 파라미터 최적화/grid sweep 목적.
 */

import { tradingParams } from '../utils/tradingParams';

// ─── Config ───

export interface CupseyReplayConfig {
  stalkWindowSec: number;
  stalkDropPct: number;
  stalkMaxDropPct: number;
  probeWindowSec: number;
  probeMfeThreshold: number;
  probeHardCutPct: number;
  winnerMaxHoldSec: number;
  winnerTrailingPct: number;
  winnerBreakevenPct: number;
  maxConcurrent: number;
  roundTripCostPct: number;
}

export function defaultCupseyReplayConfig(): CupseyReplayConfig {
  const c = tradingParams.cupseyLane;
  const liq = tradingParams.liquidity;
  return {
    stalkWindowSec: c.cupseyStalKWindowSec,
    stalkDropPct: c.cupseyStalkDropPct,
    stalkMaxDropPct: c.cupseyStalkMaxDropPct,
    probeWindowSec: c.cupseyProbeWindowSec,
    probeMfeThreshold: c.cupseyProbeMfeThreshold,
    probeHardCutPct: c.cupseyProbeHardCutPct,
    winnerMaxHoldSec: c.cupseyWinnerMaxHoldSec,
    winnerTrailingPct: c.cupseyWinnerTrailingPct,
    winnerBreakevenPct: c.cupseyWinnerBreakevenPct,
    maxConcurrent: c.cupseyMaxConcurrent,
    roundTripCostPct: liq.defaultAmmFeePct + liq.defaultMevMarginPct,
  };
}

// ─── Trade Result ───

export interface CupseyTradeResult {
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
  stalkSkip: boolean;
}

// ─── Internal Position State ───

type CupseyReplayState = 'STALK' | 'PROBE' | 'WINNER';

export interface CupseyReplayPosition {
  id: string;
  pairAddress: string;
  signalPrice: number;
  signalTimeSec: number;
  entryPrice: number;
  entryTimeSec: number;
  state: CupseyReplayState;
  peakPrice: number;
  troughPrice: number;
}

// ─── Core Functions ───

/**
 * Signal 수신 시 새 STALK position 생성.
 * 중복 pair / concurrent 가드 적용.
 */
export function tryOpenCupseyPosition(
  positions: CupseyReplayPosition[],
  signal: { pairAddress: string; price: number },
  timeSec: number,
  config: CupseyReplayConfig
): CupseyReplayPosition | null {
  // Guard: 이미 같은 pair 보유 중
  if (positions.some(p => p.pairAddress === signal.pairAddress)) {
    return null;
  }

  // Guard: max concurrent
  if (positions.length >= config.maxConcurrent) {
    return null;
  }

  const pos: CupseyReplayPosition = {
    id: `cupsey-${signal.pairAddress.slice(0, 8)}-${timeSec}`,
    pairAddress: signal.pairAddress,
    signalPrice: signal.price,
    signalTimeSec: timeSec,
    entryPrice: signal.price,
    entryTimeSec: timeSec,
    state: 'STALK',
    peakPrice: signal.price,
    troughPrice: signal.price,
  };
  positions.push(pos);
  return pos;
}

/**
 * 매 캔들마다 호출. 해당 pairAddress 의 모든 활성 position 을 tick.
 * 종료된 trade 는 completedTrades 에 push 하고 positions 에서 제거.
 *
 * Why: cupseyLaneHandler.ts L140-301 의 state transition 을 순수 함수로 추출.
 */
export function tickCupseyPositions(
  positions: CupseyReplayPosition[],
  pairAddress: string,
  price: number,
  timeSec: number,
  config: CupseyReplayConfig,
  completedTrades: CupseyTradeResult[]
): void {
  // Why: reverse iteration — splice 시 index shift 방지
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
  pos: CupseyReplayPosition,
  price: number,
  timeSec: number,
  config: CupseyReplayConfig
): CupseyTradeResult | null {
  // ─── STALK: pullback 대기 (매수 전) ───
  if (pos.state === 'STALK') {
    const stalkElapsed = timeSec - pos.signalTimeSec;
    const dropFromSignal = (price - pos.signalPrice) / pos.signalPrice;

    // STALK → SKIP: 시간 초과
    if (stalkElapsed >= config.stalkWindowSec) {
      return buildResult(pos, price, timeSec, 'STALK_TIMEOUT', config, true);
    }

    // STALK → SKIP: crash (too deep)
    if (dropFromSignal <= -config.stalkMaxDropPct) {
      return buildResult(pos, price, timeSec, 'STALK_CRASH', config, true);
    }

    // STALK → PROBE: pullback confirmed → entry
    if (dropFromSignal <= -config.stalkDropPct) {
      pos.state = 'PROBE';
      pos.entryPrice = price;
      pos.entryTimeSec = timeSec;
      pos.peakPrice = price;
      pos.troughPrice = price;
    }

    return null;
  }

  // ─── PROBE / WINNER (매수 후) ───

  pos.peakPrice = Math.max(pos.peakPrice, price);
  pos.troughPrice = Math.min(pos.troughPrice, price);

  const elapsed = timeSec - pos.entryTimeSec;
  const mfePct = (pos.peakPrice - pos.entryPrice) / pos.entryPrice;
  const maePct = (pos.troughPrice - pos.entryPrice) / pos.entryPrice;
  const currentPct = (price - pos.entryPrice) / pos.entryPrice;

  if (pos.state === 'PROBE') {
    // PROBE → REJECT: hard cut on MAE
    if (maePct <= -config.probeHardCutPct) {
      return buildResult(pos, price, timeSec, 'REJECT_HARD_CUT', config, false);
    }

    // PROBE → WINNER: MFE threshold
    if (mfePct >= config.probeMfeThreshold) {
      pos.state = 'WINNER';
      return null;
    }

    // PROBE → REJECT: timeout
    if (elapsed >= config.probeWindowSec) {
      return buildResult(pos, price, timeSec, 'REJECT_TIMEOUT', config, false);
    }

    return null;
  }

  // pos.state === 'WINNER'

  // WINNER → CLOSE: hard time stop
  if (elapsed >= config.winnerMaxHoldSec) {
    return buildResult(pos, price, timeSec, 'WINNER_TIME_STOP', config, false);
  }

  // WINNER → CLOSE: trailing stop
  const trailingStop = pos.peakPrice * (1 - config.winnerTrailingPct);
  if (price <= trailingStop) {
    return buildResult(pos, price, timeSec, 'WINNER_TRAILING', config, false);
  }

  // WINNER → CLOSE: breakeven stop
  const breakevenStop = pos.entryPrice * (1 + config.winnerBreakevenPct);
  if (price <= breakevenStop && mfePct > config.probeMfeThreshold * 2) {
    return buildResult(pos, price, timeSec, 'WINNER_BREAKEVEN', config, false);
  }

  return null;
}

/**
 * 데이터 종료 시 잔여 position 강제 청산.
 */
export function forceCloseAll(
  positions: CupseyReplayPosition[],
  lastPrices: Map<string, number>,
  timeSec: number,
  completedTrades: CupseyTradeResult[]
): void {
  for (const pos of positions) {
    const price = lastPrices.get(pos.pairAddress) ?? pos.entryPrice;
    const stalkSkip = pos.state === 'STALK';
    completedTrades.push(buildResult(pos, price, timeSec, 'DATA_END', { roundTripCostPct: 0 } as CupseyReplayConfig, stalkSkip));
  }
  positions.length = 0;
}

// ─── Helper ───

function buildResult(
  pos: CupseyReplayPosition,
  exitPrice: number,
  exitTimeSec: number,
  exitReason: string,
  config: CupseyReplayConfig,
  stalkSkip: boolean
): CupseyTradeResult {
  const entryPrice = stalkSkip ? 0 : pos.entryPrice;
  const rawPnlPct = entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice : 0;
  const netPnlPct = entryPrice > 0 ? rawPnlPct - config.roundTripCostPct : 0;
  const holdSec = stalkSkip ? 0 : exitTimeSec - pos.entryTimeSec;
  const mfePct = entryPrice > 0 ? (pos.peakPrice - entryPrice) / entryPrice : 0;
  const maePct = entryPrice > 0 ? (pos.troughPrice - entryPrice) / entryPrice : 0;

  return {
    id: pos.id,
    pairAddress: pos.pairAddress,
    signalPrice: pos.signalPrice,
    signalTimeSec: pos.signalTimeSec,
    entryPrice,
    entryTimeSec: stalkSkip ? 0 : pos.entryTimeSec,
    exitPrice: stalkSkip ? 0 : exitPrice,
    exitTimeSec: stalkSkip ? 0 : exitTimeSec,
    holdSec,
    rawPnlPct,
    netPnlPct,
    exitReason,
    mfePct,
    maePct,
    stalkSkip,
  };
}
