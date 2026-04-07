Status: current
Updated: 2026-04-07
Purpose: live ops loop 반복 수행 시 `근거 -> 판단 -> 조치 -> 재확인 계획` 이력을 UTC 기준으로 누적 기록하는 규칙
Use with: `docs/runbooks/live-ops-loop.md`, `CRITICAL_LIVE.md`

# Ops History

## Why

`live-ops-loop`는 반복 루프를 빠르게 돌리기 위한 운영 런북이다.
하지만 반복 루프를 여러 번 돌리면 아래 정보가 쉽게 사라진다.

- 어느 UTC window를 보고 판단했는지
- 어떤 파일과 어떤 명령 출력을 근거로 봤는지
- 왜 그 조치를 선택했는지
- 다음 루프에서 무엇을 다시 확인해야 하는지

이 디렉터리는 그 이력을 append-only로 누적하는 용도다.

## Directory Rule

- 파일 단위: 하루 1개
- 경로 규칙: `docs/ops-history/YYYY-MM-DD.md`
- 시간 기준: 반드시 UTC
- 기록 단위: live ops loop 1회당 entry 1개

예:

- `docs/ops-history/2026-04-07.md`
- 같은 날짜에 루프를 4번 돌렸다면 같은 파일 안에 entry 4개를 순서대로 추가

## Required Fields

각 entry에는 최소 아래 항목을 남긴다.

1. 실행 시각
   - `started_at_utc`
   - `ended_at_utc`
   - incident-recovery 직후 entry는 추가로 `post_guard_session: true`와 `bot_restart_at_utc`를 명시 (그 window의 metric이 deployment effect 위에서 측정된 것임을 한 줄로 표현)
2. 분석 window
   - `runtime_window_start_utc`
   - `runtime_window_end_utc`
   - `runtime_window_hours`
   - `db_window_start_utc`
   - `db_window_end_utc`
   - `db_window_hours`
   - 권장: `metric_scope_note` — 어떤 metric suffix(`_recent_2h` / `_recent_12h` 등)가 어떤 window를 가리키는지 한 줄로 명시
3. runtime 사용 근거
   - 동기화 시각
   - runtime window
   - 사용한 파일명
   - 실행한 명령
4. DB / ledger 사용 근거
   - DB window
   - 실행한 명령
   - 주요 anomaly 요약
   - incident성 판단이면 필수
5. 핵심 관측치
   - `signals`
   - `executed_live`
   - `risk_rejected`
   - `gate_rejected`
   - `alias_miss`
   - `sparseInsuf`
   - `realized_pnl`
   - `closed_rows`
   - `tp_negative_pnl`
   - `entry_gap`
   - `exit_gap`
   - 권장: `fake_fill_rows / closed_rows` — `exit_anomaly_reason`이 set이거나 `exit_slippage_bps >= 9000`인 row 비율. trade-report `printSlippageRawAndTrimmed` 출력의 `excluded N saturated`와 `FAKE-FILL WARNING ${count}/${total}` 줄을 그대로 옮긴다. 이 비율이 표시되지 않으면 평균 slippage가 1건 outlier로 왜곡됐는지 사후 추적 불가
   - 그 외 이번 루프에서 중요했던 숫자
6. 판단
   - 병목 분류: `wallet / overflow / alias / sparse / gate / risk / execution / incident`
   - `quality_check_of_recent_answers` — 이전 답변/판단을 재검토했을 때의 결과 (`pass` / `pass with refinement` / `revise` / `retroactive: pass`)
   - 왜 그렇게 판단했는지 2~5줄
7. 조치
   - 실제 변경
   - 보류 결정
   - 금지 조치
8. 다음 확인 포인트
   - 다음 루프에서 다시 볼 시간 범위
   - 기대 변화
   - 실패 시 다음 액션

## Recommended Rule

- 숫자는 가능한 한 raw count로 남긴다.
- “최근”, “방금”, “오늘” 대신 UTC 절대 시각을 쓴다.
- 파일명은 실제 분석한 파일명을 그대로 적는다.
- Codex에 요청한 문장도 남기면 재현성이 올라간다.
- runtime 근거와 DB 근거는 window를 분리해서 적는다.
- `signals > 0 but executed_live = 0`, `TP인데 손실`, `ledger 신뢰성 의심`, `risk blacklist 신뢰성 의심`이면
  `npx ts-node scripts/trade-report.ts --hours <N>` 또는 동등 window 명령을 함께 남긴다.
- 같은 판단을 유지하더라도 새 evidence가 생기면 새 entry를 추가한다.
- 기존 entry를 덮어쓰기보다 정정 entry를 추가하는 편이 낫다.

## Relation With Other Docs

- 단건 incident를 깊게 고정할 때는 `CRITICAL_LIVE.md`를 쓴다.
- 반복 루프 이력은 이 디렉터리에 남긴다.
- active execution plan은 `docs/exec-plans/active/`에서 관리한다.

## Template

새 날짜 파일은 아래 템플릿으로 시작한다.

```md
Status: current
Updated: 2026-04-07
Purpose: 2026-04-07 live ops loop 이력
Use with: `docs/runbooks/live-ops-loop.md`, `CRITICAL_LIVE.md`

# Ops History - 2026-04-07

## Entry 01

### Meta

- started_at_utc: `2026-04-07T02:40:00Z`
- ended_at_utc: `2026-04-07T03:05:00Z`
- operator: `igyubin`
- trigger: `regular loop`

### Window

- runtime_window_start_utc: `2026-04-07T01:00:00Z`
- runtime_window_end_utc: `2026-04-07T03:00:00Z`
- runtime_window_hours: `2`
- db_window_start_utc: `2026-04-06T15:00:00Z`
- db_window_end_utc: `2026-04-07T03:00:00Z`
- db_window_hours: `12`

### Evidence

- synced_at_utc: `2026-04-07T02:26:20.474Z`
- runtime_files:
  - `data/realtime/current-session.json`
  - `data/realtime/runtime-diagnostics.json`
  - `data/realtime/sessions/2026-04-06T14-17-04-255Z-live/realtime-signals.jsonl`
- runtime_commands:
  - `./scripts/sync-vps-data.sh`
  - `npm run ops:check -- --hours 2 --top 10`
  - `npm run ops:check:sparse -- --hours 2 --top 5`
- db_commands:
  - `npx ts-node scripts/trade-report.ts --hours 12`
  - `npm run ops:check:ledger -- --hours 12`
- codex_request:
  - `vps 운영 로그 동기화했어, 최근 2시간 로그 분석을 부탁해`

### DB Anomalies

- tp_negative_pnl_rows: `5`
- avg_entry_gap_pct: `-77.39%`
- avg_exit_gap_pct: `-77.59%`
- max_abs_entry_gap_pct: `100.00%`
- max_abs_exit_gap_pct: `100.00%`
- note:
  - `TAKE_PROFIT_2`인데 음수 실현 손익이 반복되면 incident성 판단으로 승격
  - `planned/decision`과 `fill` 가격 축이 크게 벌어지면 ledger 신뢰성 검토가 필요

### Metrics

- signals: `10`
- executed_live: `0`
- risk_rejected: `8`
- gate_rejected: `1`
- execution_failed: `1`
- alias_miss_top: `pool-xyz=17`
- sparseInsuf: `0`
- realized_pnl: `-0.008526 SOL`
- closed_rows: `6`
- tp_negative_pnl: `5`
- avg_entry_gap_pct: `-77.39%`
- avg_exit_gap_pct: `-77.59%`

### Assessment

- primary_bottleneck: `risk`
- secondary_bottleneck: `execution`
- summary:
  - `signals > 0`인데 `executed_live = 0`이라 trigger 부족은 주병목이 아님
  - 최근 구간 직접 blocker는 `edge_blacklist`, `per_token_cooldown`, `429 quote/swap failure`
  - price-axis mismatch 의심 때문에 현재 blacklist 근거 신뢰도는 낮음

### Action

- taken:
  - `CRITICAL_LIVE.md` 업데이트
  - `tradeExecution` 가격 축 추적 작업 착수
- deferred:
  - `edge_blacklist` 완화 보류
  - `cooldown` 완화 보류
- forbidden:
  - 가격 정합성 검증 전 risk 파라미터 완화 금지

### Next Check

- next_window_utc: `2026-04-07T03:00:00Z ~ 2026-04-07T05:00:00Z`
- expected_change:
  - `risk_rejected` 사유 분해
  - TP/SL 가격 축 mismatch 재현 여부 확인
- fallback_if_not_improved:
  - `tradeExecution` 값 생성 경로별 debug evidence 추가
```
