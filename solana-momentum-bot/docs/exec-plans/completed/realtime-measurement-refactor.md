# Realtime Measurement Refactor

> Created: 2026-03-22
> Purpose: realtime trigger edge를 측정 가능하게 만들고, 그 데이터를 replay/backtest에 재사용할 수 있게 한다.
> Document type: execution spec for today's work
> Authority: historical execution spec. 현재 운영 기준은 `REALTIME.md`, `OPERATIONS.md`, `MEASUREMENT.md`를 우선한다.

---

## Goal

현재 5분봉 중심 구조에서 벗어나, `Helius realtime -> micro candle -> trigger -> measurement -> replay backtest` 흐름을 운영 가능한 형태로 완성한다.

이 문서는 우선순위 문서가 아니라 실행 문서다. 각 항목은 아래 셋 중 하나로 표시한다.

- `done`: 현재 코드/로그로 확인된 상태
- `in_progress`: 코드 베이스가 있으나 측정/연결/검증이 미완료인 상태
- `planned`: 오늘 구현 대상이지만 아직 파일/명령이 없는 상태

---

## Rules

이 문서의 서술 규칙은 다음과 같다.

- `Current State`에는 현재 코드와 실제 런타임으로 확인된 사실만 적는다.
- 수치 목표는 `Target`으로 적고, 측정 전에는 사실처럼 쓰지 않는다.
- 아직 없는 파일은 `Planned Artifact`로 적고, 실행 명령은 `TBD after implementation`으로 적는다.
- `Definition of Done`이 없는 항목은 작업 패키지로 인정하지 않는다.

---

## Current State

### Runtime

- `done`: realtime pipeline은 이미 코드에 존재한다.
  - 관련 파일:
    - `src/index.ts`
    - `src/realtime/heliusWSIngester.ts`
    - `src/realtime/microCandleBuilder.ts`
    - `src/strategy/momentumTrigger.ts`
    - `src/orchestration/realtimeHandler.ts`
- `done`: `REALTIME_ENABLED=true`일 때 Helius realtime 경로가 시작된다.
- `done`: 현재 WS URL은 기본적으로 `SOLANA_RPC_URL`에서 파생되며, `HELIUS_WS_URL`은 override 용도다.
- `done`: 현재 코드에서는 `HELIUS_API_KEY` 자체가 realtime 모드의 필수 조건은 아니다.
- `done`: realtime 모드에서도 GeckoTerminal ingester/backfill 경로가 함께 살아 있다.
- `done`: 실제 런타임에서 `Helius real-time pipeline connected`와 `Helius WS subscriptions active` 로그를 확인했다.

### Strategy

- `done`: micro-candle 기반 `MomentumTrigger`가 존재한다.
- `done`: realtime signal은 기존 `Gate -> Risk -> processSignal` 경로로 연결된다.
- `done`: confirm/gate latency는 realtime summary에서 `avg/p50/p95`로 확인 가능하다.
- `done`: parse miss와 admission block은 `realtime shadow report`와 admission snapshot으로 요약 가능하다.

### Measurement

- `done`: backtest/paper/auto-backtest용 measurement 체계는 존재한다.
  - 관련 파일:
    - `MEASUREMENT.md`
    - `src/reporting/measurement.ts`
- `done`: realtime trigger의 `30s/60s/180s/300s` outcome 측정 경로가 존재한다.
- `done`: realtime trigger 전용 logger / outcome tracker / replay dataset 저장 계층이 추가됐다.
- `done`: realtime summary/report builder와 Telegram formatter가 추가됐다.

### Backtest

- `done`: 기존 백테스트는 5분봉/CSV 중심으로 동작한다.
- `done`: 현재 백테스트 체계로는 초봉 전략의 진짜 edge를 재현하기 어렵다.
- `done`: realtime 수집 데이터를 이용한 `micro replay backtest` CLI와 엔진이 추가됐다.

---

## Constraints

### Helius Developer Plan

- 표준 WebSocket 사용 가능
- Enhanced WebSocket 미사용
- Mainnet LaserStream 미사용
- RPC/credit 예산을 고려해야 함

### Credit Assumption

이 문서의 운영 가정은 아래와 같다.

- log-only parsing이 주 경로여야 한다.
- `getTransaction`은 fallback이어야 한다.
- parse rate가 낮으면 realtime universe를 넓히기 전에 parser/support를 먼저 보강해야 한다.

이 가정은 측정 전까지 사실이 아니다. `W1`과 `W2`에서 검증한다.

---

## Target State

오늘 작업이 끝난 뒤 기대하는 목표 상태는 아래와 같다.

- realtime signal이 발생할 때마다 trigger meta와 outcome이 저장된다.
- signal 후 `30s / 60s / 180s / 300s` return, MFE, MAE를 계산할 수 있다.
- gate latency와 signal-to-fill latency를 p50/p95로 볼 수 있다.
- raw swap / micro candle / realtime signal event를 replay 가능한 형태로 저장할 수 있다.
- 하루치 dataset으로 deterministic replay backtest를 돌릴 수 있다.
- replay 결과에도 `MEASUREMENT.md`의 edge score를 적용할 수 있다.

---

## Architecture Boundary

### Keep

- scanner / universe는 후보 풀 선정용으로 유지
- GeckoTerminal은 backfill/fallback/legacy backtest 용도로 유지
- Gate / Risk / Executor는 재사용
- 기존 backtest engine은 5분봉 전략 검증용으로 유지

### Add

- realtime signal measurement layer
- replay storage layer
- micro replay backtest engine

### Avoid

- “Helius 붙였으니 바로 edge 있음”으로 해석하지 않기
- measurement 없이 parameter tuning 먼저 하지 않기
- synthetic 5m -> micro candle 분해로 backtest 대체하지 않기

---

## Work Packages

### W1. Runtime Contract Cleanup

Status: `done`

목적:
- realtime 관련 환경 변수와 실제 런타임 계약을 문서/코드에서 일치시킨다.

범위:
- `REALTIME_ENABLED`
- `SOLANA_RPC_URL`
- `HELIUS_WS_URL`
- `HELIUS_API_KEY`의 실제 의미 명시
- Gecko coexist 여부 명시

대상 파일:
- `docs/exec-plans/completed/realtime-measurement-refactor.md`
- `src/utils/config.ts`
- `.env.example`

Definition of Done:
- 문서와 실제 코드의 env semantics가 일치한다.
- 운영자가 “무엇을 넣어야 realtime이 켜지는가”를 문서만 보고 판단할 수 있다.

Validation:
- `npm run build`
- `REALTIME_ENABLED=true npm start` 시 로그 해석 기준이 문서와 일치

### W2. Shadow Measurement

Status: `done`

목적:
- 주문 실행 여부와 분리해서 realtime trigger 자체의 edge를 측정한다.

Artifacts:
- `src/reporting/realtimeSignalLogger.ts`
- `src/reporting/realtimeOutcomeTracker.ts`
- `src/orchestration/reporting.ts` 또는 대응 orchestration 레이어 확장

저장 항목:
- signal timestamp
- pair / pool / tokenMint
- entry reference price
- trigger meta
  - primaryIntervalSec
  - confirmIntervalSec
  - volumeRatio
  - breakoutHigh
  - confirm stats
- gate start / gate end / processSignal start / fill time
- horizons
  - 30s
  - 60s
  - 180s
  - 300s
- outcomes
  - return
  - MFE
  - MAE

Definition of Done:
- realtime signal 1건당 outcome row가 정확히 1건 저장된다.
- trigger-only와 post-gate를 분리 비교할 수 있다.
- `signal count`, `avg return`, `avg MFE`, `avg MAE`, `gate latency`, `signal-to-fill latency`를 계산할 수 있다.

Validation:
- `npm run build`
- paper runtime에서 shadow log 생성 확인
- `scripts/paper-report.ts` 또는 별도 report script에서 realtime metrics 출력 확인

### W3. Replay Dataset Persistence

Status: `done`

목적:
- realtime 수집 결과를 오프라인 재생 가능한 형태로 저장한다.

Artifacts:
- `src/realtime/replayStore.ts`
- `scripts/export-realtime-replay.ts`

저장 계층:
1. `raw_swaps`
2. `micro_candles`
3. `realtime_signals`

필수 필드:
- `raw_swaps`: timestamp, pool, signature, side, priceNative, amountBase, amountQuote, slot
- `micro_candles`: pair, intervalSec, bucketStart, OHLCV, tradeCount, buyVolume, sellVolume
- `realtime_signals`: signal meta, gate result, outcome summary, config snapshot

Definition of Done:
- 하루 단위 export가 가능하다.
- 같은 raw swap input으로 micro candle과 signal 재생이 가능하다.
- 저장 포맷이 deterministic replay에 충분하다.

Validation:
- `npm run build`
- export 후 row count / schema 확인
- sample dataset reload 테스트

### W4. Micro Replay Backtest

Status: `done`

목적:
- realtime dataset을 오프라인 재생해 trigger/gate parameter를 다시 검증한다.

Artifacts:
- `src/backtest/microReplayEngine.ts`
- `scripts/micro-backtest.ts`

핵심 요구사항:
- stored raw swaps 또는 stored micro candles로 replay 가능
- trigger config snapshot override 가능
- gate on/off 비교 가능
- replay 결과에 measurement score 적용 가능

Definition of Done:
- 하루치 dataset에서 deterministic replay가 된다.
- 같은 dataset으로 parameter sweep가 가능하다.
- 결과에 `expectancyR`, `profitFactor`, `edgeScore`, `stageDecision`가 포함된다.

Validation:
- `npm run build`
- `npx ts-node scripts/micro-backtest.ts --help`
- dataset replay smoke test

### W5. Realtime Reporting Integration

Status: `done`

목적:
- realtime measurement 결과를 기존 measurement/reporting 체계에 연결한다.

범위:
- `paper-report`
- scoreboard / digest
- measurement mapping

Definition of Done:
- realtime metrics가 기존 판단 언어와 같은 스키마로 보인다.
- `MEASUREMENT.md` score를 realtime replay에도 적용할 수 있다.

Validation:
- `npm run build`
- report JSON / CLI 출력 확인

### W6. Realtime Ops Automation

Status: `done`

목적:
- realtime shadow 수집, export, summary, digest를 수동 glue code 없이 한 번에 실행한다.

범위:
- `scripts/realtime-shadow-runner.ts`
- `src/reporting/realtimeShadowReport.ts`
- `src/notifier/realtimeShadowFormatter.ts`

Definition of Done:
- 단일 명령으로 realtime paper session을 실행하고, signal target 또는 duration 기준으로 종료할 수 있다.
- 종료 후 `raw-swaps`, `micro-candles`, `realtime-signals`, `shadow-summary.json`가 같은 export 디렉터리에 남는다.
- 원하면 Telegram digest까지 보낼 수 있다.

Validation:
- `npm run build`
- `npx ts-node scripts/realtime-shadow-runner.ts --help`
- 기존 realtime dataset에 대한 report-only dry-run

---

## Execution Order

오늘 우선순위는 절대적이지 않지만, 의존성상 실행 순서는 아래가 맞다.

1. `W1` Runtime Contract Cleanup
2. `W2` Shadow Measurement
3. `W3` Replay Dataset Persistence
4. `W4` Micro Replay Backtest
5. `W5` Realtime Reporting Integration
6. `W6` Realtime Ops Automation

이 순서를 따르는 이유:
- `W2` 없이는 trigger edge를 모른다.
- `W3` 없이는 replay backtest input이 없다.
- `W4` 없이는 micro 전략을 반복 검증할 수 없다.
- `W5`는 앞 4개 결과를 기존 measurement 체계에 붙이는 단계다.
- `W6`는 검증 파이프라인을 운영 루프로 바꾸는 단계다.

---

## Done Definition

오늘 작업의 최종 완료 기준은 아래다.

- realtime signal shadow log가 저장된다.
- signal 후 outcome horizon 계산이 된다.
- raw swap / micro candle / signal event를 export할 수 있다.
- exported dataset으로 replay backtest가 가능하다.
- replay 결과에 measurement score가 붙는다.

위 5개가 충족되기 전에는 “realtime trigger edge 확인 완료”라고 부르지 않는다.

---

## Validation Matrix

| Package | Required Validation |
|---|---|
| `W1` | `npm run build`, env/runtime semantics 확인 |
| `W2` | shadow signal log 생성, horizon outcome 계산 확인 |
| `W3` | export/import sample dataset 확인 |
| `W4` | deterministic replay + metric output 확인 |
| `W5` | report/JSON/score integration 확인 |
| `W6` | single-command runner + export + summary JSON + optional telegram |

공통 규칙:
- 없는 스크립트는 검증 명령으로 적지 않는다.
- 구현 후 검증 명령을 문서에 추가한다.

---

## Validation Snapshot

2026-03-22 기준 실제 확인 결과:

- `done`: `npm run build` 통과
- `done`: `npx jest --runInBand test/microReplayEngine.test.ts test/realtimeMeasurement.test.ts` 통과
- `done`: `npx ts-node scripts/export-realtime-replay.ts --help` 통과
- `done`: `npx ts-node scripts/micro-backtest.ts --help` 통과
- `done`: `npx ts-node scripts/paper-report.ts --help` 통과
- `done`: `npx ts-node scripts/realtime-shadow-runner.ts --help` 통과
- `done`: tuned realtime paper runtime에서 아래를 실제 확인
  - dataset dir: `tmp/realtime-loop-live-20260322-163634`
  - `Helius real-time pipeline connected`
  - `Helius WS subscriptions active`
  - `SignalProcessor` realtime signal log 발생
  - `raw-swaps.jsonl`, `micro-candles.jsonl`, `realtime-signals.jsonl` 생성
- `done`: 실데이터 export 확인
  - export dir: `tmp/realtime-loop-live-export-20260322-163634`
  - export counts: swaps `197`, candles `63`, signals `2`
- `done`: 실데이터 signal outcome 확인
  - signal 1: `gate_rejected`, filter=`insufficient_primary_candles`, `30s=+0.03%`, `60s=-0.45%`
  - signal 2: `execution_viability_rejected`, filter=`poor_execution_viability: effectiveRR=0.80 roundTripCost=0.65%`, `30s=+0.52%`, `60s=+0.61%`
- `done`: 실데이터 micro replay 확인
  - dataset `tmp/realtime-loop-live-20260322-163634`
  - `gate-mode stored`: signals `2`, edge score `60`, decision `reject_gate`
- `done`: realtime report integration 확인
  - `paper-report --skip-db --realtime-dir ./tmp/realtime-loop-live-20260322-163634 --realtime-horizon 30`
  - output: `Signals total=2`, `executed=0`, `gateRejected=1`, `Avg Return=+0.27%`, `p95 gate latency=59ms`
- `done`: realtime ops automation 확인
  - `realtime-shadow-runner --dataset-dir ./tmp/realtime-loop-live-20260322-163634 --export-dir ./tmp/realtime-loop-live-runner-export --horizon 30 --json`
  - output counts: swaps `197`, candles `63`, signals `2`
  - generated files: `manifest.json`, `raw-swaps.jsonl`, `micro-candles.jsonl`, `realtime-signals.jsonl`, `shadow-summary.json`
- `done`: runtime shutdown 경고 완화
  - `RealtimeAdmissionStore` temp file명을 고유하게 바꿔 동시 shutdown save의 `ENOENT` 가능성을 줄임

해석:

- shadow measurement -> outcome horizon -> export -> replay -> report 경로는 실제 런타임 데이터로 end-to-end 검증됐다.
- `realtime-shadow-runner`로 이제 이 경로를 단일 운영 명령으로 반복 실행할 수 있다.
- 초기 조기 반환 signal도 이제 `realtime-signals.jsonl`로 남기므로 trigger-only와 post-gate를 분리 관찰할 수 있다.
- 남은 과제는 구현 공백이 아니라 `표본 축적`, `trigger density tuning`, `execution viability gate 해석`이다.

---

## Risks

- parser coverage가 낮으면 realtime universe가 너무 좁아질 수 있다.
- gate latency가 크면 trigger edge가 execution edge로 이어지지 않을 수 있다.
- Gecko fallback과 realtime path가 섞이면 성과 해석이 흐려질 수 있다.
- replay schema가 빈약하면 나중에 backtest 재현성이 깨진다.

각 리스크는 아래로 대응한다.

- parser coverage: admission stats와 parse rate를 별도 저장
- gate latency: shadow measurement에서 p50/p95 추적
- mixed path ambiguity: trigger source와 execution source를 각각 기록
- replay fragility: raw swap + signal snapshot 동시 저장

---

## Notes

- 기존 5분봉 backtest는 버리지 않는다.
- realtime micro strategy는 별도 측정/재현 체계로 본다.
- 이 문서는 오늘 작업 완료 후 다시 갱신한다.
