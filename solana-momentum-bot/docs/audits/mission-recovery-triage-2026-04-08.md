# Mission Recovery Triage — 2026-04-08

> Status: analysis / triage directive
> Author: Claude Opus 4.6 analysis session (2026-04-08)
> Purpose: 자체 점검을 거친 실행 리포트. "지금 무엇부터 할 것인가"를 정합니다.
> Relation: 이 문서는 plan 이 아닙니다. plan 생성을 지시하는 triage 문서입니다.
> Upstream: [`../../PLAN.md`](../../PLAN.md), [`../exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md), [`../exec-plans/active/exit-structure-validation-2026-04-08.md`](../exec-plans/active/exit-structure-validation-2026-04-08.md)
> Downstream (to be created): `docs/exec-plans/active/exit-execution-mechanism-2026-04-08.md`

---

## 0. 한 줄 진단

> **현재 sample에서 `TP2 intent → actual fill = 0/10 = 0%` 이다. Runner-centric 사명 경로의 핵심 가정이 측정상 무너져 있고, 이 현상을 다룰 plan 이 아직 존재하지 않는다. 지금 가장 먼저 만들어야 할 것은 코드 변경도 파라미터 튜닝도 아닌 "exit execution mechanism plan" 이다.**

---

## 1. 검증된 현재 상태

| 항목 | 값 | 출처 |
|---|---|---|
| 코드베이스 | 165 TS / 31.2K LOC / 19 modules | `find src -name "*.ts"` |
| 테스트 | 87 suites / `npx jest --listTests` | 로컬 확인 |
| TS build | `tsc --noEmit` 0 errors | [`MEMORY.md`](../../.claude/memory/MEMORY.md 참고) |
| Clean closed trades (post-Phase E) | n=18 (sample-gate 20 미달) | [`exit-structure-validation-2026-04-08.md`](../exec-plans/active/exit-structure-validation-2026-04-08.md) §Phase X2 v2 |
| TP2 intent → actual match | **0/10 = 0%** | 동 문서 |
| Live universe 상태 | candidate 100% idle eviction (Entry 03) | [`1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md) Latest Live Diagnosis |
| Exit execution mechanism plan | **존재하지 않음** (이름만 `STRATEGY_NOTES.md` 에 후보로 기록) | [`../../STRATEGY_NOTES.md`](../../STRATEGY_NOTES.md) 2026-04-08 메모 |

### 거대 파일 (AGENTS.md 200줄 원칙 위반)

| 파일 | LOC | 비고 |
|---|---:|---|
| `src/index.ts` | 1443 | main wiring + runtime bus |
| `src/orchestration/tradeExecution.ts` | 1379 | exit 4 경로 + Phase A3/A4 guards |
| `src/backtest/engine.ts` | 1133 | 주 경로 아님 |
| `src/scanner/scannerEngine.ts` | 787 | discovery 5 source |
| `src/risk/riskManager.ts` | 639 | |
| `src/reporting/runtimeDiagnosticsTracker.ts` | 614 | |

전체 200줄 초과: **52 파일**. 사명 경로 상에서 리팩토링이 필요한 것은 **index.ts + tradeExecution.ts 2개만**.

---

## 2. 우선순위 A — 사명 경로 회복 (코드 변경 전 plan 먼저)

### A1. 🔴 Exit Execution Mechanism Plan 작성 — 지금 즉시

**왜 A1인가:** Phase X2 v2 finding 이 구조적 병목을 노출했지만, 이를 다룰 active plan 이 없습니다. plan 없이 코드부터 건드리면 측정 축이 또 섞입니다 (Phase E 이전 악몽 재발).

**무엇이 일어나는가 (재확인):**

1. `checkOpenPositions()` 5 초 polling 이 `observedHigh >= takeProfit2` 를 감지 ([`tradeExecution.ts:510`](../../src/orchestration/tradeExecution.ts))
2. `closeTrade()` → `executor.executeSell()` → Jupiter swap 호출
3. swap 완료까지 수 초 — 메모코인 가격이 reverse
4. 실제 fill 은 SL 근처에서 체결
5. DB 는 `exit_reason=TAKE_PROFIT_2`, `exit_price=SL_level` 로 기록

**작업:**

- [ ] [`docs/exec-plans/active/exit-execution-mechanism-2026-04-08.md`](../exec-plans/active/exit-execution-mechanism-2026-04-08.md) 생성
- [ ] 문제 정의 (monitor loop → swap latency 동안 price reverse)
- [ ] 해결책 후보 나열 (아래 표)
- [ ] 각 후보의 feasibility / risk / 측정 방법 분리 기술
- [ ] Out of Scope 명시 (trailing, degraded exit mechanism 은 별도)
- [ ] Phase M / Phase X1-X4 와의 관계 명시

**해결책 후보 (plan 문서에 나열할 것, 지금 결정 금지):**

| 후보 | 접근 | 주요 위험 |
|---|---|---|
| **C1. Monitor loop 주기 단축** | 5s → 1s 또는 500ms polling | 단순하지만 근본 해결 아님. swap latency 는 여전 |
| **C2. Tick-level trigger (open-trade-only)** | `MicroCandleBuilder.on('tick')` 구독 + open trade index 로 SL/TP 체크 | dual-path (tick + 5s polling) race condition, 중복 sell 가능. `checkOpenPositions` 안의 9 개 로직 중 SL/TP 만 분리하고 나머지는 여전히 polling |
| **C3. Pre-submit price recheck** | swap 호출 직전 `getCurrentPrice()` 재확인, gap 임계 넘으면 abort | 구현 쉬움. 정상적인 fast fill 도 차단할 위험. 임계 튜닝 필요 |
| **C4. Jupiter Limit Order 연구** | Solana 메모코인 pool 에서 limit order 가 동작 가능한지 | 메모코인 pool 은 대부분 limit 미지원. 조사만 우선 |
| **C5. Hybrid (C3 + C1)** | polling 주기 단축 + submit 전 recheck | 가장 보수적. 측정 먼저, mechanism 은 2 차 |

**권장 plan 구조 (plan 안에서 확정):**

```
Phase E1 (paper): C3 또는 C5 prototype, decision_fill_gap 분포 측정
Phase E2 (paper): C2 prototype (feature flag), dual-path coordination 검증
Phase E3 (live canary): 가장 안전한 조합 선택, 20 trades 모니터링
Phase E4 (decision): Phase X3 가설 분기로 복귀하거나 E2 연장
```

**관련 코드 레퍼런스 (plan 작성 시 참고):**

- `src/orchestration/tradeExecution.ts:428` — `checkOpenPositions` 메인 루프
- `src/realtime/microCandleBuilder.ts:67` — `emit('tick', ...)` 존재 확인 (아직 subscriber 없음)
- `src/orchestration/tradeExecution.ts:621` — `closeTrade` 진입점
- `src/executor/executor.ts:146` — `executeSwap` / Jupiter 경로
- `src/state/executionLock.ts` — 현재 BUY 보호용, exit 경쟁 방어 미포함

---

### A2. 🟡 Universe Flow 회복 (W1.5) — A1 과 병행 가능

**작업 (검증 가능한 것만, 즉시 파라미터 튜닝 금지):**

- [ ] `runtimeDiagnosticsTracker` 에서 `admission_skip:unsupported_dex=21` detail dump. 어느 DEX 가 몇 건인지 분해. 코드 변경 없이 `scripts/ops-check-*` 확장만으로 가능
- [ ] `scanner.discoverFromDexBoosts/Profiles/Ads/CommunityTakeovers` 의 source 별 후보 생산량 카운터 추가 ([`scannerEngine.ts:495-534`](../../src/scanner/scannerEngine.ts)). 어느 source 가 죽어있는지 확인
- [ ] `scannerIdleEvictionMs` 600_000 튜닝은 **데이터 본 후 결정**. 지금 300_000 으로 내리는 것은 근거 불충분
- [ ] `scannerReentryCooldownMs` 완화는 **하지 말 것**. loser pair 재유입 방어 목적 (R3 blacklist). 현재 병목은 idle eviction 이지 reentry 가 아님

**측정 방법:** `ops-history` 1 일 누적. idle eviction count / source 별 discovery count / `admission_skip` breakdown 을 단일 테이블로 정리.

**금지:** `volumeSurgeMultiplier 1.8 → 1.6` 같은 trigger 파라미터 완화. A1 해결 전에는 신호 밀도를 높여도 fill 이 틀린 값에 찍히므로 오염만 증가.

---

### A3. 🟡 Cohort 측정 infra 보강 — A1 이 Phase X2 반복 실행을 요구할 때만

**작업:**

- [ ] `trades` 테이블에 `market_cap_usd_at_signal`, `volume_mcap_ratio_at_signal` 컬럼 추가
  - **이유:** 현재 `signal-intents.jsonl` JOIN 에 의존. Phase X2 를 여러 번 재실행할 예정이면 DB 네이티브가 낫다
  - **영향 파일:** `src/candle/tradeSchema.ts`, `src/candle/tradeStore.ts` (`insertTrade`), `src/orchestration/tradeExecution.ts:843` (`recordOpenedTrade`)
  - **backfill 불필요** — 신규 trade 부터 적용. 기존 trades 는 jsonl JOIN 유지
- [ ] `scripts/analysis/exit-distribution-audit.ts` v2 가 이미 intent vs actual 분리 중. **이 스크립트를 Phase M 일일 리포트 cron 에 편입** (현재는 manual 실행)

**보류 조건:** Phase X2 를 반복 안 할 계획이면 A3 보류. ROI 가 반복 실행 때만 생김.

---

## 3. 우선순위 B — 리팩토링 (A1 을 안전하게 만드는 수준만)

**원칙:** 아름다움을 위한 리팩토링은 사명 달성 후로. 지금은 "A1 작업 시 실수 확률을 낮추는 리팩토링" 만 합니다.

### B1. `src/index.ts` 1443 줄 → wire 계층 분리

**근거:** A1 구현 시 `heliusIngester.on('swap')` + `MicroCandleBuilder` 이벤트 핸들러를 수정해야 하는데, 현재 [`index.ts:1104-1229`](../../src/index.ts) 에 zombie pool cleanup + alias state + trigger 연동 + candle persistence 가 모두 중첩되어 있음. 수정 시 실수 확률 높음.

**작업 (pure move only, behavior 변경 금지):**

- 이미 `src/init/initStores.ts`, `src/init/monitoringLoops.ts` 패턴 시작됨. 확장.
- 후보 신규 파일 (implementation 시점에 design doc 에서 확정):
  - `src/init/wireRealtimeBus.ts` — heliusIngester swap 핸들러 + MicroCandleBuilder 연동 + zombie pool state
  - `src/init/wireScanner.ts` — scanner events + ingester queue
  - `src/runtime/aliasState.ts` — `zombiePoolBlacklist` / `pendingAliasCleanups` / `aliasMissCleanupState` 캡슐화

**금지:** 파일 분리하면서 기존 동작 변경. Phase E 가드들이 작동 중인 상태라 behavior drift 는 즉시 측정 오염.

### B2. `tradeExecution.ts` exit path 공통화 — **보류 권장**

**자체 점검 결과:** 이미 `resolveExitFillOrFakeFill` 로 fake-fill 공통화 완료 (TD-R7). 4 경로의 **잔여분 trade 생성 로직은 경로별로 다름** (TP1 은 `stopLoss=entry, tp1=tp2`, Grade B Runner 는 `tp2*2`, Degraded 는 stop/tp 유지).

**판정:** 추가 통합은 leaky abstraction 위험 → **보류**. A1 구현 시 특정 경로에 tick-level trigger 가 붙으면 그때 국부 리팩토링.

**단, 한 가지는 지금 해도 됨:**

- [ ] `degradedStateMap / runnerStateMap / quoteFailCountMap` exception path cleanup 추가
  - 현재: [`closeTrade` catch 블록](../../src/orchestration/tradeExecution.ts) 이 `failTrade` 만 호출하고 state map 은 정리 안 함
  - 영향: stale key 누적 (bounded — key-exact 조회라 기능 영향 없음, 메모리만 소량)
  - 수정: `closeTrade` catch 블록에 3 개 Map `.delete(trade.id)` 추가
  - **테스트 영향 확인됨:** `test/runnerExtension.test.ts:49`, `test/degradedExit.test.ts:21` 이 module-level export 에 직접 접근. BotContext 이동은 **하지 말 것** (test rewrite 부담 > 이득)

### B3. `risk/` ↔ `reporting/` 순환 의존성 (TD-5) — 보류

Node lazy resolution 으로 동작 중. A1 작업에 직접 영향 없음. [`tech-debt-tracker.md`](../exec-plans/tech-debt-tracker.md) 에 이미 등록. 사명 달성 후 정리.

---

## 4. 보류 — 근거 부족

자체 점검에서 제거된 항목. 데이터가 생기기 전에는 건드리지 않습니다.

| 항목 | 보류 이유 |
|---|---|
| `scannerIdleEvictionMs` 600_000 → 300_000 단축 | A2 의 source breakdown 데이터 본 후 결정 |
| `scannerReentryCooldownMs` 완화 | 현재 병목은 reentry 가 아니라 idle. 완화 시 loser re-entry 위험 |
| `tradingParams.ts:56-64` orderShape 튜닝 | Phase X2 sample-gate (n≥20) 미통과. `exit-structure-validation` plan Forbidden 절 준수 |
| `volumeSurgeMultiplier` 1.8 → 1.6 | A1/A2 해결 전까진 signal density 문제가 trigger 튜닝으로 풀 수 있는 범주인지 판단 불가 |
| `backtest/engine.ts` 1133 줄 리팩토링 | 주 경로 아님, 후순위 |
| `BotContext` 로 module-level Map 이동 | 테스트가 이미 직접 접근 중. 이동 시 test rewrite 부담 > 이득 |
| Strategy D live enable | Jito + sandbox wallet 검증 미완료. W1.5 이후 |

---

## 5. 금지 — 하지 말 것 (명시적으로)

이것들은 "검토 가능" 이 아니라 **금지**입니다. 사명 경로를 또 후퇴시킵니다.

- ❌ **orderShape 직접 변경** — `tp1Multiplier / tp2Multiplier / tp1PartialPct / realtimeSlAtrMultiplier`. Phase X2 gate 통과 전까지 lock ([`exit-structure-validation-2026-04-08.md`](../exec-plans/active/exit-structure-validation-2026-04-08.md) Forbidden 절)
- ❌ **사명 경로 재정의** — "밈코인이 안 되니 다른 전략" 같은 pivot. 현재 문제는 전략이 아니라 mechanism. [`PLAN.md`](../../PLAN.md) Operating Principles P5 위반
- ❌ **archived plan / canary memo 재승격** — [`PLAN.md`](../../PLAN.md) "Do Not" 절
- ❌ **설명 없는 급등 추격으로 전환** — `bypassEdgeBlacklist` 같은 flag 를 프로덕션에 남기지 말 것
- ❌ **force-push / 비가역 destructive git 명령** — 일반 원칙
- ❌ **sample < 20 상태에서 "구조가 틀렸다" 단정** — Phase X2 sample-gate 원칙

---

## 6. 다음 결정 게이트 (순서만 정의, 기간 정의 안 함)

```
Gate G1. A1 plan 작성 완료
  ↓
Gate G2. A2 universe source breakdown 데이터 ≥ 1 일 누적
  ↓
Gate G3. A1 Phase E1 (paper) C3 또는 C5 prototype 구현 + decision_fill_gap 분포 출력
  ↓
Gate G4. A1 Phase E2 (paper) C2 prototype + dual-path race 검증
  ↓
Gate G5. post-Phase E clean closed trades ≥ 20 누적 (Phase X1)
  ↓
Gate G6. Phase X2 v2 audit 재실행 → TP2 actual reach rate 변화 확인
  ↓
Gate G7. 결과가 Scenario A/B/C/D 중 어디에 해당하는지 판정 (exit-structure-validation)
  ↓
Gate G8. Risk tier 승급 기준 (trades ≥ 20 → Calibration) 충족 여부 확인
```

각 게이트 통과 여부는 `ops-history` 에 entry 로 기록. 게이트 실패 시 이전 게이트 재진입.

---

## 7. 사명 경로 재정렬

Risk tier 는 equity 가 아니라 **trade count** 로 결정됩니다 ([`src/reporting/riskTier.ts`](../../src/reporting/riskTier.ts)).

| Tier | Trades | Risk/Trade | Daily | 현재 상태 |
|---|---|---|---|---|
| **Bootstrap** | `<20` | 1% | 5% | **현재 위치** (post-Phase E clean n=18) |
| Calibration | `20-49` | 1% | 5% | Gate G8 목표 |
| Confirmed | `50-99` | Kelly cap 3% | 15% | 복리 시작 |
| Proven | `100+` | Kelly cap 5% | 15% | 확장 |

**사명 경로의 역설:** tier 승급은 거의 전적으로 "clean closed trades 누적" 에 의존하고, 그게 지금 **A1 (exit mechanism)** 과 **A2 (universe flow)** 때문에 안 쌓이고 있습니다. 즉:

> `1 SOL → 100 SOL` = `A1 + A2 해결 → 표본 누적 → Calibration 승급 → 복리`

전략 추가도 파라미터 튜닝도 이 경로 위에는 없습니다.

---

## 8. 이 문서의 한계 (자체 인정)

- **C2 (tick-level trigger) 의 dual-path race 복잡도** 는 실제 구현 전까지 풀 느낌이 안 옵니다. plan 작성 시 race condition 시나리오를 먼저 그려본 후 feasibility 재평가 필요
- **A3 의 cohort 컬럼 추가** 는 ROI 가 즉시 증명되진 않음. Phase X2 를 반복 실행할 때만 가치 있음. 반복 안 할 거면 보류
- **A2 universe flow 개선** 이 A1 없이도 가치 있는지 불명확. universe 가 흘러도 exit mechanism 이 깨져 있으면 50 canary 표본이 여전히 오염됨. 두 작업의 선후 관계는 `ops-history` 데이터 누적 후 재판정
- **본 triage 는 단일 분석 세션 산출물**. 실행 전 최소 1 회 재검토 권장

---

## 9. 한 줄 요약

> **지금 쓸 한 문장의 코드도, 먼저 `exit-execution-mechanism-2026-04-08.md` plan 한 장 없이는 쓰지 마라. 그게 가장 빠른 길이다.**

---

## History

- 2026-04-08: 초기 작성. Claude Opus 4.6 codebase analysis 세션 산출물을 자체 점검 후 오류 제거 (risk tier equity-mapping, test count, tick-level "작은 변경" 과소평가, 시간 추정) 하여 정리. 상위 연결: [`1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md), [`exit-structure-validation-2026-04-08.md`](../exec-plans/active/exit-structure-validation-2026-04-08.md), [`../../STRATEGY_NOTES.md`](../../STRATEGY_NOTES.md) 2026-04-08 메모.
