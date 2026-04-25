# INCIDENT / BACKLOG Log

> 운영 중 발견된 이슈·병목·미완 과제의 연대기 기록.
> Authority: `docs/design-docs/mission-refinement-2026-04-21.md` 기준으로 우선순위 판정.
> 이 문서는 **사실 기록**이다 — 판단 근거 / 관측 데이터 / 미해결 gap 이 모두 남아야 한다.

---

## 2026-04-23 — Option 5 채택 (KOL Discovery + 자체 Execution)

사명 §2.3 "5x+ winner 분포 실측" 이 현 pure_ws paradigm 으로 **구조적 불가** 확정. 운영자 판단으로 **전략 전면 교체** 결정.

### 관측 근거 (2026-04-22 12h + 7d ledger)
- V2 PASS 3180 / 고유 pair 2 / survival 통과율 2%
- `deltaPct p50 = −92%` (missed-alpha.jsonl, 53 records) — signal price bug 또는 dead pool 지표
- pure_ws 7d 83 trades / net 5x+ = **0**
- ASTEROID / MAGA / BELIEF / BULL 등 시장 기회 V2 PASS 0건 (detection 구조적 miss)

### 결정 (옵션 5 B형)
- **KOL Wallet Activity = 1st-class Discovery Trigger** (Scanner 우회)
- **Execution state machine 구조는 유지**하되 **Lane T (kol_hunter) 파라미터 재조정**
- **Real Asset Guard 전부 불변** (ticket 0.01 / floor 0.8 / canary -0.3 / drift halt / survival)
- **cupsey_flip_10s 동결** (benchmark), **pure_ws 는 Lane S (scalping baseline)** 로 존속
- 거절: KOL Signal Layer v1.0 §4.1 (Scanner 뒤 5번째 Gate 방식)
- 거절: 옵션 4 (full-stack 재설계) — Phase 3 성공 후 확장 여지만 남김

### 문서화 (3 분리 구조)

| 문서 | 경로 | 성격 |
|------|------|------|
| **ADR** (영구 결정 근거) | `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md` | 결정 본문 수정 금지 |
| **Debate** (대담 기록) | `docs/debates/kol-discovery-debate-2026-04-23.md` | append-only, Phase 2 결과 Round 2 추가 예정 |
| **Refactoring** (실행) | `REFACTORING_v1.0.md` | Phase 0-5 checkbox, paradigm 교체 시 v2.0 |

### Phase Roadmap
- Phase 0 (1-2일): KOL DB 정제 (50-80 wallet)
- Phase 1 (1주): KOL Wallet Tracker + passive logging
- Phase 2 (1주): Shadow Eval → **go/no-go first filter**
- Phase 3 (2주): kol_hunter paper lane
- Phase 4 (2주): Live canary 50 trades
- Phase 5 (4주): Live 200 → Stage 4 gate

### Go/No-go Gates (ADR §6)
- **Gate 1 (Phase 2)**: KOL 진입 후 T+5min/+30min median > 0 AND multi-KOL median > single-KOL AND active KOL ≥ 70% AND KOL avg hold ≥ 10분
- **Gate 2 (Phase 3)**: Paper net 5x+ ≥ 1건 OR T2 visit ≥ 2건
- **Gate 3 (Phase 4)**: Live net 5x+ OR T2 visit ≥ 1건
- **Gate 4 (Phase 5)**: mission-refinement §5 Stage 4 SCALE / RETIRE / HOLD

### 기존 backlog supersede
- 기존 Decision Fork Path A/B/C/D (`LANE_20260422.md §8`) → 본 결정으로 대체
- `20260423.md` Trending-gated scalping → Lane S (pure_ws) 로 격하, 살아있음
- Task #13 (사명 재해석) → **옵션 C (hybrid)** 로 해결: Lane S = positive growth / Lane T = 5x+ winner

### 변경 파일 (신규 3개)
- `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`
- `docs/debates/kol-discovery-debate-2026-04-23.md`
- `REFACTORING_v1.0.md`

---

## 2026-04-22 (저녁, ralph-loop sprint 완료)

본 loop 에서 P0-3 follow-up / P1-1 / P1-2 / P2-1b / P2-4 총 5건 처리.

| 항목 | 상태 | 구현 | 테스트 | 검증 |
|------|------|------|--------|------|
| P0-3 follow-up | ✅ 완료 | `.gitignore` 자동 cover 확인 + `docs/exec-plans/active/1sol-to-100sol.md` Phase O3 Stage 2 observability 체크리스트 등재 + `MEMORY.md` index + `project_missed_alpha_observer_2026_04_22.md` 신규 | N/A | grep 확인 |
| P1-1 Jupiter 429 metric | ✅ 완료 | `src/observability/jupiterRateLimitMetric.ts` 신규 + 3 site hook (entryDriftGuard / sellQuoteProbe / missedAlphaObserver) + `src/index.ts` bootstrap 5분 summary loop | `test/jupiterRateLimitMetric.test.ts` 4 case | tsc clean, 37 pass |
| P1-2 Stage gate 자동화 조사 | ✅ 완료 (Partial) | 조사 결과 INCIDENT 반영 — Stage 4 halt trigger 만 존재. 5개 부재 항목 명시 | N/A | — |
| P2-1b close-site observer | ✅ 완료 | `RejectCategory` 5개 확장 (probe_hard_cut / probe_reject_timeout / probe_flat_cut / quick_reject_classifier_exit / hold_phase_sentinel_degraded_exit) + `trackPureWsClose` helper + 5 close site hook | 1 신규 case | 10/10 pass |
| P2-4 MFE peak ledger | ✅ 완료 | `PureWsPosition` 에 `t1VisitAtSec/t2VisitAtSec/t3VisitAtSec` 추가 + 3 promotion site 기록 + sell ledger `mfePctPeak/peakPrice/troughPrice/marketReferencePrice/visit timestamps/closeState` 추가 + `canary-eval.ts` `winners5xByVisit` / `winners10xByVisit` 집계 | canary-eval 회귀 0 | 62 pass |

### 전체 검증
- `npx tsc --noEmit` — clean
- 전체 jest: **890 pass / 1 pre-existing fail** (`riskManager.test.ts:130` — main branch 동일 실패, 무관)

### 남은 항목 (별도 sprint 필요)
- **P0-1 Signal Price Bug Tier C root cause sprint** — 1-2일 규모, 별도 진단 필요 (pool stale / multi-pool / decimals mismatch 판별)
- **P0-2 Detection Diversity 판정** — P0-3 observer 1주일 데이터 축적 후 결정
- **P2-0 Layer 3 V2 reverse quote factor 실 Jupiter probe** — P0-1 해결 이후 착수
- **P2-2 Hold-Phase Sentinel reverse quote** — Stage 3 진입 시 필요
- **P2-3 Equity Delta / Lane Net PnL 분해** — Stage 2 중반
- **P1-3 Wallet Delta Comparator 실 샘플 축적** — 종속적 (P0 해결 후 자동)
- **P1-4 Survival Tier B-2/3/4** — Stage 2 진입 후 재평가
- **Decision Fork Path A/B/C/D 선택** — Observer 데이터 1-2주 축적 후 사람 판단
- **Stage gate 자동화 5개 부재 항목 구현** — 1일 규모 별도 sprint (walletDeltaComparator.stage1PassCheck, survival pass rate aggregator, 5x+ winner notifier, daily stage report, Stage 3/4 progression alert)

---

## 2026-04-22 (오후, LANE_20260422.md 대조 addendum)

### 프레이밍 정정 — "Trade 누적 0" 은 9h slice 만의 상태

앞 섹션에서 binding constraint 를 "trade 가 안 쌓이는 상태" 로 규정했으나, `LANE_20260422.md` 의 7일 ledger (2026-04-16 → 04-22) 는 다른 그림을 보여준다.

| Lane | closed | net SOL | maxDD | winners5x (net) | winners10x (net) |
|------|--------|---------|-------|-----------------|------------------|
| `cupsey_flip_10s` | 44 | -0.0180 | 8.41% | **1** | 0 |
| `pure_ws_breakout` | 83 | -0.0231 | 3.06% | **0** | 0 |
| **누적** | **127** | -0.0411 | — | 1 | 0 |

- 7일 누적 127 trades. 9h 관측에서 0 이었던 건 **detection 일시 침체 구간**이지, 구조적 trade 고갈 아님.
- **진짜 binding constraint 는 "trade 가 쌓이고 있지만 winner distribution 이 구조적으로 부족함"** — 사명의 3 bullet 중 `200 trades` 는 진행 중이지만 `5x+ winner 분포` 에서 실측 0 (pure_ws).

### 측정 gap 추가 (P2-4 신설)

**P2-4. MFE peak 미기록 — T2/T3 visit 빈도 미측정**
- **사실**: `scripts/canary-eval.ts` 의 `winners5x` 는 **net return ≥ +400%** 기준. T2 visit (MFE ≥ +400%) 이 있었어도 15% trail 로 net 325% 에서 close 하면 `winners5x=0`.
- **영향**: pure_ws "net 5x+ = 0" 을 "T2 visit = 0" 으로 단정 불가. 실제로는 T2 방문했으나 trail 로 반납했을 가능성 존재 — 현재 ledger 로 구분 불가.
- **작업**: trade ledger 에 `mfePeak`, `t1VisitAt`, `t2VisitAt`, `t3VisitAt` 필드 추가. Stage 3 "5x+ winner 분포 관측" 의 기본 metric.
- **우선순위**: P2 (Stage 2 중반 필요). P0-3 와 별도 — observer 는 reject-side, 이건 entry-side MFE 궤적.

### 구조 진단 보강

#### pure_ws 는 설계 convex / 실측 flip-cutter
- 설계: T3 no-time-stop + T2 entry×3 lock + T3 trail 25% → convex tail
- 실측: 83 trade 중 `REJECT_TIMEOUT` 82%. T1 (+100%) 도달 전 대량 cut
- 원인: 5-gate chain 이 T1 도달을 차단
  1. PROBE window 30s (Phase 2 consolidation 의 Phase 30s~3min 범위를 flat 으로 오판)
  2. PROBE hardcut MAE ≤ -3%
  3. PROBE flat band ±10% + 30s 만료 close
  4. quickRejectClassifier 45s, 2+ factor degraded exit
  5. holdPhaseSentinel 3 factor 2+ → DEGRADED_EXIT

→ 이전 `INCIDENT.md` 의 P2-1 은 "probe window" 만 지적했으나, **실제 structural miss 는 5-gate chain 전체의 조합** — P2-1 확장 필요.

#### cupsey 는 설계부터 tail 전략 아님 (버그 아님)
- `PLAN.md:74-78 — P5. Cupsey Is the Benchmark, Not the Target` 에 "건드리지 않는 A/B baseline" 으로 동결
- WINNER 기준 MFE +2% / time stop 12min / trail 4% → 의도된 scalp
- 44 trade 중 1건 net 5x+ (2.3%) 는 예외적 포획이지 convexity lane 근거 아님
- → P3 (방어 완료, 변경 금지) 에 "cupsey 역할 정의" 명시적 추가

### P2-1b 구체화 — close-site 5 카테고리 명시

이전 문서에 "close site 훅 추가" 만 적었으나 `LANE_20260422.md §6.1` 에 구체 카테고리 5개 명시됨:

| category (신설) | 발생 조건 | pure_ws 에서 비중 |
|-----------------|-----------|-------------------|
| `probe_reject_timeout` | PROBE 30s 만료 후 flat cut | 다수 (REJECT_TIMEOUT 82%) |
| `probe_hard_cut` | MAE ≤ -3% | — |
| `probe_flat_cut` | ±10% band 이탈 | — |
| `quick_reject_classifier_exit` | 45s 2+ factor degraded | — |
| `hold_phase_sentinel_degraded_exit` | T1/T2/T3 중 3 factor 2+ | — |

→ 이 5 카테고리 확장이 Phase 3 miss 가설 (consolidation→breakout) 의 정량 평가 조건. **예상 작업 1-2h**. Stage 1 원칙과 충돌 없음 (observability 확장).

### Stage 2 진입 전 Decision Fork — 4개 Path

`LANE_20260422.md §8` 에서 제시된 4-way 선택지. **현재 미결정**, 관측 축적 후 판단 필요.

| Path | 내용 | 작업량 | 리스크 | 권장도 |
|------|------|--------|--------|--------|
| A. pure_ws 재설계 (same lane) | PROBE 2-5min 확장 + quickReject 완화 + T0 consolidation phase | 2-3일 | 근거 없이 확장 시 bleed 폭증 → 0.8 floor 위협 | 관측 후 |
| B. 별도 long-horizon lane 신설 (`trend_hold_30min`) | pure_ws 유지 + 신규 독립 상태기계 | 3-5일 | 초기 paper-first 필수 | **설계적으로 안전** |
| C. LP sniper 복구 (`new_lp_sniper`) | LP 생성 직후 Phase 0 snipe | 5-7일 | Rug risk 극대, Tier B-2/3/4 완성 전 금지 | Tier B 완료 전 금지 |
| D. 기다림 (관측 우선) | Observer 1-2주 분포 수집 → 근거 기반 선택 | 0일 | bleed 지속 (현 속도 10-14일 추가) | **default** |

**권장 순서** (LANE 문서 의견):
1. **즉시**: P2-1b Observer 확장 (5 카테고리). 1-2h.
2. **1 주일 Path D**. p90 ≥ +50% 이면 Path A/B 우선순위 상승.
3. **Path B > Path A** (cupsey 개조 금지 원칙과 충돌 없음, 신설은 허용).
4. **Path C 는 Tier B-2/3/4 완성 이후**.

### Do Not 보강

- ❌ pure_ws `winners5x=0` 을 "T2 visit=0" 으로 단정 — MFE peak 로그 없이는 구분 불가 (P2-4)
- ❌ cupsey_flip_10s 를 "tail 이 아니라서" 튜닝 — benchmark 역할 소실
- ❌ pure_ws PROBE window 확장 (Observer 5-카테고리 데이터 없이)
- ❌ cupsey handler 복사로 새 lane 생성 (`PLAN.md` 명시)
- ❌ Path C (LP sniper) 를 Tier B-2/3/4 완성 전 착수 (rug risk)

### Backlog lane portfolio snapshot (LANE §7 에서 인용)

| Lane | 상태 | 사명 적합성 |
|------|------|-------------|
| `cupsey_flip_10s` | live, 동결 | benchmark (의도대로) |
| `bootstrap_10s` | signal-only | N/A (억제됨, `executionRrReject=99.0`) |
| `pure_ws_breakout` | live, opt-in | 설계 convex / 실측 flip-cutter |
| `migration_reclaim` | backlog code only | paper 대기 |
| `liquidity_shock_reclaim` | 미구현 | — |
| `new_lp_sniper` (Strategy D) | sandbox, executor 미완 | tail 후보 가능 / rug risk |
| `core_momentum` | standby | — |
| `volume_spike` / `fib_pullback` | dormant | 밈코인 비적합 (04-05 확정) |

→ 현재 live lane 중 **사명 ("5x+ winner 실측") 을 구조적으로 겨냥하는 lane 은 pure_ws 유일**. 다른 lane 은 benchmark / 억제 / backlog.

---

## 2026-04-22 (오전) — 9h 운영 관측 + 사명 기준 백로그 재정렬

### 관측된 사실 (UTC 2026-04-22 04:00 → 13:13, uptime 563m)

| 항목 | 값 |
|------|-----|
| Process | restart 03:47 UTC, 9h 무중단 |
| Real Asset Guard | `walletFloor=0.8 canaryLossCap=-0.3 canaryMaxTrades=200 maxConcurrent=3 ticketSol=0.01 mode=live_canary` — 코드 default 와 정책값 일치 |
| Wallet | `0.9972 SOL` — floor 0.8 무위반 |
| Positions / Daily PnL | 0 / 0 |
| Live trade 시도 | 1회 (07:36, pippin, Jupiter 429 × 3 → abort) |
| PUREWS_V2 누적 | scans=1,399,496 / eval=20,278,928 / PASS=9 / **고유 pair=2** (pippin, AV2okTBJG1rr) |
| PUREWS_SURVIVAL_REJECT | 7회 — AV2okTBJG1rr `Top 10 holders 99.8%, TOKEN_2022` |
| PUREWS_ENTRY_DRIFT_REJECT | 33회 — 전부 `signal price bug / pool stale 의심` 태그. pippin 27회 (drift ≈ −92%), 8WFLEGsNYVEk 6회 (drift **−93% → −97% 악화**) |
| Jupiter 429 | 9h 중 45 mention, 07:36 에 집중 cluster |
| Helius WS subscriptions | 4-19 범위 안정, reconnect event 0 (2026-04-21 churn fix 유지 중) |
| WalletDeltaComparator | 5분 주기 `observed=0 expected=0 drift=0` — trade 0 상태라 trivial pass |

### Daily 4 질문 답변 (mission-refinement §7)

1. Wallet drift: 허용 내 (trade 0 → 무의미)
2. Survival filter pass rate: 분모 2 pair 로 유의미 측정 불가
3. Trade count progress: **0 / 200**
4. Bleed per probe: N/A (probe 0)

### 진단: Binding constraint

> **"Trade 가 안 쌓이는 상태"** 가 유일한 병목.
> 방어선 (Real Asset Guard / Survival / Drift / WS) 은 정상. 문제는 **detection → entry pipeline 의 해상도와 관측 장비**.

---

## 백로그 (2026-04-22 시점, 사명 기준 우선순위)

**사명**: `0.8 SOL floor 유지 + 200 live trades + 5x+ winner 분포 실측`.
우선순위는 이 3개 기준 중 어느 것을 가로막는가로 매김.

### 🟥 P0 — 200 trades 누적 경로의 병목

#### P0-1. Signal Price Bug — Tier C root cause sprint
- **관측**: drift reject 33회 / 9h, pippin 고정 −92%, 8WFLEGsNYVEk 악화 추세
- **영향**: 주요 pair 2개 전부 entry 불가 → trade count 0 고착
- **설계 문서**: `docs/design-docs/signal-price-bug-investigation-2026-04-22.md`
- **3 후보**: (a) pool stale / (b) multi-pool routing mismatch / (c) decimals mismatch
- **예상 규모**: 1-2일 sprint
- **의존**: P0-3 데이터로 bug 판별 교차검증 가능

#### P0-2. Detection Diversity 붕괴
- **관측**: V2 PASS 9 / 고유 pair 2 / 9h
- **영향**: Stage 1 "survival pass rate ≥ 90%" 측정 분모 부족
- **원칙**: **Stage 1 "튜닝 금지"** — threshold 건드리지 말 것
- **후속**: P0-3 데이터 + Layer 3 reverse quote factor 구현 (F2, P2-0) 이후 판정

#### P0-3. Missed Alpha Observer — 구현 완료 (follow-up 필요)
- **상태**: `src/observability/missedAlphaObserver.ts` + 4개 reject site 훅 + 9 테스트 통과 + tsc clean (2026-04-22)
- **출력**: `data/realtime/missed-alpha.jsonl`
- **범위 제한 (F1)**: **reject-side only**. `pureWsBreakoutHandler` 의 4개 reject site (survival / viability / entry_drift / sell_quote_probe) 에만 훅 → entry 후 close 된 pair 의 post-close trajectory 는 **미포함**
- **Follow-up (F3)**:
  - `.gitignore` 에서 `data/realtime/missed-alpha.jsonl` ignore 여부 확인
  - `docs/exec-plans/active/1sol-to-100sol.md` Stage 2 observability 체크리스트에 등재
  - `MEMORY.md` 에 `project_missed_alpha_observer_2026_04_22.md` 엔트리 추가
  - VPS 배포 후 파일 생성 확인

### 🟧 P1 — 0.8 SOL floor 방어선 관측 해상도

#### P1-1. Jupiter 429 counter metric
- **관측**: 9h 중 45 mention, 07:36 에 quote / drift / sellProbe / swap retry 전부 429 → 유일 live buy 전멸
- **영향**: "signal→entry 체결률" metric 부재로 silent loss 추적 불가
- **작업**: 429 카운터 + 시도 대비 성사율 metric 추가 — 반나절. rate-limit budget 조정은 데이터 후.

#### P1-2. Stage gate checkpoint 자동화 — 조사 완료 (Partial)
- **조사 결과 (2026-04-22)**:
  - `src/risk/canaryAutoHalt.ts` — Stage 4 trigger (200 trades / consec loss 8 / budget 0.3 SOL) 자동 halt ✓
  - `src/risk/walletDeltaComparator.ts` — drift 5분 주기 계산. Stage 1 pass trigger 없음 ✗
  - `scripts/canary-eval.ts` — 50/100 trades PROMOTE/CONTINUE/DEMOTE 판정. **수동 스크립트 only** ✗
  - `src/utils/healthMonitor.ts` — wallet/uptime만, Stage 정보 미포함 ✗
  - Telegram stage-level notification 부재 ✗
- **부재 항목 5개**:
  1. `drift < 0.01 SOL / 48h` 자동 판정 (로그만 있고 pass 판정 미구현)
  2. `survival filter pass rate ≥ 90%` aggregator (개별 pass/fail 만, 누적 % 없음)
  3. `5x+ winner ≥ 1건` runtime notifier (canary-eval 수동 실행 필요)
  4. Daily/scheduled stage checkpoint 리포트 (healthMonitor 확장)
  5. Stage 3/4 progression 자동 로그 + Telegram 알림
- **작업 예상**: 각 1-2h × 5개 = **총 1일 내외**. 가장 먼저 `walletDeltaComparator.stage1PassCheck()` + survival aggregator 2건이 사명과 가까움.

#### P1-3. Wallet Delta Comparator 실제 샘플 축적
- **현재**: 9h 전부 `observed=0 expected=0` (trade 0 상태)
- **종속**: P0 해결 후 자동 의미화

#### P1-4. Survival Layer Tier B-2/3/4
- **상태**: 설계 완료 (`docs/design-docs/survival-layer-tier-b-2026-04-21.md`), Tier A + B-1 완료. B-2 (LP lock) / B-3 (bundler cluster) / B-4 (dev wallet DB) 미착수
- **영향**: 현재 trade 0 → rug 위험 노출 없음 → **binding constraint 아님**
- **작업**: Stage 2 진입 후 재평가

### 🟨 P2 — 5x+ Winner Distribution 측정 해상도

#### P2-0. Layer 3 V2 reverse quote factor placeholder (F2)
- **사실**: `mission-refinement §4 Layer 3` — V2 detector score 5 factor 중 reverse quote = placeholder 1.0 (`wsBurstDetector`)
- **영향**: P0-2 "detector 가 over/under-selective 인지" 판정에 교란 변수. 실 Jupiter probe 로 교체해야 detector 건강 상태 해석 가능
- **Ordering**: P0-1 해결 이후, P0-2 판정 직전

#### P2-1. Phase 3 Winner Blind Spot — reject-side 절반만 해결 (F1)
- **가설**: probe window 30s 가 Phase 2 consolidation 을 burst 실패로 오판 → Phase 3 breakout 미포획
- **현재 상태**: P0-3 로 reject → 미체결 pair 의 post-trajectory 는 측정 가능. **entry → close 된 pair 의 post-close trajectory 는 여전히 blind**
- **P2-1b — close-site observer 확장**: `pureWsBreakoutHandler` 의 close site (PROBE_TRAIL / LOSER_TIMEOUT / LOSER_HARDCUT / T1_TRAIL / T2_TRAIL / T3_TRAIL) 에 대칭 훅 추가. category `exit_close` 신설. 반나절 예상

#### P2-2. Hold-Phase Sentinel reverse quote placeholder
- **근거**: `src/risk/holdPhaseSentinel.ts:8` "실 reverse quote 는 Phase 4 후보" 주석
- **영향**: winner 보호 3 factor 중 1개 dummy. 현재 winner 포획 0 → 무관. Stage 3 진입 시 필요

#### P2-3. Equity Delta / Lane Net PnL 분해
- **근거**: `mission-refinement §4 Layer 2` "equity delta / lane 별 net pnl — 미완"
- **종속**: trade 축적 후 의미화 (Stage 2 중반)

### 🟩 P3 — 방어 완료 항목 (유지, 변경 금지)

| 항목 | 검증 근거 |
|------|-----------|
| Real Asset Guard 정책값 | `[REAL_ASSET_GUARD]` 로그 매칭 |
| Survival Tier A (top-holder / Token-2022) | 2026-04-22 9h 에서 AV2okTBJG1rr 7회 정확 reject |
| Entry Drift Guard mitigation | pippin / 8WFLEGsNYVEk 33회 reject, 자본 손실 0 |
| Helius WS churn fix | reconnect event 0 / 9h |
| Canary auto-reset | 2026-04-21 18:15 자동 해제 1회 관측 |
| Ticket policy hard lock | 0.01 SOL 고정 유지 |

---

## 실행 순서 (이번 주 기준)

1. **P0-3 observer follow-up** (F3) — `.gitignore` + exec-plan + MEMORY.md. 30분.
2. **P2-1b close-site observer 확장** (F1) — reject-side 대칭. 반나절.
3. **P0-1 Signal Price Bug Tier C sprint** — 1-2일.
4. **P1-1 Jupiter 429 counter metric** — 반나절.
5. **P1-2 Stage gate 자동화 여부 조사** (F4) — 먼저 조사.
6. **P2-0 Layer 3 reverse quote factor 구현** — P0-1 해결 후, P0-2 판정 직전.

**1-2주 후 (데이터 축적 경과)**:
- P0-3 수확: `deltaPct` 분포 p50/p90/p95, `rejectCategory` 별 구분
- P0-1 해결 후 drift guard 재평가
- P0-2 판정: detector vs 시장 구분

**Stage 2 진입 이후**:
- P1-4 Survival Tier B-2/3/4
- P2-1 close-site observer 데이터로 Phase 3 miss 검증 → probe window 재설계 판단
- P2-3 Equity delta / lane pnl 분해

---

## 금지 사항 (mission-refinement §2.2 / §3 근거)

- ❌ V2 threshold / vol_floor / buy_floor 완화 (P0-3 데이터 없이)
- ❌ probe window 30s 확장 (P2-1b 데이터 없이)
- ❌ ticket size 0.01 SOL 조정 (Stage 4 gate 도달 전까지)
- ❌ Real Asset Guard 어떤 항목도 완화
- ❌ "오늘 수익률" / "언제 100 SOL" 식 판단 (mission-refinement §7)

---

## 자체 QA 이력

### 2026-04-22 (이 문서 작성 시) — 이전 요약 self-check 4 finding

- **F1**: P0-3 observer 가 P2-1 을 완전 해결한다는 주장이 **reject-side only** 임을 간과. P2-1b 분리 필요. ✅ 반영됨
- **F2**: P0-2 판정 시 Layer 3 reverse quote factor placeholder 가 교란변수. P2-0 별도 항목. ✅ 반영됨
- **F3**: P0-3 follow-up (gitignore / exec-plan / MEMORY) 누락. ✅ 반영됨
- **F4**: Stage gate checkpoint 자동화 여부 미확인. P1-2 조사 필요. ✅ 반영됨

### 정확했던 항목 (검증 근거 남김)

| 주장 | 근거 |
|------|------|
| probe window 30s | `pureWsBreakoutHandler.ts:739,781,1270,1328` `config.pureWsProbeWindowSec` |
| Survival Tier A+B-1 완료, B-2~B-4 설계만 | `docs/design-docs/survival-layer-tier-b-2026-04-21.md:17` |
| 9h 수치 (trade=0 / wallet=0.9972 / reject 7+33 등) | 직접 로그 추출 |
| 금지 항목 4개 | mission-refinement §2.2 / §3 매칭 |
