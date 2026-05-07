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
3. **`docs/design-docs/mission-refinement-2026-04-21.md`** — 원 사명 정의. 현재 운영 floor 는 2026-04-28 B안으로 **0.7 SOL** 확정 + 200 live trades + 5x+ winner 실측. 100 SOL 은 tail outcome.
4. **`REFACTORING_v1.0.md`** — Option 5 의 Phase 0-5 실행 가이드 (현 active sprint).

### Lane 표 (2026-05-03 갱신 — 3 strategy split)

| Lane | arm | 모드 | 역할 | 코드 | 파라미터 |
|------|------|------|------|------|----------|
| `cupsey_flip_10s` | — | (disabled) | **Benchmark (frozen)** — 개조 금지 | `cupseyLaneHandler.ts` | 변경 0 |
| `kol_hunter_smart_v3` | main | live canary + paper fallback | **Main 5x lane** | `kolSignalHandler.ts` | fresh active 2+ KOL velocity / pullback live fallback |
| `kol_hunter_rotation_v1` | control + paper arms + promoted chase-topup canary | canonical rotation live off; `rotation_chase_topup_v1` canary only | fast-compound auxiliary | `kolSignalHandler.ts`, `src/orchestration/rotation/`, `rotationPaperDigest.ts` | T+15/T+30 post-cost / underfill + chase-topup + flow-exit paper |
| `pure_ws botflow` | primary + paper arms | paper/observe-only | new-pair botflow rebuild candidate | `src/orchestration/pureWs/`, `src/observability/pureWsBotflow*.ts` | T+15/30/60/180/300/1800 / 15m digest |

---

## 3. Real Asset Guard — 절대 불변

| 항목 | 값 | 위반 시 |
|------|-----|---------|
| Wallet floor | 0.7 SOL (2026-04-28 B안) | **commit 거부** — 명시적 ADR 없으면 변경 금지 |
| Cupsey canary cap (default lane) | -0.3 SOL | 동일 |
| KOL canary cap (별도) | -0.2 SOL | 동일 |
| Fixed ticket | pure_ws/cupsey/migration 0.01 / **kol_hunter 0.02** | 동일 |
| Max concurrent | 3 (전역) | 동일 |
| Drift halt | ≥ 0.2 SOL | 동일 |
| Security hard reject | mint/freeze/honeypot/Token-2022 dangerous ext / **NO_SECURITY_DATA** (Track 2B) | 동일 |
| Same-token re-entry cooldown (KOL) | 30 분 (Track 1) | env override 가능 (`KOL_HUNTER_REENTRY_COOLDOWN_MS=0` 으로 disable) |

→ 절대값 (floor / cap / ticket / max concurrent / drift / hard reject) 변경하려면 **별도 ADR + 48h cooldown + 운영자 명시 승인**.
→ 정책 layer (cooldown / Calibration tier 15% / RISK_MAX_DAILY_LOSS_OVERRIDE) 는 운영자 env 로 즉시 조정 가능.

---

## 4. 5 분 안에 알아야 할 것

### 최근 무엇을 했나
- **2026-05-07** — **smart-v3 live entry quality hardening**. Fresh active 2+ velocity remains the only default live path, but live now fail-closes to paper on strict quality flags (`EXIT_LIQUIDITY_UNKNOWN`, `TOKEN_QUALITY_UNKNOWN`, `UNCLEAN_TOKEN*`, holder-risk/no-route/rug-like), weak pre-entry sell recovery/no-sell window failures, repeated losing KOL combinations, and materially adverse quote vs fresh KOL fill price. Combo decay uses entry-time fresh KOL identity (`smartV3EntryComboKey`), learns from primary paper+live closes, treats live losses as stronger evidence, and excludes shadow arms. `smart-v3-evidence-report` now renders paper rows that would have been live-blocked with top block reasons/flags. Defaults are active; 운영 `.env` override 필수 없음.
- **2026-05-06** — **rotation chase-topup live canary + env operating profile 정리**. Canonical `KOL_HUNTER_ROTATION_V1_LIVE_ENABLED` 는 계속 false 로 두고, 승격 arm 만 `KOL_HUNTER_ROTATION_CHASE_TOPUP_LIVE_CANARY_ENABLED=true` 로 열 수 있게 정리했다. `KOL_HUNTER_ROTATION_CHASE_TOPUP_PARAMETER_VERSION=rotation-chase-topup-v1.0.0` 를 report 비교 키로 사용한다. `.env`는 secret 포함 운영 파일이라 Git 추적 금지이며, secret 없는 운영 override 는 `ops/env/production.env`로 추적한다. `scripts/deploy-remote.sh`는 원격 repo를 먼저 pull하고, 원격 `scripts/deploy.sh`가 `ops/env/production.env`를 `.env`에 병합한다.
- **2026-05-06** — **smart-v3 MAE diagnostics/live behavior refinement**. Smart-v3 probe now has default-on `smart_v3_mae_fast_fail` for dead pre-T1 probes (low MFE, token-only MAE breach, no fresh participating KOL buy) and a bounded one-time MAE recovery hold for pre-T1 candidates that already reached meaningful MFE and have no participating KOL sell. Close ledgers/projection ledgers include recovery markers plus pre-T1 MFE band/giveback diagnostics; `smart-v3-evidence-report` renders MAE fast-fail, recovery-hold, and pre-T1 `10-20`/`20-30`/`30-50` counts. 운영 `.env` override 필수 없음.
- **2026-05-05** — **Helius getTransfersByAddress KOL posterior integration**. `npm run kol:transfer-backfill` 로 active KOL transfer ledger 를 `data/research/kol-transfers.jsonl`에 적재하고, `npm run kol:transfer-report` 로 KOL별 rotation/smart-v3 fit posterior 를 생성한다. `npm run kol:transfer-refresh` 는 별도 sidecar 배치용 stale-aware wrapper(기본 7d, 22h stale, backup+overwrite)다. `sync-vps-data.sh`는 API 호출 없이 posterior report를 default 생성하고 stale 경고만 출력하며, `smart-v3-evidence-report` / `rotation-lane-report` 에 진단 전용 KOL transfer posterior 섹션을 붙인다. 운영 데이터는 VPS → local 로 가져오되 `data/research/kol-transfers.jsonl*` 는 local-only 분석 캐시라 rsync 기본 제외한다. 정책 자동 반영 없음. 운영 `.env` 변경 없음. sync-only knobs: `SKIP_KOL_TRANSFER_REPORT`, `KOL_TRANSFER_REPORT_SINCE`, `KOL_TRANSFER_INPUT`, `KOL_TRANSFER_STALE_WARN_HOURS`, `DATA_RSYNC_EXCLUDES`.
- **2026-05-03** — **3 strategy operating split + lane projection ledger refactor**. smart-v3 = main 5x lane, rotation-v1 = fast-compound auxiliary, pure_ws botflow = paper/observe-only rebuild candidate 로 문서/리포트 기준 정리. KOL aggregate ledgers 유지 (`kol-paper-trades.jsonl`, `kol-live-trades.jsonl`) + lane projection 추가 (`smart-v3-*`, `rotation-v1-*`, `pure-ws-*`). Shared markout ledger 는 분리하지 않음 (`trade-markout-anchors.jsonl`, `trade-markouts.jsonl`). rotation digest/report 는 `rotation-v1-paper-trades.jsonl` 우선 + aggregate fallback. `sync-vps-data.sh` sync health 에 projection 파일 freshness/row count + 최근 24h W/L/net/last trade summary 추가. `smart-v3-evidence-report` 추가: close-anchor 기반 T+30/60/300/1800 coverage, copyable/wallet-first W/L, token-only W/L 분리, report-only verdict (`COLLECT/DATA_GAP/COST_REJECT/POST_COST_REJECT/WATCH/PROMOTION_CANDIDATE`). 운영 `.env` 변경 없음. 기준 문서: `docs/design-docs/lane-operating-refactor-2026-05-03.md`, `docs/exec-plans/active/20260503_BACKLOG.md`.
- **2026-05-01** — **Sprint X+Y+Z 통합 — ATA rent token-only 측정 분리 + Codex 4 finding fix + R1 regression**. KIKI/STEWARD live trade 외부 explorer 비교에서 사용자 가설 "0.004 rent 누적" 정량 검증 (ticket 0.02 SOL 기준 ATA rent overhead 20% → token-only 5x 가 wallet 기준 +316.7% 로 측정 = **5x missed risk**). **Measurement-only 원칙** (거래 행동 변경 0): SwapResult schema 5 신규 필드 (swap/wallet/rent/fee/jitoTip), `decomposeSwapCost()` RPC inner instruction parse, V6+Ultra 양 path 자동 분해. PaperPosition + 모든 ledger 에 token-only / wallet-delta 분리 (entry/exit/mfe/mae/netPct/netSol). Telegram 진입 알림에 cost decomp line + 종료 알림에 entry rent visibility. analyzer (kol-paper-arm-report / dsr-validator / kol-live-canary-report) 모두 token-only 기반 stop 평가. Codex 4 finding fix: H1 (live ledger 시장가 기반), H2 (Jito fallback tip=0), M3 (live canary actual5x token-only), M4 (DSR Net SOL Wallet/Token 분리). R1 regression test (decomposeSwapCost 6 tests). R2 (Stream E pool pagination) 백로그. **165 suites / 1656 tests pass**.
- **2026-04-29** — KOL Big-loss Roadmap 채택 (`docs/exec-plans/active/kol-bigloss-roadmap-2026-04-29.md`) — paper n=438 분석에서 big-loss 51건이 all-loser cum 의 41% (IDEAL +84% sim). 4-Track 단계별 IDEAL 12%→25%→45%→60%→80% 도달 계획. **5종 변경 일괄 구현 (working tree, 미commit)**: (1) Track 1 same-token re-entry cooldown 30분 (KOL 진입 직전 reject), (2) Track 2A retro 분석 script (`scripts/kol-token-quality-retro.ts` 신규 — NO_SECURITY_DATA cohort = strong predictor 발견), (3) Track 2B NO_SECURITY_DATA reject default true (IDEAL 25%→35%), (4) Daily loss D+A (Calibration `0.05→0.15` + `RISK_MAX_DAILY_LOSS_OVERRIDE` env, -0.094 halt 사례 대응), (5) reporting.ts Q1+Q2+Q3 (reset helper 통합 / 5x peak 정의 사명 §3 정합 / transient 실패 batch 보존). `reports/` gitignore + 6 파일 untrack. **134 suites / 1122 tests pass**.
- **2026-04-28** — 24h 동기화 분석에서 **5x winner 1건 첫 돌파** (`DF7DAPat` smart-v3 mfe+940% / net+940% / insider_exit_full / hold 656s). 사명 §3 binding constraint 24h 첫 돌파 ✓. 3 of 4 phase gate 충족. 단 **3대 incident** 동시 발견: missed-alpha observer dead, wallet_delta_warn drift 0.118 SOL spam (5분 × 6회), notifier failures 3건 error 빈 capture. 분석 측정 무결성 — 시간대 정합 규칙 적용 (UTC 기준 일관).
- **2026-04-27** — KOL paper 212 누적 / 5x+ winner 0 / smart-v3 +4.79% net. KOL DB v6 (22→35 active, S 4+A 31). KOL live canary 코드 commit 1469a08 + 7 audit fix. ralph-loop 3 iteration: cupsey test isolation, dead strategy_d toggles, silent fallback ledger logs, 3개 setInterval handle cleanup, KOL live close operator notification.
- **2026-04-26** — pure_ws swing-v2 paper shadow + live canary 구현, smart-v3 + swing-v2 dual shadow, scripts archive (25개), Strategy D 영구 retire (~2200 LOC 감소).
- **2026-04-25** H1 Foundation — Clock interface / network mock / env-catalog / `npm run check`.
- **2026-04-23** Option 5 Phase 0-3 full — KOL DB scaffold + tracker + state machine + paper ledger.

### 다음 운영 액션 (운영자 결정)

**선택 A — Track 1+2B 효과 측정 sprint (권장)**: 24-48h 운영 후 회귀 차단 검증
1. VPS 재배포 (.env 추가 없이 default 즉시 활성 — Track 1 cooldown 30분 / Track 2B NO_SECURITY_DATA reject / Calibration 15% / reporting Q1+Q2+Q3)
2. 24-48h 운영 후 `bash scripts/sync-vps-data.sh` + `npx ts-node scripts/kol-token-quality-retro.ts --in data/realtime/kol-paper-trades.jsonl --md docs/exec-plans/active/kol-token-quality-retro-2026-04-30.md`
3. 측정 metric (회귀 차단):
   - mfe<1% rate 45.2% → ≤ 35% 목표
   - big-loss 12.4% → ≤ 9% 목표
   - 5x winner ≥ 1 보존 (회귀 critical)
   - cum_net Δ 측정
4. **3대 incident P0 회복** (INCIDENT.md 2026-04-28 §7-8-10) 동시 진행:
   - (P0) `MissedAlphaObserver` schema 재확인 (probe 단일 객체 / observations 미사용)
   - (P0) wallet_delta_warn drift origin 추적 (`ops:reconcile:wallet`) + dedup/cooldown 점검
   - (P2) notifier fail 경로 error capture 정정
5. 효과 + 회귀 검증 후 Track 2C (RugCheck) / Track 3 (KOL-pair cohort) / 추가 5x winner 누적 → KOL live canary 계속/강화/중단 판정

**선택 B — Track 2C 즉시 진행**: 잔여 mfe<1% 130건 (~30%) 추가 차단 시도
- RugCheck (무료) / Solana Tracker (free tier 1k req/day) 평가
- IDEAL 35% → ~50% 시뮬 후 결정
- 단 측정 sprint 완료 전 권고 안 함 — Track 1+2B 회귀 검증 우선

**백로그 — BBRI Phase 0 (장 분위기 감지, 측정 sprint 후 candidate)**:
- 사용자 권고 macro regime index (smart_flow / execution_quality / liquidity_proxy 3 components, 외부 API 0)
- observe-only, lane 영향 0 — DF7DAPat 5x winner 시점 BBRI 사후 측정으로 도입 가치 정량 입증
- INCIDENT.md 2026-04-29 BBRI 섹션 + Task #109 참조

**선택 C — KOL live canary stabilization sprint (현 active)**:
- `.env` 는 `KOL_HUNTER_PAPER_ONLY=false` + `KOL_HUNTER_LIVE_CANARY_ENABLED=true` 로 운영 중
- 안전망: floor 0.7 / KOL cap 0.2 / ticket 0.02 / independent KOL ≥ 2 / Track 1 cooldown / Track 2B reject / Daily loss override
- 구현 완료: yellow-zone live gate, single-KOL live paper fallback, canary budget ledger hydration, `npm run kol:live-canary-report`
- 다음 sprint 초점: hardcut/slippage root-cause + live/paper divergence deep-dive

### 절대 하지 말 것
- ❌ `cupsey_flip_10s` 코드 수정 (frozen benchmark)
- ❌ Real Asset Guard 어떤 항목도 완화
- ❌ V2 detector / probe window / ticket size 튜닝 (관측 데이터 없이)
- ❌ KOL DB 자동 추가 (수동 편집 only)
- ❌ trail/sentinel 파라미터 변경을 observer 회복 전에 (가설 (A) 검증 도구 부재)
- ❌ single-KOL cohort 를 live 로 재허용 (`KOL_HUNTER_LIVE_MIN_INDEPENDENT_KOL<2`) — 새 근거 + ADR 전 금지
- ❌ 0.75 SOL 미만 yellow-zone 에서 KOL live canary 조건 완화
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
npm run kol:smart-v3-evidence-report -- --since 24h --realtime-dir data/realtime

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
| ~~`missed-alpha.observations` 배열 비어있음~~ | ~~observer dead~~ — **false positive 정정 (2026-04-28)**. record schema 는 `probe` 단일 객체 / `observations` array 가 아니다. 8910/8910 = 100% probe 데이터 정상. |
| wallet_delta_warn 동일 drift 5분 spam | dedup/cooldown 미작동 + drift origin 추적 — INCIDENT.md 2026-04-28 §8 |
| `smart_v3_price_timeout` 38%+ | entry timing 가설 (B) 보조 증거. missed-alpha probe 로 직접 측정 |
| jsonl 분석 결과가 daily 와 14배 차이 | 시간대 함정 — 데이터는 UTC `Z`, cutoff 도 `date -u` 사용 (KST 금지) |
| paper-trades.jsonl 의 positionId 가 `kolh-live-*` | live mirror — paper-only 분석 시 `pid.startsWith('kolh-')` && `!pid.startsWith('kolh-live-')` 필터링 필수 |
| smart-v3 evidence 의 `minCov=0%` | 해당 cohort close `positionId` 기준 buy/sell T+ markout 이 없음. observed row ok-rate 가 아니라 close-anchor coverage 기준이므로 보수적 판정이 정상 |
| smart-v3 evidence 의 `copyable W/L` 과 `token W/L` 차이 | token-only 는 이겼지만 wallet/copyable 기준으로는 rent/fee/실체결 drag 때문에 진 케이스. 정책 판단은 copyable/wallet-first |
| smart-v3 evidence 의 `maeFastFail` 증가 | pre-T1 에 거의 살아난 적 없는 probe 를 더 빨리 자른 cohort. live 에서는 hard-cut sell retry path 를 타야 정상 |
| smart-v3 evidence 의 `preT1 20-30`/`30-50` 증가 | T1 전 수익권을 찍고 되밀린 케이스. exit 완화 후보지만 즉시 정책 변경 금지, sell-side T+와 winner-kill을 같이 봐야 함 |
| `5x winner` 라는 표현 | **mfe ≥ +400% 정의** (NOT netPct). live 의 received/actualIn 비율은 wallet axis 이지 mfe 아님 — paper mirror record 에서 mfePctPeak 직접 확인 |
| `logs/bot.log` mtime stale | `bash scripts/sync-vps-data.sh` 미실행. sync script 가 freshness 검증 추가됨 (2026-04-29) — 30분 이상 stale 시 WARNING 출력 |
| livecanary 활성 후 paper-only 분기 거의 0 | **의도된 정책 효과** (NOT incident) — `evaluateSmartV3Triggers` 의 `isLiveCanaryActive() && botCtx && !candIsShadow` 통과 시 enterLivePosition. paper-only 는 shadow KOL 또는 wallet_stop/entry_halt fallback 만 |
| V2 PASS pair = 1-2 | Detection diversity 붕괴 — Option 5 Phase 1-2 결과 확인 |
| `deltaPct p50 ≈ -92%` | Signal price bug (pool stale) — Tier C sprint 미해결 |
| Jupiter 429 cluster | `recordJupiter429` source 별 카운터 + cooldown 작동 확인 |
| `unhandled rejection` in test | network 누락 mock — `createBlockedAxiosMock()` 패턴 적용 |
| `dailyPnl=0` in test | Clock 미주입 — `createFakeClock(FIXTURE_NOW)` 사용 |
| 테스트가 운영 .env 영향으로 fail | `cupseyWalletMode='sandbox'` / `securityGateEnabled=false` / `canaryGlobalConcurrencyEnabled=false` 등 explicit override 필요 |

### 6-bis. KOL_HUNTER 분석 무결성 체크리스트 (2026-04-29 등재, 운영 분석 보고 필수)

직전 분석들이 schema 오해 / axis 혼동 / 표본 부족 / 시간대 함정 으로 반복 false positive 발생.
KOL_HUNTER 9h/24h/7d 보고서 작성 시 다음 12 항목 체크 의무:

```
[Time]
□ window 가 UTC 기준인가? `date -u +%Y-%m-%dT%H:%M:%SZ` 출력 명시
   (KST 인 `date -v-9H` 은 UTC 데이터와 9시간 어긋남 — 함정)

[Schema]
□ paper-trades.jsonl 의 positionId 가 `kolh-` (paper-only) vs `kolh-live-` (live mirror) 분리됐는가?
   filter: paper_only = pid.startsWith('kolh-') && !pid.startsWith('kolh-live-')
□ missed-alpha.jsonl 의 record 는 `probe` 단일 객체 (NOT `observations` array)
□ executed-buys/sells.jsonl 에는 mfePctPeak 없음 — 직접 측정 불가, paper mirror 에서 cross-ref

[Axis]
□ ticket axis (0.01/0.02/0.03 × n) 가 아닌 wallet axis (actualIn × Qty − receivedSol) 기반 net?
□ "5x winner" 표현 시 mfe ≥ +400% 정의 사용 (NOT netPct ≥ +400%)
□ paper netSol vs live wallet net 의 단위 차이 명시

[Statistical hygiene]
□ Single-winner 의존도 별도 표시 (winner contribution / total cum_net)
   주의: total cum_net 이 small positive 면 비율 inflated — winner 빼면 net loss 인지 cross-check
□ Cohort 비교 시 표본 ≥30/cohort? 미달 시 95% CI 같이 표시 (binomial: ±1.96·sqrt(p(1-p)/n))
□ 시뮬 결과의 hold-side 가정 명시 — "임계 안 넘으면 final outcome 그대로" 가정 시 wide 방향 시뮬 invalid

[Cross-check]
□ Sprint deploy 효과 측정 시 before/after 같은 metric — dedup vs drift recover 같은 분기 구분
□ "외부 claim (예: 70x pump)" 검증 시 우리 데이터의 peak retention / mfePctPeak 직접 측정. 데이터 없으면 "측정 불가" 명시

[INCIDENT 정합]
□ 직전 분석의 false positive (R2 observer dead, paper 정지 등) 와 충돌하는 결론 없는가?
   schema 의심 시 raw record 의 keys 직접 확인하고 시작
```

→ 매 KOL_HUNTER 보고서 첫 줄에 "체크리스트 12/12 통과" 명시 권고.

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

*Last updated: 2026-05-01 — Sprint X+Y+Z (ATA rent token-only 측정 분리, measurement-only) + Codex 4 finding fix + R1 regression. 165 suites / 1656 tests pass. 거래 행동 변경 0.*
