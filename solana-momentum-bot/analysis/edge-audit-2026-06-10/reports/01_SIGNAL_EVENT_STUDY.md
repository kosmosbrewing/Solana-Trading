# Phase 1 — Raw Signal Event Study

> Data: trade-markout-anchors × trade-markouts (Jupiter quote 기반, gross, pre-cost), 2026-05-02 ~ 2026-05-22, 21 active days.
> 단위: deltaPct 는 fraction → 본 보고서는 % 표기. mean 은 +1000% cap (decimals-bug quote 차단).
> Dedup: 같은 mint 600s 내 multi-arm anchor 는 1 token-event 로 축약 (5,177 anchors → 2,114 token events).
> 측정 신뢰: T+60 대형 움직임 (≥+50%) 91건 중 90건이 ledger MFE 와 일치 — quote 무결성 양호. 단 1건 (+88,272%) decimals bug 확인, cap 처리.

## 1.1 전체 forward return (token-event dedup, n≈2,046, 21 days)

| Horizon | N | Median | Mean (capped) | 95% CI (mean) | Pos rate | ≤−20% | ≥+50% | ≥5x |
|---|---:|---:|---:|---|---:|---:|---:|---:|
| T+15s | 1,671 | **+1.30%** | +8.6% | — | 59.2% | 8.4% | 2.6% | 0.6% |
| T+30s | 2,055 | +0.95% | +9.2% | — | 55.4% | 15.1% | 7.2% | 0.5% |
| T+60s | 2,048 | +0.25% | +8.3% | [+4.9, +12.1] | 51.7% | 22.4% | 8.8% | 0.6% |
| T+300s | 2,046 | **−9.58%** | +3.6% | [−0.4, +8.0] | 39.5% | 40.5% | 14.5% | 1.0% |
| T+1800s | 2,034 | **−47.94%** | **−6.7%** | **[−12.7, −0.5]** | 26.6% | 63.1% | 12.3% | 2.2% |

> T+6h / T+24h: 로컬 markout 미측정 (paid 수집 금지로 확장 불가) — 단 T+1800 추세가 단조 악화라 longer horizon 이 더 좋을 근거 없음. missed-alpha T+7200 ok coverage 6.5% → 사용 불가.

**핵심**: 신호의 양수 구간은 진입 후 ~60초뿐이고 (median +0.25~1.3%), 시스템이 실제로 보유하는 horizon (5분~30분) 에서는 gross 기준으로도 결정적 음수. T+1800 capped mean 의 95% CI 가 0 을 배제하며 음수.

## 1.2 세그먼트 (ex-ante axes, token-event dedup)

### Strategy family

| Family | Days | T+60 med | T+300 med | T+1800 med | T+1800 pos | T+1800 ≥5x |
|---|---:|---:|---:|---:|---:|---:|
| rotation | 21 | +0.63% | −8.27% | −43.3% | 28% | 2.2% |
| **smart_v3 (main 5x lane)** | 20 | **−4.04%** | **−28.8%** | **−65.3%** | 20% | 2.4% |
| pure_ws | 4 | +0.02% | −0.06% | −0.2% | 40% | 0% (n=25) |

### Independent KOL count — **Option 5 핵심 가설 반증**

| KOL count | T+60 med | T+300 med | T+1800 med | T+1800 ≥5x | N (T1800) |
|---|---:|---:|---:|---:|---:|
| 1 | +0.63% | −8.3% | −43.1% | 2.2% | 1,634 |
| 2 | −4.97% | −28.9% | **−64.5%** | 2.2% | 316 |
| 3+ | −0.13% | −25.3% | **−68.1%** | 3.4% | 59 |

"독립 KOL consensus 가 5x 조건부 확률을 올린다" 는 Option 5 의 1차 가설은 **이 데이터에서 반증**된다. Multi-KOL 일수록 median decay 가 더 깊다 (consensus 확인 시점 = pump 후반 진입). 5x rate 의 상승 (3.4% vs 2.2%) 은 n=59 로 CI 가 0 을 포함, 증거 불충분.

bootstrap CI (capped mean): kol=2 → T+300 [−13.9%, +11.1%], T+1800 [−30.3%, +16.2%] — 전부 0 포함.
smart_v3 (live 의 주력, fresh active 2+ KOL): T+60 [−0.3%, +12.4%], T+300 [−10.7%, +12.1%], T+1800 [−29.5%, +11.7%] — 전부 0 포함.

### Reject-side 대조 (missed-alpha, diagnostic-only, coverage 11-34%)

| Cohort | T+60 med | T+300 med | T+1800 med |
|---|---:|---:|---:|
| 진입한 token events | +0.25% | −9.6% | −47.9% |
| viability rejects (n=754@T300) | −0.23% | −7.9% | −46.1% |
| kol_close rejects | +0.59% | −11.8% | −37.0% |

**진입군과 reject 군의 forward return 분포가 사실상 동일** — admission gate 가 "미래 수익" 축에서 분리력을 갖지 못한다. (entry_drift reject 의 med −91% 는 알려진 signal-price bug cluster — 측정 아티팩트로 별도 표기.)

## 1.3 Right tail 의 위치 — 가장 중요한 구조 발견

T+1800 에서 ≥5x 인 non-tail anchor 113건 중, **해당 포지션의 ledger MFE ≥ +100% 는 9건 (8%)**.
즉 5x tail 은 universe 에 실존하지만 (~2.2%/30min), **92% 는 시스템이 이미 exit 한 뒤에 발생**한다.
median hold 가 초~분 단위인 현 payoff 구조 (fast-fail / hard-cut / sentinel / T1 partial) 는 bleed 를 막는 동시에 tail 도 함께 버린다. "fast loser cut + long runner preservation" 중 후자가 구조적으로 작동하지 않았다.

## 1.4 Phase 1 판정

Core question — *"ex-ante segment with gross forward expectancy > 0, N ≥ 100, multiple active days, CI excluding zero?"*

**NO.**
- 모든 N≥100 세그먼트의 median 이 T+300 부터 음수.
- capped mean 이 CI 양수인 곳은 T+60 전체뿐인데 (+8.3%, [4.9,12.1]), 이는 tail-driven (median +0.25%) 이며 round-trip cost (~0.5-1%+) 미만의 median 으로는 체계적 수확 불가. 60초 안에 진입+청산을 반복하는 구조는 현 execution stack 의 latency (Phase 2) 와 양립 불가.
- KOL consensus / score / family 어느 축도 양수 cohort 를 만들지 못함. consensus 는 오히려 역방향.

**→ 1차 판정 방향: `REBUILD_SIGNAL_SOURCE`** (KOL buy 를 follow 하는 진입 신호 자체가, 시스템이 실행 가능한 horizon 에서 미래 수익을 예측하지 못함). Phase 2 에서 "T+60 미만 초단기 구간이 비용 후 생존 가능한가" 를 확정한다.
