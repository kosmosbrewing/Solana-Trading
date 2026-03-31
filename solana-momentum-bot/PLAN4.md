# PLAN4.md

> Updated: 2026-03-31
> Purpose: live canary의 현재 해석과 다음 운영 우선순위를 정리한다.
> Relationship: [`PLAN3.md`](./PLAN3.md)는 historical runtime blocker, [`20260331.md`](./20260331.md)는 이번 post-patch canary와 telemetry patch의 세부 기록이다.

## Verdict

- 인프라 블로커 3건은 해소됐다.
- 12-trade baseline은 존재하지만, cadence가 안정적으로 증명됐다고 보긴 어렵다.
- `2026-03-30 09:46:50 UTC` 시작 canary 12.2시간에서는 진입 0건이었다.
- 그 구간의 직접 blocker는 주로 `poor_execution_viability`와 pair blacklist였다.
- 이후 execution viability telemetry patch를 넣고 `2026-03-30 22:22:46 UTC`에 재시작했지만, 최신 21분 구간은 아직 BUY 시그널이 0건이라 새 telemetry 해석은 보류 상태다.
- `2026-03-31` 기준으로 v5 구조 변경과 follow-up fix 3건이 코드/테스트에 반영됐다.
- 따라서 다음 검증 순서는 `live-first`가 아니라 `backtest -> paper -> live`다.

한 줄로 요약하면:

> 지금 문제는 "인프라가 안 된다"가 아니라, `BUY 표본이 다시 나올 때까지 실제 blocker를 재확인할 수 없는 상태`다.

## Confirmed Facts

### F1. 인프라 경로는 정상
- Quote 401, executor 401, BUY sizing 단위 버그는 해결됐다.
- live runtime, DB, Helius WS는 현재 정상 기동된다.

### F2. baseline 12건은 historical fact로 유지
- `2026-03-25~26` 구간에 12건 실거래가 있었다.
- 다만 성과는 음수였고, 12/12 `TRAILING_STOP`이었다.

### F3. post-patch 12.2h canary는 0 entry
- BUY 시그널 14건 전부 필터링됐다.
- rejection mix:
  - `poor_execution_viability`: 10건
  - `edge tracker blacklist`: 3건
  - `buy_ratio < 0.65`: 1건

### F4. pre-gate RR 계산 경로가 핵심 의심 지점이었다
- 기존에는 pre-gate probe의 단위와 실제 주문 단위가 어긋날 가능성이 있었다.
- 이 경로를 수정했고, 이제 `execution.preGate` / `execution.postSize`를 함께 남길 수 있다.

### F5. 최신 재시작 런은 아직 표본 부족
- `2026-03-30 22:22:46 UTC` 재시작 후 약 21분 동안:
  - `Signal: BUY`: 0
  - `Pre-gate execution reject`: 0
  - `Execution viability compare`: 0
  - `Trade opened`: 0
- 따라서 새 telemetry가 잘 찍히는지 아직 live 표본으로 확인하지 못했다.

### F6. v5 follow-up fix는 완료
- realtime signal의 pre-gate execution probe가 실제 `momentumTrigger` 주문식과 정렬됐다.
- backtest gate / post-size execution viability도 live와 같은 RR 기준을 쓰도록 정렬됐다.
- scanner blacklist는 startup preload로 cold-start 우회 구간을 줄였다.
- targeted test `46`개가 통과했다.

### F7. 운영 노이즈는 지속
- Gecko `429`는 계속 발생한다.
- unsupported venue / pool program skip도 반복된다.
- 다만 최신 21분 구간의 직접적인 0-entry 원인은 RR gate가 아니라 "시그널 자체가 아직 안 나온 것"이다.

## What Changed Since Earlier Reading

### 이전 해석
- cadence 확보
- 다음 단계는 trailing / TP 구조 진단

### 현재 해석
- cadence 확보는 아직 잠정적이다.
- 하지만 오늘부터는 v5 구현 경로가 backtest / paper / live에 걸쳐 일관되게 연결된 상태다.
- 따라서 다음 단계는 live에서 무작정 표본을 기다리는 것이 아니라, backtest와 paper에서 먼저 구조 검증을 다시 하는 것이다.

## Required Actions

### R1. backtest 재검증
- v5 구조에서 trade count, rejection mix, expectancy가 어떻게 바뀌는지 먼저 확인한다.
- execution viability rejection이 여전히 지배적인지, 아니면 signal density가 더 큰 문제인지 분리한다.

### R2. paper canary
- `20~50`건 표본을 모아 `execution.preGate` / `execution.postSize`가 기대대로 남는지 확인한다.
- live 전에는 여기서 runner/TP1/stop 구조가 실제로 동작하는지 먼저 본다.

### R3. live canary는 후순위
- live는 paper 확인 뒤에 전환한다.
- 먼저 돌리더라도 목적은 runtime sanity / telemetry shape 확인까지로 제한한다.

### R4. blacklist pair 재유입 점검
- startup preload 이후에도 동일 loser pair가 watchlist/signal 슬롯을 반복 점유하는지 확인한다.
- 필요하면 scanner cooldown 보강을 별도 작업으로 승격한다.

### R5. data-plane noise 분리
- Gecko `429`, unsupported venue skip은 계속 기록하되,
- BUY 시그널이 나온 뒤의 rejection 원인과 섞어서 해석하지 않는다.

### R6. 파라미터 조정은 후순위
- 아래는 telemetry 확보 전에는 건드리지 않는다.
  - `rrReject`
  - `TP2`
  - `roundTripCost`
  - blacklist 완화

## Mission Readiness

| 항목 | 현재 상태 |
|------|----------|
| End-to-end pipeline | PASS |
| Explainable entry discipline | PASS |
| Risk guard / daily halt | PASS |
| Stable cadence proof | NOT YET |
| Positive expectancy proof | FAIL |
| Post-patch telemetry validation | PARTIAL |
| Backtest/Paper validation of v5 | NOT YET |

## Current Priorities

1. backtest로 v5 구조를 재검증한다.
2. paper canary에서 `execution.preGate` / `execution.postSize`를 확인한다.
3. live canary는 paper 확인 뒤에 runtime sanity와 실거래 검증용으로 올린다.
4. 동일 pair 재유입이 보이면 cooldown 패치를 검토한다.
5. 충분한 표본이 생긴 뒤에만 RR / TP / cost 파라미터를 조정한다.

## One-Line Summary

> PLAN4의 현재 우선순위는 v5 구조를 곧바로 live에 재투입하는 것이 아니라, backtest와 paper에서 먼저 검증한 뒤 live canary로 넘어가는 것이다.
