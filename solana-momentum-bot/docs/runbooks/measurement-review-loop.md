# Measurement Review Loop Runbook

> Last updated: 2026-04-05
> Scope: heartbeat / daily summary / realtime signals / paper validation / mission-execution-edge 해석 순서 고정
> Primary refs: [`MEASUREMENT.md`](../../MEASUREMENT.md), [`OPERATIONS.md`](../../OPERATIONS.md), [`docs/product-specs/paper-validation.md`](../product-specs/paper-validation.md)

## Role

이 문서는 `backtest 결과`, `paper/live 운영 스냅샷`, `mission/execution/edge score`를 섞지 않고 읽기 위한 runbook이다.

- heartbeat를 먼저 본다
- daily summary와 ops-bot report를 본다
- `realtime-signals` / paper validation을 본다
- Mission / Execution / Edge를 같은 의미로 해석한다
- 다음 액션을 `운영 문제`, `측정 문제`, `전략 문제` 중 어디에 둘지 연결한다

이 문서는 전략 backtest 문서가 아니다.
`bootstrap_10s`, `core 5m`, `historical replay` 절차는 각각의 runbook을 따른다.

---

## Standard Loop

반복 루프는 아래 순서로 고정한다.

1. heartbeat / ops-bot snapshot 확인
2. daily summary 확인
3. realtime signal outcome 확인
4. paper validation / stage score 확인
5. Mission / Execution / Edge 중 어느 층의 문제인지 판정
6. live enablement / strategy 수정 / instrumentation 보강 중 다음 액션 결정

---

## 1. Heartbeat First

먼저 heartbeat 또는 ops-bot `/report`를 본다.

현재 heartbeat는 운영 스냅샷을 먼저 보여준다.

주요 해석 항목:

- 현재 잔액
- 오늘 거래 수
- 오늘 종료 거래 수
- 오픈 포지션 수
- 오늘 손익
- regime summary

이 단계의 목적:

- 지금 봇이 살아 있는지
- 지금 운용이 진행 중인지
- `거래 없음`이 진짜 0-trade인지, 단지 closed trade가 없는지 구분

주의:

- heartbeat는 전략 평가 문서가 아니다
- 먼저 `운영 스냅샷`으로 읽고, 그 다음 상세 리포트로 내려간다

---

## 2. Daily Summary / Ops Report

그 다음 daily summary 또는 ops-bot `/heartbeat`, `/report`를 본다.

여기서 보는 핵심은:

- status mix
- rejection mix
- source별 outcome
- 최근 closed trade 성과
- Mission 관련 요약 항목

먼저 구분할 것:

### A. 운영 문제

- crash
- uptime
- wallet/risk halt
- queue overflow
- alias miss

### B. 전략 문제

- signals는 많지만 adjusted가 음수
- 특정 token concentration
- flat/noise가 많음

### C. 측정 문제

- source attribution 누락
- explained entry ratio 해석 불가
- wallet PnL vs DB PnL 불일치

운영 문제면 전략 해석보다 복구가 먼저다.

---

## 3. Realtime Signal Outcome

`realtime-signals.jsonl`는 runtime signal outcome 원장이다.

여기서 보는 핵심:

- `strategy`
- `processing.status`
- `gate.rejected`
- `referencePrice`
- `estimatedCostPct`
- `horizons`
- `summary.mfePct / maePct`
- `context`

권장 질문:

1. signal 자체가 있었는가
2. `executed_*`와 `gate_rejected`, `risk_rejected`, `wallet_limit`가 어떻게 섞였는가
3. adjusted return이 raw와 얼마나 다른가
4. context가 실제로 남아 있는가

주의:

- `realtime-signals`는 signal 발생 즉시 로그가 아니라, horizon outcome이 닫힌 뒤 저장되는 outcome 원장이다
- 즉 `실시간 의사결정 직전 snapshot`과는 완전히 같지 않다

---

## 4. Paper Validation

paper 단계 판단은 `Edge-only`와 `partial composite`를 분리해서 읽는다.

핵심 문장은 [MEASUREMENT.md](../../MEASUREMENT.md)를 따른다.

- Backtest: `Edge Score`
- Realtime Shadow: `Edge-only score + execution telemetry`
- Paper: `Paper Stage Score`
- Live: `Composite Score` target

즉 지금 paper에서 봐야 하는 건:

- measured edge가 있는가
- execution telemetry가 버틸 만한가
- mission data가 일부라도 남는가

현재 구현 주의:

- Mission Score 자동화는 일부만 연결돼 있다
- `explainedEntryRatio`가 있어도 full Mission closure로 읽으면 안 된다
- Composite Score는 target state로 읽고, 현재 live hard requirement처럼 쓰지 않는다

---

## 5. Mission / Execution / Edge 판정 순서

### A. Mission

먼저 아래를 본다.

- explained entry ratio
- source attribution completeness
- context -> trigger traceability

이 단계에서 막히면:

- score가 좋아도 채택 판단을 서두르지 않는다
- instrumentation 보강이 먼저다

### B. Execution

그 다음 아래를 본다.

- uptime / crash
- quote / fill realism
- rejection quality
- automation readiness

이 단계에서 막히면:

- 전략이 아니라 운영 readiness 문제로 본다

### C. Edge

마지막으로 아래를 본다.

- net pnl
- expectancy
- profit factor
- drawdown
- sample size

Edge가 좋아도 Mission/Execution이 약하면 승격하지 않는다.

---

## 6. Decision Rules

### A. 운영 문제로 분류

아래면 전략 판단을 멈추고 운영 문제로 둔다.

- crash / uptime 문제
- queue overflow / alias miss
- wallet wiring / live preflight 문제
- heartbeat / ops report 자체가 비정상

### B. 측정 문제로 분류

아래면 instrumentation 보강이 먼저다.

- source attribution 누락
- explained entry ratio 해석 불가
- `marketCapUsd`, `volumeMcapRatio`, provenance 부족
- wallet PnL vs DB PnL 정합성 미해결

### C. 전략 문제로 분류

아래면 전략/필터 수정 후보로 둔다.

- signals는 충분한데 adjusted 음수
- flat/noise 비중이 큼
- 특정 token churn
- outlier dependence가 큼

---

## 7. Practical Reading Order

매번 같은 순서로 읽는다.

1. heartbeat
2. ops-bot `/report`
3. daily summary
4. `realtime-signals` / session replay
5. paper validation / stage score
6. Mission / Execution / Edge 중 어느 층의 실패인지 판정

이 순서를 지키면 아래 실수를 줄일 수 있다.

- 운영 장애를 전략 실패로 오해
- backtest 양수를 live readiness로 오해
- partial Mission metric을 full closure로 오해

---

## 8. Current Use

이 문서의 목적은 점수를 더 많이 만드는 게 아니다.

현재 우선순위는:

1. `운영 문제`, `측정 문제`, `전략 문제`를 섞지 않기
2. backtest / paper / live의 score 의미를 같은 이름으로 오해하지 않기
3. live enablement 판단 전에 measurement closure를 먼저 확인하기

즉 이 runbook은 새로운 score를 추가하는 문서가 아니라
`지금 있는 수치와 리포트를 어떤 순서로 읽어야 하는지`를 고정하는 문서다.
