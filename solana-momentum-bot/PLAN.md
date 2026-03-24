# PLAN.md

> Updated: 2026-03-24
> Mission: `1 SOL -> 100 SOL`
> One-line definition: 설명 가능한 진입만 하고, 작은 손실로 오래 살아남아, 증명된 엣지만 천천히 복리화한 봇
> Principle: 운영 안정화는 목적이 아니라 전제조건이며, live를 계속 운영하되 사명 적합도와 실전 입증을 우선한다.
> Relationship: `PLAN.md`는 상위 mission roadmap이고, `PLAN2.md`는 현재 코드 기준의 보완 과제 검토 문서다.

---

## 1. Operating Principles
모든 개선 작업은 이 원칙에 위배되지 않아야 한다. 위반 감지 시 해당 개선은 롤백하거나 중단한다.
### Tier 1 — 위반 시 즉시 정지
**P1. 설명 없는 급등을 사지 않는다**
- 이 봇의 존재 이유다.
- live 경로에서는 `requireAttentionScore=true`가 기본값이다.
- source attribution 또는 Attention/Event context가 없는 진입은 성공으로 해석하지 않는다.
- 참조: [MEASUREMENT.md](./MEASUREMENT.md), `Mission Gate`
- 코드 근거: [liveGateInput.ts](./src/gate/liveGateInput.ts)
**P3. 사이징은 아주 천천히 키운다**
- 수익 극대화보다 파산 방지와 복리 지속이 우선이다.
- Risk Tier(`Bootstrap -> Calibration -> Confirmed -> Proven`)와 drawdown guard를 따른다.
- 연패 쿨다운(`maxConsecutiveLosses=3`, `cooldownMinutes=30`)은 이미 구현돼 있다.
- 수동 공격적 사이징을 계획 문서의 기본값으로 두지 않는다.
- 참조: [MEASUREMENT.md](./MEASUREMENT.md), `Edge Gate`
- 코드 근거: [riskManager.ts](./src/risk/riskManager.ts), [config.ts](./src/utils/config.ts)
### Tier 2 — 위반 시 검토 후 조치
**P2. 후보 선정(Context)과 진입 Trigger를 분리한다**
- Context는 "왜 볼 만한가", Trigger는 "지금 들어가도 되는가"다.
- 브레이크아웃은 전략이 아니라 진입 트리거로만 사용한다.
- Trigger 튜닝보다 Context 품질 개선이 우선이다.
- 참조: [PROJECT.md](./PROJECT.md), [MEASUREMENT.md](./MEASUREMENT.md), `Mission Gate`
**P4. 실행 품질을 edge보다 먼저 본다**
- quote decay, sell impact, fill realism을 통과하지 못하면 백테스트 수익은 의미가 없다.
- 새 전략 추가보다 기존 전략의 execution quality 개선이 우선이다.
- 참조: [MEASUREMENT.md](./MEASUREMENT.md), `Execution Gate`
**P5. 전략 추가보다 승자만 남기는 운영을 한다**
- live에서 attribution과 expectancy가 증명된 경로만 유지한다.
- 전략별 독립 측정 없이 전략 수를 늘리지 않는다.
- 새 전략은 기존 경로가 안정적으로 증명된 뒤에만 검토한다.
- 참조: [MEASUREMENT.md](./MEASUREMENT.md), `Edge Gate`
**P6. Measurement를 운영의 중심에 둔다**
- "요즘 잘 된다"는 운영 판단 근거가 아니다.
- gate 통과와 score 해석은 반드시 `MEASUREMENT.md` 기준을 따른다.
- live를 계속 운영하더라도 승격 해석은 측정 표본이 확보됐을 때만 한다.
- 참조: [MEASUREMENT.md](./MEASUREMENT.md), `Current Snapshot`, `Composite Score`

---

## 2. Current Bottlenecks
- [완료] live runtime은 현재 기동 가능 상태다.
- [완료] `Helius WS -> realtime -> trigger -> measurement` 경로는 연결돼 있다.
- [완료] PM2 `fork` 모드 전환과 retry/reconnect/alert 품질 개선이 반영됐다.
- [부족] `Mission Gate`를 판정할 live executed-trade 표본이 아직 부족하다.
- [부족] `Execution Gate`를 판정할 안정 운영 구간과 measured trade/exit 표본이 부족하다.
- [완료] `Security Gate`의 Birdeye security dependency는 Helius RPC 온체인 조회로 대체됐다.
- [부족] `GeckoTerminal`이 아직 `trending / OHLCV backfill / regime / spread proxy`에 남아 있어 `429` 리스크가 있다.
- [부족] Birdeye는 이제 Strategy D의 optional event provider와 일부 legacy fetch / 운영 문서에 주로 남아 있다. 다만 scanner/Strategy D fallback은 Dex boosts + Dex latest token profiles/community takeovers/ads, 분리된 Dex discovery cadence, open-slot trending fallback, discovery source attribution persistence와 함께 Birdeye 없이도 성립한다.
- [부족] 후보 선정 품질보다 외부 데이터 plane 제약이 먼저 운영 결과를 흔들 수 있다.
핵심 해석:
- 지금 병목은 "전략이 없음"이 아니다.
- 지금 병목은 `mission proof 부족 + Gecko 의존 + Birdeye 잔존 의존 + 운영 표본 부족`이다.

---

## 3. Roadmap
### Horizon 1: Mission-Proof Live Bootstrap
목표:
- live를 계속 운영하면서도 사명 위반 없이 표본을 쌓는다.
- signal이 vendor-specific security data 부재 때문에 초입에서 전량 차단되지 않도록 한다.
- `후보 -> gate -> trigger -> entry -> exit` traceability가 빠짐없이 남는다.
- execution telemetry를 신뢰할 수 있는 수준으로 안정화한다.
작업:
| # | 작업 | 원칙 | 완료 기준 |
|---|---|---|---|
| 1-0 | Birdeye dependency unwind | P1, P4 | `Security Gate` blocker 해소 + scanner/runtime의 Birdeye 잔존 의존 축소 |
| 1-1 | live runtime 안정 구간 확보 | P4, P6 | `Execution Gate`의 stability 해석 가능한 운영 구간 확보 |
| 1-2 | attribution completeness 점검 | P1, P6 | source attribution + AttentionScore + gate trace가 signal/audit/position/trade/report 경로에 남는다 |
| 1-3 | realtime measurement 표본 축적 | P4, P6 | measured signal/outcome 누적, telemetry 해석 가능 |
| 1-4 | Gecko 호출량 절감 | P4, P6 | `429`가 live 해석을 방해하지 않는 수준으로 감소 |
비고:
- 현재 live 경로는 이미 `requireAttentionScore=true`다. 이 항목은 "적용"이 아니라 "지속 확인" 대상이다.
### Horizon 2: First Gate-Proven Sample
목표:
- live 표본으로 `Mission Gate / Execution Gate / Edge Gate`를 처음 판정 가능한 상태로 만든다.
- 승격 판단을 감이 아니라 문서 기준으로 내릴 수 있게 한다.
작업:
| # | 작업 | 원칙 | 완료 기준 |
|---|---|---|---|
| 2-1 | executed trade 표본 축적 | P1, P6 | `Mission Gate` 판정 가능한 표본 확보 |
| 2-2 | measured trade/exit 표본 축적 | P4, P6 | `Execution Gate` 판정 가능한 표본 확보 |
| 2-3 | 전략별 attribution 리포트 정리 | P2, P5, P6 | 어떤 경로가 실제 승자인지 분리 가능 |
| 2-4 | 첫 공식 gate 판정 수행 | P6 | `MEASUREMENT.md` 기준으로 상태 판단 |
비고:
- live를 계속 운영하되, gate 실패 시 성공처럼 해석하지 않는다.
- 필요 시 controlled paper 구간은 보조 검증 수단으로만 사용한다.
### Horizon 3: Live Survival Proof
목표:
- 작은 자본으로도 파산 방지와 운영 일관성을 입증한다.
진입 조건:
- `Mission Gate` 통과
- `Execution Gate` 통과
- `Edge Gate`가 최소 채택 조건 충족
### Horizon 4: Compound Carefully
목표:
- 증명된 경로만 천천히 복리화한다.
진입 조건:
- 전략별 기대값이 반복 확인됨
- Risk Tier가 상향 가능한 상태
- execution quality가 유지됨
### Horizon 5: Scaling Toward 100 SOL
목표:
- 검증된 시스템을 더 크게 운용하되, 사명 위반 없이 복리를 지속한다.
진입 조건:
- Proven 수준의 누적 표본
- `Composite Score`가 반복 구간에서 유지됨
- 운영 개입 없이도 시스템이 안정적으로 지속됨
Horizon 3~5의 상세 작업은 해당 단계 진입 시점의 데이터를 기준으로 별도 문서화한다.
---
## 4. Near-Term Focus
지금 당장 우선순위는 아래 다섯 가지다.

1. scanner/runtime에서 Birdeye 잔존 의존을 단계적으로 제거한다.
2. live 표본을 쌓을 수 있을 만큼 안정적으로 운영한다.
3. `Mission Gate`를 판정할 수 있도록 attribution과 traceability를 보강한다.
현재 상태:
- scanner discovery는 이제 fast Gecko `new_pools` + Dex boosts/profiles/community takeovers/ads + slower open-slot Gecko trending fallback 구조다.
- discovery source attribution은 scanner fallback -> Strategy D signal/order -> signal audit / trade store / paper metrics summary까지 기록된다.
- AttentionScore / gate trace도 signal audit log와 position signal_data에 snapshot으로 저장된다.
- source별 live outcome은 daily summary에서 `trades / win rate / pnl by source`로 확인할 수 있다.
4. `GeckoTerminal` 호출량을 줄여 live 해석 품질을 높인다.
5. realtime/outcome/executed trade 표본을 누적해 첫 gate 판정을 수행한다.
한 줄로 말하면:
> 지금은 수익을 키우는 단계가 아니라, `시그널이 gate를 통과해 표본이 남도록 만들고 사명에 맞는 live 표본으로 첫 공식 판정을 통과하는 단계`다.
---
## 5. Circuit Breaker
아래 중 하나라도 발생하면 즉시 공격적 해석을 중단하고, 필요 시 live 강도를 낮추거나 검증 모드로 복귀한다.

| 조건 | 근거 |
|---|---|
| `Mission Gate` 실패 | P1, [MEASUREMENT.md](./MEASUREMENT.md) |
| `Execution Gate` 실패 | P4, [MEASUREMENT.md](./MEASUREMENT.md) |
| `Edge Gate` 실패 | P3, P5, [MEASUREMENT.md](./MEASUREMENT.md) |
| drawdown guard 또는 daily loss halt 미작동 | P3, [riskManager.ts](./src/risk/riskManager.ts) |
| live runtime 장애가 gate 해석을 오염시킬 정도로 반복 | P4, P6 |
---
## 6. What Not To Do Now
- 전략 수를 더 늘리는 일
- measurement 없이 파라미터만 반복 조정하는 일
- `Helius` 업그레이드만으로 `Gecko 429`가 해결된다고 가정하는 일
- VPS 증설을 데이터 plane 문제보다 먼저 해결책으로 보는 일
- live라는 이유로 `Mission Gate` 미충족 상태를 성공처럼 해석하는 일
- traceability가 불완전한 trade를 성과 표본에 그대로 포함해 미화하는 일
---
## 7. Document Hierarchy
| 문서 | 역할 | 이 문서와의 관계 |
|---|---|---|
| [PROJECT.md](./PROJECT.md) | 봇의 정체성, 전략 모델, 비목표 | 상위 문서. 충돌 시 이 문서를 수정한다 |
| [MEASUREMENT.md](./MEASUREMENT.md) | 정량 기준, Gate 해석, Score 정책 | 참조 문서. 수치는 여기 기준을 따른다 |
| [OPERATIONS.md](./OPERATIONS.md) | 배포 및 운영 절차 | 실행 문서. 운영 명령은 여기 기준을 따른다 |
| 이 문서 | 왜, 어떤 순서로, 어떤 원칙 아래 개선하는가 | mission-first 로드맵 문서 |

---

## One-Line Summary

> 지금 사명에 더 가까워지는 길은 `live를 계속 돌리되, 시그널이 gate를 통과할 수 있는 최소 데이터 경로를 확보하고 설명 가능한 진입과 traceability를 지키면서 첫 공식 gate 판정을 통과하는 것`이다.
