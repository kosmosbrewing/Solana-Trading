# Execution Plan: Exit Execution Mechanism

> Status: active (draft — Phase E0 complete, Phase E1 pending)
> Created: 2026-04-08
> Origin: Phase X2 v2 audit 발견 (`TP2 intent → actual fill match = 0/10 = 0%`) + `mission-recovery-triage-2026-04-08.md` A1 지시
> Scope: monitor loop 가 exit 를 트리거한 뒤 Jupiter swap 이 체결될 때까지의 **execution mechanism** 만 다룬다. exit parameter tuning 은 본 plan 범위 밖
> Use with: [`exit-structure-validation-2026-04-08.md`](./exit-structure-validation-2026-04-08.md) (parameter side), [`live-ops-integrity-2026-04-07.md`](./live-ops-integrity-2026-04-07.md) Phase M (측정 infra), [`1sol-to-100sol.md`](./1sol-to-100sol.md) (상위 mission plan), [`../../audits/mission-recovery-triage-2026-04-08.md`](../../audits/mission-recovery-triage-2026-04-08.md) (triage)
> Related tech debt: TD-14 (orderShape lock 사유가 이 plan 의 결과에 의존)

---

## Role

이 문서는 **exit execution mechanism 의 정합성 회복**을 위한 measurement → prototype → decision lifecycle 을 고정한다.

- orderShape 튜닝 (tp1/tp2/sl multiplier) 은 본 plan 의 **전제 조건**이지 **대상**이 아니다 → `exit-structure-validation-2026-04-08.md`
- 본 plan 은 "TP2 trigger 발동 후 체결 시점까지 가격 축이 어긋나는 현상" 을 고친다
- 모든 결정은 measurement 이후. paper prototype → live canary → decision 순서 엄수
- 사명 경로(`1 SOL → 100 SOL`) 상에서 현재 **binding constraint 1 순위**이다 (triage §2 A1)

---

## Background

### 증거

| 출처 | 관찰 |
|---|---|
| `exit-structure-validation-2026-04-08.md` §Phase X2 v2 (n=18) | TP2 intent rate 55.6%, **actual TP2 reach rate 0.0%**, TP2 intent → actual match 0/10 |
| 동 문서 | Actual outcome distribution: SL_OR_WORSE 50%, BELOW_ENTRY 44.4%, BELOW_TP1 5.6% |
| 동 문서 | net realized PnL (n=18) = −0.017809 SOL |
| `signal-cohort-2026-04-07.md` | low-cap surge cohort 7 executed / 7 losses |

### 현재 exit 경로 (검증된 동작)

1. `checkOpenPositions()` 5 초 polling ([`tradeExecution.ts:428`](../../../src/orchestration/tradeExecution.ts))
2. candle 기반 `observedHigh / observedLow` 로 SL/TP 체크 ([`tradeExecution.ts:496, 510, 546`](../../../src/orchestration/tradeExecution.ts))
3. `closeTrade()` 호출 → `updatePositionsForPair('EXIT_TRIGGERED')` ([`tradeExecution.ts:621`](../../../src/orchestration/tradeExecution.ts))
4. `executor.executeSell()` → Jupiter Ultra or Swap v6 ([`executor.ts:146`](../../../src/executor/executor.ts))
5. Jupiter 응답 수신 → `resolveExitFillOrFakeFill()` 로 exit price 확정
6. DB `closeTrade` → decisionPrice / exitPrice / exitSlippageBps 기록

### 현상

step 2 → step 5 사이 수 초 지연 동안 메모코인 가격이 reverse. 10×ATR TP2 는 가장 변동성 높은 구간에 배치돼 있으므로 가장 잘 뒤집힌다. DB 에는 `exit_reason=TAKE_PROFIT_2`, `exit_price=SL 근처` 로 저장되어 intent 와 actual 이 분리된다.

**이것은 stamping bug 가 아니다.** 코드는 의도대로 동작한다 — `exit_reason` 은 monitor trigger intent 이고 `exit_price` 는 Jupiter fill 이다. 두 값은 의미상 분리돼야 하는 metric 이다. 문제는 **두 metric 의 gap 이 전략 기대값을 완전히 무효화할 만큼 크다**는 점이다.

### 왜 runner-centric 전략이 치명적으로 영향받는가

`STRATEGY.md` v5 설계: SL 1.5×ATR / TP1 1×ATR partial 30% / TP2 10×ATR runner.

- Nominal RR = 10.0 / 1.5 ≈ 6.67
- 구조상 "손실 짧게 + 큰 winner 한 건이 다수 손실 덮기" 에 의존
- **TP2 실제 fill 이 0% 면 이 전제가 성립 안 함** — runner 가 잡히지 않음

즉 orderShape 튜닝 (Phase X3 Scenario A: `tp2 10.0 → 5.0`) 만으로는 해결 안 된다. swap latency 동안의 price reverse 는 multiplier 와 무관하게 발생한다. `STRATEGY_NOTES.md` 2026-04-08 메모가 같은 판정을 한다:

> "Multiplier 만 낮춰도 swap latency 동안의 price reverse 자체는 해결되지 않는다. 그 경우 exit *mechanism* 개선 (candle observation → tick observation, market sell → limit, sub-second monitoring)을 동반해야 하며 이는 본 plan 의 Out of Scope 로 분리됐다. 후보 plan: `exit-execution-mechanism-YYYY-MM-DD.md`."

본 plan 이 그 후보 plan 이다.

---

## Candidate Solutions

Phase E1 에서 비교할 후보. **지금 결정 금지** — 측정 후 결정.

| 후보 | 접근 | 주요 위험 | 구현 부담 |
|---|---|---|---|
| **C1. Polling 주기 단축** | `checkOpenPositions` interval 5s → 1s 또는 500ms | 단순. swap latency 는 여전히 수 초 → gap 축소는 제한적. CPU / DB query 부담 증가 | 낮음 (interval 상수 변경 + query 최적화) |
| **C2. Tick-level trigger** | `MicroCandleBuilder.on('tick')` 구독 + open-trade TP/SL index 로 O(1) 체크 | dual-path (tick + 5s polling) race condition, 중복 sell 가능. `checkOpenPositions` 안의 9 개 로직 중 SL/TP 만 분리하고 나머지 (trailing, exhaustion, time stop, degraded) 는 여전히 polling | 중간 (새 listener + per-trade exit lock 필요) |
| **C3. Pre-submit price recheck** | `closeTrade` 진입 후 Jupiter swap 호출 직전 `realtimeCandleBuilder.getCurrentPrice()` 재확인. gap 임계 초과 시 abort 또는 재시도 | 정상적인 fast fill 도 차단할 위험. 임계 튜닝 필요. abort 시 남은 동작 (candle 재관찰, timeout) 설계 필요 | 낮음 (closeTrade 내부 수 줄) |
| **C4. Jupiter Limit Order** | Jupiter Limit Order API 로 SL/TP 를 사전 주문으로 배치 | Solana 메모코인 pool 에서 limit order 는 대부분 미지원 (pump.fun, pumpswap). Jupiter LO 는 mainnet pool 기반. 조사만 먼저 | 조사 단계. 본 plan 범위에선 feasibility study 만 |
| **C5. Hybrid (C3 + C1)** | polling 주기 단축 (C1) + submit 전 recheck (C3) | 가장 보수적. 양쪽 효과를 겹쳐 보수적으로 gap 축소 | 낮음 (두 변경의 합) |

### Out of Scope (후보로 다루지 않음)

- **즉시 TP2 multiplier 축소** — `exit-structure-validation-2026-04-08.md` Phase X3 Scenario A. 본 plan 과 **독립**이지 대체재가 아님
- **Trailing stop mechanism 변경** — Grade A/B runner activation 로직. 별도 plan
- **Degraded exit phase 2 mechanism** — sell impact / quote fail 기반 분리 경로. 이미 동작 중이며 본 plan 무관
- **Entry execution mechanism** — buy 경로는 Phase A3 ratio clamp + entry alignment 로 이미 정합성 확보됨

---

## Phase E0 — Problem Verification (완료)

### 목표

현상이 stamping bug 가 아니라 mechanism issue 임을 확정한다.

### 작업

- [x] `exit-distribution-audit.ts` v2 가 intent vs actual cross-tabulation 출력하도록 확장 — 완료 (n=18 audit 결과)
- [x] `exit_reason=TAKE_PROFIT_2` rows 의 `exit_price >= takeProfit2` 매치율 측정 — 0/10 확인
- [x] 코드 static review: `exit_reason` 은 monitor trigger 시점 intent, `exit_price` 는 Jupiter fill — 의도대로 분리 동작 확인 ([`tradeExecution.ts:540, 655`](../../../src/orchestration/tradeExecution.ts))

### Acceptance

- [x] Phase X2 v2 finding 이 `exit-structure-validation-2026-04-08.md` 에 기록됨
- [x] `STRATEGY_NOTES.md` 2026-04-08 메모에 mechanism issue 로 분리 기록됨
- [x] `mission-recovery-triage-2026-04-08.md` 에서 A1 으로 분류됨

### Lifecycle

- 시작: 2026-04-08 (Phase X2 v2 실행일)
- 종결: 본 plan 생성 시점 = 2026-04-08
- **상태: complete**

---

## Phase E1 — Measurement Baseline + C3/C5 Prototype (paper)

### 목표

exit latency 와 price reverse 의 분포를 실측으로 확정하고, C3/C5 prototype 을 paper 모드에서 검증한다. **가장 보수적인 후보부터 시작**한다 (race condition 없는 경로).

### 작업

#### E1-1. Measurement infra 확장

- [ ] `trades` 테이블에 신규 컬럼 추가 (Drizzle migration):
  - `monitor_trigger_price NUMERIC` — monitor 가 trigger 발동 시점에 관찰한 가격 (observedHigh / observedLow 또는 tick price)
  - `monitor_trigger_at TIMESTAMPTZ` — trigger 발동 시각
  - `swap_submit_at TIMESTAMPTZ` — Jupiter swap 호출 직전 시각
  - `swap_response_at TIMESTAMPTZ` — Jupiter 응답 수신 시각
  - `pre_submit_tick_price NUMERIC` — submit 직전 `realtimeCandleBuilder.getCurrentPrice()` (C3 시 기록)
- [ ] `closeTrade()` 에서 위 5 개 값 persist ([`tradeExecution.ts:621`](../../../src/orchestration/tradeExecution.ts))
- [ ] `scripts/analysis/exit-latency-audit.ts` 신규 생성
  - 입력: `trades` 테이블 (clean, `exit_anomaly_reason IS NULL`)
  - 출력: `trigger → submit` gap, `submit → response` gap, `trigger_price → exit_price` ratio 분포
  - 출력: exit reason × {latency p50/p95, price reverse ratio p50/p95}
- [ ] `trade-report.ts` 확장: exit latency 한 줄 헤드라인 추가

#### E1-2. C5 (Hybrid) prototype — paper mode only

- [ ] Feature flag 추가: `EXIT_MECHANISM_MODE` env var
  - 값: `legacy` (기본) | `hybrid_c5`
  - `config.ts` 에 `exitMechanismMode: string` 추가
- [ ] `monitoringLoops.ts` 의 position check interval 을 `exitMechanismMode === 'hybrid_c5'` 일 때 5000 → 1000 로 단축 (C1 part)
- [ ] `closeTrade()` 진입 시 (paper 모드에서도) `realtimeCandleBuilder.getCurrentPrice()` 조회하여 `pre_submit_tick_price` 에 persist (C3 part, paper 모드에선 abort 경로 skip)
- [ ] paper 모드에서 `decision_price == exit_price` 유지하되 `monitor_trigger_price`, `pre_submit_tick_price` 는 실측

**핵심 제약:** Phase E1 은 **paper 모드에서 measurement 만** 한다. Live canary 는 Phase E3 이후.

#### E1-3. Paper validation loop

- [ ] `EXIT_MECHANISM_MODE=hybrid_c5` 로 paper 재기동
- [ ] 최소 ≥ 100 closed trades (paper) 또는 ≥ 7 일 운용 중 먼저 도달하는 쪽까지 누적
- [ ] `exit-latency-audit.ts` 실행하여 gap 분포 기록

### Target Files

- `src/candle/tradeSchema.ts` (migration)
- `src/candle/tradeStore.ts` (`insertTrade`, `closeTrade`)
- `src/orchestration/tradeExecution.ts` (`closeTrade`, `handleTakeProfit1Partial`, `handleRunnerGradeBPartial`, `handleDegradedExitPhase1` — persist 추가)
- `src/utils/config.ts` (`exitMechanismMode` env)
- `src/init/monitoringLoops.ts` (interval override)
- `scripts/analysis/exit-latency-audit.ts` (신규)
- `docs/audits/exit-latency-YYYY-MM-DD.md` (출력)

### Owner

`igyubin` (CEO)

### Acceptance Criteria

- [ ] migration 배포 → `trades` 테이블에 5 개 신규 컬럼 존재
- [ ] paper 모드 `EXIT_MECHANISM_MODE=hybrid_c5` 로 재기동 후 첫 closeTrade 호출이 에러 없이 성공 + 5 개 컬럼 non-null
- [ ] ≥ 100 paper closed trades 또는 7 일 경과 후 `exit-latency-audit` 첫 실행 → latency 분포 + reverse ratio 분포 출력
- [ ] `docs/audits/exit-latency-*.md` 에 결과 + Phase E2 진행 권장 / 보류 판정 기록

### Lifecycle

- 시작: Phase E0 종결 직후
- 종결 조건: 위 acceptance 4 개 모두 통과 → Phase E2 진입 여부 판정

### Decision Branch (Phase E1 결과 기반)

Phase E1 측정 결과에 따라 다음 분기:

- **E1 결과 A**: paper 에서도 submit-before tick price 가 trigger price 대비 > 2% 분기. 근본은 monitor observation 지연이 아니라 swap latency → Phase E2 (C2 tick-level) 필요
- **E1 결과 B**: paper 에서 gap 이 작고 monitor polling 지연만 문제 → live 에서는 C5 단독으로 충분할 가능성. Phase E3 로 바로 진입 검토
- **E1 결과 C**: paper 에서 유의미 signal 부족 (universe 문제로 n<20) → A2 (universe flow) 선행 필요. 본 plan 일시 대기

---

## Phase E2 — C2 Tick-level Trigger Prototype (paper, 조건부)

### 진입 조건

Phase E1 결과 A 또는 C 에서 universe 회복 후. 그 전에는 진입 금지.

### 목표

tick-level SL/TP trigger 를 paper 모드에서 구현하고 dual-path race condition 을 방어한다.

### Architecture 결정 사항 (plan 작성 시점에 확정해야 할 것들)

이 섹션은 Phase E2 시작 전에 **design doc 으로 별도 정리**해야 한다. 아래는 체크리스트:

#### A. Dual-path partitioning

두 가지 옵션:

1. **Strict partitioning**: tick handler 는 SL/TP1/TP2 만. polling 은 trailing / exhaustion / time stop / degraded 만. 둘이 동일 trade 에 대해 exit 를 트리거할 수 없음
2. **Shared with per-trade lock**: 둘 다 모든 조건 체크 가능. 단 per-trade exit lock (`exitLockMap: Map<tradeId, boolean>`) 으로 직렬화

**선택 기준:** Phase E1 결과에서 trailing/time stop 이 얼마나 자주 trigger 되는지 확인 후. 빈도가 낮으면 option 1, 높으면 option 2.

#### B. Per-trade exit lock (option 2 시)

- `ExecutionLock` 은 현재 **전역 single-slot** ([`executionLock.ts`](../../../src/state/executionLock.ts)). BUY 보호용
- exit 는 trade 별로 독립이어야 하므로 **신규 `TradeExitLock: Map<tradeId, boolean>`** 도입
- acquire/release 패턴 + 타임아웃 + stale cleanup
- `closeTrade` 진입 시 acquire, exit 경로 모두 (full close / TP1 partial / runner partial / degraded) 에서 finally 로 release

#### C. Feature flag 설계

- `EXIT_MECHANISM_MODE` env 에 `tick_c2` 값 추가
- 값: `legacy` | `hybrid_c5` | `tick_c2`
- **부분 활성화 전략**: 한번에 전체가 아니라 **token whitelist** 로 1 개 pair 씩 tick-level 적용 가능하게 (rollback 단위 축소)

#### D. Tick subscription 경로

- `MicroCandleBuilder.on('tick', ({pool, price, timestamp}))` 이 이미 존재 ([`microCandleBuilder.ts:67`](../../../src/realtime/microCandleBuilder.ts))
- 단 현재 subscriber 없음. 신규 `TickExitMonitor` 클래스 도입
- Open trade index: `Map<pairAddress, {tradeId, stopLoss, takeProfit1, takeProfit2}[]>`
- `closeTrade` 후 index 에서 제거, `recordOpenedTrade` 후 index 에 추가

#### E. Paper mode 의 의미

- paper 에선 Jupiter 호출 안 함 → swap latency 없음 → C2 vs C5 차이가 측정 안 됨
- paper 에서 검증 가능한 것:
  - tick handler 가 실제로 발화하는가
  - dual-path race 가 재현되지 않는가 (중복 sell 시도 없음)
  - lock cleanup 이 정상 동작하는가
  - `exit_reason=TP2` 와 `monitor_trigger_price >= takeProfit2` 가 100% 매치하는가 (intent 일관성)
- **swap latency 비교는 Phase E3 live canary 에서만 가능**

### 작업

- [ ] 위 A-E 항목을 담은 **design doc** 작성: `docs/design-docs/tick-exit-mechanism-YYYY-MM-DD.md`
- [ ] `src/orchestration/tickExitMonitor.ts` 신규 클래스
- [ ] `src/state/tradeExitLock.ts` 신규 (option 2 채택 시)
- [ ] `src/orchestration/tradeExecution.ts` 수정:
  - exit 경로마다 `tradeExitLock.acquire(tradeId)` / `release(tradeId)` 삽입
  - `closeTrade` 내부에서 `tickExitMonitor.unregister(tradeId)` 호출
  - `recordOpenedTrade` 내부에서 `tickExitMonitor.register(trade)` 호출
- [ ] `src/init/wireRealtimeBus.ts` (B1 리팩토링 선행 필요) 또는 `src/index.ts` 에서 `realtimeCandleBuilder.on('tick', ...)` 바인딩
- [ ] 테스트 신규:
  - `test/tickExitMonitor.test.ts` — tick 기반 trigger 동작
  - `test/tradeExitLock.test.ts` — concurrent acquire / timeout / stale cleanup
  - `test/tradeExecution.test.ts` 확장 — dual-path race scenario (tick + polling 동시 진입)

### Target Files

- `src/orchestration/tickExitMonitor.ts` (신규)
- `src/state/tradeExitLock.ts` (신규, conditional)
- `src/orchestration/tradeExecution.ts` (수정)
- `src/init/wireRealtimeBus.ts` (B1 리팩토링 후)
- `docs/design-docs/tick-exit-mechanism-YYYY-MM-DD.md` (신규)
- `test/tickExitMonitor.test.ts`, `test/tradeExitLock.test.ts` (신규)

### Owner

`igyubin` (CEO) — implementation. OnchainAnalyst (Paperclip: `62f28d7a`) 후보 — design doc review

### Acceptance Criteria

- [ ] Design doc (A-E 항목) 작성 완료 + 1 회 review
- [ ] `tsc --noEmit` 0 errors / `npx jest` all suites pass (신규 테스트 포함)
- [ ] paper 모드 `EXIT_MECHANISM_MODE=tick_c2` 로 재기동, 24 시간 이상 무사고 운용
- [ ] paper audit: `exit_reason=TP2` rows 의 `monitor_trigger_price >= takeProfit2` 매치율 = 100%
- [ ] dual-path race 테스트 통과 (중복 sell 시도 0 건, lock timeout 0 건)
- [ ] `docs/audits/exit-mechanism-prototype-YYYY-MM-DD.md` 에 결과 기록

### Lifecycle

- 시작: Phase E1 종결 + 결과 분기 A 또는 C + (A2 universe flow 해결 완료 or 병렬 진행)
- 종결 조건: 위 acceptance 6 개 모두 통과 → Phase E3 진입

### Forbidden (Phase E2 scope 안)

- ❌ design doc 없이 코드 작성 시작
- ❌ paper 미통과 상태로 live 전환
- ❌ option 1 / 2 선택을 측정 없이 결정
- ❌ feature flag 없이 legacy 경로 제거

---

## Phase E3 — Live Canary

### 진입 조건

Phase E1 결과 B (C5 단독 충분) 또는 Phase E2 acceptance 전체 통과.

### 목표

선택된 mechanism (C5 또는 C2 또는 둘 다 활성) 을 live 에서 canary 운영하고 실측 gap 감소를 확인한다.

### 작업

- [ ] live VPS 에 `EXIT_MECHANISM_MODE` env 설정 + pm2 재배포
- [ ] **token whitelist 부분 활성화**: 1 개 pair 로 시작해 24 시간 모니터링, 문제 없으면 점진 확대
- [ ] 기본 모니터링 metrics (`ops-history` Entry 로 일별 기록):
  - `exit_reason=TP2` 의 actual TP2 match rate (Phase E0 대비 변화)
  - `monitor_trigger_price → exit_price` reverse ratio p50 / p95
  - `trigger → submit` latency p50 / p95
  - `submit → response` latency p50 / p95
  - `exit_anomaly_reason` 신규 발생 여부
- [ ] `docs/ops-history/YYYY-MM-DD.md` 에 Phase E3 전용 섹션 추가

### Rollback 조건 (자동 또는 수동)

- 첫 24 시간 내 `exit_anomaly_reason` 신규 발생 → 즉시 `EXIT_MECHANISM_MODE=legacy` 로 revert
- 첫 24 시간 내 drawdown > 2 × Phase E0 baseline → rollback + 재분석
- `tradeExitLock` timeout 3 회 이상 → rollback + race condition 재검토
- dual-path 에서 중복 sell 시도 1 회라도 → 즉시 rollback + 중단

### Target Files

- `.env` (VPS)
- `docs/ops-history/YYYY-MM-DD.md` (일별 기록)
- `docs/audits/exit-mechanism-canary-YYYY-MM-DD.md` (최종 결과)

### Owner

`igyubin` (CEO)

### Acceptance Criteria

- [ ] 7 일 연속 live canary 운용 (rollback 없이)
- [ ] `exit_reason=TP2` actual match rate ≥ 30% (Phase E0 의 0% 대비 의미 있는 개선)
- [ ] `monitor_trigger_price → exit_price` reverse ratio p95 ≤ 2%
- [ ] `exit_anomaly_reason` 신규 발생 0 건
- [ ] Phase X1 (live-ops-integrity Phase M) 와 병행하여 post-Phase E clean closed trades ≥ 20 누적

### Lifecycle

- 시작: Phase E2 (또는 E1 결과 B) 종결 직후
- 종결 조건: 위 acceptance 5 개 모두 통과 → Phase E4 진입

### Forbidden (Phase E3 scope 안)

- ❌ token whitelist 생략하고 전체 활성화로 시작
- ❌ 첫 24 시간 안 결과만 보고 "성공" 판정
- ❌ rollback 조건 충족 시 override 계속 진행
- ❌ Phase E3 결과로 `exit-structure-validation` Phase X3 를 skip (둘은 독립)

---

## Phase E4 — Decision Window

### 목표

Phase E3 acceptance 통과 후 7 일 monitoring 으로 mechanism 의 안정성을 확정하고, 영구 baseline 승급 또는 원복을 결정한다.

### 작업

- [ ] Phase E3 종결 후 7 일 연속 daily PnL / max DD / exit reason 분포 추적
- [ ] 동일 기간 `exit-distribution-audit` 재실행 → intent vs actual match rate 추이 확인
- [ ] Phase E3 acceptance metrics 가 7 일 평균에서도 유지되는지 확인
- [ ] 7 일 후 결정:
  - **유지**: `EXIT_MECHANISM_MODE` 의 승자 (C2 또는 C5 또는 조합) 를 `tradingParams.ts` 에 기본값으로 승급. `STRATEGY.md` quick reference 업데이트. legacy 경로는 한 리즈(release) 유지 후 제거 예정으로 표시
  - **원복**: `EXIT_MECHANISM_MODE=legacy` 로 revert + Phase E1 재측정 (하이퍼파라미터 조정 또는 접근 변경)

### Acceptance Criteria

- [ ] 7 일 연속 Phase E3 metrics 유지
- [ ] Risk tier 승급 (Bootstrap → Calibration, trades ≥ 20) 또는 미승급 사유 문서화
- [ ] 유지/원복 결정이 `STRATEGY_NOTES.md` 에 기록됨
- [ ] Phase X3 (exit-structure-validation) 로 handoff 준비 (parameter 튜닝이 이제 가능해지는 상태)

### Lifecycle

- 시작: Phase E3 종결 후
- 종결 조건: 유지 결정 + 승급 완료 → 본 plan `completed/` 로 이동

---

## Relationship Map (다른 active plan 과의 관계)

```
exit-execution-mechanism-2026-04-08.md  (본 plan — MECHANISM)
  │
  ├─ upstream: 1sol-to-100sol.md (상위 mission plan, W1.5 와 병행)
  ├─ upstream: mission-recovery-triage-2026-04-08.md (본 plan 의 trigger)
  │
  ├─ parallel: live-ops-integrity-2026-04-07.md
  │     │
  │     └─ Phase M (7 일 monitoring) = 본 plan 의 Phase E3/E4 와 중첩
  │        → 같은 `ops-history` entry 에서 통합 기록
  │
  └─ downstream: exit-structure-validation-2026-04-08.md (PARAMETER)
        │
        └─ Phase X3 Scenario A/B/C 판정은 본 plan Phase E4 이후에만 의미 있음
           (측정 축이 정합한 상태에서만 orderShape 튜닝 valid)
```

**핵심 원칙:**
- 본 plan 은 **exit-structure-validation** 과 독립이지만 **선행**이다
- parameter 튜닝을 먼저 하면 mechanism 노이즈에 파라미터를 fit 시키게 됨 → 오염된 결정
- mechanism 을 먼저 고치고 → 측정이 정직해지고 → 그 후 parameter 판정

---

## Forbidden (본 plan scope 안)

- ❌ Phase E0 완료 상태에서 design doc / plan 없이 코드 작업 시작
- ❌ Phase E1 건너뛰고 Phase E2 (tick-level) 바로 구현
- ❌ Phase E2 paper 검증 없이 live 활성화
- ❌ Phase E3 token whitelist 없이 전체 live 활성화
- ❌ orderShape 튜닝 (`tp1Multiplier / tp2Multiplier / tp1PartialPct / realtimeSlAtrMultiplier`) — `exit-structure-validation` plan scope
- ❌ trailing / exhaustion / degraded exit 경로 동시 수정 — 범위 외
- ❌ `ExecutionLock` 의 기존 BUY 보호 동작 변경
- ❌ `resolveExitFillOrFakeFill` (Phase E 가드) 의 saturated slippage 임계 변경
- ❌ Phase E 마크가 겹치는데 `exit_anomaly_reason` 가드를 비활성화
- ❌ 측정 < 20 표본 상태로 Phase E3 결과 단정

---

## Out of Scope (본 plan 에서 다루지 않음)

- **Entry execution mechanism** — buy 경로. Phase A3 ratio clamp + entry alignment 로 이미 정합성 확보됨
- **Trailing stop 활성화 시점** — Grade A/B runner. `STRATEGY.md` Current Exit Guards
- **Degraded exit phase mechanism** — sell impact / quote fail 기반. 동작 중이며 본 plan 무관
- **Fake-fill detection 임계 튜닝** — `FAKE_FILL_SLIPPAGE_BPS_THRESHOLD = 9000`. `live-ops-integrity-2026-04-07.md` Phase S
- **Jito bundle 활성화** — MEV 보호 별도. 현재 `useJitoBundles` flag 존재하나 본 plan 무관
- **Universe flow / idle eviction** — `1sol-to-100sol.md` W1.5. **본 plan 과 병렬로 진행 가능**하나 해결 책임은 분리
- **`backtest/engine.ts` exit 경로** — backtest 는 본 plan 의 mechanism 을 simulate 하지 않음. 별도 판단

---

## Current Status Summary

| Phase | Status | Owner | 의존 |
|---|---|---|---|
| E0 — Problem Verification | 🟢 complete | — | — |
| E1 — Measurement + C3/C5 paper | 🔴 pending | igyubin | E0 |
| E2 — C2 tick-level paper | 🔴 pending (조건부) | igyubin | E1 결과 분기 + A2 (선행 또는 병렬) |
| E3 — Live canary | 🔴 pending | igyubin | E1 결과 B 또는 E2 종결 |
| E4 — Decision window | 🔴 pending | igyubin | E3 종결 |

---

## Open Questions

Phase 진행 중 답해야 할 질문들. 지금 답 내지 말 것.

1. Phase E1 paper 에서 측정한 latency 분포가 live 와 얼마나 다를까? (paper 는 swap 호출 없음)
2. C2 option 1 (strict partitioning) vs option 2 (shared with lock) 중 어느 쪽이 trailing 빈도 상 합리적인가?
3. Jupiter Limit Order (C4) 는 조사만 해도 충분한가, 아니면 작은 POC 필요한가?
4. Phase E3 의 "actual TP2 match rate ≥ 30%" 임계는 현실적인가? (Phase E0 0% → 30% 는 의미 있는 개선이지만 달성 가능성은 measurement 후에만 판단)
5. token whitelist 부분 활성화 시 어느 pair 를 첫 canary 로 쓸까? (liquidity 상위 + activity 안정 기준)
6. Phase E4 유지 결정 시 legacy 경로는 얼마나 오래 유지할까? (rollback 대비 vs 코드 부채)

---

## History

- 2026-04-08: 초기 작성. Phase X2 v2 audit (`TP2 intent → actual = 0/10`) finding + `mission-recovery-triage-2026-04-08.md` A1 지시에 따라 생성. Phase E0 complete 로 시작. 상위 mission plan 은 `1sol-to-100sol.md`, parameter 쪽은 `exit-structure-validation-2026-04-08.md`.
