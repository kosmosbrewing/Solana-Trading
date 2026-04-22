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
    maxWatchlistSize: 30,              // 20 → 30 (cupsey-primary): signal 공급 확대. 동시 감시 풀 수 +50%
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
    scannerTrendingPollMs: 300_000,       // 900K → 300K (2026-04-15): trending 발견 주기 15분→5분. 새 활성 토큰 빠른 포착
    scannerGeckoNewPoolMs: 60_000,
    scannerDexDiscoveryMs: 60_000,
    scannerDexEnrichMs: 300_000,
    scannerLaneAMinAgeSec: 3_600,
    scannerLaneBMaxAgeSec: 1_200,
    scannerReentryCooldownMs: 300_000,            // 900K → 300K (2026-04-15): 5분으로 단축. idle 퇴장 토큰 재진입 속도 향상
    scannerMinimumResidencyMs: 180_000,
    scannerReplacementScoreMargin: 5,
    scannerIdleEvictionMs: 600_000,               // 1800K → 600K (2026-04-15): 10분으로 복원. 100% 토큰이 30분 슬롯 낭비 → 빠른 순환
    scannerIdleEvictionSweepIntervalMs: 60_000,  // 1분 — sweep 주기
  },

  // ─── Realtime ───
  realtime: {
    realtimeReplayWarmSyncIntervalMs: 60_000,
    realtimePrimaryIntervalSec: 10,
    realtimeConfirmIntervalSec: 60,
    realtimeVolumeSurgeLookback: 20,
    realtimeVolumeSurgeMultiplier: 1.8,   // 1.3 → 1.8 (2026-04-14): VPS 검증 baseline 복원. 1.3은 vol_accel 중간값 1.17로 gate(1.5) 전량 차단됨
    realtimeSparseVolumeLookback: 120,    // sparse DEX: wider window에서 non-zero candle 탐색 (120 × 10s = 20min)
    realtimeMinActiveCandles: 2,          // sparse avg 계산에 필요한 최소 non-zero candle 수 (runtime 완화: 3→2)
    realtimePriceBreakoutLookback: 20,
    realtimeConfirmMinBars: 3,
    realtimeConfirmMinChangePct: 0.02,
    realtimeCooldownSec: 300,
    realtimeOutcomeHorizonsSec: [30, 60, 180, 300],
    realtimeMaxSubscriptions: 30,
    realtimeBootstrapMinBuyRatio: 0.60,   // 0.50 → 0.60 (2026-04-14): VPS 검증 baseline 복원
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
    // 2026-04-21 (QA M2): Helius WS watchdog + reconnect cooldown env 노출.
    // watchdog 이 너무 민감하면 idle watchlist 에서 reconnect 루프 발생 (14→5 감소 관측).
    // 너무 관대하면 진짜 dead WS 복구 지연. 관측 기반 튜닝 가능하도록 env 노출.
    heliusWatchdogIntervalMs: 300_000,    // 5분 (이전 default 60s 에서 완화)
    heliusReconnectCooldownMs: 300_000,   // 5분 (back-to-back reconnect 방지)
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
    cupseyStalKWindowSec: 60,          // 20 → 60 (2026-04-14): pullback 대기 창 확대. 완만한 패턴에서 7분 뒤 pullback 사례 관찰
    // 2026-04-17 variant analysis (`docs/audits/entry-timing-variants-2026-04-17.md`):
    //   0.001(-0.1%): n=145, avg_exit_720s=-0.23%, 30s flat=90%  → 음의 기대값
    //   0.005(-0.5%): n=81, avg_exit_720s=+0.47%, 30s flat=86%   → 양의 기대값 전환 지점
    //   0.010(-1.0%): n=21, avg_exit_720s=+3.28%, 30s flat=76%   → 최대 edge, 샘플 variance 큼
    // 기본값을 0.005 로 채택 (수익 전환 + 샘플 안정성). CUPSEY_STALK_DROP_PCT 환경변수로 0.010 공격 모드 전환 가능.
    cupseyStalkDropPct: 0.005,         // 0.001 → 0.005 (2026-04-17 variant analysis)
    cupseyStalkMaxDropPct: 0.015,      // -1.5% 이상 떨어지면 skip (crash, not pullback)
    // PROBE phase: 진입 후 초기 방향 판정
    cupseyProbeWindowSec: 45,          // PROBE 관찰 구간
    cupseyProbeMfeThreshold: 0.020,    // 0.0005 → 0.020 (2026-04-12 sweep 최적): +2.0% MFE → WINNER. 노이즈 승격 방지, 진짜 모멘텀만 통과
    cupseyProbeHardCutPct: 0.008,      // -0.8% MAE → 즉시 REJECT (0.01 → 0.008, 더 빠른 손절)
    // WINNER phase: runner 보유
    cupseyWinnerMaxHoldSec: 720,       // 480 → 720 (2026-04-12 sweep 최적): 12min 최대 보유. runner 캡처 시간 확대
    cupseyWinnerTrailingPct: 0.040,    // 0.015 → 0.040 (2026-04-12 sweep 최적): 4.0% trailing distance. runner 에 충분한 여유
    cupseyWinnerBreakevenPct: 0.005,   // 0.001 → 0.005 (2026-04-12 sweep 최적): winner SL = entry + 0.5%. noise whipsaw 방어 강화
    cupseyMaxConcurrent: 5,            // 3 → 5 (cupsey-primary): signal 유실 감소. 0.05 SOL 최대 lock
    // 2026-04-17 peak sanity guard (HWM axis oxidation 방어)
    // Why: realtimeCandleBuilder ±50% sanity bound 가 신규 pool 첫 tick + ingestClosedCandle 경로를
    // 커버 못 함 → 오염된 price가 pos.peakPrice / DB high_water_mark 에 영구 고착 → WINNER 판정 / trailing
    // 전체 오염 (VPS 2026-04-17 실측: WINNER_TIME_STOP 11/11 HWM=+500% 허수).
    // entry 대비 이 배율 초과 peak은 spurious spike로 간주하고 업데이트 skip.
    // 15x = Cupsey winner 프로필(+500~700%)의 2-3x 여유. 100x 밈코인 outlier는 env 로 override.
    cupseyMaxPeakMultiplier: 15,
  },

  // ─── Cupsey Signal Quality Gate (2026-04-12) ───
  // Why: bootstrap trigger 가 volume spike peak 에서 발화 → lagging entry timing.
  // multi-bar momentum 사전 검증으로 단일-bar noise signal 필터.
  // 좋은 signal = 수 바 동안 지속된 volume + 상승 가격. 나쁜 signal = 단일 바 flush.
  cupseyGate: {
    cupseyGateEnabled: true,
    cupseyGateMinVolumeAccelRatio: 1.2,   // 1.5 → 1.2 (2026-04-16): 측정 우선 전략. 48h reject 66% 해소. 추가 trade 절대 비용 < 0.01 SOL (0.01 티켓 기준)
    cupseyGateMinPriceChangePct: 0.000,   // 0.001 → 0.000 (2026-04-16): cupsey STALK은 pullback 진입 — 가격 하락 중인 신호가 오히려 적합
    cupseyGateMinAvgBuyRatio: 0.50,       // 0.55 → 0.50 (2026-04-16): BORAHAEM 0.535 사례 포착. buy pressure 최소 기준만 유지
    cupseyGateMinTradeCountRatio: 1.0,    // 1.5 → 1.0 (2026-04-14): trade_count가 2번째 bottleneck. vol_accel+buy_ratio가 이미 organic 검증
    cupseyGateLookbackBars: 20,           // baseline window
    cupseyGateRecentBars: 3,              // recent momentum window
  },

  // ─── CUSUM Volume Regime Change Detector (2026-04-14) ───
  // Why: bootstrap trigger 는 spike peak 에서 발화 → CUSUM 은 mean shift 를 조기 감지.
  // Phase 0: observation-only (gate log 에 strength 기록만). Phase 1 에서 gate factor 편입 결정.
  cusumDetector: {
    cusumKMultiplier: 0.3,      // allowance = k × σ. 작을수록 민감
    cusumHMultiplier: 4.0,      // threshold = h × σ. 클수록 신중
    cusumWarmupPeriods: 10,     // mean/std 안정화에 필요한 최소 캔들 수
  },

  // ─── KOL Wallet Tracking (2026-04-11, Path B2) ───
  kolTracking: {
    kolWalletAddresses: [] as string[], // 운영 시 env 로 override
  },

  // ─── Operator ───
  operator: {
    operatorTokenBlacklist: [] as string[],
  },

  // ─── Migration Handoff Reclaim Lane (2026-04-17, Tier 1) ───
  // Why: Pump.fun graduation / PumpSwap canonical pool / Raydium LaunchLab 이벤트 직후
  // first overshoot 통과 → reclaim pullback 진입. cupsey와 독립 lane.
  // 설계: docs/design-docs/migration-handoff-reclaim-2026-04-17.md
  // ─── Pure WS Breakout Lane (Block 3, 2026-04-18) ───
  // Why: Mission pivot convexity — cupsey benchmark 는 그대로 유지하고 loose-gate + tiered runner 로
  // 별도 lane 운영. 설계 근거: docs/design-docs/pure-ws-breakout-lane-2026-04-18.md
  pureWsLane: {
    pureWsLaneTicketSol: 0.01,              // fixed micro-ticket (risk 대비 절대 ticket)
    pureWsMaxConcurrent: 3,                 // canary 동시 max 3
    pureWsProbeWindowSec: 30,               // immediate PROBE 관찰 창
    pureWsProbeHardCutPct: 0.03,            // MAE -3% → 즉시 loser cut
    pureWsProbeFlatBandPct: 0.10,           // ±10% 이내 = flat, 30s flat 시 close
    pureWsProbeTrailingPct: 0.03,           // PROBE trail 3%
    // tiered runner
    pureWsT1MfeThreshold: 1.0,              // +100% (2x) → T1 승격
    pureWsT1TrailingPct: 0.07,              // T1 trail 7%
    pureWsT2MfeThreshold: 4.0,              // +400% (5x) → T2 승격
    pureWsT2TrailingPct: 0.15,              // T2 trail 15%
    pureWsT2BreakevenLockMultiplier: 3.0,   // T2 진입 시 entry × 3 lock (never close below 3x)
    pureWsT3MfeThreshold: 9.0,              // +900% (10x) → T3 승격
    pureWsT3TrailingPct: 0.25,              // T3 trail 25%, no time stop
    pureWsMaxPeakMultiplier: 15,            // HWM sanity (Patch B2 동일 철학)
    pureWsSourceLabel: 'pure_ws_breakout',
  },

  // ─── Pure WS Breakout Gate (Block 3, looser than cupsey) ───
  pureWsGate: {
    pureWsGateEnabled: true,
    pureWsGateLookbackBars: 13,             // cupsey 와 동일 구조
    pureWsGateRecentBars: 3,
    pureWsGateMinVolumeAccelRatio: 1.0,     // cupsey 1.2 → 1.0
    pureWsGateMinPriceChangePct: -0.005,    // cupsey 0 → -0.005 (하락 중 reclaim 허용)
    pureWsGateMinAvgBuyRatio: 0.45,         // cupsey 0.50 → 0.45
    pureWsGateMinTradeCountRatio: 0.8,      // cupsey 1.0 → 0.8
  },

  migrationLane: {
    migrationLaneTicketSol: 0.01,           // hard guardrail (override 조건)
    migrationMaxConcurrent: 1,              // Phase 2 초기 — 관측 우선
    migrationMaxAgeSec: 900,                // 15min 이후 edge expired
    // COOLDOWN: graduation 직후 first overshoot 대기
    migrationCooldownSec: 90,
    // STALK: reclaim pullback 대기
    migrationStalkWindowSec: 180,           // 3min pullback 관측창
    migrationStalkMinPullbackPct: 0.10,     // -10% pullback 최소
    migrationStalkMaxPullbackPct: 0.30,     // -30% 초과 = rug suspect
    migrationReclaimBuyRatioMin: 0.55,      // reclaim candle 에서 매수 우세 확인
    // PROBE: cupsey와 동일한 window/cut 재사용 (검증된 파라미터)
    migrationProbeWindowSec: 45,
    migrationProbeHardCutPct: 0.008,
    migrationProbeMfeThreshold: 0.020,
    // WINNER
    migrationWinnerMaxHoldSec: 720,
    migrationWinnerTrailingPct: 0.040,
    migrationSourceLabel: 'migration_reclaim',
  },
};
