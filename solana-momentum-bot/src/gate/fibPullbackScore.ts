import { buildBreakoutScoreDetail } from '../strategy/breakoutScore';
import type { LpStability } from '../strategy';
import type { BreakoutScoreDetail, Signal } from '../utils/types';
import type { FibPullbackGateConfig } from './scoreGate';

interface FibPullbackScoreInput {
  signal: Signal;
  lpStability: LpStability;
  config: FibPullbackGateConfig;
}

export function calcFibPullbackScore(input: FibPullbackScoreInput): BreakoutScoreDetail {
  const impulsePct = input.signal.meta.impulsePct ?? 0;
  const impulseStrength = safeRatio(impulsePct, input.config.impulseMinPct);
  const fibPrecision = clampUnit(input.signal.meta.fibPrecision ?? 0);
  const volumeClimaxRatio = Math.max(0, input.signal.meta.volumeClimaxRatio ?? 0);
  const reclaimQuality = clampUnit(
    input.signal.meta.reclaimQuality ??
      fallbackReclaimQuality(input.signal, input.config.minWickRatio)
  );

  const volumeScore = scoreVolumeClimax(volumeClimaxRatio, input.config.volumeClimaxMultiplier);
  const buyRatioScore = scoreFibPrecision(fibPrecision);
  const multiTfScore = scoreImpulseStrength(impulseStrength);
  const whaleScore = scoreReclaimQuality(reclaimQuality);
  const lpScore = scoreLpStability(input.lpStability);

  return buildBreakoutScoreDetail({
    volumeScore,
    buyRatioScore,
    multiTfScore,
    whaleScore,
    lpScore,
    mcapVolumeScore: 0,
    components: [
      { key: 'impulse_strength', label: 'Impulse Strength', score: multiTfScore, maxScore: 25, value: impulseStrength },
      { key: 'fib_precision', label: 'Fib Precision', score: buyRatioScore, maxScore: 25, value: fibPrecision },
      { key: 'volume_climax_ratio', label: 'Volume Climax', score: volumeScore, maxScore: 20, value: volumeClimaxRatio },
      { key: 'reclaim_quality', label: 'Reclaim Quality', score: whaleScore, maxScore: 15, value: reclaimQuality },
      { key: 'lp_stability', label: 'LP Stability', score: lpScore, maxScore: 15, value: input.lpStability === 'stable' ? 1 : input.lpStability === 'dropping' ? -1 : 0 },
    ],
  });
}

function scoreImpulseStrength(impulseStrength: number): number {
  if (impulseStrength >= 1.5) return 25;
  if (impulseStrength >= 1.25) return 18;
  if (impulseStrength >= 1.0) return 10;
  return 0;
}

function scoreFibPrecision(fibPrecision: number): number {
  if (fibPrecision >= 0.75) return 25;
  if (fibPrecision >= 0.55) return 18;
  if (fibPrecision >= 0.35) return 10;
  return 0;
}

function scoreVolumeClimax(volumeClimaxRatio: number, baseThreshold: number): number {
  if (volumeClimaxRatio >= baseThreshold * 1.5) return 20;
  if (volumeClimaxRatio >= baseThreshold * 1.2) return 15;
  if (volumeClimaxRatio >= baseThreshold) return 10;
  return 0;
}

function scoreReclaimQuality(reclaimQuality: number): number {
  if (reclaimQuality >= 0.75) return 15;
  if (reclaimQuality >= 0.55) return 10;
  if (reclaimQuality >= 0.35) return 5;
  return 0;
}

function scoreLpStability(lpStability: LpStability): number {
  if (lpStability === 'stable') return 15;
  if (lpStability === 'dropping') return -10;
  return 0;
}

function fallbackReclaimQuality(signal: Signal, minWickRatio: number): number {
  const wickRatio = signal.meta.wickRatio ?? 0;
  const reclaimCloseStrength = signal.meta.reclaimCloseStrength ?? 0;
  const wickQuality = clampUnit(
    (wickRatio - minWickRatio) / Math.max(1 - minWickRatio, Number.EPSILON)
  );
  return clampUnit(reclaimCloseStrength * 0.6 + wickQuality * 0.4);
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function safeRatio(value: number, base: number): number {
  return base > 0 ? value / base : 0;
}
