Status: current
Updated: 2026-04-07
Purpose: VPS 운영 데이터 동기화부터 Codex 분석 요청, 후속 조치, loop history 기록까지 반복 루프를 고정
Use with: `OPERATIONS.md`, `docs/ops-history/README.md`, `CRITICAL_LIVE.md`

# Live Ops Loop Runbook

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
4. 필요 시 운영 DB / ledger 점검
5. loop history entry 초안 기록
6. Codex에 시간 범위를 명시해 분석 요청
7. 병목을 `wallet / overflow / alias / sparse / gate` 중 어디로 볼지 판정
8. 필요한 경우 파라미터 또는 코드 수정
9. loop history entry를 `판단 / 조치 / 다음 확인 포인트`까지 확정
10. 다시 동기화해서 before/after 비교

---

## 1. VPS Data Sync

### Quick Start

가장 자주 쓰는 최소 루프는 아래 3줄이다.

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
FETCH_TRADE_REPORT=true npm run ops:refresh:vps-analysis
npm run ops:check:sparse -- --hours 2 --top 5
```

이 wrapper는 아래를 한 번에 수행한다.

- `scripts/sync-vps-data.sh`
- optional VPS `trade-report.ts --hours 4`
- local `scripts/analysis/realized-replay-ratio.ts`

산출물은 기본적으로 아래 경로에 남는다.

- `results/vps-analysis/trade-report-latest.txt`
- `results/vps-analysis/realized-replay-ratio-latest.md`

그 다음 Codex에 아래처럼 요청한다.

```text
vps 운영 로그 동기화했어, 최신 세션 로그 분석을 다시 부탁해 (약 40분)
```

### 권장 위치

운영 분석까지 같이 갱신할 때는 저장소 루트에서 wrapper를 실행한다.

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
FETCH_TRADE_REPORT=true npm run ops:refresh:vps-analysis
```

동기화만 따로 할 때는 아래를 쓴다.

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

wrapper 실행 후 아래 파일들이 최신 시각으로 갱신됐는지 먼저 본다.

```bash
ls -lh \
  data/realtime/current-session.json \
  data/realtime/runtime-diagnostics.json \
  results/vps-analysis/trade-report-latest.txt \
  results/vps-analysis/realized-replay-ratio-latest.md
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

### Trade / ledger report

운영 DB 이상 징후가 보이면 아래 명령을 표준으로 같이 본다.

```bash
npx ts-node scripts/trade-report.ts --hours 12
```

이미 wrapper를 돌렸다면 최신 4h 스냅샷은 아래 파일에서 바로 본다.

```bash
cat results/vps-analysis/trade-report-latest.txt
```

이 명령은 아래를 빠르게 보여준다.

- opened row / closed row / open row / partial close row
- realized pnl / win-loss / token count
- 종목별 종료 사유 / 보유 시간
- planned -> fill entry gap
- decision -> fill exit gap
- slippage / round-trip cost / TP outcome anomaly

아래 조건 중 하나면 `trade-report`를 같이 남긴다.

- `signals > 0`인데 `executed_live = 0`
- `TAKE_PROFIT`인데 음수 실현 손익이 보임
- `edge_blacklist` 근거 신뢰성이 의심됨
- exit 판단, 체결가, ledger 정합성을 같이 봐야 함

---

## 3. Codex Request Templates

## 3A. Loop History Record

반복 운영 루프는 매번 기록을 남기는 편이 좋다.
분석을 다시 요청할 때 아래 세 가지가 빠지면 같은 루프를 다시 해석하게 된다.

- 어느 UTC window를 보고 판단했는지
- 어떤 파일과 어떤 명령 출력을 근거로 봤는지
- 왜 그 조치를 택했는지

기록 규칙:

- 하루 1파일: `docs/ops-history/YYYY-MM-DD.md`
- loop 1회당 entry 1개 추가
- 시간은 반드시 UTC
- 최소 필드: `runtime_window`, `db_window`, `runtime_files`, `runtime_commands`, `db_commands`, `metrics`, `assessment`, `action`, `next check`
- `assessment`는 `quality_check_of_recent_answers`를 항상 포함한다 (이전 답변/판단을 재검토했을 때의 결과 — `pass`, `pass with refinement`, `revise`, `retroactive: pass` 등)
- `window`는 권장 필드로 `metric_scope_note`를 포함해, 어떤 metric suffix(`_recent_2h` 등)가 어떤 window를 가리키는지 명시한다
- runtime과 DB window가 완전히 같지 않으면 둘을 억지로 맞추지 말고 실제 evidence end 시각을 각각 적는다
- `trade-report-latest.txt` 같은 synced snapshot만 쓴 경우와, user/operator가 수동 전달한 same-window DB report를 쓴 경우를 구분해 적는다
- `signals`는 필요하면 `runtime signal rows`와 `trigger stats signals`를 분리 기록한다
- incident-recovery 직후 entry는 `meta`에 `post_guard_session: true`와 `bot_restart_at_utc`를 포함해, 해당 window의 metric이 deployment effect 위에서 측정된 것임을 명시한다 (commit hash 나열은 git log/별도 audit 문서에 맡기고 ops-history는 운영 맥락만 한 줄로 남긴다)
- `exit_slippage_bps`/`entry_slippage_bps` 평균을 기록할 때는 `fake_fill_rows / closed_rows` 비율을 함께 남긴다. trade-report의 `printSlippageRawAndTrimmed` 출력에서 `excluded N saturated >=9000bps`와 하단 `FAKE-FILL WARNING ${count}/${total}` 줄이 근거다. 이 비율이 빠지면 1건 outlier로 평균이 왜곡됐는지 사후 검증 불가능
- **Phase M day-2부터** `metrics_note`에 다음 4종을 1줄씩 기록한다 (`live-ops-integrity-2026-04-07.md` Phase M acceptance):
  1. `entry_gap_p95_pct_recent_${H}h` / `exit_gap_p95_pct_recent_${H}h` — `npm run ops:check:ledger -- --hours ${H}` 출력의 `Phase C2 verdict | entry_gap p95 X% (≤5%) pass/fail | exit_gap p95 Y% (≤10%) pass/fail` 라인에서 추출 (`scripts/ledger-audit.ts:printGapDistribution`).
  2. `exit_anomaly_rows_recent_${H}h` — 같은 ledger-audit 출력의 `Suspicious Rows` 섹션 카운트 (또는 trade-report `FAKE-FILL WARNING N/total` 라인). day-1 baseline은 ops-history Entry 03 기록을 따른다.
  3. `realized_replay_excluded_groups / rows` — `realized-replay-ratio-latest.md` 헤드라인의 `Anomaly filter (>=9000bps slippage or exit_anomaly_reason set): N parent groups (M rows) excluded` 라인. drop이 실제 작동하는지 누적 추적용 (F1-deep-5).
  4. `closed_rows_clean_vs_raw` — 같은 헤드라인의 `Closed trades: raw=A, clean=B (anomaly filter excluded N parent groups / M rows)` 라인.
- 위 4종이 metrics_note에서 빠지면 Phase M 7일 acceptance에 자동으로 미달이다. 7일 누적이 `entry_gap p95 ≤ 5%` 합격이 안 나오면 Phase C2 raw 합격이 영구 실패 상태이므로 fake-fill threshold 또는 size sanitizer 보강을 우선 검토.

새 기록을 시작할 때는 [`docs/ops-history/README.md`](../ops-history/README.md) 템플릿을 그대로 쓴다.

빠른 작성 순서:

1. sync 직후 `started_at_utc`, `runtime_window_*`, `db_window_*`를 먼저 적는다
2. `ops:check`, `ops:check:sparse` 실행 후 `runtime_files`, `runtime_commands`, `metrics`를 채운다
3. 기본은 `FETCH_TRADE_REPORT=true npm run ops:refresh:vps-analysis`로 `trade-report-latest.txt`와 `realized-replay-ratio-latest.md`를 같이 갱신한다
4. incident성 drill-down이면 `npx ts-node scripts/trade-report.ts --hours <N>`를 추가 실행해 `db_window`, `db_commands`, `db anomalies`를 보강한다
5. Codex 답변 후 `assessment`, `action`, `next check`를 확정한다
6. `ops:check`와 `ops:check:sparse`의 signal 수가 다르면 `row 기준`인지 `trigger stats 기준`인지 메모를 남긴다

기록 예시:

```text
docs/ops-history/2026-04-07.md
- Entry 01: critical live incident review
- Entry 02: post-fix 2h canary check
```

## 3B. Codex Request Templates

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
- signaled mint concentration
- low-cap / high volume-mcap 후보가 실제로 execution까지 갔는지

전부 `sell` 편향이면 trigger 완화만으로는 buy가 안 나오는 것이 정상일 수 있다.
반대로 signal이 있는데 한 ticker에 과집중되면 `신호 부족`보다 `universe quality / concentration control` 문제가 더 직접적일 수 있다.

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

### 6) `signals > 0` + `single ticker concentration` + 손실 누적

우선 확인:

- top mint concentration
- 동일 ticker 재신호 비중
- `portfolio cooldown` / `per-token cooldown`
- 최근 실현 손익이 partial close row 기준으로 과장되지 않았는지
- `non_sol_quote`, `unsupported_dex`, `idle eviction` 비중

원칙:

- 이 경우는 `signal scarcity`보다 `pool discovery quality + concentration control`이 우선이다
- `cooldown` 완화 전에 먼저 `찾는 풀의 품질`과 `같은 ticker 재노출 구조`를 본다
- 장기적으로는 `marketCap / volumeMcap / freshness` 코호트별 성과 분리를 같이 준비한다

---

## 6. Minimal Command Set

자주 쓰는 명령만 모으면 아래 4개다.

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
FETCH_TRADE_REPORT=true npm run ops:refresh:vps-analysis
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

1. `FETCH_TRADE_REPORT=true npm run ops:refresh:vps-analysis`
2. `ops:check`
3. `ops:check:sparse`
4. 필요 시 `trade-report` 추가 drill-down
5. `docs/ops-history/YYYY-MM-DD.md`에 entry 초안 작성
6. Codex에 시간 범위를 지정해서 요청
7. Codex 답변 후 `assessment / action / next check` 확정
8. 필요한 drill-down 요청

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

루프 종료 직전에는 반드시 해당 entry에 아래 2개를 채운다.

- 실제 조치 결과
- 다음 루프에서 볼 UTC window
