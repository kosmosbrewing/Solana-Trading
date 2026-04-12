// 거래 파라미터 코드 관리 — git 추적, 타입 안전, 코드 리뷰
// 변경 시 반드시 PR 통해 리뷰 후 배포
// Why: .env 관리 → 오타/누락/리뷰 없는 변경 리스크 제거
//
// Label convention (REFACTORING.md P0-4):
//   code_default   — strategy 코드 또는 STRATEGY.md 기본값
//   runtime_canary — VPS 운영에서 의도적으로 변경한 canary 값 (이 파일의 현재 값)
//   operator_cap   — OPERATIONS.md에서 보수적으로 제한한 cap 값 (env override)

export const tradingParams = {
  // ─── Universe ───
  universe: {
    minPoolTVL: 50_000,
    minTokenAgeSec: 86_400,
    maxTop10HolderPct: 0.80,
    minDailyVolume: 10_000,
    minTradeCount24h: 50,
    maxSpreadPct: 0.03,
    maxWatchlistSize: 20,
    universeRefreshIntervalMs: 300_000,
  },

  // ─── Strategy A (Volume Spike) ───
  strategyA: {
    defaultTimeframe: 300,
    volumeSpikeMultiplier: 3.0,           // runtime_canary: 3.0 (code_default: 2.5)
    volumeSpikeLookback: 20,
    minBuyRatio: 0.65,
    minBreakoutScore: 50,
    exhaustionThreshold: 2,
  },

  // ─── Strategy C (Fib Pullback) ───
  strategyC: {
    fibImpulseWindowBars: 18,
    fibImpulseMinPct: 0.175,
    fibEntryLow: 0.5,
    fibEntryHigh: 0.618,
    fibInvalidation: 0.786,
    fibVolumeClimaxMultiplier: 2.5,
    fibMinWickRatio: 0.4,
    fibTimeStopMinutes: 60,
  },

  // ─── Strategy D (Sandbox) ───
  strategyD: {
    strategyDTicketSol: 0.02,
    strategyDMinAge: 3,
    strategyDMaxAge: 20,
    strategyDTpMultiplier: 3.0,
    sandboxDailyLossLimitSol: 0.5,
    sandboxMaxPositionSol: 0.05,
  },

  // ─── Order Shape (Option β 재설계 — 2026-04-10) ───
  // Why: 48h live 에서 clean expectancy -0.00108 SOL/trade 확정 → DD halt ETA ~16일.
  // 이전 v5 runner-centric 확장 (tp2=10.0, tp1 partial 30%) 는 backtest 2026-04-01 sweep 과 정합 X.
  // backtest 수렴값 (tp2=5.0 100%, tp1=1.5 mode, timeStop=20-25) 복원 + TP1 partial 제거 + ATR floor.
  // 전체 근거: docs/design-docs/strategy-redesign-2026-04-10.md
  orderShape: {
    tp1Multiplier: 1.5,                   // 1.0 → 1.5: backtest mode (2026-04-01 sweep)
    tp2Multiplier: 5.0,                   // 10.0 → 5.0: backtest 100% 수렴 (v5 주관 확장 철회)
    slAtrMultiplier: 1.25,                // 유지: runtime_canary 부합 (code_default 1.0, live_path overridden)
    timeStopMinutes: 25,                  // 20 → 25: backtest mode 상단
    tp1PartialPct: 0,                     // 0.3 → 0: TP1 partial 제거, backtest 정합 + runner thesis 순수화
    trailingAfterTp1Only: false,          // true → false: partial 제거 후 entry 직후 trailing 가능
    tp1TimeExtensionMinutes: 0,           // 30 → 0: no-op (partial removed)
  },

  // ─── Risk ───
  risk: {
    maxRiskPerTrade: 0.01,
    maxDailyLoss: 0.05,
    maxDrawdownPct: 0.30,
    recoveryPct: 0.85,
    maxConsecutiveLosses: 3,
  },

  // ─── Liquidity ───
  liquidity: {
    maxSlippage: 0.01,
    maxPoolImpact: 0.02,
    emergencyHaircut: 0.50,
    defaultAmmFeePct: 0.003,
    defaultMevMarginPct: 0.0015,
    minExitLiquidityUsd: 10_000,
    maxSellImpact: 0.03,
    sellImpactSizingThreshold: 0.015,
  },

  // ─── Execution ───
  execution: {
    maxRetries: 3,
    txTimeoutMs: 30_000,
    cooldownMinutes: 30,
    samePairOpenPositionBlock: true,
    perTokenLossCooldownLosses: 2,
    perTokenLossCooldownMinutes: 240,
    perTokenDailyTradeCap: 15,
    executionRrReject: 99.0,               // 1.2 → 99.0 (cupsey-primary): bootstrap 실거래 100% 억제. rollback: env EXECUTION_RR_REJECT=1.2
    executionRrPass: 1.5,
    executionRrBasis: 'tp2' as 'tp1' | 'tp2',
  },

  // ─── Concurrent / Position ───
  position: {
    maxConcurrentAbsolute: 3,
    maxConcurrentPositions: 2,            // runtime_canary: 2 (code_default: 1)
    maxPositionPct: 0.20,
    concurrentTier1Sol: 5,
    concurrentTier2Sol: 20,
  },

  // ─── Age Bucket ───
  ageBucket: {
    ageBucketHardFloorMin: 5,             // runtime_canary: 5 (code_default: 15)
    ageBucketTiers: [
      { upperHours: 1, multiplier: 0.25 },
      { upperHours: 4, multiplier: 0.50 },
      { upperHours: 24, multiplier: 0.75 },
    ],
  },

  // ─── Liquidity Adaptation (v4) ───
  liquidityAdaptation: {
    liquidityTier1Sol: 5,
    liquidityTier1MinPool: 100_000,
    liquidityTier2Sol: 20,
    liquidityTier2MinPool: 200_000,
    impactTier1Sol: 5,
    impactTier1MaxImpact: 0.015,
    impactTier2Sol: 20,
    impactTier2MaxImpact: 0.01,
  },

  // ─── Degraded Exit (v2) ───
  degradedExit: {
    degradedSellImpactThreshold: 0.05,
    degradedQuoteFailLimit: 3,
    degradedPartialPct: 0.25,
    degradedDelayMs: 300_000,
  },

  // ─── Scanner ───
  scanner: {
    scannerMinWatchlistScore: 30,
    scannerTrendingPollMs: 900_000,       // runtime_canary: 900K (code_default: 600K)
    scannerGeckoNewPoolMs: 60_000,
    scannerDexDiscoveryMs: 60_000,
    scannerDexEnrichMs: 300_000,
    scannerLaneAMinAgeSec: 3_600,
    scannerLaneBMaxAgeSec: 1_200,
    scannerReentryCooldownMs: 900_000,            // 30분 → 15분 (2026-04-10 W1.5): evict → 재발견 주기 단축. edge blacklist 가 loser 이중 보호
    scannerMinimumResidencyMs: 180_000,
    scannerReplacementScoreMargin: 5,
    scannerIdleEvictionMs: 1_800_000,             // 10분 → 30분 (2026-04-10 W1.5): token 이 activity 가질 시간 확보. 6h idle_evicted 99% → 목표 70% 이하
    scannerIdleEvictionSweepIntervalMs: 60_000,  // 1분 — sweep 주기
  },

  // ─── Realtime ───
  realtime: {
    realtimeReplayWarmSyncIntervalMs: 60_000,
    realtimePrimaryIntervalSec: 10,
    realtimeConfirmIntervalSec: 60,
    realtimeVolumeSurgeLookback: 20,
    realtimeVolumeSurgeMultiplier: 1.3,   // 1.8 → 1.3 (2026-04-11): signal 고갈 해소. cupsey STALK 가 noise 관리
    realtimeSparseVolumeLookback: 120,    // sparse DEX: wider window에서 non-zero candle 탐색 (120 × 10s = 20min)
    realtimeMinActiveCandles: 2,          // sparse avg 계산에 필요한 최소 non-zero candle 수 (runtime 완화: 3→2)
    realtimePriceBreakoutLookback: 20,
    realtimeConfirmMinBars: 3,
    realtimeConfirmMinChangePct: 0.02,
    realtimeCooldownSec: 300,
    realtimeOutcomeHorizonsSec: [30, 60, 180, 300],
    realtimeMaxSubscriptions: 30,
    realtimeBootstrapMinBuyRatio: 0.50,   // 0.60 → 0.50 (2026-04-11): signal 고갈 해소. STALK + PROBE 가 noise 관리
    realtimeVolumeMcapBoostThreshold: 0.005, // low-cap/high-turnover 포착 완화 (runtime zero-boost 빈도 완화)
    realtimeVolumeMcapBoostMultiplier: 1.5,
    realtimePoolDiscoveryConcurrency: 6,   // 4→6: filter 강화 후에도 burst 흡수 여유 확보
    realtimePoolDiscoveryRequestSpacingMs: 100, // 150→100: Helius dedicated RPC는 rate limit 여유 있음
    realtimePoolDiscoveryQueueLimit: 500,
    realtimeFallbackConcurrency: 3,       // runtime_canary: 3 (code_default: 2)
    realtimeFallbackRequestsPerSecond: 1, // runtime_canary: 1 (code_default: 4)
    realtimeFallbackBatchSize: 1,         // runtime_canary: 1 (code_default: 5)
    realtimeMaxFallbackQueue: 1000,
    realtimeDisableSingleTxFallbackOnBatchUnsupported: true,
    realtimeSeedAllowSingleTxFallback: false,
    realtimeSlMode: 'atr',
    realtimeSlAtrMultiplier: 1.25,        // 1.5 → 1.25 (Option β-B 2026-04-10): backtest 수렴값 직접 적용. ATR floor 0.8% 가 noise 이미 흡수, RR 4.0 유지
    realtimeSlSwingLookback: 5,
    realtimeTimeStopMinutes: 20,          // 15 → 20 (Option β 2026-04-10): backtest mode 최하단
    // 2026-04-10 Option β: 10s ATR 이 noise floor (0.3~0.5% of price) 수준일 때 absolute floor 강제.
    // TP1 / SL 이 noise 에 잡히지 않도록 effective_atr = max(raw_atr, entry_price × atrFloorPct).
    // 0.008 = 0.8% (raw noise 0.3-0.5% 위로 margin 0.3% 확보). 근거: strategy-redesign-2026-04-10.md
    atrFloorPct: 0.008,
  },

  // ─── Tick Trigger (2026-04-11, Sub-Second Architecture) ───
  // Why: 10s candle close 대기 제거 → raw swap event마다 즉시 trigger 평가.
  // 기존 bootstrap_10s와 동일한 volume/buyRatio metric, 평가 시점만 즉시로 변경.
  tickTrigger: {
    tickTriggerWindowSec: 200,                    // rolling window 전체
    tickTriggerBurstSec: 10,                      // burst 구간 (기존 candle interval 대체)
    tickTriggerVolumeSurgeMultiplier: 1.3,        // 기존 realtime과 동일
    tickTriggerMinBuyRatio: 0.50,                 // 기존 realtime과 동일
    tickTriggerCooldownSec: 300,                  // 기존 realtime과 동일
    tickTriggerSparseMinSwaps: 3,                 // burst window 내 최소 swap 수
    tickTriggerVolumeMcapBoostThreshold: 0.005,   // 기존 realtime과 동일
    tickTriggerVolumeMcapBoostMultiplier: 1.5,    // 기존 realtime과 동일
  },

  // ─── Event Context ───
  event: {
    eventPollingIntervalMs: 1_800_000,
    eventTrendingFetchLimit: 20,
    eventMinScore: 35,
    eventExpiryMinutes: 180,
    eventMinLiquidityUsd: 25_000,
    eventScoreRetentionDays: 30,
  },

  // ─── Social ───
  social: {
    socialInfluencerMinFollowers: 10_000,
  },

  // ─── Jito ───
  jito: {
    jitoTipSol: 0.001,
  },

  // ─── Paper Mode ───
  paper: {
    paperInitialBalance: 1.0,
    livePreflightMinWalletBalanceSol: 0.05,
  },

  // ─── Safety (legacy aliases — Universe에서 사용) ───
  safety: {
    minPoolLiquidity: 50_000,
    minTokenAgeHours: 24,
    maxHolderConcentration: 0.80,
  },

  // ─── Notification ───
  notification: {
    pm2AllowedProcesses: ['momentum-bot', 'momentum-ops-bot'] as string[],
  },

  // ─── Cupsey-Inspired Lane (2026-04-11, Path A) ───
  // Why: bootstrap_10s trigger 의 entry timing 이 lagging → post-entry 30-45s 판정으로 winner/loser 분류.
  // 기존 core 와 완전 격리된 sandbox lane. 근거: docs/design-docs/mission-pivot-ab-parallel-2026-04-11.md
  cupseyLane: {
    cupseyLaneTicketSol: 0.01,         // fixed micro-ticket (risk-per-trade 가 아닌 fixed)
    // STALK phase: signal 직후 즉시 매수하지 않고 pullback 대기 (spike 꼭대기 매수 방지)
    cupseyStalKWindowSec: 20,          // signal 후 pullback 대기 시간
    cupseyStalkDropPct: 0.003,         // signal price 에서 -0.3% 떨어지면 entry (pullback confirmed)
    cupseyStalkMaxDropPct: 0.015,      // -1.5% 이상 떨어지면 skip (crash, not pullback)
    // PROBE phase: 진입 후 초기 방향 판정
    cupseyProbeWindowSec: 45,          // PROBE 관찰 구간
    cupseyProbeMfeThreshold: 0.0005,   // +0.05% MFE → WINNER (0.001 → 0.0005, 더 쉽게 승격)
    cupseyProbeHardCutPct: 0.008,      // -0.8% MAE → 즉시 REJECT (0.01 → 0.008, 더 빠른 손절)
    // WINNER phase: runner 보유
    cupseyWinnerMaxHoldSec: 480,       // WINNER_MODE 최대 보유 8min (backtest grid 최적: 5m→8m 으로 runner 캡쳐)
    cupseyWinnerTrailingPct: 0.015,    // 1.5% trailing distance (0.005 → 0.015, runner 여유)
    cupseyWinnerBreakevenPct: 0.001,   // winner 진입 후 SL = entry + 0.1%
    cupseyMaxConcurrent: 3,            // 동시 cupsey 포지션 상한
  },

  // ─── KOL Wallet Tracking (2026-04-11, Path B2) ───
  kolTracking: {
    kolWalletAddresses: [] as string[], // 운영 시 env 로 override
  },

  // ─── Operator ───
  operator: {
    operatorTokenBlacklist: [] as string[],
  },
};
