// Per-pair cooldown maps — pair diversity 확보 (top pair 쏠림 방어).
// v2: scanner 주도 (scanPureWsV2Burst 가 entry 성공 시 set).
// v1: bootstrap signal 주도 (handlePureWsSignal 이 ws_burst_v2 가 아닌 source 에 한해 set).
// 둘 다 module-level Map — 모든 lane 호출이 같은 인스턴스 공유.

export const v2LastTriggerSecByPair = new Map<string, number>();

// 2026-04-21 P1: v1 (bootstrap) 경로 per-pair cooldown.
// Why: BOME(ukHH6c7m) 한 토큰에 반복 signal → duplicate guard 는 "이미 holding" 만 차단 →
// close 직후 재signal → 또 진입 → 4 consecutive losers → canary halt 조기 유발.
// v2 와 동일 메커니즘으로 close 이후에도 pair-level cooldown 적용 (config.pureWsV1PerPairCooldownSec).
export const v1LastEntrySecByPair = new Map<string, number>();

export interface PureWsPairOutcomeCooldown {
  untilSec: number;
  reason: string;
  netPct: number;
  mfePct: number;
  recordedAtSec: number;
}

export interface PureWsPairOutcomeCooldownConfig {
  enabled: boolean;
  weakMfeThreshold: number;
  baseCooldownSec: number;
  weakCooldownSec: number;
  lossCooldownSec: number;
  hardCutCooldownSec: number;
}

export const pairOutcomeCooldownByPair = new Map<string, PureWsPairOutcomeCooldown>();

export function getPureWsPairOutcomeCooldown(
  pair: string,
  nowSec: number
): PureWsPairOutcomeCooldown | null {
  const cooldown = pairOutcomeCooldownByPair.get(pair);
  if (!cooldown) return null;
  if (cooldown.untilSec <= nowSec) {
    pairOutcomeCooldownByPair.delete(pair);
    return null;
  }
  return cooldown;
}

export function recordPureWsPairOutcomeCooldown(input: {
  pair: string;
  nowSec: number;
  exitReason: string;
  netPct: number;
  mfePct: number;
  config: PureWsPairOutcomeCooldownConfig;
}): PureWsPairOutcomeCooldown | null {
  if (!input.config.enabled) return null;

  let cooldownSec = input.config.baseCooldownSec;
  let reason = 'base';
  if (input.exitReason === 'REJECT_HARD_CUT') {
    cooldownSec = input.config.hardCutCooldownSec;
    reason = 'hard_cut';
  } else if (input.netPct <= 0) {
    cooldownSec = input.config.lossCooldownSec;
    reason = 'loss';
  } else if (input.mfePct < input.config.weakMfeThreshold) {
    cooldownSec = input.config.weakCooldownSec;
    reason = 'weak_mfe';
  }

  if (cooldownSec <= 0) return null;
  const next: PureWsPairOutcomeCooldown = {
    untilSec: input.nowSec + cooldownSec,
    reason,
    netPct: input.netPct,
    mfePct: input.mfePct,
    recordedAtSec: input.nowSec,
  };
  const prev = pairOutcomeCooldownByPair.get(input.pair);
  if (!prev || prev.untilSec < next.untilSec) {
    pairOutcomeCooldownByPair.set(input.pair, next);
    return next;
  }
  return prev;
}

/** Test helper — scanPureWsV2Burst 이후 cooldown state 초기화 */
export function resetPureWsV2CooldownForTests(): void {
  v2LastTriggerSecByPair.clear();
  v1LastEntrySecByPair.clear();
  pairOutcomeCooldownByPair.clear();
}
