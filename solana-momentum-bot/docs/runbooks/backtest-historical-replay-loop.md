# Historical Replay Loop Runbook

> Last updated: 2026-04-05
> Scope: Helius RPC 과거 swap 수집 -> momentum/core-style historical replay dataset 생성 -> edge summary 확인 -> pool별 drill-down
> Primary refs: [`REALTIME.md`](../../REALTIME.md), [`BACKTEST.md`](../../BACKTEST.md), [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md)

## Role

이 문서는 `live/paper` 표본이 부족할 때 과거 onchain swap을 수집해 historical replay로 빠르게 screening하는 runbook이다.

- pool 또는 trending set을 정한다
- `fetch-historical-swaps.ts`로 raw swaps를 수집한다
- 필요한 경우 replay를 같이 돌린다
- pool별 edge summary를 본다
- 다음 액션을 `추가 수집 / pool 좁히기 / bootstrap 비교 / live 검증 후보`로 연결한다

이 문서는 live 운영 문서가 아니다.
현재 구현 기준으로 [fetch-historical-swaps.ts](../../scripts/fetch-historical-swaps.ts)는 `MomentumTriggerConfig` 기반 replay를 사용한다.
즉 이 문서는 `bootstrap_10s` 범용 historical replay 문서가 아니라, 현재 historical screening 경로 문서로 읽는다.

실시간 session replay는 [`backtest-bootstrap-replay-loop.md`](./backtest-bootstrap-replay-loop.md), `core 5m` replay는 [`backtest-core-5m-replay-loop.md`](./backtest-core-5m-replay-loop.md)를 따른다.

---

## Standard Loop

반복 루프는 아래 순서로 고정한다.

1. 대상 pool set 결정
2. dry-run으로 signature 규모 확인
3. fetch + replay 실행
4. aggregate summary 확인
5. pool별 상위/하위 결과 확인
6. 필요하면 `skip-replay` / `max-txs-per-pool` / `days` 조정
7. 가치 있는 후보만 live/session 경로로 다시 검증

---

## 1. Target Selection

저장소 루트에서 실행:

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
```

기본 선택지는 3개다.

### A. 단일 pool

```bash
npx ts-node scripts/fetch-historical-swaps.ts \
  --pools <pool_address> \
  --days 3
```

### B. 여러 pool

```bash
npx ts-node scripts/fetch-historical-swaps.ts \
  --pools <addr1,addr2,addr3> \
  --days 3
```

### C. GeckoTerminal trending

```bash
npx ts-node scripts/fetch-historical-swaps.ts \
  --trending \
  --days 3 \
  --json
```

추천:

- 단일 hypothesis 검증: 단일 pool
- 빠른 후보 스캔: `--trending`
- known pool 비교: 여러 pool

---

## 2. Dry-Run First

목적:

- 비용과 signature 규모를 먼저 본다

```bash
npx ts-node scripts/fetch-historical-swaps.ts \
  --pools <pool_address> \
  --days 1 \
  --dry-run
```

또는:

```bash
npx ts-node scripts/fetch-historical-swaps.ts \
  --trending \
  --days 1 \
  --dry-run \
  --json
```

판정:

- signature 수가 지나치게 크면 `--max-txs-per-pool`을 먼저 둔다
- dry-run 없이 바로 크게 돌리지 않는다

---

## 3. Fetch + Replay

기본 경로:

```bash
npx ts-node scripts/fetch-historical-swaps.ts \
  --pools <pool_address> \
  --days 3
```

출력 흐름:

```text
pool list
  -> signatures fetch
  -> parsed transactions fetch
  -> parseSwapFromTransaction()
  -> raw-swaps.jsonl
  -> replayRealtimeDataset()
  -> summary.json
```

의미:

- 이 경로는 live session이 아니라 historical replay dataset을 만든다
- 목적은 `현재 historical screening trigger가 과거 swap 흐름에서 정보량이 있었는가`를 빠르게 보는 것이다

---

## 4. Fetch Only / Replay Later

수집과 replay를 분리하고 싶으면:

```bash
npx ts-node scripts/fetch-historical-swaps.ts \
  --pools <pool_address> \
  --days 3 \
  --skip-replay
```

이 경우는 아래 상황에 쓴다.

- 비용/수집량만 먼저 확인하고 싶을 때
- raw swaps만 저장하고 다른 trigger 설정으로 나중에 재생할 때

---

## 5. Safety Controls

### Max tx cap

```bash
npx ts-node scripts/fetch-historical-swaps.ts \
  --trending \
  --days 3 \
  --max-txs-per-pool 500
```

### Narrow day window

```bash
npx ts-node scripts/fetch-historical-swaps.ts \
  --trending \
  --days 1
```

### JSON output

```bash
npx ts-node scripts/fetch-historical-swaps.ts \
  --trending \
  --days 3 \
  --json
```

기본 원칙:

- 큰 수집은 `days=1`로 먼저 축소 검증
- `--max-txs-per-pool`로 비용 상한을 둔다
- `--trending`은 dry-run -> small run -> full run 순으로 간다

---

## 6. Interpretation

먼저 aggregate를 본다.

핵심 질문:

1. signal proxy가 충분한가
2. positive pool ratio가 의미 있는가
3. average edge score / return이 한두 pool에만 의존하는가
4. parse failure가 과도하지 않은가

그 다음 pool별로 본다.

추천 구분:

- `useful positive`: replay score / avg return이 같이 양수
- `false positive`: replay score는 나오지만 adjusted가 약하거나 음수
- `sparse`: swap 수는 있어도 replay 정보량이 약함

중요:

- historical replay는 liquidity/execution 현실을 완전히 복원하지 않는다
- 따라서 이 결과는 `후보 pool screening`으로 읽고, live 승격 근거로 바로 쓰지 않는다
- 현재 summary의 `Signals`는 exact runtime signal count가 아니라 proxy 성격으로 읽는다
- exact signal count가 필요하면 별도 replay CLI로 다시 확인한다

---

## 7. Follow-Up Paths

### A. Candidate worth live/session replay

아래면 다음 단계 후보로 둔다.

- replay proxy와 edge summary가 너무 빈약하지 않다
- avg return / edge score가 양수다
- 한 pool만이 아니라 여러 pool에서 비슷한 방향이 보인다

후속:

- 같은 token/pool을 live session에서 다시 본다
- [`backtest-bootstrap-replay-loop.md`](./backtest-bootstrap-replay-loop.md)로 이어서 검증한다

### B. Pool-specific hypothesis

아래면 단일 hypothesis로 좁힌다.

- 특정 pool 하나만 강하다
- 다른 pool은 거의 0-signals 또는 음수다

후속:

- single-pool replay
- 파라미터 변경 전/후 비교

### C. Bad fetch / low value

아래면 수집 전략을 바꾼다.

- parse failure가 크다
- signal density가 너무 낮다
- 비용 대비 summary 정보량이 약하다

후속:

- `days` 축소
- `max-txs-per-pool` 축소
- 대상 pool 재선정

---

## 8. Guardrails

- 이 경로는 live runtime과 다르다
- `wallet`, `risk`, `execution viability`, `real spread drift`는 그대로 재현되지 않는다
- historical replay 양수 = live 승격 아님
- 반대로 historical replay 음수 = 전략 영구 폐기라고도 단정하지 않는다

올바른 읽기:

- historical replay는 `후보군 스크리닝`
- live/session replay는 `현행 runtime 검증`

---

## Current Use

이 문서는 지금 당장 표본이 부족할 때 시간을 단축하는 보조 루프다.

우선순위는:

1. live/session 데이터가 부족할 때 빠른 후보 스캔
2. pool hypothesis를 싸게 줄이기
3. 가치 있는 후보만 realtime/session 검증으로 넘기기

즉, historical replay는 메인 운영 루프를 대체하지 않고
`live 검증 이전의 좁히기 단계`로 쓰는 것이 맞다.

### Important Caveat

현재 [fetch-historical-swaps.ts](../../scripts/fetch-historical-swaps.ts) summary의 `Signals`는
정확한 `totalSignals`를 직접 노출한 값이 아니다.
문서 해석에서는 이를 `signal proxy` 또는 `information density proxy`로 읽고,
정확한 signal 수가 중요할 때는 다른 replay 경로로 재검증한다.
