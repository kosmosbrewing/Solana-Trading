# PLAN_CMPL.md

> Status: completed plan archive
> Updated: 2026-03-31
> Purpose: 완료된 `PLAN*` 및 dated canary/handoff 문서의 핵심 결론을 한곳에 보관한다.
> Read when: 왜 현재 코드 구조와 telemetry가 이런 형태가 되었는지 historical context가 필요할 때

## Role

이 문서는 완료된 plan과 dated evidence의 archive다.

- 현재 mission charter: [`PLAN.md`](./PLAN.md)
- 현재 active execution plan: [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md)
- 현재 runtime quick reference: [`STRATEGY.md`](./STRATEGY.md)

즉 이 문서는 현재 우선순위를 정하지 않는다.

## Archived Sources

- former `PLAN2.md`
- former `PLAN3.md`
- former `PLAN4.md`
- former `20260330.md`
- former `20260331.md`

## Why These Were Archived

아래 항목들이 현재 코드와 테스트에 반영되어, 더 이상 active plan 문서로 유지할 이유가 약해졌다.

### A. execution telemetry and size-aware recheck

근거:

- [`src/orchestration/signalProcessor.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/orchestration/signalProcessor.ts)
- pre-gate vs post-size execution viability 비교
- size-aware recomputation
- execution viability compare log

### B. v5 RR basis and order shape alignment

근거:

- [`src/utils/config.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/utils/config.ts)
- [`src/gate/index.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/gate/index.ts)
- [`src/backtest/engine.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/backtest/engine.ts)
- [`src/orchestration/candleHandler.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/orchestration/candleHandler.ts)
- [`src/orchestration/realtimeHandler.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/orchestration/realtimeHandler.ts)

반영된 내용:

- `EXECUTION_RR_BASIS=tp1`
- `EXECUTION_RR_REJECT=0.8`
- `EXECUTION_RR_PASS=1.0`
- live / realtime / backtest 경로의 RR 기준 정렬

### C. v5 exit management

근거:

- [`src/orchestration/tradeExecution.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/orchestration/tradeExecution.ts)
- [`src/strategy/volumeSpikeBreakout.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/strategy/volumeSpikeBreakout.ts)
- [`src/strategy/momentumTrigger.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/strategy/momentumTrigger.ts)

반영된 내용:

- `TP1_MULTIPLIER=1.0`
- `TP2_MULTIPLIER=10.0`
- `SL_ATR_MULTIPLIER=1.0`
- `TIME_STOP_MINUTES=20`
- `TP1_PARTIAL_PCT=0.3`
- `TRAILING_AFTER_TP1_ONLY=true`

### D. scanner blacklist preload and reentry control

근거:

- [`src/index.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/index.ts)
- [`src/scanner/index.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/scanner/index.ts)
- [`src/scanner/scannerEngine.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/scanner/scannerEngine.ts)
- [`test/scannerBlacklistCheck.test.ts`](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/test/scannerBlacklistCheck.test.ts)

반영된 내용:

- startup preload 기반 blacklist check
- watchlist blacklist eviction
- scanner 재유입 억제 경로 보강

## Archived Conclusions

### From PLAN2

초기 capability gap의 다수는 이미 코드에 흡수됐다.

- discovery source 다변화
- warmup / seed 경로 보강
- Security Gate Birdeye hard dependency 제거
- audit / gate trace / source attribution 보강

### From PLAN3

당시 핵심 lesson은:

> 전략 품질과 data-plane 장애를 분리해서 읽어야 한다.

대표 blocker:

- quote endpoint drift
- runtime drift / stale process 가능성
- security input availability

### From PLAN4

당시 active next step은 아래였다.

- v5 구조를 backtest와 paper에서 먼저 재검증
- `execution.preGate` / `execution.postSize` 비교 확보
- blacklist pair 재유입과 data-plane noise 분리

이 항목들은 현재 코드상 구현 완료로 본다.

## Archived Dated Evidence

### 2026-03-25 ~ 2026-03-26 baseline live

출처: `20260330.md`

- live trade `12`
- PnL 음수
- `12/12 TRAILING_STOP`

의미:

- end-to-end live execution은 실제로 존재했다
- cadence와 edge까지 증명한 것은 아니었다

### 2026-03-30 post-patch canary

출처: `20260331.md`

- BUY `14`
- trade `0`
- 주 blocker: `poor_execution_viability`, pair blacklist

### 2026-03-31 extended live canary

출처: `20260331.md`

- BUY `0`
- trade `0`
- interpretation: execution RR만이 아니라 upstream signal/input coverage도 문제였다

## What To Read Now Instead

| 목적 | 현재 읽을 문서 |
|---|---|
| 상위 mission / 문서 계층 | [`PLAN.md`](./PLAN.md) |
| 현재 active plan | [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md) |
| 현재 전략 / 게이트 / 리스크 quick reference | [`STRATEGY.md`](./STRATEGY.md) |
| 운영 절차 | [`OPERATIONS.md`](./OPERATIONS.md) |
| archived plan / dated evidence | [`PLAN_CMPL.md`](./PLAN_CMPL.md) |

## One-Line Summary

> `PLAN_CMPL.md`는 완료된 plan과 canary handoff를 한곳으로 접어, 현재 문서 체계에서 active plan과 historical archive를 분리하기 위한 문서다.
