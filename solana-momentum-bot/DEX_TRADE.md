# DEX_TRADE.md

> Status: transition design
> Updated: 2026-04-18
> Role: 순수 DEX 트레이딩봇 전환 설계서
> Authority: subordinate to [`PLAN.md`](./PLAN.md), [`MEASUREMENT.md`](./MEASUREMENT.md), [`STRATEGY.md`](./STRATEGY.md)
> Pivot source: [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md)
> Related lane spec: [`docs/design-docs/pure-ws-breakout-lane-2026-04-18.md`](./docs/design-docs/pure-ws-breakout-lane-2026-04-18.md)

## Role

이 문서는 새로운 상위 사명을 선언하는 문서가 아니다.

대신 아래를 고정한다.

1. 현재 convexity pivot 을 **순수 DEX 트레이딩봇 체제**로 더 밀어갈 때 무엇을 추가해야 하는가
2. 무엇을 유지하고 무엇을 버릴 것인가
3. 어떤 순서로 구현해야 하는가

한 줄로:

> `explainable signal bot`에서 멈추지 않고, `wallet-truth 기반 pure DEX trading bot`으로 완성하는 설계 문서다.

## 1. Why This Document Exists

현재 Block 0~4는 방향은 맞지만 아직 **hybrid transition state**다.

- 사명은 convexity 로 바뀌었다
- wallet truth / comparator / guardrail 방향도 들어갔다
- `pure_ws_breakout` lane 도 생겼다

하지만 아직 아래 한계가 남아 있다.

- `pure_ws_breakout` 가 **bootstrap signal**을 소비한다
- venue coverage 가 좁다 (`unsupported_dex`, `no_pairs`)
- canary 평가는 아직 wallet-truth 완결이 아니다
- detector / landing / bleed 모델이 완전히 pure trading bot 수준은 아니다

즉 지금 필요한 건 **또 다른 mission rewrite**가 아니라, 현재 pivot 을 **pure DEX trading bot completion** 쪽으로 밀어주는 하위 설계다.

## 2. Objective

목표 함수는 그대로다.

> 수단과 방법을 가리지 않고 `1 SOL -> 100 SOL` 달성 확률을 최대화한다.

이 문서가 다루는 해석은 다음과 같다.

- 더 많은 pool 을 본다
- 더 빠르게 진입한다
- loser 는 빨리 자른다
- winner 는 길게 든다
- 모든 판단은 wallet truth 로 검증한다

즉:

> “더 많이 시도하고, 작은 손실을 빠르게 정리하고, 드문 큰 winner 를 놓치지 않는 순수 DEX 트레이딩 체제”

## 3. Non-Negotiables

아래는 pure trading bot 으로 가도 절대 완화하지 않는다.

- Security hard reject
  - top-holder concentration
  - mint authority / freeze authority
  - honeypot / transfer restriction
- 최소 liquidity / quote sanity
- exitability / sell-side impact hard floor
- duplicate / race 방지
- entry integrity halt
- wallet truth accounting
- fixed micro-ticket
- Wallet Stop Guard
- RPC fail-safe

핵심 원칙:

> 새 체제는 fail-open 쪽으로 가더라도, **생존 가드레일은 fail-closed** 여야 한다.

## 4. What Gets Retired

아래는 pure trading bot 기준으로 primary logic 에서 내린다.

- attention / context hard gate
- explainability score
- STALK 60s + pullback wait 를 primary entry 구조로 쓰는 것
- 5분봉 confirm 을 실시간 기본 trigger 로 쓰는 것
- TP2 nominal RR 기반 hard reject
- 복잡한 reject taxonomy

보정:

- `execution viability`를 **완전히 삭제하는 것**은 아니다
- 버리는 것은 `TP2 기준 RR 때문에 probe 자체를 막는 구조`다
- 대신 `probe viability floor` 로 바꾼다

## 5. Pure Trading Bot Architecture

순수 DEX 트레이딩봇으로 가려면 5개 레이어가 필요하다.

### 5.1 Truth Layer

이 레이어가 먼저 닫혀야 한다.

- wallet delta only
- executed-buys / executed-sells append-only ledger
- lane-level attribution
- comparator
- reconciliation

운영 원칙:

- DB `pnl` 단독 판정 금지
- notifier 단독 판정 금지
- 승격 / 폐기 결정은 wallet 기준으로만

### 5.2 Strategy Layer

Primary candidate:

- `pure_ws_breakout_v2`

Supporting lanes:

- `migration_handoff_reclaim`
- `liquidity_shock_reclaim`
- `cupsey_flip_10s` (benchmark only)

핵심:

- 하나의 “완벽한 전략”이 아니라
- **breakout + event + reclaim + benchmark** 구조

### 5.3 Math / Control Layer

pure trading bot 에서 필수인 제어 항목:

- wallet log growth
- bleed per probe
- daily bleed cap
- max probes/day
- max drawdown
- max loss streak
- ruin probability

### 5.4 Read Layer

우선순위:

1. 현재 WSS / LaserStream 급
2. 이후 필요 시 shred / sniper lane 분리

원칙:

- detector 독립이 먼저
- ultra-low-latency 는 그 다음

### 5.5 Execution / Landing Layer

우선순위:

1. managed execution 안정화
2. private / redundant RPC
3. Sender / Jito / custom landing

원칙:

- truth closure 이전에 landing complexity 부터 올리지 않는다

## 6. Target Lane Set

### 6.1 `cupsey_flip_10s`

역할:

- **benchmark**
- 개조 금지
- A/B baseline

하지 말 것:

- pure trading architecture 의 target 으로 간주하지 않기
- immediate PROBE lane 으로 억지 개조하지 않기

### 6.2 `pure_ws_breakout_v2`

이 문서의 핵심 target lane.

현재 `pure_ws_breakout` 는:

- immediate PROBE
- tiered runner
- loose gate

라는 점에서 방향은 맞다.

하지만 아직:

- bootstrap signal source 의존
- pure detector 미완성

상태다.

다음 단계 target 은 이것이다.

```text
pool discovered
  -> WS burst detector
  -> probe viability floor
  -> immediate PROBE
  -> quick loser cut
  -> tiered runner
```

즉:

- `bootstrap-derived candidate lane`
가 아니라
- **independent WS burst lane**
으로 승격해야 한다.

### 6.3 `migration_handoff_reclaim`

역할:

- event-anchored lane
- pure breakout 의 false-positive 를 보완

특징:

- migration / graduation / canonical pool 형성 후 첫 reclaim
- pure breakout 보다 설명 가능한 이벤트 앵커
- false-positive 가 더 적을 가능성

### 6.4 `liquidity_shock_reclaim`

역할:

- crowded breakout 의존도 완화

구조:

- sell impact spike
- reverse quote deterioration
- 짧은 시간 내 reverse quote 회복
- reclaim 진입

### 6.5 `cupsey_inspired_optional`

역할:

- optionality sandbox

가져올 것:

- quick reject
- winner hold

버릴 것:

- 큰 사이즈 복제
- DCA 우선 도입

## 7. Entry Philosophy

### Current Problem

현재 병목:

- `STALK 15 -> ENTRY 1`
- low throughput
- explanation-first filtering

이는 pure trading bot 목표와 충돌한다.

### New Entry Rule

```text
WS micro-candle / swap burst detect
  -> hard safety
  -> probe viability floor
  -> immediate PROBE
```

primary input 후보:

- volume acceleration
- buy pressure / buy ratio
- tx density
- minimal price acceleration
- spread / reverse quote stability

### Explicitly Removed

- STALK wait
- pullback required entry
- attention/context hard gate
- TP2-based nominal RR gate

## 8. Probe Viability Floor

이건 이번 설계에서 가장 중요하다.

삭제할 것은 `RR hard reject`이지,
`진입 불가능 토큰까지 다 사는 것`이 아니다.

pure trading lane 의 minimum floor:

```text
if no route -> reject
if sell-side impact > hard cap -> reject
if quote sanity fails -> reject
if expected round-trip bleed > probe bleed budget -> reject
else -> allow PROBE
```

즉:

- RR gate 는 버린다
- viability floor 는 남긴다

## 9. Exit Philosophy

순수 DEX trading bot 의 기본 exit 철학:

- loser 빠르게 정리
- winner 는 구조적으로 오래 듦

### Baseline Shape

```text
PROBE:
  hard cut
  flat timeout
  tight trail

RUNNER T1:
  moderate trail

RUNNER T2:
  looser trail
  breakeven lock

RUNNER T3:
  very loose trail
  no time stop
```

주의:

- runner tuning 은 실제 5x+ / 10x+ winner 관측 후에만
- 관측 없이 trail 을 만지면 과최적화 위험이 크다

## 10. Coverage Plan

Coverage 확대는 pure trading bot 의 시도 수를 직접 결정한다.

우선순위:

1. Raydium
2. PumpSwap canonical
3. Meteora
4. Orca

현재 병목 기준으로는:

- `unsupported_dex`
- `no_pairs`

를 먼저 줄여야 한다.

원칙:

- global fail-open 금지
- staged / flagged expansion
- venue support 추가 후 telemetry 필수

즉:

> `unsupported_dex 해제`가 아니라, `DEX support + pair eligibility widening`

## 11. Measurement Model

### Primary

```text
log_growth = ln(wallet_t / wallet_0)
```

### Secondary

- 5x+ winner frequency / 100 trades
- 10x+ winner frequency / 100 trades
- max consecutive losers
- max drawdown
- bleed per 100 probes

### Required Additions

- bleed per probe
- daily bleed cap
- max probes/day
- lane-level attribution
- ruin simulation

### Promotion Logic

승격은 아래가 함께 필요하다.

- wallet delta positive
- benchmark 대비 우위
- guardrail 무사고
- 5x+ winner evidence
- drawdown survivable

## 12. Implementation Order

### Phase 0 — Truth Closure

- wallet ownership explicit
- comparator
- lane attribution
- reconcile loop

### Phase 1 — `pure_ws_breakout_v2` Detector Independence

- bootstrap signal 재사용 중단
- independent WS burst detector
- same safety/integrity primitives 재사용

### Phase 2 — Probe Viability Floor

- RR gate 제거
- route / exitability / bleed floor 도입

### Phase 3 — Coverage Expansion

- DEX support staged rollout
- resolver / pair eligibility widening

### Phase 4 — Canary Math

- bleed budget
- max probes/day
- drawdown / ruin model

### Phase 5 — Landing Upgrade

- private / redundant RPC
- Sender / Jito / custom path

## 13. What We Intentionally Reuse

다시 쓰는 것:

- entry integrity
- close mutex
- fallback ledger
- Wallet Stop Guard
- HWM sanity
- fixed micro-ticket
- benchmark cupsey lane

다시 쓰지 않는 것:

- cupsey STALK state machine
- explainability-first admission logic
- attention/context hard gate

## 14. Decision Rules

### Do

- pure trading bot 완성은 `independent detector + viability floor + wallet truth` 순서로 간다
- cupsey 는 benchmark 로 유지한다
- coverage 는 staged 로 연다
- guardrail 은 먼저, latency 는 나중에

### Do Not

- gate 를 전부 제거하지 않는다
- RR gate 제거를 viability floor 제거로 오해하지 않는다
- cupsey 를 pure trading target architecture 로 삼지 않는다
- Shred/Jito 를 지금 blocker 해결보다 먼저 붙이지 않는다

## 15. One-Line Summary

> 이 프로젝트의 다음 단계는 `설명 가능한 bot`을 더 고치는 것이 아니라, `wallet truth 위에서 immediate probe / fast loser cut / long runner / broad venue coverage`를 갖춘 순수 DEX 트레이딩봇으로 완성하는 것이다.
