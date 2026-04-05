# Live Ops Loop Runbook

> Last updated: 2026-04-05
> Scope: VPS 운영 데이터 동기화 -> 로컬 점검 -> Codex 분석 요청 -> 후속 조치
> Primary refs: [`OPERATIONS.md`](../../OPERATIONS.md), [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md)

## Role

이 문서는 반복 운영 루프를 한 장에 고정한다.

- VPS `data/`를 로컬로 동기화한다
- 동기화 직후 기본 점검 명령을 실행한다
- Codex에 어떤 식으로 분석 요청할지 템플릿을 제공한다
- 결과를 어떤 병목으로 해석하고 다음 액션을 무엇으로 둘지 빠르게 연결한다

이 문서는 전략 철학 문서가 아니다.
현재 전략/게이트 기준은 [`STRATEGY.md`](../../STRATEGY.md), active 운영 우선순위는 [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md)를 따른다.

`bootstrap_10s` replay를 반복 분석할 때는 [`backtest-bootstrap-replay-loop.md`](./backtest-bootstrap-replay-loop.md)를 같이 본다.
`volume_spike` / `fib_pullback` 5분 replay를 반복 분석할 때는 [`backtest-core-5m-replay-loop.md`](./backtest-core-5m-replay-loop.md)를 같이 본다.
historical fetch -> replay를 반복 분석할 때는 [`backtest-historical-replay-loop.md`](./backtest-historical-replay-loop.md)를 같이 본다.
heartbeat / daily summary / paper validation / score 해석은 [`measurement-review-loop.md`](./measurement-review-loop.md)를 같이 본다.

---

## Standard Loop

운영 루프는 아래 순서로 고정한다.

1. VPS 데이터 동기화
2. 로컬 기본 점검
3. sparse 전용 점검
4. Codex에 시간 범위를 명시해 분석 요청
5. 병목을 `wallet / overflow / alias / sparse / gate` 중 어디로 볼지 판정
6. 필요한 경우 파라미터 또는 코드 수정
7. 다시 동기화해서 before/after 비교

---

## 1. VPS Data Sync

### Quick Start

가장 자주 쓰는 최소 루프는 아래 4줄이다.

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/scripts
./sync-vps-data.sh
cd ..
npm run ops:check:sparse -- --hours 2 --top 5
```

그 다음 Codex에 아래처럼 요청한다.

```text
vps 운영 로그 동기화했어, 최신 세션 로그 분석을 다시 부탁해 (약 40분)
```

### 권장 위치

보통 `scripts/` 디렉터리에서 실행한다.

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/scripts
./sync-vps-data.sh
```

저장소 루트에서 실행할 때는 아래를 쓴다.

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
bash scripts/sync-vps-data.sh
```

### 기본 동작

`scripts/sync-vps-data.sh`는 아래 경로를 동기화한다.

- remote: `root@104.238.181.61:~/Solana/Solana-Trading/solana-momentum-bot/data/`
- local: `./data/`

스크립트 실제 내용은 아래와 같다.

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${REMOTE_HOST:-root@104.238.181.61}"
REMOTE_PATH="${REMOTE_PATH:-~/Solana/Solana-Trading/solana-momentum-bot/data/}"
LOCAL_PATH="${LOCAL_PATH:-${ROOT_DIR}/data/}"

mkdir -p "${LOCAL_PATH}"

echo "[sync-vps-data] ${REMOTE_HOST}:${REMOTE_PATH} -> ${LOCAL_PATH}"
rsync -avz --progress "${REMOTE_HOST}:${REMOTE_PATH}" "${LOCAL_PATH}"
```

의미:

- 현재 작업 디렉터리가 어디든 `ROOT_DIR`는 저장소 루트로 계산된다
- 기본 local target은 항상 저장소 루트의 `data/`
- 실제 전송은 `rsync -avz --progress`
- `REMOTE_HOST`, `REMOTE_PATH`, `LOCAL_PATH`는 env override 가능

전제:

- 로컬에 `rsync` 설치
- VPS에 SSH 접속 가능
- SSH key 또는 로그인 경로가 이미 잡혀 있음

override가 필요하면 env로 바꾼다.

```bash
REMOTE_HOST=root@<host> REMOTE_PATH=~/path/to/data/ LOCAL_PATH=./data/ ./sync-vps-data.sh
```

예:

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/scripts
REMOTE_HOST=root@1.2.3.4 ./sync-vps-data.sh
```

### 성공 확인

동기화 후 아래 두 파일이 최신 시각으로 갱신됐는지 먼저 본다.

```bash
ls -lh ../data/realtime/current-session.json ../data/realtime/runtime-diagnostics.json
```

정상 출력 예시는 아래 형태다.

```text
[sync-vps-data] root@104.238.181.61:~/Solana/Solana-Trading/solana-momentum-bot/data/ -> /.../solana-momentum-bot/data/
receiving incremental file list
...
```

실패 시 먼저 볼 것:

- `ssh: connect to host ... failed`
- `rsync: command not found`
- 권한 문제로 `Permission denied`

이 경우는 로그 해석 전에 동기화 자체를 먼저 복구한다.

---

## 2. Local Baseline Checks

### Realtime ops summary

저장소 루트에서 실행:

```bash
npm run ops:check -- --hours 2 --top 10
```

이 명령은 아래를 빠르게 보여준다.

- current session
- today UTC eval suppress
- 최근 window의 `alias_miss`
- 최근 window의 `pre_watchlist_reject`
- 최근 window의 `capacity`
- 최근 window의 signal status / top pair / risk reject reason

### Sparse trigger summary

```bash
npm run ops:check:sparse -- --hours 2 --top 5
```

이 명령은 아래를 빠르게 보여준다.

- 최근 window signal 수 / executed_live
- 최신 trigger stats
- `sparseInsuf`, `volInsuf`, `lowBuyRatio`
- 최근 window `alias_miss` 상위 pool

### Longer window

상황이 애매하면 `40m -> 2h -> 11h` 순으로 넓힌다.

```bash
npm run ops:check -- --hours 5 --top 10
npm run ops:check:sparse -- --hours 4 --top 10
```

---

## 3. Codex Request Templates

동기화 후에는 아래처럼 시간 범위를 먼저 명시해서 요청한다.

### Fast check

```text
vps 운영 로그 동기화했어, 최신 세션 로그 분석을 다시 부탁해 (약 40분)
```

### Normal check

```text
vps 운영 로그 동기화했어, 최근 2시간 로그 분석을 부탁해
```

### Long window

```text
vps 운영 로그 동기화했어, 최근 11시간 로그 분석을 부탁해, buy가 한건도 발생하지 않았어
```

### Quality-reviewed report

```text
답변 내용 품질 점검해주고 리포트 출력해줘
UTC 기준으로 몇시간 로그인지도 출력해주고 어떤 파일명을 분석했는지 포함해줘
```

### Follow-up drill down

```text
응 추가 분석을 부탁해
```

```text
1. top raw-swap 토큰이 왜 signal 0인지 추적해줘
2. alias_miss 상위 pool을 mint/watchlist 기준으로 복원해줘
3. 이번 구간의 최소 운영 수정안을 정리해줘
```

---

## 4. Interpretation Order

분석 결과는 아래 순서로 읽는다.

### A. Wallet / execution routing

먼저 아래가 있는지 본다.

- `wallet_not_configured`
- `wallet_limit`
- `risk_rejected`
- `quote_rejected`

이 단계에서 막히면 신호 품질보다 실행 배선 문제가 우선이다.

### B. Data plane

그 다음 아래를 본다.

- `capacity` / `queue_overflow`
- `alias_miss`
- `pre_watchlist_reject`
- `admission_skip`

여기서 문제가 크면 breadth나 threshold보다 discovery / subscription hygiene를 먼저 본다.

### C. Trigger generation

신호가 0이면 아래를 본다.

- `volInsuf`
- `sparseInsuf`
- `lowBuyRatio`
- `cooldown`

현재 sparse-mode 운영에서는 `volInsuf`보다 `sparseInsuf`가 더 직접 병목일 수 있다.

### D. Market shape

마지막으로 raw swap을 본다.

- total swaps
- buy/sell 비중
- top mint concentration

전부 `sell` 편향이면 trigger 완화만으로는 buy가 안 나오는 것이 정상일 수 있다.

---

## 5. Action Map

### 1) `wallet_not_configured` 반복

우선 확인:

- [`src/executor/walletManager.ts`](../../src/executor/walletManager.ts)
- 해당 전략이 main wallet `allowedStrategies`에 포함되는지

### 2) `queue_overflow` 증가

우선 확인:

- pool init log filter
- pool discovery concurrency / spacing
- `non_sol_quote` noise

관련 명령:

```bash
npm run ops:check -- --hours 2 --top 10
```

### 3) `alias_miss` 증가

우선 확인:

- 상위 offender pool이 stale/zombie인지
- grace 종료 후 잔류 swap인지
- 재진입 pair인지

관련 명령:

```bash
npm run ops:check -- --hours 2 --top 20
npm run ops:check:sparse -- --hours 2 --top 20
```

### 4) `signals=0` + `sparseInsuf` 지배

우선 확인:

- `realtimeMinActiveCandles`
- `realtimeSparseVolumeLookback`
- raw swap buy/sell 비중

원칙:

- 먼저 `minActiveCandles`
- 그 다음 `sparse lookback`
- `volume multiplier`는 마지막

### 5) `signals > 0` but `executed_live = 0`

우선 확인:

- `risk reject`
- `quote reject`
- `wallet limit`
- `per-token cooldown`
- `daily trade cap`

이 경우는 trigger보다 execution / policy 문제가 우선이다.

---

## 6. Minimal Command Set

자주 쓰는 명령만 모으면 아래 4개다.

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/scripts
./sync-vps-data.sh
```

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
npm run ops:check -- --hours 2 --top 10
```

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
npm run ops:check:sparse -- --hours 2 --top 5
```

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
npm run ops:check -- --hours 5 --top 10
```

---

## 7. Recommended Ask Pattern

운영 루프를 부드럽게 돌리려면 아래 패턴을 유지한다.

1. `./sync-vps-data.sh`
2. `ops:check`
3. `ops:check:sparse`
4. Codex에 시간 범위를 지정해서 요청
5. Codex 답변 후 필요한 drill-down 요청

예시:

```text
vps 운영 로그 동기화했어, 최신 세션 로그 분석을 다시 부탁해 (약 40분)
```

그 다음:

```text
답변 내용 품질 점검해주고 리포트 출력해줘
UTC 기준으로 몇시간 로그인지도 출력해주고 어떤 파일명을 분석했는지 포함해줘
```

---

## 8. Exit Rule

아래 4개가 동시에 맞으면 운영 루프의 한 사이클을 종료한다.

- `wallet_not_configured` 같은 직접 실행 blocker 없음
- `queue_overflow`가 낮거나 0
- `alias_miss`가 offender few-pool 수준으로 관리됨
- `signals` 또는 `executed_live` 변화가 관측됨

그 전까지는 `동기화 -> 점검 -> 해석 -> 조치 -> 재동기화`를 반복한다.
