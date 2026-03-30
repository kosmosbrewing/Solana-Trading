# PLAN4.md

> Updated: 2026-03-30
> Purpose: live canary의 현재 해석과 다음 운영 우선순위를 정리한다.
> Relationship: [`PLAN3.md`](./PLAN3.md)는 historical runtime blocker, [`20260331.md`](./20260331.md)는 이번 post-patch canary와 telemetry patch의 세부 기록이다.

## Verdict

- 인프라 블로커 3건은 해소됐다.
- 12-trade baseline은 존재하지만, cadence가 안정적으로 증명됐다고 보긴 어렵다.
- `2026-03-30 09:46:50 UTC` 시작 canary 12.2시간에서는 진입 0건이었다.
- 그 구간의 직접 blocker는 주로 `poor_execution_viability`와 pair blacklist였다.
- 이후 execution viability telemetry patch를 넣고 `2026-03-30 22:22:46 UTC`에 재시작했지만, 최신 21분 구간은 아직 BUY 시그널이 0건이라 새 telemetry 해석은 보류 상태다.

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

### F6. 운영 노이즈는 지속
- Gecko `429`는 계속 발생한다.
- unsupported venue / pool program skip도 반복된다.
- 다만 최신 21분 구간의 직접적인 0-entry 원인은 RR gate가 아니라 "시그널 자체가 아직 안 나온 것"이다.

## What Changed Since Earlier Reading

### 이전 해석
- cadence 확보
- 다음 단계는 trailing / TP 구조 진단

### 현재 해석
- cadence 확보는 아직 잠정적이다.
- 먼저 새 telemetry가 실제 BUY 시그널에서 찍혀야 한다.
- 그 뒤에야 `cost`, `TP2/SL`, `blacklist`, `watchlist quality` 중 어느 쪽이 직접 blocker인지 다시 분리할 수 있다.

## Required Actions

### R1. 첫 BUY 시그널 확보
- 재시작 후 live canary를 더 돌린다.
- 최소 목표:
  - `Signal: BUY`
  - `execution.preGate`
  - 필요 시 `execution.postSize`

### R2. execution viability compare 판독
- 첫 BUY 시그널에서 아래를 바로 본다.
  - `preGate effectiveRR`
  - `postSize effectiveRR`
  - `probe notional`
  - `post-size notional`
  - `sizeMultiplier`

### R3. blacklist pair 재유입 점검
- 동일 loser pair가 blacklist 상태로 watchlist/signal 슬롯을 반복 점유하는지 확인한다.
- 필요하면 scanner cooldown 보강을 별도 작업으로 승격한다.

### R4. data-plane noise 분리
- Gecko `429`, unsupported venue skip은 계속 기록하되,
- BUY 시그널이 나온 뒤의 rejection 원인과 섞어서 해석하지 않는다.

### R5. 파라미터 조정은 후순위
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
| Post-patch telemetry validation | NOT YET |

## Current Priorities

1. live canary를 더 돌려 첫 BUY 시그널을 기다린다.
2. 첫 BUY 시그널에서 `execution.preGate` / `execution.postSize`를 확인한다.
3. 동일 pair 재유입이 보이면 cooldown 패치를 검토한다.
4. 충분한 표본이 생긴 뒤에만 RR / TP / cost 파라미터를 조정한다.

## One-Line Summary

> PLAN4의 현재 우선순위는 수익성 튜닝이 아니라, post-patch live canary에서 첫 BUY 표본을 확보해 새 execution telemetry로 실제 blocker를 재식별하는 것이다.
