# Core 5m Replay Loop Runbook

> Last updated: 2026-04-05
> Scope: live session dataset 기준 `volume_spike` / `fib_pullback` 5분 price replay -> pair 분해 -> parameter drill-down
> Primary refs: [`REALTIME.md`](../../REALTIME.md), [`BACKTEST.md`](../../BACKTEST.md), [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md)

## Role

이 문서는 session dataset으로 `volume_spike`와 `fib_pullback`를 반복 검증하기 위한 runbook이다.

- `micro-candles`를 `300s`로 재집계한다
- `volume_spike`, `fib_pullback`, `both`를 같은 입력으로 다시 돌린다
- pair별 편차를 확인한다
- 파라미터를 완화/강화했을 때 signal density와 성과가 어떻게 달라지는지 본다
- 다음 액션을 `core revive / threshold tuning / bootstrap 유지` 중 어디에 둘지 연결한다

이 문서는 runtime-equivalent backtest 문서가 아니다.
현재 구현은 [session-backtest.ts](../../scripts/session-backtest.ts) 기준의 `price replay only` 경로이며, live gate/risk/execution metadata를 복원하지 않는다.

---

## Standard Loop

반복 루프는 아래 순서로 고정한다.

1. 세션 dataset 확인
2. `both` 기준 baseline replay
3. `volume_spike` 단독 replay
4. `fib_pullback` 단독 replay
5. pair별 상위/하위 결과 확인
6. parameter drill-down
7. `bootstrap_10s`와 역할 분리 관점으로 해석

---

## 1. Dataset Check

저장소 루트에서 실행:

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
```

세션 목록:

```bash
find data/realtime/sessions -maxdepth 1 -type d -name '*-live' | sort
```

현재 session-backtest는 `micro-candles.jsonl`가 있으면 동작한다.
즉 `realtime-signals.jsonl`이 없어도 5분 price replay는 가능하다.

확인:

```bash
find data/realtime/sessions/<session>-live -maxdepth 1 -name 'micro-candles.jsonl'
```

---

## 2. Baseline Replay

목적:

- `volume_spike`와 `fib_pullback`가 session price action 기준으로 살아 있는지 빠르게 본다

기본 명령:

```bash
npx tsx scripts/session-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --strategy both
```

JSON 출력:

```bash
npx tsx scripts/session-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --strategy both \
  --json
```

의미:

- 입력: `micro-candles.jsonl`
- 중간: 가장 작은 base interval을 골라 `300s` candle로 재집계
- 출력: pair별 `volume_spike`, `fib_pullback`, `combined`

주의:

- `combined`는 세션 전체 포트폴리오가 아니라 pair 내부 조합 결과다
- `replayMode=price_replay_only`를 항상 같이 본다

---

## 3. Strategy-Specific Replay

### Volume Spike only

```bash
npx tsx scripts/session-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --strategy volume_spike
```

### Fib Pullback only

```bash
npx tsx scripts/session-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --strategy fib_pullback
```

권장 해석:

- `both`는 빠른 개요
- 실제 전략 판단은 `volume_spike`와 `fib_pullback`를 따로 본다

---

## 4. Pair Drill-Down

목적:

- 어느 pair에서만 신호가 나는지
- 상위 결과가 broad edge인지 특정 pair outlier인지 본다

단일 pair:

```bash
npx tsx scripts/session-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --strategy volume_spike \
  --pair <pair_address> \
  --json
```

출력에서 먼저 볼 것:

- `totalTrades`
- `winRate`
- `netPnlPct`
- `profitFactor`
- `maxDrawdownPct`

판정:

- 상위 1~2 pair만 강하면 outlier 의존 가능성이 크다
- pair 대부분이 `totalTrades=0`이면 parameter가 너무 보수적일 수 있다

---

## 5. Parameter Drill-Down

목적:

- `core`가 죽은 건지
- 아니면 현재 threshold가 너무 타이트한지 구분한다

### Volume Spike relaxed check

```bash
npx tsx scripts/session-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --strategy volume_spike \
  --min-buy-ratio 0 \
  --min-score 0 \
  --vol-mult 1.5 \
  --vol-lookback 10
```

### Volume Spike stricter check

```bash
npx tsx scripts/session-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --strategy volume_spike \
  --min-buy-ratio 0.65 \
  --min-score 70 \
  --vol-mult 2.5 \
  --vol-lookback 20
```

### Fib Pullback relaxed check

```bash
npx tsx scripts/session-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --strategy fib_pullback \
  --fib-impulse-bars 6 \
  --fib-impulse-min-pct 0.03 \
  --fib-time-stop 10
```

### Fib Pullback stricter check

```bash
npx tsx scripts/session-backtest.ts \
  --dataset ./data/realtime/sessions/<session>-live \
  --strategy fib_pullback \
  --fib-impulse-bars 10 \
  --fib-impulse-min-pct 0.06 \
  --fib-time-stop 20
```

해석:

- 완화했을 때만 trade가 나오면 `core` 자체보다 threshold 문제일 가능성이 있다
- 완화해도 거의 안 나오면 현재 세션 구조가 `core`와 맞지 않는 쪽일 수 있다

---

## 6. Session Comparison

여러 세션을 비교할 때는 아래 순서로 본다.

1. 최근 active live 세션
2. signal density가 높았던 세션
3. bootstrap runner가 강했던 세션
4. bootstrap이 약했던 세션

권장 질문:

- `volume_spike`가 아예 0-trade인가
- `fib_pullback`는 특정 pair에서만 제한적으로 되는가
- relaxed parameter에서만 살아나는가
- bootstrap strong session에서 core도 같이 좋아지는가

---

## 7. Decision Rules

### A. Core revive candidate

아래면 core 재도전 후보로 본다.

- relaxed parameter에서 multiple pair가 양수
- 특정 outlier 1개가 아니라 상위 pair가 분산됨
- `volume_spike`와 `fib_pullback` 중 하나라도 일관된 plus가 보임

### B. Threshold issue

아래면 전략이 완전히 죽은 건 아닐 수 있다.

- baseline은 0-trade 또는 약한 음수
- relaxed에서만 trade가 늘고 성과가 개선

후속:

- 문서 기준선과 분리된 실험군으로 별도 저장
- default 운영값과 섞지 않는다

### C. Bootstrap stay default

아래면 bootstrap default 유지가 맞다.

- baseline/relaxed 모두 core trade가 거의 없음
- 성과가 특정 pair 1개에만 의존
- drawdown이 커서 실전 후보로 보기 어려움

---

## Interpretation Guardrails

- 이 경로는 `price replay only`다
- 현재 runtime의 `discoverySource`, `marketCapUsd`, `volumeMcapRatio`, `execution viability`, `wallet/risk state`는 재현하지 않는다
- 따라서 이 결과는 `core 전략의 가격 반응 screening`이지 `live-equivalent expectancy`가 아니다

특히 아래를 조심한다.

- `pair 1개 + trade 몇 건`의 양수 결과를 전략 승격 근거로 쓰지 않는다
- `combined`를 세션 전체 포트폴리오 결과로 읽지 않는다
- relaxed parameter 결과를 default 운영값과 섞지 않는다

---

## Current Use

이 문서의 목적은 지금 당장 `core를 승격하자`가 아니다.

현재 우선순위는:

1. session 기준으로 `volume_spike` / `fib_pullback`가 정말 전혀 안 되는지 확인
2. 된다면 threshold 문제인지 구조 문제인지 구분
3. 결과를 `bootstrap_10s` default 유지 판단과 연결

즉, `core 5m` replay는 bootstrap 대체가 아니라
`언제 core를 다시 시험할 수 있는지`를 판단하는 보조 루프다.
