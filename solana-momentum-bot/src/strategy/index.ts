export {
  evaluateVolumeSpikeBreakout,
  buildVolumeSpikeOrder,
} from './volumeSpikeBreakout';
export type { VolumeSpikeParams } from './volumeSpikeBreakout';

export {
  evaluatePumpDetection,
  buildPumpOrder,
} from './pumpDetection';
export type { PumpDetectParams } from './pumpDetection';

export {
  calcATR,
  calcAvgVolume,
  calcHighestHigh,
  calcLowestLow,
  countConsecutiveBullish,
  calcPriceChangeRate,
} from './indicators';

export { calcBreakoutScore, calcBuyRatio } from './breakoutScore';
export type { BreakoutScoreInput } from './breakoutScore';

export { detectWhaleActivity } from './whaleDetect';
export type { WhaleAlert } from './whaleDetect';

export { checkLpChange, assessLpStability } from './lpMonitor';
export type { LpStability, LpAlert } from './lpMonitor';

export { checkMultiTfAlignment } from './multiTf';

export { checkExhaustion } from './exhaustion';

export { calcRSI, calcAdaptiveTrailingStop } from './adaptiveTrailing';

export {
  evaluateFibPullback,
  buildFibPullbackOrder,
} from './fibPullback';
export type { FibPullbackParams } from './fibPullback';
