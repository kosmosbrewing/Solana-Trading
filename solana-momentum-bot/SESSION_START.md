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

### Lane 표 (2026-04-26 갱신 — swing-v2 추가)

| Lane | arm | 모드 | 역할 | 코드 | 파라미터 |
|------|------|------|------|------|----------|
| `cupsey_flip_10s` | — | (disabled) | **Benchmark (frozen)** — 개조 금지 | `cupseyLaneHandler.ts` | 변경 0 |
| `pure_ws_breakout` | primary (v1) | live opt-in | Lane S (scalping baseline) | `pureWsBreakoutHandler.ts` | 30s probe / 15% trail |
| `pure_ws_swing_v2` | shadow / live canary | paper-first → opt-in live | swing 손익비 A/B | `pureWs/swingV2Entry.ts` | 600s probe / 25% trail / 1.10 floor |
| `kol_hunter` | v1 / smart-v3 / swing-v2 | paper-only (코드 강제) | **Lane T (사명 직결)** | `kolSignalHandler.ts` | smart-v3 main + swing-v2 shadow |

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

### 최근 무엇을 했나
- **2026-04-28** — 24h 동기화 분석에서 **5x winner 1건 첫 돌파** (`DF7DAPat` smart-v3 mfe+940% / net+940% / insider_exit_full / hold 656s). 사명 §3 binding constraint 24h 첫 돌파 ✓. 3 of 4 phase gate 충족. 단 **3대 incident** 동시 발견: missed-alpha observer dead, wallet_delta_warn drift 0.118 SOL spam (5분 × 6회), notifier failures 3건 error 빈 capture. 분석 측정 무결성 — 시간대 정합 규칙 적용 (UTC 기준 일관).
- **2026-04-27** — KOL paper 212 누적 / 5x+ winner 0 / smart-v3 +4.79% net. KOL DB v6 (22→35 active, S 4+A 31). KOL live canary 코드 commit 1469a08 + 7 audit fix. ralph-loop 3 iteration: cupsey test isolation, dead strategy_d toggles, silent fallback ledger logs, 3개 setInterval handle cleanup, KOL live close operator notification.
- **2026-04-26** — pure_ws swing-v2 paper shadow + live canary 구현, smart-v3 + swing-v2 dual shadow, scripts archive (25개), Strategy D 영구 retire (~2200 LOC 감소).
- **2026-04-25** H1 Foundation — Clock interface / network mock / env-catalog / `npm run check`.
- **2026-04-23** Option 5 Phase 0-3 full — KOL DB scaffold + tracker + state machine + paper ledger.

### 다음 운영 액션 (운영자 결정)

**선택 A — 사명 §3 정합 (권장)**: 추가 5x winner 1-2건 누적 + 3대 incident 회복 후 ADR
1. 매일 1회 `bash scripts/sync-vps-data.sh` 후 UTC 기준 24h 분석
2. **3대 incident P0 회복** (INCIDENT.md 2026-04-28 §7-8-10):
   - (P0) `MissedAlphaObserver` dead 회복 — `src/observability/missedAlphaObserver.ts` + observer init 점검. 회복 전엔 가설 (B) 정량 검증 불가
   - (P0) wallet_delta_warn drift 0.118 SOL origin 추적 (`ops:reconcile:wallet`) + dedup/cooldown 코드 점검
   - (P2) notifier fail 경로 error capture 정정
3. **5x+ root cause 가설 검증** (INCIDENT.md 2026-04-28 §3 데이터 근거):
   - (A) trail/sentinel 보수성 = **정량 증거 누적** (Top-5 mfe 중 3건 sentinel 컷 / capture 29% / mfe 167%→net 58%)
   - (B) entry timing — smart_v3_price_timeout 1644건 (38.3%) / 가설 보조 증거 ✓ / observer 회복 시 직접 측정 가능
   - (C) T2 임계 적정성 — 5x winner 1건 추가 누적 후 재평가
4. 추가 5x winner 1-2건 누적 시 별도 ADR + Telegram critical ack `stage4_approved_YYYY_MM_DD` 후 KOL live canary opt-in

**선택 B — 자발적 §3 위반 인지 후 활성화**: 코드 모두 준비됨
- `.env` 에 `KOL_HUNTER_PAPER_ONLY=false` + `KOL_HUNTER_LIVE_CANARY_ENABLED=true` 추가 후 재시작
- startup `[STAGE_GATE_REMINDER]` warn 로 §3 의무 알림
- 안전망: canary cap 0.3 SOL / drift halt 0.2 SOL / max consec / ticket 0.01 hard lock
- 단 **현재 비추** — single-winner n=1 + observer dead + drift incident 진행 중

### 절대 하지 말 것
- ❌ `cupsey_flip_10s` 코드 수정 (frozen benchmark)
- ❌ Real Asset Guard 어떤 항목도 완화
- ❌ V2 detector / probe window / ticket size 튜닝 (관측 데이터 없이)
- ❌ KOL DB 자동 추가 (수동 편집 only)
- ❌ trail/sentinel 파라미터 변경을 observer 회복 전에 (가설 (A) 검증 도구 부재)
- ❌ KOL live canary 활성화를 추가 5x winner 1-2건 + observer 회복 + drift origin 확인 전에
- ❌ KST cutoff 으로 UTC 데이터 분석 (시간대 함정 — `date -u` 기준 일관 사용)
- ❌ ESLint disable / `STRUCTURE_BASELINE freeze` 같은 임시방편 (Phase H2-H4 에서 근본 refactor)
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
| 5x winner 의 hold_phase_sentinel 컷 빈도 ↑ | INCIDENT.md 2026-04-28 §3 — capture rate 29% / mfe 167%→net 58%. sentinel 완화 검토 (가설 A) |
| `missed-alpha.observations` 배열 비어있음 | `MissedAlphaObserver` dead — INCIDENT.md 2026-04-28 §7 (commit 1469a08 회귀 의심) |
| wallet_delta_warn 동일 drift 5분 spam | dedup/cooldown 미작동 + drift origin 추적 — INCIDENT.md 2026-04-28 §8 |
| `smart_v3_price_timeout` 38%+ | entry timing 가설 (B) 보조 증거. observer 회복 후 직접 측정 |
| jsonl 분석 결과가 daily 와 14배 차이 | 시간대 함정 — 데이터는 UTC `Z`, cutoff 도 `date -u` 사용 (KST 금지) |
| V2 PASS pair = 1-2 | Detection diversity 붕괴 — Option 5 Phase 1-2 결과 확인 |
| `deltaPct p50 ≈ -92%` | Signal price bug (pool stale) — Tier C sprint 미해결 |
| Jupiter 429 cluster | `recordJupiter429` source 별 카운터 + cooldown 작동 확인 |
| `unhandled rejection` in test | network 누락 mock — `createBlockedAxiosMock()` 패턴 적용 |
| `dailyPnl=0` in test | Clock 미주입 — `createFakeClock(FIXTURE_NOW)` 사용 |
| 테스트가 운영 .env 영향으로 fail | `cupseyWalletMode='sandbox'` / `securityGateEnabled=false` / `canaryGlobalConcurrencyEnabled=false` 등 explicit override 필요 |

---

## 7. 문서 깊이 들어갈 때

- 코드 변경 전: `MISSION_CONTROL.md` + `docs/design-docs/option5-...md`
- Lane 추가/변경: `REFACTORING_v1.0.md` + `INCIDENT.md` 의 lane 섹션
- 운영 트러블슈팅: `INCIDENT.md` + `OPERATIONS.md`
- 백로그: `INCIDENT.md` + `docs/exec-plans/active/1sol-to-100sol.md`
- 사명 토론 / 의사결정: `docs/debates/`
- 구조 / 의존성 방향: `ARCHITECTURE.md`

---

## 8. 한 줄 원칙

> **"방어선 굳건 + 작게 여러 번 + 뱅어 올 때까지 버티기."**
> Behavioral drift 가 가장 큰 적. Daily 4 질문 (`MISSION_CONTROL.md` §discipline) 만 매일 확인.

---

*Last updated: 2026-04-28 — 5x winner 첫 돌파 (24h n=1) + 3대 incident 회복 sprint 진입.*
