# INCIDENT / BACKLOG Log

> 운영 중 발견된 이슈·병목·미완 과제의 연대기 기록.
> Authority: `docs/design-docs/mission-refinement-2026-04-21.md` 기준으로 우선순위 판정.
> 이 문서는 **사실 기록**이다 — 판단 근거 / 관측 데이터 / 미해결 gap 이 모두 남아야 한다.

---

## 2026-04-28 (오후-저녁) — KOL Live Canary 본격 활성화 + B안 ticket 결정 + 8JH1J6p4 incident

### 1. 누적 코드 변경 (commit 미수행, working tree 18 파일 / +1474 LOC)

#### Sprint 1A — Hold-phase sentinel 임계 완화
- `KOL_PAPER_HOLD_PHASE_PEAK_DRIFT_THRESHOLD` (hardcoded 0.30) → **`config.kolHunterHoldPhasePeakDriftThreshold` (default 0.45, env override 가능)**
- 근거: paper n=401 mfe 200%+ 9건 중 **4건 sentinel 컷** (8ipcTXum 246%→108% / HqyQHwQv 207%→98% / ssFb5yQU 215%→116% / EjY599u1 230%→42%)
- 영향: drift 31-40% 케이스 보호, 50%+ 심각 cases 는 여전히 cut

#### Sprint 2A — KOL live position recovery
- `recoverKolHunterOpenPositions(ctx)` 신규 (~143 LOC, kolSignalHandler.ts)
- cupsey/pure_ws 패턴 모방: orphan/dust/RPC fail/state inference (PROBE/T1/T2/T3)
- 8 통합 테스트 케이스 PASS
- `runLaneRecoveries.ts` wiring (config.kolHunterEnabled gate)

#### Sprint 2 Task 3 — KOL-specific canary cap (independent from 공유)
- `kolHunterCanaryMaxBudgetSol` / `MaxConsecLosers` / `MaxTrades` 신규
- B안 적용 후 **0.2 / 5 / 50** (ticket 0.02 비례)
- `canaryAutoHalt.readConfig('kol_hunter')` 분기 추가

#### Sprint 2 Task 4 — KOL live canary E2E integration tests + F1/F2 source defect fix
- 6 E2E 테스트 케이스 (winner trail / executeBuy throw / executeSell throw / ORPHAN / canary slot / close race)
- **F1 fix** (CRITICAL): `closePosition` 가 mutation 후 capture → sell 실패 시 state 영구 'CLOSED' 잠금. callerPreviousState param 추가, mutation 전 capture.
- **F2 fix** (HIGH): "60s cooldown" 이 entry-since check 였음 → entry 직후 sell 실패 critical 미발사. lastCloseFailureAtSec 필드 + cupsey/pure_ws 패턴 동일.

#### Sprint 3 — Inactive KOL shadow track
- `KOL_HUNTER_SHADOW_TRACK_INACTIVE` flag (default false), inactive 28명 별도 subscribe
- `kol-shadow-tx.jsonl` 별도 logger, kolSignalHandler 호출 0 (entry 영향 0)
- Helius 429 risk MEDIUM (활성화 전 quota 확인 필수)

#### KOL DB v6 → v7 — 7 신규 candidate
- 4 active 승격: `degenerate_brian` (5x bucket=1 입증) / `noob_mini` PROVISIONAL / `limfork_eth` PROVISIONAL / `yenni` PROVISIONAL
- 2 observe-only B: `fz7` (promotion candidate) / `cowboybnb` (ticket 4.23 SOL 영구 보류)
- 1 REJECT: `qavec` (Solana Explorer creator 필드 노출 = Doji 패턴, operator/dev overlap)
- Active 35 → **39** (S 4 + A 35), inactive 28명

### 2. Ticket scaling 진로 (3단계)

| 단계 | Ticket | floor | KOL canary cap | 적용 시각 | 근거 |
|---|---|---|---|---|---|
| 초기 | 0.01 SOL | 0.8 SOL | 공유 0.3 | F5 hard lock 정책 | 외부 트레이더 피드백 |
| **A안** | 0.03 SOL | 0.8 SOL | 0.3 SOL | 오후 초반 | paper n=401 / 5x+ winner 1건 입증 후 3x scale |
| **B안 (현재)** | **0.02 SOL** | **0.7 SOL** | **0.2 SOL** | 오후 후반 | live 24h n=44 ROI -2.55% + catastrophic 4.5% 후 후퇴 |

#### Per-lane policy max 도입
- `policyGuards.ts:POLICY_TICKET_MAX_SOL_BY_LANE = { kol_hunter: 0.02 }` 신규
- `getPolicyMaxForLane(lane)` helper
- 다른 lane (pure_ws / cupsey / migration / pure_ws_swing_v2) 0.01 정책 그대로 유지
- KOL 만 별도 max — Stage 4 partial (paper proof) 인정

### 3. B안 산정 근거 (200-trade Stage 4 여정 시뮬)

**Live 24h 데이터 (n=44, ticket 0.03 산 결과)**:
- Win rate 27.3% (12W / 32L)
- avg WIN +86.42% (paper +46% 의 1.87x)
- avg LOSS -32.95% (paper -12.69% 의 **2.6x 악화**)
- avg per-trade **-2.55%** (bleeding 중)
- Catastrophic **4.5%** (-100% PNL_DRIFT 2건/44, 8JH1J6p4 incident 포함)
- Best gain +244.27%

**Live raw Kelly = 0.00%** ← -100% tail 이 log-growth 음수화. Kelly 수학적으로는 trading 중단 권고.

**B안 시뮬 (200 trade)**:
- Catastrophic 9건 × 0.02 = 0.18 SOL
- Bleed 200 × 2.55% × 0.02 = 0.102 SOL
- 합계 drawdown ≈ 0.282 SOL → wallet **0.718 SOL** (floor 0.7 +0.018 margin)
- Catastrophic 견딤: 15 events (예상 9건 + 6 buffer)

**100-trade 자동 재평가 분기**:
- catastrophic rate < 2% AND ROI > 0% → **0.025 승격 검토**
- catastrophic rate ≥ 4% (개선 없음) → **0.015 후퇴**
- ROI 양수 + 5x+ winner ≥ 1건 live 입증 → Stage 4 SCALE gate ADR 진입

### 4. Ralph-loop 6 iter (API 병목 P0/P1 fix)

| Iter | Priority | 변경 | 효과 |
|---|---|---|---|
| 1 | P0 | KOL inflight dedup (`inflightLiveEntry` Set) | live entry duplicate 차단 |
| 2 | P0 | Notifier fire-and-forget (4 lane × open + 3 lane × close, 7 sites) | Telegram 429 entry/exit blocking 0 |
| 3 | P0 | Exit RPC 병렬 (`Promise.all([getTokenBalance, getBalance])`) | ~250ms 단축 |
| 4 | P0 | Jupiter 429 backoff [5,15,45,60,60] → [2,5,15,30,60] | **185s → 112s (39% 단축)** |
| 5 | P1 | waitForFirstTick 10s → 5s | worst case 50% 단축 |
| 6 | P1 | sellQuoteProbe TTL cache | **N/A** (이미 구현됨, audit claim 잘못) |

### 5. 8JH1J6p4 Incident (live canary 첫 운영 사고, 11:54-12:02 UTC)

**Token**: `8JH1J6p43XYm1zUo3ZYfFqeBkmPQ5362JpKC3xH5CV5p`

**5중 cascade 실패**:
1. **Security gate bypass** — "Invalid param: not a Token mint" 오류에도 `kolHunterSurvivalAllowDataMissing=true` 통과 (Token-2022/비표준 program 검증 0)
2. **Smart-v3 score fooled** — KOL exit 직전 pullback 을 "기회" 로 해석 (score 4.98/5.96)
3. **Jupiter 429 entry cascade** — pos `1777377286` trigger 11:54:46 → fill 11:57:59 = **3분 13초 delay**, mae -77.73% 까지 하락 후 매수
4. **0.03 ticket scale 영향** — 각 손실이 0.01 ticket 대비 3배. 합계 wallet **-0.0754 SOL** (2.5x ticket)
5. **Sell 429 cascade** — pos `1777377286` close "Swap failed after 3 attempts: 429" → retry success 까지 ~3-4분

**정량**:
- pos `1777377322`: walletDelta -0.0552 / receivedSol = **-0.0230 (negative!)** / **PNL_DRIFT 0.0498**
- pos `1777377286`: walletDelta -0.0202 / hold 407s / mae -77.73%
- wallet_delta_warn drift -0.0603 SOL (PNL_DRIFT 가 주된 기여)

**잔여 권고**:
- ⚠️ Token blacklist (8JH1J6p4 quarantine)
- ⚠️ `KOL_HUNTER_SURVIVAL_ALLOW_DATA_MISSING=false` 운영 변경 — "not a Token mint" 자동 reject
- ⚠️ Same-mint cooldown (5분 내 재진입 차단)
- ⚠️ Smart-v3 trigger 시 observe 윈도우 KOL SELL 발생 시 trigger 무효화

### 6. Quality 점검 패턴 — agent grep 단독 한계 노출

자체 quality check 에서 직전 audit agent 의 false claim **4건** 발견:
- "Jupiter 18k/min 부하" → 실측 ~186/min (free tier 31%)
- "Helius onLogs unbounded" → 실제 maxFallbackQueue=200 cap
- "sendTradeOpen .catch() 누락" → 실제 모든 사이트 .catch() 있음
- "sellQuoteProbe cache 부재" → 실제 quoteResultCache + quoteInFlight + rateLimitedUntilMs 3-layer 구현

**교훈**: agent grep 단독 검증은 부분 context 누락 → false positive. critical claim 은 직접 read + cross-check 필수.

### 7. 검증

- tsc clean
- jest **1101/1101 pass** (regression 0, 새 테스트 +95: recovery 8 + E2E 6 + KOL canary cap 4 + sentinel relax + KOL ticket policy + shadow 4)

### 8. 운영 적용 절차

`.env` 변경 **불필요** (코드 default 모두 적용). 재배포만으로:
- ticket 0.02 SOL
- wallet floor 0.7 SOL
- KOL canary cap 0.2 SOL
- sentinel peak drift 0.45
- 429 backoff 단축
- live position recovery
- F1/F2 fix 운영 반영

운영자 명시 변경 권고:
- `KOL_HUNTER_SURVIVAL_ALLOW_DATA_MISSING=false` (8JH1J6p4 같은 incident 차단)
- `KOL_HUNTER_LIVE_CANARY_ENABLED=true` + `KOL_HUNTER_PAPER_ONLY=false` (live canary 의도적 활성화 시)
- (선택) `KOL_HUNTER_SHADOW_TRACK_INACTIVE=true` (inactive KOL 활동량 관측)

### 9. 미해결 / 별도 sprint

- **PNL_DRIFT root cause 진단** — 2/44 의 -100% events (sell-side fee + Jito tip + slippage 분해 필요)
- **Same-mint 5분 cooldown** — 8JH1J6p4 같은 동시 2 position 진입 방지
- **Smart-v3 KOL SELL trigger guard** — observe 윈도우 내 KOL exit 시 trigger 무효화
- **Token blacklist file** (`data/quarantine.jsonl` 등 영구 차단 시스템)
- **commit/push** — 누적 working tree 18 파일 / +1474 LOC, 운영자 승인 대기
- **probe_hard_cut threshold A/B simulation** — 미구현 (paper-trades.jsonl 95건 24h 으로 분석 가능, script 도구화 필요)
- **swing-v2 hurdle 완화 A/B** — minKolCount 2→1 + score 5.0→4.0, 24h paired observation 후 결정
- **Trending Sniper / pure_ws retire** — 의도된 보류, 5x winner 추가 누적 후 재평가

---

## 2026-04-28 — 우선순위 8 항목 진척 점검 (코드 audit)

직전 우선순위 표(P0~P3 9항목 + 티켓 금액)를 코드/데이터로 직접 검증 → 다수가 이미 완료. 진척표:

| 순위 | 항목 | 상태 | 검증 근거 |
|------|------|------|---------|
| **P0** | 5x+ winner 가설 3종 검증 | 🟡 **부분 진행** | 24h 에 5x winner **1건 첫 돌파** (`DF7DAPat` mfe+940%). 가설 (A) trail/sentinel 보수성 = 정량 증거 (Top-5 mfe 중 3건 sentinel 컷, capture 29%). 가설 (B) entry timing = 보조 증거 (smart_v3_price_timeout 1644건, 38.3%). **observer 가용 (R2 false positive 정정 2026-04-28) — 가설 (B) 정량 측정 가능** |
| **P1** | KOL live position recovery (`src/state/recovery.ts`) | ✅ **완료** | `kolSignalHandler.ts:2141 recoverKolHunterOpenPositions` 구현. 8 테스트 케이스 (orphan / dust / paper mode / RPC fail / state inference) PASS. setupShutdown 통합은 별도 wiring 필요 (검증 미실시) |
| **P1** | KOL-specific canary cap config (공유 0.3 → 별도) | ✅ **완료** | `walletAndCanary.ts:30-32`: `KOL_HUNTER_CANARY_MAX_BUDGET_SOL=0.1` / `KOL_HUNTER_CANARY_MAX_CONSEC_LOSERS=5` / `KOL_HUNTER_CANARY_MAX_TRADES=50`. `canaryAutoHalt.ts:75-83` 에서 lane='kol_hunter' 분기 적용 ✓ |
| **P2** | inactive KOL paper shadow 측정 (Option A) | ✅ **완료** | `kolWalletTracker.ts:56 shadowTrackInactive` flag + `getAllInactiveAddresses()` + `shadowAddresses` Set + 별도 `kol-shadow-tx.jsonl` 라우팅. handleLog 가 active vs shadow 분기 ✓ |
| **P2** | Trending Sniper 신규 lane | ⏸ **보류 (의도)** | 코드 변경 없음. KOL root cause 검증 선행 — 5x winner 추가 누적 후 재평가 |
| **P3** | pure_ws lane retire 결정 | ⏸ **보류 (의도)** | 코드 변경 없음. swing-v2 paper shadow 데이터 누적 후 |
| **P3** | KOL live integration tests | ✅ **완료** | test/kolSignalHandler.test.ts 의 17 통합 케이스: triple-flag gate (5) + smart-v3 trigger live wiring (4) + recovery (8). executor.executeBuy 직접 호출 검증 |
| **P3** | probe_hard_cut threshold A/B simulation | ❌ **미구현** | simulation script 없음. paper-trades.jsonl 의 95건 (24h) 으로 직접 분석 가능하나 도구화 필요 |
| **P3** | swing-v2 hurdle 완화 A/B (multi-KOL ≥2 → ≥1 + score ≥4.0) | ❌ **미구현** | `minKolCount=2 / minScore=5.0` default 그대로. 24h paired observation 57 pairs / swing-v2 +0.034 SOL 데이터 더 누적 후 |
| **(보너스)** | 티켓 금액 hard lock | ✅ **이미 구현됨** | `policyGuards.ts:28 POLICY_TICKET_MAX_SOL=0.01` + 초과 시 force revert + Telegram critical. 운영자 ack `stage4_approved_YYYY_MM_DD` 형식 엄격 검증 |

### 진척 요약

- **완료 5건**: KOL recovery / KOL canary cap / inactive KOL shadow / KOL live integration tests / 티켓 금액 hard lock
- **부분 진행 1건 (P0)**: 5x winner 1건 첫 돌파 + 가설 (A)/(B) 정량 증거. 단 가설 (B) 직접 측정 도구 (observer) dead
- **보류 2건 (의도)**: Trending Sniper / pure_ws retire — 데이터 누적 단계
- **미구현 2건 (P3, follow-up)**: probe_hard_cut A/B simulation / swing-v2 hurdle 완화

### 미흡 / 위험 — 운영자 확인 필요

| # | 항목 | 위험 | 권고 |
|---|-----|------|------|
| **R1** | ~~`recoverKolHunterOpenPositions` wiring~~ | ✅ 검증 완료 | `src/init/runLaneRecoveries.ts:44 await recoverKolHunterOpenPositions(ctx)` 호출 wiring 정상 |
| ~~**R2**~~ | ~~missed-alpha observer dead~~ | **FALSE POSITIVE 정정 (2026-04-28 ralph-loop P0-P3)** — schema 오해. record 의 field 는 `probe` 단일 객체 / `observations` array 가 아니었음. 직접 검증 결과 **8910/8910 = 100% probe 데이터 보유**, observer 정상 작동. 6h 1079 records 도 동일. 가설 (B) entry timing 측정 가능 ✓ — 별도 sprint 불필요 | resolved |
| **R3** | wallet_delta_warn drift 0.118 SOL spam (5분 × 6회 dedup 미작동) | critical alert 무딘화 + drift origin 불명 (paper-only인데 main wallet 변동) | `walletDeltaComparator` dedup/cooldown 코드 점검 + `ops:reconcile:wallet` 으로 drift origin 추적 |
| **R4** | 24h 5x winner 1건의 single-winner 의존도 66% (+0.094 / +0.142) | 표본 부족 — 1건이 paper test 의 통계적 한계 | 추가 5x winner 1-2건 누적까지 ADR 작성 보류 권고 (선택 A 정합) |
| **R5** | KOL_HUNTER_CANARY_MAX_BUDGET_SOL=0.1 SOL 의 의미 점검 | ticket 0.01 × 50 trades = 최대 0.5 SOL 노출이지만 budget 0.1 SOL 도달 시 즉시 halt → 평균 −2% net 이상 시 10 trade 안에 budget 소진 가능 | 실제 24h 데이터로는 net +0.142 SOL 흑자라 0.1 SOL budget 충분. 단 첫 1-3 trade 가 즉시 hard_cut 만 발동하면 7-8건 만에 halt 가능 (avg hard_cut −2.0%/0.01 = −0.0190 → 5건이면 −0.095 ≈ budget 한계) |
| **R6** | 티켓 0.01 SOL × 첫 1-3 trade 안전 한계 | hard_cut 평균 −19.5% 손실 = 1건당 −0.00195 SOL. 5건 연속 loser 시 −0.00975 SOL → consec losers cap 5 도달로 halt | 안전망 작동 ✓. 단 운영자 첫 morning-stop 윈도 권고 |

---

## 2026-04-29 — 분석 무결성 체크리스트 등재 + 9h log 분석 6 critical finding 정정

### 1. 직전 9h 분석 (2026-04-28 14:40~23:40Z) 의 6 critical finding

| # | 직전 claim | 검증 결과 | Severity |
|---|---------|---------|---------|
| F1 | "5x winner 첫 돌파 (live 4y1gkKzC +487%)" | **❌ 정의 위반** — paper mirror 의 mfePctPeak=102% (5x 미달). +487% 는 wallet axis netPct 이지 mfe 아님. **mfe ≥ +400% 5x winner 0건** (paper/live) | CRITICAL |
| F2 | "paper 3.5h 정지" | **❌ schema 오해** — paper-trades.jsonl 의 last 8건이 모두 `kolh-live-*` (live mirror). 실제 paper-only **7h 정지** (16:53 이후) | HIGH |
| F3 | "paper 16건" | **mixed pool** — paper-only 8건 + live mirror 8건 | HIGH |
| F4 | "Single-winner 5145% 의존도" | misleading 수학 — total small 이라 비율 inflated. 정확: winner +0.108 SOL, 그 외 16건 cum −0.106 SOL = winner 빼면 net loss | MEDIUM |
| F5 | "Sprint A1 효과 100%" | **부분 검증** — sendCritical 0 사실, 단 dedup vs drift recover 미구분 (bot.log stale) | MEDIUM |
| F6 | "Phase 1 over-close 가능성" | schema 정정 후 paper-only 7h 정지가 진짜 — root cause 진단 필요 | MEDIUM |

### 2. 운영 사실 (정정 후)

| 지표 | 9h 값 |
|------|-------|
| Live trades | 17건 / wallet net **+0.0021 SOL** |
| Live winners (wallet axis +) | 4건 (24%) — 1건 net+487% (winner +0.108) |
| Paper-only trades | 8건 (16:27~16:53) + 7h 정지 |
| **mfe ≥ +400% 5x winner** | **0건** (paper / live 모두) |
| Sprint A1 (drift dedup) | sendCritical 108→0 (dedup OR recover, 미구분) |
| Sprint B1 (429 retry) | 44→8 (80% 감소) |
| `kol_live_close_failed` | 8건 / 5 unique pos / `FXB6a9Di` 3회 retry |

### 3. 분석 무결성 체크리스트 (12 항목) 등재

`SESSION_START.md §6-bis` 에 등재. 향후 KOL_HUNTER 분석 보고서 작성 시 체크 의무:

- **Time**: UTC 기준 / `date -u` 명시
- **Schema**: paper-only vs live mirror positionId 분리 / probe 단일 객체 (observations array 아님) / executed-* 에 mfe 부재
- **Axis**: ticket axis 금지, wallet axis / 5x = mfe 정의 / paper 단위 차이
- **Statistical hygiene**: single-winner 의존도 / cohort 95% CI / 시뮬 hold-side 가정
- **Cross-check**: Sprint before/after / 외부 claim 직접 검증 / INCIDENT false positive

→ 매 보고서 첫 줄 "체크리스트 12/12 통과" 명시 권고.

### 4. P0 진단 결과 — Paper-only 7h 정지 = **false positive (의도된 정책 효과)**

24h hourly cross-check:

```
03:00 paper=13, live=1   livecanary 비활성 (paper dominant)
04:00 paper=0,  live=9   ← 13:29 livecanary 활성 후 분기 변경
04~14 paper=0~4, live=2~15  livecanary dominant
16:00 paper=8 (일시 fallback — wallet stop / entry halt 흔적)
17:00~ paper=0 영구
```

**Root cause** (`kolSignalHandler.ts:824` `evaluateSmartV3Triggers`):
```ts
if (isLiveCanaryActive() && botCtx && !candIsShadow) {
  await enterLivePosition(...);  // 모든 non-shadow cand → live
  return;
}
await enterPaperPosition(...);  // shadow KOL 또는 fallback 만
```

→ livecanary 활성 시 **paper-only 분기는 의도된 dead path**. shadow KOL (Option B) 또는 wallet_stop / entry_halt fallback 시에만 paper 진입. 16:00 의 paper=8 spike 는 일시적 fallback 흔적.

**처리**:
- ✅ 신규 sprint 불필요 (의도된 정책)
- ✅ SESSION_START.md §6-bis 체크리스트 (paper-only vs live mirror 분리) 가 향후 false positive 차단
- ⚠ 측정 도구 (`kol-paper-arm-report.ts` 등) 가 paper-only ledger 와 live mirror 분리해서 read 하는지 점검 필요 (별도 sub-task)

### 5. P1 — bot.log freshness 검증 sync 자동화

**Root cause**: `sync-vps-data.sh` 가 logs/ 전체 rsync 하지만 sync 후 freshness 검증 없음 → 운영자가 sync 안 돌렸거나 VPS 봇 down 시 stale data 로 분석 진행.

**Fix** (`scripts/sync-vps-data.sh`):
```bash
LOG_FRESHNESS_THRESHOLD_SEC=1800  # 30분 default, env override
# sync 후 logs/bot.log mtime vs NOW 비교 → 30분 이상 stale 시 WARNING + 봇 상태 확인 권고
```

- macOS (BSD) / Linux (GNU) `stat` 양쪽 호환
- threshold env override 가능 (`LOG_FRESHNESS_THRESHOLD_SEC=300` 등)
- 직전 incident (logs/bot.log 20:16Z stale) 같은 패턴 자동 감지
- bash syntax 검증 통과 + 현재 stale (755min old) 시나리오 dry-run 정합

### 6. Hourly KST snapshot + close 알림 일관성 fix (2026-04-29)

**운영자 요청**:
- 매 KST 시간 (00~23) 잔고 + 증감 짧은 알림 (`00:00 1.0sol(잔고) 증감 +-` 형식)
- close 알림이 올 때 있고 안 올 때 있는 issue

**Fix** (`src/orchestration/reporting.ts`):
- `getScheduledReportType` 에 `'hourly'` enum 추가
- `HOURLY_SNAPSHOT_KST_HOURS = 0~23` 모두
- 우선순위: daily(9시) > heartbeat(짝수) > hourly
- `sendHourlySnapshot` — 짧은 1-3 줄 (잔고 + 1h 증감 + live close 카운트 + 5x+ winner 표시)
- in-memory baseline 으로 1h 증감 계산 (재시작 시 reset, 첫 1h 는 증감 표시 없음)
- 회귀 테스트 2건 추가

**Close 알림 일관성 분석**:
| Path | 알림 | 빈도 |
|------|------|------|
| Live close 정상 | `sendInfo('[KOL_LIVE_CLOSE] ...')` | 매 close ✓ |
| Live close sell fail | `sendCritical('kol_live_close_failed')` | retry 시점 |
| Live close DB persist fail | `sendCritical('kol_live_close_persist')` | DB 에러 시 |
| **Paper close** | `emit('paper_close')` 만 | hourly digest + 5x anomaly 만 (silent by design) |

→ "close 알림 안 올 때" = paper close (의도된 silent). hourly snapshot 의 누적 표시로 인지 보완.
   단 paper close 는 jsonl ledger 라 `tradeStore.getTradesCreatedWithinHours` (DB) 에 없음 → 향후 sub-task 로 paper jsonl reader 추가.

### 7. 잔존 sprint

| 우선순위 | 항목 |
|---------|------|
| P2 | live trade 의 mfe 측정 인프라 — executed-* schema 에 mfePctPeak 추가 또는 paper mirror cross-ref 자동화 |
| P2 | `kol-paper-arm-report.ts` 의 paper-only ledger filter — 현재 mixed (paper-only + live mirror) read 가능성 점검 |
| P2 | hourly snapshot 의 paper close 누적 표시 — kol-paper-trades.jsonl reader 통합 |

---

## 2026-04-28 — ralph-loop P0-P3 follow-up (QA fix + 분류 도구 + 비대칭 fix)

### 1. 적용된 변경

| Task | 영역 | 변경 |
|------|------|------|
| **P1 — Test isolation** | `test/kolSignalHandler.test.ts` | beforeEach/afterEach 에 `resetKolDbState()` 추가. KOL DB module global state 가 test 간 leak (Phase 1 신규 테스트의 __testInject 가 후속 test 영향 가능성). |
| **P1 — INCIDENT R2 정정** | `INCIDENT.md` | 'observer dead' false positive 정정 (직접 검증 8910/8910 = 100% probe 데이터). 4곳 mention 갱신. P0 5x winner 가설 (B) 측정 도구 가용으로 정정. |
| **P2 — Trail buildup 비대칭 fix** | `kolSignalHandler.ts:applySmartV3Reinforcement` | scalper KOL buy 는 reinforcementCount 만 +1, trail 변경 안 함 (P2 fix). longhold/swing/unknown buy 만 trail buildup. Phase 1 의 lower_confidence (scalper sell trail--) 정책과 정합. |
| **P0 — Phase 0A 분류 도구** | `scripts/kol-classify-helper.ts` 신규 | notes 텍스트 → lane_role/trading_style/avg_hold_days/avg_ticket_sol 추정. `--json` / `--diff` 지원. wallets.json 직접 수정 안 함 (운영자 권한). 운영자 manual review 가이드 출력. |

### 2. 검증

```
npm run check:fast
Test Suites: 133 passed, 133 total
Tests:       1102 passed, 1102 total  (이전 sprint +1 P2 회귀)
```

### 3. 운영자 다음 액션

```bash
# 1. 분류 도구 실행 — 39 active KOL 의 추천값 + 미분류 highlight
npx ts-node scripts/kol-classify-helper.ts

# 2. data/kol/wallets.json 직접 편집 — 각 active KOL 에 fields 추가:
#      "lane_role": "copy_core" | "discovery_canary" | "observer"
#      "trading_style": "longhold" | "swing" | "scalper"
#      "avg_hold_days": <number>
#      "avg_ticket_sol": <number>

# 3. 분류 후 정합 확인
npx ts-node scripts/kol-classify-helper.ts --diff
```

### 4. 다음 sprint 후보 (Phase 0A 완료 후)

- **Phase 4** — 조건부 hold-time 완화 (clean_token + copy_core 조건부). 24h paper replay 시뮬 mandatory.
- **wash detection 외부 데이터** — unique trader count + creator-funded bundle 검출.
- **Phase 5** — Discovery lane 한정 latency 최적화 (Helius Sender / Jito ShredStream / Yellowstone).

---

## 2026-04-28 — ralph-loop P0-P3 구현 (외부 피드백 통합)

외부 피드백 5축 (KOL style 분리 / token quality / observer / 조건부 hold / lane-한정 latency) 의 P0-P3 ralph-loop 구현.

### 1. 직전 plan 의 false positives 정정

| 항목 | 직전 진단 | 실제 검증 |
|------|---------|---------|
| **R2 — observer dead** | INCIDENT 에 "24h × 4287 records 모두 observations 빈 배열" | **FALSE POSITIVE** — schema 오해 (record 의 field 는 `probe` 단일 객체 / `observations` array 아님). 8910/8910 = 100% probe 데이터 보유. observer 정상 작동 |
| **Phase 2B — close-side observer 신규** | 직전 plan 에서 신규 작업으로 listing | **이미 구현됨** — `kolSignalHandler.ts:1511-1550` 의 `trackRejectForMissedAlpha` 호출이 close 5 reason (probe_hard_cut/probe_flat_cut/probe_reject_timeout/quick_reject_classifier_exit/hold_phase_sentinel_degraded_exit) 분기 |

### 2. 적용된 변경

| Task | 파일 | 변경 |
|------|------|------|
| **Phase 2B** | `pairAndSession.ts` | `MISSED_ALPHA_OBSERVER_OFFSETS_SEC` default `60,300,1800` → **`30,60,300,1800`** (피드백의 T+30s 정합) |
| **Phase 0B** | `kol/types.ts` | `KolWallet` interface 확장: `lane_role`, `trading_style`, `avg_hold_days`, `avg_ticket_sol` 옵션 필드. `KolLaneRole` / `KolTradingStyle` types |
| **Phase 0B** | `kol/db.ts` | `getKolLaneRole(kolId)` / `getKolTradingStyle(kolId)` helpers — 미분류 시 `'unknown'` fallback (backwards-compat) |
| **Phase 1** | `orchestration/kolSignalHandler.ts` | `evaluateInsiderExitDecision(pos, sellingKolId)` helper 신규: <br>(1) observer → ignore <br>(2) all-scalper cohort → close <br>(3) scalper sell + non-scalper cohort → lower_confidence (close 안 함) <br>(4) longhold/swing sell → close <br>(5) unknown → close (보수적 fallback) |
| **Phase 1** | `handleKolSellSignal` | blanket `closePosition('insider_exit_full')` → 분기 처리. lower_confidence 시 `kolReinforcementCount` 하향 |
| **Phase 3** | `gate/securityGate.ts` | `CLEAN_TOKEN` / `UNCLEAN_TOKEN:checkpoint` flag stamp. 4 dimensions: <br>(1) creatorPct >30% (creator-funded bundle 의심) <br>(2) top10HolderPct >50% (등급 down — 80% 임계는 entry reject 그대로) <br>(3) sellBuyRatio <0.5 \|\| >2.0 (wash 패턴) <br>(4) exit_liq_unknown |

### 3. 회귀 테스트 (9 신규)

| 영역 | 테스트 |
|------|--------|
| Phase 1 (style-aware exit) | scalper sell + longhold cohort → lower_confidence / longhold sell → close / all-scalper → close / unknown fallback → close (4건) |
| Phase 3 (token-quality flag) | clean → CLEAN_TOKEN / creatorPct >30% / top10 65% / ratio 5.0 / exit_liq null (5건) |

### 4. 검증

```
npm run check:fast
Test Suites: 133 passed, 133 total
Tests:       1100 passed, 1100 total  (1091 → +9: 4 Phase 1 + 5 Phase 3)
```

### 5. 운영자 다음 단계

| 우선순위 | 액션 |
|---------|------|
| **P0** | **Phase 0A — KOL DB 운영자 manual 분류** (39 active 중 11 미분류). `data/kol/wallets.json` 의 각 KOL 에 `lane_role` + `trading_style` + `avg_hold_days` 필드 직접 입력. notes 의 자유 텍스트 ('Copy Core S', 'discovery canary', '평균 13일' 등) 를 구조화 필드로 이전. |
| **P1** | **Phase 4** — 조건부 hold-time 완화 (clean_token + copy_core 조건부). holdProfile (tight/standard/extended) 결정 로직. extended profile 적용 시 winner 잠재 차단 위험 — 24h paper replay 시뮬 mandatory. |
| **P2** | **wash detection 외부 데이터 인프라** (Phase 3 확장) — 현재 sellBuyRatio anomaly 만, 진정한 wash detection 은 unique trader count + creator-funded bundle 검출 별도 sprint. |

### 6. 잔존 위험

- **Phase 1 의 'unknown' fallback** — KOL DB manual 분류 (Phase 0A) 완료 전엔 거의 모든 KOL 이 unknown → 기존 default behavior 보존. 분류 누적될수록 효과 점진. 단 효과 측정 위해 운영 결과 누적 1주 후 재평가 필요.
- **Phase 3 의 CLEAN_TOKEN flag 는 stamp 만** — 현재 hold-time 정책 변경 없음. Phase 4 완료 후 비로소 정책 영향.

---

## 2026-04-28 — Sprint A1 (wallet_delta_warn dedup) + B1 (Jupiter 429 retry 강화)

### 1. 배경 — last 6h 운영 critical alerts 156건 분석 결과

| Alert | 건수 | Root cause |
|-------|-----|-----------|
| `wallet_delta_warn` | **108** | dedup/cooldown 미작동 → 동일 drift 0.04~0.05 SOL 5분 spam |
| `kol_live_close_failed` | **44** | Jupiter 429 rate-limit. `kolh-live-GwR3ruFz` 9 attempts × 3 retries = **17분 close 지연 → mae −63%→−66.8% 손실 확대** |

### 2. Sprint A1 — `wallet_delta_warn` dedup/cooldown

**구현** (`src/risk/walletDeltaComparator.ts:265-296` + `runWalletDeltaCheckOnceForTests`):
- ComparatorState 에 `lastWarnAlertAtMs` + `lastWarnAlertDrift` 추가
- 발동 조건: (1) 처음 발동 OR (2) cooldown 경과 OR (3) drift 값 변화 ≥ tolerance
- log.warn 은 **항상 유지** (운영자 grep 채널), `sendCritical` 만 dedup
- env: `WALLET_DELTA_WARN_ALERT_COOLDOWN_MS` (default 30분), `WALLET_DELTA_WARN_DRIFT_DELTA_TOLERANCE_SOL` (default 0.005 SOL)

**효과**: 5분 polling × 6 cycle = 30분 동안 동일 drift 발동을 1회로 압축. **108건 spam → 예상 ~6건 (90% 감소)**.

### 3. Sprint B1 — Jupiter 429 retry 강화

**구현** (`src/executor/executor.ts:executeSwapV6`):
- `is429Error()` helper — axios `response.status === 429` + generic error message fallback (`/\b429\b/` / `/rate.?limit/i`)
- 일반 retry (`maxRetries=3`, backoff 1/2/4s) 와 **별도 429-specific retry**: 5/15/45/60/60s, max 5회 (env `JUPITER_429_MAX_RETRIES`)
- 429 발생 시 일반 attempt counter 회복 (`attempt--`) — 429 가 quote endpoint rate-limit 이라 일반 attempt 소진하면 진짜 swap 시도 기회 잃음
- `recordJupiter429('executor_swap_v6')` 호출 — 운영 모니터링 hook

**효과**: 9 attempts × 3 retries (이전) → 3 일반 + 5 429-retry × 5/15/45/60/60s backoff. GwR3ruFz 같은 17분 지연 케이스에서 **5분 안 close 가능 → 손실 확대 차단**.

### 4. 회귀 테스트 (9 신규)

| 파일 | 테스트 |
|------|--------|
| `test/walletDeltaComparator.test.ts` | 동일 drift cooldown skip / 새 drift 재발동 / cooldown 경과 후 재발동 (3건) |
| `test/executor429Detection.test.ts` | AxiosError 429 / 500 / generic message fallback / non-Error null (6건) |

### 5. 검증

```
npm run check:fast
Test Suites: 133 passed, 133 total
Tests:       1091 passed, 1091 total  (1081 → +10: 4 A1 + 6 B1)
```

### 5-bis. Sprint self-QA findings (post-merge)

10 audit point 검증 → 진짜 issue 3건 fix:

| # | Severity 주장 | 검증 결과 | 처리 |
|---|------------|---------|------|
| Q1 | DRY 미스 (production check vs test helper 의 dedup 로직 중복) | OK — 정합 유지, 향후 cleanup 후보 | 변경 불요 |
| Q2 | `attempt--` 무한루프 가능성 | OK — `retry429Count < max429Retries` 종료 조건. 소진 후 fallthrough 로 일반 attempt 진행 | 변경 불요 |
| Q3 | AxiosError import 미사용 | OK — line 29 `error instanceof AxiosError` | 변경 불요 |
| **Q4** | Ultra path 의 429 detection / `recordJupiter429` 호출 누락 | **LOW (관측 누락)** | **fix** — Ultra catch 에서 `is429Error(ultraError) → recordJupiter429('executor_swap_ultra')` |
| **Q5** | env value 0/negative 방어 부재 (`cooldownMs`, `tolerance`) | **LOW (defensive)** | **fix** — `Math.max(0, Number.isFinite(...) ? ... : default)` |
| **Q9** | **drift 회복 후 재발생 시 dedup state stale → 운영자 미수신** | **MEDIUM 위험 (real incident risk)** | **fix** — 회복 분기에서 `lastWarnAlertAtMs = 0; lastWarnAlertDrift = 0;` reset |
| Q6 | drift 부호 변화 시 dedup 정확성 | OK — `Math.abs(drift - lastWarnAlertDrift)` 가 부호 반전도 정확히 감지 | 변경 불요 |
| Q7 | `runWalletDeltaCheckOnceForTests` 가 dedup state reset 하는지 | OK — line 352-353 에서 reset 정상 | 변경 불요 |
| Q8 | Ultra path 의 429 retry 자체 부재 | OK — v6 fallback 이 retry mitigation 역할. 단 관측은 Q4 로 보정 | 변경 불요 |
| Q10 | 직전 sprint (inactive paper trade) 와의 충돌 | OK — 다른 모듈 변경 | 변경 불요 |

**적용된 fix 3건**:
1. `walletDeltaComparator.ts:check()` + `runWalletDeltaCheckOnceForTests` — 회복 분기 dedup state reset
2. 양쪽에 `Math.max(0, Number.isFinite(...) ? ...!: default)` defensive
3. `executor.ts:executeSwapWithRetry` Ultra catch — `is429Error → recordJupiter429('executor_swap_ultra')`

**신규 회귀 테스트 1건**: drift 회복 후 동일 값 재발생 시 alert 재발동 (Q9 핵심 시나리오)

### 6. 운영자 활성화 액션

```bash
# A1: 자동 활성 (default 값으로 운영 가능)
# 별도 env override 가능:
WALLET_DELTA_WARN_ALERT_COOLDOWN_MS=1800000           # default 30분
WALLET_DELTA_WARN_DRIFT_DELTA_TOLERANCE_SOL=0.005     # default 0.005 SOL

# B1: 자동 활성 (default JUPITER_429_MAX_RETRIES=5, backoff 5/15/45/60/60s)
# 더 보수적 운영하려면:
JUPITER_429_MAX_RETRIES=8                             # 더 많은 retry

npm run build
pm2 restart momentum-bot --update-env
```

### 7. 남은 위험 / 후속 sprint

| # | 항목 | 우선순위 |
|---|------|---------|
| R3.5 | wallet_delta_comparator 의 baseline 갱신 정책 — 매매로 인한 wallet 변화는 drift 가 아니라 expected 로 처리 (분석 §A) | P1 (Sprint A2) |
| R5 | Daily Loss limit 안전망 실제 entry block 작동 여부 검증 | P1 (Sprint A3) |
| R6 | Alternative DEX route (Raydium direct, Pump.fun direct) fallback — Jupiter 단일 점 실패 분산 | P2 (Sprint B3) |

---

## 2026-04-28 — Inactive KOL paper trade (Option B) 구현 sprint

### 1. 결정 — Option B: 측정 분리 ledger

INCIDENT.md 2026-04-27 §7 의 3 옵션 중 **Option B (full paper shadow trading + 별도 ledger)** 채택. Option A 는 이미 구현 (shadow tx 만 jsonl 기록), Option C 는 후속 (promotion 알림 자동화).

### 2. 구현 (4 task 병렬)

| Task | 파일 | 변경 |
|------|------|------|
| **#81** | `src/kol/types.ts:KolTx` | optional `isShadow?: boolean` 필드 추가 — handler 가 active vs inactive 분기 처리 |
| **#83** | `src/ingester/kolWalletTracker.ts:329-396` | shadow 분기에서 `kol_shadow_tx` emit 후 `shadowPaperTradeEnabled=true` 면 `kol_swap` 도 emit (isShadow=true). KolTx 에 isShadow flag stamp |
| **#83** | `src/index.ts:1212` | tracker config 에 `shadowPaperTradeEnabled` wiring |
| **#82** | `src/config/kolHunter.ts:28-29` | `kolHunterShadowPaperTradeEnabled` (default false, opt-in) + `kolShadowPaperTradesFileName` (default `'kol-shadow-paper-trades.jsonl'`) |
| **#82** | `src/orchestration/kolSignalHandler.ts:PaperPosition` | `isShadowKol?: boolean` 필드 추가 |
| **#82** | `src/orchestration/kolSignalHandler.ts:enterPaperPosition` | `cand.kolTxs.every((t) => t.isShadow === true)` 일 때만 `isShadowKol=true` 마킹. active 1명이라도 끼면 active 우선 (downgrade 안 함, 보수적 정책) |
| **#82** | `src/orchestration/kolSignalHandler.ts:appendPaperLedger` | `pos.isShadowKol` 이면 `config.kolShadowPaperTradesFileName` 으로 분리 dump |
| **#82** | `src/orchestration/kolSignalHandler.ts:resolveStalk` + `evaluateSmartV3Triggers` | shadow-only cand 는 `isLiveCanaryActive() && botCtx` 분기 진입 차단 (`!candIsShadow` guard) — 실 자산 노출 금지 |
| **#84** | `test/kolSignalHandler.test.ts` | 신규 describe `inactive KOL paper trade (Option B, 2026-04-28)` — 5 회귀-방지 케이스 |

### 3. 5 회귀 방지 테스트

1. `cand.kolTxs.every isShadow=true` → `isShadowKol=true` 마킹
2. shadow + active 혼합 → `isShadowKol=false` (downgrade 안 함)
3. shadow position close → `kol-shadow-paper-trades.jsonl` 로 분리 dump (active ledger 안 건드림)
4. active position close → active ledger 로 dump (shadow ledger 안 건드림)
5. **shadow-only cand 는 live canary 차단** — `isLiveCanaryActive=true` + executeBuy 미호출 + `isLive=false` (실 자산 노출 0)

### 4. 검증

```
npm run check:fast
Test Suites: 132 passed, 132 total
Tests:       1080 passed, 1080 total  (+5 inactive paper trade + 8 sprint 2A recovery)
```

### 5. 운영자 활성화 액션

```bash
# 1. .env 에 두 flag 모두 활성 (superset 관계)
KOL_HUNTER_SHADOW_TRACK_INACTIVE=true       # 기존 flag (subscribe + jsonl)
KOL_HUNTER_SHADOW_PAPER_TRADE_ENABLED=true  # ← 신규 flag (paper trade 진입)

# 2. dist 재빌드 + restart
npm run build
pm2 restart momentum-bot --update-env

# 3. 결과 dump 위치
data/realtime/kol-shadow-paper-trades.jsonl  # ← inactive KOL paper close 결과
data/realtime/kol-paper-trades.jsonl         # ← active KOL paper close 결과 (분리 유지)
```

### 6. 안전 정합 (실 자산 0 노출)

- `kolHunterPaperOnly=false + kolHunterLiveCanaryEnabled=true` 운영 환경에서도 **shadow-only cand 는 무조건 paper** (코드 강제, env 우회 불가)
- ledger 분리로 active vs inactive 분포 측정 무결성 유지 — `kol-paper-arm-report.ts` / kolDailySummary 가 active ledger 만 보면 inactive 결과가 active 평균을 오염 안 시킴
- Helius 429 risk: `shadowTrackInactive=true` 의 RPC 부담 (active+inactive subscriptions) 그대로. paper trade 옵션 활성은 추가 RPC 부담 0 (handler 내부 처리만)

### 6-bis. Sprint self-QA findings (post-merge)

8 audit finding 검증 → 진짜 issue 2건만 fix:

| # | Severity 주장 | 검증 결과 | 처리 |
|---|------------|---------|------|
| #1 | CRITICAL — fileName undefined crash | **FALSE POSITIVE** — `optional()` helper 의 fallback 명시로 항상 string 반환 | 변경 불요 |
| #2 | HIGH — daily summary 가 shadow 안 읽음 | **DESIGN INTENT** — 분포 분리 의도, promotion alert 는 Option C (next sprint) | 변경 불요 |
| #3 | MEDIUM — recovery 가 isShadowKol 미설정 | **NOT-A-BUG** — recovery 는 DB live position 만, paper shadow 는 DB persist 안 함 | 변경 불요 |
| #4 | MEDIUM — `kol-paper-arm-report` 필터 부재 | **부분 valid** | **defensive filter 추가** (`activeOnly = loaded.filter(r => !r.isShadowKol)`) |
| Q5 | **HIGH (audit miss)** — `kolPaperNotifier.onPaperClose/onPaperEntry` 가 shadow paper close/entry 를 active hourly digest / 5x anomaly / top movers 에 합산 → active 분포 오염 | **REAL** | **`if (pos.isShadowKol) return;` 격리** (양쪽 handler) |
| Q6 | empty cand 가 enterPaperPosition 도달 가능? | OK — `length > 0` guard 정상 | 변경 불요 |
| Q7 | enterLivePosition 의 paired swing-v2 shadow 가 isShadowKol 가짐? | OK — entry 자체가 candIsShadow=false 일 때만이라 자동으로 false | 변경 불요 |

**적용된 fix**:
1. `src/orchestration/kolPaperNotifier.ts:onPaperEntry/onPaperClose` — `pos.isShadowKol` 분기 추가하여 shadow 격리
2. `scripts/kol-paper-arm-report.ts:main` — `activeOnly = loaded.filter(r => !r.isShadowKol)` defensive filter
3. `test/kolSignalHandler.test.ts` — `paper_close payload.pos.isShadowKol=true` 검증 회귀 케이스

**검증**: `Tests: 1081 passed` (1080 → +1 회귀).

### 7. 다음 단계 (운영 결과 누적 후)

- `kol-shadow-paper-trades.jsonl` 24-72h 누적 → silent inactive KOLs (`johnson` 89tx, `kev` 46, `decu` 45, `trenchman` 24 — INCIDENT.md 2026-04-28 §4 24h 분석 발견) 의 paper outcome 측정
- mfe / capture / hold 분포가 active KOL 평균보다 좋으면 promotion candidate 로 KOL DB 수정 검토
- Option C (promotion 자동 알림) 은 별도 sprint — Option B 결과 1주 누적 후

---

## 2026-04-28 — KOL live canary dead-path 수정 sprint (sync fix)

### 1. 발견 — smart-v3 main arm 의 live wiring 누락 (commit 1469a08 회귀)

운영자가 `KOL_HUNTER_LIVE_CANARY_ENABLED=true` + `KOL_HUNTER_PAPER_ONLY=false` + `TRADING_MODE=live` 로 13시간+ 운영했음에도 `executed-buys.jsonl` 의 `kol_hunter` 건수 0. 봇 startup log 는 `liveCanary=ENABLED` 정상 출력됨.

**Root cause**: `evaluateSmartV3Triggers` (smart-v3 main arm trigger 경로, `kolSignalHandler.ts:798`) 가 무조건 `enterPaperPosition` 호출. `isLiveCanaryActive()` 체크 부재.

`isLiveCanaryActive()` 의 live 분기는 `resolveStalk` (v1 fallback arm, line 841) 안에만 존재. 그러나 운영 환경은 smart-v3 가 main 으로 활성이라 v1 경로는 dormant → **line 841 분기는 운영에서 도달 불가능한 dead path**. `executeBuy` 가 단 한 번도 호출되지 않은 정상 동작 (코드 버그 영향).

### 2. 추가 발견

- `enterLivePosition` 시그니처가 v1 arm 만 가정: `(tokenMint, cand, score, survivalFlags, ctx)` 로 옵션 미수신. smart-v3 의 `entryReason / convictionLevel / paramVersion / tokenDecimals` 를 받을 수 없음.
- `enterLivePosition` 내부에서 `armNameForVersion(config.kolHunterParameterVersion)` (= v1) 로 라벨링 → 만약 단순 분기 추가만으로 fix 시 smart-v3 가 live 로 가도 **v1 arm 라벨/파라미터 가 적용**되어 trail/sentinel 정책 어긋남.
- swing-v2 paired observation 처리: `enterPaperPosition` 안의 `isSwingV2Eligible(score)` 분기가 main 이 live 일 때는 호출되지 않음 → swing-v2 shadow 측정 누락.

### 3. 수정 (병렬 4 task, 본 sprint)

| Task | 파일 | 변경 |
|------|------|------|
| #77 | `kolSignalHandler.ts:1602` | `enterLivePosition` 시그니처에 `options: PaperEntryOptions` 추가. fallback paper 호출 시 options 전달 |
| #77 | `kolSignalHandler.ts:1693-1758` | hardcoded v1 paramVersion 제거. 옵션 기반 `primaryVersion / armName / entryReason / conviction / dynamicExit / liveDecimals` 사용. `t1MfeOverride / t1TrailPctOverride / t1ProfitFloorMult / probeFlatTimeoutSec` 적용 |
| #79 | `kolSignalHandler.ts` (enterLivePosition 내부) | smart-v3 live entry 시 swing-v2 shadow paired paper position 추가 (`isLive=false`, `parentPositionId` 연결, `LIVE_PAIRED_PAPER_SHADOW` flag) |
| #78 | `kolSignalHandler.ts:782-839` (`evaluateSmartV3Triggers`) | `isLiveCanaryActive() && botCtx` 체크 + 2 hard guard (`isWalletStopActive`, `isEntryHaltActive`) + fallback paper. 통과 시 `enterLivePosition` 호출 |
| #80 | `test/kolSignalHandler.test.ts` | 신규 describe `smart-v3 trigger → live canary wiring (2026-04-28)` 3 테스트: (1) triple-flag + smart-v3 pullback → `executor.executeBuy` 호출 + `isLive=true` (회귀 방지 핵심), (2) `LIVE_CANARY_ENABLED=false` → executor 미호출 (기존 동작 보존), (3) smart-v3 + swing-v2 dual → main live + shadow paper paired |

### 4. 검증

```
npm run check:fast
Test Suites: 132 passed, 132 total
Tests:       1057 passed, 1057 total  (3 sprint + 8 recovery + QA fix 회귀 방지)
```

### 4-bis. Sprint self-QA findings (post-merge)

| # | Severity | Finding | Fix |
|---|---------|---------|-----|
| QA1 | CRITICAL | `enterLivePosition` 의 swing-v2 paired shadow 가 `kolHunterEvents.emit('paper_entry', ...)` 누락 — `enterPaperPosition` (line 1216) 와 비대칭 → kolPaperNotifier 의 hourly digest + 5x anomaly alert 에서 paired shadow 분포 누락 | swing-v2 shadow `setActivePosition` 직후 `emit('paper_entry')` 추가. 신규 회귀 케이스 추가 |
| QA2 | MINOR | live shadow 의 `survivalFlags` 가 `LIVE_PAIRED_PAPER_SHADOW` 만 — paper shadow 의 `DECIMALS_${source}` 미포함 | `DECIMALS_${liveDecimalsSource?.toUpperCase() ?? 'UNKNOWN'}` flag 추가 (paper 분포 분석 호환) |
| QA3 | LOW (defer) | swing-v2 shadow entryPrice = `actualEntryPrice` (live slippage 포함). enterPaperPosition shadow 는 paper firstTick 사용 | paired observation 의 정합 측면에서 같은 entry 사용이 합리적이라 deferral. follow-up sprint 에서 분포 비교 후 결정 |
| QA4 | LOW (defer) | DRY 미스 — PaperPosition build 코드 enterPaperPosition.makePosition vs enterLivePosition inline 2곳 | follow-up refactor (테스트 강화 후 헬퍼 추출) |
| QA5 | LOW (verified) | swing-v2 shadow 의 `t1MfeOverride` 등 dynamicExit 빈 객체 — enterPaperPosition 도 동일 (`config.kolHunterSwingV2T1TrailPct` 등은 별도 경로 적용) | 정합 ✓, 변경 불요 |

### 5. 운영 영향

- 본 fix 가 배포되어야 비로소 `KOL_HUNTER_LIVE_CANARY_ENABLED=true` 가 의미있게 동작.
- 사명 §3 phase gate 의 5x winner 1건은 paper 데이터 (n=1) 이므로 **paper-only 단계에서의 충족** 으로 인정됨. live canary 는 배포 후 별도 누적 필요.
- **주의**: 본 fix 배포 직후 첫 1-3 trade 가 가장 위험. canary cap 0.3 SOL / drift halt 0.2 SOL / ticket 0.01 hard lock / max consec losers 등 안전망은 모두 유지되지만, 운영자가 **첫 1-3 close** 를 morning-stop 가능한 윈도에서 직접 관측 권고.
- 잔존 incident 2건 (drift spam / notifier fail) — observer dead 는 false positive 정정됨 (2026-04-28) 은 별도 sprint 필요 — 본 sprint 와 무관.

### 6. dist 빌드 + pm2 restart 필요

운영자 액션:
```bash
npm run build                    # dist 재빌드 (smart-v3 live wiring 반영)
pm2 restart momentum-bot         # process 새 코드 로드
pm2 logs momentum-bot --lines 200 | grep -E "KOL_HUNTER_LIVE_BUY|KOL_HUNTER_LIVE_OPEN"
# ↑ smart-v3 trigger 발동 시 위 두 로그가 떠야 정상 (이전엔 KOL_HUNTER_PAPER_ENTER 만 떴음)
```

---

## 2026-04-28 — 5x winner 첫 돌파 + 측정 인프라 회귀 + drift spam (24h sync 분석)

### 1. 24h KOL paper 결과 (2026-04-27 02:36Z ~ 04-28 02:37Z, UTC)

| 지표 | smart-v3 (main) | swing-v2 (shadow) | 합계 |
|------|----------------|-------------------|------|
| Trades | 197 | 57 | **254** |
| netSol | +0.108 | +0.034 | **+0.142 SOL** |
| avgNet% | +5.99% | +6.50% | — |
| avgMfe% | +26.6% | +19.9% | — |
| T1+ (mfe ≥ +50%) | 33 (16.8%) | 5 (8.8%) | 38 |
| 2x+ (mfe ≥ +100%) | 13 | 2 | 15 |
| **5x (mfe ≥ +400%)** | **1** | 0 | **1** ✓ |
| 10x (mfe ≥ +900%) | 0 (940% = 9.4x) | 0 | 0 |

→ **사명 §3 5x+ winner binding constraint 24h 내 첫 돌파**. 단 single-winner 의존도 매우 높음 (+0.094 / +0.142 = **66%**).

### 2. 5x winner raw record 검증 — `kolh-DF7DAPat-1777322938`

```
closedAt: 2026-04-27T20:59:54Z
arm:      kol_hunter_smart_v3 (paramVersion smart-v3.0.0-paper-2026-04-26)
entry=1.3745e-07  exit=1.4302e-06   (10.4x entry)
peak=exit (정확 일치)  trough=entry (drift 0, MAE 0)
mfePeak=940.5%  netPct=940.5%  netSol=+0.094 SOL
hold=656s  reason=insider_exit_full
T1@+109s, T2@+506s, T3@+639s
kols: jijo (A), trey (A)  kolScore=1.99  indep=1
```

→ price feed glitch 의심 점검 결과 **데이터 일관성 ✓**. peak == exit 정확 일치는 **insider_exit_full 이 정확히 정점 tick 에서 컷**한 결과 (회귀 0). MAE=0 은 진입 후 entry 아래로 한 번도 안 내려간 이상 trajectory. 가설 (A) trail 보수성을 *이 케이스에서는 반박* — insider_exit signal 따라가기가 trail 보다 정점에 가까움.

### 3. Capture rate by exit reason (mfe ≥ 50% trade, 24h)

| Exit reason | n | avg capture (net/mfe) | avg mfe% | avg net% |
|------------|---|----------------------|---------|---------|
| **insider_exit_full** | 15 | **+0.88** | +148% | **+139%** |
| winner_trailing_t1 | 8 | +0.50 | +116% | +61% |
| **hold_phase_sentinel_degraded_exit** | 8 | **+0.29** | **+167%** | **+58%** |

→ **가설 (A) "trail/sentinel 보수성" 정량 증거 누적**. Top-5 mfe 중 3건이 sentinel 컷 (mfe 215~246% / net 42~116%). sentinel 완화 시 추가 5x winner 후보 존재 가능성. INCIDENT.md §6 가설 (A) 검증의 1차 데이터 도착.

### 4. probe_hard_cut 95건 = 가설 (B) entry timing 추적

| 지표 | 값 |
|------|-----|
| 건수 | 95 (전체 254의 37.4%) |
| 평균 MAE | −19.5% |
| 평균 hold | 47s |
| hold < 5s | 1건 (1%) |
| hold < 15s | 23건 (24%) |
| 누적 손실 | **−0.190 SOL** |

→ **probe_hard_cut 누적 손실 −0.190 > 24h winner 합산 +0.142**. 즉 net +0.142 흑자는 **+940% winner (+0.094) + 그 외 winner들이 hard_cut 손실을 가까스로 상쇄한 결과**. 즉시 dump (hold<5s) 비율은 1% 로 낮음 — 04-27 누적의 86건 즉시 dump 주장 (이전 데이터) 대비 개선 추세.

### 5. Reject 분포 (24h, 4287건)

| Reason | n | % |
|--------|---|---|
| **smart_v3_price_timeout** | **1644** | **38.3%** |
| stalk_expired_no_consensus | 987 | 23.0% |
| smart_v3_kol_sell_cancel | 802 | 18.7% |
| smart_v3_no_trigger | 376 | 8.8% |

→ smart-v3 price/velocity trigger 가 stalk 윈도 안에 못 맞춰 1644건 (38%) 미진입. 가설 (B) entry timing 보수성의 보조 증거.

### 6. Paired observation (32 mints, 57 pairs) — smart-v3 vs swing-v2

| 결과 | 건수 |
|------|-----|
| smart-v3 wins | 7 |
| swing-v2 wins | 9 |
| tied | 41 |

paired net: smart-v3 +0.0165 / **swing-v2 +0.0342** / **diff swing-v2 +0.0177 SOL**

→ 같은 mint 진입 시 swing-v2 가 약간 더 좋은 결과. tied 41건은 양 arm 동시 insider_exit 컷. 차이는 trail 정책이 다른 9건 — 표본 적음, 결정적 신호 아님.

### 7. ⚠ 측정 인프라 회귀: missed-alpha observations 24h × 4287건 모두 빈 배열

→ post-reject T+60/300/1800s 가격 관측이 **dead**. INCIDENT.md §6 가설 (B) "stalk 끝난 후 +50% mfe 도달 빈도" 측정 도구가 회귀. 원인 후보: commit 1469a08 (KOL live canary) 이후 `MissedAlphaObserver` 시작 누락 또는 observation persist 회귀.

**P0 조치**: `src/observability/missedAlphaObserver.ts` + observer init 점검. 회복 전엔 가설 (B) 정량 검증 불가.

### 8. ⚠ wallet_delta_warn 12회 spam (2026-04-27 13:01-13:26)

```
drift 0.1180 SOL (warn ≥ 0.03 SOL, halt ≥ 0.2 SOL)
5분 간격 6회 발동, 동일 drift 값 (cooldown/dedup 깨짐)
```

→ **두 개의 별도 문제**:
1. **drift origin 불명**: paper-only 운영인데 main wallet 에 0.118 SOL 변동. `executed-buys/sells.jsonl` 마지막 04-26 06:53Z 이후 외부 활동 없음 가정. 운영자 수동 입출금? 외부 transfer? 검증 필요.
2. **alert spam**: 동일 drift 값 5분 간격 6회 발동. dedup/cooldown 미작동. 운영자 critical alert 무딘화 위험.

**P0 조치**: drift origin 추적 (`ops:reconcile:wallet`) + `walletDeltaComparator` dedup 코드 점검 (`state.haltTriggered` reset path 만 있고 warn-단계 dedup 없음 가능).

### 9. Daily reporter `win10x` 임계 점검

Telegram daily 가 `bestPeak +940%` (= 9.4x) 를 `win10x=1` 로 카운트. 임계가 `>= 9.0` 인지 `>= 10.0` 인지 reporter 코드 (`src/orchestration/kolDailySummary.ts`) 정의 확인 필요. **이름과 임계 일관성 정정** (P1).

### 10. notifier failures 3건 (24h)

| 시각 | category | 비고 |
|------|---------|------|
| 04-27 16:29:43 | info:kol_hourly_digest | error 빈 문자열 |
| 04-27 17:00:53 | info:heartbeat | 동일 |
| 04-28 00:00:59 | daily_summary | 동일 |

→ fail 경로의 `error` 필드가 빈 문자열로 capture. notifier audit 의 fail 경로 점검 필요 (P2).

### 11. Telegram daily 246 vs jsonl 254 — 정합 ✓

이전 세션의 246 vs 17 (12h) 14배 모순은 **시간대 오류 (KST cutoff vs UTC 데이터) + sync stale** 합산이었음. UTC 정정 후 254 (24h) ↔ 246 (daily 발송 시점 cutoff) 차이 +8건은 daily 발송 후 누적분으로 설명됨 → **정합 회복**. 향후 분석은 UTC 기준 일관 적용.

### 12. 사명 §3 phase gate 진척

| 조건 | 현재 | 평가 |
|------|------|------|
| 0.8 SOL floor 유지 | 1.07 SOL | ✓ |
| 200 paper trades | **466+ 건** (4-25 시작 누적) | ✓ |
| 5x+ winner ≥ 1 | **24h 내 1건** ✓ | **첫 돌파 — 단 single-winner 표본** |
| 별도 ADR + Telegram critical ack | — | 미작성 |

→ **3 of 4 조건 충족**. 추가 5x winner 1-2건 + drift origin 확인 후에 ADR 작성 가능 상태. ~~observer 회복~~ 은 2026-04-28 false positive 정정으로 불필요. 즉시 live canary 활성화는 **표본 부족 (n=1) + drift incident** 으로 **여전히 비추**.

### 13. 분석 측정 무결성 — 시간대 정합 규칙 (적용)

- 봇 로그/jsonl 모든 timestamp 는 **UTC `Z` 접미사**
- 분석 cutoff 도 **UTC 기준 ISO** (`date -u +%Y-%m-%dT%H:%M:%SZ`)
- KST 기준 cutoff 사용 금지 (`date -v-12H` 출력은 로컬 시간이라 함정)
- 향후 모든 운영 분석 보고에 시간대 명시

---

## 2026-04-27 — KOL paper 측정 1차 종료 + KOL live canary 코드 완료 + DB v6 rebalance

### 1. KOL paper 누적 결과 (n=212, 2026-04-23 ~ 04-27)

| 지표 | 값 |
|------|----|
| 총 trade | **212** (smart-v3 133 / swing-v2 11 / v1 fallback 68) |
| 누적 net SOL (paper) | **+0.0568 SOL** |
| 평균 net% | +3.18% (smart-v3 +4.79 / swing-v2 +7.31 / v1 −0.65) |
| Win rate | 30.0% |
| T1 도달 | 33 (15.6%) |
| **T2/T3 도달** | **0 / 0** |
| **5x+ winner (net ≥ 400%)** | **0** ← 사명 §2.3 **binding constraint** |
| 2x+ mfe | 5 |
| 1x+ mfe | 13 |

**Top winner**: kolh-7iwshRyG mfe **+285%** / net **+186%** (decu, T1 trail 337s). 사명 임계 +400% 의 47% 도달.

**Reason 별 평균 net%**:
- probe_hard_cut −16.29% (n=86, 가장 많음 — wallet bleed 의 주 원인)
- insider_exit_full +14.68% (n=49)
- **winner_trailing_t1 +66.25%** (n=17)
- **hold_phase_sentinel_degraded_exit +44.59%** (n=6)
- probe_flat_cut −1.50% (n=36)

**KOL 별 net 기여 Top 5**: decu (S, +0.024 SOL), clukz (S, +0.024), euris (A→S, +0.010), trenchman (신규 A, +0.007), earl (신규 A, +0.005).

**KOL 별 net 기여 Bottom (이미 inactive 처리됨)**:
- west_ratwizardx (4-27 inactive) −0.0069 SOL
- theo (active) −0.0049 SOL ← 활동 다대 (49 trade) but 평균 음수, 모니터링 대상
- lexapro (4-27 inactive) −0.0024 SOL

### 2. KOL DB v6 rebalance (2026-04-27)

`data/kol/wallets.json` v6 last_updated 2026-04-27. External KOL feedback v2 + OKX/Kolscan/GMGN/Solscan cross-check 적용.

| 변경 | 인원 | 사유 |
|------|------|------|
| Active → Inactive | 5명 (josim / lebron / pain / west_ratwizardx / scharo) | 공개 재검증 근거 약함 |
| A → S 승격 | 1명 (euris) | 저시총 + 회전 + tail 분포 검증 |
| split & 승격 | 1명 (ogantd) | secondary_unverified_pool → OKX+Kolscan 양쪽 검증 |
| watch → active | 1명 (domy) | Kolscan 상위권 노출 |
| 신규 A active | 8명 (chester / casino / jijo / johnson / the_doc / heyitsyolo / kadenox / kev) | copy core / discovery canary |
| 신규 B observe-only | 13명 (matt / naruza / nyhrox 등) | single-source, 2차 검증 대기 |

**Lane 분류 (3-tier)**:
- **Copy Core**: decu / euris / bflg / ekawy_2 / dzfk / jijo / johnson / heyitsyolo (저티켓 + 저시총 + 회전)
- **Discovery Canary**: clukz / theo / chester / kadenox / kev / the_doc / gdaqp3 (먼저 본다 — latency 민감)
- **Benchmark / Observer**: oxsun / lebron / cupsey_benchmark 등 (트리거 X)

현재 active 35명 (S 4 + A 31).

### 3. KOL live canary 코드 완료 (commit 1469a08)

`enterLivePosition` (~190 LOC) + `closeLivePosition` (~178 LOC) + Triple-flag gate (`isLiveCanaryActive`) 구현. **paper-only 코드 락 해제** — 운영자 명시 opt-in 시 live wallet 사용.

**Triple-flag gate** (모두 충족 시에만 live):
1. `botCtx` 주입 (initKolHunter ctx)
2. `ctx.tradingMode === 'live'`
3. `!config.kolHunterPaperOnly` (default true → explicit false 필요)
4. `config.kolHunterLiveCanaryEnabled` (default false → explicit true)

**점검 후 추가 fix (7건)**:
- 🔴 CRITICAL: `walletDeltaComparator.haltAllLanes()` 의 lane 배열에 kol_hunter / pure_ws_swing_v2 누락 → 추가
- 🔴 CRITICAL: `getAllLaneIntegrityState()` 의 lane 배열 누락 → 추가
- 🔴 CRITICAL: `closeLivePosition` fire-and-forget race → state='CLOSED' 즉시 mark + guard
- 🟡 HIGH: `canaryAutoHalt.DEFAULT_LANES` 에 kol_hunter 누락 → 추가
- 🟡 HIGH: DB closeTrade 실패 시 `triggerEntryHalt('kol_hunter')` 추가 (cupsey/pure_ws 패턴 동등화)
- 🟠 MEDIUM: startup `[STAGE_GATE_REMINDER]` 에 KOL_HUNTER_LIVE_CANARY 추가
- 🟠 MEDIUM: Triple-flag gate test 5건 추가

**미해결 (별도 sprint 권장)**:
- KOL live position recovery (재시작 시 OPEN 복구) — `src/state/recovery.ts` 추가 필요
- KOL 별도 canary cap (현재 공용 0.3 SOL 사용)
- enterLivePosition 직접 호출 통합 test (executor mock 필요)

### 6. 5x+ winner 미달 root cause 가설 (다음 P0 분석)

paper 212 trade / 5x+ winner 0 의 원인은 **3 가지 가설 중 어느 것이 binding 인지 미확정**. 다음 1-2 주 sprint 의 P0:

**가설 A — trail/sentinel 의 보수적 cut**:
- 데이터: kolh-8ipcTXum mfe 245% → net 108% (peak 의 44%), kolh-EjY599u1 mfe 230% → net 42% (peak 의 18%)
- hold_phase_sentinel_degraded_exit 가 large winner 의 retreat 50% 에서 cut
- 검증: trail 0.15 → 0.25 / sentinel peakDrift 0.30 → 0.45 paper A/B 측정
- 작업: 1주 데이터 + 별도 ADR

**가설 B — entry timing 늦음 (KOL fill 직후 즉시 dump)**:
- 데이터: probe_hard_cut −16.29% × 86건 (40% of close), 3-12초 안에 −20%+ 즉시 dump 다수
- 의심: KOL fill → tracker emit → 봇 entry 사이 1-3초 gap 동안 sniper bot front-run 가능
- 검증: kol-tx.jsonl timestamp + raw-swaps.jsonl 가격 변동 micro-replay
- 작업: 0.5-1일 분석 + hardcut threshold (-10% → -7%/-15%) ADR

**가설 C — T2 임계 (+400% mfe) 자체가 너무 높음**:
- 데이터: T2 도달 0건 / T1 도달 33건 / mfe 200%+ 5건 / mfe 400%+ 0건
- 의심: 사명 §2.3 의 5x+ 임계가 KOL signal 의 자연 분포보다 한참 위
- 검증: 동일 token 의 KOL fill 이후 4h 가격 분포 (90 percentile mfe) 측정
- 작업: 1주 데이터 + 사명 임계 재정의 (별도 ADR + 운영자 의사결정)

→ **세 가설 동시 검증 가능** (코드 변경 0, paper 데이터만 사용). 그 후 데이터 기반 trail/hardcut 조정 ADR 작성.

### 7. inactive KOL 의 paper shadow 측정 부재 (사후 검증 인프라 gap)

**사실**:
- 현재 `is_active=false` KOL (26명) 은 KolWalletTracker subscribe 자체 안 함 → KOL_TX 0건
- 4-27 reverify v2 의 5명 inactive 처리 (josim / lebron / pain / west_ratwizardx / scharo) 가 옳았는지 paper 결과로 검증 불가
- watch-only KOL (cupsey_benchmark / cented_benchmark / domy_watch / gwyg_watch) 의 sustained signal 측정 안 됨
- rejected_candidates (Doji / Trey) 가 noise vs trader 인지 paper 데이터 없이 판단

**문제**:
- 운영자의 정성 reverify 판단 vs 실측 paper 수익 검증 인프라 부재
- promotion candidate / dormant 자연 분류의 데이터 근거 부재
- 사명 §3 의 "관측 의무" 와 정합한 측정 framework 누락

**제안 (3 옵션)**:

(A) **Shadow Track only** (즉시, 0.5일):
- KolWalletTracker 가 inactive 도 subscribe → `data/realtime/kol-shadow-tx.jsonl` 활동량 기록만
- smart-v3 / paper position 영향 0
- 활동량 분포 측정만

(B) **Full Paper Shadow** (1주 누적 후 결정, ~150 LOC):
- inactive KOL 도 v1 기본 정책 (180s stalk + 15% trail) 으로 paper trade 시뮬
- 별도 ledger `kol-inactive-paper-trades.jsonl` + paper-arm-report 의 별도 cohort
- PaperPriceFeed 부담 ~2배 (active 35 + inactive 26)

(C) **A + 주기적 promotion candidate 알림** (Phase 2):
- 옵션 A + 7d 활동량 ≥ 50 tx 시 운영자 promotion alert
- DB 자동 수정 안 함 (운영자 수동 only 유지)

**권장**: **옵션 A 즉시 + 옵션 B 표본 누적 후 결정**.
- Phase 1 (0.5일): KolWalletTracker `subscribeInactive` flag + 별도 logger
- Phase 2 (1주 후): 활동량 데이터 보고 paper shadow 가치 vs Jupiter quota 부담 trade-off 결정

**사명 §3 정합**: ✅ paper-only, wallet 영향 0, DB 자동 수정 0, smart-v3 main 변경 0 — 위반 0건.

### 8. Trending Sniper 신규 lane 제안 검토 (2026-04-27, 보류 권고)

**제안 요지**: KOL paradigm 의 5x+ winner ceiling 입증 (212 trade / 0건) 을 근거로 4번째 lane (`trending_sniper`) 도입 — dexscreener trending API 기반 신규 listing token 의 first-200 buyer 영역 진입.

**제안 내용**:
- 새 모듈 `src/orchestration/trendingSniper/` — pure_ws 패턴 80% 재사용
- Phase 0 (KOL 후처리, 1-2일) + Phase 1 (paper scaffold, 1주) + Phase 2 (측정 1-2주) + Phase 3 (결정)
- T1 +100% / T2 +400% / T3 +900% / hardcut −10%
- paper-first 강제, Helius quota 영향 0 (외부 API)

**점검 결과 — 보류 권고**:

(1) **"KOL ceiling 입증" 결론은 시기상조**:
- 표본 212 → Wilson LCB 95% 의미 없음
- mfe 200%+ winner 5건 발생 — paradigm 자체 ceiling 이 아니라 trail/sentinel 보수성 (mfe 245% → net 108% gap) 일 가능성 미검증
- INCIDENT §6 의 root cause 가설 3개 (trail/timing/T2 임계) 검증 전에 paradigm pivot 결론은 logical leap

(2) **"smart money exit zone 후행" 정의가 KOL 데이터와 부분 충돌**:
- winner_trailing_t1 17건 평균 +66.25% — KOL exit 와 무관 자체 trail capture
- decu/clukz max mfe 285%/242% — 봇 진입 후 가격 상승 capture, exit 후행 아님
- KOL paradigm 은 부분 후행/부분 동행. 단정 부정확.

(3) **"first 200 buyer" latency 가능성 주장 근거 부재**:
- "memecoin 10x 는 5-30분 윈도" 데이터 출처 없음
- "5-15s = buyer #50-200" 측정 부재
- pure_ws V2 PASS 53,260건 / 8h = wash-trade 만 — Solana memecoin detection 자체의 어려움. trending 도 같은 문제 가질 가능성

(4) **사명 §3 위반 위험**:
- "KOL paradigm 데이터 부족 상태에서 새 paradigm 추가" = explainability paradigm 시기 함정 패턴 재현
- Premature paradigm pivot

**권장 — Phase 0 만 (KOL 후처리) + 1주 후 재검토**:

1. KOL paper 표본 누적 (212 → 350-400) — root cause 가설 3 검증
2. theo 처리: 단순 deactivate 보다 "tier B-watch" 강등 (trigger 제외 + paper shadow 유지)
3. probe_hard_cut threshold 완화 paper A/B (-10% vs -7% / -15%) — 별도 ADR
4. swing-v2 hurdle 완화 (multi-KOL ≥2 → ≥1 + score ≥ 4.0) paper A/B
5. **dexscreener trending 의 24h 분포 실측** (수동 분석) — Phase 1 진입 전 데이터 근거 확보

**1주 후 분기**:
- KOL 5x+ winner 1건 입증 → KOL paradigm 충분, trending 추가 명분 약함
- 5x+ 여전히 0 + trail 완화 후에도 ceiling 입증 → **그때 trending lane 추가 ADR** (사명 §3 정합)

→ **즉시 implement 비추천**. 제안 자체는 가치 있으나 KOL root cause 검증이 선행 조건. 사명 §3 의 "데이터 없이 paradigm 변경 금지" 정합.

### 9. pure_ws lane retire 결정 보류 (사명 §3 lane 분류)

**사실**:
- 8h V2 PASS 53,260건 / 거의 전부 KMnDBXcP wash-trade pair
- Option 5 ADR §6: pure_ws 는 Lane S (scalping baseline) 로 격하, 살아있음
- 그러나 **사명 (5x+ winner) 에 기여 가능성 0** — wash-trade pair detection
- swing-v2 paper shadow 도 pure_ws 입력 의존 → 의미 0

**결정 보류 사유**:
- benchmark 로 운영하면서 KOL paradigm 과 비교 baseline 역할 (ADR §6)
- 운영자가 `PUREWS_LIVE_CANARY_ENABLED=false` 로 paper 만 → bleed 0

**다음 결정 시점** (아직 결정 미필요):
- 사명 §2.3 의 5x+ winner 1건 입증 시 → KOL paradigm 우선, pure_ws retire 검토
- 또는 24h V2 PASS 의 90% 가 dead pool 만 잡는 패턴 sustained 시 → retire ADR

### 4. 사명 §3 phase gate 평가

| Gate | 임계 | 현재 | 충족? |
|------|------|------|------|
| Paper trades | ≥ 200 | **212** | ✅ |
| Paper 5x+ winner (net ≥ 400%) | ≥ 1건 | **0** (가장 가까움 +186%) | ❌ |
| Paper 5x+ winner (mfe ≥ 400%) | ≥ 1건 (참고) | 0 (가장 가까움 +285%) | ❌ |
| sustained net 양수 | yes | smart-v3 +4.79%, swing-v2 +7.31% | ✅ |
| 코드 (`enterLivePosition`) | 구현 | ✅ commit 1469a08 | ✅ |
| 별도 ADR | yes | **없음** | ❌ |
| Telegram critical ack | `stage4_approved_YYYY_MM_DD` | **없음** | ❌ |

**진단**: 5x+ winner 미입증 → 활성화는 **운영자 자발적 §3 위반 인지** 상태에서만. 코드 안전망 (canary cap 0.3 / max consec / drift halt 0.2) 으로 wallet 보호.

### 5. 1+2차 sweep 누적 14건 처리

CRITICAL 7건 (Real Asset Guard / silent failure / race / TDZ / token 노출 / state API / drift halt 우회) + HIGH 4건 + MEDIUM 3건. jest 1038/1041 pass (regression 0).

---

## 2026-04-26 — Phase 3.5/3.6: 손익비 정책 A/B + pure_ws swing-v2 live canary 코드 완성

### 산출물

1. **KOL smart-v3 main** (`KOL_HUNTER_SMART_V3_ENABLED=true` default) — Pullback / Velocity / Both trigger, reason 별 trail/floor override. Paper-only 강제.
2. **KOL swing-v2 shadow** — `primaryVersion === v1` 제약 제거 → smart-v3 main + swing-v2 shadow dual 측정. 자격: multi-KOL S/A ≥2 + score ≥5.0.
3. **pure_ws swing-v2 paper shadow** — V2 PASS 신호마다 primary live + shadow paper 동시 생성. `pureWs/swingV2Entry.ts` 신규 (~300 LOC). 별도 ledger (`pure-ws-paper-trades.jsonl`).
4. **pure_ws swing-v2 live canary** (`PUREWS_SWING_V2_LIVE_CANARY_ENABLED=true`, opt-in) — 별도 EntryLane / canary slot / budget −0.1 SOL cap. 3 mode (dual live / swing-only live / paper shadow).

### 사명 §3 phase gate (Stage 4 SCALE)

Live canary 활성화 전 충족 필요:
- ⏳ Paper trades ≥ 200 (현재 75 = smart-v3 7 + v1 fallback 68)
- ⏳ Paper 5x+ winner ≥ 1건 입증 (현재 0)
- ⏳ 별도 ADR (`docs/design-docs/pure-ws-swing-v2-live-canary-YYYY-MM-DD.md`)
- ⏳ Telegram critical ack `stage4_approved_YYYY_MM_DD`

→ 활성화는 운영자 책임. 코드는 paper-first 강제.

---

## 2026-04-26 — Doc / scripts cleanup

| 변경 | 효과 |
|------|------|
| 6 stale 루트 doc archive 또는 삭제 | `Block_QA / CRITICAL_LIVE / DEX_TRADE / REFACTORING (구) / LANE_20260422 / 20260423` |
| 25 pre-pivot scripts → `scripts/archive/pre-pivot-2026-04-18/` | 65 → 40 active |
| Strategy D (`new_lp_sniper`) 영구 retire | `BirdeyeWSClient / listingSourceAdapter × 2 / newLpSniper` 모듈 5개 삭제 (~1991 LOC 감소) |
| Path B2 KOL tracker (`src/discovery/kolWalletTracker.ts`) 제거 | Option 5 의 `src/ingester/kolWalletTracker.ts` 만 남음 |
| sync-vps-data 자동 paper-arm-report 추가 | 매일 1 명령으로 sync + sub-arm 통계 |
| 3 test suite isolation fix (cupseyWalletMode + survival/probe gate override) | 16 fail → 3 fail (남은 3 cupsey state coupling 은 별도 sprint) |

---

## 2026-04-26 — smart-v3 Jupiter probe 부담 모니터링 항목 (F11)

`kol_hunter_smart_v3` 가 main paper 진입 경로로 활성화됨에 따라, paper price feed (`PaperPriceFeed`) 의 Jupiter quote 부담이 stalk window 길이 × active subscription 수만큼 비례 증가한다.

### 부하 추정

| 항목 | 값 | 출처 |
|------|----|------|
| Smart-v3 observe window | 120 s | `KOL_HUNTER_SMART_V3_OBSERVE_WINDOW_SEC` |
| Pullback probe timeout | 300 s | `KOL_HUNTER_SMART_V3_PROBE_TIMEOUT_PULLBACK_SEC` |
| Velocity probe timeout | 300 s | `KOL_HUNTER_SMART_V3_PROBE_TIMEOUT_VELOCITY_SEC` |
| Both (pullback + velocity) timeout | 600 s | `KOL_HUNTER_SMART_V3_PROBE_TIMEOUT_BOTH_SEC` |
| PaperPriceFeed poll interval | 3 s | `paperPriceFeed.ts:44` |
| Subscription dedup | per-mint, in-flight skip | `paperPriceFeed.ts:144` (각 mint 의 이전 poll 진행 중이면 skip) |
| Max concurrent paper position | 3 (Real Asset Guard 고정) | `kolHunterMaxConcurrent` |

**Worst-case quote/min 추정** (active 3 + pending 3 동시):
- 6 mint × 60 s / 3 s = **120 quote/min** (sustained, observe + hold 중)
- 단, `PaperPriceFeed` 가 mint 단일 timer + in-flight dedup → mint 당 최대 20 quote/min.

**429 cooldown 동작 시**: `rateLimitCooldownMs=10_000` 동안 모든 mint poll skip → 자체 회로차단 보유.

### 모니터링 항목 (배포 후 24h 관측)

- [ ] `recordJupiter429('paper_price_feed')` 카운터 → `jupiterRateLimitMetric` 일별 합계
- [ ] active subscription 수 (`PaperPriceFeed.getActiveSubscriptionCount()`) p95
- [ ] cooldown 발생 빈도 (10s window 의 누적 시간) → 발생 시 paper trade exit 정확도 영향 평가
- [ ] missed-alpha observer 의 `decimals_unknown` 비율 (paper price feed 의 decimals null 응답 빈도와 연관)

### 임계값 (잠정)

| 메트릭 | warn | critical | 대응 |
|--------|------|----------|------|
| Jupiter 429 / hour (paper feed) | 5 | 20 | poll interval 5s 로 늘리거나 observe window 단축 |
| Active subscription p95 | 6 | 10 | concurrent guard 점검 (Real Asset Guard 위반 의심) |
| Cooldown 누적 시간 / hour | 60s | 300s | 임계값 위반 lane 의 paper exit accuracy 별도 검토 |

### 후속 조치

- 24h 관측 후 임계값 위반 없으면 monitoring section 을 `MEASUREMENT.md` 로 이관 (이 INCIDENT 종료).
- 위반 발생 시 PaperPriceFeed 의 batch quote API 도입 (`/quote-batch`) 또는 poll interval 조정 ADR 작성.

### 단기 회피책 (이미 구현)

- `PaperPriceFeed` 의 in-flight dedup (`sub.inFlight`) → 동일 mint 동시 poll 차단
- 429 시 `rateLimitedUntilMs` 글로벌 cooldown 10 s
- subscriber 수 감소 시 `unsubscribePriceIfIdle` 호출 (kol-paper close 직후)

---

## 2026-04-26 — Lane Edge Controller (Kelly) P0 즉시 착수 후보

ADR: `docs/design-docs/lane-edge-controller-kelly-2026-04-25.md` 검토 완료. 사명 적합성 ⭐⭐⭐⭐⭐.
**P0 (Accounting Eligibility) 만** 즉시 착수 가능. P1-P3 는 명시 phase gate (Option 5 Phase 2 GO / Phase 4 50 trades / Stage 4 SCALE) 까지 deferred.

### P0 산출물 (decided 2026-04-26)
- DB trade rows ↔ executed-buys/sells.jsonl FIFO match
- 신규 outcome record 필드 (single source of truth):
  - `kelly_eligible: boolean`
  - `reconcile_status: 'ok' | 'duplicate_buy' | 'orphan_sell' | 'open_row_stale' | 'wallet_drift'`
  - `matched_buy_id / matched_sell_id: string | null`
  - `wallet_truth_source: 'executed_ledger' | 'wallet_delta_comparator' | 'db_pnl' | 'unreconciled'`
  - `laneName / armName` (legacy `StrategyName` enum 외)
- 산출 파일: `data/realtime/lane-outcomes-reconciled.jsonl`
- canary-eval.ts 가 reconciled outcome 만 사용

### 진입 게이트 (P0 종료 → P1 시작 전 만족 필요)
- 최근 7일 trade 의 `kelly_eligible=true` ≥ 95%
- duplicate buy / open-row stale 0건
- Option 5 Phase 2 shadow eval GO 판정 (별도)

### Cohort 차원 (P0/P1 한정)
`laneName × armName × (kolCluster or discoverySource)` — 3 차원 only. 추가 차원은 ADR 필수.

### Hard constraint 재확인
- Kelly 가 양수여도 ticket cap 자동 증가 **없음**
- `cap = 0.03` unlock 은 Stage 4 SCALE + 별도 ADR + Telegram critical ack 후만
- Phase gate 위반 시 commit 거부 (`[KELLY_CONTROLLER_PHASE_VIOLATION]`)

### 관련 문서 변경 (2026-04-26)
- `docs/design-docs/lane-edge-controller-kelly-2026-04-25.md` §5/§7/§10/§11 강화 (phase gate / cohort 축소 / Real Asset Guard 정합)
- `MISSION_CONTROL.md` Control 3 §3.1 cross-reference 추가

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
- 기존 Decision Fork Path A/B/C/D (LANE_20260422 §8 — 2026-04-26 cleanup 시 삭제) → 본 결정으로 대체
- 외부 KOL piece (20260423 메모 — 2026-04-26 cleanup 시 삭제, Option 5 ADR 에 흡수됨) Trending-gated scalping → Lane S (pure_ws) 로 격하, 살아있음
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

## 2026-04-22 (오후, LANE_20260422 대조 addendum — 원본 문서 2026-04-26 cleanup 시 삭제, 핵심 내용은 본 섹션에 흡수)

### 프레이밍 정정 — "Trade 누적 0" 은 9h slice 만의 상태

앞 섹션에서 binding constraint 를 "trade 가 안 쌓이는 상태" 로 규정했으나, 7일 ledger (2026-04-16 → 04-22) 는 다른 그림을 보여준다.

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

이전 문서에 "close site 훅 추가" 만 적었으나 LANE_20260422 §6.1 (cleanup 전 메모) 에 구체 카테고리 5개 명시됨:

| category (신설) | 발생 조건 | pure_ws 에서 비중 |
|-----------------|-----------|-------------------|
| `probe_reject_timeout` | PROBE 30s 만료 후 flat cut | 다수 (REJECT_TIMEOUT 82%) |
| `probe_hard_cut` | MAE ≤ -3% | — |
| `probe_flat_cut` | ±10% band 이탈 | — |
| `quick_reject_classifier_exit` | 45s 2+ factor degraded | — |
| `hold_phase_sentinel_degraded_exit` | T1/T2/T3 중 3 factor 2+ | — |

→ 이 5 카테고리 확장이 Phase 3 miss 가설 (consolidation→breakout) 의 정량 평가 조건. **예상 작업 1-2h**. Stage 1 원칙과 충돌 없음 (observability 확장).

### Stage 2 진입 전 Decision Fork — 4개 Path

LANE_20260422 §8 (cleanup 전 메모) 에서 제시된 4-way 선택지. **현재 미결정**, 관측 축적 후 판단 필요.

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
