# PLAN.md

> Updated: 2026-03-30
> Mission: `1 SOL -> 100 SOL`
> Role: 상위 mission roadmap
> Relationship: 현재 운영 해석은 [`PLAN4.md`](./PLAN4.md), 세부 historical note는 [`20260331.md`](./20260331.md)를 우선한다.

## Operating Principles

### P1. 설명 없는 급등을 사지 않는다
- live 기본은 `requireAttentionScore=true`다.
- source attribution 또는 context 없는 진입은 성공으로 해석하지 않는다.

### P2. Context와 Trigger를 분리한다
- Context는 왜 볼 만한가, Trigger는 지금 들어가도 되는가다.
- 브레이크아웃은 진입 트리거이지 알파 전체가 아니다.

### P3. 측정 없이 승격하지 않는다
- `Mission Gate`, `Execution Gate`, `Edge Gate`를 통과하기 전까지 live는 bootstrap 해석으로만 본다.

### P4. 실행 품질을 먼저 고친다
- quote decay, sell impact, price impact, telemetry 정합성이 확보되지 않으면 성과 해석을 보류한다.

### P5. 전략 수보다 검증된 경로를 우선한다
- 승자인지 증명되지 않은 경로를 늘리지 않는다.

## Current Bottlenecks

- 인프라 블로커는 해소됐다.
- 전략이 완전히 죽은 것은 아니다. 과거 baseline에서 12건 체결은 있었다.
- 하지만 cadence는 아직 안정적으로 증명되지 않았다.
- 현재 핵심 blocker는 아래 4개다.

1. `effectiveRR` gate가 pre-gate 단계에서 완전 차단을 만드는지 여부
2. pair blacklist와 scanner 재유입이 cadence를 다시 죽이는지 여부
3. Gecko `429`와 unsupported venue churn이 watchlist 품질을 얼마나 훼손하는지
4. 새 telemetry 패치 이후 BUY 시그널 표본이 아직 없어서 진짜 blocker를 재확인하지 못했다는 점

## Current Roadmap

### Horizon 1. Explainable Live Bootstrap
- 목표: live를 계속 운영하면서도 설명 가능한 진입과 traceability를 유지한다.
- 완료 기준:
  - signal / gate / risk / execution / exit trace가 일관되게 남는다.
  - `execution.preGate` / `execution.postSize` 비교가 restart 후에도 분석 가능하다.

### Horizon 2. First Reliable Edge Diagnosis
- 목표: `poor_execution_viability`의 직접 원인을 분리한다.
- 완료 기준:
  - 첫 post-patch BUY 시그널에서 pre-gate vs post-size RR 비교 확보
  - blacklist pair 재유입 여부 확인
  - round-trip cost / TP2-SL 구조 중 어느 쪽이 실제 blocker인지 구분

### Horizon 3. Gate-Proven Sample
- 목표: 50-trade를 의미 있게 쌓는다.
- 진입 조건:
  - cadence가 다시 살아난다.
  - `Edge Gate`를 왜곡하는 운영 노이즈가 분리된다.

### Horizon 4. Survival Proof
- 목표: 기대값과 리스크 관리가 동시에 반복 확인된다.

### Horizon 5. Compound Carefully
- 목표: 검증된 경로만 천천히 키운다.

## Near-Term Focus

1. 첫 BUY 시그널이 다시 나오도록 런타임을 더 관찰한다.
2. BUY 발생 시 `execution.preGate` / `execution.postSize` snapshot을 우선 확인한다.
3. 동일 loser pair가 blacklist 상태로 scanner/watchlist를 반복 점유하는지 확인한다.
4. Gecko `429`와 unsupported venue churn은 alpha blocker와 분리해서 기록한다.
5. telemetry가 확보되기 전에는 RR threshold, TP2, blacklist 완화 같은 파라미터 조정을 서두르지 않는다.

## What Not To Do

- 표본 없이 RR threshold를 낮추는 것
- blacklist를 감으로 완화하는 것
- `Gecko 429`를 곧바로 전략 실패로 해석하는 것
- 12-trade baseline만으로 수익성 결론을 확정하는 것
- 새 BUY 표본 없이 2차, 3차 파라미터 튜닝을 반복하는 것

## One-Line Summary

> 지금 단계의 일은 더 많은 기능을 만드는 것이 아니라, post-patch live canary에서 첫 BUY 표본을 확보해 실제 blocker가 `pre-gate RR`, `post-size RR`, `blacklist`, `data-plane noise` 중 무엇인지 분리하는 것이다.
