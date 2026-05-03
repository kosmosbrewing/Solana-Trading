# ADR: Option 5 — KOL Discovery + 자체 Execution 채택

> Status: **Decided (2026-04-23)**. Phase 2 shadow eval 통과 시 확정, 실패 시 기각.
> Decision Owner: 운영자
> Authority precedence (본 문서 merge 이후):
> `mission-refinement-2026-04-21.md` > `mission-pivot-2026-04-18.md` > **본 문서** > PLAN/PROJECT/STRATEGY/MEASUREMENT
> Supersedes: `LANE_20260422.md §8 Decision Fork` 의 Path A/B/C/D 선택은 본 결정으로 대체.
> Rejects: `20260423.md` Option 4 (full-stack 재설계) 및 KOL Signal Layer v1.0 문서 §4.1 (Scanner 뒤의 5번째 Gate 방식).

---

## 1. Context — 왜 이 결정이 필요해졌는가

### 1.1 관측 근거

2026-04-22 12h 운영 로그 + 7일 ledger 분석 결과:

| 항목 | 값 | 의미 |
|------|-----|------|
| pure_ws 7d trade | 83 | trade 는 쌓이는 중 |
| pure_ws net 5x+ winner | **0** | 사명 §2.3 의 5x+ 실측 0 건 |
| V2 PASS 12h | 3180 | detection 은 폭발적 |
| V2 PASS 고유 pair | **2개** | detection diversity 붕괴 |
| Survival gate 통과율 | 2% | scan 대상 자체가 rug-prone |
| `deltaPct p50` (missed-alpha) | **−92%** | signal price 와 Jupiter 가격이 12배 괴리 |
| ASTEROID / MAGA / BELIEF / BULL | V2 PASS 0건 | 살아있는 시장이 구조적으로 감지 불가 |

### 1.2 Root cause 진단 (`20260423.md` §2, `LANE_20260422.md` §4)

- **Discovery layer (Helius pool discovery + V2 detector)** 가 구조적으로 "방금 생긴 pool 의 0-60s burst" 에 편향 → dead liquidity wash-trade 를 burst 로 오인
- **Execution paradigm (30s probe + 5-gate chain)** 이 Phase 2 consolidation 을 flat 으로 오판 → T1 도달 전 82% 사망
- 둘 다 "Helius-only on-chain signal" 이라는 **공통 전제** 의 귀결
- 사명 §2.3 "5x+ winner 분포 실측" 은 현 구조로 **구조적 달성 불가**

### 1.3 운영자 판단 (2026-04-23 대담)

> "이건 도저히 사명 달성 가능성이 없다고 봐도 무방할 것 같아, 하지만 트레이딩 전략에 대한 부분은 내가 배워야 할 점이야, 그래서 절충하고 싶어, 토큰을 거르고 전략을 선정하는 것에 대한 부분은 KOL 전략을 추종하되 트레이딩 전략은 우리의 것을 준용하는 것이야."

대담 원문 및 품평 — `docs/debates/kol-discovery-debate-2026-04-23.md` 참조.

---

## 2. Decision — 무엇을 결정했는가

### 2.1 본문

> **KOL Wallet Activity 를 1st-class Discovery Trigger 로 격상한다.**
> **Execution state machine 의 구조 (상태·가드·ledger) 는 유지하되, 파라미터는 KOL Discovery 에 정합하도록 재조정한다.**
> **Real Asset Guard 는 어떤 항목도 완화하지 않는다.**

### 2.2 채택된 형태: "옵션 5 B형"

| 구분 | A형 (거절) | **B형 (채택)** |
|------|------------|----------------|
| Discovery | Helius Scanner + KOL score 가산 | **KOL wallet tx = 1st-class candidate** |
| Execution 구조 | 현 pure_ws 그대로 | 현 pure_ws 구조 유지 |
| Execution 파라미터 | 현 값 그대로 | **KOL Discovery 에 맞게 재조정** |
| 사명 달성 확률 | 중간 이하 | 가장 높음 |

### 2.3 역할 분업

- **운영자 도메인 지식 → Discovery**: KOL DB 수동 정제 / 월간 재검증
- **시스템 discipline → Execution**: state machine / Real Asset Guard / observability
- 이 분업이 본 결정의 논리적 축

---

## 3. Consequences — 무엇을 얻고 무엇을 잃는가

### 3.1 얻는 것

- **사명 §2.3 "5x+ winner 분포 실측" 이 구조적으로 가능해짐**
  - Discovery 가 "살아있는 시장 (KOL 판단 pool)" 로 교체
  - Execution 재조정으로 Phase 2-3 breakout 포획 가능
- **"Helius only" single-point-of-dead-liquidity 탈출**
- **운영자 축적 자산 (한국 KOL DB) 의 실질 활용**
- **cupsey benchmark 개조 금지 원칙 유지** (신설만, 기존 개조 없음)
- **Real Asset Guard 불변** (죽지 않기 속성 보존)

### 3.2 잃는 / 포기하는 것

- Paper-first 2-4주 소요 (Phase 1-3)
- KOL DB 유지 부담 (월 1회 재검증 루틴 필요)
- Helius-only 경로의 단순성 상실 (다중 trigger source 관리 필요)
- 이전 문서 (`KOL Signal Layer v1.0`) 의 "Gate 5번째" 설계 폐기
- 현 pure_ws 단독 체제의 심리적 단순성 상실 (Lane T / Lane S 병행)

### 3.3 Residual Risk (Phase 2 에서 검증 대상)

- R1. **KOL DB stale**: 과거 winner 지만 현재 아닐 수 있음
- R2. **Insider exit liquidity**: KOL 이 진입 직후 exit → 우리가 exit liquidity 역할
- R3. **Multi-KOL 합의 허위**: 같은 alpha group 에서 chain forward → "독립 판단" 아님
- R4. **1st wave vs 2nd wave**: 한국 KOL 이 영어권 Twitter narrative 뒤일 수 있음 (단 2nd wave 도 사명 달성 가능)

각 R1-R4 는 **Phase 2 shadow eval 의 go/no-go 기준**으로 정량 검증.

---

## 4. Alternatives Considered — 왜 다른 옵션이 아닌가

### Alt 1. 현 pure_ws 유지 (Path D, 관측만)
- 관측: 7일 127 trade / net 5x+ = 1 (benchmark only, pure_ws 는 0)
- 이유: 사명 §2.3 구조적 달성 불가. **기각**.

### Alt 2. KOL Signal Layer v1.0 (Scanner 뒤의 5번째 Gate)
- Scanner 후보 중 KOL 진입 토큰에 score 가산
- 관측: Scanner 후보 (dead pool) ∩ KOL 진입 토큰 (ASTEROID 등) = 거의 공집합
- 이유: Discovery 병목을 비껴감. **기각**.

### Alt 3. Trending + Pump.fun Graduate only (`20260423.md` Tier 1)
- DexScreener / Pump.fun graduate 만 Discovery 교체
- 한계: narrative alpha / insider signal 부재. KOL 경험 자산 활용 0.
- 이유: 옵션 5 의 subset. **본 결정이 포함**.

### Alt 4. Full-stack 재설계 (Twitter API + Telegram MTProto + Smart Wallet DB + 신규 Lane T)
- 가장 ambitious
- 한계: Timeline 4-6주, Twitter 비용 $100+, Telegram ToS 리스크, 검증되지 않은 축 4개 동시 도입
- 이유: 본 결정 Phase 3 성공 후 확장 가능. 지금은 **연기**.

### **Alt 5 (본 결정). KOL Discovery (1st-class) + 자체 Execution (구조 유지, 파라미터 재조정)**
- 운영자 강점 + 시스템 강점 명확한 분업
- Phase 2 shadow eval 으로 KOL DB edge 를 early validation
- Real Asset Guard 전혀 건드리지 않음
- **채택**.

---

## 5. Hard Constraints — 이 결정 이후 불변

> 2026-05-03 정합성 주석: 아래 Real Asset Guard 값은 현재 운영 기준으로 갱신됐다.
> `MISSION_CONTROL.md` 가 wallet floor `0.7 SOL`, KOL ticket `0.02 SOL`,
> KOL canary cap `-0.2 SOL` 을 상위 운영값으로 둔다. Option 5 의 핵심 결정
> 자체는 유지된다: KOL discovery is first-class, execution discipline and guardrails
> are not bypassed.

### 5.1 Real Asset Guard (절대 불변)

| 항목 | 값 | 근거 |
|------|-----|------|
| Wallet floor | 0.7 SOL | `MISSION_CONTROL.md` 2026-04-28 B안 |
| Canary cumulative loss cap | default lane -0.3 SOL / KOL -0.2 SOL | `MISSION_CONTROL.md` |
| Fixed ticket | pure_ws/cupsey/migration 0.01 SOL / KOL 0.02 SOL | `SESSION_START.md`, `MISSION_CONTROL.md` |
| Max concurrent | 3 (전역) | 동일 |
| Wallet delta drift halt | ≥ 0.2 SOL | 동일 |
| Daily bleed budget | wallet × 0.05 | 동일 |
| Security hard reject | mint/freeze/honeypot/Token-2022 dangerous ext | 동일 |

### 5.2 Execution 구조 불변 (Lane T 파라미터만 재조정)

- 상태기계: PROBE → T1 → T2 → T3 구조 유지
- Hold-phase sentinel 개념 유지 (threshold 재조정 허용)
- Quick-reject classifier 개념 유지 (threshold 재조정 허용)
- Entry drift guard / sell quote probe / survival gate 유지

### 5.3 Benchmark Lane 동결

- cupsey_flip_10s 는 현재 구조 그대로 (cupsey handler 개조 금지 원칙)
- pure_ws 는 Lane S (scalping, 비교 baseline) 로 격하 가능 — 기존 파라미터 유지

### 5.4 KOL Layer 자체 제약

- **KOL 단독으로 Gate 통과 강제 금지**: Survival / drift / sell probe 모두 통과해야 entry
- **KOL 진입 즉시 매수 금지**: Discovery trigger → gate pipeline 경유 필수
- **KOL DB 자동 추가 금지**: 수동 편집 only (stale 방지)
- **KOL exit signal 카피 금지**: exit 는 자체 execution state machine
- **Anti-correlation 윈도우** 최소 60s (10s 아님) — multi-KOL 합의 허위 방지

---

## 6. Go / No-go Gates — 언제 이 결정을 번복하는가

### Gate 1: Phase 2 Shadow Eval (1주 후)

**Go 기준** (모두 만족):
- KOL 진입 후 T+5min / T+30min 가격 분포 **median > 0**
- Multi-KOL 합의 케이스의 median > single-KOL median
- 최근 30일 내 tx 가 있는 active KOL 비율 ≥ 70%

**No-go 시 행동**:
- 옵션 5 기각 선언
- Alt 4 (full-stack 재설계) 로 pivot or 전략 paradigm 재논의
- 본 문서는 **archive (supersede)**, 새 ADR 발행

### Gate 2: Phase 3 Paper Trading (2주 후)

**Go 기준**:
- Paper kol_hunter lane 의 net 5x+ winner ≥ 1건 또는 T2 visit ≥ 2건
- Real Asset Guard 위반 0건
- KOL Discovery candidate 의 survival gate 통과율 ≥ 50%

**No-go 시 행동**:
- Execution 파라미터 재조정 1차 실패 → 재튜닝 (Phase 3 연장)
- 2차 실패 시 옵션 5 기각

### Gate 3: Phase 4 Live Canary 50 trades

**Go 기준**:
- Live net 5x+ 또는 T2 visit ≥ 1건
- 0.7 floor 무위반
- paper vs live gap (slippage / friction) 허용 범위

**No-go 시 행동**:
- Live 중단, paper 로 복귀 → Execution 재검토

### Gate 4: Stage 4 (200 trades, 최종)

- mission-refinement §5 Stage 4 기준 그대로 (SCALE / RETIRE / HOLD)

---

## 7. Implementation Scope Summary

세부 실행 가이드: `REFACTORING_v1.0.md`.

### 건드리지 않는 것
- Real Asset Guard 전부
- cupsey_flip_10s 전체
- Execution state machine 구조
- Observability (missed_alpha_observer, jupiter_rate_limit_metric, wallet_delta_comparator)
- 기존 security / drift / sell probe gate

### 재조정 대상 (Lane T 한정)
- Probe window 30s → 2-5min stalk
- Hardcut MAE -3% → -10%
- T1 threshold +100% → +50%
- T1 trail 7% → 15%
- quickReject window / threshold
- Hold-phase sentinel threshold

### 신규 모듈
- `src/ingester/kolWalletTracker.ts`
- `src/kol/db.ts` + `data/kol/wallets.yaml`
- `src/kol/scoring.ts` (Discovery trigger 용, Gate 가산 아님)
- `src/orchestration/kolSignalHandler.ts` (pureWsBreakoutHandler 참고)
- Phase 3 에서 lane_t_paper 테스트

### Lane 구조 (결정 이후)

| Lane | 역할 | 파라미터 |
|------|------|----------|
| cupsey_flip_10s | Benchmark (동결) | 변경 없음 |
| pure_ws_breakout | Scalping / Baseline | 기존 파라미터 유지 |
| **kol_hunter (신규, Lane T)** | **Tail Hunter** | **재조정 파라미터** |

---

## 8. 사명 Alignment Check

### mission-refinement-2026-04-21 §2.3 "새 정의"

> "0.8 SOL floor 를 깨지 않고 200 live trades 를 통과하며, 5x+ winner 분포를 실측했다."

2026-05-03 운영 기준으로 floor 는 `0.7 SOL` 로 갱신됐다. 원문 사명은
"floor 보호 + 200 live trades + 5x+ winner 실측" 구조로 유지한다.

본 결정 이후:
- 0.7 floor: Real Asset Guard 불변 ✅
- 200 trades: Lane S + Lane T 병행 속도 ≥ 현 pure_ws 단독
- **5x+ winner**: **구조적 가능**으로 전환 (현 구조: 구조적 불가)

### mission-refinement §4 Survival Priority Stack

| Layer | 본 결정 영향 |
|-------|-------------|
| Layer 1 Survival | 동일 (KOL 도 survival gate 통과 필요) |
| Layer 2 Truth | 동일 (wallet delta comparator) |
| Layer 3 Detection | **교체 — KOL Discovery 가 1st-class** |
| Layer 4 Viability | 동일 (sell quote probe) |
| Layer 5 Quick Reject | Lane T 에서 재조정 |
| Layer 6 Hold-phase Sentinel | Lane T 에서 재조정 |
| Layer 7 Info Edge | **실체화 — KOL DB 가 Info Edge 의 구체화** |

---

## 9. 이 ADR 의 수정 규칙

- 본 결정 본문 (§2, §5) 수정 금지
- Phase 2/3/4 결과는 새 ADR 로 작성 (본 문서는 history 유지)
- Go/No-go gate 기준 변경 시 새 ADR + 본 ADR supersede 선언
- Iteration 2 대담은 `docs/debates/` 로

---

## 10. Related Documents

- `docs/design-docs/mission-refinement-2026-04-21.md` — 최상위 authority
- `docs/design-docs/mission-pivot-2026-04-18.md` — convexity pivot
- `LANE_20260422.md` — Lane fit 진단
- `20260423.md` — Dead liquidity + trending scalping
- `KOL Signal Layer v1.0` (운영자 초안 문서, 5번째 Gate 방식, 본 ADR 로 rejects)
- `docs/debates/kol-discovery-debate-2026-04-23.md` — 본 결정의 Q&A
- `REFACTORING_v1.0.md` — 본 결정의 실행 가이드
- `INCIDENT.md` — 관측 근거 연표

---

*2026-04-23 — Initial decision*
