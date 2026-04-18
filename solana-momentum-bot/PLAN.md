# PLAN.md

> Status: current mission charter (post-pivot)
> Updated: 2026-04-18
> Purpose: 이 저장소의 장기 목표, 운영 원칙, 문서 계층을 고정한다.
> Pivot decision: [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md)
> Pre-pivot snapshot: [`docs/historical/pre-pivot-2026-04-18/PLAN.md`](./docs/historical/pre-pivot-2026-04-18/PLAN.md)
> Use with: [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md) for current active execution work, [`PLAN_CMPL.md`](./PLAN_CMPL.md) for archived plans.

## Role

이 문서는 "지금 당장 무엇을 할 것인가"를 세부적으로 지시하지 않는다.
대신 아래 3가지만 고정한다.

1. 이 봇이 무엇을 하려는가
2. 어떤 원칙으로 운영 판단을 내리는가
3. 하위 plan 문서를 어떻게 읽어야 하는가

## Mission (2026-04-18 post-pivot)

> 수단과 방법을 가리지 않고 `1 SOL -> 100 SOL` 달성 확률을 최대화한다.
> Wallet truth 기준 log 성장률과 winner 분포로 성과를 측정한다.

목표 함수는 **explainability 가 아니라 convexity** 다.

### Why Pivoted (2026-04-18)

- 시작 wallet `1.30 SOL` → 현재 `1.07 SOL`
- 같은 기간 DB pnl 합계 `+18.11 SOL`
- drift `+18.34 SOL` — **DB pnl은 허수, wallet만 ground truth**
- 기존 "설명 가능한 진입 + 보수적 gate + 반복 가능한 기대값" 사명은 wallet 기준으로 증명 실패
- 상세: [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md)

## Operating Principles (post-pivot)

### P1. Wallet Delta is the Only Truth

- DB `pnl`, notifier, 내부 metric은 reconciliation evidence일 뿐이다.
- 운영 판정은 항상 `wallet balance delta`로 내린다.
- `DB vs wallet drift`가 감지되면 해석 전체를 재점검한다.

### P2. Convexity Over Explainability

- "왜 오르는가"보다 "지금 실제로 폭발하는가"를 본다.
- Attention / context score는 **hard reject로 사용하지 않는다**.
- Entry throughput이 wallet expectancy에 도움이 된다면 gate를 연다.

### P3. Small Ticket, Many Shots, Long Runners

- Fixed ticket `0.01 SOL` (canary), 동시 진입 여러 개 허용.
- Loser는 빠르게 정리, winner는 최대한 길게 보유.
- 평균 수익률보다 5x/10x winner 빈도를 중시한다.

### P4. Hard Safety Never Compromised

- Security hard reject (top-holder %, mint/freeze authority, honeypot sim)
- 최소 liquidity / quote sanity
- Exitability 확인
- Duplicate / race 방지 (Patch A, B1)
- HWM / price sanity (Patch B2)
- Wallet Stop Guard `< 0.8 SOL` halt
- RPC fail-safe halt

이 항목은 convexity 최우선 원칙보다도 위에 있다.

### P5. Cupsey Is the Benchmark, Not the Target

- `cupsey_flip_10s`는 현재 유일한 live-proven lane이다.
- Pivot 이후에도 **절대 개조하지 않는다** — A/B 비교 baseline.
- 새 lane은 cupsey와 병렬로 paper → canary 순서로만 올린다.

### P6. Live Lane Promotion Needs Wallet Evidence

- Paper에서 신호 재현은 필요 조건이지 충분 조건이 아니다.
- Live canary는 `50 trades` 도달 후 wallet delta 기준으로 판정한다.
- Single-session outlier는 edge 증거가 아니다.

## Plan Hierarchy

### Layer 1. 상위 헌장

- [`PLAN.md`](./PLAN.md) (이 문서)
- [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md) — pivot 결정 근거

### Layer 2. 현재 active execution plan

- [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md)

### Layer 3. Reference

- [`PROJECT.md`](./PROJECT.md) — persona / goals
- [`MEASUREMENT.md`](./MEASUREMENT.md) — wallet 기준 KPI
- [`STRATEGY.md`](./STRATEGY.md) — cupsey benchmark + pure_ws_breakout placeholder

### Layer 4. Completed archive

- [`PLAN_CMPL.md`](./PLAN_CMPL.md)
- [`docs/historical/pre-pivot-2026-04-18/`](./docs/historical/pre-pivot-2026-04-18/) — pre-pivot snapshot

## Mission Horizons (post-pivot)

### H1. Truth Closure

- cupsey primary의 wallet ownership 명시
- always-on wallet delta comparator 상시 작동
- `wallet-reconcile` live-binding 표준화

### H2. Coverage Expansion

- admission `unsupported_dex` / `no_pairs` 해제 (Meteora, Orca 등)
- Scanner poll cadence는 eligibility 이후

### H3. Pure WS Breakout Lane

- 사명에 맞춘 새 lane 설계 (attention/context gate 없음)
- Paper에서 entry rate + 시뮬 wallet growth 확인
- cupsey handler 복사 금지, 별도 상태기계

### H4. Canary with Hard Guardrails

- 0.01 SOL fixed, 동시 max 3 ticket
- 50 trades 도달 시 wallet delta + winner distribution 평가
- cupsey와 A/B 병렬

### H5. Tiered Runner Tuning

- 실제 5x+ winner 관측 이후에만 trailing 튜닝 시작
- 관측 없이 tuning 하지 않는다

## Decision Rules

### Do

- wallet delta 기준으로 최종 판단한다.
- 새 lane은 paper first, canary small, A/B 병렬.
- cupsey benchmark는 건드리지 않는다.
- 새 전략은 `docs/design-docs/`에 설계 문서 먼저.

### Do Not

- DB pnl 단독으로 전략 채택 / 폐기 결정하지 않는다.
- attention / context score를 hard reject로 다시 도입하지 않는다.
- cupsey handler를 개조해서 pure WS lane을 만들지 않는다.
- 표본 `< 50`에서 Kelly / 확대 sizing 활성화 금지.
- Wallet Stop Guard / RPC fail-safe / security hard reject를 완화하지 않는다.

## One-Line Summary

> 목표 함수는 convexity, 유일한 truth는 wallet delta, cupsey는 건드리지 않는 benchmark.
