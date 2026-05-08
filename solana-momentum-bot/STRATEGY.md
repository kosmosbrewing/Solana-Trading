# STRATEGY.md (post-pivot)

> Status: current quick reference
> Updated: 2026-05-07
> Purpose: 현재 runtime 에서 읽어야 할 전략 / gate / risk / 핵심 파라미터를 짧게 정리한다.
> Pivot decision: [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md)
> Current lane refactor: [`docs/design-docs/lane-operating-refactor-2026-05-03.md`](./docs/design-docs/lane-operating-refactor-2026-05-03.md)
> Pre-pivot snapshot: [`docs/historical/pre-pivot-2026-04-18/STRATEGY.md`](./docs/historical/pre-pivot-2026-04-18/STRATEGY.md)
> Forward memo: [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md)

## Role

이 문서는 quick reference 다.

- 현재 구현 / 운영 기준만 짧게 담는다
- 전략의 구조적 한계나 다음 방향 메모는 [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md) 로 분리한다
- pivot 상세 근거는 [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md)

## Core Principle (post-pivot)

> 수단과 방법을 가리지 않고 `1 SOL -> 100 SOL` 달성 확률을 최대화한다.
> "왜 오르는가"보다 "지금 실제로 폭발하는가"를 본다.

## Runtime Lane Set (2026-05-03 갱신)

| Lane / arm | 상태 | 역할 |
|---|---|---|
| **`cupsey_flip_10s`** | **benchmark (frozen, env disabled)** | A/B 비교 기준선. **개조 금지.** |
| `bootstrap_10s` | **signal-only** | cupsey/pure_ws trigger source. `executionRrReject=99.0` 로 실거래 100% 억제. |
| **`kol_hunter_smart_v3`** | **main 5x lane / live canary with strict paper fallback** | Fresh active 2+ KOL velocity 중심. A+A 허용, S+B/A+B 는 fresh S/A strength rule 미통과. Pullback-only / weak post-sell recovery / unclean quality / repeated losing KOL combo / adverse KOL-fill price 는 paper fallback. Pre-T1 dead probe 는 MAE fast-fail, 살아난 probe 는 bounded recovery-hold. |
| ↳ `kol_hunter` swing-v2 | paper shadow (`KOL_HUNTER_SWING_V2_ENABLED`) | multi-KOL S/A ≥2 + score ≥5.0 자격 시 동시 생성. 600s stalk / 25% trail / 1.10 floor. |
| **`kol_hunter_rotation_v1`** | **fast-compound auxiliary / canonical live off; underfill canary only** | T+15/T+30 post-cost harvesting 실험. Control + `rotation_fast15_v1` / `rotation_cost_guard_v1` / `rotation_quality_strict_v1` / `rotation_underfill_v1` / `rotation_chase_topup_v1`. Canonical live와 chase-topup live는 닫고, S/A KOL fill보다 유리한 `rotation_underfill_v1`만 별도 live canary 키로 연다. |
| **`pure_ws botflow`** | **paper/observe-only rebuild candidate** | New-pair / botflow microstructure 관측. Mayhem copy 금지. T+15/30/60/180/300/1800 markout + 15분 digest + paper arms. |
| `migration_reclaim` | signal-only (env) | Migration Handoff Reclaim. paper 대기. |
| `volume_spike` / `fib_pullback` / `core_momentum` | **dormant** | 5m 해상도, 밈코인 비적합 |
| ~~`new_lp_sniper` (Strategy D)~~ | **retired (2026-04-26 cleanup)** | Birdeye WS + sandbox executor 영구 제거 |

### Lane Ledger Layout (2026-05-03)

KOL aggregate ledgers remain the compatibility source:

```text
data/realtime/kol-paper-trades.jsonl
data/realtime/kol-live-trades.jsonl
```

Lane projections are added for operator analysis:

```text
data/realtime/smart-v3-paper-trades.jsonl
data/realtime/smart-v3-live-trades.jsonl
data/realtime/rotation-v1-paper-trades.jsonl
data/realtime/rotation-v1-live-trades.jsonl
data/realtime/pure-ws-paper-trades.jsonl
data/realtime/pure-ws-live-trades.jsonl
```

Shared markout files remain unsplit:

```text
data/realtime/trade-markout-anchors.jsonl
data/realtime/trade-markouts.jsonl
```

Smart-v3 evidence report:

```bash
npm run kol:smart-v3-evidence-report -- --since 24h --realtime-dir data/realtime
```

- Report-only; no live entry, exit, ticket, or guard behavior changes.
- Verdict T+ coverage is close-anchor based by `positionId × anchorType × horizon`, not just observed-row ok-rate.
- Closed Trades uses copyable/wallet-first W/L and shows token-only W/L separately.
- Closed Trades also shows MAE fast-fail, recovery-hold, MFE floor-exit/stage counts, and pre-T1 MFE band counts (`10-20`, `20-30`, `30-50`).
- It also summarizes paper rows that would have been live-blocked, including `smartV3LiveBlockReason` and `smartV3LiveBlockFlags`.
- Runtime `.env` override is not required for the 2026-05-06 MAE or 2026-05-07 live-quality fallback changes; defaults are active. `SKIP_SMART_V3_EVIDENCE_REPORT` and `SMART_V3_EVIDENCE_ROUND_TRIP_COST_PCT` are sync/report-only shell knobs.

Smart-v3 probe exit refinement (2026-05-06):

```text
MAE fast-fail:
  pre-T1 only
  elapsed >= 5s
  market/reference MFE < +3%
  token-only MAE <= -6%
  no fresh participating KOL buy within 15s
  close reason = smart_v3_mae_fast_fail

MAE recovery hold:
  pre-T1 only
  market/reference MFE >= +10%
  token-only MAE > -18%
  no participating KOL sell after entry
  one bounded 12s hold before generic hard cut

Pre-T1 telemetry:
  smartV3PreT1MfeBand = 10_20 / 20_30 / 30_50
  smartV3PreT1ClosePct
  smartV3PreT1GivebackPct
  smartV3PreT1WouldLockBreakeven
```

Default knobs:

```text
KOL_HUNTER_SMART_V3_MAE_FAST_FAIL_ENABLED=true
KOL_HUNTER_SMART_V3_MAE_FAST_FAIL_MIN_ELAPSED_SEC=5
KOL_HUNTER_SMART_V3_MAE_FAST_FAIL_MAX_MFE_PCT=0.03
KOL_HUNTER_SMART_V3_MAE_FAST_FAIL_MAX_MAE_PCT=0.06
KOL_HUNTER_SMART_V3_MAE_FAST_FAIL_FRESH_BUY_GRACE_SEC=15
KOL_HUNTER_SMART_V3_MAE_RECOVERY_HOLD_ENABLED=true
KOL_HUNTER_SMART_V3_MAE_RECOVERY_MIN_MFE_PCT=0.10
KOL_HUNTER_SMART_V3_MAE_RECOVERY_MAX_MAE_PCT=0.18
KOL_HUNTER_SMART_V3_MAE_RECOVERY_HOLD_SEC=12
```

### MFE Winner Preservation

Smart-v3 exit tuning is not trying to force a higher close win-rate. It raises the stop to breakeven/profit floors once a position has already shown MFE, so it does not round-trip into an ordinary loss.

Default stages:

```text
MFE >= +10%   -> breakeven_watch, floor +0.5%
MFE >= +20%   -> profit_lock,     floor +2.0%
MFE >= +50%   -> runner,          floor +10.0%
MFE >= +100%  -> convexity,       floor +20.0%
```

If current price crosses below the active token-only floor, smart-v3 exits immediately as `smart_v3_mfe_floor_exit` and logs `KOL_HUNTER_SMART_V3_MFE_FLOOR_EXIT`. This is a stop trigger, not a close blocker. Structural/liquidity/insider safety exits still remain highest priority.

```bash
KOL_HUNTER_SMART_V3_MFE_FLOOR_ENABLED=true
KOL_HUNTER_SMART_V3_MFE_BREAKEVEN_THRESHOLD_PCT=0.10
KOL_HUNTER_SMART_V3_MFE_PROFIT_LOCK_THRESHOLD_PCT=0.20
KOL_HUNTER_SMART_V3_MFE_RUNNER_THRESHOLD_PCT=0.50
KOL_HUNTER_SMART_V3_MFE_CONVEXITY_THRESHOLD_PCT=1.00
KOL_HUNTER_SMART_V3_MFE_BREAKEVEN_FLOOR_PCT=0.005
KOL_HUNTER_SMART_V3_MFE_PROFIT_LOCK_FLOOR_PCT=0.02
KOL_HUNTER_SMART_V3_MFE_RUNNER_FLOOR_PCT=0.10
KOL_HUNTER_SMART_V3_MFE_CONVEXITY_FLOOR_PCT=0.20
```

Smart-v3 live entry hardening (2026-05-07):

```text
Strict quality fallback:
  EXIT_LIQUIDITY_UNKNOWN / TOKEN_QUALITY_UNKNOWN / UNCLEAN_TOKEN*
  holder-risk / no-route / rug-like flags
  live fallback = SMART_V3_LIVE_QUALITY_FALLBACK

Pre-entry sell fallback:
  same-mint KOL sell before entry requires enough fresh independent re-buy
  and a clean no-sell window
  live fallback = SMART_V3_PRE_ENTRY_SELL_LIVE_DISABLED
  or SMART_V3_RECENT_SELL_NO_SELL_WINDOW

Combo decay:
  repeated losing fresh KOL combinations fallback to paper temporarily.
  The combo key is fixed at entry-time fresh KOLs, not later reinforcement KOLs.
  Primary paper and live closes both feed the decay memory; live losses can block
  with fewer samples. Shadow arms are excluded.
  live fallback = SMART_V3_COMBO_DECAY

KOL fill-price advantage:
  if our quote is materially above fresh KOL weighted fill price,
  live fallback = SMART_V3_ENTRY_ADVANTAGE_ADVERSE
```

Default knobs:

```text
KOL_HUNTER_SMART_V3_LIVE_STRICT_QUALITY_ENABLED=true
KOL_HUNTER_SMART_V3_LIVE_BLOCK_EXIT_LIQUIDITY_UNKNOWN=true
KOL_HUNTER_SMART_V3_LIVE_BLOCK_TOKEN_QUALITY_UNKNOWN=true
KOL_HUNTER_SMART_V3_LIVE_BLOCK_UNCLEAN_TOKEN=true
KOL_HUNTER_SMART_V3_PRE_ENTRY_SELL_LIVE_BLOCK_ENABLED=true
KOL_HUNTER_SMART_V3_PRE_ENTRY_SELL_MIN_NO_SELL_SEC=60
KOL_HUNTER_SMART_V3_COMBO_DECAY_ENABLED=true
KOL_HUNTER_SMART_V3_COMBO_DECAY_COOLDOWN_MS=21600000
KOL_HUNTER_SMART_V3_COMBO_DECAY_MIN_CLOSES=2
KOL_HUNTER_SMART_V3_COMBO_DECAY_LOSS_RATIO=1.0
KOL_HUNTER_SMART_V3_KOL_FILL_ADVANTAGE_ENABLED=true
KOL_HUNTER_SMART_V3_MAX_ADVERSE_KOL_FILL_PCT=0.03
```

Rotation live canary operating rule (2026-05-08):

```text
KOL_HUNTER_ROTATION_V1_ENABLED=true
KOL_HUNTER_ROTATION_V1_LIVE_ENABLED=false

# demoted to paper after live/paper divergence
KOL_HUNTER_ROTATION_CHASE_TOPUP_LIVE_CANARY_ENABLED=false
KOL_HUNTER_ROTATION_CHASE_TOPUP_PARAMETER_VERSION=rotation-chase-topup-v1.0.0
KOL_HUNTER_ROTATION_CHASE_TOPUP_PAPER_ENABLED=true
KOL_HUNTER_ROTATION_CHASE_TOPUP_MIN_BUYS=2
KOL_HUNTER_ROTATION_CHASE_TOPUP_MIN_TOPUP_STRENGTH=0.08
KOL_HUNTER_ROTATION_CHASE_TOPUP_MAX_RECENT_SELL_SEC=60

# single promoted arm only
KOL_HUNTER_ROTATION_UNDERFILL_PAPER_ENABLED=true
KOL_HUNTER_ROTATION_UNDERFILL_LIVE_CANARY_ENABLED=true
KOL_HUNTER_ROTATION_UNDERFILL_LIVE_EXIT_FLOW_ENABLED=true
KOL_HUNTER_ROTATION_UNDERFILL_LIVE_STRICT_QUALITY_ENABLED=true
```

`KOL_HUNTER_ROTATION_V1_LIVE_ENABLED=true` opens the broader canonical rotation-v1 live path and is not the current operating intent.

Deployment/env note:

- Secret-bearing runtime `.env` remains gitignored.
- Non-secret live/paper toggles are tracked in `ops/env/production.env`.
- `scripts/deploy.sh` merges that profile into runtime `.env` during deploy, then restarts `momentum-bot`.
- `scripts/deploy-remote.sh` first refreshes the remote repo, so profile merge changes are available before the remote deploy script runs.

## Cupsey Benchmark Lane (개조 금지)

`cupsey_flip_10s` 는 현재 유일한 live-proven lane 이며 benchmark 로 유지한다.
pivot 이후에도 파라미터 / 구조 변경 없이 운영한다. 새 lane 의 wallet 성과를 여기 대비로 평가한다.

### 현재 파라미터 (변경 금지)

```text
Ticket            = 0.01 SOL fixed
STALK window      = 60s  (pullback entry 대기)
STALK drop        = -0.5% (cupseyStalkDropPct = 0.005)
STALK max drop    = -1.5% (crash skip)
PROBE window      = 45s
PROBE → WINNER    : MFE ≥ +2.0%
PROBE → REJECT    : MAE ≤ -0.8% OR 45s timeout
WINNER trailing   = 4.0%
WINNER max hold   = 12min (720s)
WINNER breakeven  = entry + 0.5% (MFE > +4% 일 때 활성)
HWM peak sanity   = entry × 15 (cupseyMaxPeakMultiplier)
Max concurrent    = 5
```

### Cupsey Signal Quality Gate

참고: 이 gate 는 **attention gate 가 아니다**. multi-bar momentum 지속성 (volume accel + price momentum + buy ratio + trade count) 검증 gate 다.

```text
Volume Acceleration   ≥ 1.2x
Price Momentum        ≥ 0%
Buy Ratio Consistency ≥ 0.50
Trade Count Density   ≥ 1.0x
```

cupsey benchmark 유지 방침에 따라 이 threshold 역시 변경 금지.
새 lane 에서는 같은 factor set 을 재사용하되, threshold 만 사명에 맞춰 재조정.

## DEX_TRADE Phase 3 — Quick Reject + Hold Sentinel + Ruin Sim (2026-04-18)

> Legacy appendix. This section preserves the 2026-04-18 pure_ws/cupsey DEX_TRADE work for reference. Current runtime lane policy is the Runtime Lane Set above plus `docs/design-docs/lane-operating-refactor-2026-05-03.md`; do not use the old `pure_ws_breakout` promotion text below as live policy.

### Quick Reject Classifier ([src/risk/quickRejectClassifier.ts](./src/risk/quickRejectClassifier.ts))

PROBE 구간 내 price-only cut 보완. MFE decay + buy ratio drop + tx density drop 조합 판정.

- `action = 'exit'`: 2+ factors degraded → 즉시 close (`REJECT_TIMEOUT`)
- `action = 'reduce'`: 1 factor + weak MFE → warn log만 (partial exit 는 Phase 4 후보)
- `action = 'hold'`: 정상

Env: `QUICK_REJECT_CLASSIFIER_ENABLED=true`, `QUICK_REJECT_WINDOW_SEC=45`, `QUICK_REJECT_MIN_MFE_PCT=0.005`, `QUICK_REJECT_BUY_RATIO_DECAY=0.15`, `QUICK_REJECT_TX_DENSITY_DROP=0.5`, `QUICK_REJECT_DEGRADE_COUNT_FOR_EXIT=2`.

### Hold-Phase Exitability Sentinel ([src/risk/holdPhaseSentinel.ts](./src/risk/holdPhaseSentinel.ts))

RUNNER T1/T2/T3 보유 중 microstructure 악화 감지 → `DEGRADED_EXIT` 로 조기 전환.

- 3 factor: buy pressure collapse / tx density drop / peak drift
- 2+ factors → `degraded` status → close. 1 factor → warn.

Env: `HOLD_PHASE_SENTINEL_ENABLED=true`, `HOLD_PHASE_BUY_RATIO_COLLAPSE=0.2`, `HOLD_PHASE_TX_DENSITY_DROP=0.6`, `HOLD_PHASE_PEAK_DRIFT=0.35`, `HOLD_PHASE_DEGRADED_FACTOR_COUNT=2`.

### Ruin Probability ([scripts/ruinProbability.ts](./scripts/ruinProbability.ts))

FIFO paired PnL 분포 → **block bootstrap** monte carlo. 승격 판정 기준 `< 5%` (DEX_TRADE Section 11).

```bash
npm run ops:ruin:simulate -- --start-sol 1.07 --ruin-threshold 0.3 \
  --runs 10000 --trades-per-run 200 --strategy pure_ws_breakout \
  --md docs/audits/ruin-sim-<date>.md
```

출력: ruin probability / median ending wallet / p5·p95 / max drawdown p95.

### Max Probes Today (extension to [dailyBleedBudget.ts](./src/risk/dailyBleedBudget.ts))

```ts
maxProbesToday(expectedBleedPerProbe, walletBaseline, cfg)
= floor(remainingBudget / expectedBleedPerProbe)
```

현재는 reporting/script 용도. Runtime 통합은 Phase 4 후보.

## DEX_TRADE Phase 2 — Probe Viability Floor + Daily Bleed Budget (2026-04-18)

**Status**: 구현 완료. handler 에 통합 (PROBE 직전 체크).

### Probe Viability Floor ([src/gate/probeViabilityFloor.ts](./src/gate/probeViabilityFloor.ts))

RR gate 를 retire 하고 **최소 viability** 만 유지하는 fail-closed floor.

Check 순서:
1. ticket >= `PROBE_VIABILITY_MIN_TICKET_SOL` (default 0.005 SOL)
2. estimated round-trip bleed pct <= `PROBE_VIABILITY_MAX_BLEED_PCT` (default 6%)
3. `dailyBleedBudget.remainingBudget() > 0` + >= estimated bleed
4. (optional) sell impact <= `PROBE_VIABILITY_MAX_SELL_IMPACT_PCT` (default 0 = disabled)

Env: `PROBE_VIABILITY_FLOOR_ENABLED=true` (default on), 위 threshold env 전부 override 가능.

### Venue-Specific Bleed Model ([src/execution/bleedModel.ts](./src/execution/bleedModel.ts))

```
bleed_total = base_fee + priority_fee + tip + venue_fee
            + entry_slippage + quick_exit_slippage
```

| Venue | Per-side fee | 비고 |
|---|---:|---|
| raydium | 0.25% | V4/CLMM/CPMM 평균 |
| pumpswap | 1.0% | canonical pool (graduated pump.fun) |
| meteora | 0.3% | DLMM/DAMM 평균 |
| orca | 0.3% | Whirlpool |
| unknown | 0.5% | conservative fallback |

기본 priority fee: `0.0001 SOL/tx` (실 운영 관측 기반). Phase 2 초기 integration 은 venue=undefined → unknown fallback.

### Daily Bleed Budget ([src/risk/dailyBleedBudget.ts](./src/risk/dailyBleedBudget.ts))

```
daily_cap = max(alpha × wallet_baseline, min_cap)
```

Env:
- `DAILY_BLEED_BUDGET_ENABLED=true`
- `DAILY_BLEED_ALPHA=0.05` (wallet 5%)
- `DAILY_BLEED_MIN_CAP_SOL=0.05`
- `DAILY_BLEED_MAX_CAP_SOL=0` (0 = unlimited)

Wallet baseline: `walletStopGuard.getWalletStopGuardState().lastBalanceSol` (30s 주기 갱신). Close 마다 loss 누적 → remaining < expected bleed 이면 entry halt.

## Pure WS Breakout V2 Detector (DEX_TRADE Phase 1.1, 2026-04-18)

**Status**: pure function 구현 완료. Handler wiring 은 Phase 1.3 (flag 전환). 설계: [`docs/design-docs/pure-ws-breakout-v2-detector-2026-04-18.md`](./docs/design-docs/pure-ws-breakout-v2-detector-2026-04-18.md)

`burst_score = Σ w_i × f_i` (0-100 weighted, 각 factor [0,1] 정규화).

| Factor | Weight | Normalization |
|---|---:|---|
| volume_accel_z | 30 | recent 30s vs baseline 120s, z / 3.0 saturate |
| buy_pressure_z | 25 | buy ratio z / 2.0 saturate + 절대 0.55 floor |
| tx_density_z | 20 | MAD-robust z / 3.0 saturate + 절대 3 tx floor |
| price_accel | 20 | bps / 300 saturate + 30 bps floor |
| reverse_quote_stability | 5 | Phase 1 placeholder 1.0, Phase 2 에서 Jupiter reverse quote 통합 |

Pass 조건: 모든 floor 통과 + weighted score ≥ 60 (tunable).

Env overrides: `PUREWS_V2_ENABLED` (default false), `PUREWS_V2_MIN_PASS_SCORE`, `PUREWS_V2_FLOOR_*`, `PUREWS_V2_W_*`, `PUREWS_V2_N_RECENT`, `PUREWS_V2_N_BASELINE`.

Phase 1.2 대기: paper replay 로 weight/threshold tuning → `docs/audits/ws-burst-detector-calibration-<date>.md` 기록.

## Pure WS Breakout Lane (Block 3, 2026-04-18 구현 완료, paper-first)

Convexity 사명 첫 구현 lane. 설계: [`docs/design-docs/pure-ws-breakout-lane-2026-04-18.md`](./docs/design-docs/pure-ws-breakout-lane-2026-04-18.md)

### 상태기계

```text
[signal] → loose gate → immediate PROBE (NO STALK)
[PROBE] 30s  MAE≤-3% → LOSER_HARDCUT | flat → LOSER_TIMEOUT | trail 3% → close | MFE≥+100% → T1
[T1] trail 7%  |  MFE≥+400% → T2 (set lock=entry×3)
[T2] trail max(15%, lock)  |  MFE≥+900% → T3  |  절대 3x 미만 close 금지
[T3] trail 25%, no time stop (runner)
```

### 파라미터 (canary 기본)

```text
Ticket                 = 0.01 SOL
Max concurrent         = 3
PROBE window           = 30s
PROBE hardcut          = MAE ≤ -3%
PROBE flat band        = ±10% (window 만료 + flat → close)
PROBE trail            = 3%
T1 MFE threshold       = +100% (2x)
T1 trail               = 7%
T2 MFE threshold       = +400% (5x)
T2 trail               = 15%
T2 breakeven lock      = entry × 3 (T2 도달 시 영구 lock)
T3 MFE threshold       = +900% (10x)
T3 trail               = 25% (no time stop)
HWM peak sanity        = entry × 15 (cupsey Patch B2 동일)
```

### Gate (cupseyGate factor 재사용, threshold 완화)

```text
vol_accel   ≥ 1.0   (cupsey 1.2)
price_chg   ≥ -0.5% (cupsey 0)
buy_ratio   ≥ 0.45  (cupsey 0.50)
trade_count ≥ 0.8   (cupsey 1.0)
env overrides: PUREWS_GATE_* / PUREWS_LANE_TICKET_SOL / PUREWS_MAX_CONCURRENT / PUREWS_PROBE_HARD_CUT_PCT
```

### Wallet mode

- `PUREWS_WALLET_MODE=auto|main|sandbox` (default `auto`)
- `sandbox` 명시 시 `SANDBOX_WALLET_PRIVATE_KEY` 필수 (startup throw if missing)
- 기본 상태: `PUREWS_LANE_ENABLED=false` (paper-first, 운영자 opt-in 필요)

### 운영 방침

- **Phase 3.1** Paper: `PUREWS_LANE_ENABLED=true` + `TRADING_MODE=paper`, 20-50 trade 관측
- **Phase 3.2** Live canary: paper 20+ trade + 가드레일 무사고 확인 후 진입 (여전히 ticket 0.01 × max 3)
- **Phase 3.3** 승격 판정: wallet delta cupsey 대비 positive + 50 trade 달성 → primary 승격 후보

### Shared Guardrails (Block 1/2 공유, 불변)

- Wallet Stop Guard `< 0.7 SOL` halt
- Wallet delta comparator halt (Block 1)
- `entryIntegrity('pure_ws_breakout')` halt
- Close mutex (`swapSerializer`)
- Security hard reject
- HWM peak sanity (15x)

## Bootstrap Signal Source

`bootstrap_10s` 는 signal-only 로 유지한다.

```text
Primary interval : 10s
Volume lookback  : 20
Volume multiplier: 1.8
Min buy ratio    : 0.60
Cooldown         : 300s
executionRrReject: 99.0  (실거래 100% 억제)
```

### 사용 방식

- cupsey lane 의 trigger source
- pure_ws_breakout lane 도 bootstrap signal 을 소비할지 여부는 Block 3 설계에서 결정

### Rollback

실거래 재개 필요 시: `EXECUTION_RR_REJECT=1.2` → pm2 restart.

## Dormant Strategies

### `volume_spike` (dormant)

- 5m 해상도 + breakout 기반
- 4 sessions × 87 pairs × 3 strategies 중 단 3건 trade → 밈코인 비적합 (2026-04-05 확인)
- CEX/DEX 대형 토큰 전환 시에만 재활성화 고려

### `fib_pullback` (dormant)

- 5m 해상도 + pullback 확인형
- 밈코인 비적합. `volume_spike` 와 같은 사유.

### `core_momentum` (standby)

- 3-AND trigger (volume surge + breakout + confirm)
- 검증 후 사용

## Gate Chain (post-pivot)

```text
Gate 0  Security (hard)
Gate 1  Liquidity / Quote Sanity (hard)
Gate 2  Exitability (hard)
Gate 3  Lane-specific signal filter
        - cupsey: cupseyGate (변경 금지)
        - pure_ws_breakout: 설계 시 확정
        - bootstrap: vol + buyRatio
Gate 4  Integrity (persistOpenTradeWithIntegrity)
Close   Sell-side impact
```

### Retired Gates

- `Attention / Context` gate (hard reject 로 사용 금지)
- `Execution Viability` RR gate 기반 hard reject (bootstrap 억제용 env 는 유지)

## Risk And Exit

### Canary Risk (post-pivot)

| 항목 | 값 |
|---|---|
| Ticket | `0.01 SOL` fixed |
| Max concurrent | `3` ticket (canary) |
| Wallet Stop Guard | `< 0.7 SOL` lane halt |
| RPC fail-safe | 연속 RPC 실패 시 lane halt |
| Per-trade loss floor | lane 별 설계 시 확정 |

### Exit Guards (benchmark cupsey 유지)

- PROBE hard cut (MAE ≤ -0.8%)
- WINNER trailing / breakeven / max hold
- Sell-side impact exit
- Decision price tracking

새 lane 의 exit 구조는 Block 3 설계에서 별도 정의.

## Block 4 Canary Guardrails (2026-04-18)

Block 3 canary 단계 per-lane circuit breaker + A/B 평가.

| 변수 | 기본값 | 역할 |
|---|---|---|
| `CANARY_AUTO_HALT_ENABLED` | `true` | per-lane 자동 halt on/off |
| `CANARY_MAX_CONSEC_LOSERS` | `5` | 연속 loser 회차 임계 |
| `CANARY_MAX_BUDGET_SOL` | `0.5` | 누적 손실 임계 (SOL) |
| `CANARY_MAX_TRADES` | `100` | canary window 최대 trade 수 |
| `CANARY_MIN_LOSS_TO_COUNT_SOL` | `0` | flat close 를 loser로 세지 않는 임계 |

Halt 발동 시: 해당 lane 에 `entryIntegrity.triggerEntryHalt` — 다른 lane entry 는 영향 없음. 운영자 `resetEntryHalt(lane)` 수동 해제 필요 (자동 복구 없음 — false unblock 보다 false halt 가 안전).

### A/B 평가 도구

```bash
npm run ops:canary:eval [-- --since ISO8601] [--json out.json] [--md out.md]
```

cupsey_flip_10s (benchmark) vs pure_ws_breakout (candidate) — executed-buys/sells ledger FIFO pair matching + winner distribution + promotion verdict (`PROMOTE`/`CONTINUE`/`DEMOTE`).

## Block 2 Coverage Expansion (2026-04-18)

### DEX ID Alias Normalization

Layer 3 병목 (`unsupported_dex=77.8%`) 대응 — DexScreener 태그 변형을 모두 canonical 로 normalize.

| Canonical | 허용 alias |
|---|---|
| `pumpswap` | `pumpswap`, `pumpfun`, `pump-swap`, `pump.fun`, `pump_swap`, `pumpdotfun`, `pumpswap-amm`, `pumpfun-amm`, `pump` |
| `meteora` | `meteora`, `meteora-dlmm`, `meteora-damm`, `meteora-damm-v1`/`-v2`, `meteoradbc`, `meteora-dbc`, `meteora_*`, `meteora-dynamic`, `dlmm`, `damm`, `damm-v1`/`-v2`, `damm_v1`/`_v2` |
| `raydium` | `raydium`, `raydium-v4`, `raydium-clmm`, `raydium-cpmm`, `raydium-launchpad`, `raydium-launchlab`, `raydium-amm` (+ `_` 변형) |
| `orca` | `orca`, `orca-whirlpool`, `orca_whirlpool`, `whirlpool` |

알려지지 않은 DEX (Phoenix, Lifinity, SolFi 등) 는 여전히 `unsupported_dex` 로 차단.

### Admission Skip Telemetry

파일: `data/realtime/admission-skips-dex.jsonl`
기록 조건: `unsupported_dex` / `no_pairs` / `unsupported_pool_program` 발생 시 dexId + samplePair + tokenMint + resolvedCount 기록. dex+mint 60초 dedup.
용도: 24-48h 후 실제 어느 DEX 가 Solana 운영에서 주로 차단되는지 empirical 판정 → 다음 coverage 확장 방향 결정.

## Block 1 Runtime Wiring (2026-04-18)

### Lane Wallet Mode

| 변수 | 값 | 동작 |
|---|---|---|
| `CUPSEY_WALLET_MODE` | `auto` / `main` / `sandbox` | cupsey lane executor 명시 선택 (default `auto` backward compat) |
| `MIGRATION_WALLET_MODE` | `auto` / `main` / `sandbox` | migration lane executor 명시 선택 |

`sandbox` 명시했는데 `SANDBOX_WALLET_PRIVATE_KEY` 미설정 시 startup throw (fail-closed).

### Wallet Delta Comparator (always-on)

| 변수 | 기본값 | 동작 |
|---|---|---|
| `WALLET_DELTA_COMPARATOR_ENABLED` | `true` | live 모드에서만 작동 |
| `WALLET_DELTA_POLL_INTERVAL_MS` | `300000` (5분) | poll 주기 |
| `WALLET_DELTA_DRIFT_WARN_SOL` | `0.05` | Telegram 경고 임계 |
| `WALLET_DELTA_DRIFT_HALT_SOL` | `0.20` | 전 lane entry halt 임계 |
| `WALLET_DELTA_MIN_SAMPLES` | `2` | 연속 breach 누적 전 alert 억제 |

Halt 발동 시: 모든 lane(cupsey/migration/main/strategy_d)의 `entryIntegrity` halt 설정 → 운영자 `resetEntryHalt` 수동 복구.

## Guardrails (pivot 불변)

- **Cupsey 개조 금지**
- **Security hard reject 완화 금지**
- **DB pnl 단독 판정 금지** — wallet reconcile 필수
- **Attention / context score hard reject 재도입 금지**
- **cupsey handler 복사해서 pure_ws_breakout 만들기 금지** (별도 상태기계)
- **Kelly / 확대 sizing 은 live 50 trades + wallet 기준 양수 expectancy 확인 후에만**
- **DexScreener / X 데이터 매수 trigger 금지**
- **`OPERATOR_TOKEN_BLACKLIST` 는 scanner / realtime / candle path 에서 모두 차단**

## One-Line Summary

> smart-v3 는 main 5x lane, rotation-v1 은 fast-compound 보조 lane, pure_ws 는 new-pair paper/observer 후보, cupsey 는 frozen benchmark, wallet delta 가 유일한 판정 기준.
