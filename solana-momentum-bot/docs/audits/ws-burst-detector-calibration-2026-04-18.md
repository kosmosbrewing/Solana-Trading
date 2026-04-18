# WS Burst Detector Calibration (Paper Replay)

- Generated: 2026-04-18T04:31:41.152Z
- Sessions (76): 2026-03-31T13-04-55-420Z-live, 2026-03-31T13-40-37-060Z-live, 2026-03-31T13-59-31-453Z-live, 2026-03-31T14-01-53-556Z-live, 2026-03-31T15-15-34-690Z-live, 2026-04-01T03-30-16-181Z-live, 2026-04-01T03-37-16-312Z-live, 2026-04-01T10-58-01-252Z-live, 2026-04-01T23-01-19-435Z-live, 2026-04-01T23-03-20-752Z-live, 2026-04-02T03-05-47-071Z-live, 2026-04-02T03-18-12-410Z-live, 2026-04-02T13-29-31-708Z-live, 2026-04-03T03-15-55-495Z-live, 2026-04-03T03-47-25-892Z-live, 2026-04-03T03-53-57-260Z-live, 2026-04-03T15-45-41-044Z-live, 2026-04-04T03-57-44-298Z-live, 2026-04-04T03-58-37-308Z-live, 2026-04-04T05-05-20-003Z-live, 2026-04-04T05-26-11-982Z-live, 2026-04-04T06-19-44-409Z-live, 2026-04-04T06-31-53-863Z-live, 2026-04-04T08-29-16-439Z-live, 2026-04-04T14-31-50-271Z-live, 2026-04-05T02-32-07-632Z-live, 2026-04-05T05-24-58-037Z-live, 2026-04-05T06-45-55-671Z-live, 2026-04-05T12-42-12-317Z-live, 2026-04-05T13-09-07-906Z-live, 2026-04-05T13-49-11-869Z-live, 2026-04-06T03-20-29-395Z-live, 2026-04-06T12-02-59-892Z-live, 2026-04-06T12-18-52-516Z-live, 2026-04-06T13-44-48-115Z-live, 2026-04-06T14-17-04-255Z-live, 2026-04-07T03-53-05-856Z-live, 2026-04-07T12-21-19-322Z-live, 2026-04-07T14-35-58-100Z-live, 2026-04-07T23-23-09-281Z-live, 2026-04-07T23-38-06-317Z-live, 2026-04-08T02-49-26-450Z-live, 2026-04-08T03-53-17-101Z-live, 2026-04-08T09-48-10-685Z-live, 2026-04-09T10-55-52-576Z-live, 2026-04-09T23-23-39-579Z-live, 2026-04-10T03-01-25-410Z-live, 2026-04-10T08-46-47-585Z-live, 2026-04-11T01-19-08-074Z-live, 2026-04-11T01-23-17-607Z-live, 2026-04-11T01-24-22-378Z-live, 2026-04-11T01-31-50-833Z-live, 2026-04-11T01-44-18-864Z-live, 2026-04-11T12-22-47-075Z-live, 2026-04-12T04-52-38-544Z-live, 2026-04-12T05-24-30-862Z-live, 2026-04-12T10-05-35-307Z-live, 2026-04-12T10-53-30-413Z-live, 2026-04-12T12-29-43-283Z-live, 2026-04-12T12-34-06-934Z-live, 2026-04-14T00-59-55-188Z-live, 2026-04-14T08-01-11-603Z-live, 2026-04-14T14-29-38-499Z-live, 2026-04-15T02-39-37-358Z-live, 2026-04-15T03-15-52-858Z-live, 2026-04-16T03-28-19-636Z-live, 2026-04-16T03-44-37-300Z-live, 2026-04-16T07-42-01-182Z-live, 2026-04-17T02-56-02-789Z-live, 2026-04-17T03-22-59-776Z-live, 2026-04-17T04-30-07-651Z-live, 2026-04-17T07-57-13-627Z-live, 2026-04-17T13-44-42-144Z-live, 2026-04-17T14-28-17-762Z-live, 2026-04-17T15-57-08-780Z-live, 2026-04-17T17-16-08-792Z-live
- Config: nRecent=3 (30s), nBaseline=12 (120s), minPassScore=60
- Weights: vol=30 buy=25 density=20 price=20 reverse=5
- Floors: vol=0.33 buy_z=0.25 tx_z=0.33 price=0.1 buy_ratio_abs=0.55 tx_count_abs=3

## Overall

- Total evaluations: **2255613**
- Passes: **283** (rate: **0.013%**)

## Reject Reasons

| reason | count | share |
|---|---:|---:|
| vol_floor | 2195399 | 97.34% |
| buy_floor_ratio | 30764 | 1.36% |
| buy_floor_z | 16516 | 0.73% |
| tx_floor_count | 11368 | 0.50% |
| tx_floor_z | 574 | 0.03% |
| price_floor | 479 | 0.02% |
| score_below_threshold | 230 | 0.01% |

## Score Distribution

| bucket | count |
|---|---:|
| 0-10 | 1416733 |
| 10-20 | 307266 |
| 20-30 | 452576 |
| 30-40 | 49449 |
| 40-50 | 15665 |
| 50-60 | 11232 |
| 60-70 | 1992 |
| 70-80 | 540 |
| 80-90 | 155 |
| 90-100 | 5 |

## Factor Percentiles (normalized [0, 1])

| factor | p50 | p75 | p90 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| volumeAccelZ | 0.000 | 0.000 | 0.000 | 0.148 | 0.883 | 1.000 |
| buyPressureZ | 0.000 | 0.000 | 0.096 | 0.254 | 0.671 | 1.000 |
| txDensityZ | 0.000 | 0.000 | 0.000 | 0.000 | 0.333 | 1.000 |
| priceAccel | 0.000 | 0.310 | 1.000 | 1.000 | 1.000 | 1.000 |

Raw factor percentiles:

| factor | p50 | p75 | p90 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| rawBuyRatioRecent | 0.500 | 0.500 | 0.624 | 0.667 | 1.000 | 1.000 |
| rawTxCountRecent | 0.000 | 0.000 | 1.000 | 2.000 | 12.333 | 329.333 |

## Threshold Sweep

| minPassScore | estimated passes | pass rate |
|---:|---:|---:|
| 30 | 79038 | 3.504% |
| 40 | 29589 | 1.312% |
| 50 | 13924 | 0.617% |
| 55 | 0 | 0.000% |
| 60 | 2692 | 0.119% |
| 65 | 0 | 0.000% |
| 70 | 700 | 0.031% |
| 75 | 0 | 0.000% |
| 80 | 160 | 0.007% |
| 90 | 5 | 0.000% |

**Note**: threshold sweep 은 floor rejection 무관. 실제 pass rate 는 floor + threshold 동시 통과 기준.

## Top Pairs by Pass Count

| pair | passes | evaluations | rate |
|---|---:|---:|---:|
| Dfh5DzRgSvvCFDoY... | 164 | 32193 | 0.51% |
| 74SBV4zDXxTRgv1p... | 22 | 2479 | 0.89% |
| 9BB6NFEcjBCtnNLF... | 22 | 1559 | 1.41% |
| 2qEHjDLDLbuBgRYv... | 15 | 1473 | 1.02% |
| CYTUg8qLd45EGbx7... | 10 | 583 | 1.72% |
| 7zgViwJv3H1msPXR... | 8 | 1279 | 0.63% |
| KENJSUYLASHUMfHy... | 6 | 1135 | 0.53% |
| BvHneYfnCYjfZE52... | 5 | 2552 | 0.20% |
| GUMZk4G4jmZ3hyGG... | 4 | 1144 | 0.35% |
| 97PGWGgGJorRwwYg... | 3 | 1015 | 0.30% |
| CpFJrfYq32Wae2Bt... | 3 | 985 | 0.30% |
| DFzeUzRnzbaVDziE... | 3 | 1130 | 0.27% |
| 29CWsqH84TykHDDw... | 3 | 1002 | 0.30% |
| CGEDT9QZDvvH5GmV... | 2 | 751 | 0.27% |
| J8PSdNP3QewKq2Z1... | 2 | 803 | 0.25% |
| H95BDWuhU4rtkWqD... | 2 | 3470 | 0.06% |
| PzcEKaaQ5csrxfhu... | 2 | 1534 | 0.13% |
| FBbnzHwJ1WHYwP42... | 2 | 239 | 0.84% |
| HAS3Bdqy97iKNRYh... | 1 | 2500 | 0.04% |
| ACtfUWtgvaXrQGNM... | 1 | 1675 | 0.06% |

## Interpretation Guide

- **Pass rate 너무 높음 (>5%)**: threshold 또는 floor 상향 고려
- **Pass rate 너무 낮음 (<0.1%)**: threshold 완화 또는 baseline window 조정 고려
- **Factor p95 가 1.0 saturate**: saturation 상한 상향 고려
- **특정 reject reason 편중 (>50%)**: 해당 floor 재검토
- **Top pairs 쏠림**: outlier pair 가 대부분 pass → per-pair cooldown 필요

## Empirical Findings (2026-04-18 replay)

### 핵심 관찰

1. **vol_floor reject 97.34%** — 거의 모든 reject 가 volume floor 에서 걸림. `volumeAccelZ` 의 p95 = 0.148 로 default floor 0.33 의 절반 이하. Default volume floor 가 **실 시장 분포와 mismatch**.
2. **Pass rate 0.013%** — 2.26M evaluations 중 283 pass. 너무 보수적. Canary 데이터 축적 지나치게 느림.
3. **txDensityZ p99 = 0.333** — 대부분의 tradeCount 가 baseline median 수준. 평탄한 tx density 분포.
4. **priceAccel p90 = 1.0 saturate** — 10s 단위 micro-candle 의 price change 가 bps 기준으로 쉽게 튐 (micro-cap volatility). `bpsPriceSaturate=300` 이 너무 낮음.
5. **Top pair 쏠림** — Dfh5DzRgSvvCFDoY (pippin) 164 passes / 32193 eval = 58% 점유. Per-pair cooldown 없으면 동일 pair 중복 entry 위험.

### 튜닝 권장 (tuned default candidate)

| param | before | after | 근거 |
|---|---|---|---|
| `floorVol` | 0.33 | **0.15** | volumeAccelZ p95=0.148, 0.15 면 ~상위 5% 진입 |
| `zVolSaturate` | 3.0 | **2.0** | 더 민감, p95 표본이 0.148 → 0.22 로 올라감 |
| `minPassScore` | 60 | **50** | threshold sweep: 60=0.119% → 50=0.617% (~5x). 50 이면 하루 ~수백 candidate 기대 |
| `bpsPriceSaturate` | 300 | **1000** | p90 가 1.0 saturate 이미 도달 → 상한 높임. micro-cap 10s candle 의 bps 변동폭 반영 |
| `nBaseline` | 12 | **6** | baseline window 60s (12 → 6 candle) 로 축소. 최근 30s 가 이전 60s 대비 튈 확률 증가. v2 detector 의 "instant burst" 성격과 부합 |

**주의**:
- 위 tuning 은 **paper replay 기반 제안**. 실거래 적용 전 Phase 1.3 에서 `PUREWS_V2_ENABLED=true` 로 관측 후 재검증 필요.
- Raw MAD-based tx z-score 는 p99 가 여전히 0.333 → tx density factor 의 normalization curve 는 그대로 두되, weight 만 재고려 가능 (현재 20).
- Per-pair cooldown 은 Phase 1.3 handler 에 도입 필수 (Top pair 쏠림 방지).

### 다음 단계

- Phase 1.3 handler 에 tuned default 주입 (위 table 의 values) + per-pair cooldown (e.g., 5min)
- 배포 후 24h 관측, 동일 replay 다시 돌려 실 signal 분포와 paper 분포 비교
- weight 재검토는 paper trade 50 건 축적 후

### ⚠ QA Note (F5, 2026-04-18): placeholder dependency

- 현재 `tuned minPassScore=50` 은 `f_reverse_quote_stability = 1.0` (Phase 1 placeholder) × `W_REVERSE=5` = `+5 자동 기여` 기반.
- Phase 2 에서 실 reverse quote probe 통합하면 `f_reverse_quote_stability` 가 `[0, 1]` 실측값으로 교체됨 (대부분 1.0 미만).
- **결과**: burst_score 분포 전체가 낮아짐 → 기존 threshold 50 은 pass rate 과다 감소 → 재튜닝 필수.
- 교체 시점에 이 script 를 **실 runtime config 값** 으로 재실행 (`--config-env` CLI 추가 후보 — QA F6).
