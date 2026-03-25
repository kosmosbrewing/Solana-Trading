# Realtime Edge Validation Guide

> Created: 2026-03-22
> Updated: 2026-03-22
> Goal: Helius realtime shadow, historical swap backfill, micro replay를 하나의 실행 경로로 정리해 초봉 momentum edge를 검증한다
> Document type: working guide
> Authority: realtime validation 워크플로 기준 문서. 운영 절차는 `OPERATIONS.md`, 점수 해석은 `MEASUREMENT.md`를 우선한다.

---

## Scope

이 문서는 `5m CSV backtest`가 아니라 아래 3가지를 다룬다.

1. `Helius realtime shadow collection`
2. `historical onchain swap backfill`
3. `micro replay backtest`

`7일 5m` 대량 백테스트는 [BACKTEST.md](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/BACKTEST.md), 점수 해석은 [MEASUREMENT.md](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/MEASUREMENT.md), 운영 명령은 [OPERATIONS.md](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/OPERATIONS.md)를 기준으로 본다.

### Quick Start

가장 짧은 권장 순서는 이렇다.

1. `npm run realtime-shadow -- --run-minutes 180 --signal-target 50`
2. 생성된 session dataset 또는 export bundle을 확인
3. `npx ts-node scripts/micro-backtest.ts --dataset <dataset-dir> --gate-mode stored --horizon 30 --json`
4. 표본이 부족하면 `npx ts-node scripts/fetch-historical-swaps.ts --trending --days 3 --json`

---

## Why Realtime

현재 판단은 이렇다.

- `5m` 폴링만으로는 Solana 밈코인 breakout/momentum을 너무 늦게 본다.
- 실시간 trigger의 edge를 보려면 `swap -> micro candle -> signal -> horizon outcome` 경로가 필요하다.
- live/paper를 오래 돌려 표본을 쌓는 속도가 느리므로, `historical swap backfill -> micro replay` 경로도 같이 필요하다.

즉 realtime 경로의 목적은 `바로 실거래`가 아니라 먼저 `trigger 자체가 후속 30s/60s/180s 움직임을 설명하는지`를 검증하는 것이다.

---

## Current State

| 항목 | 상태 | 근거 |
|---|---|---|
| Helius realtime pipeline | 구현됨 | `REALTIME_ENABLED=true`에서 paper realtime 경로 실행 가능 |
| Realtime persistence | 구현됨 | `raw-swaps.jsonl`, `micro-candles.jsonl`, `realtime-signals.jsonl` 저장 |
| Realtime shadow runner | 구현됨 | session 실행 -> export -> summary -> telegram digest 자동화 |
| Micro replay backtest | 구현됨 | 저장된 realtime dataset을 오프라인 재생 가능 |
| Historical swap fetch | 구현됨 | 과거 onchain swap을 수집해 replay dataset 생성 가능 |
| Measurement integration | 구현됨 | realtime 결과는 `Realtime Edge Score`로 요약 가능 |
| 표본 수 | 아직 부족 | 최신 live snapshot은 `signals=2` 수준으로 전략 판단엔 약함 |

### Latest Validation Snapshot

실데이터 기준 최신 검증 스냅샷:

- 이 snapshot은 `default 운영`이 아니라 `tuned validation` 실행 기준이다.

- runtime log:
  - `Helius real-time pipeline connected`
  - `Helius WS subscriptions active`
- persisted counts:
  - `swaps=197`
  - `candles=63`
  - `signals=2`
- 30초 shadow summary:
  - `Avg Adjusted Return = +0.27%`
  - `Realtime Edge Score = 60`
  - `Decision = reject_gate`
- stored-gate replay:
  - `signals=2`
  - `edgeScore=60`
  - `decision=reject_gate`

중요:

- 현재 부족한 것은 구현이 아니라 `signal sample size`다.
- 따라서 이 문서의 핵심은 `표본 확대`와 `replay 기반 재현성 확보`다.

---

## Architecture

| 레이어 | 파일 | 역할 |
|---|---|---|
| Realtime ingest | [heliusWSIngester.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/realtime/heliusWSIngester.ts) | Helius websocket 이벤트 수신 |
| Swap parsing | [swapParser.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/realtime/swapParser.ts) | transaction/log -> parsed swap |
| Micro candle | [microCandleBuilder.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/realtime/microCandleBuilder.ts) | `1s/5s/15s/1m` synthetic candle 생성 |
| Trigger | [momentumTrigger.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/strategy/momentumTrigger.ts) | breakout + volume surge signal 산출 |
| Runtime gating | [realtimeHandler.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/orchestration/realtimeHandler.ts) | execution viability, rejection reason, shadow logging |
| Persistence | [replayStore.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/realtime/replayStore.ts) | realtime dataset 저장/로드/export |
| Measurement | [realtimeMeasurement.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/reporting/realtimeMeasurement.ts) | signal outcome 요약, score, gate 판정 |
| Runner | [realtime-shadow-runner.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/scripts/realtime-shadow-runner.ts) | session orchestration |
| Replay CLI | [micro-backtest.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/scripts/micro-backtest.ts) | offline replay/backtest |
| Historical fetch | [fetch-historical-swaps.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/scripts/fetch-historical-swaps.ts) | 과거 swap 수집 + replay |

### Realtime Data Flow

```text
Helius WS
  -> parsed swap
  -> micro candles
  -> momentum trigger
  -> shadow signal log
  -> outcome horizons (30/60/180/300s)
  -> Realtime Edge Score
```

### Historical Replay Data Flow

```text
Helius RPC historical tx fetch
  -> parsed swap
  -> raw-swaps.jsonl
  -> microReplayEngine
  -> outcome horizons
  -> Realtime Edge Score
```

---

## Dataset Contract

realtime 및 historical replay는 같은 데이터 계층을 공유한다.

```text
<dataset-dir>/
  raw-swaps.jsonl
  micro-candles.jsonl
  realtime-signals.jsonl
  export/
    manifest.json
    shadow-summary.json
```

### File Meaning

| 파일 | 의미 |
|---|---|
| `raw-swaps.jsonl` | 원본 swap 이벤트. replay의 최하위 원천 데이터 |
| `micro-candles.jsonl` | swap으로부터 생성된 synthetic candles |
| `realtime-signals.jsonl` | trigger 결과, processing status, gate reason, horizon outcome |
| `runtime-diagnostics.json` | restart-safe runtime diagnostics snapshot. 24h data-plane summary 원천 |
| `manifest.json` | export metadata |
| `shadow-summary.json` | runner가 만든 session 요약 |

설계 원칙:

- `raw-swaps`를 남겨야 trigger 로직이 바뀌어도 다시 재생 가능하다.
- `micro-candles`를 남겨야 빠른 재분석이 가능하다.
- `realtime-signals`를 남겨야 stored-gate replay와 trigger-only replay를 비교할 수 있다.
- `runtime-diagnostics`를 남겨야 PM2 restart 이후에도 `429`, pre-watchlist reject, realtime skip, realtime-ready ratio를 같은 24h 창으로 해석할 수 있다.

### Runtime Diagnostics Semantics

운영 summary의 realtime diagnostics는 아래 기준을 따른다.

- `gate reject`는 gate-origin reject만 집계한다.
- `STALE`, `RISK_REJECTED`, wallet/risk halt는 별도 downstream rejection으로 본다.
- `realtime-ready ratio`는
  - 분자: 실제 realtime-ready까지 도달한 **unique token**
  - 분모: pre-watchlist reject + post-watchlist admission skip + ready candidate를 합친 **unique token**
- 따라서 이 지표는 event-frequency가 아니라 candidate pipeline quality를 보는 지표다.

---

## Workflow 1: Realtime Shadow Collection

realtime shadow는 실제 paper runtime을 돌리되, 목적은 주문 성과보다 `signal outcome measurement`에 둔다.

실행 명령은 [OPERATIONS.md](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/OPERATIONS.md)를 기준으로 한다.

### Default Path

- 용도: 표본 축적
- 입력: `.env`의 realtime 기본 파라미터
- 출력: session dataset, export bundle, `shadow-summary.json`, optional Telegram digest
- 기본 dataset root: `data/realtime-sessions/<timestamp>`
- 기본 admission snapshot: `data/realtime-admission.json`
- 권장 해석: default 결과끼리만 누적 비교

### Tuned Validation Path

- 용도: signal density 확인, rejection path 디버깅
- 해석: 기본 운영 결과와 섞지 않는다
- 권장 해석: default runtime과 별도 실험군으로 저장

### Session Stop Conditions

runner는 아래 중 하나가 만족되면 session을 종료한다.

- `--run-minutes <N>`
- `--signal-target <N>`
- child process exit

---

## Workflow 2: Historical Swap Backfill

live 표본이 부족하면 Helius RPC로 과거 swap을 수집해 즉시 replay할 수 있다.

### 목표

- 실시간 paper를 며칠 돌리지 않고도 초봉 edge 후보를 빠르게 본다
- 특정 풀 또는 trending pool 묶음을 같은 trigger로 재생해본다
- 기본 output root: `data/historical-swaps`

### CLI

```bash
# dry-run: signature 수만 확인
npx ts-node scripts/fetch-historical-swaps.ts \
  --pools <pool_address> \
  --days 1 \
  --dry-run

# 단일 풀 수집 + replay
npx ts-node scripts/fetch-historical-swaps.ts \
  --pools <pool_address> \
  --days 3

# GeckoTerminal trending 기반 멀티풀
npx ts-node scripts/fetch-historical-swaps.ts \
  --trending \
  --days 3 \
  --json

# 수집만 하고 replay 생략
npx ts-node scripts/fetch-historical-swaps.ts \
  --pools <addr1,addr2> \
  --days 1 \
  --skip-replay
```

### Historical Flow

```text
pool list
  -> signatures fetch
  -> parsed transactions fetch
  -> parseSwapFromTransaction()
  -> raw-swaps.jsonl
  -> replayRealtimeDataset()
  -> summary.json
```

### Rough Credit Model

Helius Developer 기준 대략 이렇게 본다.

| API | rough cost | 비고 |
|---|---:|---|
| `getSignaturesForAddress` | `1` | 페이지네이션 |
| `getParsedTransaction` | `100` | 가장 큰 비용 |
| `getAccountInfo` | `1` | pool metadata 보조 |

이 값은 운영 전 rough estimate로만 보고, 실제 billing은 Helius 대시보드를 기준으로 확인한다.

운영 메모:

- 현재 runtime은 `batch parsed transaction 미지원 -> single-request fallback` 폭주를 막기 위해
  `REALTIME_DISABLE_SINGLE_TX_FALLBACK_ON_BATCH_UNSUPPORTED=true`를 기본으로 둔다.
- startup `recent swap seed`는 `REALTIME_SEED_BACKFILL_ENABLED=false`로 끄고 안정성을 먼저 보는 운영이 가능하다.

### Safety Controls

| 옵션 | 역할 |
|---|---|
| `--dry-run` | signature count만 확인 |
| `--max-txs-per-pool <N>` | 비용 상한 |
| `--skip-replay` | fetch와 replay 분리 |
| backoff | 429 대응 |

---

## Workflow 3: Micro Replay Backtest

이미 저장된 dataset은 `micro-backtest.ts`로 재현한다.

### 용도

- trigger-only replay
- stored-gate replay
- horizon별 outcome 비교
- 파라미터 변경에 따른 signal density / return 변화 확인

### CLI

```bash
# trigger-only replay
npx ts-node scripts/micro-backtest.ts \
  --dataset ./data/realtime-sessions/<session-dir> \
  --horizon 30 \
  --json

# stored gate replay
npx ts-node scripts/micro-backtest.ts \
  --dataset ./data/realtime-sessions/<session-dir>/export \
  --gate-mode stored \
  --horizon 30 \
  --json

# trigger parameter override
npx ts-node scripts/micro-backtest.ts \
  --dataset ./data/realtime-sessions/<session-dir> \
  --primary-interval 5 \
  --confirm-interval 5 \
  --volume-lookback 1 \
  --volume-multiplier 1 \
  --breakout-lookback 1 \
  --confirm-bars 1 \
  --confirm-change-pct 0 \
  --cooldown-sec 60
```

### Gate Modes

| 모드 | 의미 |
|---|---|
| `off` | trigger path만 재생 |
| `stored` | 저장된 runtime gate 결과를 그대로 사용 |

권장 해석:

- `off`는 trigger 자체의 정보량을 본다
- `stored`는 현재 runtime gating까지 포함한 현실 성과를 본다

`--dataset`은 session dataset 디렉터리 또는 export bundle 디렉터리를 가리킬 수 있다.

---

## Measurement Interpretation

realtime 결과는 [MEASUREMENT.md](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/MEASUREMENT.md) 기준으로 해석한다.

### 현재 규칙

- 점수 이름: `Realtime Edge Score`
- 점수 의미: `observed signal outcomes` 기준 Edge-only score
- 포함 지표:
  - adjusted return
  - expectancy
  - profit factor
  - sharpe
  - max drawdown
  - total signals
- 별도 telemetry:
  - gate latency
  - signal-to-fill latency
  - status mix
  - admission block stats

즉 현재 realtime 단계에서는 `Execution telemetry`를 점수에 합산하지 않는다.

### Important Caveats

1. `Realtime Edge Score`는 executed trade score가 아니다.
2. 현재 score는 horizon이 완료된 signal outcome 전체를 기준으로 한다.
3. `admission summary`는 dataset과 완전히 같은 session 범위가 아닐 수 있다.
   - runner는 기본적으로 전역 admission snapshot 파일을 읽는다.
4. `signals < 10`이면 점수는 참고만 하고 전략 판단에 쓰지 않는다.

---

## What Good Looks Like

현재 우선 목표는 이 정도다.

1. realtime shadow `signals >= 100`
2. `execution_viability_rejected`와 `insufficient_primary_candles` 비중 파악
3. default runtime과 tuned validation을 분리 저장
4. historical replay와 live shadow의 direction이 크게 어긋나지 않는지 확인

판단 순서:

1. signal density가 충분한가
2. rejection reason이 구조적인가
3. adjusted return / expectancy가 양수인가
4. stored gate replay에서도 완전히 무너지지 않는가

---

## Validation Checklist

문서 반영 시점 기준 최소 확인 경로:

```bash
npx ts-node scripts/realtime-shadow-runner.ts --help
npx ts-node scripts/export-realtime-replay.ts --help
npx ts-node scripts/micro-backtest.ts --help
npx ts-node scripts/fetch-historical-swaps.ts --help
```

실데이터 검증 경로:

```bash
# 1. session run
npm run realtime-shadow -- --run-minutes 30 --signal-target 10

# 2. report-only
npm run realtime-shadow -- \
  --dataset-dir ./tmp/realtime-loop-live-20260322-163634 \
  --export-dir ./tmp/realtime-loop-live-runner-export \
  --horizon 30 \
  --json

# 3. stored gate replay
npx ts-node scripts/micro-backtest.ts \
  --dataset ./tmp/realtime-loop-live-20260322-163634 \
  --gate-mode stored \
  --horizon 30 \
  --json
```

---

## Decision Rule

현재는 이렇게 본다.

- `5m backtest`는 후보 압축용
- `realtime shadow`는 trigger edge 존재 여부 확인용
- `historical swap replay`는 realtime 표본 부족을 메우는 가속기

즉 `REALTIME.md`의 최종 목적은 `실시간 전략을 이미 증명했다`가 아니라,
`실시간 전략을 더 빠르고 재현 가능하게 검증하는 운영 체계가 마련되었다`는 상태를 유지하는 것이다.
