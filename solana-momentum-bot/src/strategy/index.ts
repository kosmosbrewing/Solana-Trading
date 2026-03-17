export {
  evaluateVolumeSpikeBreakout,
  buildVolumeSpikeOrder,
  calcVolumeMcapRatio,
} from './volumeSpikeBreakout';
export type { VolumeSpikeParams } from './volumeSpikeBreakout';

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

export { assessLpStability } from './lpMonitor';
export type { LpStability } from './lpMonitor';

export { checkExhaustion } from './exhaustion';

export { calcRSI, calcAdaptiveTrailingStop } from './adaptiveTrailing';

export {
  evaluateFibPullback,
  buildFibPullbackOrder,
} from './fibPullback';
export type { FibPullbackParams } from './fibPullback';

export {
  evaluateNewLpSniper,
  buildNewLpOrder,
} from './newLpSniper';
export type { NewLpSniperParams, NewListingCandidate } from './newLpSniper';

export {
  evaluateMomentumCascadeEntry,
  buildMomentumCascadeOrder,
  isFirstLegQualified,
  detectRecompression,
  detectReacceleration,
  calculateCombinedStopLoss,
  calculateAddOnQuantity,
  initCascadeState,
  addCascadeLeg,
  updateCascadeState,
} from './momentumCascade';
export type { CascadeState, CascadeLeg, MomentumCascadeParams } from './momentumCascade';
