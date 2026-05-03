// pure_ws_breakout 의 in-memory position 표현. PureWsTradeState 는 운영 4 단계 +
// CLOSED 의 sentinel. PureWsPosition 은 entry/exit 사이의 모든 derived state 보유.

export type PureWsTradeState = 'PROBE' | 'RUNNER_T1' | 'RUNNER_T2' | 'RUNNER_T3' | 'CLOSED';

export interface PureWsPosition {
  tradeId: string;                // in-memory positionId
  dbTradeId?: string;
  pairAddress: string;
  /** Jupiter fill 가격 — pnl 계산 기준 (실제 지출 / 수령 토큰). */
  entryPrice: number;
  /**
   * 2026-04-19: Signal price (WS feed) — MAE/MFE hard-cut 판정 기준.
   * Why: Jupiter fill 이 signal 대비 +20-50% 드리프트 되는 경우 (Token-2022 / low-liq route)
   * entry 기준 MAE 는 시장이 수평인데도 -20% 로 찍혀 즉시 hardcut → bad fill 을 rug 로 오인.
   * market reference 기준 MAE/MFE 는 실제 가격 움직임만 측정.
   */
  marketReferencePrice: number;
  entryTimeSec: number;
  quantity: number;
  tokenDecimals?: number | null;
  state: PureWsTradeState;
  peakPrice: number;
  troughPrice: number;
  tokenSymbol?: string;
  sourceLabel?: string;
  discoverySource?: string;
  plannedEntryPrice?: number;
  entryTxSignature?: string;
  entrySlippageBps?: number;
  lastCloseFailureAtSec?: number;
  /** T2 도달 시 캐시 — 이후 close 하한선 (never close below entry × breakeven_lock) */
  t2BreakevenLockPrice?: number;
  /** Phase 3 snapshot — entry 시점 microstructure (quickReject / holdPhase 분석용) */
  buyRatioAtEntry?: number;
  txCountAtEntry?: number;
  /**
   * 2026-04-22 P2-4 (MFE peak ledger): `winners5x` 는 net return 기준이라 "T2 방문했으나
   * trail 로 반납" 케이스를 구분 못 한다. 아래 visit timestamp 로 MFE peak 기반 winner 분포
   * 보강 — canary-eval 이 `winners5x_by_visit = (t2VisitAtSec != null)` 로 집계 가능.
   */
  t1VisitAtSec?: number;
  t2VisitAtSec?: number;
  t3VisitAtSec?: number;
  // Phase 2 P1-3 (2026-04-25): T1 promotion 이 quote-based MFE 신호로 발동됐는지 기록.
  // candle peak vs quote peak 발산 측정 — ledger 까지 전파해 sweep 가능.
  t1ViaQuote?: boolean;
  // Phase 3 P1-6 (2026-04-25): continuation mode override (winner 직후 재진입).
  // 정상 PROBE 대신 더 긴 window + 낮은 T1 threshold 적용.
  continuationMode?: boolean;
  continuationT1Threshold?: number;
  continuationProbeWindowSec?: number;
  // 2026-04-26: paper shadow arm — swing-v2 손익비 정책 측정용.
  // primary 가 동일 V2 PASS 신호로 shadow 와 함께 생성. shadow 는 paper-only 강제 (DB persist X, live exec X).
  // armName 은 ledger / paper-arm-report 에서 sub-arm 분리 통계 라벨링용.
  executionMode?: 'live' | 'paper';
  paperOnlyReason?: string;
  canarySlotAcquired?: boolean;
  parameterVersion?: string;
  armName?: string;
  isShadowArm?: boolean;
  parentPositionId?: string;
  // 아래 3 필드는 swing-v2 shadow 가 원래 config 값을 override 할 때만 사용.
  // 정의되어 있으면 tickMonitor 가 우선 사용, 없으면 config.pureWs* default.
  probeWindowSecOverride?: number;
  probeHardCutPctOverride?: number;
  probeTrailingPctOverride?: number;
  t1TrailPctOverride?: number;
  t1ProfitFloorMultOverride?: number;
}
