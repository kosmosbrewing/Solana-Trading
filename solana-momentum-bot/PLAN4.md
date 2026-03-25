# PLAN4.md

> Updated: 2026-03-25
> Purpose: `PLAN3` 이후 live canary의 **현재 해석과 다음 운영 계획**을 mission 관점으로 재정리한다.
> Scope: 이번 문서는 "왜 아직 사명을 평가할 수 없는가"와 "무엇을 먼저 검증해야 하는가"만 다룬다.
> Relationship: `PLAN3.md`가 quote endpoint/runtime drift를 다뤘다면, 이번 문서는 그 이후 남은 **cadence / coverage / mission-readiness** 문제를 다룬다.

---
## Verdict
- `quote-api.jup.ag` DNS 문제는 현재 프로세스 구간에서는 active blocker가 아니다.
- 하지만 그렇다고 mission이 검증된 것은 전혀 아니다. 지금 live canary는 **수익성 검증 단계가 아니라 cadence 진단 단계**다.

- `2026-03-24 22:38:53 UTC` 재시작 이후
  - `quote_rejected = 0`
  - `ENOTFOUND quote-api.jup.ag = 0`
  - `Signal: BUY = 1`
  - `Signal filtered = 1`
  - `trades = 0`
- 유일한 BUY 1건은 `security_rejected: Token is freezable`로 차단됐다.
- 같은 구간에서 realtime skip은 `unsupported_dex = 5`, `non_sol_quote = 1`이었다.

> 지금 문제는 "quote가 죽어서 0 trade"가 아니라, "mission을 검증할 만큼 trade cadence가 아직 나오지 않는다"는 점이다.

---
## Confirmed Facts

### F1. `PLAN3`의 quote blocker는 현재 구간에서 operationally improved다
- `quote_rejected = 0`
- `ENOTFOUND quote-api.jup.ag = 0`
- 따라서 `Jupiter quote endpoint / runtime setting drift`는 현재 next-step 1순위 blocker에서 내린다.

### F2. live canary는 아직 alpha를 검증하지 못했다
- `trades = 0`
- closed trade sample = `0`
- expectancy after fees/slippage
- win rate by gate path
- candidate-to-trade conversion quality
- paper/live execution gap
- 지금 단계에서 "가능하다 / 불가능하다"를 강하게 단정하면 표본보다 해석이 앞선다.

### F3. 다만 `12시간 0 entry`는 무시할 수 없는 cadence 경고다
- `Signal >= 1/hour`
- `Trade >= 1/6 hours`
- 이 기준은 현재 단계에서 **paper/live 공통 운영 휴리스틱**으로 사용한다.
- `한 번의 12h 0 entry`만으로 mission failure를 선언하지는 않는다.
- 하지만 같은 패턴이 반복되면 cadence blocker로 승격한다.

### F4. post-restart 현재 관측된 차단 요인은 `freezable`과 `unsupported_dex`다
- 실제 BUY signal 1건 → `Token is freezable` hard reject
- realtime admission skip:
  - `TARO`: `unsupported_dex` 4회
  - `MOVING`: `unsupported_dex` 1회
  - `dapang`: `non_sol_quote` 1회
- `freezable`은 보안 철학상 정상 hard reject다.
- `freezable`은 cadence를 위해 완화할 대상이 아니라, 유지해야 할 의도된 차단이다.
- 더 운영적으로 중요한 낭비는 discovery/watchlist에 올라왔지만 realtime admission에서 뒤늦게 탈락하는 `unsupported_dex`다.

### F5. discovery와 realtime admission 사이에 구조적 mismatch가 있다
- discovery/ingester 준비는 DexScreener pair를 최고 유동성 기준으로 먼저 본다.
- realtime admission은 그 다음에야 지원 DEX / SOL quote / pool owner 조건으로 거른다.
- watchlist에는 올라오지만
- realtime에서는 `unsupported_dex` 또는 `non_sol_quote`로 탈락하는 후보가 생긴다.
- 이는 alpha 문제라기보다 **candidate pipeline quality 문제**다.

### F6. `PLAN3`의 runtime drift 경계는 아직 유효하다
- 현재 `quote blocker` 해소 해석은 **현 프로세스 구간**에 대해서만 유효하다.
- stale build / stale env / legacy process가 다시 섞이면 같은 증상이 다른 이름으로 재발할 수 있다.
- 따라서 runtime drift 의심이 생기면 `PLAN3`의 stale process / runtime verification을 다시 연다.

### F7. Gecko `429`는 사라진 문제가 아니라 cadence 해석을 오염시킬 수 있는 병행 리스크다
- 현재 문서의 핵심은 cadence와 admission quality지만, GeckoTerminal `429`는 아직 data-plane 리스크다.
- 즉 `0 trade`를 모두 gate/admission 문제로만 해석하면 안 된다.
- watchlist churn, poll continuity, candle continuity와 함께 봐야 cadence 해석이 오염되지 않는다.

---
## What This Means For Mission

### M1. 지금 live canary는 "돈을 버는가?"보다 "검증 가능한 속도로 표본이 쌓이는가?"를 먼저 봐야 한다
- trade가 없으면 expectancy를 증명할 수 없다.
- expectancy를 증명하지 못하면 mission 달성 가능성도 증명할 수 없다.
> "이 설정으로 검증 가능한 trade cadence가 나오는가?"

### M2. 현재까지 증명된 것은 수익성이 아니라 fail-closed discipline이다
- quote DNS failure는 사라졌다.
- freezable token은 막는다.
- unsupported realtime venue는 admission에서 제외한다.
- 이건 중요한 진전이지만, 아직 증명된 것은 "위험한 진입을 막는 파이프라인"이지 "양의 기대값을 만드는 엔진"은 아니다.

### M3. 지금 phase의 목표는 mission 달성이 아니라 mission-readiness 확보다
1. candidate quality 개선
2. trade cadence 확보
3. 50-trade 검증으로 넘어갈 수 있는 운영 속도 확보
4. expectancy 검증
5. live bootstrap
6. 복리 성장

---
## Required Actions

### R1. `12h / 24h no-entry`를 공식 cadence alarm으로 승격
- `0 trade`를 단순 관찰이 아니라 운영 failure signal로 본다.
1. runtime summary에 `time_since_last_signal`, `time_since_last_trade` 추가
2. `12h no entry`, `24h no closed trade` 알림 기준 정의
3. signal / filtered / trade count를 rolling window로 남김
- 완료 기준: "왜 아직 0 trade인가"를 매번 수동 로그 확인 없이 바로 볼 수 있다.

### R2. rejection mix를 cadence 관점으로 집계
- `0 trade`의 원인을 alpha와 운영 경로로 분리한다.
- `unsupported_dex`
- `non_sol_quote`
- `unsupported_pool_program`
- `security_rejected: Token is freezable`
- `security_rejected: Token security data unavailable`
- `quote_rejected`
- `429/hour`
- `poll failed / no candle received`
- 완료 기준: `0 trade`가 signal 부족인지, watchlist 품질 문제인지, gate fail-closed인지, execution 문제인지 바로 분류 가능하다.

### R3. discovery → realtime admission mismatch 줄이기
- realtime에서 어차피 못 받을 후보를 discovery/watchlist 단계에서 더 일찍 거른다.
1. **realtime mode 기준으로** discovery/watchlist 단계에서 realtime 미지원 DEX pair를 미리 제외하거나 강한 감점 적용
2. supported realtime dex/SOL quote 후보를 discovery ranking에 반영
3. `Realtime skipped ... unsupported_dex` 로그에 실제 `dexId` 포함
4. unsupported skip의 token / dex / source 분포를 daily summary에 남김
5. watchlist churn 대비 realtime-eligible ratio 측정
- 완료 기준:
  - `unsupported_dex`가 watchlist 슬롯 낭비 요인인지 수치로 확인 가능
  - post-restart 기준 `unsupported_dex` 발생률이 유의미하게 내려간다.

### R4. cadence blocker와 alpha blocker를 분리해서 다룬다
- `freezable`은 정책 완화 대상이 아니다.
- `unsupported_dex`는 alpha 부족이 아니라 pipeline quality 문제다.
- `Gecko 429`와 candle discontinuity는 별도 data-plane 리스크로 분리한다.
- `0 trade`를 곧바로 전략 무효로 해석하지 않는다.
- 반대로 `0 trade`가 반복되는데도 "아직 이르다"만 반복하지도 않는다.
1. `12h no entry` 1회:
   - 경고, 원인 분해 시작
2. `12h no entry` 반복 또는 `24h no trade`:
   - cadence blocker로 공식 승격
3. cadence 확보 후에도 expectancy 음수:
   - 그때 전략/파라미터 문제로 분류

### R5. runtime drift 재검증 조건을 남긴다
1. startup snapshot이 예상 env/runtime과 다르게 보일 때
2. 이미 해결된 `quote_rejected` / `NO_SECURITY_DATA` 패턴이 재발할 때
3. 로그 source와 현재 프로세스 구간이 맞지 않는 의심이 생길 때
- 완료 기준: 위 조건에서는 `PLAN3`의 runtime drift 검증을 다시 여는 규칙이 명시된다.

### R6. mission readiness의 최소 통과 조건을 다시 고정
1. `Signal >= 1/hour` 대략 충족
2. `Trade >= 1/6 hours` 대략 충족
3. 50-trade 수집이 현실적인 속도로 시작
4. explained entry 비율 유지
5. expectancy 계산 가능한 closed trade sample 확보
- 완료 기준: "이제는 phase 2 validation을 논해도 된다"는 운영 합의가 가능해진다.

---
## Priority
1. `12h / 24h no-entry` cadence telemetry 추가
2. rejection mix + `429/candle continuity` daily summary 추가
3. discovery/watchlist 단계의 `unsupported_dex` 사전 제외 + `dexId` 로그 보강
4. watchlist quality / churn 대비 realtime-eligible ratio 측정
5. runtime drift 재검증 조건 명시
6. 그 뒤에만 gate 파라미터나 전략 cadence 완화 검토

---
## Non-Goals
- 현재 표본만으로 mission success/failure를 단정하는 일
- `freezable` hard reject를 완화하는 일
- `0 trade`를 곧바로 전략 무효로 해석하는 일
- quote blocker가 사라졌다는 이유만으로 live readiness를 선언하는 일
- cadence 문제를 alpha 문제와 섞어 해석하는 일

---
## One-Line Summary
> `PLAN3` 이후의 핵심 문제는 quote DNS가 아니라, live canary가 아직 mission을 검증할 만큼 trade cadence를 만들지 못한다는 점이다. 다음 작업은 전략 튜닝보다 먼저 `0 trade`의 구조적 원인을 telemetry와 admission quality 관점에서 드러내는 것이다.
