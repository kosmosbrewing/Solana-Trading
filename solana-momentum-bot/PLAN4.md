# PLAN4.md

> Updated: 2026-03-30
> Purpose: `PLAN3` 이후 live canary의 **현재 해석과 다음 운영 계획**을 mission 관점으로 재정리한다.
> Scope: 이번 문서는 cadence / coverage / mission-readiness / 수익성 초기 진단을 다룬다.
> Relationship: `PLAN3.md`가 quote endpoint/runtime drift를 다뤘다면, 이번 문서는 그 이후의 **cadence 확보 → 수익성 진단** 전환을 기록한다.
> Related: 상세 거래 내역 및 Phase별 타임라인은 [`20260330.md`](./20260330.md) 참조

---
## Verdict (2026-03-30 갱신)
- 인프라 블로커 3건(Quote 401, Executor 401, insufficient lamports)은 **모두 해소**됐다.
- **cadence는 확보됐다** — 실측 ~1건/2시간, PLAN4 기준 `Trade >= 1/6h` 충족.
- 그러나 **수익성은 아직 증명되지 않았다**.

- `2026-03-25 19:14 UTC` 이후 실거래 구간:
  - `총 거래 = 12건`
  - `승률 = 2/12 = 16.7%` (목표 40% 대비 심각 미달)
  - `총 PnL = -0.017652 SOL`
  - `청산 사유 = 12/12 TRAILING_STOP` (TP1/TP2 도달 0건)
  - 필터링된 시그널의 `effectiveRR` 대부분 0.05~1.15로 reject 기준(1.2) 미만 (체결된 12건은 ≥1.2 통과)

> 지금 문제는 "cadence가 안 나온다"가 아니라, **"cadence는 나오지만 진입 후 수익 방향으로 움직이지 않는다"**는 점이다.
> 다음 단계는 cadence 진단이 아니라 **trailing stop / 진입 타이밍 / effectiveRR 분포 진단**이다.

---
## Confirmed Facts

### F1. 인프라 블로커 3건 모두 해소 (2026-03-30 확인)
- Quote 401 → Jupiter endpoint drift + API key 설정으로 해소
- Executor swap 401 → x-api-key 헤더 추가로 해소
- insufficient lamports → BUY sizing 단위 수정 (`quantity * price`)으로 해소
- `PLAN3`의 quote blocker는 더 이상 active blocker가 아니다.

### F2. cadence는 확보됐다
- 실측: ~1건/2시간 (Signal ~2-5건/시간)
- PLAN4 기준 `Trade >= 1/6h` **충족**
- `12h 0 entry` 경고는 더 이상 해당하지 않는다.

### F3. 수익성은 아직 증명되지 않았다
- 12건 closed, 승률 16.7%, 총 PnL -0.017652 SOL, PF 0.19
- 12/12 TRAILING_STOP 청산, TP1/TP2 도달 0건
- 12건은 통계적 판단에 불충분하지만, **방향성은 경고 수준**이다.
- 상세 수치는 아래 [Mission Review](#mission-review-2026-03-30) 및 [`20260330.md`](./20260330.md) 참조

### F4. 시그널 필터 지배 요인이 변경됐다
- 기존 지배 필터: `security_rejected`, `quote_rejected`
- 현재 지배 필터: **`poor_execution_viability`** (effectiveRR 0.05~1.15)
- `roundTripCost = 0.65%` 대비 기대 수익폭이 좁은 토큰에 시그널이 집중됨
- 이는 전략 품질 문제인지, 토큰 선정(watchlist) 품질 문제인지 추가 분석 필요

### F5. 12/12 TRAILING_STOP 해석에는 계측 caveat가 있었다
- TP1/TP2에 한 번도 도달하지 못했다는 것은:
  - trailing width(ATR 기반)가 시장 변동성 대비 너무 타이트하거나
  - 진입 타이밍이 volume_spike 고점 직후(이미 올라간 뒤)이거나
  - 둘 다일 가능성
- 다만 2026-03-30 후속 수정으로:
  - live trailing 활성화 조건을 backtest와 동일하게 `최소 2봉`으로 정렬
  - TP1/TP2/SL를 wick-aware 관측값으로 판정
  - actual entry price / executed quantity / executed-size effectiveRR telemetry 저장
- 따라서 **기존 12건의 TP1 0건 / trailing 12건은 일부 계측 왜곡 가능성**이 있다.
- 다음 카나리아부터의 분포를 기준으로 재판정해야 한다.

### F6. discovery → realtime admission mismatch는 여전하다
- `unsupported_dex` = 2,817회 (거의 전부 TARO/meteora)
- `non_sol_quote` = 197회
- watchlist 슬롯 낭비가 cadence를 제한하지는 않지만, 자원 효율성 관점에서 개선 필요

### F7. Gecko 429와 runtime drift 경계는 유효하다
- GeckoTerminal 429 = 968회, data-plane 리스크 지속
- runtime drift 의심 시 `PLAN3` stale process 검증을 다시 연다

### F8. 해석 정확도 보강 패치 완료 (2026-03-30)
- stop-loss도 wick-aware로 통일되어 intrabar SL miss 가능성을 제거했다.
- `trades`/position signal data에 `tokenSymbol`, actual entry telemetry가 남아 restart 후 종료 알림/사후 분석 정확도가 올라갔다.
- `effectiveRR`는 planned gate 값뿐 아니라 executed-size 기준 실측값을 남길 수 있게 됐다.

---
## What This Means For Mission

### M1. cadence 검증은 통과, 다음 관문은 수익성이다
- trade cadence (~1건/2시간)는 확보됐다.
- 50건 축적은 현재 속도로 ~4일이면 가능하나, **현재 방향(음수)이 유지되면 의미 없는 축적**이다.
- 이제 문제는 "검증 가능한 속도로 표본이 쌓이는가?"가 아니라 **"쌓이는 표본의 방향이 양수인가?"**다.

### M2. fail-closed discipline + 실행 파이프라인은 증명됐다
- quote DNS failure 해소, executor auth 해소, sizing 단위 해소
- freezable token hard reject 유지
- unsupported realtime venue admission 제외 유지
- 실제 SOL로 on-chain swap 체결 → TRAILING_STOP 청산까지의 전체 경로 동작 확인
- **증명된 것**: 파이프라인이 end-to-end로 동작한다
- **미증명**: 양의 기대값을 만드는 엔진인가

### M3. 지금 phase의 목표는 수익성 진단 + 파라미터 교정이다
1. ~~candidate quality 개선~~ (진행 중)
2. ~~trade cadence 확보~~ (**완료**)
3. **post-fix 재카나리아 표본 확보** (신규 최우선)
4. **trailing stop / ATR width 적정성 진단**
5. **진입 타이밍(volume_spike 후 entry slippage) 분석**
6. 50-trade 축적 → Phase 2 검증
7. expectancy 양수 확인 후 live bootstrap 판단

---
## Required Actions

### R1. `12h / 24h no-entry` cadence alarm
> Status: **충족 — cadence 확보됨** (실측 ~1건/2시간)

- cadence alarm 자체는 유효하나, 현재 구간에서는 트리거되지 않는다.
- 향후 regression 감지용으로 유지한다.

### R2. rejection mix 집계
> Status: **관측 가능** — 지배 필터가 `poor_execution_viability`로 이동

- 2026-03-30 기준 rejection mix:
  - `poor_execution_viability` (effectiveRR < 1.2 reject / 1.2~1.5 reduced): **압도적 다수**
  - `buy_ratio < 0.65`: 3건
  - `Max concurrent position limit`: 3건
  - `security_rejected`, `quote_rejected`: Phase 1-2에서만, Phase 3 이후 없음
- 결론: 필터링된 시그널의 주 원인은 gate fail-closed가 아니라, **시그널의 RR 품질 부족**이다.

### R3. discovery → realtime admission mismatch 줄이기
> Status: **코드 반영 완료, 효과 부분적** — pre-watchlist 필터 동작 확인, 그러나 TARO/meteora 반복 2,817회

- pre-watchlist 필터와 dexId 로그는 동작 중이나, 특정 토큰(TARO)이 반복적으로 dex_boost source로 올라와 매분 스킵됨
- 추가 필요: dex_boost source에서 meteora pair를 사전 제외하거나, skip된 토큰의 cooldown 적용

### R4. cadence blocker와 alpha blocker를 분리해서 다룬다
> Status: **cadence 확보 완료, alpha blocker로 전환** — R4.3 단계 진입

- `freezable`은 정책 완화 대상이 아니다.
- `unsupported_dex`는 alpha 부족이 아니라 pipeline quality 문제다.
- `Gecko 429`와 candle discontinuity는 별도 data-plane 리스크로 분리한다.
1. ~~`12h no entry` 1회: 경고, 원인 분해 시작~~ (해당 없음)
2. ~~`12h no entry` 반복 또는 `24h no trade`: cadence blocker로 승격~~ (해당 없음)
3. **cadence 확보 후에도 expectancy 음수: 전략/파라미터 문제로 분류** ← **현재 여기**

### R5. runtime drift 재검증 조건을 남긴다
> Status: 유지 — regression 감지용

1. startup snapshot이 예상 env/runtime과 다르게 보일 때
2. 이미 해결된 `quote_rejected` / `NO_SECURITY_DATA` 패턴이 재발할 때
3. 로그 source와 현재 프로세스 구간이 맞지 않는 의심이 생길 때

### R6. mission readiness 최소 통과 조건
> Status: **부분 충족, Edge Gate FAIL**

| 조건 | 상태 |
|------|------|
| `Signal >= 1/hour` | **충족** (~2-5건/시간) |
| `Trade >= 1/6 hours` | **충족** (~1건/2시간) |
| 50-trade 수집 속도 | **진행 중** (12/50, ~4일이면 50건 도달) |
| Explained entry ≥ 90% | **충족** (100%) |
| Expectancy > 0 | **FAIL** (-0.017652 SOL) |
| Win Rate ≥ 40% | **FAIL** (16.7%) |
| TP1 Hit Rate ≥ 50% | **FAIL** (0%) |

- 결론: cadence/안전성은 Phase 2 진입 수준이나, Edge가 전면 FAIL이므로 **파라미터 교정 없이 Phase 2 통과 불가**.

---
## Mission Review (2026-03-30)

### Hard Gate 점검

#### Mission Gate (최근 50건 기준)
| 기준 | 요구 | 현재 | 판정 |
|------|------|------|------|
| Explained Entry Ratio | ≥ 90% | 100% (전부 volume_spike) | PASS |
| Source Attribution | 완전 | 전부 source 있음 | PASS |
| Attribution Gap | < 5% | 0% | PASS |
| Safety Bypass | 0건 | 0건 | PASS |
| **표본 충족** | **≥ 50건** | **12건** | **FAIL — 표본 부족** |

> Mission Gate: **평가 불가** (50건 미도달)

#### Execution Gate (최근 24시간 기준)
| 기준 | 요구 | 현재 | 판정 |
|------|------|------|------|
| Unhandled Crash | ≤ 1건 | 0건 | PASS |
| Uptime | ≥ 95% | ~100% | PASS |
| Quote Decay (median) | ≤ 1.0% | 미측정 | **미측정** |
| Sell Impact (median) | ≤ 1.5% | 미측정 | **미측정** |
| Manual Intervention | ≤ 1건 | 0건 | PASS |

> Execution Gate: **조건부 PASS** (uptime/crash 충족, quote decay/sell impact 미측정)

#### Edge Gate (핵심)
| 기준 | 요구 | 현재 | 판정 |
|------|------|------|------|
| Expectancy | > 0R | 음수 | **FAIL** |
| Net PnL | > 0% | -0.017652 SOL | **FAIL** |
| Profit Factor | ≥ 1.0 | 0.19 | **FAIL** |
| Positive Token Ratio | ≥ 40% | 16.7% | **FAIL** |
| Total Trades | ≥ 50 / ≥ 10 (fail) | 12 (fail 기준 통과) | WEAK |

> Edge Gate: **FAIL** — 4개 하위 기준 모두 미달

### Paper Validation 기준 점검
| 지표 | 기준 | 현재 | 판정 |
|------|------|------|------|
| Total Trades | ≥ 50 | 12 | FAIL |
| Win Rate | ≥ 40% | 16.7% | **FAIL (2.4배 미달)** |
| Expectancy | > 0 | 음수 | **FAIL** |
| Max Drawdown | < 30% | ~1.8% | PASS |
| TP1 Hit Rate | ≥ 50% | **0%** (0/12) | **FAIL (심각)** |
| Explained Entry | ≥ 90% | 100% | PASS |

### Risk Tier 점검
| 항목 | 기준 | 현재 | 판정 |
|------|------|------|------|
| 현재 Tier | Bootstrap (< 20 trades) | 12건 | 정상 |
| Risk/Trade | 1% fixed | 정상 | PASS |
| Daily Limit | 5% | 최대 ~1.3% | PASS |
| Max DD | 30% | ~1.8% | PASS |
| Kelly | Inactive | Inactive | 정상 |

> Risk Tier: **PASS** — 리스크 관리 정상

### Composite Score 추정

| 축 | 가중치 | 점수 | 주요 감점 |
|----|--------|------|----------|
| Mission | 0.40 | 100/100 | (표본 caveat) |
| Execution | 0.25 | 68/100 | hold/exit quality 0점 (12/12 trailing, TP 0건) |
| Edge | 0.35 | 13/100 | PnL·expectancy·PF·win rate 전부 0점 |
| **Composite** | — | **61.55** | **Parameter Retuning Required (60–69)** |

### Strategy A 설계값 vs 실측 괴리

| 파라미터 | 설계값 | 실측 | 괴리 |
|----------|--------|------|------|
| TP1 | entry + ATR(20) × 1.5 | 도달 0/12건 | TP1이 실제 변동폭보다 먼 것으로 의심 |
| TP2 | entry + ATR(20) × 2.5 | 도달 0건 | — |
| SL | candle.low | 측정 필요 | — |
| Trailing Stop | ATR(7) adaptive | 12/12 청산 사유 | 너무 타이트하거나 TP1 전에 발동 |
| Time Stop | 30분 | 발동 0건 | trailing이 먼저 잡음 |
| effectiveRR | <1.2 reject / 1.2~1.5 reduced / ≥1.5 full | 필터링 시그널 대부분 <1.2 (reject 구간) | 시그널 RR 품질 구조적 부족 |

### 핵심 의문 3가지

1. **TP1 도달률 0%** — ATR(20) × 1.5가 현재 타겟 토큰의 실제 변동폭 대비 너무 큰가?
2. **Trailing이 TP1 전에 발동** — trailing stop이 TP1 도달 전에도 활성화되는 구조인가? 진입 직후부터 활성화인가?
3. **effectiveRR < 1.2 지배적** — roundTripCost 0.65% 대비 기대 수익폭이 좁다면, 대상 토큰의 유동성/스프레드가 전략 전제와 맞지 않는 것인가?

### 종합 판정

```
사명: 1 SOL → 100 SOL
현재 단계: Phase 1 (Live Bootstrap 관찰)
Composite Score: 61.55 → Parameter Retuning Required

✅ 인프라: 완성 (블로커 0건)
✅ 리스크 관리: 정상 (DD 1.8%, 일일 손실 제한 동작)
✅ 안전성: 정상 (explained 100%, safety bypass 0건)
✅ Cadence: 확보 (~1건/2시간)
❌ 수익성: FAIL (승률 16.7%, PnL 음수, PF 0.19)
❌ TP1 도달: FAIL (0/12 = 0%)
❌ Edge Gate: FAIL (4개 하위 기준 전부 미달)

결론: 사명 달성 가능성을 판단하기엔 이르지만,
     현재 방향은 명확히 음수이며, 파라미터 교정 없이
     50건을 채워도 Phase 2 통과는 불가능하다.
```

---
## Required Actions (2026-03-30 신규)

### RA1. Trailing stop 발동 조건 코드 확인 (P0)
> Status: **완료**

- 12/12 trailing stop 청산은 구조적 문제를 시사한다.
- 확인 결과:
  1. live trailing은 backtest보다 이르게 켜지고 있었다.
  2. live는 TP/SL보다 trailing 쪽이 wick 정보를 더 많이 반영하고 있었다.
  3. 후속 수정으로 live trailing 활성화 조건을 `최소 2봉`으로 정렬했다.
- 산출물:
  - live/backtest trailing parity 정렬
  - SL/TP/trailing wick-aware 판정 일관화
  - 관련 회귀 테스트 추가

### RA2. ATR(20) × 1.5 (TP1) vs 실제 토큰 변동폭 비교 (P0)
> Status: 미착수

- TP1 도달률 0%는 설계 전제와 실제 시장의 괴리를 의미한다.
- 작업:
  1. 12건 거래의 entry price / exit price / TP1 price / ATR(20) 값 추출
  2. TP1까지의 거리(%) vs 실제 holding 기간 중 최대 유리 이동(%) 비교
  3. ATR(20) 값이 토큰의 실제 bar 변동폭과 일치하는지 확인
- 완료 기준: TP1 미도달 원인이 "TP1이 너무 먼 것"인지 "진입 후 방향이 반대"인지 판별

### RA3. effectiveRR 분포 히스토그램 (P1)
> Status: **준비 완료 — 재카나리아 필요**

- 시그널 대부분이 effectiveRR < 1.2로 필터링되는 구조 문제 진단
- 작업:
  1. 최근 시그널의 effectiveRR 분포를 0.0~3.0 구간 히스토그램으로 시각화
  2. 통과 기준 1.2 vs 1.5 vs 2.0에서의 통과율 비교
  3. roundTripCost 0.65%가 현실적인지 검증 (실제 체결 데이터 대비)
- 완료 기준: effectiveRR 기준 조정 여부 판단 가능
- 메모:
  - actual entry price / executed quantity / executed-size effectiveRR telemetry 저장 경로는 확보됨
  - 다음 live 표본부터 분포 해석 신뢰도가 올라감

### RA4. 진입 타이밍 분석 — 고점 추격 여부 (P1)
> Status: **준비 완료 — 재카나리아 필요**

- volume_spike 감지 시점 가격 vs 실제 체결 가격 비교
- 작업:
  1. 12건 거래의 signal price (로그의 `at X.XXXX`)와 entry price 비교
  2. 시그널 가격 대비 entry가 높으면 → 고점 추격 진입 확인
  3. volume_spike 이후 가격 추세 분석 (spike 이후 추가 상승 vs 즉시 반전)
- 완료 기준: 진입 타이밍이 구조적으로 고점 직후인지 판별
- 메모:
  - 기존 12건은 planned entry 중심이라 해석에 한계가 있었다.
  - actual entry telemetry 저장 후 새 카나리아부터 직접 비교 가능해졌다.

### RA5. 파라미터 교정 후 재카나리아 (P2)
> Status: RA2~RA4 결과에 의존

- RA1~RA4 진단 결과에 따라 조정할 파라미터 후보:
  - trailing stop ATR 배수 (현재 ATR(7) → 확대 검토)
  - TP1 ATR 배수 (현재 ATR(20) × 1.5 → 축소 검토)
  - effectiveRR 통과 기준 (현재 1.2 → 조정 검토)
  - trailing stop 활성화 시점 (TP1 이후로 제한 검토)
- **원칙: 현재 파라미터로 50건 채우는 것은 음수 표본만 쌓는 것이므로, 진단 → 교정 → 재카나리아 순서를 지킨다.**
- 완료 기준: 교정된 파라미터로 새 카나리아 12건 이상에서 방향 개선 확인

---
## Priority (2026-03-30 갱신)
1. **post-fix 재카나리아 10~20건 확보** — 새 계측값으로 TP1/SL/trailing 분포 재판정
2. **[RA2] ATR(20) × 1.5 vs 실제 변동폭 비교** — TP1 도달률 0%의 원인 판별
3. **[RA3] effectiveRR 분포 분석** — executed-size 기준 RR 품질 구조 진단
4. **[RA4] 진입 타이밍 분석** — signal price vs actual entry price 비교
5. **[RA5] 파라미터 교정 후 재카나리아** — RA2~4 결과 반영
6. discovery/watchlist TARO/meteora 반복 제거
7. 50건 축적 후 Phase 2 검증

---
## Non-Goals
- 12건 표본만으로 mission success/failure를 단정하는 일
- `freezable` hard reject를 완화하는 일
- cadence 확보를 수익성 증명으로 혼동하는 일
- 12/12 trailing stop 패턴을 무시하고 표본 축적만 기다리는 일
- 진단 없이 파라미터를 감으로 조정하는 일
- Edge Gate FAIL 상태에서 Phase 2 통과를 주장하는 일

---
## One-Line Summary
> 인프라/cadence는 충족했고, trailing/TP/entry telemetry 해석 경로도 보강됐다. 다음 단계는 **post-fix live canary를 다시 쌓아 TP1/SL/trailing/actual entry 분포를 재판정**하는 것이다. 기존 12건은 방향성 경고로 보되, 새 계측 기준으로 재해석해야 한다.
