// 2026-04-21 P0 (observability): v2 scanner 가 production 에서 24h 동안 PASS 0건 관측됨.
// reject 는 log.debug 라 INFO 레벨 운영 로그에 안 찍혀 진단 불가.
// counter 기반 누적 telemetry 를 주기적으로 info log 출력 — threshold 튜닝 근거 확보.

import { config } from '../../utils/config';
import { log } from './constants';

export interface PureWsV2TelemetryState {
  scansCalled: number;
  pairsEvaluated: number;
  candlesInsufficient: number;
  detectorRejects: Record<string, number>;
  noCurrentPrice: number;
  cooldownSkipped: number;
  haltSkipped: number;
  passed: number;
  sessionStartMs: number;
}

export const v2Telemetry: PureWsV2TelemetryState = {
  scansCalled: 0,
  pairsEvaluated: 0,
  candlesInsufficient: 0,
  detectorRejects: {},
  noCurrentPrice: 0,
  cooldownSkipped: 0,
  haltSkipped: 0,
  passed: 0,
  sessionStartMs: Date.now(),
};

export function getPureWsV2Telemetry(): Readonly<PureWsV2TelemetryState> {
  return v2Telemetry;
}

export function resetPureWsV2TelemetryForTests(): void {
  v2Telemetry.scansCalled = 0;
  v2Telemetry.pairsEvaluated = 0;
  v2Telemetry.candlesInsufficient = 0;
  v2Telemetry.detectorRejects = {};
  v2Telemetry.noCurrentPrice = 0;
  v2Telemetry.cooldownSkipped = 0;
  v2Telemetry.haltSkipped = 0;
  v2Telemetry.passed = 0;
  v2Telemetry.sessionStartMs = Date.now();
}

/**
 * 주기적으로 (caller: HealthMonitor tick) 호출되어 v2 scan 누적 통계를 info 로그로 출력.
 * counter 는 reset 하지 않고 누적 유지 — 운영자가 lifetime 추이도 관찰 가능.
 * detectorRejects 는 top 3 reason 만 inline 으로, 나머지는 'other' 로 집계.
 */
export function logPureWsV2TelemetrySummary(): void {
  if (!config.pureWsLaneEnabled || !config.pureWsV2Enabled) return;
  const t = v2Telemetry;
  const rejectEntries = Object.entries(t.detectorRejects).sort((a, b) => b[1] - a[1]);
  const top3 = rejectEntries.slice(0, 3).map(([k, v]) => `${k}=${v}`).join(',');
  const rest = rejectEntries.slice(3).reduce((sum, [, v]) => sum + v, 0);
  const rejectSummary = top3 + (rest > 0 ? `,other=${rest}` : '');
  const uptimeMin = Math.round((Date.now() - t.sessionStartMs) / 60000);
  log.info(
    `[PUREWS_V2_SUMMARY] uptime=${uptimeMin}m scans=${t.scansCalled} ` +
    `eval=${t.pairsEvaluated} insuf=${t.candlesInsufficient} ` +
    `rejects=[${rejectSummary || 'none'}] noPrice=${t.noCurrentPrice} ` +
    `cooldown=${t.cooldownSkipped} halt=${t.haltSkipped} PASS=${t.passed}`
  );
}
