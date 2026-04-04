# Solana Momentum Bot

> **Mission: 1 SOL -> 100 SOL**
>
> 가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다.

Solana DEX 이벤트 기반 트레이딩 봇이다.  
`Context -> Trigger -> Gate -> Risk -> Execute -> Monitor` 경로를 일관되게 기록하고,
backtest / realtime shadow / paper / live를 같은 measurement 프레임으로 해석하는 것을 목표로 한다.

## Current Status

- core runtime과 telemetry 경로는 구현 완료 상태다.
- 현재 active work는 기능 추가보다 배포, paper validation, live enablement gate 정리에 가깝다.
- 2026-04-04 기준 bootstrap replay sweep / token leaderboard / fixed-notional 비교 도구가 추가됐다.
- 현재 bootstrap canary 기준값은 `vm=1.8 / buyRatio=0.60 / lookback=20`이고, operator blacklist를 runtime에 직접 반영할 수 있다.
- live buy entry cost는 planned notional이 아니라 actual input amount 기준으로 기록되도록 보정됐다.
- `trade-report.ts`는 `opened_at ledger`와 `closed_at realized PnL`을 분리해 운영 리포트로 사용한다.
- historical canary와 follow-up fix 요약은 [`PLAN_CMPL.md`](./PLAN_CMPL.md)에 모아뒀다.

현재 active execution plan은 [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md)이고,
완료된 plan/canary history는 [`PLAN_CMPL.md`](./PLAN_CMPL.md)에 모아둔다.

## Read Order

### Current Source Of Truth

| 문서 | 역할 |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | 에이전트 규칙과 문서 우선순위 |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 모듈 책임, 의존성 방향, 데이터 흐름 |
| [`PROJECT.md`](./PROJECT.md) | 목표, 비목표, 현재 phase |
| [`PLAN.md`](./PLAN.md) | mission charter와 plan hierarchy |
| [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md) | 현재 active execution plan |
| [`STRATEGY.md`](./STRATEGY.md) | 현재 runtime quick reference |
| [`OPERATIONS.md`](./OPERATIONS.md) | 운영 절차와 runbook |
| [`docs/product-specs/strategy-catalog.md`](./docs/product-specs/strategy-catalog.md) | 전략/Gate/Risk 상세 명세 |
| [`MEASUREMENT.md`](./MEASUREMENT.md) | stage score / composite score 기준 |

### Workflow Guides

| 문서 | 역할 |
|---|---|
| [`BACKTEST.md`](./BACKTEST.md) | 5분봉 backtest 워크플로 |
| [`REALTIME.md`](./REALTIME.md) | realtime shadow / replay 워크플로 |
| [`SETUP.md`](./SETUP.md) | VPS / DB / env 초기 셋업 |

### Forward / Historical Notes

| 문서 | 역할 |
|---|---|
| [`PLAN_CMPL.md`](./PLAN_CMPL.md) | 완료된 plan / canary history archive |
| [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md) | 현재 전략의 구조적 한계와 다음 전략 질문 |
| [`docs/exec-plans/completed/`](./docs/exec-plans/completed) | 완료된 실행 기록과 historical execution spec |

## Runtime Shape

```text
Stage 1: Context
  scanner / event / watchlist / attention score

Stage 2: Trigger
  volume_spike / fib_pullback / realtime momentum trigger

Stage 3: Gate
  security -> attention -> execution viability -> quote -> safety -> exit impact

Stage 4: Risk
  risk tier / drawdown guard / daily halt / sizing

Stage 5: Execute
  Jupiter / Jito / wallet limits / paper-live split

Stage 6: Observe
  audit log / paper metrics / realtime outcome / runtime diagnostics
```

## Module Map

| Layer | 모듈 |
|---|---|
| Foundation | `utils/`, `candle/`, `state/`, `ingester/` |
| Discovery / Data Plane | `event/`, `scanner/`, `universe/`, `realtime/` |
| Decision Core | `strategy/`, `gate/`, `risk/` |
| Execution / Reporting | `executor/`, `notifier/`, `audit/`, `reporting/` |
| Top-Level Coordination | `orchestration/`, `src/index.ts` |

상세 의존성 규칙은 [`ARCHITECTURE.md`](./ARCHITECTURE.md)를 우선한다.

## Main Commands

```bash
npm run build
npm test
npm run dev
npm run backtest
npm run realtime-shadow
npm run paper-report
npx ts-node scripts/trade-report.ts
scripts/bootstrap-replay-report.sh --save
```

## Notes

- 현재 문서 체계는 `current source`, `workflow guide`, `forward memo`, `historical note`로 분리돼 있다.
- 전략 상세와 파라미터 근거는 [`STRATEGY.md`](./STRATEGY.md)와 [`docs/product-specs/strategy-catalog.md`](./docs/product-specs/strategy-catalog.md)로 읽고, 구조적 한계/다음 가설은 [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md)로 읽는다.
- 오래된 plan/handoff 문서는 현재 동작의 기준 문서로 읽지 않는다.

## One-Line Summary

> 이 저장소의 현재 핵심은 새로운 전략 추가보다, explainable entry와 restart-safe telemetry를 유지한 채 backtest / paper / live 해석 경로를 정교하게 맞추는 것이다.
