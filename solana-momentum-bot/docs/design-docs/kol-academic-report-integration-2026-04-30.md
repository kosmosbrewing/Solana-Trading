# 학술 리포트 ↔ KOL Hunter 통합 ADR (2026-04-30)

> **작성일**: 2026-04-30
> **상태**: Sprint 1 + Sprint 2.A1 + F11/F3/F7 fix 완료. Sprint 2 후반 / Phase 3-4 보류.
> **출처**: 외부 전략가 학술 리포트 "KOL Hunter 를 위한 Kelly·손익비·손절 짧게 수익 길게 전략 연구" (2026-04-30)
> **상위 ADR**:
>   - `docs/design-docs/mission-refinement-2026-04-21.md` (사명 §3 — 0.7 SOL floor + 200 trades + 5x+ winner)
>   - `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md` (Option 5 paradigm)
>   - `docs/design-docs/external-strategy-report-analysis-2026-04-29.md` (1차 외부 리포트, 4-29)
>   - `docs/design-docs/lane-edge-controller-kelly-2026-04-25.md` (Kelly 엔진 ADR)
> **선행 ADR 으로 흡수된 항목 없음** — 본 문서는 신규 학술 리포트의 11개 권고를 코드 사실 기반으로 결정.

---

## 0. 문서 목적

학술 리포트의 11개 권고 (Full Kelly / Fractional Kelly / DRK / RCK / Optimal f / Stop-loss as risk reducer / MAE-MFE 동적 SL/TP / Time-in-market asymmetry / Trade anatomy 계측 / DSR-CSCV-PBO 검증 / Regime filter) 를:

1. **현재 코드 정합성** 정밀 측정 (이미 구축된 것 / 부분 구축 / 신규)
2. **사명 §3 leverage** 평가
3. **결정 매트릭스 영구 보존** (어떤 권고를 왜 채택 / 보류했는지)
4. **후속 sprint 트리거 조건** 명시 (보류 항목의 데이터 prerequisite)

코드 변경은 본 문서 결정에 따라 진행한 Sprint 1 / Sprint 2.A1 으로 정리. 본 문서는 **결정 근거의 영구 보존** 용.

---

## 1. 학술 리포트 핵심 통찰 요약

### 1.1 사명의 수학적 재정의 (학술 §Executive)
> "0.7 SOL floor 유지 + 200 live trades + 5x+ winner 만남 → 핵심은 공격적 Kelly 최적화가 아니라 생존성을 훼손하지 않는 비대칭 구조."

→ 우리 `docs/design-docs/mission-refinement-2026-04-21.md` 와 **100% 정합**. 새 paradigm 아님 — 같은 방향의 세부 강화.

### 1.2 핵심 명제 (학술 §학술 근거)
1. **Kelly 는 신호 생성기가 아니라 sizing 모듈** — Thorp/Ziemba/MacLean 의 1/2 Kelly 75% growth + 손실 확률 ↓ + Rising/Wyner 의 추정오차 shrinkage 효과
2. **"손절 짧게, 수익 길게" 는 조건부 명제** — Kaminski-Lo, IID 구간엔 stop 이 alpha 깎음, persistence 있을 때만 양수
3. **memecoin 은 미시구조가 먼저** — Solana memecoin rug/pump-and-dump 연구 + Solana 공식 priority fee/Jito tip/landing 문서 — exit route 가 사라지면 true Kelly = 0
4. **Time-in-market asymmetry** — AQR 137년 trend-following 연구 — 지속성 있는 승자에게 더 배정

---

## 2. 11개 권고 결정 매트릭스 (코드 사실 기반)

| # | 학술 권고 | 코드 정합 | Sprint 결정 | 후속 트리거 |
|---|---|---|---|---|
| **1** | Full Kelly | ✓ KOL 은 fixed `0.02 SOL` 유지 (sandbox lane) | **유지 — 학술도 "직접 적용 비권고"** | — |
| **2** | Fractional Kelly | ✓ portfolio: `riskTier.kellyScale=0.25` (Confirmed/Proven), `kellyCap=0.03~0.05`. KOL 은 sandbox 라 미적용 | **현 상태 유지** — 학술 권고 1/2 보다 1단계 보수 (1/4) 이미 작동 | KOL Stage 4 SCALE 시 portfolio 통합 검토 |
| **3** | Distributionally Robust Kelly | ❌ 미구축 | **보류 (Phase 4)** | paper n≥1000 + 5x≥3건 + uncertainty set 정의 후 |
| **4** | RCK (Risk-Constrained Kelly) | ❌ 미구축 (`walletStopGuard` 는 binary cutoff) | **보류 (Phase 3)** | 5x winner ≥ 3 / DSR Prob>0 ≥ 95% 통과 |
| **5** | Optimal f (Vince) | ❌ 미구축 | **비채택** — 학술도 "fat-tail 과소추정 위험" 비권고 | 영구 비채택 |
| **6** | Stop-loss as risk reducer | ✓ P1-1 winner-safe (mfe≥5% QR 비활성) | **Sprint P1-1 완료 (2026-04-30 P1)** | — |
| **7** | **MAE/MFE 기반 동적 SL/TP** | ⚠ universal `kolHunterHardcutPct=0.10` | **부분 통합** (P1 의 winner-safe 분기). 분위수 기반 hardcut 은 Sprint 1 데이터 누적 후 결정 | live n≥100 + winner MAE 분포 추정 가능 |
| **8** | Time-in-market asymmetry | ✓ scalper 180s / swing-v2 600s / smart-v3 path 별 timeout, insider-exit style-aware (4-29 P0-2) | **부분 정합** — swing TTL 학술 권고 1800-3600s 보다 짧음. env override 가능 | live winner 분포 측정 후 swing TTL 확장 결정 |
| **9** | Trade anatomy 계측 | ✓ 80% 구축 (mfe/mae/markout T+30/60/300/1800/7200/style/decimals). landing latency 만 missing | **Sprint 1.A3 완료** — `executor.ts` 의 `landingLatencyMs` 추가 | — |
| **10** | DSR/CSCV/PBO 검증 | ✓ `scripts/dsr-validator.ts` (paper-only) + `missed-alpha-retrospective.ts` + `kol-community-analyzer.ts` | **Sprint 1.B3 완료** — `--source=paper\|live\|both` flag + `kol-live-trades.jsonl` writer | — |
| **11** | Regime filter / Day Quality Index | ✓ `regimeFilter.ts` 존재. KOL lane 미통합 | **보류 (Phase 2)** — 외부 리포트 #7 (DQI) 의 후속 sprint 와 통합 | regime telemetry 1주 누적 후 |

### 2.1 추가로 학술 §exit two-layer 권고에서 도출한 신규 항목

| # | 학술 권고 | 코드 정합 | Sprint 결정 |
|---|---|---|---|
| **A1** | Structural kill-switch (no_sell_route / impact > 임계 / quote disappear → emergency exit, stop 보다 우선) | ❌ KOL lane 의 runtime sell quote 평가 미구축 | **Sprint 2.A1 완료 (2026-04-30)** — `kolHunterStructuralKill*` 5 config + `'structural_kill_sell_route'` 신규 close reason |
| **A2** | Partial take @ T1 (+40~60% 30~50% 부분 실현) | ✓ paper/live T1 partial helper 구축. live 는 별도 opt-in flag 필요 | **구현 완료, default OFF** — paper/live 동일 T1 trigger, live 실패 시 runner 보유 + pending full-close drain |
| **A4** | Post-close observer (KOL live close trajectory) | ⚠ paper close 만 wired, live close 누락 | **Sprint 1.A4 완료** — `kolMissedAlpha.ts` + `trackKolClose` |
| **B1** | Continuous DD throttle `λ_dd=((D_max-D_t)/D_max)^β` | ❌ binary halt 만 (`drawdownGuard.ts`) | **보류** — KOL fixed ticket 0.02 환경에서 효과 분리 측정 어려움 |
| **B2** | Winner-kill rate metric | ❌ 미구축 | **Sprint 1.B2 완료** — `scripts/winner-kill-analyzer.ts` |

---

## 3. 채택 항목 — 통합된 변경 (실측)

### 3.1 Sprint 1 (Telemetry / 측정 인프라)

| Sprint | 변경 | LOC |
|---|---|---|
| 1.A3 | `executor.ts` SwapResult 에 `landingLatencyMs` 추가 (Jito / Ultra / V6 standard 3 path 모두 측정) | +30 |
| 1.A4 | `kolMissedAlpha.ts` 신규 (`trackKolClose`) + `closeLivePosition` wiring (shadow arm 차단) | +110 |
| 1.B2 | `scripts/winner-kill-analyzer.ts` — 7일 paper 실측에서 winner-kill 3건 발견 (postMfe +41,678% / +2,085% / +1,388%) | +240 |
| 1.B3 | DSR `--source=paper\|live\|both` flag + `appendLiveLedger` (kol-live-trades.jsonl) | +110 |

### 3.2 Sprint 2.A1 (Structural Kill-Switch)

| Sprint | 변경 | LOC |
|---|---|---|
| 2.A1 | `kolHunterStructuralKill*` 5 config + `evaluateStructuralKillAsync` + `'structural_kill_sell_route'` 신규 close reason. shouldRunStructuralKillProbe pre-gate (peakDrift 0.20) + sellQuoteProbe runtime cache (30s) | +130 |

### 3.3 품질 fix (Quality QA)

| Fix | 변경 |
|---|---|
| F11 | `deleteActivePosition` 의 `structuralKillCache.delete(positionId)` — memory leak 차단 |
| F3 | `evaluateStructuralKillAsync` 의 `tokenDecimals == null` skip — 부정확 quote 차단 |
| F7 | live + enabled + impact>0.10 → kill 발화 positive case 회귀 테스트 |

### 3.4 누적 통계

```
변경 파일: 5 modified (executor.ts / config/kolHunter.ts / kolSignalHandler.ts /
              dsr-validator.ts / kolSignalHandler.test.ts) + 2 new (kolMissedAlpha.ts /
              winner-kill-analyzer.ts)
LOC delta: ~810
신규 회귀 테스트: 8건 (P1-2 reject/accept + P1-1 winner-safe pos/neg + P1.5 daily halt +
                   Sprint 2.A1 disabled/paper/live-fire)
Test 총합: 1202 (1194 baseline + 8 new)
Regression: 0
```

### 3.5 신규 운영 환경변수 (default 적용)

```bash
# Sprint 1.A3 (자동 측정 only — env 없음)

# Sprint 2.A1 — default ON
KOL_HUNTER_STRUCTURAL_KILL_ENABLED=true
KOL_HUNTER_STRUCTURAL_KILL_MIN_HOLD_SEC=60
KOL_HUNTER_STRUCTURAL_KILL_MAX_IMPACT_PCT=0.10
KOL_HUNTER_STRUCTURAL_KILL_CACHE_MS=30000
KOL_HUNTER_STRUCTURAL_KILL_PEAK_DRIFT_TRIGGER=0.20

# 이전 P0/P1 sprint 와 결합 (default 동작)
KOL_HUNTER_QUICK_REJECT_FACTOR_COUNT=2  # 운영자 적용 완료
KOL_HUNTER_QUICK_REJECT_WINDOW_SEC=120  # 운영자 적용 완료
KOL_HUNTER_SMART_V3_MIN_PULLBACK_PCT=0.20  # 운영자 적용 완료
KOL_HUNTER_SMART_V3_PULLBACK_MIN_KOL_COUNT=2  # P1-2 default
KOL_HUNTER_QUICK_REJECT_MFE_LOW_ELAPSED_SEC=15  # P1-1 default (이전 30)
KOL_HUNTER_QUICK_REJECT_PULLBACK_THRESHOLD=0.10  # P1-1 default (이전 0.20)
KOL_HUNTER_QUICK_REJECT_WINNER_SAFE_MFE=0.05  # P1-1 신규
```

### 3.6 Rollback path (긴급 시)

P1 + P1.5 + Sprint 2.A1 모두 무력화:
```bash
KOL_HUNTER_STRUCTURAL_KILL_ENABLED=false
KOL_HUNTER_QUICK_REJECT_MFE_LOW_ELAPSED_SEC=30
KOL_HUNTER_QUICK_REJECT_PULLBACK_THRESHOLD=0.20
KOL_HUNTER_QUICK_REJECT_WINNER_SAFE_MFE=999  # sentinel — 도달 불가
KOL_HUNTER_SMART_V3_PULLBACK_MIN_KOL_COUNT=1
# tradingHaltedReason 가드는 코드 변경이라 env rollback 불가 (재배포만 가능)
```

---

## 4. 보류 항목 — 후속 sprint 트리거 조건

### 4.1 RCK (Phase 3) — Risk-Constrained Kelly

**구현 비용**: ~300 LOC + bootstrap 검증 인프라
**트리거 조건** (모두 AND):
- live n ≥ 200 + paper n ≥ 1000 (DSR 통계적 유의성)
- 5x winner 실측 ≥ 3건 (tail 추정 신뢰도)
- DSR Prob>0 ≥ 95% (현 paper n=488: Prob>0=64.4%, FAIL)
- PBO < 0.5 (현 0.679, FAIL)
- 운영자 별도 ADR

**구현 방향**: `Prob(W_min < 0.7 SOL) < β` 직접 minimize. 학술 §RCK 권고 정합. wallet floor 보호 직접 강화.

### 4.2 DRK (Phase 4) — Distributionally Robust Kelly

**구현 비용**: ~500 LOC + uncertainty set 정의 + offline convex solve
**트리거 조건**:
- RCK 통합 후 6개월 데이터 누적
- regime / day-quality 분류 통계 신뢰도 확보 (Phase 2 #11 통합)
- 외부 ADR + 운영자 명시 승인

**비고**: 현 단계에서 도입 시 over-engineering 위험. 학술 리포트 자체도 "Phase 3-4" 명시.

### 4.3 Partial take @ T1 (A2) — RUNNER state machine 변경

**구현 비용**: ~200-400 LOC (Discovery 결과에 따라 schema 변경 시 더 큼)
**Discovery 필요 항목**:
1. `Trade.status` 의 `'OPEN'/'CLOSED'/'PARTIAL'` 확장 가능?
2. `walletDeltaComparator` 의 expected/observed 가 partial sell 정합?
3. `kolPaperNotifier` / `sendTradeClose` 가 partial close 지원?
4. `executed-buys.jsonl` / `executed-sells.jsonl` ledger record 형식 영향?
5. db schema (drizzle migration) 필요 여부

**트리거 조건**:
- Sprint 1 의 winner-kill rate metric 1주 누적
- live winner > 50% net 도달 케이스 ≥ 3건 (partial take 의 효과 측정 baseline)
- paper-shadow A/B (30%/50%/70%) 비교 후 결정

**예상 효과**: 5x winner 의 일부 lock-in. 학술 §exit asymmetry 권고. 현재 winner_trailing_t1 시 전량 close 의 위험 (4-29 GASyGb3F +154% trail 시 전량 close) 완화.

### 4.4 Continuous DD throttle (B1)

**구현 비용**: ~50-80 LOC (config + riskManager wiring)
**트리거 조건**:
- KOL canary 가 fixed ticket 외 dynamic ticket 으로 전환되는 시점
- 또는 portfolio level 의 wallet floor margin 측정값 < 0.05 SOL 지속 시 즉시 도입 (긴급)

**현 상태**: ticket fixed 0.02 SOL 환경에선 throttle multiplier 효과 분리 측정 어려움. 학술 §3 정합하나 implementation timing 보류.

### 4.5 MAE 분위수 기반 hardcut (#7 분위수 부분)

**트리거 조건**:
- live n ≥ 100 + winner cohort 분리 (mfe≥10% n≥10)
- per-style + per-regime conditional MAE quantile 추정 가능 시점
- Sprint 1 의 trade anatomy 데이터 1주 누적

**구현 방향**: `hardCut_probe = clamp(Q_0.8(MAE | winner, style, regime) + δ, 0.15, 0.30)` (학술 §exit two-layer 식 정합).

### 4.6 Regime filter / Day Quality Index (#11)

**트리거 조건**: 외부 리포트 4-29 의 #7 (DQI) sprint 와 통합. SOL 4H trend / breadth / follow-through 데이터 1주 누적 후.

### 4.7 Swing TTL 1800-3600s 확장 (#8)

**트리거 조건**: live swing-v2 winner 분포 측정 후. 현재 swing-v2 는 paper-only 라 데이터 부족. live canary 진입 후 결정.

---

## 5. 사명 §3 정합성 점검

| 사명 KPI | 학술 통합 후 효과 | 현재 상태 |
|---|---|---|
| Wallet floor 0.7 SOL | structural kill (Sprint 2.A1) + daily halt 가드 (P1.5) + tradingHalted 가드 → wallet floor margin 직접 강화 | **현재 wallet 0.731 SOL, margin 0.031 SOL** (1.5 trade) |
| 200 trade 누적 | 진입 게이트 강화 (P1-2 pullback minKolCount=2) → 빈도 ↓ but 품질 ↑ | live 49 / 200 = 24.5% (paper 포함 487) |
| 5x+ winner | winner-safe 분기 (P1-1) + structural kill 의 winner 보호 + post-close observer (winner-kill rate) | live 5x winner 1건 (4-28 GASyGb3F +940%) |
| Real Asset Guard | ticket 0.02 / canary cap -0.2 / structural kill / daily halt 다층 보호 | **모두 변경 없음** |

---

## 6. 통합 검증 기준 (배포 후 측정)

학술 §검증 프레임워크 권고 정합. **24h 후 측정**:

1. **DSR / CSCV / PBO 재실행**: `npx ts-node scripts/dsr-validator.ts --source=both --window-days=1`
2. **Winner-kill rate**: `npx ts-node scripts/winner-kill-analyzer.ts --window-days=1` — 학술 권고 임계 10-15% 이하
3. **Landing latency 분포**: `grep "landing=" logs/bot.log | awk` — sell tx 의 D-bucket (>30s) 빈도
4. **Structural kill 발화 빈도**: `grep "KOL_HUNTER_STRUCTURAL_KILL" logs/bot.log | wc -l` — 0 이면 cooldown 감소 필요
5. **Wallet drift**: WALLET_DELTA observed/expected — 변경 없어야 (`drift < 0.01 SOL` 유지)

**1주 후 측정**:
- 49 trades → 100 trades 누적 — Sprint 1 데이터 prerequisite 도달 시 Sprint 2 후반 (A2 / B1 / #7) 결정

---

## 7. 의사결정 이력 (append-only)

| 일자 | 결정 | 근거 |
|---|---|---|
| 2026-04-30 | Sprint 1.A3/A4/B2/B3 + Sprint 2.A1 통합 | 학술 §exit two-layer + §검증 프레임워크 권고 정합 |
| 2026-04-30 | Partial take (A2) 보류 | DB schema / wallet ledger 영향 Discovery 필요 |
| 2026-04-30 | RCK (Phase 3) 보류 | DSR FAIL (Prob>0=64.4%, PBO=0.679), 5x winner=1, 데이터 부족 |
| 2026-04-30 | DRK (Phase 4) 보류 | RCK 후 6개월 검증 |
| 2026-04-30 | Optimal f 영구 비채택 | 학술 권고대로 fat-tail 과소추정 위험 |
| **2026-05-01** | **Phase A.1 — winner-kill-classifier** | scripts/winner-kill-classifier.ts. price/structural/insider/winner/orphan/other 6 카테고리. 7일 baseline 결과: **price-kill 비중 66.7% (2/3 winner-kill), avg postMfe 21,882%** → Phase C 진입 정량 근거 충족 |
| **2026-05-01** | **Phase B — Discovery (sub-position 패턴)** | DB schema 변경 0 결정. walletDeltaComparator (sells - buys ledger) 정합. notifier 영향 0 |
| **2026-05-01** | **Phase C — tail retain paper-shadow 구현** | `'TAIL'` state 신설 + 3 close reason (`tail_trail_close` / `tail_max_hold` / `tail_winner_capture`) + 4 config (`kolHunterTailRetain*`). default OFF (paper-shadow 1주 측정 후 활성화 ADR). 학술 정합: Kaminski-Lo + Taleb convexity + TSMOM. 회귀 테스트 3건 |
| **2026-05-01** | **Phase D — live tail 코드 구현 (flag 로 조정)** | `kolHunterTailRetainLiveEnabled` 신규 config (default false). `spawnTailSubPosition` 의 isLive 분기 + `closeLivePosition` 의 partial sell 분기 (sellAmount = tokenBalance × 0.85). actualExitPrice / dbPnl / walletDelta 모두 sold 비중 정합. **paper-shadow 1주 측정 후 flag ON 만으로 live 작동**. live 활성 prerequisite (별도 ADR): paper n≥7day + DSR Prob>0≥95% + wallet floor margin>0.05. 회귀 테스트 2건 (paper precedes live + parent isLive=false 강제) |
| **2026-05-01** | **Phase 2.A2 P0 — Partial Take @ T1 promote** | `kolHunterPartialTake*` 3 신규 config (default false). T1 promote 시 30% lock-in + 70% runner 잔존. `partialTakeAtSec`/`partialTakeT1AtSec` marker 로 재실행 방지. `appendPartialTakeLedger` jsonl. F1 fix (recovery 시 RUNNER_T1+ marker set). 2026-05-12 보강: live T1 partial sell opt-in 구현, 실패 시 runner 수량 유지 + pending full-close drain, rotation flow reduce 와 `partialKind` 분리. 학술 §convexity (Taleb / Carver / Moskowitz). 7일 paper Top 10 의 8/10 retreat 70%+ 직접 차단 lever |
| **2026-05-01** | **Canary cap 조정 — Stage 4 promotion review gate** | KST 13:53 budget exhausted (`-0.2672 <= -0.2`) 영구 halt 발화 (auto-reset 거부, 자산 보호 정책). 운영자 한도 상향: `KOL_HUNTER_CANARY_MAX_TRADES` 50→200 (사명 §5 의 200 trade gate 정합), `KOL_HUNTER_CANARY_MAX_BUDGET_SOL` 0.2→0.3 (cumulativePnl -0.2672 + margin 0.03). 재시작 시 hydrate 152 trade + 신규 한도 비교 → halt 자동 클리어 |
| **2026-05-02** | **KOL canary 표본 연장** | 운영자 결정: `KOL_HUNTER_CANARY_MAX_TRADES` 200→300, `KOL_HUNTER_CANARY_MAX_BUDGET_SOL` 0.35 운영값 유지. startup `[REAL_ASSET_GUARD]` 에 공용 cap 과 KOL 전용 cap/trade/ticket/hydrate window 를 모두 출력해 cap 혼동 방지 |
| **2026-05-01** | **Decu Quality Layer Phase B (observe-only 골격)** | 별도 ADR: `decu-new-pair-quality-layer-2026-05-01.md`. 8 sub-task 병렬 구현 — 5 module (`tokenQualityInspector` / `holderDistribution` / `vampLint` / `globalFeeObserver` / `devWalletRegistry`) + report script + boot wiring + paper/live entry wiring + 5 단위 테스트. codex 피드백 4건 즉시 fix (cohort dedup / 4-jsonl join + winnerKill / RPC cap placeholder / 수치 정정). 7 신규 env. enrichment 는 Phase B.1.5 follow-up sprint |

---

## 8. Open questions / limitations

학술 리포트의 한계 (§Open questions) 인용:
> "실거래 데이터가 주어지지 않아, hard-cut 재설정값·style별 holding budget·5x winner용 MAE/MFE quantile은 문헌 기반의 초기 제안일 뿐이다. 특히 5x tail은 희소하므로, 실제 최적값은 최근 30일 trades와 markout 로그를 받아 bucket별 shrinkage 추정으로 다시 계산해야 한다."

본 ADR 의 답:
- 채택 항목 (Sprint 1+2.A1) 은 **데이터 prerequisite 없이도 안전한 default-ON** (env override 가능)
- 보류 항목 (RCK / DRK / 분위수 기반 hardcut / partial take) 은 **데이터 누적 후 별도 ADR + paper-shadow A/B 검증** 필수

본 문서는 **2026-04-30 시점의 의사결정 snapshot**. 후속 sprint 마다 §7 의사결정 이력 append + 트리거 조건 충족 시 §4 항목 별도 ADR 로 승격.
