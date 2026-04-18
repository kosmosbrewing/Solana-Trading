# Pure WS Breakout V2 — Detector Math Spec

> Status: design (Phase 1.1 of DEX_TRADE.md roadmap)
> Date: 2026-04-18
> Role: `pure_ws_breakout` lane 의 **독립 detector** 수학 명세
> Supersedes: `pure_ws_breakout` 의 bootstrap signal 의존 (기존 v1)
> Parent: [`DEX_TRADE.md`](../../DEX_TRADE.md) Section 7, [`mission-pivot-2026-04-18.md`](./mission-pivot-2026-04-18.md)

## 1. Why

현재 `pure_ws_breakout` 는 `bootstrap_10s` signal 을 재사용한다. 이는 `VolumeMcapSpikeTrigger` 가 만든 candle-close 기반 signal 에 의존한다는 뜻이고, v2 의 목표인 **"independent WS burst detector"** 와 맞지 않다.

v2 는 bootstrap 과 **완전히 분리된** burst 수학으로 pair 별 burst_score 를 계산한다.

## 2. Design Principles

- **Pure function** — 부작용 없음. input: `Candle[]` + 현재가. output: score + factors + pass.
- **Candle granularity 재사용** — MicroCandleBuilder 의 10s candle 을 그대로 사용 (tick-level 필요 없음)
- **Normalized factors** — 각 factor 는 [0, 1] 로 정규화
- **Weights sum 100** — cupseyGate 와 interpretability 일치
- **Hard floor + weighted score** — 모든 factor 가 minimum floor 넘어야 하고, weighted sum 이 threshold 넘어야 pass
- **Cooldown per pair** — pair 단위 re-trigger 간격 (detector caller 가 관리)

## 3. Core Formula

```text
burst_score =
    W_VOLUME    * f_volume_accel_z
  + W_BUY       * f_buy_pressure_z
  + W_DENSITY   * f_tx_density_z
  + W_PRICE     * f_price_accel
  + W_REVERSE   * f_reverse_quote_stability
```

각 factor `f_*` 는 **[0, 1] 정규화 값** (raw z-score 또는 bps 를 bounded scale 로 변환).

### Default weights (initial, paper replay tuning 대상)

| symbol | factor | weight |
|---|---|---:|
| W_VOLUME | volume acceleration | 30 |
| W_BUY | buy pressure | 25 |
| W_DENSITY | tx density | 20 |
| W_PRICE | price acceleration | 20 |
| W_REVERSE | reverse quote stability | **5** (placeholder, Phase 2 viability floor 에서 강화) |

합계: 100

## 4. Factor Specs

공통: **`recent window`** 은 마지막 `N_RECENT` 개 10s candle (기본 N_RECENT=3, 즉 30초), **`trailing baseline`** 은 그 직전 `N_BASELINE` 개 candle (기본 N_BASELINE=12, 즉 120초).

### 4.1 `f_volume_accel_z`

**Purpose**: 최근 30초 volume 이 이전 120초 baseline 대비 얼마나 가속하는가.

```text
recent_avg_vol    = mean(recent[i].volume for i in 1..N_RECENT)
baseline_avg_vol  = mean(baseline[i].volume for i in 1..N_BASELINE)
baseline_std_vol  = stddev(baseline)
z_vol             = (recent_avg_vol - baseline_avg_vol) / max(baseline_std_vol, eps)
f_volume_accel_z  = clip(z_vol / Z_VOL_SATURATE, 0, 1)
```

- `eps = 1e-9`
- `Z_VOL_SATURATE = 3.0` — z-score 3 이상은 전부 1 로 saturate
- **floor**: `z_vol >= 1.5` (최소 1.5σ 이상 acceleration 필요)
- **fallback**: `baseline_avg_vol == 0` 이면 `z_vol = 0` (pair 가 방금 생긴 경우)

### 4.2 `f_buy_pressure_z`

**Purpose**: 최근 매수 우세가 baseline 대비 얼마나 튀어나왔는가.

```text
for each candle c:
  buy_ratio(c) = c.buyVolume / max(c.buyVolume + c.sellVolume, eps)

recent_avg_buy_ratio    = mean(buy_ratio(recent[i]))
baseline_avg_buy_ratio  = mean(buy_ratio(baseline[i]))
baseline_std_buy_ratio  = stddev(buy_ratio over baseline)
z_buy                   = (recent_avg_buy_ratio - baseline_avg_buy_ratio) / max(baseline_std_buy_ratio, 0.05)
f_buy_pressure_z        = clip(z_buy / Z_BUY_SATURATE, 0, 1)
```

- `Z_BUY_SATURATE = 2.0`
- **floor**: `recent_avg_buy_ratio >= 0.55` AND `z_buy >= 0.5`
  - dual floor: 절대값 매수비 55% 이상 + 상대적 가속 0.5σ 이상
- **fallback**: baseline std 최소 0.05 (극도로 flat 한 pair 의 가짜 z 방지)

### 4.3 `f_tx_density_z` (robust)

**Purpose**: tx 카운트가 baseline 대비 튀어나왔는가. outlier 에 robust 하게 MAD 사용.

```text
recent_tx         = mean(recent[i].tradeCount)
baseline_medians  = median(tc for tc in baseline.tradeCount)
MAD               = median(|tc - baseline_medians| for tc in baseline)
z_tx_robust       = (recent_tx - baseline_medians) / max(1.4826 * MAD, 1)
f_tx_density_z    = clip(z_tx_robust / Z_TX_SATURATE, 0, 1)
```

- `Z_TX_SATURATE = 3.0`
- 1.4826 = MAD → std 변환 상수
- `max(..., 1)` — 0 tx baseline 방지
- **floor**: `recent_tx >= 3` AND `z_tx_robust >= 1.0`

### 4.4 `f_price_accel`

**Purpose**: 최소한의 price impulse — "거래 활성인데 가격은 안 움직인다" 를 걸러냄.

```text
oldest_recent_open = recent[0].open
latest_close        = recent[-1].close
price_change_bps    = (latest_close - oldest_recent_open) / oldest_recent_open * 10_000
f_price_accel       = clip(price_change_bps / BPS_SATURATE, 0, 1)
```

- `BPS_SATURATE = 300` (3%)
- **floor**: `price_change_bps >= 30` (0.3%)
  - 너무 엄격하면 loss-first mission 사명 위배 (pullback entry 도 허용해야)
  - 너무 느슨하면 평평한 주행 소음 통과

### 4.5 `f_reverse_quote_stability` (Phase 1 placeholder)

**Purpose**: route 유지율 + sell side impact 안정성. 실제 구현은 Phase 2 viability floor 에서 Jupiter reverse quote 호출 통합.

**Phase 1 spec**:

```text
f_reverse_quote_stability = 1.0  (constant)
W_REVERSE                 = 5    (weight 낮게)
```

Phase 2 에서 교체:

```text
stability = (route_kept_count / N_QUOTES) * clip(1 - impact_drift_bps / 500, 0, 1)
f_reverse_quote_stability = clip(stability, 0, 1)
```

- **Phase 1 floor 없음** (placeholder 라 gate 영향 최소화)

## 5. Pass / Reject Logic

```text
def evaluateWsBurst(candles, config):
    # 1. 샘플 충분성
    if len(candles) < (N_RECENT + N_BASELINE):
        return { pass: False, reason: 'insufficient_samples', score: 0, factors: {} }

    # 2. factor 계산
    factors = compute_all_factors(candles)

    # 3. hard floor check (각 factor 마다)
    if factors.volume_accel_z < FLOOR_VOL:
        return { pass: False, reason: 'vol_floor', score: computed_score, factors }
    if factors.buy_pressure_z < FLOOR_BUY:
        return { pass: False, reason: 'buy_floor', score: computed_score, factors }
    if factors.tx_density_z < FLOOR_TX:
        return { pass: False, reason: 'tx_floor', score: computed_score, factors }
    if factors.price_accel < FLOOR_PRICE:
        return { pass: False, reason: 'price_floor', score: computed_score, factors }

    # 4. weighted score
    score = sum(w_i * f_i)

    # 5. 최종 threshold
    if score < MIN_PASS_SCORE:
        return { pass: False, reason: 'score_below_threshold', score, factors }

    return { pass: True, score, factors }
```

### Default threshold values

```text
MIN_PASS_SCORE = 60   # 100 중 60 이상 pass
N_RECENT       = 3    # 30s
N_BASELINE     = 12   # 120s
FLOOR_VOL      = 0.33 # z_vol >= 1.5 / 3.0 ≈ 0.5 → 0.33 = z 1.0 이상
FLOOR_BUY      = 0.25 # z_buy >= 0.5 / 2.0
FLOOR_TX       = 0.33 # z_tx >= 1.0 / 3.0
FLOOR_PRICE    = 0.1  # price_change >= 30 bps / 300 bps saturate
```

**주의**: 이 값은 **paper replay tuning 전의 초기값**. 실거래 적용 전에 기존 세션 데이터 replay 로 weight 와 threshold 를 재조정한다.

## 6. Env Overrides

```text
PUREWS_V2_ENABLED=false                 # default false, opt-in
PUREWS_V2_MIN_PASS_SCORE=60             # threshold
PUREWS_V2_FLOOR_VOL=0.33
PUREWS_V2_FLOOR_BUY=0.25
PUREWS_V2_FLOOR_TX=0.33
PUREWS_V2_FLOOR_PRICE=0.1
PUREWS_V2_W_VOLUME=30
PUREWS_V2_W_BUY=25
PUREWS_V2_W_DENSITY=20
PUREWS_V2_W_PRICE=20
PUREWS_V2_W_REVERSE=5
PUREWS_V2_N_RECENT=3
PUREWS_V2_N_BASELINE=12
```

모든 값은 config.ts 에서 default 제공 + env override 가능.

## 7. Integration Plan

### Phase 1.1 (this doc)
- `src/strategy/wsBurstDetector.ts` — pure function `evaluateWsBurst(candles, config)`
- `test/wsBurstDetector.test.ts` — unit tests (factor normalization, floor, threshold, edge cases)
- **아직 handler 에 wire 하지 않음**. 순수 function 검증 먼저.

### Phase 1.2
- `scripts/wsBurstPaperReplay.ts` — 기존 session 데이터 replay 로 detector 출력 수집
- 수집 결과로 weight / floor / threshold 재튜닝
- `docs/audits/ws-burst-detector-calibration-<date>.md` — empirical 근거 기록

### Phase 1.3 (flag 전환)
- `pureWsBreakoutHandler.ts` 에 `PUREWS_V2_ENABLED` 분기 추가
- v2 활성 시 bootstrap signal 소비 중단 + independent ticker (매 candle close 또는 매 swap event 마다 detector 호출)
- v1 은 benchmark 유지 (flag off)

## 8. Open Questions (Phase 1.1 에서 닫지 않음)

1. **Trigger frequency** — 매 candle close vs 매 swap event vs 매 N 초. Phase 1.3 integration 에서 확정.
2. **Per-pair cooldown** — detector 호출 주기와 별개로 같은 pair 연속 burst 방지 간격. Phase 1.3 에서.
3. **Dynamic baseline window** — 현재 fixed 120s. 시장 레짐 (high vol / low vol) 별로 adaptive 필요 여부. Phase 2 후보.
4. **Reverse quote integration** — Jupiter quote caller 통합. latency / rate-limit tradeoff. Phase 2 viability floor 와 같이.

## 9. Testing Spec (Phase 1.1)

- `f_volume_accel_z` — synthetic candle 로 z-score 검증 (baseline flat + spike / baseline spike + flat / zero baseline)
- `f_buy_pressure_z` — dual floor (절대값 + 상대 z) 동작 확인
- `f_tx_density_z` — MAD 기반 robust z 가 outlier 에 영향 안 받는지
- `f_price_accel` — bps → [0, 1] 정규화 + floor
- `f_reverse_quote_stability` — placeholder 1.0 고정
- `evaluateWsBurst` — 샘플 부족 / 모든 floor 통과 / 각 floor 개별 reject / weighted score threshold / 가중치 env override

## 10. One-Line Summary

> burst_score = weighted sum of (volume_accel_z, buy_pressure_z, tx_density_z, price_accel, reverse_quote_stability). 각 factor [0,1] 정규화 + hard floor + weighted threshold. Paper replay 로 threshold tuning 전까지 detector 만 구현하고 handler wiring 은 Phase 1.3 로 분리.
