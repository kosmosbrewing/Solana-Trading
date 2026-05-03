import type { RotationFlowMetrics } from './flowMetrics';

export type RotationFlowExitAction = 'hold' | 'reduce_light' | 'reduce_strong' | 'close_full';

export interface RotationFlowExitPolicyConfig {
  lightReducePressure: number;
  strongReducePressure: number;
  fullExitPressure: number;
  criticalExitPressure: number;
  lightReducePct: number;
  strongReducePct: number;
  residualHoldSec: number;
}

export interface RotationFlowExitDecision {
  action: RotationFlowExitAction;
  reducePct: number;
  residualHoldSec: number;
  reason: string;
}

export function decideRotationFlowExit(
  metrics: RotationFlowMetrics,
  config: RotationFlowExitPolicyConfig
): RotationFlowExitDecision {
  const pressure = metrics.sellPressure30;
  if (pressure >= config.criticalExitPressure) {
    return {
      action: 'close_full',
      reducePct: 1,
      residualHoldSec: 0,
      reason: 'critical_sell_pressure',
    };
  }
  if (pressure >= config.fullExitPressure) {
    return {
      action: 'close_full',
      reducePct: 1,
      residualHoldSec: 0,
      reason: 'high_sell_pressure',
    };
  }
  if (pressure >= config.strongReducePressure) {
    return {
      action: 'reduce_strong',
      reducePct: config.strongReducePct,
      residualHoldSec: config.residualHoldSec,
      reason: 'medium_sell_pressure',
    };
  }
  if (pressure >= config.lightReducePressure) {
    return {
      action: 'reduce_light',
      reducePct: config.lightReducePct,
      residualHoldSec: config.residualHoldSec,
      reason: 'low_sell_pressure',
    };
  }
  return {
    action: 'hold',
    reducePct: 0,
    residualHoldSec: config.residualHoldSec,
    reason: metrics.freshTopup ? 'low_pressure_with_fresh_topup' : 'low_pressure_hold',
  };
}

export function decideRotationFlowPriceKill(
  metrics: RotationFlowMetrics,
  config: RotationFlowExitPolicyConfig
): RotationFlowExitDecision {
  if (metrics.sellPressure30 >= config.fullExitPressure) {
    return {
      action: 'close_full',
      reducePct: 1,
      residualHoldSec: 0,
      reason: 'price_kill_with_high_sell_pressure',
    };
  }
  if (metrics.freshTopup && metrics.sellPressure30 < config.strongReducePressure) {
    return {
      action: 'reduce_strong',
      reducePct: config.strongReducePct,
      residualHoldSec: config.residualHoldSec,
      reason: 'price_kill_residual_with_fresh_topup',
    };
  }
  return {
    action: 'close_full',
    reducePct: 1,
    residualHoldSec: 0,
    reason: 'price_kill_without_flow_support',
  };
}
