# REFACTORING v1.0 — Option 5: KOL Discovery + 자체 Execution

> **Status**: Phase 0-3 완료 (paper 측정 단계). Phase 4 (Live Canary) 게이트 대기 중.
> **Updated**: 2026-04-26 — Phase 3 + smart-v3 + swing-v2 (KOL/pure_ws) 코드 완료. Phase 4 gate 미충족 (200 trades + 5x+ winner 입증).
> **Authority**: `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md` (ADR)
> **Debate log**: `docs/debates/kol-discovery-debate-2026-04-23.md`
> **Paradigm**: KOL Wallet Activity = 1st-class Discovery, 자체 Execution = 구조 유지 + 파라미터 재조정
> **Timeline**: Phase 0-3 완료 / Phase 4-5 paper 데이터 누적 후

---

## 0. 이 문서의 역할

- ADR (영구 결정 근거) 과 Debate (대담) 와 분리됨
- **실행 가이드**: Phase 별 작업 목록 + checkbox + acceptance criteria + rollback
- Paradigm 변경 시 본 문서 archive → `REFACTORING_v2.0.md` 신규

---

## 1. Phase Status

- [x] **Phase 0**: KOL DB 정제 — scaffold 완료 (2026-04-23). 22 active KOL.
- [x] **Phase 1**: KOL Wallet Tracker + passive logging — 코드 구현 완료 (2026-04-23). 운영 환경 활성.
- [x] **Phase 2**: Shadow Eval 스크립트 — 완료 (2026-04-23). `npm run kol:shadow-eval`.
- [x] **Phase 3**: kol_hunter Paper Lane — full 구현 완료 (2026-04-23). PROBE→T1→T2→T3 + price feed + observer hooks + paper ledger.
- [x] **Phase 3.5** (2026-04-26): smart-v3 main + swing-v2 paper shadow — 손익비 정책 A/B. KOL `kol_hunter_smart_v3` (pullback/velocity/both) + `kol_hunter_swing_v2` (multi-KOL long hold).
- [x] **Phase 3.6** (2026-04-26): pure_ws swing-v2 paper shadow + live canary 코드 — `pure_ws_swing_v2` arm. paper-first → opt-in live (별도 lane / canary slot / budget).
- [ ] **Phase 4**: Live Canary 50 trades (2주) — **게이트 대기**: paper 200 trades + 5x+ winner ≥ 1건 입증 필요.
- [ ] **Phase 5**: Live 200 trades → Stage 4 gate (4주)

### Phase 3.5/3.6 산출물 (2026-04-26)

| 변경 | 위치 | 영향 |
|------|------|------|
| KOL smart-v3 main (pullback/velocity/both) | `kolSignalHandler.ts` | smart-v3 default ON, kolEntryReason 별 trail/floor override |
| KOL swing-v2 shadow (smart-v3 + dual) | `kolSignalHandler.ts:1031` | `primaryVersion !== swingV2ParameterVersion && isSwingV2Eligible(score)` 로 smart-v3 path 와 dual |
| pure_ws swing-v2 shadow + live canary | `pureWs/swingV2Entry.ts` (신규 모듈) | EntryLane `pure_ws_swing_v2`, paper ledger (`pure-ws-paper-trades.jsonl`) 또는 live canary (별도 slot/budget) |
| Real Asset Guard 정합 | `policyGuards`, `canaryAutoHalt` | swing-v2 ticket 0.01 / max budget 0.1 / max consec 5 별도 cap |
| sync 자동 paper-arm-report | `scripts/sync-vps-data.sh` | `bash sync-vps-data.sh` 1회로 sync + report 자동 |

---

## 2. Hard Constraints — 건드리지 않는 것

ADR §5 로부터 그대로. 본 문서 모든 Phase 에서 불변.

### 2.1 Real Asset Guard (절대 불변)

| 항목 | 값 | 코드 변수 |
|------|-----|-----------|
| Wallet floor | 0.8 SOL | `walletStopMinSol` |
| Canary cumulative loss cap | -0.3 SOL | `canaryMaxBudgetSol` |
| Fixed ticket | 0.01 SOL | `pureWsLaneTicketSol` (Lane T 도 동일값 사용) |
| Max concurrent | 3 | `pureWsMaxConcurrent` (전역) |
| Wallet delta drift halt | ≥ 0.2 SOL | `walletDeltaHaltSol` |
| Daily bleed budget alpha | 0.05 | `dailyBleedAlpha` |
| Security hard reject | mint/freeze/honeypot/Token-2022 dangerous ext | `evaluateSecurityGate` |

### 2.2 Execution State Machine 구조 (Lane T 도 유지)

- PROBE → T1 → T2 → T3 단계별 promotion 구조 그대로
- MFE 기반 승격 / trail 기반 exit 구조 그대로
- Hold-phase sentinel 개념 유지 (threshold 재조정 허용)
- Quick-reject classifier 개념 유지 (threshold 재조정 허용)

### 2.3 Benchmark / Baseline Lane 동결

- **cupsey_flip_10s**: 전체 동결 (handler 개조 금지, 파라미터 변경 금지)
- **pure_ws_breakout**: 파라미터 변경 금지, Lane S (scalping baseline) 역할
  - Phase 1 중에도 계속 live (비교 기준)
  - Phase 3-4 에서 Lane T 결과를 Lane S 와 A/B 비교

### 2.4 Observability 유지

- `missed_alpha_observer` — Lane T 에도 동일 훅 확장 (reject + close site)
- `jupiter_rate_limit_metric` — Lane T 도 동일 metric 공유
- `wallet_delta_comparator` — 변경 없음

### 2.5 KOL Layer 자체 제약 (ADR §5.4)

- KOL 단독으로 Gate 통과 강제 금지 — Survival / drift / sell probe 모두 통과 필수
- KOL 진입 즉시 매수 금지 — Discovery trigger → gate pipeline 경유 필수
- KOL DB 자동 추가 금지 — 수동 편집 only
- KOL exit signal 카피 금지 — exit 는 자체 execution state machine
- Anti-correlation window 최소 60s

---

## 3. 재조정 대상 — Lane T (kol_hunter) 파라미터

### 3.1 초기 제안값 (Phase 3 paper 에서 iterate)

| 항목 | 현 pure_ws | **Lane T 초기값** | 근거 |
|------|-----------|-------------------|------|
| Probe (stalk) window | 30s | **120-300s (2-5min)** | Phase 2 consolidation 허용 |
| Hardcut MAE | -3% | **-10%** | memecoin 변동성 noise 흡수 |
| Flat band | ±10% | **±10%** (유지) | 변화 없음 |
| Flat exit timeout | 30s | **300s** | Stalk window 와 동기 |
| T1 MFE threshold | +100% (2x) | **+50%** (1.5x) | KOL 신뢰 → 빠른 승격 |
| T1 trail | 7% | **15%** | Phase 2-3 변동성 수용 |
| T2 MFE threshold | +400% (5x) | **+400%** (유지) | 사명 목표와 일치 |
| T2 trail | 15% | **20%** | Phase 3 변동 수용 |
| T2 breakeven lock | entry × 3 | **entry × 3** (유지) | 불변 |
| T3 MFE threshold | +900% (10x) | **+900%** (유지) | 불변 |
| T3 trail | 25% | **25%** (유지) | 불변 |
| T3 time stop | 없음 | **없음** (유지) | 불변 |
| Quick reject window | 45s | **180s** | Stalk 와 정합 |
| Quick reject degrade factor count | 2 | **3** (완화) | false negative 감소 |
| Hold-phase buyRatio collapse | 현값 | 현값 × 0.8 (완화) | Phase 3 microstructure 흔들림 허용 |

### 3.2 재조정 원칙

- 모든 값은 **env override 가능**
- `LANE_T_*` prefix 로 구분 (`PUREWS_*` 와 분리)
- Phase 3 에서 paper 50+ trade 관측 후 iterative tuning
- **Real Asset Guard 는 재조정 대상 아님** (§2.1)

---

## 4. 신규 파일 구조

```
src/
├── kol/                                  (신규 모듈)
│   ├── db.ts                            KOL DB 로더 (YAML)
│   ├── scoring.ts                       KOL score (Discovery trigger 판정용)
│   └── types.ts                         KolWallet, KolTier 등
│
├── ingester/
│   └── kolWalletTracker.ts              (신규) Helius WS 로 KOL tx 구독
│
├── orchestration/
│   └── kolSignalHandler.ts              (신규) Lane T 핸들러 (pureWsBreakoutHandler 구조 복사)
│
├── observability/                       (기존, 변경 없음)
│   ├── missedAlphaObserver.ts
│   └── jupiterRateLimitMetric.ts
│
data/
└── kol/
    └── wallets.yaml                     (신규) KOL DB

test/
├── kolDb.test.ts
├── kolWalletTracker.test.ts
├── kolScoring.test.ts
└── kolSignalHandler.test.ts

docs/
├── design-docs/
│   └── option5-kol-discovery-adoption-2026-04-23.md    (ADR)
├── debates/
│   └── kol-discovery-debate-2026-04-23.md              (대담)
└── exec-plans/active/
    └── 1sol-to-100sol.md                                (Phase O3 observability 등재 유지)
```

---

## 5. Phase 0: KOL DB 정제 (1-2일)

### 5.1 작업

- [ ] `data/kol/wallets.yaml` 구조 확정
- [ ] KOL 50-80 wallet 수동 입력
  - [ ] 운영자 GMGN / Axiom 스크린샷 기반
  - [ ] 각 KOL 의 본지갑 / 부지갑 / 벡터지갑 모두 포함
  - [ ] 동일 인물 address 그룹화 (KOL id 통일)
- [ ] 초기 tier 배정 (S / A / B)
  - 초기: 운영자 주관 판단. Phase 3 데이터로 재조정
- [ ] `last_verified_at` 필드에 오늘 날짜 기록
- [ ] 월간 재검증 루틴 계획 (Phase 5 이후 실 운영)

### 5.2 YAML schema

```yaml
kols:
  - id: pain
    addresses:
      - "HAN61K...96q6"            # 본지갑
    tier: S
    added_at: 2026-04-23
    last_verified_at: 2026-04-23
    notes: "Pain - 본지갑 (GMGN stake)"
    is_active: true

  - id: dunpa
    addresses:
      - "EwTNPY...Kgtt"            # 벡터지갑
      - "CNudZX...qHPc"            # 부지갑
    tier: S
    added_at: 2026-04-23
    last_verified_at: 2026-04-23
    notes: "던파 - 다중지갑"
    is_active: true
```

### 5.3 Acceptance

- [ ] 50 ≤ wallet count ≤ 80
- [ ] 전 KOL 에 tier / notes / is_active 명시
- [ ] 중복 address 없음 (역인덱스 검증)
- [ ] YAML parse 성공 (Phase 1 loader 로 검증)

### 5.4 Rollback

- KOL DB 가 50 이하로 부족 시 Phase 1 지연 (data 확보 우선)
- 운영자 리소스 부족 시 tier S (15-20 wallet) 로 축소 시작

---

## 6. Phase 1: KOL Wallet Tracker + Passive Logging (1주)

### 6.1 작업

- [ ] `src/kol/db.ts`: YAML loader
  - [ ] address → kol_id 역인덱스
  - [ ] hot reload 지원 (SIGHUP 또는 파일 watch)
  - [ ] 테스트: 1000 address lookup < 100ms
- [ ] `src/kol/types.ts`: KolWallet, KolTier enum, KolTx event
- [ ] `src/ingester/kolWalletTracker.ts`:
  - [ ] 기존 Helius WS 재활용 (`heliusIngester`)
  - [ ] KOL address set subscription
  - [ ] swap event 필터 → `(kol_id, token_ca, action, timestamp, tx_sig)` 추출
  - [ ] EventEmitter 로 candidate queue 발행
- [ ] Logging:
  - [ ] `${REALTIME_DATA_DIR}/kol-tx.jsonl` (crash-safe append)
  - [ ] `${REALTIME_DATA_DIR}/kol-candidates.jsonl` (gate 진행 기록)
- [ ] 기존 `pureWsBreakoutHandler` 에 영향 없음 (shadow only)
- [ ] Real Asset Guard 연결 (walletStopGuard, canaryAutoHalt 조회 가능)

### 6.2 KOL Discovery Trigger 동작

```
[Helius WS event]
    ↓
[address 매칭 — kol_id 반환]
    ↓
[swap event: kol_id, token_ca, action=buy, timestamp, sol_amount]
    ↓
[kol-tx.jsonl append]
    ↓
[Anti-correlation dedup (60s window)]
    ↓
[Candidate queue — Phase 2 에서 shadow eval 용]
    ↓
(Phase 1: 여기서 멈춤. Gate pipeline 연결은 Phase 3 에서)
```

### 6.3 Acceptance

- [ ] 7일 logging 후 `kol-tx.jsonl` ≥ 100 entries
- [ ] active KOL (최근 30일 tx 보유) 비율 ≥ 50%
- [ ] Helius WS rate limit 초과 0건
- [ ] KOL tx 감지 지연 ≤ 5s
- [ ] `pureWsBreakoutHandler` 회귀 0건

### 6.4 Rollback

- KOL tx rate 폭주 → rate limit 시: tier S 만 실시간, tier A/B 는 1분 polling 으로 degrade
- YAML parse 실패 → fail-open (KOL layer disabled, 기존 pipeline 그대로)

### 6.5 신규 env

```
KOL_TRACKER_ENABLED=true
KOL_DB_PATH=data/kol/wallets.yaml
KOL_HOT_RELOAD_INTERVAL_SEC=60
KOL_ANTI_CORRELATION_WINDOW_SEC=60
KOL_TX_LOG_PATH=data/realtime/kol-tx.jsonl
```

---

## 7. Phase 2: Shadow Eval — go/no-go First Filter (1주)

### 7.1 작업

- [ ] `scripts/kol-shadow-eval.ts` (신규):
  - [ ] `kol-tx.jsonl` 읽어 KOL 진입 tx 목록 추출
  - [ ] 각 tx 의 token_ca 에 대해 T+30s, T+5min, T+30min 시점 Jupiter price 조회
  - [ ] `missed_alpha_observer` 재활용 고려
- [ ] 통계 집계:
  - [ ] 조건 A: 모든 KOL 진입 → median / p50 / p90 의 future price delta
  - [ ] 조건 B: Multi-KOL 합의 (2+ 독립 KOL, 60s anti-correlation) → 동일
  - [ ] 조건 C: Tier S 포함 → 동일
- [ ] 비교 baseline:
  - [ ] 현 pure_ws 의 같은 기간 reject 후 trajectory (missed-alpha.jsonl)
  - [ ] KOL 진입 토큰의 trajectory 가 baseline 대비 우위인지

### 7.2 Acceptance (Go / No-go 기준)

**Go 조건 (모두 만족)**:
- [ ] KOL 진입 후 T+5min / T+30min 분포 **median > 0**
- [ ] Multi-KOL 합의 median > Single-KOL median
- [ ] Active KOL (최근 30일 tx) 비율 ≥ 70%
- [ ] Insider exit 지표: KOL 평균 hold ≥ 10분

**No-go (이 중 하나라도 해당)**:
- T+5min median ≤ 0 → KOL DB stale 또는 edge 부재
- Multi-KOL 합의가 오히려 낮은 median → chain forward 증거
- Active KOL < 50% → DB 재정제 필요
- KOL avg hold < 5분 → Insider exit 문제 심각

### 7.3 Go 시

- Phase 3 착수
- shadow eval report → `docs/phase2_kol_shadow_eval_2026_MM_DD.md`

### 7.4 No-go 시

- **옵션 5 기각 선언** (ADR §6 Gate 1 해당)
- 본 `REFACTORING_v1.0.md` archive → `REFACTORING_v1.0_rejected.md`
- 새 paradigm 논의 (옵션 4 full-stack 재설계 등)

---

## 8. Phase 3: kol_hunter Paper Lane (2주)

### 8.1 작업

- [ ] `src/orchestration/kolSignalHandler.ts` 신규
  - [ ] `pureWsBreakoutHandler` 구조 복사 (cupsey handler 복사 금지 원칙 유지)
  - [ ] state machine: PROBE(STALK) → T1 → T2 → T3 그대로
  - [ ] 파라미터: §3.1 Lane T 초기값
- [ ] Gate pipeline 연결 (Phase 1 passive → Phase 3 active):
  - [ ] KOL candidate → Security gate (기존) → Sell quote probe (기존) → Entry drift guard (기존)
  - [ ] 통과 시 paper entry (Phase 3 는 paper only)
- [ ] Observer 훅:
  - [ ] Pre-entry reject (survival / drift / sell probe) — 기존 `trackPureWsReject` 참고
  - [ ] Post-entry close (PROBE/T1/T2/T3 exit) — 기존 `trackPureWsClose` 참고
  - [ ] MFE peak + t1/t2/t3 visit timestamp — 기존 P2-4 필드 그대로
- [ ] Canary guardrails:
  - [ ] `canaryAutoHalt` 연결 (Lane T 용 별도 budget -0.3 SOL)
  - [ ] `canaryConcurrencyGuard` 전역 (pure_ws + cupsey + kol_hunter 통합 3)
- [ ] A/B 비교 설정:
  - [ ] Lane T (kol_hunter, paper) vs Lane S (pure_ws, 기존)
  - [ ] 같은 신호 window 에서 KOL 있/없음 비교
- [ ] 테스트:
  - [ ] `kolSignalHandler.test.ts` — state machine 단위
  - [ ] Integration — KOL tx → gate → paper entry → close 전체 경로

### 8.2 신규 env

```
KOL_HUNTER_ENABLED=true
KOL_HUNTER_PAPER_ONLY=true           # Phase 3 에서 강제 true
KOL_HUNTER_TICKET_SOL=0.01
KOL_HUNTER_MAX_CONCURRENT=3           # 전역 3 의 일부
KOL_HUNTER_STALK_WINDOW_SEC=180
KOL_HUNTER_HARDCUT_PCT=0.10
KOL_HUNTER_T1_MFE=0.50
KOL_HUNTER_T1_TRAIL_PCT=0.15
KOL_HUNTER_T2_MFE=4.00
KOL_HUNTER_T2_TRAIL_PCT=0.20
KOL_HUNTER_T2_BREAKEVEN_LOCK_MULT=3.0
KOL_HUNTER_T3_MFE=9.00
KOL_HUNTER_T3_TRAIL_PCT=0.25
KOL_HUNTER_QUICK_REJECT_WINDOW_SEC=180
KOL_HUNTER_QUICK_REJECT_FACTOR_COUNT=3
```

### 8.3 Acceptance

- [ ] Paper lane 30+ trade 누적
- [ ] **net 5x+ winner ≥ 1건 OR T2 visit ≥ 2건**
- [ ] Real Asset Guard 위반 0건
- [ ] Lane S vs Lane T 비교 report
- [ ] KOL Discovery candidate 의 survival gate 통과율 ≥ 50%

### 8.4 Rollback

- Paper 5x+ winner 0 AND T2 visit 0 → 파라미터 재조정 (1차)
- 재조정 후 2주 추가 paper → 여전히 실패 → 옵션 5 기각 (ADR Gate 2)

---

## 9. Phase 4: Live Canary 50 trades (2주)

### 9.1 작업

- [ ] `KOL_HUNTER_PAPER_ONLY=false` (운영자 명시 승인 후)
- [ ] ticket 0.01 SOL, max concurrent 3 (전역) 유지
- [ ] Canary budget -0.3 SOL cap (Lane T 전용)
- [ ] Live 50 trade 까지 halt 미발동 시 Phase 5 진행
- [ ] Telegram notification:
  - [ ] Lane T entry / exit / halt
  - [ ] 5x+ winner alert
- [ ] Daily 4 질문 답변에 Lane T metric 추가:
  - drift / survival / trade count / bleed per probe — Lane 별 분리

### 9.2 Acceptance

- [ ] Live 50 trade 누적
- [ ] **net 5x+ OR T2 visit ≥ 1건**
- [ ] 0.8 floor 위반 0건
- [ ] paper vs live gap (slippage / friction) 허용 범위
- [ ] `canary-eval.ts` Lane T report

### 9.3 Rollback

- 0.8 floor 근접 (< 0.85) 또는 budget -0.3 소진 → 즉시 halt
- 50 trade 내 5x+ winner 0 AND T2 visit 0 → Phase 3 재조정 복귀

### 9.4 ADR Gate 3 참조

- ADR §6 Gate 3 기준 그대로 적용
- No-go 시 Live 중단 → paper 복귀

---

## 10. Phase 5: Live 200 trades → Stage 4 Gate (4주)

### 10.1 작업

- [ ] Live 50 → 200 trade 확장
- [ ] Monthly KOL 재검증 루틴 1회 실행 (Phase 5 중)
- [ ] `canary-eval.ts --stage scale` 실행
- [ ] Stage 4 판정 (mission-refinement §5 Stage 4 기준)

### 10.2 Acceptance — Stage 4 판정

- **SCALE**: Lane T wallet log growth > 0 + Ruin prob < 5% + 5x+ winner rate 확정
- **RETIRE**: netSol ≤ 0 OR ruin prob ≥ 10% OR 5x+ winner = 0 이고 bleed 누적
- **HOLD**: 부분 만족 → Phase 5 연장

### 10.3 후속

- SCALE → 본 `REFACTORING_v1.0.md` archive (completed)
- RETIRE → Lane T 폐기 후 새 paradigm 검토
- HOLD → 추가 canary window

---

## 11. Test / QA Gate

### 11.1 Phase 별 Test

| Phase | Unit test | Integration | Regression |
|-------|-----------|-------------|------------|
| Phase 0 | YAML parse | — | — |
| Phase 1 | kol db / tracker / scoring | KOL tx → candidate queue | pure_ws 회귀 0 |
| Phase 2 | shadow-eval script | 과거 jsonl 기반 | — |
| Phase 3 | kolSignalHandler state machine | Full gate pipeline (paper) | pure_ws / cupsey 회귀 0 |
| Phase 4 | — | Live canary smoke | 전 lane 회귀 0 |
| Phase 5 | — | 200 trade stability | 전 lane 회귀 0 |

### 11.2 매 PR 기준

- [ ] `npx tsc --noEmit` clean
- [ ] `npx jest` 전체 pass (기존 pre-existing fail 제외 회귀 0)
- [ ] `docs/` 업데이트 (Phase report)
- [ ] Hard constraint 위반 검사 (ticket / floor / canary / cupsey 건드리지 않음)

---

## 12. Rollback Master List

| Trigger | Action |
|---------|--------|
| Phase 2 No-go (Gate 1) | 옵션 5 기각 → 본 문서 `_rejected` archive |
| Phase 3 재조정 2차 실패 (Gate 2) | 동일 |
| Phase 4 5x+ / T2 visit 0 (Gate 3) | Paper 복귀 → Phase 3 재조정 |
| Wallet < 0.85 SOL | 즉시 Lane T halt, manual review |
| KOL DB 해킹 / 유출 | 즉시 Lane T halt, DB 재정제 |
| Helius rate limit 초과 | tier degrade (S 만 실시간) |
| 운영자 수동 중단 요청 | 즉시 Lane T halt, paper 유지 |

---

## 13. 위반 방지 장치

### 13.1 Ticket / Floor / Budget 변경 시도
- Self-review 필수
- 48시간 cooldown 필수
- Git commit message 에 `[REAL_ASSET_GUARD_EXCEPT]` tag 필수
- 운영자 명시 승인 없이는 merge 금지

### 13.2 cupsey / pure_ws 개조 시도
- cupsey handler 코드 변경 금지 (CI check)
- pure_ws 파라미터 수정은 별도 PR + ADR 필수

### 13.3 KOL Layer 범위 초과 시도
- KOL score 단독 gate 통과 구현 시도 → reject
- KOL exit signal 카피 구현 시도 → reject
- 자동 KOL 추가 구현 시도 → reject

---

## 14. 진행률 요약 (실시간 업데이트)

> 매 Phase 진행 시 이 섹션에 간결한 현재 상태 기록. Phase 완료 시 `docs/phaseN_report.md` 링크 추가.

- **2026-04-23 Phase 3 full impl 완료** — 병렬 구현 sprint 2회. 925 jest pass, tsc clean.
  - `src/kol/paperPriceFeed.ts` — Jupiter quote 주기 polling + 429 방어
  - `src/orchestration/kolSignalHandler.ts` — FULL: stalk → PROBE → T1 → T2 → T3 + 5 close category + paper ledger (`kol-paper-trades.jsonl`)
  - `src/index.ts` — KolWalletTracker 'kol_swap' event → `handleKolSwap` 연결
  - tests: `kolSignalHandler` = 10 cases (stalk / probe / T1 / T2 / T3 / trail / multi-KOL / sell)
- **2026-04-23 Phase 0-3 scaffold 완료** — 병렬 구현 sprint 1회. 915 jest pass, tsc clean.
  - `data/kol/wallets.json` (운영자 채움 대기)
  - `src/kol/{types,db,scoring}.ts` — DB loader + hot reload + scoring (anti-correlation 60s)
  - `src/ingester/kolWalletTracker.ts` — Helius WS subscribe + wallet-perspective swap detection
  - `src/orchestration/kolSignalHandler.ts` — Phase 3 scaffold (paper-first gate)
  - `scripts/kol-shadow-eval.ts` — Phase 2 go/no-go 판정 CLI
  - `src/index.ts` bootstrap 연결 (env gate: `KOL_TRACKER_ENABLED=false` default)
  - `src/utils/config.ts` — KOL_* / KOL_HUNTER_* 20+ env 추가
  - tests: `kolDb` + `kolScoring` + `kolWalletTracker` = 25 cases all pass
- **다음 운영 단계**:
  1. 운영자: `data/kol/wallets.json` 에 50-80 KOL 수동 입력
  2. `KOL_TRACKER_ENABLED=true` 로 재배포 → Phase 1 passive logging 시작 (1주)
  3. `npm run kol:shadow-eval` 실행 → Phase 2 go/no-go 판정
  4. Go 시 Phase 3 full state machine 구현 착수 (현재는 scaffold)
- Phase 1 live: TBD (운영자 결정)
- Phase 2 결과: TBD
- Phase 3 full impl: TBD
- Phase 4: TBD
- Phase 5: TBD

---

## 15. 참조 문서

- `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md` — ADR (영구 결정)
- `docs/debates/kol-discovery-debate-2026-04-23.md` — 대담 기록
- `docs/design-docs/mission-refinement-2026-04-21.md` — 사명 최상위
- `docs/design-docs/mission-pivot-2026-04-18.md` — convexity pivot
- `LANE_20260422.md` — Lane fit 진단
- `20260423.md` — Dead liquidity / trending scalping
- `INCIDENT.md` — 관측 연표
- `docs/exec-plans/active/1sol-to-100sol.md` — 사명 roadmap

---

## 16. 한 줄 요약

> **KOL Wallet Activity 를 1st-class Discovery 로 격상하고, 자체 Execution 구조는 유지하되 Lane T 파라미터만 재조정한다.**
> **Real Asset Guard 는 전부 불변, cupsey 동결, pure_ws 는 Lane S (baseline) 로 존속.**
> **Phase 2 shadow eval 이 go/no-go 의 first filter**. 실패 시 옵션 5 즉시 기각.

---

*v1.0 2026-04-23 — Initial draft, Phase 0 착수 대기*
