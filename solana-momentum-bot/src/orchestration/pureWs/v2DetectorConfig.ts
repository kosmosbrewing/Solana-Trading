// 2026-04-18 DEX_TRADE Phase 1.3: v2 detector config builder.
// runtime config snapshot → WsBurstDetectorConfig. tuning 시 config.ts 의 PUREWS_V2_* 만 수정.

import { config } from '../../utils/config';
import type { WsBurstDetectorConfig } from '../../strategy/wsBurstDetector';

export function buildV2DetectorConfig(): WsBurstDetectorConfig {
  return {
    enabled: true,
    nRecent: config.pureWsV2NRecent,
    nBaseline: config.pureWsV2NBaseline,
    minPassScore: config.pureWsV2MinPassScore,
    wVolume: config.pureWsV2WVolume,
    wBuy: config.pureWsV2WBuy,
    wDensity: config.pureWsV2WDensity,
    wPrice: config.pureWsV2WPrice,
    wReverse: config.pureWsV2WReverse,
    floorVol: config.pureWsV2FloorVol,
    floorBuy: config.pureWsV2FloorBuy,
    floorTx: config.pureWsV2FloorTx,
    floorPrice: config.pureWsV2FloorPrice,
    buyRatioAbsoluteFloor: config.pureWsV2BuyRatioAbsFloor,
    txCountAbsoluteFloor: config.pureWsV2TxCountAbsFloor,
    zVolSaturate: config.pureWsV2ZVolSaturate,
    zBuySaturate: config.pureWsV2ZBuySaturate,
    zTxSaturate: config.pureWsV2ZTxSaturate,
    bpsPriceSaturate: config.pureWsV2BpsPriceSaturate,
  };
}
