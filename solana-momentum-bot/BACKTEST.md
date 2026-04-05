# 대량 백테스트 실행 계획

> Created: 2026-03-22
> Updated: 2026-04-05 (replay-loop 병렬 백테스팅 + session-backtest + Strategy A/C dormancy)
> Goal: 5분봉 대량 백테스트와 realtime micro replay를 분리해 각각의 역할로 edge를 검증한다
> Document type: working guide
> Authority: 백테스트 워크플로 기준 문서. 아키텍처/전략 정의는 `ARCHITECTURE.md`, `docs/product-specs/strategy-catalog.md`, `MEASUREMENT.md`를 우선한다.

---

## 현재 확인된 사실

| 항목 | 현재 상태 | 의미 |
|------|-----------|------|
| `npm run build` | 통과 | `tsconfig.json`이 `src/**/*`만 포함하고 `scripts/`는 제외한다 |
| `npx ts-node scripts/auto-backtest.ts --help` | 통과 | 스크립트 타입 불일치는 해소되었다 |
| `scripts/multi-token-sweep.ts` | 사용 가능 | `data/*.csv` 기반 다중 토큰 스윕은 이미 실행 가능한 상태다 |
| `scripts/fetch-candles.ts` | 사용 가능 | 단건/수동 수집용이며 `BIRDEYE_API_KEY`가 필요하다 |
| `scripts/auto-backtest.sh` | 사용 가능 | 래퍼 스크립트로 기본 실행, sweep, drill을 호출할 수 있다 |
| `scripts/auto-backtest.ts --pool <addr> --days 1` | 통과 | 실제 trending 풀 1개로 캔들 수집과 백테스트 실행을 확인했다 |
| `combined` 스윕 | 부분 구현 | `multi-token-sweep.ts`에서 실제로는 `volume_spike`만 실행한다 |
| `scripts/micro-backtest.ts` | 사용 가능 | realtime 수집 데이터 기반 micro replay backtest가 가능하다 |
| `scripts/export-realtime-replay.ts` | 사용 가능 | realtime dataset을 replay/export bundle로 묶을 수 있다 |
| `scripts/realtime-shadow-runner.ts` | 사용 가능 | realtime paper 수집 -> export -> summary -> telegram digest 자동화 가능 |

### 현재 백테스트 해석 원칙

이제 백테스트는 2개 레이어로 분리해서 본다.

1. `5m/CSV backtest`
- 용도: 대량 토큰 스크리닝, 파라미터 후보 압축
- 소스: Gecko/Birdeye 수집 CSV

2. `realtime micro replay`
- 용도: Helius realtime trigger의 초봉 edge 확인
- 소스: `raw-swaps.jsonl`, `micro-candles.jsonl`, `realtime-signals.jsonl`

즉 `7일 5m` 결과와 `realtime 5s/15s` 결과는 같은 표로 합치지 않고, 서로 다른 단계의 증거로 취급한다.

### `auto-backtest.ts` 복구 내용

수정된 항목:

1. `GeckoOHLCVBar` 의존성을 제거하고 `Candle[]` 기준으로 저장하도록 변경
2. `getOHLCV(poolAddress, interval, timeFrom, timeTo)` 시그니처에 맞게 호출 수정
3. 1000캔들 제한을 넘는 구간을 chunk 단위로 나눠 수집 후 timestamp 기준 dedupe
4. `--days`, `--pool-file` 옵션 추가

즉, **대량 백테스트의 첫 병목이었던 `auto-backtest.ts` 실행 불가 상태는 해소되었다.**

---

## 왜 대량 백테스트가 필요한가

| 현재 상태 | 한계 |
|-----------|------|
| Paper 12h, 7 trades, Net -0.007 SOL | 표본이 너무 적어 edge 판단 불가 |
| 기존 백테스트 데이터 10 tokens, 3~4일 | 51 trades 수준으로 과적합 위험이 크다 |
| 파라미터 스윕 1회 완료 | 같은 소수 토큰에 재스윕해도 새 정보가 거의 없다 |

목표 표본:

- 50~100 tokens
- 7~14일 5분봉
- 수백~수천 trades

판단에 필요한 최소 출력:

- Net PnL
- Sharpe
- Profit Factor
- Win Rate
- 토큰별 양수 비율

---

## Phase 1: 데이터셋 확보

### 1A: `auto-backtest.ts` 기반 수집

현재 지원:

- `--pool <addr>` 단건 수집
- `--pool-file <path>` 주소 목록 수집
- `--days <N>` 기간 지정
- GeckoTerminal 1000캔들 제한 대응 chunk 수집
- `_300.csv` 형식으로 저장

핵심 로직:

```typescript
const interval = '5m';
const intervalSec = 300;
const maxCandlesPerCall = 1000;
const chunkSec = (maxCandlesPerCall - 1) * intervalSec;

for (let cursor = from; cursor <= to; ) {
  const chunkTo = Math.min(cursor + chunkSec, to);
  const candles = await gecko.getOHLCV(pool.address, interval, cursor, chunkTo);
  // merge + dedupe by timestamp
  cursor = chunkTo + intervalSec;
}
```

중요한 점:

- 현재 `GeckoTerminalClient`는 내부적으로 2.5초 간격 큐를 사용한다.
- 7일 5분봉은 약 2016캔들이다.
- 따라서 **풀당 3회 요청**이 필요하다.

### 1B: 토큰 소스 확장

현재 `collectOHLCV()`는 아래 3가지 경로를 지원한다.

1. `--pool <addr>` 단일 풀
2. `--pool-file <txt>` 수동 큐레이션 목록
3. 인자가 없으면 `getTrendingPools()` 기반 자동 탐색

남은 확장 과제:

- `scripts/collect-backtest-tokens.ts` 자동 수집기 추가
- trending 외 소스 결합

### 1C: 수집 검증

수집이 끝나면 아래를 확인한다.

1. CSV 파일명 규칙이 `_300.csv` 또는 `CsvLoader`가 읽을 수 있는 형식인지 확인
2. 각 CSV가 최소 30개 이상 캔들을 가지는지 확인
3. 타임스탬프 중복 여부 확인
4. 구간 공백이 심한 토큰 제거

검증 명령 예시:

```bash
npx ts-node scripts/auto-backtest.ts --help
npx ts-node scripts/auto-backtest.ts --pool <POOL_ADDRESS> --days 1 --no-notify
rg --files data | wc -l
```

---

## Phase 2: 대량 백테스트 실행

### 사용 가능한 도구

| 도구 | 파일 | 상태 | 비고 |
|------|------|------|------|
| BacktestEngine | `src/backtest/engine.ts` | 사용 가능 | 전략 시뮬레이션 |
| CsvLoader | `src/backtest/csvLoader.ts` | 사용 가능 | `_300.csv`, `_5m.csv`, `.csv` 패턴 지원 |
| Param Sweep Core | `src/backtest/paramSweep.ts` | 사용 가능 | walk-forward / CV / stability filter 로직 포함 |
| Multi-Token Sweep CLI | `scripts/multi-token-sweep.ts` | 사용 가능 | 다중 토큰 평균 성과 집계 |
| Auto-Backtest | `scripts/auto-backtest.ts` | 사용 가능 | 5분봉 chunk 수집 + baseline 백테스트 가능 |
| Micro Replay Engine | `src/backtest/microReplayEngine.ts` | 사용 가능 | realtime dataset 재생, fillCandleGaps() 내장 |
| Micro Replay CLI | `scripts/micro-backtest.ts` | 사용 가능 | `gate on/off`, horizon 비교, measurement score 출력 |
| Session Candle Aggregator | `src/backtest/sessionCandleAggregator.ts` | 사용 가능 | micro candle → 5m OHLC 집계, fillCandleGaps() 적용 |
| Session Backtest CLI | `scripts/session-backtest.ts` | 사용 가능 | 세션 데이터로 5m Strategy A/C 재생 |

### 실행 순서

1. `auto-backtest.ts`로 데이터셋 수집 및 baseline 실행
2. ~~`volume_spike` 스윕 실행~~ — **Strategy A/C는 5m 밈코인에서 dormant** (2026-04-05 확정)
3. ~~`fib_pullback` 스윕 실행~~ — dormant
4. 결과 비교 후 상위 파라미터만 재검증

> **Note (2026-04-05)**: 아래 5m Strategy A/C 스윕 명령은 밈코인 외 대형 토큰이나 CEX/DEX 전환 시에만 사용한다.
> 현재 밈코인 runtime에서는 bootstrap_10s micro-replay만 유효하다.
> bootstrap replay 명령은 [`OPERATIONS.md`](./OPERATIONS.md)의 Bootstrap Replay Command를 참조한다.

기본 명령:

```bash
./scripts/auto-backtest.sh
```

전략별 스윕 (dormant — 밈코인 외 대형 토큰에서만 사용):

```bash
npx ts-node scripts/multi-token-sweep.ts \
  --strategy volume_spike \
  --objective sharpeRatio \
  --min-total-trades 50 \
  --min-positive-ratio 0.5 \
  --top 20

npx ts-node scripts/multi-token-sweep.ts \
  --strategy fib_pullback \
  --objective sharpeRatio \
  --min-total-trades 30 \
  --min-positive-ratio 0.5 \
  --top 20
```

주의:

- `combined`는 아직 진짜 결합 전략 스윕이 아니다.
- `multi-token-sweep.ts` 내부에서 `combined`를 주어도 실제 실행 전략은 `volume_spike`로 매핑된다.
- 따라서 **현재 단계에서는 `combined` 결과를 의사결정 근거로 쓰지 않는다.**
- **Strategy A/C 5m는 밈코인 모멘텀(10-30s)에서 구조적 비적합**. 87 pairs × 3 strategies = 261 combination 중 3건만 trade (04-05 확인).

### 파라미터 범위

v5 스윕에서는 gate/risk 파라미터(`maxRiskPerTrade`, `minBreakoutScore`)를 고정하고 전략 파라미터만 스윕한다.

| 파라미터 | 범위 | 단계 | 비고 |
|---------|------|------|------|
| `volumeMultiplier` | 2.0 ~ 3.5 | 0.5 | volume spike entry |
| `tp1MultiplierA` | 0.5 ~ 1.5 | 0.5 | volume spike TP1 |
| `tp2MultiplierA` | 5.0 ~ 15.0 | 2.5 | volume spike TP2 (v5 runner) |
| `slAtrMultiplierA` | 0.75 ~ 1.5 | 0.25 | volume spike SL |
| `timeStopMinutesA` | 15 ~ 30 | 5 | volume spike time stop |
| `impulseMinPct` | 0.10 ~ 0.20 | 0.025 | fib pullback |
| `tp1MultiplierC` | 0.80 ~ 0.95 | 0.05 | fib pullback |

---

## Phase 3: 과적합 방지와 Edge 판정

### 현재 이미 있는 방어장치

| 장치 | 상태 | 근거 |
|------|------|------|
| 다중 토큰 평균 성과 | 구현됨 | `scripts/multi-token-sweep.ts` |
| `minPositiveRatio` 필터 | 구현됨 | CLI 인자로 제어 |
| `minTotalTrades` 필터 | 구현됨 | CLI 인자로 제어 |
| stability filter | 라이브러리에는 있음 | `src/backtest/paramSweep.ts`에는 있으나 multi-token CLI에서는 직접 사용하지 않음 |
| walk-forward | 엔진에는 있음 | `runParameterSweep()`가 `walkForwardRatio`를 지원하지만 multi-token CLI는 아직 미사용 |

### 판정 기준

| 지표 | Edge 있음 | Edge 없음 |
|------|-----------|-----------|
| Net PnL | > 0% | <= 0% |
| Sharpe | > 1.0 | <= 1.0 |
| Profit Factor | > 1.3 | <= 1.0 |
| Win Rate | > 35% | <= 30% |
| 양수 토큰 비율 | > 50% | <= 40% |

### 분기

```text
Edge 확인:
  최적 파라미터를 config로 반영
  Paper 50-trade 검증 재시작

Edge 불확실:
  상위 파라미터 3~5개만 남겨 표본 추가 수집 후 재검증

Edge 없음:
  진입 규칙 또는 전략 자체를 재설계
```

### Realtime Micro Replay 해석

realtime 쪽은 아래처럼 본다.

| 단계 | 기준 | 의미 |
|------|------|------|
| shadow signal 생성 | `realtime-signals.jsonl > 0` | trigger/outcome 계측 경로 정상 |
| replay 가능 | `micro-backtest.ts`로 same dataset 재현 가능 | 저장 포맷 정상 |
| sample 충분 | `signals >= 50` | 파라미터 비교 시작 가능 |
| sample 충분(강) | `signals >= 100` | edge 해석 신뢰도 상승 |

### v5 Micro Replay 검증 결과 (2026-04-01)

아카이브 데이터(8 pairs, 4.3M candles)에서 `vm=3.0, cb=2, cp=0.01` 기준:

| Horizon | Signals | Return | MFE | MAE | MFE/MAE |
|---------|---------|--------|-----|-----|---------|
| 30s | 16 | +0.14% | 6.40% | -0.34% | 18.8x |
| 60s | 16 | -0.01% | 6.44% | -0.36% | 17.9x |
| 180s | 16 | +0.19% | 75.46% | -6.40% | 11.8x |

핵심 발견:

- MFE/MAE 18.8x → 시그널이 진짜 모멘텀을 포착하고 있음
- 30s가 최적 캡처 포인트, 60s에서 되돌림 시작
- confirm_bars=1은 모든 경우 대규모 손실 (-16~-47%), confirm_bars≥2 필수
- 현재 데이터는 15s primary로 수집됨 → v5(10s) 기준 재수집 후 재검증 필요
- 표본 16건으로 방향성만 참고, 최종 확정에는 50건 이상 필요

---

## 구현 우선순위

### 즉시 해야 할 것

1. realtime shadow dataset 100 signal 이상 누적
2. micro replay 기준 `execution_viability_rejected` / `insufficient_primary_candles` 비중 분석
3. 5분봉 baseline 데이터셋은 후보 압축용으로 계속 유지

### 그다음 할 것

1. `micro parameter sweep` 추가
2. `multi-token-sweep.ts`에 실제 `combined` 전략 지원
3. 5분봉 multi-token CLI에 stability / walk-forward 옵션 연결

### 당장 수정 불필요

- `src/backtest/engine.ts`
- `src/backtest/csvLoader.ts`
- `src/backtest/paramSweep.ts`

---

## 검증 루프

이 작업은 아래 순서로 반복한다.

1. `auto-backtest.ts` 최소 수정
2. `npx ts-node scripts/auto-backtest.ts --help` 재실행
3. 소량 풀로 CSV 수집 확인
4. baseline 백테스트 실행
5. multi-token sweep 실행

종료 조건:

- `auto-backtest.ts`가 `ts-node`로 실행 가능
- 50개 이상 토큰 CSV 확보
- `volume_spike`, `fib_pullback` 스윕 결과 확보

---

## 리스크

| 리스크 | 완화 |
|--------|------|
| `npm run build`가 green이어도 scripts 오류를 놓칠 수 있음 | 반드시 `ts-node` 기준으로 검증 |
| GeckoTerminal 429 | 현재 클라이언트의 2.5초 큐 + 429 backoff 유지 |
| universe 편향 | trending + 수동 큐레이션을 혼합하고 결과 해석 시 survivorship bias 명시 |
| directional volume 부재 | `minBuyRatio=0` 기준으로 paper와 동일 조건 유지 |
| `combined` 결과 오해 | 실제 결합 전략 구현 전까지 의사결정에서 제외 |

---

## VPS 운영 구조: 수집 + 크론 백테스트

### 아키텍처

```
VPS (상시 실행)
┌─────────────────────────────────────────────────┐
│  Helius WS Ingester (24/7)                      │
│    → 온체인 swap 실시간 수신                      │
│    → data/realtime/                            │
│        runtime-diagnostics.json                │
│        current-session.json                    │
│        sessions/<timestamp>-<mode>/            │
│          raw-swaps.jsonl      (원본 swap)      │
│          micro-candles.jsonl  (1s/5s/15s/60s)  │
│          realtime-signals.jsonl (trigger 발화)  │
└─────────────────────────────────────────────────┘
          │
          │  파일 시스템 공유 (같은 VPS)
          ▼
┌─────────────────────────────────────────────────┐
│  Cron Job (매 N시간)                             │
│    1. 최신 session 디렉토리 감지                  │
│    2. micro-backtest × 파라미터셋 A/B/C/D 실행   │
│    3. Edge Score 비교 → JSON 저장                │
│    4. Telegram 알림 (요약)                       │
└─────────────────────────────────────────────────┘
```

### 핵심 원칙

1. **수집과 분석 분리** — 수집은 중단 없이 24/7, 분석은 크론으로 독립 실행
2. **같은 데이터, 다른 파라미터** — 동일 `raw-swaps.jsonl`을 여러 파라미터로 반복 재생
3. **누적 신뢰도** — signals 10 → 50 → 100으로 쌓이며 Edge Score 신뢰도 상승
4. **비용 0** — Helius WS 구독은 크레딧 소비 없음

### 수집 프로세스 (PM2 상시)

```bash
# ecosystem.config.cjs에 추가
pm2 start scripts/realtime-shadow-runner.ts \
  --name helius-collector \
  --interpreter npx \
  --interpreter-args "ts-node" \
  -- --run-minutes 0 --signal-target 0 --verbose-runtime
  # run-minutes=0, signal-target=0 → 무한 수집
```

출력:
```
data/realtime/
  runtime-diagnostics.json
  current-session.json
  sessions/
    2026-03-23T00-00-00-000Z-live/
      raw-swaps.jsonl         ← 원본 swap 데이터 (계속 append)
      micro-candles.jsonl     ← 빌드된 마이크로캔들
      realtime-signals.jsonl  ← trigger 발화 기록
      manifest.json           ← export 시점 세션 메타
```

### 크론 백테스트 (매 6시간)

```bash
# crontab -e
0 */6 * * * /home/deploy/solana-momentum-bot/scripts/cron-backtest.sh >> /var/log/cron-backtest.log 2>&1
```

`scripts/cron-backtest.sh` 내용:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# 최신 세션 디렉토리 감지
SESSION=$(ls -td data/realtime/sessions/*/ 2>/dev/null | head -1)
if [ -z "$SESSION" ]; then
  echo "No session found"
  exit 0
fi

SWAPS=$(wc -l < "$SESSION/raw-swaps.jsonl" 2>/dev/null || echo 0)
echo "[$(date)] Session: $SESSION | Swaps: $SWAPS"

if [ "$SWAPS" -lt 100 ]; then
  echo "Insufficient swaps ($SWAPS < 100), skipping"
  exit 0
fi

OUTDIR="results/cron-backtest/$(date +%Y-%m-%dT%H-%M)"
mkdir -p "$OUTDIR"

# 파라미터셋 A: 현재 기본값
npx ts-node scripts/micro-backtest.ts \
  --dataset "$SESSION" \
  --volume-multiplier 3.0 --confirm-bars 3 --confirm-change-pct 0.02 \
  --estimated-cost-pct 0.0065 --json > "$OUTDIR/params-A.json"

# 파라미터셋 B: 스윕 최적값
npx ts-node scripts/micro-backtest.ts \
  --dataset "$SESSION" \
  --volume-multiplier 2.5 --confirm-bars 3 --confirm-change-pct 0.02 \
  --estimated-cost-pct 0.0065 --json > "$OUTDIR/params-B.json"

# 파라미터셋 C: 공격적 (낮은 문턱)
npx ts-node scripts/micro-backtest.ts \
  --dataset "$SESSION" \
  --volume-multiplier 2.0 --confirm-bars 2 --confirm-change-pct 0.01 \
  --estimated-cost-pct 0.0065 --json > "$OUTDIR/params-C.json"

# 파라미터셋 D: 보수적 (높은 문턱)
npx ts-node scripts/micro-backtest.ts \
  --dataset "$SESSION" \
  --volume-multiplier 3.5 --confirm-bars 3 --confirm-change-pct 0.03 \
  --estimated-cost-pct 0.0065 --json > "$OUTDIR/params-D.json"

echo "[$(date)] Results saved to $OUTDIR"

# 비교 요약 출력
echo "=== Edge Score Comparison ==="
for f in "$OUTDIR"/params-*.json; do
  NAME=$(basename "$f" .json)
  EDGE=$(jq -r '.summary.edgeScore' "$f")
  SIGNALS=$(jq -r '.summary.totalSignals' "$f")
  DECISION=$(jq -r '.summary.stageDecision' "$f")
  echo "  $NAME: Edge=$EDGE Signals=$SIGNALS Decision=$DECISION"
done
```

### 파라미터셋 정의

| 셋 | volumeMultiplier | confirmBars | confirmChangePct | 의도 |
|----|-----------------|-------------|-----------------|------|
| A | 3.0 | 3 | 0.02 | 코드 기본값 (운영 .env) |
| B | 2.5 | 2 | 0.01 | micro replay 최적 (signal 밀도 높음) |
| C | 2.0 | 2 | 0.01 | 공격적 (signal 많이) |
| D | 3.5 | 3 | 0.03 | 보수적 (signal 적지만 정밀) |

추가 가능한 파라미터 (현재 CLI 지원):

| CLI 플래그 | 기본값 | 역할 |
|-----------|--------|------|
| `--primary-interval` | 10 | 주봉 주기(초). 15s 수집 데이터 사용 시 15로 변경 |
| `--confirm-interval` | 60 | 확인봉 주기(초) |
| `--volume-lookback` | 20 | 볼륨 평균 윈도우 |
| `--breakout-lookback` | 20 | 가격 돌파 윈도우 |
| `--cooldown-sec` | 300 | 재진입 대기(초) |

> **주의:** SL/TP multiplier는 현재 CLI에 미노출. 필요 시 `--sl-atr-multiplier`, `--tp1-multiplier`, `--tp2-multiplier` 추가 구현 가능.

### 판단 흐름

```
signals < 10   → 참고만, 의사결정 금지
signals 10~49  → weak sample, 경향만 확인
signals 50~99  → 파라미터 비교 가능
signals ≥ 100  → Edge Score 해석 시작

Edge Score 비교:
  4개 파라미터셋 중 최고 Edge → 후보
  후보의 stageDecision이 keep/keep_watch → Paper 50 trades 진행
  후보의 stageDecision이 reject → 파라미터 재설계
```

### Telegram 알림 예시

```
📊 Cron Backtest (2026-03-24 06:00)
Session: 2026-03-23, Swaps: 12,847

  A (기본):    Edge 65 | 23 signals | keep_watch
  B (스윕최적): Edge 72 | 31 signals | keep_watch
  C (공격적):  Edge 58 | 47 signals | retune
  D (보수적):  Edge 71 | 15 signals | weak_sample

→ 파라미터셋 B 선도, 48h 후 재평가
```

### Paper 전환 기준

크론 백테스트에서 아래 조건이 모두 충족되면 최적 파라미터로 Paper 50 trades 시작:

| 조건 | 기준 |
|------|------|
| 누적 signals | ≥ 50 |
| 최고 Edge Score | ≥ 70 |
| stageDecision | keep 또는 keep_watch |
| 양수 풀 비율 | ≥ 50% |
| Expectancy | > 0 |

---

## 최신 스윕 결과 요약 (2026-04-01)

### CSV 5분봉 스윕 (19 tokens × 960 combos)

| Rank | volume | tp1 | tp2 | sl | timeStop | AvgSharpe | Trades | +Tokens |
|------|--------|-----|-----|-----|---------|-----------|--------|---------|
| 1 | 3.0 | 1.5 | 5.0 | 1.5 | 25 | 2.22 | 313 | 12/17 |
| 2 | 3.5 | 0.5 | 5.0 | 1.25 | 20 | 2.19 | 281 | 11/17 |
| 3 | 3.0 | 1.5 | 5.0 | 1.25 | 25 | 2.14 | 315 | 12/17 |

파라미터 안정도 (상위 15개):

| 파라미터 | 범위 | 수렴도 |
|----------|------|--------|
| tp2MultiplierA | 5.0 | **100% 일치** (가장 강한 시그널) |
| slAtrMultiplierA | 1.25~1.50 | mode 1.25 |
| volumeMultiplier | 3.0~3.5 | mode 3.5 |
| tp1MultiplierA | 0.5~1.5 | mode 1.5 |
| timeStopMinutesA | 15~30 | mode 20 |

### 적용된 운영 파라미터

| 파라미터 | 이전 | 스윕 후 | 근거 |
|----------|------|---------|------|
| TP2_MULTIPLIER | 10.0 | 5.0 (스윕 최적) | v5 runner-centric으로 **10.0** 유지. live 50-trade로 재판단 |
| SL_ATR_MULTIPLIER | 1.0 | **1.25** | 스윕 안정 영역. live env는 1.5 |
| VOLUME_SPIKE_MULTIPLIER | 2.5 | **3.0** | 스윕 + STRATEGY.md 합의 |

### Replay-Loop 결과 (2026-04-05)

4 sessions × 2 modes (bootstrap micro + 5m strategy) = 8 parallel backtests.
상세: [`results/replay-loop-report-2026-04-05.md`](./results/replay-loop-report-2026-04-05.md)

| 모드 | 결과 |
|------|------|
| Bootstrap micro-replay | 1/4 pass (04-04 edgeScore 78, +6.89%), 3/4 reject |
| 5m Strategy A/C | 87 pairs × 3 strategies → **3건 trade** (구조적 비적합) |

핵심 병목: **sparse data insufficient 81%** — Feature 4(zero-volume skip) 후유증.

> **결론**: 5m Strategy A/C는 밈코인에서 dormant. bootstrap_10s가 유일한 유효 trigger.

---

## 예상 일정

```text
Completed: auto-backtest.ts 복구 + pool-file 지원
Completed: realtime shadow -> export -> replay -> report 경로 검증
Completed: VPS 운영 구조 설계 (수집 + 크론 백테스트)
Completed: v5 CSV 19-token 파라미터 스윕 (2026-04-01)
Completed: v5 realtime micro replay 검증 (2026-04-01)
In Progress: VPS live canary 운영 + 10s primary 데이터 수집
Next: 10s primary 데이터 50+ signals 누적 → micro replay 재검증
Next: 크론 백테스트 배포 → 파라미터 비교 자동화
Next: signals ≥ 50 도달 → 최적 파라미터 확정 → Paper 50 trades
```
