# Ralph Loop — Paper Runtime 안정화

> Created: 2026-03-21
> Mode: `ralph-loop`
> Goal: paper runtime을 50-trade 검증 가능한 상태로 안정화한다.
> Mission fit: 설명 가능한 후보만 안정적으로 추적하고, 무인 paper 운영에서 데이터 연속성과 성과 추적을 먼저 확보한다.
> Document type: execution loop record
> Authority: historical loop spec. 현재 paper 운영 기준은 `OPERATIONS.md`와 `docs/product-specs/paper-validation.md`를 우선한다.

---

## Loop Inputs

- `goal`: paper runtime 안정화 + paper validation 시작 조건 충족
- `max_iterations`: 6
- `validation_commands`:
  - `npm run build`
  - `npm test -- --runTestsByPath test/tradeExecution.test.ts test/geckoTerminalClient.test.ts test/scannerEngine.test.ts test/universeEngine.test.ts`
  - runtime observation:
    - `pgrep -af "node dist/index.js"`
    - `rg -n "429|No candle received|Poll failed|Dynamic pair added|candidateDiscovered|evicted" logs`
    - `npx ts-node scripts/paper-report.ts` when enough trades exist
- `stop_condition`:
  - 6시간+ paper run에서 데이터 연속성 안정
  - `paperBalance`와 paper report가 현실적으로 누적
  - 50-trade 수집을 시작할 만한 trade cadence 확보

---

## 현재 사실

### 확인된 것

- `paperBalance` 미갱신은 실제 버그였고 수정 완료.
- Edge/risk tier는 `paperBalance`가 아니라 closed trade history 기반이다.
- Ingester는 이미 startup gap, stable offset, recursive `setTimeout` 분산이 들어가 있다.
- 남은 병목은 Ingester 단독보다 `EventMonitor + Regime + Ingester` 합산 Gecko 부하다.

### 현재 남은 리스크

- Gecko `429`가 아직 완전히 0이 아니다.
- `No candle received` 경고가 다시 나오는지 장시간 관찰이 필요하다.
- paper DB/HWM baseline이 오염돼 있을 가능성이 있다.
- free-cash ledger는 아직 없다. 현재는 realized PnL 반영까지만 되어 있다.

---

## Loop Protocol

### Iteration 1: Baseline Observation

- `what_changed`: 코드 변경 없이 현재 패치 상태로 paper 재시작
- `validation_result`:
  - 6시간 이상 run
  - `429/hour`, `Poll failed`, `No candle received`, `Signal`, `Trade`, `paperBalance` 변화 수집
- `next_step`:
  - 429가 높으면 Iteration 2
  - signal은 있으나 trade가 너무 적으면 Iteration 3
  - trade cadence가 충분하면 Iteration 5

### Iteration 2: Gecko Load Reduction

- `trigger`:
  - `429 > 10/hour`
  - `Poll failed` 또는 candle lag가 반복
- `change_budget`: Gecko 호출 소스 하나만 줄인다.
- `candidate_changes`:
  - EventMonitor와 Scanner의 trending 캐시 공유 강화
  - regime poll 간격/캐시 재조정
  - 운영 watchlist를 `8 -> 6`으로 임시 축소
- `validation_result`:
  - build/test 통과
  - 3~6시간 run에서 `429`와 candle lag 재측정
- `stop_if`:
  - `429 < 5/hour` and candle continuity acceptable

### Iteration 3: Gate / Cadence Tuning

- `trigger`:
  - signal은 생성되는데 trade가 거의 없음
  - 24시간 run에도 trade cadence가 paper validation에 너무 부족
- `change_budget`: 파라미터 하나만 완화
- `candidate_changes`:
  - `minBreakoutScore` 소폭 완화
  - `minBuyRatio` 소폭 완화
  - age hard floor 소폭 완화
- `validation_result`:
  - build/test 통과
  - 다음 6시간 run에서 `Signal -> Trade` 전환율 비교
- `guardrail`:
  - 한 번에 하나만 바꾸고, 설명 불가능한 진입 비율이 올라가면 즉시 롤백

### Iteration 4: Paper Ledger Accuracy

- `trigger`:
  - equity tier 2+ 진입이 가까움
  - concurrent sizing 또는 free cash 왜곡이 실제 문제로 관찰됨
- `change_budget`: paper accounting 하나만 확장
- `candidate_changes`:
  - 진입 시 cash 차감
  - 청산 시 proceeds 복원
  - session baseline/HWM 분리
- `validation_result`:
  - paper report와 로그의 balance/equity가 일관적인지 확인
- `note`:
  - 현재는 realized PnL 반영까지만 되어 있으므로 이 단계는 조건부다.

### Iteration 5: Baseline Reset + Long Run

- `trigger`:
  - 데이터 연속성은 안정적이나 baseline/HWM 오염이 남아 있음
- `what_changed`:
  - paper DB/session baseline 정리
  - 새 session marker로 24~72시간 장기 run
- `validation_result`:
  - `paper-report` 기준 50-trade 축적 시작
  - expectancy, TP1 hit rate, explained entry ratio 추적

### Iteration 6: Exit Decision

- `stop_condition_met`:
  - 50-trade 검증 루프로 넘어간다.
- `stop_condition_not_met`:
  - 남은 병목을 `PLAN3` 또는 tech-debt로 분리하고 종료한다.

---

## Runtime Success Criteria

### Stability

- `429 < 5/hour`
- `Poll failed` 거의 0
- `No candle received` 경고가 반복되지 않음
- watchlist churn이 통제됨

### Cadence

- `Signal >= 1/hour`
- `Trade >= 1/6 hours`를 최소 기준으로 본다.
- `50 trades in 1~2 hours` 같은 낙관적 가정은 사용하지 않는다.

### Validation Readiness

- `paperBalance`가 realized PnL을 반영한다.
- `npx ts-node scripts/paper-report.ts` 결과가 baseline과 모순되지 않는다.
- `docs/product-specs/paper-validation.md` 기준의 50-trade 수집이 현실적인 cadence로 시작된다.

---

## Iteration Report Template

매 반복 종료 시 아래 3줄만 기록한다.

- `what_changed`: 이번 반복에서 바꾼 것 1개
- `validation_result`: build/test/runtime 관찰 결과
- `next_step`: 다음 반복에서 할 일 또는 종료 판단

---

## Exit Rules

- 6회 초과 반복 금지
- 같은 원인의 429/lag를 두 번 연속 같은 방식으로 고치지 않음
- 설명 불가능한 진입 비율이 올라가면 cadence보다 설명 가능성을 우선
- live 전환 판단은 이 문서 범위가 아니다. 이 문서는 paper 안정화까지만 다룬다.
