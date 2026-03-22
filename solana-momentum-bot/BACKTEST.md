# 대량 백테스트 실행 계획

> Created: 2026-03-22
> Updated: 2026-03-22 (realtime micro replay 경로 반영)
> Goal: 5분봉 대량 백테스트와 realtime micro replay를 분리해 각각의 역할로 edge를 검증한다

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
| Micro Replay Engine | `src/backtest/microReplayEngine.ts` | 사용 가능 | realtime dataset 재생 |
| Micro Replay CLI | `scripts/micro-backtest.ts` | 사용 가능 | `gate on/off`, horizon 비교, measurement score 출력 |

### 실행 순서

1. `auto-backtest.ts`로 데이터셋 수집 및 baseline 실행
2. `volume_spike` 스윕 실행
3. `fib_pullback` 스윕 실행
4. 결과 비교 후 상위 파라미터만 재검증

기본 명령:

```bash
./scripts/auto-backtest.sh
```

전략별 스윕:

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

### 파라미터 범위

| 파라미터 | 범위 | 단계 | 비고 |
|---------|------|------|------|
| `maxRiskPerTrade` | 0.005 ~ 0.025 | 0.005 | 현재 CLI 기본 범위와 일치 |
| `minBreakoutScore` | 40 ~ 70 | 10 | 현재 CLI 기본 범위와 일치 |
| `volumeMultiplier` | 2.0 ~ 4.0 | 0.5 | volume spike |
| `tp1MultiplierA` | 1.0 ~ 2.0 | 0.25 | volume spike |
| `tp2MultiplierA` | 2.0 ~ 3.5 | 0.5 | volume spike |
| `impulseMinPct` | 0.10 ~ 0.20 | 0.025 | fib pullback |
| `tp1MultiplierC` | 0.80 ~ 0.95 | 0.05 | fib pullback |

문서상 목표 범위를 더 넓히고 싶다면, 먼저 `scripts/multi-token-sweep.ts` 기본 범위를 수정해야 한다.

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

현재 live 검증 기준:

- tuned realtime dataset 1회에서 `signals=2`
- `gate_rejected` 1건, `execution_viability_rejected` 1건
- 30초 기준 평균 조정 수익률 `+0.27%`

즉 구현은 끝났고, 남은 건 `표본 축적`이다.

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

## 예상 일정

```text
Completed: auto-backtest.ts 복구 + pool-file 지원
Completed: realtime shadow -> export -> replay -> report 경로 검증
Next: realtime shadow 100-signal 누적
Next: micro parameter sweep + execution viability 해석
```
