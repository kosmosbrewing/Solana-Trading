# PLAN.md

> Status: current mission charter
> Updated: 2026-04-05
> Purpose: 이 저장소의 장기 목표, 운영 원칙, 문서 계층을 고정한다.
> Use with: [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md) for current active execution work, [`PLAN_CMPL.md`](./PLAN_CMPL.md) for archived plans.

## Role

이 문서는 "지금 당장 무엇을 할 것인가"를 세부적으로 지시하지 않는다.
대신 아래 3가지만 고정한다.

1. 이 봇이 무엇을 하려는가
2. 어떤 원칙으로 운영 판단을 내리는가
3. 하위 plan 문서를 어떻게 읽어야 하는가

즉:

- 현재 active execution work는 [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md)
- 완료된 plan / dated canary history는 [`PLAN_CMPL.md`](./PLAN_CMPL.md)
- 이 문서는 그 둘의 상위 헌장이다

## Mission

> 가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다.

최종 목표는 `1 SOL -> 100 SOL` 자체가 아니라,
설명 가능한 진입, 보수적 리스크 관리, 반복 가능한 기대값을 가진 자동화 경로를 만드는 것이다.

## Operating Principles

### P1. 설명 없는 급등을 사지 않는다

- 기본 경로는 `requireAttentionScore=true`를 전제로 해석한다.
- source attribution 또는 context가 빠진 진입은 성공 사례로 세지지 않는다.

### P2. Context와 Trigger를 분리한다

- Context는 "왜 봐야 하는가"
- Trigger는 "지금 들어가도 되는가"
- 브레이크아웃은 알파 전체가 아니라 진입 트리거다.

### P3. 측정 없이 승격하지 않는다

- `Mission Gate`
- `Execution Gate`
- `Edge Gate`

위 3축이 충족되기 전까지 live는 bootstrap 해석으로만 본다.

### P4. 실행 품질을 먼저 고친다

- quote decay
- sell impact
- execution viability telemetry
- gate trace 정합성

이 경로가 불안정하면 수익성 해석도 보류한다.

### P5. 전략 수보다 검증된 경로를 우선한다

- 새 전략 추가보다 현재 경로의 explainability와 replayability를 우선한다.
- 증명되지 않은 전략은 문서상 후보로 남을 수 있어도 운영 우선순위를 차지하지 않는다.

## Plan Hierarchy

### Layer 1. 상위 헌장

- [`PLAN.md`](./PLAN.md)
- 변하지 않는 mission, 원칙, 판정 구조

### Layer 2. 현재 active execution plan

- [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md)
- 현재 검증 순서와 실행 우선순위를 정한다

### Layer 3. completed archive

- [`PLAN_CMPL.md`](./PLAN_CMPL.md)
- 완료된 plan과 dated canary history를 모은 archive다

## Mission Horizons

### Horizon 1. Explainable Bootstrap

목표:
- signal -> gate -> risk -> execution -> exit trace가 일관되게 남는다.
- `execution.preGate` / `execution.postSize` 비교가 분석 가능하다.

### Horizon 2. First Reliable Diagnosis

목표:
- `poor_execution_viability`가 실제 blocker인지
- blacklist 재유입이 cadence를 죽이는지
- data-plane noise가 해석을 얼마나 오염시키는지

를 분리한다.

### Horizon 3. Gate-Proven Sample

목표:
- 충분한 trade/sample을 쌓아 Mission/Execution/Edge를 같은 프레임으로 읽는다.

### Horizon 4. Survival Before Compounding

목표:
- 기대값이 있어도 파산하지 않는 구조를 먼저 증명한다.

### Horizon 5. Compound Carefully

목표:
- 검증된 경로만 천천히 키운다.

## Decision Rules

### Do

- 현재 active 판단은 항상 최신 active execution plan으로 읽는다.
- historical 문서는 "왜 지금 이렇게 됐는가"를 이해할 때만 참고한다.
- 파라미터 조정보다 먼저 telemetry와 표본 부족 문제를 분리한다.

### Do Not

- 오래된 handoff를 현재 active blocker로 재승격하지 않는다.
- 표본 없이 RR threshold, TP 구조, blacklist를 감으로 완화하지 않는다.
- archived note를 source of truth처럼 읽지 않는다.

## One-Line Summary

> `PLAN.md`의 역할은 어떤 문서가 현재 active이고 어떤 문서가 archive인지를 고정하는 것이다.
