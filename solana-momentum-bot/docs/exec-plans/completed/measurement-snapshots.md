# Measurement Snapshots Archive

> Status: archive
> Updated: 2026-03-31
> Purpose: 과거 시점의 measurement 해석과 운영 스냅샷을 보관한다.
> Source policy: 현재 점수 체계와 판정 규칙은 [`MEASUREMENT.md`](../../../MEASUREMENT.md)를 따른다.

## Role

이 문서는 historical snapshot archive다.

- 현재 정책 문서가 아니다
- 특정 날짜의 운영 판단을 당시 맥락으로 보관한다
- 현재 상태를 말할 때는 이 문서를 source of truth로 쓰지 않는다

## Snapshot: 2026-03-24 UTC

### 1. 코드베이스 준비도

| 항목 | 당시 상태 | 근거 |
|---|---|---|
| 전략/게이트/리스크/실행 배선 | 구현 완료 수준 | Strategy A/C/D/E, 5+1 gate, Risk Tier, WalletManager, realtime path 존재 |
| 측정 파이프라인 | 구현 완료 수준 | backtest, paper validation, realtime shadow telemetry, audit log 존재 |
| 테스트 상태 | 양호 | `2026-03-24` 기준 `40 suites / 172 tests` 통과 |
| 운영 프로세스 관리 | 개선 완료, 추가 관찰 필요 | PM2 `fork_mode` 전환 후 startup loop 해소 |

### 2. 운영 상태 스냅샷

| 구분 | 당시 상태 | 해석 |
|---|---|---|
| PM2 runtime | `momentum-bot online`, `fork_mode`, `restarts = 0` after recreation | 당시 기준 기동 안정화 상태 |
| Live bootstrap | 진행 중 | full live composite 측정 이전 단계 |
| Helius plan | Developer tier | Free 대비 headroom은 늘었지만 startup `seed backfill` burst는 관찰 필요 |
| GeckoTerminal | 429 관찰됨, retry path 존재 | 즉시 치명 장애는 아니지만 watchlist churn / backfill quality 리스크 |
| `helius-collector` | 별도 프로세스 중지 가능 | 본체 runtime과 분리 운영 여부 점검 필요 |

### 3. Stage별 측정 가능 상태

| 단계 | 당시 측정 가능 여부 | 당시 판단 |
|---|---|---|
| Backtest | 가능 | `Edge Score` 중심으로 평가 가능 |
| Realtime Shadow | 가능 | `Realtime Edge Score + execution telemetry` 해석 가능 |
| Paper | 부분 가능 | 정책은 준비됐지만 `50 trades` 표본이 없었음 |
| Live | 불충분 | `Composite Score` 계산에 필요한 표본과 안정성 구간이 부족했음 |

### 4. Gate 관점 당시 판단

| Gate | 당시 판단 | 이유 |
|---|---|---|
| Mission Gate | 아직 판정 불가 (`N/A`) | 최근 `50 executed trades` 표본 부족 |
| Execution Gate | 아직 통과 판정 불가 | 최근 `24h uptime`, `20 measured trades`, `20 measured exits` 기준 미충족 |
| Edge Gate | backtest 기준만 부분 판정 가능 | paper/live 실표본 부족 |

### 5. 사명 근접도 해석

- **구현 근접도**: 높음
- **검증 근접도**: 낮음
- **운영 근접도**: 중간

당시 한 줄 요약:

> **Mission engine is mostly built, but mission proof is still early-stage.**

### 6. 당시 공식 판단

- **Backtest**: 채택 후보 압축용으로 사용 가능
- **Realtime Shadow**: execution telemetry 해석 가능
- **Paper**: 아직 live gate 통과 전 단계
- **Live**: bootstrap 관찰 단계이며, 아직 `full Composite` 평가 대상으로 보지 않음

### 7. 당시 인정 기준

1. Paper `50 trades` 이상 + expectancy 양수
2. 최근 `24h` uptime `>= 95%` + unhandled crash `<= 1`
3. 최근 `20 measured trades` 기준 quote quality 기준 충족
4. 최근 `50 executed trades` 기준 Mission Gate 항목 충족

## Snapshot: 2026-03-22

### 전체 진행 상황

```text
[완료] 5m CSV backtest (7일 × 10 tokens, 51 trades, WR 43%)
[완료] Parameter sweep (2000 combos, 최적 파라미터 적용)
[완료] Realtime pipeline 구현 (Helius WS → swap → candle → trigger → outcome)
[완료] Realtime shadow runner 구현 (session 실행 → export → summary)
[실패] Historical swap backfill 시도
[진행] Realtime shadow 24h 실행
[대기] Paper 50 trades 검증
```

### Historical Swap Backfill 시도 결과

| 블로커 | 상세 | 영향 |
|---|---|---|
| Parser 호환성 | `swapParser.ts`가 PumpSwap(Pump.fun AMM) 미지원 | GeckoTerminal trending 밈코인 대부분이 PumpSwap, 파싱 성공률 <1% |
| API 시간 필터 불가 | `getSignaturesForAddress`에 timestamp 필터 없음 | 하루 118K sigs를 전체 순회해야 특정 시간대 도달, 풀당 30분+ |
| 크레딧 비용 | 활성 풀 하루 100K+ txs × 100 credits/tx | 1풀 = 10M+ credits, 월 한도 초과 |

추가 발견:

- 균등 샘플링은 candle sparse 문제로 trigger 발화가 어려웠다
- window 기반 연속 샘플링은 trigger 최소 요구 시간을 충족하지 못했다
- top pools는 momentum breakout이 거의 없었다

결론:

- historical swap backfill 구현 자체는 가능했지만 실전 경로로는 비실용적이었다
- realtime shadow 전환이 당시 올바른 판단이었다

### 당시 Edge 검증 경로

```text
5m backtest = 후보 압축
realtime shadow = trigger edge 검증
paper 50 trades = go/no-go
```
