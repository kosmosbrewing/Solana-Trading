# REFACTORING.md

> Updated: 2026-04-05 (rev.6 — Feature 1-4 구현 완료 + replay-loop 결과 + Strategy A/C dormant + sparse P0 신설)
> Purpose: 리포트/구현/운영 해석이 문서 기준과 어긋나지 않도록 현재 기준선과 리팩터링 우선순위를 고정한다.

## Scope

이 문서는 다음 두 용도로 쓴다.

- 현재 코드/운영/문서 사이의 기준선 차이를 정리한다.
- 무엇을 먼저 고쳐야 `1 SOL -> 100 SOL` 미션에 더 가까워지는지를 리팩터링 관점에서 우선순위화한다.

현재 판단 기준 문서는 아래 4개다.

- `docs/exec-plans/active/1sol-to-100sol.md`
- `OPERATIONS.md`
- `STRATEGY.md`
- `docs/product-specs/strategy-catalog.md`

참고 문서:

- `STRATEGY_NOTES.md` — 현재 runtime이 왜 그런 형태인지, 어떤 질문이 열려 있는지 기록한 forward memo

---

## Source of Truth Hierarchy

값이 충돌할 때는 아래 우선순위로 해석한다.

1. **live runtime / deployment override**
   - 실제 프로세스가 현재 사용 중인 env, secret, operator override
2. **OPERATIONS.md의 active operator 값**
   - 현재 운영자가 의도적으로 걸어둔 보수 cap / canary 제한
3. **STRATEGY.md의 current quick reference 값**
   - 현재 runtime을 설명하는 문서 기준선
4. **code default / parameter layer 값**
   - fallback 값 또는 candidate 값

### 라벨 규칙

숫자/파라미터를 적을 때는 반드시 아래 셋 중 하나의 라벨을 붙인다.

- `runtime_observed_value`
- `operator_cap_value`
- `code_default_candidate`

규칙:

- 서로 다른 라벨의 값을 둘 다 `현재 기준`이라고 부르지 않는다.
- 문서가 서로 다른 값을 가질 경우, 더 아래 우선순위의 문서는 **현재 운영값**이 아니라 **candidate/default**로 표시한다.
- `STRATEGY.md`에 있는 값과 `OPERATIONS.md`의 보수 cap이 다르면, 둘을 충돌로 숨기지 말고 **역할이 다른 값**으로 명시한다.

---

## Current Baseline

2026-04-05 기준 baseline은 아래처럼 읽는다.

### Strategy Runtime Baseline

- realtime bootstrap (`volumeMcapSpikeTrigger`)는 **active default**다 — 유일한 유효 trigger.
- **A/C는 5m 밈코인에서 dormant**다 (04-05 확인: 261 combination → 3 trades). 향후 CEX/DEX 대형 토큰 전환 시에만 재활성화 고려.
- realtime core (`momentumTrigger`)는 standby다.
- D는 sandbox 전용이며 main live execution 경로에 섞지 않는다.
- E는 conditional add-on이며 Strategy A live expectancy 검증 전에는 공격적으로 켜지 않는다.

### Current Live Order Shape

현재 realtime live path는 아래 기준으로 읽는다.

- `SL = ATR x 1.5`
- `TP1 = ATR x 1.0`
- `TP2 = ATR x 10.0`
- `Time Stop = 15m`
- `TP1 partial = 30%`
- `Trailing = TP1 이후에만 활성화`

참고:

- STRATEGY.md / strategy별 코드 기본값은 `SL 1.0 ATR / TP1 1.0 ATR / TP2 10.0 ATR / time stop 20m`다.
- 단, `tradingParams.ts`의 전역 orderShape 기본값은 `slAtrMultiplier: 1.25` (VPS canary)로 이미 변경돼 있다.
- 따라서 현재 3개 값이 혼재한다: `strategy 코드 기본값(1.0)` / `tradingParams 전역 기본값(1.25)` / `live env override(1.5)`.
- 이 혼재가 정확히 P0-4에서 해결하려는 source-of-truth 충돌의 대표 사례다.
- default/backtest path와 realtime live path를 같은 기준선으로 읽지 않는다.

### Bootstrap Trigger Baseline

현재 quick reference 기준의 bootstrap baseline은 아래처럼 읽는다.

- `REALTIME_TRIGGER_MODE=bootstrap`
- `REALTIME_VOLUME_SURGE_MULTIPLIER=1.8`
- `REALTIME_BOOTSTRAP_MIN_BUY_RATIO=0.60`
- `REALTIME_VOLUME_SURGE_LOOKBACK=20`
- `REALTIME_COOLDOWN_SEC=300`

참고:

- code default candidate는 여전히 더 큰 값(`3.0 / 0.55 / 20`)일 수 있다.
- ✅ bootstrap signal은 `strategy=bootstrap_10s`로 기록된다 (P0-1 완료). Strategy A(`volume_spike`)와 별도 집계된다.

### Watchlist / Subscription Baseline 해석 규칙

현재 quick reference는 `MAX_WATCHLIST_SIZE=20`, `REALTIME_MAX_SUBSCRIPTIONS=30`을 **VPS 현재값**으로 적고 있다.

한편 운영 문서가 더 보수적인 cap(예: `8 / 5`)을 갖고 있다면, 이는 **active operator cap**이지 자동으로 같은 의미의 baseline이 아니다.

따라서 현재 단계에서는 아래처럼 적는다.

- `runtime_observed_value`: 현재 실제 프로세스가 쓰는 값
- `operator_cap_value`: 운영자가 의도적으로 더 낮게 제한한 값
- `code_default_candidate`: 코드 기본값

이 셋을 구분하지 않으면 아래 오해가 생긴다.

- 운영 기준이 이미 확장형으로 바뀌었다는 착시
- provider 상한만 문제라고 보는 해석
- backlog / burst / churn / backpressure 병목을 과소평가하는 해석

---

## Quality Review Result

이번 사명 점검 리포트는 방향은 대체로 맞지만, 우리 기준으로는 아래처럼 보정해서 읽는다.

### 1. Strategy Identity Contamination — ✅ 해결됨 (P0-1)

(이전) 3개 경로가 모두 `strategy=volume_spike`로 기록되어 contamination이 발생했다.

(현재) P0-1 완료 후 각 경로는 고유 전략 ID를 사용한다:

- `volumeMcapSpikeTrigger` (bootstrap, 10초봉) → `strategy: 'bootstrap_10s'`
- `momentumTrigger` (core, 10초봉) → `strategy: 'core_momentum'`
- `volumeSpikeBreakout` (Strategy A, 5분봉) → `strategy: 'volume_spike'`

현재 `StrategyName` union type (types.ts):

- `volume_spike` — Strategy A: 5분봉 브레이크아웃
- `bootstrap_10s` — Realtime bootstrap trigger
- `core_momentum` — Realtime core trigger (standby)
- `fib_pullback` — Strategy C
- `new_lp_sniper` — Strategy D (sandbox)
- `momentum_cascade` — Strategy E (conditional)

보조 필드:

- `sourceLabel` — signal path (어떤 trigger가 발화했는지). ✅ 4개 trigger/strategy 부여 완료.
- `discoverySource` — discovery provenance (어떻게 이 토큰을 발견했는가). ✅ 필드 추가 + 파이프라인 연결 완료 (WatchlistEntry → PoolInfo → Signal → Order → Trade → DB).
- `VOLUME_SPIKE_FAMILY` — 라우팅(order shape, scoring, gate) 공유 유틸. ✅ 구현 완료.

### 2. Breadth Expansion is Important, but Not Yet the Primary Proven Bottleneck

breadth는 중요한 가설이지만, 현재 active 문서가 직접 열어 둔 질문은 아래 쪽이다.

- explained entry ratio
- bootstrap replay vs live canary 정합성
- actual-cost accounting 이후 wallet PnL vs DB PnL 차이
- execution telemetry 해석 가능성

따라서 현재 표현은 이렇게 고정한다.

- `breadth = 중요`
- `breadth = 다음 단계 실험 후보`
- `breadth = 아직 문서상 확정된 최대 병목은 아님`

즉, breadth는 P2에서 확장하되 P0/P1의 계측 정합성을 밀어내지 않는다.

### 3. Measurement Closure는 대부분 구현됐고, 남은 것은 live validation이다

현재 사명 점검에서 가장 중요한 보정은 아래다.

- `strategy identity 분리`는 더 이상 새 구현 과제가 아니다. 현재는 완료된 기준선이다.
- `wallet PnL vs DB PnL closure`도 구현/계측 관점에서는 대부분 닫혔다.
- 현재 남은 우선순위는 구현 자체보다 `live 표본으로 이 기준선이 실제로 유지되는지` 검증하는 일이다.

즉, 아래 두 문장을 구분해서 쓴다.

- `measurement closure largely done`
- `mission engine live validation still pending`

### 4. Runner는 현재 엔진이 아니라 runner-centric thesis under validation이다

현재 구조는 분명 runner 중심 thesis로 정렬돼 있다.

- TP2는 10 ATR runner-centric 확장값이다.
- execution RR도 TP2 기준으로 해석한다.
- fat-tail winner가 다수 손실을 덮는 구조를 목표로 한다.

하지만 아래 이유로 아직 `현재 엔진 = runner`라고 단정하지 않는다.

- `runnerEnabled`는 config default상 optional이다.
- product spec에서도 runner / degraded exit를 optional extension으로 취급한다.
- active open question도 `runner hold가 실제 손실 묶음을 덮는가`를 아직 검증 대상으로 둔다.

따라서 현재 표현은 아래로 고정한다.

- `runtime thesis = bootstrap + runner-centric order shape`
- `mission engine = bootstrap + runner hypothesis under validation`

### 5. Watchlist / Subscription 숫자는 문서 기준과 코드 기본값을 분리해 해석한다

숫자 하나만 따로 복사해 리포트에 적지 않는다.

- `STRATEGY.md` quick reference의 값
- `OPERATIONS.md`의 operator cap
- 실제 env/runtime observed 값

을 각각 분리해 기록한다.

### 6. Mission Metric은 Executed Entry와 Closed Trade를 분리해 읽는다

현재 리포트/요약에서 가장 쉽게 섞이는 부분은 표본 기준이다.

- 진입 설명 가능성은 **executed entry 표본** 기준으로 본다.
- 실현 손익/승률/기대값은 **closed trade 표본** 기준으로 본다.

둘을 같은 이름으로 부르지 않는다.

---

## Target Metric Naming

아래 metric 이름은 **목표 상태 naming 규칙**이다.

주의:

- 이 섹션은 현재 코드가 이미 이 이름/표본 기준을 모두 구현했다는 뜻이 아니다.
- 구현 전까지는 `current implementation`과 `target metric`을 구분해 적는다.
- 현재 구현 상태와 충돌하면 `현재 코드 기준`을 우선 명시하고, 이 naming은 refactor target으로 취급한다.

### Entry / Attribution Metrics

- `entry_attribution_ratio_50_executed`
  - 최근 50 executed entries 기준
  - 진입 설명 가능성 / source attribution completeness
- `bootstrap_explained_entry_ratio_50_executed`
  - bootstrap 경로만 별도 집계
- `core_explained_entry_ratio_50_executed`
  - core 전략만 별도 집계

### Realized / Outcome Metrics

- `realized_summary_50_closed`
  - 최근 50 closed trades 기준
  - PnL, win rate, expectancy, realized RR
- `strategy_expectancy_50_closed`
  - 전략 ID별 최근 50 closed trades 기준 기대값

### 규칙

- executed entry 집계와 closed trade 집계를 같은 metric 이름으로 부르지 않는다.
- Daily Summary는 어떤 기준(`executed` / `closed`)인지 metric 이름에서 드러나야 한다.
- Strategy A expectancy 계산에 bootstrap contaminated sample을 넣지 않는다.

현재 구현 메모:

- ✅ Daily Summary의 explained entry ratio는 `getRecentExecutedEntries(50)` 기반으로 계산된다 (P0-3 완료).
- 이 섹션의 metric naming은 현재 구현과 정합한다.

---

## Legacy Contamination Handling

전략 ID 분리 이전에 `strategy=volume_spike`로 저장된 bootstrap 표본은 Strategy A expectancy와 Strategy E 활성화 판단에 직접 사용하지 않는다.

우선순위:

1. **deterministic retag 가능하면 backfill**
   - 신호 시간, interval, signalPath, trigger metadata로 `bootstrap_10s` 재태깅
2. **retag 불가능하면 quarantine**
   - `legacy_contaminated` 또는 동등한 별도 분류로 격리
3. **mission metric 제외**
   - 아래 계산에서 제외
     - Strategy A expectancy
     - Strategy E activation
     - Kelly activation
     - mission scorecard

원칙:

- legacy contaminated sample을 조용히 남겨두고 새 표본과 합산하지 않는다.
- quarantine sample은 보조 참고용으로만 남긴다.

---

## Operationally Confirmed Bottlenecks

이 문서는 측정/attribution 우선순위를 다루지만, 최근 운영에서 이미 확인된 직접 병목은
아래처럼 별도 기록해 둔다.

### 1. Cooldown / Cap Token Saturation

- 최근 live 세션에서는 `pippin`이 반복적으로 signal을 만들었지만
  `per-token cooldown` 또는 `per-token daily trade cap`에 막혔다.
- 따라서 `buy 0건`을 단순히 market drought로 해석하면 안 된다.

의미:

- signal quality 문제와 execution policy 문제를 분리해서 읽어야 한다.
- `cooldown/cap hit token`이 trigger eval budget을 계속 점유하는지 별도 계측/제어가 필요하다.

### 2. Discovery Noise and Overflow

- 최근 runtime diagnostics에서는 `non_sol_quote` 반복 유입과 `queue_overflow`가 함께 관측됐다.
- breadth 부족만으로 설명하기 전에 discovery noise와 backlog 압력을 먼저 본다.

의미:

- breadth 확장은 단순 subscription 확대가 아니라
  `noise suppression + queue stability`와 같이 다뤄야 한다.

### 3. Alias / Admission Continuity Gap

- `alias_miss`, `all_pairs_blocked`, `not_in_watchlist`는 최근 missed-token 해석에서
  실제로 확인된 병목이다.
- 따라서 watchlist/subscription 문제는 단순 provider cap 이슈가 아니라
  `eviction -> admission -> signal eligibility` 연속성 문제로 읽는다.

의미:

- breadth 실험보다 먼저 `continuity instrumentation`과 `reentry/admission` 해석력이 필요하다.

### 해석 규칙

- 위 3개는 **운영에서 이미 확인된 직접 병목**이다.
- P0/P1 measurement work가 중요하더라도, 이 병목을 문서 밖 예외처럼 취급하지 않는다.
- 리팩터링 우선순위를 읽을 때는 `measurement closure`와 `operational bottleneck relief`를 분리해서 본다.

---

## Implementation Progress

이전 작업에서 이미 구현된 항목과 아직 미구현인 항목을 구분한다.
이 섹션은 P0 작업을 시작하기 전에 중복 작업을 방지하기 위해 참조한다.

### 완료된 항목

| 항목 | 상태 | 위치 | 비고 |
|------|------|------|------|
| sourceLabel 부여 (4개 trigger/strategy) | ✓ 완료 | volumeMcapSpikeTrigger, momentumTrigger, volumeSpikeBreakout, fibPullback | signal path label 부여 완료. discoverySource 필드 추가 + 파이프라인 연결 완료. |
| Mission Score 5개 컴포넌트 | ✓ 완료 | `src/reporting/missionScore.ts` | contextClarity(25), eventAlignment(20), unexplainedSuppression(20), safetyDiscipline(20), traceability(15) |
| Composite Score 공식 | ✓ 완료 | `src/reporting/missionScore.ts` | Mission×0.40 + Execution×0.25 + Edge×0.35 |
| computeExplainedEntryRatio | ✓ 완료 | `src/reporting/sourceOutcome.ts` | ✅ caller가 `getRecentExecutedEntries(50)` 기준으로 호출 (P0-3 완료). |
| index.ts 분할 | ✓ 완료 | `src/init/initStores.ts`, `src/init/monitoringLoops.ts` | ~104줄 감소 |
| Runtime diagnostics tracker | ✓ 완료 | `src/reporting/runtimeDiagnosticsTracker.ts` | admission skip, pre-watchlist reject, alias miss, capacity, trigger stats 등 전체 계측 |
| Daily Summary에 explainedEntryRatio 표시 | ✓ 완료 | `src/notifier/dailySummaryFormatter.ts` | `explained entry (last N)` 라인 추가 |

### P0 기준선 커버리지 (구현 완료 항목 중심)

| 항목 | 상태 | P0 연결 | 비고 |
|------|------|---------|------|
| Strategy ID 분리 | ✓ 완료 | P0-1 | `bootstrap_10s`, `core_momentum` 분리 완료. `VOLUME_SPIKE_FAMILY` 라우팅 유틸 추가. |
| Wallet PnL vs DB PnL 비용 분해 | ✓ 완료 | P0-2 | trades 테이블에 entry/exit slippage, price impact, round-trip cost, effective RR 컬럼 추가. recordOpenedTrade/closeTrade에서 전달. Daily Summary에 비용 요약 섹션 추가. |
| discoverySource 필드 추가 | ✓ 완료 | P0-1 확장 | Signal/Order/Trade/SignalAuditEntry + DB 컬럼 추가. PoolInfo → Signal → Order → Trade 전체 파이프라인 연결 완료. |
| Legacy contaminated sample retag | ✓ 완료 | P0-1 연계 | `scripts/retag-legacy-strategy.ts` 추가. source_label 기반 deterministic retag. |
| executed entry vs closed trade 표본 분리 | ✓ 완료 | P0-3 | `getRecentExecutedEntries(50)` 추가. Daily Summary에 `executed` 라벨 추가. |
| 운영 숫자 3-label 표준화 | ✓ 완료 | P0-4 | tradingParams.ts 코멘트 + STRATEGY.md 표에 3-label 반영 |

---

## Refactoring Priorities

### P0. Measurement Closure Before New Strategy Work

새 전략/새 데이터 소스보다 먼저 닫아야 하는 항목이다.

상태 보정:

- P0는 현재 구현 기준으로 대부분 완료됐다.
- 아래 항목은 더 이상 `greenfield implementation backlog`가 아니라
  `완료 기준선 확인용 reference`로 읽는다.
- 지금 active work의 무게중심은 P0 신규 구현보다
  `live validation / telemetry interpretation / blacklist 효과 검증` 쪽이다.

따라서 이 섹션은 아래처럼 해석한다.

- `무엇을 만들 것인가`보다 `무엇이 이미 닫혔고, 운영에서 무엇을 검증할 것인가`
- P0 항목 자체를 다시 구현하는 것이 아니라, live 표본에서 기준선이 유지되는지 확인하는 단계

#### P0-1. Strategy identity 분리

- bootstrap trigger와 Strategy A 표본을 완전히 분리한다.
- `strategy`, `sourceLabel`, 필요하면 `discoverySource` / `signalPath` / `executionPath`를 별도 필드로 분리한다.
- legacy contaminated sample 처리 규칙까지 한 세트로 묶는다.

완료 기준:

- `bootstrap_10s`, `core_momentum`, `A_5m_volume_spike`가 대시보드/리포트/DB query에서 별도 집계된다.
- Strategy E 활성화 판단에서 bootstrap/core contaminated sample이 제외된다.
- EdgeTracker가 전략 ID별로 분리 집계한다.

#### P0-2. Wallet PnL vs DB PnL 정합성 닫기

- actual-cost accounting 이후 새 trade 기준으로 비용 원인을 분해한다.
- slippage, fee, priority fee, Jito tip, rent, partial exit, degraded exit를 포함해 aggregate 차이를 설명 가능 상태로 만든다.

완료 기준:

- 거래별 비용 분해가 가능하다.
- aggregate wallet PnL과 DB PnL 차이를 원인별로 설명할 수 있다.
- unexplained delta가 운영 허용 범위 이내로 줄어든다.

#### P0-3. Mission metric 표본 기준 정리

- `explained entry ratio`와 source attribution completeness는 `최근 50 executed entries` 기준으로 계산한다.
- realized summary는 `최근 50 closed trades` 기준으로 계산한다.
- 같은 summary에 executed/closed를 섞어 쓰지 않는다.

구현 메모:

- `computeExplainedEntryRatio()` 자체에 rolling window가 없다면 caller가 명시적으로 표본을 잘라서 넘겨야 한다.
- Daily Summary가 `closed trades` 기준이면 metric 이름에도 그 기준을 드러낸다.

#### P0-4. Source-of-truth 충돌 해소

- watchlist/subscription 등 운영 숫자는 `runtime observed / operator cap / code default` 3라벨로 표준화한다.
- `STRATEGY.md`와 `OPERATIONS.md`가 같은 항목에 서로 다른 값을 가질 경우, 둘 다 `현재 기준`이라고 쓰지 않는다.

현재 확인된 충돌 사례:

- **SL ATR multiplier**: strategy 코드 기본값(`1.0`) / tradingParams 전역 기본값(`1.25`, VPS canary) / live env override(`1.5`) — 3개 값 혼재
- **watchlist/subscription**: STRATEGY.md(`20/30`) / OPERATIONS.md 운영 cap(`8/5`) / 실제 VPS env — 역할 미구분
- **bootstrap buy ratio**: code default(`0.55`) / VPS 운영 baseline(`0.60`) — 어느 것이 현재 기준인지 라벨 없음

완료 기준:

- 파라미터 리포트에 각 값의 라벨(`runtime_observed` / `operator_cap` / `code_default`)이 명시된다.
- 운영 회고에서 `20/30인지 8/5인지`, `SL 1.0인지 1.25인지 1.5인지` 같은 해석 혼선이 사라진다.
- `tradingParams.ts`와 `STRATEGY.md`의 default path 값이 일치하거나, 불일치 사유가 문서화된다.

### P1. Operational Safety and Attribution

측정 오염을 걷어낸 뒤 바로 들어갈 항목이다.

주의:

- 아래 항목은 운영 병목을 무시한 채 순차적으로만 진행한다는 뜻이 아니다.
- `cooldown/cap saturation`, `discovery overflow`, `alias/admission continuity`는
  필요하면 P1 작업과 병행해 국소 수정한다.

#### P1-1. 카나리아 운영 규칙 고정 ✅

아래를 운영 체크리스트/런북으로 고정한다.

- max live notional
- daily halt 조건
- wallet kill-switch
- flat 확인 절차
- restart 전후 확인 절차

구현 완료: OPERATIONS.md에 "Canary Runbook" 섹션 추가. 5개 항목 모두 체크리스트 포함.

#### P1-2. bootstrap / core / sandbox lane 분리 강화 ✅

- main core와 Strategy D sandbox를 표본, 지갑, 승격 조건 관점에서 분리한다.
- bootstrap, core, sandbox를 같은 live quality 표본으로 합치지 않는다.

구현 완료:
- `SANDBOX_STRATEGIES` + `isSandboxStrategy()` 추가 (types.ts)
- `EdgeTracker.getMainPortfolioStats()` + `getRecentMainStats()` — sandbox 제외 portfolio 통계
- `riskTier.ts`: 모든 portfolio-level 판단(resolveRiskTierWithDemotion, resolvePortfolioRiskTier, replayPortfolioDrawdownGuard)에서 sandbox 제외
- `checkDemotion()` portfolio mode에서도 sandbox 제외
- backtest engine도 `getMainPortfolioStats()` 사용

#### P1-3. blacklist와 reentry control 검증 ✅ (measurement infra)

- replay 후보를 runtime에 반영한 뒤 false block / 재발률 / expectancy 변화를 측정한다.
- `OPERATOR_TOKEN_BLACKLIST`의 효과를 live 표본에서 검증한다.

측정 인프라 완료:
- RiskManager.checkOrder()에서 9개 거절 포인트에 `RuntimeDiagnosticsTracker.recordRiskRejection()` 호출
- reentry control: `same_pair_block`, `per_token_cooldown`, `daily_trade_cap`, `portfolio_cooldown`, `edge_blacklist`, `max_concurrent`
- portfolio risk: `active_halt` (daily loss / drawdown halt)
- safety/sizing: `token_safety`, `zero_position_size`
- Daily Summary의 Data Plane 섹션에 `risk reject` 카운트 표시
- live 데이터 축적 후 차단 효과 분석 가능

#### P1-4. execution telemetry 해석 가능성 확보 ✅

- reject reason
- quote failure
- sell impact
- degraded exit trigger
- stale quote
- signal created but not admitted

를 전략별/경로별로 분리해 본다.

구현 완료:
- `SignalAuditLogger.getRecentStrategyFilterBreakdown(hours)` — 전략별 action(EXECUTED/FILTERED/STALE) 카운트 + FILTERED의 top reject reasons
- `DailySummaryReport.strategyTelemetry` 필드 추가
- Daily Summary에 "전략별 Telemetry (24h)" 섹션 추가: 전략별 total/exec/filtered + top 3 reject reasons
- `TradeStore.getExitReasonBreakdown(hours)` — 전략별 exit_reason 카운트 + 평균 PnL
- `DailySummaryReport.exitReasonBreakdown` 필드 추가
- Daily Summary에 "Exit Reason (24h)" 섹션 추가: 전략별 exit reason 분포 + 평균 PnL
- Degraded exit telemetry DB 스키마 + 저장 코드 추가: `degraded_trigger_reason` (sell_impact/quote_fail), `degraded_quote_fail_count`, `parent_trade_id` (부분 청산 parent-child 관계)
- `getRecentExecutedEntries()`에 `parent_trade_id IS NULL` 필터 추가 — child trade가 executed entry 표본을 오염하지 않도록 방지

완료 기준:

- `왜 안 들어갔는지`, `왜 손실이 났는지`, `왜 exit가 악화됐는지`를 사람이 설명 가능하다.
- ✅ degraded exit의 trigger 원인(sell_impact vs quote_fail)과 quote 실패 횟수가 DB에 기록되도록 구현됨. 단, `handleDegradedExitPhase1` 호출 경로는 `degradedExitEnabled=true` 활성화 + phase 1 trigger 연결 후 동작. 현재 dormant.
- ✅ 부분 청산 시 parent-child trade 관계가 `parent_trade_id`로 추적 가능하다.
- ✅ executed entry 표본에서 partial exit child trade가 제외된다 (`parent_trade_id IS NULL` 필터).

### P2. Breadth and External Context

아래는 P0/P1 이후에 진행한다.

#### P2-1. breadth 확장 실험

- watchlist/subscription을 단계적으로 늘린다.
- queue overflow, burst, churn, signal-not-in-watchlist, update drop을 같이 본다.
- breadth 확장은 provider 상한이 아니라 **내부 처리 안정성**과 함께 평가한다.

#### P2-2. organic context 추가

- Jupiter Tokens API의 `organicScore`, `recent`, category/stats는 hard gate가 아니라 soft ranking 후보로 검증한다.
- 구현 직전 API key / rate limit / 가격 체계를 다시 확인한다.

#### P2-3. Token-2022 분류/로깅 ✅

- hard reject 확대 전에 어떤 확장이 실제 손실/실행 실패와 연결되는지 먼저 축적한다.
- 최소한 `tokenProgram`, 주요 extension, simulation failure type을 로깅한다.

구현 완료:
- `TokenSecurityData`에 `tokenProgram`, `extensions` 필드 추가
- `parseExtensionNames()` 헬퍼로 Token-2022 extension 이름 파싱
- `evaluateSecurityGate()`에서 `TOKEN_2022`, `EXT_{name}` flag 자동 추가 (hard reject 아님, 로깅 전용)
- candleHandler/realtimeHandler에서 Token-2022 감지 시 log.info 출력

#### P2-4. core trigger 재도전 조건 정의 ✅ (P2-4a 기준 정의)

- bootstrap을 언제 유지하고
- core를 언제 다시 실험하며
- 두 경로를 어떤 표본 기준으로 비교할지

를 미리 정의한다.

구현 완료:
- `STRATEGY_NOTES.md`에 "Core Trigger Re-Challenge 기준 (P2-4a)" 섹션 추가
- Bootstrap 유지 조건, Core 재실험 전제, A/B 비교 방법, 전환 판정 기준, 롤백 조건 정의
- P2-4b~d (실제 A/B test, switchover)는 bootstrap 50+ trades 축적 후 진행

### P3. Deferred

현재 active 핵심이 아닌 항목:

- social / onchain intelligence platform
- Strategy D full live hardening
- Phase 3+ 복리화 전제 기능
- 공격적 Kelly / scale-up

이 항목들은 `5+ SOL`, 안정 수익, measurement closure 이후에 검토한다.

---

## Decision Rules

리포트 / PR / 운영 메모를 읽을 때 아래 규칙을 적용한다.

1. `문서 기준`이라고 쓰면 active docs 값과 일치해야 한다.
2. bootstrap 성과와 Strategy A 성과를 같은 전략 표본으로 합치지 않는다.
3. breadth 관련 주장은 backlog / queue / churn / backpressure 근거 없이 확정 결론으로 쓰지 않는다.
4. Mission metric은 closed-trade summary와 executed-entry gate를 분리해 적는다.
5. 새 전략 / 새 데이터 소스보다 attribution과 measurement closure를 먼저 처리한다.
6. default 값과 operator cap 값을 둘 다 `현재 기준`이라고 쓰지 않는다.
7. legacy contaminated sample을 미션 판단 지표에 재사용하지 않는다.

---

## Exit Criteria for This Refactor

이 문서를 기준선 문서로 확정할 수 있는 최소 조건은 아래다.

| # | 조건 | 현재 상태 | 연결 |
|---|------|----------|------|
| 1 | 전략 ID 분리가 완료되어 bootstrap/core/Strategy A contamination이 차단된다 | ✓ 완료 | P0-1 |
| 2 | wallet PnL vs DB PnL 차이가 비용 원인별로 설명 가능해진다 | ✓ 완료 | P0-2 |
| 3 | executed vs closed metric 이름이 코드/리포트에 반영된다 | ✓ 완료 | P0-3 |
| 4 | watchlist/subscription 값이 `runtime / operator cap / default`로 라벨링된다 | ✓ 완료 | P0-4 |
| 5 | legacy contaminated sample이 quarantine 또는 backfill 처리된다 | ✓ 완료 (retag 스크립트) | P0-1 연계 |

---

## P-New: Signal Attribution & Replay Quality (2026-04-05 구현 완료)

### Feature 1-4 Implementation (commit 076e1f4)

| Feature | 상태 | 수정 파일 | 비고 |
|---------|------|----------|------|
| MarketCap context in signal | ✓ 완료 | realtimeMeasurement.ts, realtimeHandler.ts | marketCapUsd, volumeMcapRatio 추가 |
| Signal-intent 즉시 기록 | ✓ 완료 | realtimeSignalLogger.ts, replayStore.ts, realtimeOutcomeTracker.ts | crash-safe persistence via signal-intents.jsonl |
| Strategy별 분리 집계 | ✓ 완료 | realtimeMeasurement.ts, realtimeShadowReport.ts | summarizeRealtimeSignalsByStrategy() |
| Zero-volume candle skip | ✓ 완료 | index.ts, microReplayEngine.ts | persist ~90% 감소, fillCandleGaps() 복원 |

### P-New-0: Sparse Data Insufficient 병목 (81%)

Feature 4(zero-volume skip)의 후유증으로 **전체 평가의 81%가 차단**되어 edge 측정 자체가 불가능.

현황:
- lookback window(20 bars × 10s = 200s) 내 연속 active candle 부족 → `sparseDataInsufficient`
- 4 sessions 중 1개만 edge pass (04-04, edgeScore 78), 나머지 reject
- 이것이 해소되지 않으면 나머지 모든 작업은 의미 없음

해결 방향:
1. `minActiveCandles` / `calcSparseAvgVolume` 로직 정량 분석
2. Lookback을 시간 기반(200s)에서 active candle 기반(최근 20 non-zero candle)으로 전환 검토
3. Persist 시 30초마다 anchor candle 삽입 (zero-volume이어도 close carry-forward)

### Strategy A/C 5m Dormancy (2026-04-05 확인)

4 sessions × 87 pairs × 3 strategies = 261 combination 중 **단 3건만 trade 발생**.
5m(300s) 해상도에서 밈코인 모멘텀(10-30s)을 포착하는 것이 구조적으로 불가능.
Session-backtest는 진단 도구로만 유지, edge 판단에 사용하지 않음.

---

## Current One-Line Conclusion

P0 measurement closure와 P-New Feature 1-4는 모두 완료됐다. 현재 **최대 병목은 sparse data insufficient 81%**로, edge 측정 자체를 가능하게 하는 것이 최우선. 5m Strategy A/C는 밈코인에 구조적 비적합으로 dormant 전환. bootstrap_10s가 유일한 유효 trigger이며, 04-04 세션의 edge 재현성 검증이 필요하다.

현재 남은 우선순위:

`Sparse 해소(P-New-0) → edge 재현성 확인 → paper 50-trade → live enablement`
