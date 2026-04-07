Status: current
Updated: 2026-04-07
Purpose: 2026-04-07 live 운영 이상 징후와 현재 판단 근거를 단건 문서로 고정
Use with: `OPERATIONS.md`, `docs/runbooks/live-ops-loop.md`, `scripts/ledger-audit.ts`

# CRITICAL_LIVE

## Scope

- 목적: 최신 live 운영 이슈를 `증거 -> 판단 -> 금지 조치 -> 다음 액션` 순서로 정리
- 기준 window:
  - runtime latest synced at `2026-04-07T02:26:20.474Z`
  - DB trade report window `2026-04-06T14:31:03Z ~ 2026-04-07T02:31:03Z`
- 기준 소스:
  - `data/realtime/current-session.json`
  - `data/realtime/runtime-diagnostics.json`
  - `data/realtime/sessions/2026-04-06T14-17-04-255Z-live/realtime-signals.jsonl`
  - `scripts/ledger-audit.ts`
  - `src/orchestration/tradeExecution.ts`
  - `src/notifier/notifier.ts`
  - `src/notifier/messageFormatter.ts`

## One-line Conclusion

- 현재 live 핵심 이슈는 단순 `signal 부족`이 아니라, `risk/gate 차단` 위에 `가격 단위 불일치 의심`이 겹쳐 `exit 판단과 ledger 근거가 동시에 오염됐을 가능성`이다.

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
| `entry_gap` p95 | ≤ 5% | n/a² | n/a² | ⚠ unmeasured | ⚠ unmeasured |
| `exit_gap` p95 | ≤ 10% | max abs 0.58% (n=4) | max abs 0.58% (n=3) | ✅ | ✅ |
| `gap_vs_slippage_mismatch` | 0건 | 1건 (slip=2500 avg, gap≈0) | 0건 (E0 mark) | ❌ | ✅ |

¹ Phase E0 `exit_anomaly_reason` 마커가 set된 row 1건을 제외했을 때(`docs/audits/exit-slip-gap-divergence-2026-04-07.md` 가설 A: 1/4 saturated). raw 4건 중 1건은 `>=9000bps` saturated였다.
² Entry 02 metrics에 `avg_entry_gap_pct_recent_7h`가 부재. 다음 ops loop에서 `npm run ops:check -- --hours 7` 실행 시 entry-gap 라인을 함께 캡처해야 한다.

**해석**

- Phase A/B/C1 배포 효과는 명확하다: Entry 01(12h) `avg_exit_gap_pct: -77.59%, max abs 100%` → Entry 02(7h) `-0.30%, 0.58%`. 가격 단위 폭발은 사실상 사라졌다.
- 그러나 raw 카운트 기준 Phase C2 4종 합격은 아직 **2/4 통과 + 2/4 미달**이다. 미달 2건은 모두 같은 saturated row 1개에서 발생한 outlier 효과다.
- E0 마커를 제외한 sanitized subset 기준으로는 측정 가능한 3종이 모두 통과한다. 학습 측면에서 Phase B1 sanitizer가 이 row를 EdgeTracker 입력에서 자동 격리하고 있으므로, **제거된 효과는 이미 운영 중**이다.

**판단**

- raw 메트릭과 sanitized 메트릭 사이 격차가 외부 노이즈가 아니라 **단일 saturated row의 outlier 효과**라는 점이 audit으로 확정됐다. 따라서 Phase C2 합격 기준을 raw로만 보면 단 1건의 fake-fill만 발생해도 canary가 영구히 실패한다.
- 합격 기준을 `marker-aware`로 보강한다: raw 4종 외에 `marker_excluded_subset`에서도 4종을 본다. 본 entry처럼 raw는 부분 미달이지만 marker-excluded subset은 전부 통과면 **조건부 진입(canary 연장 + 추가 표본 4건)**으로 처리한다.
- 단 `entry_gap p95`는 어떤 경로로도 측정되지 않은 상태다. 이 line item을 채우기 전까지 Phase C2 entry는 보류한다.

**즉시 액션**

- `data/realtime/notifier-events.jsonl`에서 Entry 02 window 동안 `exit_anomaly` critical alert가 실제로 발화했는지 cross-check (E0/Phase A4가 발화하지 않으면 marker-excluded 가설 자체가 흔들린다).
- 다음 ops loop entry에서 `npm run ops:check -- --hours 7`의 entry-gap 출력을 캡처해 `avg_entry_gap_pct_recent_7h`, `max_abs_entry_gap_pct_recent_7h`, `entry_gap_p95_recent_7h`를 metrics_note에 포함.
- `fake_fill_rows / closed_rows` 비율 재측정 (F1-deep-3) — 1/4가 일회성인지 구조적인지 표본 1건만으로는 확정 불가.

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
5. **Live 일시정지 권장** — 운영자 판단으로 Phase C2 통과까지 live는 수동 halt 유지.
