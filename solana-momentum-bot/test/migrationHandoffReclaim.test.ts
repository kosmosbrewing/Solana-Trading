import {
  evaluateMigrationStage,
  MigrationEvent,
  MigrationGateConfig,
} from '../src/strategy/migrationHandoffReclaim';
import { Candle } from '../src/utils/types';

function makeGate(overrides: Partial<MigrationGateConfig> = {}): MigrationGateConfig {
  return {
    cooldownSec: 90,
    maxAgeSec: 900,
    stalkMinPullbackPct: 0.10,
    stalkMaxPullbackPct: 0.30,
    reclaimBuyRatioMin: 0.55,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<MigrationEvent> = {}): MigrationEvent {
  return {
    kind: 'pumpswap_canonical_init',
    pairAddress: 'PAIR_TEST',
    eventPrice: 1.0,
    eventTimeSec: 1_000_000,
    signature: 'SIG_TEST',
    ...overrides,
  };
}

function makeCandle(buy: number, sell: number): Candle {
  return {
    pairAddress: 'PAIR_TEST',
    timestamp: new Date(),
    intervalSec: 10,
    open: 1, high: 1, low: 1, close: 1,
    volume: buy + sell,
    tradeCount: buy + sell > 0 ? 1 : 0,
    buyVolume: buy,
    sellVolume: sell,
  };
}

describe('evaluateMigrationStage', () => {
  it('returns COOLDOWN during first overshoot window', () => {
    const event = makeEvent();
    const result = evaluateMigrationStage(event, event.eventTimeSec + 30, 1.05, [], makeGate());
    expect(result.stage).toBe('COOLDOWN');
  });

  it('returns REJECT_TIMEOUT after maxAgeSec', () => {
    const event = makeEvent();
    const result = evaluateMigrationStage(event, event.eventTimeSec + 1000, 0.9, [], makeGate());
    expect(result.stage).toBe('REJECT_TIMEOUT');
  });

  it('returns REJECT_CRASH when pullback exceeds stalkMaxPullbackPct', () => {
    const event = makeEvent();
    const result = evaluateMigrationStage(event, event.eventTimeSec + 120, 0.6, [], makeGate());
    expect(result.stage).toBe('REJECT_CRASH');
  });

  it('returns STALK when pullback not yet reached minimum', () => {
    const event = makeEvent();
    // after cooldown, price only -5% (< 10% min pullback)
    const result = evaluateMigrationStage(event, event.eventTimeSec + 120, 0.95, [], makeGate());
    expect(result.stage).toBe('STALK');
  });

  it('returns STALK when pullback ok but buy_ratio too weak (still selling)', () => {
    const event = makeEvent();
    const candles = [makeCandle(20, 80), makeCandle(30, 70), makeCandle(25, 75)];
    const result = evaluateMigrationStage(event, event.eventTimeSec + 120, 0.85, candles, makeGate());
    expect(result.stage).toBe('STALK');
    expect(result.buyRatio).toBeLessThan(0.55);
  });

  it('returns READY when pullback met AND reclaim buy_ratio confirmed', () => {
    const event = makeEvent();
    const candles = [makeCandle(80, 20), makeCandle(70, 30), makeCandle(75, 25)];
    const result = evaluateMigrationStage(event, event.eventTimeSec + 120, 0.85, candles, makeGate());
    expect(result.stage).toBe('READY');
    expect(result.buyRatio).toBeGreaterThanOrEqual(0.55);
  });

  it('skips zero-volume candles in buy_ratio average', () => {
    const event = makeEvent();
    // 2 zero-volume candles + 1 strong buy candle → average should reflect only the live one
    const candles = [makeCandle(0, 0), makeCandle(0, 0), makeCandle(80, 20)];
    const result = evaluateMigrationStage(event, event.eventTimeSec + 120, 0.85, candles, makeGate());
    expect(result.stage).toBe('READY');
    expect(result.buyRatio).toBeCloseTo(0.8, 2);
  });

  it('boundary: just past stalkMinPullbackPct with reclaim passes READY', () => {
    const event = makeEvent();
    const candles = [makeCandle(60, 40)];
    // -10.1% — clearly past threshold (float-safe). Boundary inclusive 검증은 float 정밀도로
    // 신뢰하기 어려워서 명확히 threshold 넘은 케이스만 단언한다.
    const result = evaluateMigrationStage(event, event.eventTimeSec + 120, 0.899, candles, makeGate());
    expect(result.stage).toBe('READY');
  });
});
