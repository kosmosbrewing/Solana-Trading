# 2026-04-06 Audit Note

## Scope

- 목적: 2026-04-06 기준 realtime 운영/전략/문서 상태를 전수 점검한 결과를 단건 메모로 고정
- 기준 소스:
  - `docs/exec-plans/active/1sol-to-100sol.md`
  - `docs/runbooks/live-ops-loop.md`
  - `STRATEGY.md`
  - `STRATEGY_NOTES.md`
  - `MEASUREMENT.md`
  - `OPERATIONS.md`
  - `ARCHITECTURE.md`
  - `src/index.ts`
  - `src/scanner/scannerEngine.ts`
  - `src/realtime/microCandleBuilder.ts`
  - `src/realtime/replayStore.ts`
  - `src/strategy/volumeMcapSpikeTrigger.ts`
  - `src/strategy/momentumTrigger.ts`

## Fixed Facts

### 1. Current live interpretation

- 현재 active plan의 P0는 `idle universe + volume gate 병목 해소`가 맞다.
- 최근 12h live 해석의 중심은 `wallet`, `queue_overflow`, `alias_miss`, `unsupported_dex`가 아니라:
  - `idleSkip` 대량
  - 실제 평가된 candle의 `volInsuf`
- 따라서 현재 mission-aligned 우선순위는 threshold 완화보다 freshness 개선이다.

### 1A. Problem 1 is not simply "too few tickers"

- 운영에서 보이는 문제 1은 `티커 수가 적다`보다 `fresh candidate diversity가 부족하다`로 정의하는 편이 정확하다.
- 핵심은:
  - stale/idle pair가 watchlist와 realtime slot을 오래 점유하고
  - fresh candidate가 trigger에 충분히 노출되지 못하며
  - 결과적으로 실질 universe가 매우 좁게 유지된다는 점이다.
- 따라서 문제 1은:
  - discovery failure
  - 보다는
  - 발견 이후 freshness 유지 실패 / stale pair occupancy
  로 읽어야 한다.
- 이 문제가 사명에 중요한 이유는:
  - 50 live canary trades 확보 속도를 늦추고
  - 특정 종목/특정 시장 구간 편향을 키우며
  - live edge 검증 표본 자체를 왜곡할 수 있기 때문이다.
- 그래서 현재 P0의 `idle universe + freshness 개선`은 곧 문제 1의 구체적 운영 해석이다.

### 2. Realtime trigger wiring

- realtime trigger는 bootstrap과 core가 동시에 도는 구조가 아니다.
- `REALTIME_TRIGGER_MODE=bootstrap`이면 `VolumeMcapSpikeTrigger`만 active다.
- `REALTIME_TRIGGER_MODE=core`일 때만 `MomentumTrigger`가 active다.
- 현재 문서 기준 runtime default는 bootstrap이고, `core_momentum`은 standby다.

### 3. Bootstrap/core semantics

- `bootstrap_10s`는 breakout/confirm 전략이 아니다.
- 실제 동작은 `10초봉 volume surge + buy ratio` 2-gate다.
- `core_momentum`은 5분 전략이 아니라 realtime에서:
  - primary `10s`
  - confirm `60s`
  구조다.

### 4. Realtime candle model

- WS swap 이벤트가 들어오면 메모리에서 `5s / 10s / 60s` candle을 계산한다.
- 판단은 파일이 아니라 `MicroCandleBuilder`의 메모리 closed history를 직접 사용한다.
- builder는 1초 sweep으로 bucket 종료를 판정하고 synthetic zero-volume candle을 메모리에 채운다.

### 5. micro-candles artifact semantics

- `micro-candles.jsonl`은 latest-only 조회 결과가 아니라 세션 전체 append-only artifact다.
- 과거 timestamp가 보이는 것은 정상이다.
- 같은 `(pairAddress, intervalSec, timestamp)`가 여러 번 보일 수도 있다.
- 현재 저장은 `tradeCount > 0` candle만 파일에 append한다.
- synthetic zero-volume candle이 전부 파일에 저장되는 구조는 아니다.

### 6. Why micro-candles can be larger than raw-swaps

- one swap can contribute to multiple intervals (`5s / 10s / 60s`)
- file format is append-only
- no on-write dedupe
- later range export/load reads whole file sequentially

즉 `micro-candles.jsonl`가 `raw-swaps.jsonl`보다 커지는 것은 현재 구조상 가능하다.

### 7. Raw artifact priority

- replay/backtest/postmortem 관점에서 더 중요한 원본은 `raw-swaps.jsonl`이다.
- `micro-candles.jsonl`은 파생 artifact에 가깝다.
- 장기적으로 저장 정책을 다이어트한다면 raw-swaps를 우선 보존하는 쪽이 맞다.

## Important Corrections

### 1. "Watchlist empty" is too strong

- 현재 코드는 swap이 있어야 open candle을 만들고, 그 뒤에만 missing bucket을 synthetic candle로 채운다.
- 따라서 `evals=0`, `sparseInsuf=0` 같은 구간을 바로 `watchlist empty`로 읽으면 오판 가능성이 있다.
- `idleSkip`가 같이 높다면 더 정확한 해석은:
  - watchlist completely empty
  - 가 아니라
  - narrow universe + idle synthetic candle dominance

### 2. Idle eviction does not mean immediate slot release

- scanner idle eviction은 들어갔지만, realtime unsubscribe는 즉시 일어나지 않는다.
- `removeRealtimePoolTarget()`는 alias grace period를 공유한다.
- 현재 구조는:
  - idle detect
  - candidateEvicted
  - removeRealtimePoolTarget
  - up to 5 min grace
  - unsubscribe
  순서다.
- 따라서 `10m idle -> immediate slot release`는 과장이고,
  실제로는 `10m idle + up to 5m grace`에 가깝다.

### 3. Unsupported DEX is not always the primary bottleneck

- 과거 일부 구간에서는 `unsupported_dex_after_lookup`가 admission 병목이었다.
- 그러나 latest 12h diagnosis 기준으로는 주병목이 아니었다.
- 따라서 이 항목은 항상 P0가 아니라, window-specific secondary issue로 읽어야 한다.

## Mission Interpretation

- 현재 mission에 맞는 방향은 `더 많이 허용`이 아니다.
- 더 정확한 방향은:
  1. stale/idle pair를 빨리 제거
  2. fresh candidate turnover 증가
  3. live sample sufficiency 확보
  4. 그 뒤에 threshold 미세 조정

즉 `50 live canary trades 확보`는 사명 포기가 아니라 사명 검증을 가능한 단계로 만드는 운영 목표다.

## Recommended Next Order

1. idle/stale pair eviction 운영 효과 검증
2. `scannerMinimumResidencyMs` / `scannerReentryCooldownMs` 완화 효과 확인
3. 24h live observation
4. 그래도 signal이 부족하면 `volumeSurgeMultiplier 1.8 -> 1.6` 조건부 검토
5. unsupported DEX / breadth 확장은 후순위

## Documentation Mismatch To Revisit

- `ARCHITECTURE.md`의 전략 상태 표는 아직 일부 historical 표현이 남아 있다.
- current runtime 기준은 `STRATEGY.md`와 active plan을 우선한다.
- 필요 시 다음 정리 대상:
  - A/C/E status wording
  - realtime bootstrap/core active/standby wording

## One-line Conclusion

현재 2026-04-06 기준 핵심은 "실행 경로 장애"가 아니라 "stale/idle pair가 좁은 universe를 점유하고, 실제 평가된 pair도 quality가 낮아 signal을 못 만드는 상태"이며, 따라서 mission-aligned P0는 freshness 개선이다.
