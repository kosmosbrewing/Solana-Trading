# Session Replay Parameter Sweep

> Status: draft implementation guide
> Updated: 2026-04-05
> Scope: `./data/realtime/sessions` 운영 세션 `micro-candles` 기반 replay/backtest parameter sweep

## Goal

운영 세션 데이터를 그대로 사용해 전략별 replay/backtest를 반복 실행하고,
전략별 최적 파라미터 조합과 근거 통계를 Markdown 문서로 남긴다.

## Data Source

- root: `./data/realtime/sessions`
- input: session directory의 `micro-candles.jsonl`
- optional filter: `realtime-signals.jsonl` line count 기준 상위 세션 우선

## Strategy Lanes

### 1. `bootstrap_10s`

- runner: `micro-backtest` 계열 realtime replay
- input fidelity: session micro-candle stream
- primary metrics:
  - weighted adjusted return
  - edge score
  - gate-pass session count
  - keep/keep_watch session count
  - total replayed signals

기본 grid (`standard`):
- `volumeMultiplier`: `1.6, 1.8, 2.0, 2.2, 2.4`
- `minBuyRatio`: `0.55, 0.60, 0.65`
- `volumeLookback`: `20, 30, 40`
- `cooldownSec`: `180, 300, 420`
- total: `135` combos

### 2. `volume_spike`

- runner: `session-backtest` 기반 5m price replay
- caveat: runtime-equivalent expectancy가 아니라 price-response screening
- primary metrics:
  - stage score / edge score
  - positive pair ratio
  - total trades
  - average net PnL%
  - gate-pass session count

기본 grid (`standard`):
- `volumeMultiplier`: `2.0, 2.5, 3.0, 3.5`
- `minBreakoutScore`: `40, 50, 60`
- `minBuyRatio`: `0.60, 0.65`
- `tp1Multiplier`: `0.75, 1.0`
- `tp2Multiplier`: `7.5, 10.0, 12.5`
- `slAtrMultiplier`: `1.0, 1.25`
- total: `288` combos

### 3. `fib_pullback`

- runner: `session-backtest` 기반 5m price replay
- caveat: runtime-equivalent expectancy가 아니라 price-response screening
- primary metrics:
  - stage score / edge score
  - positive pair ratio
  - total trades
  - average expectancy R
  - gate-pass session count

기본 grid (`standard`):
- `impulseWindowBars`: `6, 8, 10`
- `impulseMinPct`: `0.08, 0.10, 0.12, 0.15`
- `tp1Multiplier`: `0.80, 0.85, 0.90`
- `timeStopMinutes`: `20, 40, 60`
- total: `108` combos

## Session Selection

기본 원칙:
- `*-live` 세션 우선
- 필요 시 `legacy-*` 포함
- stored signal count가 있는 세션을 우선
- 기본은 `minStoredSignals >= 1`

추천 기본:
- top `5`~`8` sessions
- replay sweep과 live canary 방향 비교

## Ranking Policy

### Bootstrap

정렬 우선순위:
1. gate-pass session count
2. keep/keep_watch session count
3. weighted adjusted return
4. average edge score
5. total signals

### Volume Spike / Fib Pullback

정렬 우선순위:
1. gate-pass session count
2. keep/keep_watch session count
3. stage score
4. total trades
5. average net PnL%

## Output

각 실행은 아래 산출물을 남긴다.

- `results/session-replay-sweep-<strategy>-<timestamp>.json`
- `results/session-replay-sweep-<strategy>-<timestamp>.md`

Markdown 문서에는 아래를 포함한다.

- dataset / session selection
- grid definition
- top parameter profiles
- best profile session-by-session breakdown
- strategy-specific caveats
- mission 해석용 operator notes

## Guardrails

- `bootstrap_10s` 결과와 5m 전략 결과를 같은 fidelity로 섞지 않는다
- 5m replay는 live-equivalent execution evidence로 쓰지 않는다
- top 1 profile만 보지 않고 top 3~5 안정 구간을 같이 본다
- replay 결과는 active plan 기준 live/paper gate와 직접 동일시하지 않는다
