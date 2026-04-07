Status: current (Phase E 배포 검증 통과, Phase M day-2 + ralph-loop iter10 PRICE_ANOMALY fix 배포 단계)
Updated: 2026-04-08 (§7H iter10 결과 추가 — `parsePumpSwapInstruction` priceNative 산출 path 폐기 + 87 suites/466 tests pass)
Purpose: 2026-04-07~04-08 live 운영 이상 징후와 현재 판단 근거를 단건 문서로 고정
Use with: `OPERATIONS.md`, `docs/runbooks/live-ops-loop.md`, `scripts/ledger-audit.ts`, `docs/exec-plans/active/live-ops-integrity-2026-04-07.md`, `docs/ops-history/2026-04-07.md` (Entry 01/02/03/04), `docs/ops-history/2026-04-08.md` (Entry 05), `docs/audits/price-anomaly-ratio-2026-04-08.md`

# CRITICAL_LIVE

## Scope

- 목적: 최신 live 운영 이슈를 `증거 -> 판단 -> 금지 조치 -> 다음 액션` 순서로 정리
- 기준 window (history):
  - runtime latest synced at `2026-04-07T02:26:20.474Z` (Entry 01 origin)
  - DB trade report window `2026-04-06T14:31:03Z ~ 2026-04-07T02:31:03Z` (Entry 01 baseline)
  - **post Phase A/B/C1 측정**: `2026-04-07T04:01Z ~ 11:01Z` (Entry 02, §7F-pre)
  - **post Phase E P0~P3 검증**: `2026-04-07T12:21Z ~ 13:33Z` (Entry 03, §7F-post)
- 기준 소스:
  - `data/realtime/current-session.json`
  - `data/realtime/runtime-diagnostics.json`
  - `data/realtime/sessions/2026-04-06T14-17-04-255Z-live/realtime-signals.jsonl` (Entry 01)
  - `data/realtime/sessions/2026-04-07T12-21-19-322Z-live/realtime-signals.jsonl` (Entry 03)
  - `data/vps-trades-latest.jsonl` (Entry 03)
  - `scripts/ledger-audit.ts`
  - `scripts/analysis/realized-replay-ratio.ts` (F1-deep-5)
  - `src/orchestration/tradeExecution.ts`
  - `src/notifier/notifier.ts`
  - `src/notifier/messageFormatter.ts`

## One-line Conclusion

- ~~현재 live 핵심 이슈는 단순 `signal 부족`이 아니라, `risk/gate 차단` 위에 `가격 단위 불일치 의심`이 겹쳐 `exit 판단과 ledger 근거가 동시에 오염됐을 가능성`이다.~~
- **갱신 (2026-04-07T13:50Z, Entry 03 기준)**: Phase A/B/C1 (가격 정합성) + Phase E P0~P3 (fake-fill 감지/마킹) + 품질 개선까지 모두 배포·검증 통과. 가격 단위 폭발은 사실상 사라졌고 (Entry 02 max abs `100%` → `0.58%`), fake-fill row 1건은 sanitizer/replay-ratio anomaly filter가 정확히 격리한다 (Entry 03 `1 parent group / 2 rows excluded`). 현 상태는 `오염 ledger 의심` 단계가 아니라 **Phase M 7일 누적 모니터링 단계**이며, 핵심 미해소 항목은 `per-row anomaly 서브라인 자연 검증` + `entry_gap p95 측정` + `Phase C2 4종 합격 기준 marker-aware 측정 누적` 세 가지다.

## 1. 테스트 근거

### 1A. Runtime 운영 로그

- 현재 세션 기준 최근 2시간:
  - `10 signals`
  - `0 executed_live`
  - `8 risk_rejected`
  - `1 gate_rejected`
  - `1 execution_failed`
- 주요 사유:
  - `Pair blacklisted by edge tracker`
  - `Per-token cooldown`
  - `Quote error: 429`
  - `Swap failed after 3 attempts: 429`

### 1B. DB 원장 리포트

- 최근 12시간 realized:
  - `6 closed rows`
  - `0W / 6L`
  - `net -0.008526 SOL`
- 이상 패턴:
  - `TAKE_PROFIT_1/2`인데 `PnL < 0`
  - `planned_entry_price`, `decision_price`와 `entry_price`, `exit_price` 사이 gap이 `-84% ~ -100%`
  - 같은 row의 `entry_slippage_bps`, `exit_slippage_bps`는 `0~80bps`

### 1C. Ledger anomaly script

- `npm run ops:check:ledger -- --hours 12` 결과:
  - `BTW`, `pippin`, `stonks` 모두 `entry_gap>=50%`, `exit_gap>=50%`
  - `gap_vs_slippage_mismatch`
  - `tp_negative_pnl`
- 이는 report formatting 문제가 아니라 raw row 수준 이상 징후다.

### 1D. 실제 Telegram 원문

- 실제 반복 알림에서도 같은 패턴이 재현됐다.
- 확인된 대표 사례:
  - `BTW`
    - open: `planned=0.81549236 -> fill=0.00000122 (-100.00%)`
    - close: `decision=0.81696596 -> fill=0.00000122 (-100.00%)`
    - `2차 익절`인데 `손실 확정`
    - `entry=0bps`, `exit=0bps`, `rtCost=0.00%`
  - `pippin`
    - open: `planned=0.00252896 -> fill=0.00039738 (-84.29%)`
    - close: `decision=0.00251658 -> fill=0.00039599 (-84.26%)`
    - `2차 익절`인데 `-0.0005 SOL`
    - 진입 직후 종료 패턴 재현
  - `stonks`
    - open: `planned=0.00008227 -> fill=0.00000372 (-95.48%)`
    - close: `decision=0.00008227 -> fill=0.00000358 (-95.64%)`
    - `2차 익절`인데 `-0.0043 SOL`
    - 진입 직후 종료 패턴 재현
- 반대 사례도 확인됐다:
  - `stonks` profit case
    - open: `planned=0.00008217 -> fill=0.00000406 (-95.06%)`
    - close: `decision=0.00008217 -> fill=0.00000574 (-93.02%)`
    - `2차 익절`이며 `+0.0475 SOL (+41.4%)`
    - 즉 가격 축 mismatch가 있어도 실제 fill 축에서 큰 수익이 날 수 있다
  - `stonks` near-normal-scale case
    - open: `entry=0.00008173`, entry gap 표시는 없음
    - close: `decision=0.00008250 -> fill=0.00008161 (-1.08%)`
    - `1차 익절`인데 `-0.0000 SOL`
    - 동시에 `entry=10000bps`라는 별도 이상치가 존재
- 즉 동일 패턴이 단일 pair가 아니라 다중 pair에서 반복됐다.
- 다만 모든 거래가 같은 방식으로 깨진 것은 아니고, `대규모 planned/decision mismatch`, `near-normal-scale but odd slippage`, `실제 수익 사례`가 혼재한다.

### 1E. Historical / Replay 배경 근거

- 현재 bootstrap 운영 baseline `1.8 / 0.60 / 20`은 5-session replay sweep 기준으로 채택된 값이다.
- replay validation snapshot 기준:
  - `04-04T14:31` 세션은 `132 signals / edge score 78 / pass`
  - 나머지 세션은 `edge score 8` 수준으로 reject
- 같은 replay 문맥에서 이미 확인된 병목:
  - `Sparse data insufficient: 81%`
  - edge가 일부 runner 세션에 과집중
  - `pippin`류 high-attention token도 평균 손실 사례 존재
- 즉 historical data는:
  - `bootstrap_10s`가 완전히 죽은 전략은 아님
  - 그러나 재현성은 약하고 sparse / runner concentration 문제가 큼
  는 점을 뒷받침한다.

## 2. 테스트 결과

### 2A. 최신 운영 병목 자체는 risk/gate가 맞다

- 예전 `idle/stale occupancy` 문제는 최근 window에서 주병목에서 한 단계 내려갔다.
- 최신 window에서 직접 진입을 막는 것은:
  - `edge_blacklist`
  - `per_token_cooldown`
  - `429 quote/swap failure`

### 2B. 그러나 현재 blacklist 근거는 신뢰하기 어렵다

- `edge_blacklist`는 closed trade history를 입력으로 학습한다.
- 그런데 현재 closed trade의 가격/PnL 기록 자체에 단위 불일치 의심이 있다.
- 따라서 `risk 차단이 발생한다`는 사실과 `risk 차단이 옳다`는 판단은 분리해서 봐야 한다.

### 2C. 가격 축 불일치가 실행 경로에도 존재했을 가능성이 높다

- DB 리포트만 이상한 것이 아니다.
- Telegram open/close 원문에도 같은 이상값이 찍혔다.
- 이는 문제 범위를:
  - `SQL/report bug`
  - 가 아니라
  - `executionSummary / order / trade` 가격 생성 경로
  로 좁혀준다.

### 2D. “TP인데 손실”은 전략 품질만으로 설명하기 어렵다

- 정상 가격 체계라면:
  - `TAKE_PROFIT_2`
  - `-100% exit gap`
  - `0bps slippage`
  - `negative pnl`
  조합이 반복되기 어렵다.
- 현재 더 강한 가설은:
  - `planned/decision` 가격 축과
  - `entry/exit fill` 가격 축이
  서로 다르다는 것이다.
- 추가 Telegram 사례까지 보면 이 현상은:
  - `단일 종목 이상치`
  - 보다는
  - `다중 종목에 걸친 시스템적 가격 축 불일치 또는 exit 오판`
  에 더 가깝다.
- 보정:
  - `모든 거래가 무조건 손실`은 아니다
  - `모든 거래가 완전히 같은 방식으로 깨진 것`도 아니다
  - 더 정확한 표현은 `가격/슬리피지/TP 라벨 해석이 서로 일관되지 않은 혼재 상태`다

### 2E. Replay가 뒷받침하는 것과 아직 증명하지 못한 것

- replay / historical data가 뒷받침하는 것:
  - bootstrap baseline 채택 배경
  - sparse 병목과 sample insufficiency
  - 일부 token이 runner/outlier에 과도하게 의존한다는 점
  - `pippin`류가 historical 문맥에서도 일관된 우등 token은 아니라는 점
- replay / historical data가 아직 직접 증명하지 못한 것:
  - 이번 live incident의 `planned/decision vs fill` 가격 단위 불일치
  - `TP인데 손실`이 발생한 정확한 실행 경로
  - 현재 `edge_blacklist`가 오염됐는지 여부
- 따라서 이번 문서는:
  - 전략 배경은 replay로 보강하되
  - incident의 직접 근거는 live runtime + DB + Telegram 원문으로 본다.

## 3. 문제점 및 개선점

### 3A. 현재 문제점

- `signal 있음 -> executed_live 0` 상태가 지속됨
- `edge_blacklist`가 실제 진입을 반복 차단함
- blacklist 근거가 되는 ledger 가격 정합성이 의심됨
- Telegram 성공 발송 이력이 서버에 저장되지 않아 사후 감사가 약함

### 3B. 해석상 주의점

- 텔레그램 메시지는 DB 재조회 결과가 아니라 실행 시점 메모리 객체를 포맷한 것이다.
- 따라서 텔레그램은 감사 원장이 아니라 보조 증거다.
- 하지만 이번 건에서는 DB와 텔레그램이 같은 이상 패턴을 보여, 오히려 실행 경로 이상 가능성을 강화한다.

### 3C. 즉시 개선 필요 항목

- `entryPrice`, `plannedEntryPrice`, `decisionPrice`, `exitPrice`의 단위 정합성 검증
- `currentPrice`, `observedHigh/Low`와 TP/SL 비교 시 같은 가격 축 사용 여부 검증
- full closed history 기준 `edge_blacklist` 재현과 입력값 검토
- 텔레그램 outgoing/incoming 이력 저장 추가

## 4. 지금 당장 하지 말아야 할 조치

- 가격 정합성 확인 전 `edge_blacklist` 완화
- 가격 정합성 확인 전 `cooldown` 완화
- 현재 ledger를 그대로 전략 품질의 확정 근거로 사용
- 텔레그램 메시지 하나만 보고 실현 손익 원장을 대체

## 5. 향후 계획

### 5A. Priority 0

1. `tradeExecution`에서 아래 값 생성 경로를 끝까지 추적
   - `plannedEntryPrice`
   - `entryPrice`
   - `takeProfit1`
   - `takeProfit2`
   - `decisionPrice`
   - `exitPrice`
2. `BTW`, `pippin`, `stonks` 문제 row를 기준으로 실제 체결 amount로 실매수가/실매도가 재계산
3. `checkOpenPositions()`의 `currentPrice`와 stored TP/SL 축 일치 여부 확인

### 5B. Priority 1

1. full history 기준 `edge_blacklist` 재현 스크립트 확장
2. 가격 정합성 수정 후 12h canary 재관찰
3. 그 다음에만 risk/gate 완화 여부 재판단

### 5C. Priority 2

1. Telegram 발송/수신 이벤트를 JSONL 또는 DB로 저장
2. 최소 필드:
   - `sent_at`
   - `direction`
   - `category`
   - `trade_id`
   - `pair_address`
   - `message_preview`
   - `status`
   - `error`

## 6. Fixed Facts

- 현재 최신 운영은 `신호 부재`보다 `신호는 있으나 실행 전 차단` 상태다.
- historical / replay 기준으로도 bootstrap은 `완전 무효`가 아니라 `재현성 취약` 상태였다.
- 현재 ledger에는 가격 단위 불일치 의심이 강하다.
- `TP인데 손실`은 개별 outlier가 아니라 다중 사례로 확인됐다.
- `BTW`, `pippin`, `stonks` 모두에서 `진입 직후 종료 + TP 판정 + 손실 확정` 패턴이 반복됐다.
- 반대로 `stonks`에서는 큰 수익 사례도 확인돼, 문제는 `무조건 손실 로직`이라기보다 `가격 축 / 슬리피지 / exit 라벨의 혼재` 쪽에 더 가깝다.
- 실제 Telegram 원문도 같은 이상 패턴을 재현했다.
- 따라서 지금 우선순위는 전략 튜닝보다 `가격 기록/exit 판단 경로 검증`이다.

## 7. Execution Log (2026-04-07)

> 대응 plan: `plans/wiggly-gathering-swan` (CRITICAL_LIVE 대응 — 가격 정합성 회복 + 사명 회귀)
> 상태: Phase A/B/C1 코드 배포 완료, Phase A1 진단 아티팩트 보존, Phase C2 canary 대기

### 7A. Phase A — 가격 경로 정합성 가드 (배포 완료)

- **A1. 진단**: `npm run ops:check:ledger -- --hours 24` 결과를 `data/diagnostics/ledger-audit-2026-04-07.txt`로 보존. BTW/pippin/stonks raw row + 온체인 교차 검증은 운영자 수작업 체크리스트로 남김.
- **A2. fallback mix 금지 + 단위 폭발 가드**:
  - `src/orchestration/signalProcessor.ts` — `buildEntryExecutionSummary`가 `actualInputUiAmount`/`actualOutUiAmount` 중 하나만 set이면 **두 값 모두 planned로 강제**. entryPrice 왜곡 원천 차단.
  - 동일 함수 내 `entryPrice / order.price` ratio `[0.5, 2.0]` 벗어나면 `log.error` + 이후 Phase A3가 hard-block.
  - `src/executor/executor.ts` — `resolveInputMetrics`/`resolveOutputMetrics`가 decimals 확보 실패 시 `[DECIMALS_MISSING]` 에러 로깅 후 빈 metrics 반환(orphan token 방지).
- **A3. `alignOrderToExecutedEntry` ratio clamp + 즉시 dump**:
  - `src/orchestration/tradeExecution.ts` — `PriceAnomalyError` 클래스 + `assertEntryAlignmentSafe()` 추가. ratio가 `[0.7, 1.3]` 벗어나면 `emergencyDumpPosition()`을 호출해 live 모드에서 **즉시 best-effort `executor.executeSell`** 후 `sendCritical('entry_alignment_unsafe', ...)` → `recordOpenedTrade`는 DB write 전에 throw. 광적인 TP/SL이 ledger에 새로 들어가지 않는다.
- **A4. `closeTrade` exit anomaly 플래그**:
  - 동일 파일 — `(exitPrice - entryPrice) / entryPrice`가 `[-0.95, 10]` 벗어나거나 decision vs fill gap이 50% 이상이면 `sendCritical('exit_anomaly', ...)` 발화 + 로그 기록. close 자체는 완료하되 대시보드에서 즉시 감지 가능.

### 7B. Phase B — Edge Blacklist 격리 (배포 완료)

- **B1. EdgeTracker 입력 sanitizer 강화**:
  - `src/reporting/edgeInputSanitizer.ts` 재작성 — `plannedEntryPrice`, `exitReason` 필드 추가 + `SanitizerDropReason` 9종:
    `invalid_entry_price`, `invalid_stop_loss`, `invalid_quantity`, `invalid_pnl`, `stop_above_entry`, `zero_planned_risk`, `risk_pct_too_high`, `planned_entry_ratio_corrupt`, `tp_negative_pnl`
  - `planned/actual ratio`가 `[0.5, 2.0]` 밖이면 `planned_entry_ratio_corrupt`로 drop.
  - `TAKE_PROFIT_1/2/TRAILING_STOP`인데 `pnl < 0`이면 `tp_negative_pnl`로 drop (P0-C 오염 제거 전까지).
  - `sanitizeEdgeLikeTrades`가 `dropReasonCounts`를 돌려줘 audit 가능.
  - 호출부: `src/risk/riskManager.ts`, `src/orchestration/reporting.ts`, `src/scanner/scannerBlacklist.ts` 모두 새 필드 전파. `checkOrder`에서 drop count 발생 시 `log.warn(EdgeTracker input sanitized: dropped ...)`.
  - `src/reporting/edgeTracker.ts` — `EdgeTrackerTrade` 인터페이스에 `plannedEntryPrice`, `exitReason` optional 추가.
- **B2. `BOT_BYPASS_EDGE_BLACKLIST` 임시 backdoor**:
  - `src/utils/config.ts` — `bypassEdgeBlacklist: boolOptional('BOT_BYPASS_EDGE_BLACKLIST', false)`.
  - `src/risk/riskManager.ts` — `isPairBlacklisted` 경로에서 플래그가 true면 reject 대신 `log.warn([BYPASSED_EDGE_BLACKLIST] ...)` + `appliedAdjustments.push('BYPASSED_EDGE_BLACKLIST')`.
  - **Production에서는 반드시 false** — Phase C2 canary 중에만 한시적 허용.
- **B3. `ledger-audit.ts --full-history` + sanitize 비교**:
  - `scripts/ledger-audit.ts` — `--full-history` 옵션 추가. closed trade 전체 기간을 대상으로 raw/sanitized EdgeTracker를 side-by-side 재현하며, sanitize 적용 후 blacklist가 풀리는 pair를 `FLIPPED` 마커로 표시. window-only 출력과 full-history 출력이 함께 나간다.

### 7C. Phase C1 — Notifier 이벤트 원장 (배포 완료)

- `src/notifier/notifier.ts` — `data/realtime/notifier-events.jsonl`에 append-only 로깅 추가. 각 sendMessage 호출마다 chunk 단위로 `attempt` + `result` 두 이벤트 기록.
- 필드: `sent_at, direction, phase, category, trade_id, pair_address, chunk_index, chunk_total, message_preview(120자), status(ok/fail/attempt/disabled), error?`
- 모든 specialized method (`sendCritical`, `sendWarning`, `sendTradeAlert`, `sendInfo`, `sendMessage`, `sendSignal`, `sendTradeOpen`, `sendTradeClose`, `sendRecoveryReport`, `sendDailySummary`, `sendRealtimeShadowSummary`)가 `NotifierEventContext`를 전달.
- `splitTelegramMessage`로 분할된 chunk도 동일 `trade_id`로 묶여 기록된다.

### 7D. 테스트 검증 상태

- `npx tsc --noEmit` — 0 errors.
- `npx jest` — 87 suites / 465 tests pass (baseline 427 → +38 new tests 누적).
- 신규 테스트 (누적):
  - `test/signalProcessor.test.ts` — `buildEntryExecutionSummary` 5 cases (actual/planned 혼합, 부분 fallback guard, paper fallback, BTW ratio 확인).
  - `test/tradeExecution.test.ts` — Phase A3 3 cases + Phase A4 2 cases + **Phase E 2 cases** (live fake-fill 시 `exit_anomaly_reason` 기록 + Phase A4 critical alert, 정상 live fill 무발화).
  - `test/edgeInputSanitizer.test.ts` — 10 cases + **Phase E 5 cases** (exitAnomalyReason drop, slippageBps ≥ 9000 drop, 8999bps 허용, tp_negative_pnl 보다 우선, dropReasonCounts 노출).

### 7E. Phase E — Live Ops Integrity (2026-04-07 P0~P3 배포 완료)

배경: 2026-04-07 `trade-report` / `realized-replay-ratio` 품질 감사에서 **Jupiter Ultra `outputAmountResult="0"` fake-fill fallback**이 4개 exit path에서 winning trade로 마스킹되는 것이 모든 의심 수치의 root cause로 확인됨. 증거: row #1 `exit_slip=10000bps + exitGap=0.00% + 양수 PnL` 모순 상태.

- **E0. Fake-fill 감지 + 영구 마킹** (`src/orchestration/tradeExecution.ts`, `src/utils/types.ts`, `src/candle/tradeStore.ts`):
  - `detectFakeFill()` helper — `receivedSol <= 0` 또는 `slippageBps >= 9000` 이면 reasons 배열 반환.
  - `resolveExitFillOrFakeFill()` helper — 4개 exit path (`closeTrade`, `degraded_phase1`, `tp1_partial`, `runner_b_partial`) 의 중복되는 `receivedSol > 0 ? received/qty : fallback + saturated slippage guard` 블록을 단일 함수로 통합. path drift 차단.
  - `Trade` 인터페이스에 `exitAnomalyReason?: string | null` 추가, DB `trades.exit_anomaly_reason TEXT` 컬럼 마이그레이션 자동 적용.
  - `tradeStore.closeTrade()` 11번째 positional 인자로 `exitAnomalyReason` 전달 (TD-8 부채 +1, 후속 PR 에서 options object 전환 예정).
- **E1a. Trade-report parent grouping + 라벨 정정** (`scripts/trade-report.ts`):
  - `groupByParent()` helper — TP1 partial + remainder 를 parent 단위로 합산.
  - W/L 라인 이중화: `승/패 (row)` 기존 값 + `승/패 (entry)` entry 단위 합산. entry 기준이 1차 메트릭.
  - 라벨 정정: `rtCost(entry)`, `effRR(entry)`, `평균 round-trip cost (entry-time gate snapshot)` — `round_trip_cost_pct` 는 현재 entry-time gate snapshot 이라는 사실 명시.
  - 각 row 서브라인에 `anomaly=...` 노출, `printCostAggregation` 끝에 `FAKE-FILL WARNING` 섹션 추가 (saturated slippage 또는 exit_anomaly_reason 이 N건 있으면 경고).
- **E1c. EdgeTracker sanitizer `fake_fill_slippage` filter** (`src/reporting/edgeInputSanitizer.ts` 외 6 callers):
  - `EdgeLikeTrade` 에 `exitSlippageBps?`, `exitAnomalyReason?` 추가.
  - 신규 drop reason `fake_fill_slippage` — `tp_negative_pnl` 보다 **먼저** 검사해 양수 PnL fake fill 도 차단.
  - `edgeTracker.ts`, `riskManager.ts`, `scannerBlacklist.ts`, `orchestration/reporting.ts`, `scripts/ledger-audit.ts` 모두 새 필드 전파.
- **E2. realized-replay-ratio parent dedup + magnitude floor** (`scripts/analysis/realized-replay-ratio.ts`):
  - `aggregateByParent()` — child row (TP1 partial + remainder) 가 tx_signature 로 중복 매칭되는 경로 차단. pnl 합산, 마지막 exit 가격 사용.
  - `MIN_PREDICTED_MAGNITUDE_PCT = 0.05` floor — per-trade `ratio` 와 `ratioRealizedTotal` 양쪽에 적용. `|denom| < 0.05%` 면 NaN 처리 (tiny denominator 분모 증폭 차단).
  - `AggregateResult` 에 `sumPredictedAdj`, `finiteRatioCount`, `excludedByMagnitudeFloor` 노출. 헤드라인 메시지에 `Mean of per-trade ratios: **X** (n=Y finite, Z excluded by floor)` + `Sum-based ratio: N/A — predicted edge ≈ 0` 처리.
  - finite ratio 가 0 개면 verdict 섹션에 `⚠ **Verdict: 표본 부족 (predicted edge ≈ 0)**` 강제 표시.
- **E3. Phase A4 `EXIT_ANOMALY` slippage saturation guard** (`tradeExecution.ts:670-680`):
  - Phase A4 기존 ratio/gap 체크 다음에 `slippageBps >= 9000` 체크 추가 (live 모드만).
  - E0 fake-fill reason 과 Phase A4 reasons 를 `mergeAnomalyReasons()` 로 dedupe 후 단일 `exit_anomaly_reason` 컬럼에 기록. `slippage_saturated=*` 이 양쪽에서 모두 push 되는 중복 제거.
- **품질 개선 (refactor)**:
  - 4× 중복된 fake-fill detect 블록을 `resolveExitFillOrFakeFill()` helper 로 통합 — 약 100 줄 중복 제거, 향후 drift 차단.
  - `closeTrade` 로그 메시지가 실제 fallback 값 (`exitPrice.toFixed(8)`) 을 출력해 "fallback to entryPrice" 오해 소지 제거.
  - `realized-replay-ratio` 헤드라인에서 `avgPredictedAdj * n` 우회 계산을 `sumPredictedAdj` 직접 노출로 교체.

### 7F-pre. Post-guard 7h window 측정 (Entry 02, 2026-04-07T04:01Z~11:01Z)

> Source: `docs/ops-history/2026-04-07.md` Entry 02
> Context: bot restart `2026-04-07T03:53:05Z` (Phase A/B/C1 배포 직후), 측정 window 7h, closed_rows=4

**raw 측정값 vs Phase C2 합격 기준 (4종)**

| Criterion | Threshold | Entry 02 raw | Entry 02 marker-excluded¹ | Status (raw) | Status (excluded) |
|-----------|-----------|--------------|----------------------------|--------------|-------------------|
| `tp_negative_pnl` | 0건 | 1건 | 0건 (E0 mark) | ❌ | ✅ |
| `entry_gap` p95 | ≤ 5% | n/a² | n/a² | ⚠ unmeasured³ | ⚠ unmeasured³ |
| `exit_gap` p95 | ≤ 10% | max abs 0.58% (n=4) | max abs 0.58% (n=3) | ✅ | ✅ |
| `gap_vs_slippage_mismatch` | 0건 | 1건 (slip=2500 avg, gap≈0) | 0건 (E0 mark) | ❌ | ✅ |

¹ Phase E0 `exit_anomaly_reason` 마커가 set된 row 1건을 제외했을 때(`docs/audits/exit-slip-gap-divergence-2026-04-07.md` 가설 A: 1/4 saturated). raw 4건 중 1건은 `>=9000bps` saturated였다.
² Entry 02 metrics에 `avg_entry_gap_pct_recent_7h`가 부재. 다음 ops loop에서 `npm run ops:check -- --hours 7` 실행 시 entry-gap 라인을 함께 캡처해야 한다.
³ 측정 경로 자체는 2026-04-07 ralph-loop iter3에서 `scripts/ledger-audit.ts:printGapDistribution`로 신설됨. Entry 02 시점에는 미존재였으므로 retroactive 측정 대신 다음 ops loop entry부터 자동 채워진다.

**해석**

- Phase A/B/C1 배포 효과는 명확하다: Entry 01(12h) `avg_exit_gap_pct: -77.59%, max abs 100%` → Entry 02(7h) `-0.30%, 0.58%`. 가격 단위 폭발은 사실상 사라졌다.
- 그러나 raw 카운트 기준 Phase C2 4종 합격은 아직 **2/4 통과 + 2/4 미달**이다. 미달 2건은 모두 같은 saturated row 1개에서 발생한 outlier 효과다.
- E0 마커를 제외한 sanitized subset 기준으로는 측정 가능한 3종이 모두 통과한다. 학습 측면에서 Phase B1 sanitizer가 이 row를 EdgeTracker 입력에서 자동 격리하고 있으므로, **제거된 효과는 이미 운영 중**이다.

**판단**

- raw 메트릭과 sanitized 메트릭 사이 격차가 외부 노이즈가 아니라 **단일 saturated row의 outlier 효과**라는 점이 audit으로 확정됐다. 따라서 Phase C2 합격 기준을 raw로만 보면 단 1건의 fake-fill만 발생해도 canary가 영구히 실패한다.
- 합격 기준을 `marker-aware`로 보강한다: raw 4종 외에 `marker_excluded_subset`에서도 4종을 본다. 본 entry처럼 raw는 부분 미달이지만 marker-excluded subset은 전부 통과면 **조건부 진입(canary 연장 + 추가 표본 4건)**으로 처리한다.
- ~~단 `entry_gap p95`는 어떤 경로로도 측정되지 않은 상태다.~~ → **2026-04-07 보강**: `scripts/ledger-audit.ts:printGapDistribution`이 `entry_gap |abs|` / `exit_gap |abs|`의 n/mean/p50/p95/p99/max와 함께 `Phase C2 verdict | entry_gap p95 X% (≤5%) pass/fail | exit_gap p95 Y% (≤10%) pass/fail` 한 줄을 출력한다 (commit 미정, ralph-loop iteration 3). 다음 ops loop의 `npm run ops:check:ledger -- --hours 7` 산출물에 자동 포함.

**즉시 액션**

- `data/realtime/notifier-events.jsonl`에서 Entry 02 window 동안 `exit_anomaly` critical alert가 실제로 발화했는지 cross-check (E0/Phase A4가 발화하지 않으면 marker-excluded 가설 자체가 흔들린다).
- 다음 ops loop entry에서 `npm run ops:check -- --hours 7`의 entry-gap 출력을 캡처해 `avg_entry_gap_pct_recent_7h`, `max_abs_entry_gap_pct_recent_7h`, `entry_gap_p95_recent_7h`를 metrics_note에 포함.
- `fake_fill_rows / closed_rows` 비율 재측정 (F1-deep-3) — 1/4가 일회성인지 구조적인지 표본 1건만으로는 확정 불가.

### 7F-post. Post-deploy verification (Entry 03, 2026-04-07T12:21Z~13:33Z)

> Source: `docs/ops-history/2026-04-07.md` Entry 03
> Context: bot restart `2026-04-07T12:21:19Z` (Phase E P0~P3 + 품질 개선 배포 직후), 측정 window 1h12min, post_deploy_session=true
> Scope: live-ops-integrity-2026-04-07.md **Phase D 종결 + Phase V D-immediate 검증 + Phase M day-1 baseline**

**Phase D (Deploy & DB Migration) 결과**

| Acceptance | Result | Evidence |
|------------|--------|----------|
| `exit_anomaly_reason` 컬럼 존재 | ✅ pass | `vps-trades-latest.jsonl` 135 rows 모두 keys에 포함, `tradeStore.initialize()` ALTER TABLE 자동 마이그레이션 동작 |
| 재기동 후 첫 closeTrade 성공 | ✅ pass | `dd2a6b4e` (pippin) `2026-04-07T12:32:18Z` TIME_STOP, pnl=+0.000542 SOL, exit_slippage_bps=35, sanitizer/Phase A4 가드 정상 통과 |
| `[FAKE_FILL]` log rotation 부담 | n/a | post-deploy 1h12min 동안 prefix 출력 0건 |

→ Phase D 두 acceptance 모두 통과. live-ops-integrity-2026-04-07.md Phase D 4개 task 전부 종결.

**Phase V D-immediate 결과 (DB UPDATE 없이 즉시 검증 가능 항목)**

| Item | Result | Evidence |
|------|--------|----------|
| `realized-replay-ratio` F1-deep-5 stdout | ✅ pass | `Anomaly filter (>=9000bps slippage or exit_anomaly_reason set): 1 parent groups (2 rows) excluded` |
| `realized-replay-ratio` F1-deep-5 markdown header | ✅ pass | `Closed trades: raw=133, clean=131 (anomaly filter excluded 1 parent groups / 2 rows)` |
| `trade-report` `printSlippageRawAndTrimmed` | ✅ pass (jq simulation) | n=17, raw avg=598.3 bps (saturated 1건 outlier), trimmed avg=10.7 bps (excluded 1) |
| `trade-report` `FAKE-FILL WARNING` 섹션 | ✅ pass (jq simulation) | 후보 row=`1/135` (`exit_anomaly_reason set OR exit_slippage_bps>=9000`) |
| per-row `anomaly=...` 서브라인 | 🟡 deferred | historical row는 `exit_anomaly_reason` NULL이라 자연 검증 불가, 다음 자연 발생 또는 prod DB 1회 backfill 까지 보류 |
| W/L `(row)`/`(entry)` 두 줄 | 🟡 deferred | 로컬 DATABASE_URL 미설정, 다음 ops loop에서 vps-analysis 자동 산출물로 검증 |
| `realized-replay-ratio` N/A verdict | 🟡 deferred | 현 dataset finite n=3이라 0건 강제 verdict 미검증 |

**기대값 정정**: live-ops-integrity-2026-04-07.md Phase V 의 expected `excluded 1/1`은 잘못된 추정이었다. 실제 출력은 `1 parent group / 2 rows` — TP1 partial parent (`2207984d`, 07:50, exit_slip=10000bps) 와 child remainder (`694ca489`, 07:52, STOP_LOSS) 가 같은 `parent_trade_id` 로 묶여 함께 drop된다. Parent-group-aware drop이 의도대로 동작 중이다.

**Phase M day-1 baseline**

| Metric | Value |
|--------|-------|
| 측정 window | `2026-04-07T12:21:19Z ~ 13:33:04Z` (~1h12min) |
| closed_rows | `1` (dd2a6b4e, pre-deploy entry의 자연 unwind) |
| 신규 entry | `0` |
| realized PnL | `+0.000542 SOL` |
| `exit_anomaly_reason` set | `0/1` (post-deploy close 1건은 clean) |
| `fake_fill_rows` (`>=9000bps` or marker) | `0/1` |
| `anomaly_filter_excluded` (1h window) | `0 parent groups / 0 rows` |
| Telegram I/O fail | `0` |

→ day-1 baseline = `0 fake-fill, 0 anomaly marker, 0 false positive`. 7일 누적 종결 = `2026-04-14`.

**Activity (universe / candidate diversity)**

- `runtime_signal_rows_recent_1h=1` (13:26Z `pippin` Grade A → Token too new 8min 차단 = 신규 hard floor 정상 작동)
- `realtime_candidate_seen_recent_1h=62` (distinct 39) / `candidate_evicted_recent_1h=54` (idle 100%)
- `admission_skip_recent_1h=29` (`unsupported_dex` 21 + `no_pairs` 8)
- `risk_rejection_recent_1h=1` (`token_safety`)
- `trigger_stats` reset 12:42Z 이후 대부분 `evals=0`, 13:27Z `evals=6 signals=1 activePairs=1` 1회만 활성

> ⚠ 1h 표본은 universe quality / concentration / 로서 페어 재유입 framing 의 근거로 사용 금지. day-2 비교가 가능해질 때까지 framing 보류.

**즉시 액션 / Action items**

- live-ops-integrity-2026-04-07.md Phase V 에서 검증 끝난 3건은 종결, 5건은 deferred 마킹 (완료).
- Phase M 7일 모니터링 본격 가동 — day-2 entry부터 metrics_note에 `exit_anomaly_reason` 카운트 + `realized-replay-ratio` excluded 카운트 누적.
- per-row `anomaly=` 서브라인 검증은 (a) 다음 자연 발생 fake-fill 또는 (b) prod DB 1회 backfill 둘 중 자연 발생 우선. 7일이 지나도 자연 발생이 없으면 backfill 결정 재고려.
- 7F item 5 (`Live 일시정지 권장`) 은 본 entry로 무효화 — bot v0.5 가 12:22:20Z 부터 정상 가동 중. 일시정지 항목은 §7F 본문에서 제거 또는 status 갱신 (다음 항목 참조).

### 7F. 남은 운영 과제

> **Phase E(2026-04-07 Live Ops Integrity) 배포 이후 작업은 별도 실행 플랜으로 분리**:
> [`docs/exec-plans/active/live-ops-integrity-2026-04-07.md`](./docs/exec-plans/active/live-ops-integrity-2026-04-07.md)
> — Phase D(배포) / Phase V(실데이터 검증) / Phase M(7일 모니터링) / Phase S(별도 PR 부채) 참조.

1. **Phase A1 수동 교차 검증** — 운영자가 `data/diagnostics/ledger-audit-2026-04-07.txt`를 기반으로 BTW/pippin/stonks txSignature를 Solscan/Helius에서 조회해 `outAmount_raw / 10^decimals` 실측 vs DB `quantity` 배수 기록.
2. **Pre-guard row 격리 절차** — 2026-04-07 이전에 생성된 trade rows(특히 `planned_entry_price IS NULL` 또는 `planned/entry ratio ∉ [0.5, 2.0]`)는 sanitizer가 부분적으로만 걸러내므로 EdgeTracker 학습과 daily/shadow 리포트에서 명시적으로 제외해야 한다. 스키마 변경 없이 **cutoff 기준 + sanitizer 의존** 방식으로 처리한다.
   - **(a) 오염 범위 조회** (read-only SQL, 삭제 금지):
     ```sql
     SELECT id, pair_address, created_at, planned_entry_price, entry_price,
            CASE WHEN planned_entry_price > 0
                 THEN entry_price / planned_entry_price ELSE NULL END AS ratio
     FROM trades
     WHERE created_at < '2026-04-07T00:00:00Z'
       AND status = 'CLOSED'
       AND (planned_entry_price IS NULL
            OR planned_entry_price <= 0
            OR entry_price / planned_entry_price NOT BETWEEN 0.5 AND 2.0)
     ORDER BY created_at DESC;
     ```
     결과를 `data/diagnostics/pre-guard-rows-2026-04-07.csv`로 보존.
   - **(b) audit 실행** — `npm run ops:check:ledger -- --hours 336 --full-history`로 sanitize on/off 차이를 재확인. `FLIPPED` 마커가 있는 pair는 bypass canary 기간 동안 차단 해제 대상.
   - **(c) Cutoff 기준** — rows는 물리적으로 삭제하지 않는다. 경로별 처리는 다음과 같다:
     - **EdgeTracker 학습** — `sanitizeEdgeLikeTrades`가 이미 `invalid_stop_loss`(stop_loss=0 케이스, VPS dump의 대부분 pre-guard row가 여기에 해당) + `planned_entry_ratio_corrupt`(plannedEntryPrice가 세팅된 후 ratio 이탈) 두 필터로 drop하므로 `toEdgeTrackerTrade` 경로는 **자동 격리**.
     - **`plannedEntryPrice IS NULL` 잔여 갭** — plannedEntryPrice는 NULL이지만 stop_loss는 유효한 희귀 케이스는 sanitizer가 잡지 못한다. (a) 조회 결과에서 해당 row가 존재하면 `scripts/ledger-audit.ts`의 추가 필터(`created_at < cutoff AND planned_entry_price IS NULL`) 명시적 exclusion이 필요.
     - **Daily/shadow 리포트** — `closedTodayTrades`가 24h window라 cutoff 이전 row를 자연스럽게 벗어난다. 별도 조치 불필요.
   - **(d) EdgeTracker 재학습** — `BOT_BYPASS_EDGE_BLACKLIST=true` 상태에서 최소 20개의 post-guard closed trade가 쌓인 뒤에만 `false`로 복귀. 이 시점에 EdgeTracker가 재계산되며 sanitizer가 pre-guard row를 drop한다.
   - **(e) 검증** — Phase D1 baseline 측정 시 `scripts/ledger-audit.ts --full-history` 출력의 `sanitizer dropReasonCounts`에서 `invalid_stop_loss` + `planned_entry_ratio_corrupt` 합계가 (a) 카운트와 일치해야 한다. 차이가 나면 NULL plannedEntryPrice 잔여 갭(위 두 번째 항목)에 해당하므로 수동 exclusion 필요.
3. **Phase C2 12h paper canary** — 가드 배포 후 paper 모드로 12h 운영 후 합격 기준 4종 확인:
   - 0건 `tp_negative_pnl`
   - `entry_gap` p95 ≤ 5%
   - `exit_gap` p95 ≤ 10%
   - 0건 `gap_vs_slippage_mismatch`
   합격 후에만 live 재가동. **2026-04-07 보강** — 1건의 saturated fake-fill row가 raw 메트릭을 영구히 실패시키므로 `marker_excluded_subset`에서도 동일 4종을 측정한다(§7F-pre 참조). raw 부분 미달 + sanitized subset 전체 통과 케이스는 canary 연장(추가 표본 ≥ 4건)으로 처리한다.
4. **Phase D 50-trade 동결 복귀** — canary 합격 후 `BOT_BYPASS_EDGE_BLACKLIST=false`로 복원, bootstrap tier risk 룰 그대로 50 trades까지 유지.
5. **Live 운영 상태** — ~~Phase C2 통과까지 수동 halt 유지~~ → **2026-04-07T12:22:20Z `Bot started v0.5` 부터 live 재가동 중** (Phase E P0~P3 + 품질 개선 배포 직후 자동 부팅, Entry 03 Phase D 통과 확인). Phase M 7일 모니터링 기간 동안 `exit_anomaly_reason` 자연 발생 빈도와 신규 entry 분포를 관찰하며, false positive 발생 시에만 수동 halt 재고려.

### 7G. Edge Cohort Quality — Axis 3 signal-level 1차 측정 (Entry 04, 2026-04-07)

> ops-history Entry 04 / `docs/exec-plans/active/edge-cohort-quality-2026-04-07.md` Axis 3 acceptance 첫·셋째 항목 partial 충족.
> 출처 audit: [`docs/audits/signal-cohort-2026-04-07.md`](./docs/audits/signal-cohort-2026-04-07.md)
> 측정 도구: [`scripts/analysis/signal-cohort-audit.ts`](./scripts/analysis/signal-cohort-audit.ts) (read-only, signal-intents.jsonl 기반, DB 의존성 0)

**왜 §7G에 두는가**: 사용자 가설(저시총 고거래량 surge edge)이 가드 차단 때문에 미검증인지, 데이터 자체가 부족해서 미검증인지 1차 분리하기 위해. trade 단위 R-multiple은 trades 테이블에 marketCap 컬럼이 없어 산출 불가 — signal 단위 pass rate로 우회.

**Cohort verdict (4 sessions / 86 signals / 71 with marketCap)**

| Cohort | 정의 | Signals | Executed | Exec rate |
|---|---|---:|---:|---:|
| **low-cap surge** | mc<$1M AND vol/mc>1.0 | 24 | 7 | **29.2%** |
| **high-cap continuation** | mc≥$10M AND vol/mc<0.5 | 43 | 7 | 16.3% |

**해석 (4점)**

1. **partial confirm (통과율)**: low-cap surge cohort exec rate 29.2% > high-cap continuation 16.3% — 가드가 저시총 cohort를 일률적으로 봉인하지 않는다. "가설 검증을 가드가 막는 중"은 사실이 아님.
2. **partial reject (실측 손익)**: 그러나 executed 7건 모두 손실 (LLM × 2, stonks × 3, BTW × 2). cooldown 발화 사유에서 "6/7/9/10 consecutive losses" 직접 관측. **n=3 unique token이라 cohort-level 단정 불가** — 표본 부족이지 가설 기각 아님.
3. **inconclusive (극단 저시총 4ytp $44K)**: cohort 내 가장 극단인 `4ytpZgVoNB66bF` ($44K mc, ratio 3.48) 는 0 trades — `[PRICE_ANOMALY_BLOCK] Entry ratio 0.000000 outside [0.7, 1.3]` 로 차단. **cohort 내 어떤 단일 signal도 진입하지 못해 가설 검증 자체가 봉인**.
4. **Phase A3 false positive 의심**: BTW $47K (ratio 3.29) 도 동일 PRICE_ANOMALY_BLOCK 으로 2회 차단. 다만 BTW는 historical loser (cooldown 누적 토큰)라 PRICE_ANOMALY가 false positive인지 단정 불가 — F1-deep audit (`docs/audits/exit-slip-gap-divergence-2026-04-07.md`)에서 분리 추적 필요.

**차단 사유 분포 (24 low-cap surge → 17 blocked)**

| 사유 | 건수 |
|---|---:|
| Cooldown active (6~10 consecutive losses) | 9 |
| Per-token cooldown (recent losses) | 3 |
| Quote error (DNS/EPROTO) | 2 |
| `[PRICE_ANOMALY_BLOCK]` (Phase A3) | 3 |
| Swap failed after 3 attempts | 1 |

→ **가드 차단의 60%가 risk cooldown 누적**. PRICE_ANOMALY 차단은 17건 중 3건 (18%)에 불과 — 사용자 가설 검증 봉인의 1차 원인은 risk cooldown이지 Phase A3가 아니다.

**즉시 액션 (이 §7G로부터 파생)**

- **금지**: 이 데이터를 근거로 risk cooldown 완화를 검토하지 않는다. F1-deep audit 통과 전까지 forbidden (edge-cohort-quality plan Out-of-Scope 명시).
- **다음 진입 조건**: Phase M 7d 누적 시 `low-cap surge` cohort closed trades ≥ 30 (현재 7) 도달 후에만 cohort verdict를 confirm/reject로 전환. 그 전까지는 Entry 04 verdict는 inconclusive로 고정.
- **Axis 3 종결 조건**: 위 30 trades 표본 + cohort별 win-rate / R-multiple 산출 + trades 테이블 marketCap 컬럼화(또는 signal-intents JOIN 로직) — 현 시점에서는 Axis 3 acceptance 첫·셋째 항목 `[~]` partial 마킹 유지.

**상위 plan link**

- [`docs/exec-plans/active/edge-cohort-quality-2026-04-07.md`](./docs/exec-plans/active/edge-cohort-quality-2026-04-07.md) Axis 3 acceptance + History (2026-04-07 ralph-loop iter7)
- [`docs/ops-history/2026-04-07.md`](./docs/ops-history/2026-04-07.md) Entry 04 (cohort signal-level 1차 측정)

### 7H. Price Anomaly Ratio — 7h live window 정밀 진단 (Entry 05, 2026-04-08, ralph-loop iter8)

> Source: [`docs/audits/price-anomaly-ratio-2026-04-08.md`](./docs/audits/price-anomaly-ratio-2026-04-08.md) (read-only Phase 1 diagnosis)
> Trigger: Codex 운영 로그 분석 — 2026-04-07T15:13Z~22:13Z window에서 28 signals 중 15건 PRICE_ANOMALY_BLOCK (54%)
> Window: `2026-04-07T15:13:02.733Z ~ 2026-04-07T22:13:02.733Z` (7h)
> Session: `2026-04-07T14-35-58-100Z-live`

**핵심 정정 (§7G와의 framing 차이)**

- §7G framing: 4-session 평균에서 cohort blocking의 60%가 risk cooldown 누적, PRICE_ANOMALY는 17건 중 3건(18%)
- 7H framing: 단일 7h window에서 PRICE_ANOMALY 100%(15/15 execution_failed)
- 두 framing 모두 유효 — 적용 cohort/window가 다르다. §7G는 4-session aggregate, 7H는 단일 7h live window 직접 측정. **PRICE_ANOMALY rate는 시점/cohort에 따라 18~100%로 변동**

**Hard data**

| Status | Count | Note |
|---|---:|---|
| `execution_failed` | 15 | 100% PRICE_ANOMALY_BLOCK |
| `risk_rejected` | 9 | cooldown 누적 |
| `executed_live` | 4 | pippin × 2, swarms × 2 |
| **Total** | **28** | 100% pippin(14)+swarms(14) |

| Ticker | mc | volMcap | TVL | mean ratio | inflation |
|---|---:|---:|---:|---:|---:|
| pippin | $34.2M | 0.15 | $4.7M | 0.185 | 5.41× |
| swarms | $14.7M | 0.17 | $1.6M | 0.031 | 32.26× |

**관찰**:
1. ratio가 토큰별로 다르고 같은 토큰 내에서는 거의 일정 (pippin σ<5%, swarms σ<8%)
2. 같은 토큰에서 30분 내 success/failure interleave — 토큰 영구 unit bug 아님 (path-dependent)
3. inflation 5.41× / 32.26×는 정수 decimals shift(10^k) 아님 — 단순 decimals 누락 아님

**Verdict (Phase 1 read-only)**

- **Phase A3 가드는 true positive**. 잘못된 가격을 ledger에 진입시키지 않게 정확히 차단 중. Phase A3 임계 [0.7, 1.3] 조정 금지.
- **차단의 원인은 timing/sandwich가 아니라 candle.close 산출 path의 오염**이다 — 즉 priceNative computation upstream에 path-dependent bug.

**Suspect ranking** (상세는 audit doc §Suspect Ranking)

| Rank | Path | 확률 | 검증 |
|---|---|---:|---|
| 1 | `parsePumpSwapInstruction` offset 16 = `max_quote_amount_in` 디코딩 | **100% 확정** (iter9 IDL verification) | PumpSwap 공식 IDL `buy(base_amount_out, max_quote_amount_in, track_volume)` 시그니처 — 두 u64 모두 user intent (slippage worst-case bound) |
| 2 | `parseFromPoolMetadata` `sumMintDelta` partial delta | ~20% (iter10 후 decision) | iter10 fix 배포 후 PRICE_ANOMALY rate 변화로 분기 |
| 3 | `pickLargestTokenDelta` multi-hop intermediate token | ~5% | pool metadata 존재 여부 확인 |
| 4 | Helius WS feed 자체 inflation | ~5% | `heliusWSIngester.ts` read |

**iter9 verdict (2026-04-08)**: 1순위 100% 확정. `parsePumpSwapInstruction`이 산출하는 `priceNative = max_quote_amount_in / base_amount_out`은 사용자의 worst-case price (slippage upper bound)이지 actual fill price가 아니다. 슬리피지 톨러런스 reverse engineering: pippin 5.41× ≈ 68.7%, swarms 32.26× ≈ 94%. 멤코인 트레이더가 큰 슬리피지를 자주 설정하는 패턴과 일치.

**즉시 차단 우선순위 (다음 ralph-loop iter)**

1. ~~iter9 (code-only): PumpSwap IDL discriminator 확인 → 1순위 verdict~~ ✅ **완료**
2. ~~iter10: `parsePumpSwapInstruction` priceNative 산출 path 폐기~~ ✅ **완료 (2026-04-08)** — 아래 §iter10 결과 참조
3. **iter11 (decision-tree, 7h 모니터링 후)**: iter10 배포 후 PRICE_ANOMALY rate 변화 미관측 시 → 시나리오 Y 확정, `sumMintDelta` user-account-only 필터 추가
4. **Phase 2 (별도 iter)**: 4 entries (PIPPIN×2, SWARMS×2) per-trade timeline decomposition

**iter10 결과 (2026-04-08, ralph-loop iter10)**

- 변경 파일:
  - `src/realtime/pumpSwapParser.ts` — `parsePumpSwapFromTransaction`, `parsePumpSwapInstruction`, `parsePumpSwapFromLogs`, `BUY_DISCRIMINATOR`, `SELL_DISCRIMINATOR`, `decodeInstructionData`, `decodeSide`, `readU64LE`, `parseNumeric`, `detectSide` 모두 삭제. bs58 / web3.js types import 제거. `PUMP_SWAP_PROGRAM`, `PUMP_SWAP_DEX_IDS`, `isPumpSwapDexId`, `isPumpSwapPool`만 유지 (157 lines → 23 lines)
  - `src/realtime/swapParser.ts:142` — `parseSwapFromTransaction`에서 PumpSwap pool 분기 단순화: `isPumpSwapPool(metadata)`이면 `parseFromPoolMetadata` 결과를 그대로 반환 (null이면 swap drop). instruction parser fallback 호출 완전 제거.
  - `test/swapParser.test.ts:108` — 'parses direct PumpSwap instructions...' 테스트를 'drops PumpSwap swaps when pre/post token balance deltas are missing (no instruction-decode fallback)'로 교체. 동일 입력(meta with empty token balances + buy instruction)이 이제 `null`을 반환하는지 검증.
- 검증:
  - `npx tsc --noEmit` → 0 errors
  - `npx jest test/` → **87 suites / 466 tests all pass** (swapParser 16/16)
- 의도:
  - PumpSwap pool에 한해 actual fill을 측정 가능한 유일한 source는 pre/postTokenBalances delta. instruction payload는 user intent (slippage 상한)이라 산술적으로 actual price를 산출할 수 없다.
  - 옵션 A (보수적) 적용: parser 자체를 삭제해 미래에 동일 버그 재발 가능성 차단.
- VPS 배포 + 7h 모니터링 결과는 다음 ops loop entry에 기록 (decision tree: PRICE_ANOMALY rate 0% → 시나리오 X 확정 → axis 종결 / 여전히 high → 시나리오 Y 확정 → iter11 sumMintDelta 보강).

**iter10 fix 접근법** (audit doc §Phase 1B Verdict 상세)

- 옵션 A (보수적, 권장): `parseFromPoolMetadata`가 null이면 PumpSwap swap을 drop. instruction parser path는 본질적으로 actual fill을 측정 불가하므로 즉시 폐기.
- 옵션 B (계측 후 결정): 1주일 instrumentation 후 결정 — 거부 (PRICE_ANOMALY 1주일 추가 누적 비용 > 1순위 가설 틀릴 위험)

**Operational verdict**

- 옵션 D 유지: **운영 계속 + 진단 병행**. Phase A3 가드가 ledger 오염을 정확히 막고 있고, 7h window 실손실 -0.0029 SOL = daily 한도의 6%로 제어 범위 내.
- 4 entry 0W/4L 100% 손실률은 **Phase 2 (per-trade decomposition)에서 별도 분해 필요** — 이번 audit은 Phase 1 read-only diagnosis로만 한정.
- **Phase A3 임계 조정 금지** — 5×/32× inflation이 사실이면 [0.7, 1.3]는 정확한 임계다. 늘리면 ledger 오염을 풀어준다.

**상위 plan link**

- [`docs/audits/price-anomaly-ratio-2026-04-08.md`](./docs/audits/price-anomaly-ratio-2026-04-08.md) — 본 audit 원문 (Phase 1 diagnosis)
- [`docs/ops-history/2026-04-08.md`](./docs/ops-history/2026-04-08.md) Entry 05 (day-2 ops loop entry, ralph-loop iter8)
- [`docs/exec-plans/active/edge-cohort-quality-2026-04-07.md`](./docs/exec-plans/active/edge-cohort-quality-2026-04-07.md) Axis 2 — 7h window `top_signal_pair / total_signals = 14/28 = 0.5` (acceptance 임계 상한)
