# SESSION_START — 새 세션 1 페이지 hand-off

> 새 AI/사람 세션이 이 프로젝트를 처음 만났다면 **이 1 페이지만** 읽고 시작하세요.
> 더 깊이 들어가야 할 때만 아래 링크를 따라가세요.

---

## 1. 가장 먼저 — 1줄 신뢰 명령

```bash
npm run check:fast
```

→ typecheck + typecheck:scripts + env-catalog drift + jest 전체. 통과하면 코드 신뢰 가능.

| 명령 | 범위 | 사용 시점 |
|------|------|----------|
| `npm run check:fast` | typecheck + jest --silent + env drift | 작업 중 빠른 검증 |
| `npm run check` | check:fast 전체 + jest 비-silent | commit 전 확정 검증 (현재 GREEN) |
| `npm run check:strict` | + lint + docs:lint | **현재 RED** — Phase H4 ESLint debt 해소 후 GREEN. CI gate 후보 |

> 2026-04-25 현황: lint 8 errors / structure check 48 errors 는 **기존 debt (Phase H2-H4 에서 점진 해소)**. `check:strict` 는 그때까지 의도적으로 deferred.

---

## 2. 현재 paradigm — 무엇이 active 한가

### Authority chain (위에서부터 읽기)

1. **`MISSION_CONTROL.md`** — 6 control framework (survival/universe/payoff/execution/experiment/discipline). 모든 변경의 4-layer reporting 의무.
2. **`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`** — **현 active paradigm**. KOL Wallet = 1st-class Discovery, 자체 Execution 구조 유지 + Lane T 파라미터 재조정.
3. **`docs/design-docs/mission-refinement-2026-04-21.md`** — 사명: 0.8 SOL floor + 200 trades + 5x+ winner 실측. 100 SOL 은 tail outcome.
4. **`REFACTORING_v1.0.md`** — Option 5 의 Phase 0-5 실행 가이드 (현 active sprint).

### Lane 표

| Lane | 역할 | 코드 | 파라미터 |
|------|------|------|----------|
| `cupsey_flip_10s` | **Benchmark (frozen)** — 개조 금지 | `cupseyLaneHandler.ts` | 변경 0 |
| `pure_ws_breakout` | Lane S (scalping baseline) | `pureWsBreakoutHandler.ts` | 변경 0 |
| `kol_hunter` | **Lane T (사명 직결, paper-first)** | `kolSignalHandler.ts` | 재조정 (Lane T) |

---

## 3. Real Asset Guard — 절대 불변

| 항목 | 값 | 위반 시 |
|------|-----|---------|
| Wallet floor | 0.8 SOL | **commit 거부** — 명시적 ADR 없으면 변경 금지 |
| Canary cumulative loss cap | -0.3 SOL | 동일 |
| Fixed ticket | 0.01 SOL | 동일 |
| Max concurrent | 3 (전역) | 동일 |
| Drift halt | ≥ 0.2 SOL | 동일 |
| Security hard reject | mint/freeze/honeypot/Token-2022 dangerous ext | 동일 |

→ 이 값들 변경하려면 **별도 ADR + 48h cooldown + 운영자 명시 승인**.

---

## 4. 5 분 안에 알아야 할 것

### 어제 (전 세션) 무엇을 했나
- **2026-04-25 H1 Foundation** — Clock interface / network mock helper / env-catalog / `npm run check`. 새 세션 hand-off 비용 영구 감소.
- **2026-04-23 Option 5 Phase 0-3 full** — KOL DB scaffold + tracker + state machine + paper ledger.

### 다음 운영 액션 (운영자)
1. `data/kol/wallets.json` 추가 KOL 입력 (현재 16건, 50-80 목표)
2. `KOL_TRACKER_ENABLED=true` + `KOL_HUNTER_ENABLED=true` (paper-only) 로 재배포
3. 1-2주 Phase 1 passive logging
4. `npm run kol:shadow-eval` → Phase 2 go/no-go

### 절대 하지 말 것
- ❌ `cupsey_flip_10s` 코드 수정 (frozen benchmark)
- ❌ Real Asset Guard 어떤 항목도 완화
- ❌ V2 detector / probe window / ticket size 튜닝 (관측 데이터 없이)
- ❌ KOL DB 자동 추가 (수동 편집 only)
- ❌ ESLint disable / `STRUCTURE_BASELINE freeze` 같은 임시방편 (Phase H2-H4 에서 근본 refactor 예정)
- ❌ `npm run check:fast` 가 빨강인 채로 commit

---

## 5. 자주 쓰는 명령

```bash
# 검증
npm run check:fast              # 빠른 신뢰 (typecheck + jest)
npm run check                   # 전체 (lint 포함)

# Env
npm run env:check               # config.ts ↔ .env.example.generated drift
npm run env:generate            # generated 카탈로그 재생성

# 운영 / 분석
npm run ops:canary:eval         # Stage 2/3 trade 결과 평가
npm run kol:shadow-eval         # Phase 2 KOL Discovery go/no-go

# 테스트 단독
npx jest test/kolSignalHandler  # Lane T state machine
npx jest test/missedAlphaObserver  # 관측 장비
npx jest test/utils/clock       # Clock interface
```

---

## 6. 진단 — 무엇을 보면 무엇을 알 수 있나

| 증상 | 1차 확인 |
|------|----------|
| 5x+ winner 0건 / probe_reject_timeout 다수 | Lane T 파라미터 재조정 필요 (REFACTORING §3) |
| V2 PASS pair = 1-2 | Detection diversity 붕괴 — Option 5 Phase 1-2 결과 확인 |
| `deltaPct p50 ≈ -92%` | Signal price bug (pool stale) — Tier C sprint 미해결 |
| Jupiter 429 cluster | `recordJupiter429` source 별 카운터 + cooldown 작동 확인 |
| `unhandled rejection` in test | network 누락 mock — `createBlockedAxiosMock()` 패턴 적용 |
| `dailyPnl=0` in test | Clock 미주입 — `createFakeClock(FIXTURE_NOW)` 사용 |

---

## 7. 문서 깊이 들어갈 때

- 코드 변경 전: `MISSION_CONTROL.md` + `docs/design-docs/option5-...md`
- Lane 추가/변경: `LANE_20260422.md` + `REFACTORING_v1.0.md`
- 운영 트러블슈팅: `INCIDENT.md` + `OPERATIONS.md`
- 백로그: `INCIDENT.md` + `docs/exec-plans/active/1sol-to-100sol.md`
- 사명 토론 / 의사결정: `docs/debates/`
- 구조 / 의존성 방향: `ARCHITECTURE.md`

---

## 8. 한 줄 원칙

> **"방어선 굳건 + 작게 여러 번 + 뱅어 올 때까지 버티기."**
> Behavioral drift 가 가장 큰 적. Daily 4 질문 (`MISSION_CONTROL.md` §discipline) 만 매일 확인.

---

*Last updated: 2026-04-25 — Phase H1 Foundation 완료.*
