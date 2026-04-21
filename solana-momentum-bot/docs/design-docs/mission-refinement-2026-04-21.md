# Mission Refinement — Tail Outcome vs KPI

> Status: decision record (extends `mission-pivot-2026-04-18.md`)
> Date: 2026-04-21
> Does NOT supersede the 2026-04-18 pivot — **refines it by closing remaining ambiguity**.
> Authority precedence: `mission-refinement-2026-04-21.md` > `mission-pivot-2026-04-18.md` > PLAN/PROJECT/MEASUREMENT/STRATEGY.

## 1. Why This Refinement

2026-04-18 pivot 은 "explainability → convexity" 로 목표 함수를 바꿨다. 그 후 7일 간 구현 (Block 0-4, DEX_TRADE Phase 1-3, P0/P1/P2 fix 반복) 은 전부 이 방향을 실현하는 infra 였다. 그러나 운영 현장 (VPS 로그, Telegram 알림, 대시보드) 에서는 **두 개의 모순된 언어가 공존**했다.

| 언어 A (2026-04-18 pivot, 문서) | 언어 B (legacy KPI, 운영 실무) |
|-------------------------------|-----------------------------|
| 100 SOL 은 **tail outcome** | "주간 몇 %?" / "언제 도달?" |
| "죽지 않으면서 winner 기다리기" | consecutive 4 loser → halt → 수동 개입 |
| wallet truth 만 판정 | DB pnl 기반 일일 점검 |
| paper-first, **실험 자본** | 24h 손익 내지 못하면 "문제" |

지난 7일 간 fix 한 것들 (`orphan close` / `drift guard` / `dual tracker` / `V2 telemetry` / `v1 cooldown` / `canary auto-reset`) 은 전부 **언어 A 를 실현하기 위해 언어 B 의 잔재를 제거한 작업**이었다.

본 문서는 그 제거 작업에 **명시적 도장**을 찍는다.

## 2. What This Refinement Says

### 2.1 한 문장 재정의

> **1 SOL → 100 SOL 은 기대 가능한 계획이 아니다. 낮은 확률의 convex tail outcome 이다.**
> **우리가 만들 수 있는 것은 그 outcome 을 잡을 확률을 높이되, 그 전까지 wallet 이 죽지 않게 하는 시스템이다.**

이 문장이 모든 판단의 상위 기준이다. 이후 모든 문서는 이 문장과 충돌하면 안 된다.

### 2.2 멘탈 모델 전환

기존 멘탈 모델 (**금지**):

- "좋은 자동매매 전략 하나를 만들면 안정적으로 1 SOL 이 100 SOL 된다."
- "매주 X% 수익이 목표다."
- "오늘 왜 수익이 안 나지?"

새 멘탈 모델 (**채택**):

- "작은 자본으로 tail winner 를 잡을 수 있는 실험 시스템을 만들고, wallet 기준으로 살아남는지 본다."
- "100 SOL 은 dashboard 의 맨 아래 '관찰' 항목이다. 운영 판단에 쓰이지 않는다."
- "오늘 wallet 이 drawdown 허용 범위 안에 있었는가? Safety layer 를 통과한 pair 수가 얼마인가?"

### 2.3 성공 기준 재정의

**낡은 정의**: "1 SOL → 100 SOL 달성"

**새 정의** (이것이 성공):

> **0.8 SOL floor 를 깨지 않고 200 live trades 를 통과하며, 5x+ winner 분포를 실측했다.**

그 이후 tail outcome (10x / 50x / 100x) 은 운이다. 실패해도 학습이다.

이 재정의에 따라, 100 SOL 달성 여부와 무관하게 프로젝트는 **기술적 성공** 할 수 있다.

## 3. Real Asset Guard vs Observability Guard

모든 guard/threshold/halt 조건을 2범주로 분류한다. 각 범주에 대한 운영 태도가 다르다.

### Real Asset Guard (타협 불가)

실제 자산을 보호한다. 발동 시 운영자 개입 필요. **정책값은 문서와 코드 default 가 반드시 일치** — 시작 시 `[REAL_ASSET_GUARD]` 로그로 effective 값 확인.

| Guard | 정책값 | 코드 default | env override | 역할 |
|-------|--------|--------------|--------------|------|
| Wallet Stop | `wallet_sol < 0.8` | `walletStopMinSol=0.8` | `WALLET_STOP_MIN_SOL` | 전 lane halt |
| Canary Cumulative Loss Cap | `-0.3 SOL` (lane별) | `canaryMaxBudgetSol=0.3` | `CANARY_MAX_BUDGET_SOL` | 해당 lane halt |
| Pure_ws Max Concurrent | `3` | `pureWsMaxConcurrent=3` | `PUREWS_MAX_CONCURRENT` | 동시 포지션 상한 |
| Fixed Ticket | `0.01 SOL` | `pureWsLaneTicketSol=0.01` | `PUREWS_LANE_TICKET_SOL` | 진입당 SOL 고정 |
| Security Hard Reject | mint/freeze authority, honeypot sim | security gate | — | 진입 차단 |
| Wallet Delta HALT | drift `>= 0.2 SOL` | `walletDeltaHaltSol=0.2` | `WALLET_DELTA_HALT_SOL` | 전 lane halt |
| Daily Bleed Budget | `wallet × 0.05` | `dailyBleedAlpha=0.05` | `DAILY_BLEED_ALPHA` | 해당 lane probe 중단 |

이 범주는 **절대 완화하지 않는다**. startup 시 `[REAL_ASSET_GUARD] walletFloor=... canaryLossCap=... maxConcurrent=... ticketSol=... mode=...` 한 줄 로그로 effective 값 확인.

### Observability Guard (튜닝 대상)

실험의 trade distribution 을 관찰하기 위한 circuit breaker. 발동이 반복되면 **guard 자체를 재평가** 한다.

| Guard | 현 값 | 역할 |
|-------|--------|------|
| Consecutive Losers | `>= 8` | canary halt trigger (2026-04-21 부터 4→8) |
| Canary Auto-Reset | 30분 경과 시 자동 해제 | observability halt 해제 |
| V2 detector minPassScore | 50 | signal 빈도 조절 |
| V2 per-pair cooldown | 300s | pair diversity |
| V1 bootstrap per-pair cooldown | 300s | pair diversity |
| Entry drift guard | ±2% | bad fill 차단 |

이 범주는 운영 데이터에 따라 **의도적으로 튜닝한다**.

**중요**: 운영자가 "halt 가 자주 걸린다" 고 느끼면 먼저 observability guard 완화를 고려하고, 절대 real asset guard 는 건드리지 않는다.

## 4. Survival-First Priority Stack

우선순위 7개는 아래 순서로 고정한다. 낮은 층이 흔들리면 위층은 무의미하다.

### Layer 1 — Survival (지금 가장 약함)

- Rug / honeypot structural filter
- mint / freeze authority
- top holder concentration
- dev wallet behavior
- bundler analysis
- LP lock / unlock
- Token-2022 extension policy
- transfer restriction
- **미완: pure_ws 가 security gate 를 우회함. Token-2022 는 log 만 찍고 reject 안 함.**

### Layer 2 — Truth

- Wallet delta (primary)
- Wallet equity delta (미구현)
- Realized lane pnl 분해 (미구현)
- Execution cost breakdown
- **완료: walletDeltaComparator + always-on poller + executed-buys/sells.jsonl**
- **미완: equity delta (open position mark-to-market), lane 별 net pnl 집계**

### Layer 3 — Detection

- Volume acceleration
- Buy pressure
- Tx density
- Price acceleration
- Reverse quote stability (**미완: placeholder=1.0, 실 Jupiter probe 필요**)
- **완료: src/strategy/wsBurstDetector.ts**

### Layer 4 — Viability Floor

- No route reject
- Sell impact hard cap
- Quote sanity
- Expected bleed cap
- Venue-specific cost model
- **완료: src/gate/probeViabilityFloor.ts + src/execution/bleedModel.ts**

### Layer 5 — Quick Reject (loser cut)

- First 30-45s net MFE
- Buy ratio decay
- Tx density drop
- Reverse quote 악화
- Sell impact widening
- **완료: src/risk/quickRejectClassifier.ts (weak_mfe filter 포함)**

### Layer 6 — Hold-Phase Sentinel (winner 보호)

- Reverse quote every N sec (**미완: placeholder**)
- Route disappearance
- Sell impact drift
- Fee tier change
- Degraded exit trigger
- **완료: src/risk/holdPhaseSentinel.ts (3 factor)**

### Layer 7 — Info Edge (future)

- Smart wallet DB
- 최근 90일 10x+ 지갑 필터링
- Entry/hold/exit 패턴 라벨링
- **미착수: 별도 lane 으로 분리 예정**

## 5. KPI 4단계 Maturity Gate

운영 판단은 이 4단계 외의 숫자를 보지 않는다.

### Stage 1 — Safety Pass (현재 단계)

진입 조건: bot 배포 직후

**통과 기준** (모두 만족):
- Wallet truth 정합: WALLET_DELTA drift 48h 내 `< 0.01 SOL`
- Survival filter 통과율: 진입 pair 중 `>= 90%` 가 Layer 1 (Survival) 필터 통과
- 0.8 SOL floor 위반 없음
- 0.01 SOL ticket 유지
- RPC fail-safe 무사고

통과 시 → Stage 2 진입.

### Stage 2 — Sample Accumulation (100 live trades)

진입 조건: Stage 1 통과

**중간 체크포인트** (50 trades):
- **50 trades 는 safety checkpoint — 승격 결정 없음**. bleed per probe / quick-reject 동작 / halt 빈도 / wallet reconcile 이상 여부만 점검.
- 여기서 나온 결과로 ticket 확대 / lane 추가 / 전략 변경 **금지**.
- 이슈 있으면 Observability Guard 완화 검토 (Real Asset Guard 는 그대로).

**통과 기준** (100 trades, preliminary check):
- 100 live trades 완주 (누적, lane 무관)
- Max drawdown `< 30%` (wallet 기준)
- Live friction 측정 완료 (paper vs live pnl gap 분포)
- Paper degradation ratio 측정 완료
- Wallet stop halt 0회

통과 시 → Stage 3 진입.

### Stage 3 — Winner Distribution Observation

진입 조건: Stage 2 통과

**통과 기준**:
- 5x+ winner `>= 1건` 실측
- 10x+ winner 빈도 관측 (없어도 통과 가능 — 분포 확인이 목적)
- Runner 가 누적 loser + bleed 를 덮는 방향인지 관측 (Wallet log growth 양수 아니어도 trend)

통과 시 → Stage 4 진입.

### Stage 4 — Scale / Retire Decision Gate (200 live trades)

진입 조건: Stage 3 통과 + 200+ trades 누적

**판정 기준** (scale / retire / hold 중 택일):
- `SCALE`: Lane 별 wallet log growth `> 0` (primary) + Ruin probability `< 5%` + Winner distribution 5x+ rate 확정
- `RETIRE`: netSol ≤ 0 OR ruin probability ≥ 10% OR 5x+ winner 0건이고 bleed 누적이 포지티브 기대값 가정 붕괴
- `HOLD`: 부분 만족 (다음 canary window 추가 관측)

이 단계에서 **처음으로** ticket size 증가 / infra 확장 / lane 추가 / 폐기 여부 판단.
100 SOL 은 여기 **이후의 관찰 변수**.

## 6. Dashboard 재편

운영 화면은 다음 순서로만 표시한다.

1. **현재 단계** (Stage 1/2/3/4)
2. **이번 단계 통과 기준 체크리스트** (몇 개 충족 / 필요)
3. **Real Asset Guard 상태** (전부 OK 인지)
4. **Observability Summary** (V2 telemetry, cooldown hit 비율, halt 빈도)
5. **Wallet delta 분해** (cash delta / equity delta / drift)
6. **Trade count 진행률** (Stage 2 목표 100 trades 대비)
7. (맨 아래) 100 SOL 도달률 — **관찰 변수, 판단 근거 아님**

**금지**:
- 일/주/월 수익률 % 를 판단 지표로 쓰지 말 것
- "언제 100 SOL 도달?" 계산 금지
- DB pnl 단독 판정 금지 (2026-04-18 pivot R1 유지)

## 7. Daily / Weekly Review 질문 재정의

**❌ 금지 질문**

- 이번 주 수익률은?
- 언제 100 SOL 도달?
- 왜 오늘 수익이 안 나지?

**✅ 4개 질문만**

1. Wallet delta 와 DB pnl 의 drift 가 허용 범위 내인가?
2. Survival filter 통과율은? (진입 pair 중 safe 비율)
3. Trade count 진행률은? (현재 Stage 목표 대비)
4. Bleed per probe 추이는? (비용 구조 개선 중인가)

이 4개에 대한 답이 나오지 않으면 운영 로그에 문제가 있는 것 — 코드 fix 대상.

## 8. 결정 (Decisions)

이 문서를 merge 하는 즉시 발효:

### D1. 100 SOL 은 tail outcome 으로 재분류

- PLAN/PROJECT/MEASUREMENT/STRATEGY 의 `1 SOL → 100 SOL` 모든 언급에 **"tail outcome"** 명시 또는 링크
- 이 문서가 최종 authority

### D2. Survival Layer 가 다음 P0

- Rug/honeypot/Token-2022 policy 구현이 다른 어떤 P0 보다 선행
- 기존 exec-plan 우선순위 재정렬

### D3. Dashboard / Telegram 문구 재편

- 일일 수익률 표시 제거
- Stage 체크리스트 표시 추가
- Real/Observability guard 구분 표시

### D4. Review Cadence 재정의

- 매일: 4개 질문 답변
- 매주: Stage 진행률 + trade count 증분
- Stage 통과 시에만 "다음 단계로 이동" 결정

### D5. Retired Concepts

- "매일/주/월 수익 목표"
- "100 SOL 까지 며칠 남았나" 계산
- "DB pnl 기반 주간 리뷰"

## 9. 문서 동기화 체크리스트

이 refinement 적용 후 아래 문서들이 이 authority 를 반영해야 한다:

- [ ] `PLAN.md` — mission charter 에 tail outcome 명시
- [ ] `PROJECT.md` — 성공 기준 Stage 4 로 재정의
- [ ] `MEASUREMENT.md` — KPI 4단계 maturity gate 섹션 추가
- [ ] `STRATEGY.md` — Stage 현황 표시
- [ ] `OPERATIONS.md` — daily 4개 질문, weekly Stage 체크
- [ ] `docs/exec-plans/active/1sol-to-100sol.md` — title 재검토 (운영 plan 명도 tail outcome 반영 고려)

## 10. 철학적 Note

이 refinement 는 프로젝트를 **작게** 만들지 않는다. 오히려:

- **실험의 범위를 명확히** 한다
- **실패의 정의를 바꾼다** — 100 SOL 미달 ≠ 실패. 0.8 SOL floor 깨짐 = 실패. 200 trades 미달 = 미완.
- **성공의 문턱을 낮춘다** — tail outcome 잡았다면 bonus. 못 잡았어도 200 trades + survival = 기술적 성공.

이 framing 없이는 매일 wallet 을 보며 감정 기복으로 전략을 바꾸게 된다. 그건 convexity engine 의 반대다.

---

**Final one-liner**:

> Build a positive-optionality engine. Don't measure it by the outcome it's designed to catch.
