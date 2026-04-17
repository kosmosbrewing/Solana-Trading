# Execution Plan: 1 SOL → 100 SOL

> Status: current active execution plan
> Updated: 2026-04-17 (wallet truth drift +18.34 SOL 실측, Patch A/B1 duplicate+race fix, cupsey 조건부 primary 명시)
> Scope: 구현 완료 이후의 운영 검증, 배포, 표본 축적, live enablement gate
> Archive: 완료된 root plan과 dated canary history는 [`PLAN_CMPL.md`](../../../PLAN_CMPL.md)에 보관한다.
> Sub-plans: [`live-ops-integrity-2026-04-07.md`](./live-ops-integrity-2026-04-07.md) (Phase E P0~P3 fake-fill 운영 후속 트래킹), [`exit-execution-mechanism-2026-04-08.md`](./exit-execution-mechanism-2026-04-08.md) (P0-A: monitor → swap latency / winner preservation execution path), [`exit-structure-validation-2026-04-08.md`](./exit-structure-validation-2026-04-08.md) (parameter / exhaustion 가설 측정·결정, mechanism plan 과 병렬 계측)
> Triage: [`../../audits/mission-recovery-triage-2026-04-08.md`](../../audits/mission-recovery-triage-2026-04-08.md) (2026-04-08 현재 우선순위 재정렬)

## Role

이 문서는 현재 active execution plan이다.

- 구현 완료 여부를 기록하는 문서가 아니다
- historical canary를 해석하는 문서도 아니다
- 지금 남아 있는 운영 검증과 배포 우선순위를 정하는 문서다

### Baseline (Ground Truth)

- 미션: 1 SOL → 100 SOL (추상 목표)
- 실제 wallet baseline (2026-04-17 실측): 시작 **1.3 SOL** → 현재 **1.07 SOL** (−17.7%)
- 실 지갑 delta가 유일한 **ground truth**. DB `pnl` 컬럼은 참고용으로 강등
- 추상 목표 "1 SOL"은 사명 지표이고, 현실 baseline은 이 값을 기준으로 관측·비교한다

### Deployment Status (2026-04-17)

- **Patch A (STALK→PROBE reentrancy guard)**: commit 대기 — VPS 배포 전
- **Patch B1 (close serialization mutex)**: commit 대기 — VPS 배포 전
- **`scripts/wallet-reconcile.ts`**: 구현 완료, 실행 대기
- **`scripts/stuck-positions-cleanup.ts`**: 구현 완료, dry-run 대기
- 배포 완료 전까지 **duplicate DB row + close race는 계속 신규 생성 중**. 운영 해석 시 반드시 고려

## Current Position

### 이미 완료된 것

- 전략 A/C 코어 + D sandbox + E cascade 배선
- Security / Quote / Execution Viability / Safety / Exit Impact gate 배선
- Risk Tier / Kelly / Demotion / DD Guard / Daily Loss Halt
- realtime persistence / replay / measurement path
- pre-gate / post-size execution telemetry
- v5 RR basis 및 exit 구조 정렬
- scanner blacklist preload / reentry control 보강
- bootstrap trigger (VolumeMcapSpikeTrigger) — breakout/confirm 제거, volume+buyRatio 2-gate
- trigger mode 전환 (REALTIME_TRIGGER_MODE env var)
- **Signal attribution 4-feature** (04-05): marketCap context, crash-safe signal-intent, strategy별 분리 집계, zero-volume skip
- **Replay-loop 병렬 백테스팅** (04-05): 4 sessions × 2 modes = 8 parallel backtests 완료
- **Strategy A/C 5m dormancy 확인** (04-05): 261 combination 중 3건 trade → 밈코인 구조적 비적합
- **Phase E P0~P3 fake-fill 감지/마킹** (04-07): `exit_anomaly_reason` 컬럼 + sanitizer + Phase A4 close-time guards 배포 (commit 26fbfea 외). live 배포는 `2026-04-07T12:21:19Z` `Bot started v0.5`. Phase D acceptance 통과 (ops-history Entry 03). Phase M 7일 모니터링 day-1 진입. 상세는 [`live-ops-integrity-2026-04-07.md`](./live-ops-integrity-2026-04-07.md)
- **Code refactor quality** (04-07): TD-8 `closeTrade` positional → `CloseTradeOptions` 객체 (5 sites + 6 tests), TD-12 bps 매직넘버 → `src/utils/units.ts` (9 sites). tsc 0 errors / jest 87 suites / 466 tests pass
- **Cupsey lane integrity hardening** (04-16): shared ledger / separate control, fallback executed ledger, integrity halt, restart recovery, cupsey funnel / gate soft fail-open 관측성 추가
- **Cupsey duplicate + close race fix** (04-17, commit 대기 — VPS 배포 전): Patch A (`enteringLock` STALK→PROBE reentrancy guard, [`cupseyLaneHandler.ts:234-241, 504-512`](../../../src/orchestration/cupseyLaneHandler.ts)), Patch B1 (`closeMutex` serialization, [`cupseyLaneHandler.ts:47-68`](../../../src/orchestration/cupseyLaneHandler.ts)). 실측 근거: 187 unique buy_tx 중 45개(24%) DB duplicate, cupsey CLOSED 30건 중 21건 stored_pnl > recomputed 양의 skew. tsc 0 errors / jest 31/31 cupsey pass / 585/586 total.
- **Wallet audit + cleanup 도구 추가** (04-17): `scripts/wallet-reconcile.ts` (Solana RPC ground-truth SOL delta), `scripts/stuck-positions-cleanup.ts` (phantom OPEN atomic cleanup with --i-understand-phantom confirm). `npm run ops:reconcile:wallet`, `npm run ops:cleanup:stuck`.

구현 완료 이력과 canary history는 [`PLAN_CMPL.md`](../../../PLAN_CMPL.md)를 본다.

### 현재 남은 것

- **P0-A: Exit mechanism + winner preservation baseline** — TP2 intent/fill gap 축소와 `pre-TP1 EXHAUSTION` 빈도 측정을 함께 진행
- **P0-B: Idle universe + admission breadth 병목 해소** — stale pair eviction + freshness 개선으로 live signal / fresh trade flow 확보
- **P0-0: Source-of-truth / wallet attribution closure** — cupsey actual wallet path와 DB 원장을 일치시켜 live 판단 오염 제거
- **P0-C: Replay baseline sparse 차단율 81% 해소** — edge 측정 자체를 가능하게 만들기 (replay path)
- 04-04 edge (score 78)의 재현성 검증 — runner outlier vs 구조적 edge
- Legacy 세션 재검증 (OOM 해결, 113 stored signals)
- paper 표본을 운영 가능한 방식으로 쌓는다
- live enablement 기준을 명확히 통과시킨다

### Mission P0 Model (2026-04-17 갱신, trio → quartet)

사명 기준 현재 P0는 **4축**이다. 이 중 **P0-0이 선행**되어야 나머지 P0-A/B/C의 측정이 의미를 가진다.

0. **P0-0 Source-of-truth closure** ⚠ 신규 최우선 — wallet delta ≡ DB pnl이 될 때까지 다른 P0 측정은 전부 오염. Patch A/B1 배포 + `wallet-reconcile` 자동화 + `bootstrap_10s` 실거래 16건 감사 + stuck 11 positions 정리.
1. **P0-A Exit mechanism** — TP2 trigger intent와 actual fill gap을 줄여 runner를 실제로 보존할 수 있게 만든다.
2. **P0-B Fresh flow** — fresh pair가 discovery → admission → signal → executed_live로 이어지는 폭을 넓힌다.
3. **P0-C Winner preservation audit** — `EXHAUSTION / TIME_STOP / TRAILING`이 TP1 이전 winner를 잘라먹는지 측정한다.

원칙:
- **P0-0 없이 P0-A/B/C 측정은 drift에 오염되므로 결론을 낼 수 없다.** 2026-04-17 실측이 이를 증명.
- 4축 중 하나만 해결해도 사명 경로는 복구되지 않는다.
- `execution integrity`, `sample flow`, `winner preservation`, `attribution closure`를 동시에 개선해야 `1 SOL → 100 SOL` 경로가 열린다.

### Lane Decision (2026-04-17)

**결정**: `cupsey_flip_10s`를 **조건부 current primary execution lane**으로 운영한다. "조건부"의 의미는, **실제 wallet attribution이 닫히기 전까지는 메인 wallet / risk ownership을 확정하지 않는다**는 뜻이다. edge가 증명된 것이 아니라, "현재 유일하게 수치상 분석 가능한 execution path"이기 때문이다.

지금까지의 근거:
- bootstrap/volume_spike는 DB `pnl` 전부 허수 (드리프트 섹션 참조). 측정 가능한 유일한 lane이 cupsey.
- 새 lane을 먼저 붙이는 것보다 **현재 lane이 wallet 기준으로 돈을 버는지 측정하는 것**이 사명 경로 상 1순위.
- 미션 자체(1 → 100)는 convexity로 달성하지 fixed size로 달성 못 하지만, **convexity 투입은 양의 기대값 샘플 확보 이후**에만 의미 있다.

### Mission Lane Stack

lane은 많이 늘리는 것이 목적이 아니다. **현재 primary를 wallet 기준으로 증명하고, 다음 lane을 하나씩 추가**한다.

| Tier | Lane | 상태 | 역할 | 진행 조건 |
|---|---|---|---|---|
| 0 | **Cupsey Primary Survival** (`cupsey_flip_10s`) | **조건부 current primary** | bootstrap signal 재사용 + quick reject + winner hold | wallet↔DB 정합성 closure + 20~30 trade wallet-verified expectancy |
| 1 | **Migration Handoff Reclaim** | next build candidate | LaunchLab / PumpSwap / canonical pool 이벤트 후 첫 reclaim | Tier 0 증명 완료 시 설계 문서 착수 |
| 2 | **Liquidity Shock Reclaim** | later candidate | panic sell 이후 reverse quote / liquidity health 회복 진입 | Tier 1 live 진입 후 backlog 1순위 |
| 3 | Optionality / sandbox lanes | conditional | 별도 micro-ticket convexity 실험 | Tier 0~2 정리된 뒤 |

보조 원칙:
- `bootstrap_10s`는 **signal source only**. direct execution lane으로 되돌리지 않는다. (단 W1.2에서 실거래 16건 감사 필요)
- `AttentionScore`는 lane이 아니라 **shared ranking input**.
- `Recent + Organic + Event Anchor`는 새 lane이 아니라 **shared discovery upgrade**. Tier 1 신호원 확장용.
- 동시에 여러 live lane을 열지 않는다. wallet attribution closure 이전에는 **cupsey 단일 lane**.

### Surrounding Priority (lane 외 supporting work)

아래 항목은 lane이 아니라 lane을 돌리기 위한 infra / 운영 업무다.

1. **Cupsey primary stabilization** (= W1.2 Source-of-truth closure)
   - wallet path / DB row / executed ledger / notifier / funnel을 하나의 source-of-truth로 고정
   - 목표: 최근 20~30 closed cupsey trade의 `wallet_delta ≈ DB.pnl` 정합성 확보
2. **Migration Handoff Reclaim 설계 (paper)**
   - Tier 0 증명 전에도 **설계 문서는 착수 가능** (live 배포는 금지)
   - 이벤트 앵커(Raydium LaunchLab 졸업, Pump.fun → PumpSwap canonical)를 signal source로 정의
3. **Recent + Organic discovery upgrade**
   - lane이 아니라 shared discovery input
   - Tier 1 신호원 폭 확장용
4. **Infra split (LaserStream / Sender / Jito)**
   - lane이 2개 이상 live 된 뒤 검토
   - 현재 1순위 병목은 latency보다 attribution / reconciliation

### Wallet Truth Finding (2026-04-17)

> 출처: DB dump `vps-trades-20260417-113744.jsonl` (259 rows), 실지갑 잔고 사용자 직접 확인
> 사명 문서의 모든 전략 평가를 근본적으로 재설정시킨 실측.

| metric | value | 비고 |
|---|---|---|
| 실제 지갑 시작 | **1.3 SOL** | mission 문서상 추상 baseline "1 SOL"의 현실값 |
| 실제 지갑 현재 | **1.07 SOL** | 04-17 기준 |
| **실현 손익 (ground truth)** | **−0.23 SOL (−17.7%)** | wallet delta 기준 |
| DB 전체 `pnl` 합계 (2026-03-25~04-17, 243 closed) | +18.11 SOL | `cupsey +0.75` + `bootstrap −0.01` + `volume_spike +17.38` |
| **DB ↔ wallet drift** | **+18.34 SOL** | DB 수치 전부 신뢰 불가 |

**Drift 구조 분해**:
- **24% duplicate DB row** (187 unique buy_tx 중 45개): STALK→PROBE reentrancy race → `executeBuy` 중복 실행 + 2× `insertTrade`. **Patch A로 미래 생성 차단**.
- **Close race condition**: `updateCupseyPositions` fire-and-forget + concurrent close → `solBefore/solAfter` 겹침 → receivedSol 과대 기록. **Patch B1으로 차단**.
- **Duplicate buy 후유증**: 같은 mint에 2× tokens 누적 → close 시 `getTokenBalance` 전량 sell → `actualExitPrice` 2× 허수. Pnut 10 + SOYJAK 1 = 11 OPEN row가 stuck positions.
- **volume_spike +17.38 SOL**: 2026-04-03 pippin 대량 매매 시점의 Phase A/B/C1 이전 price-axis 오염 레거시 데이터. `STOP_LOSS`인데 +700% ROI 등 논리 모순. 신규 버그 아님, 이미 Phase E에서 max abs 100%→0.58% 수렴 문서화.

**운영 가정 불일치 발견**:
- STRATEGY.md / MEMORY.md는 `bootstrap_10s = signal-only (executionRrReject=99.0)`으로 기록하지만 DB에는 Cupsey-Primary 전환(04-12) 이후에도 16건 실거래 존재. `executionRrReject` 환경변수가 VPS에 실제 반영됐는지, 또는 억제 로직이 우회되는지 **감사 필요** — W1.2에 액션으로 등록.

**핵심 판정**: DB 기반의 `cupsey +0.226 SOL 양의 기대값`, `volume_spike +17 SOL` 같은 판단은 **전부 환상**. ground truth는 wallet delta 하나뿐. 새 lane 추가/사이징/Kelly는 wallet attribution 자동 closure 전까지 전부 금지.

---

### Latest Live Diagnosis (2026-04-07, post-Phase E 1h12min window)

> 분석 구간: UTC 04-07 12:21 ~ 13:33 (Phase E 배포 직후 첫 1h12min, ops-history Entry 03)
> 04-06 12h baseline은 [Historical Diagnosis (2026-04-06)](#historical-diagnosis-2026-04-06) 섹션 참조

| metric | value | 의미 |
|--------|-------|------|
| runtime_signal_rows | 1 | 13:26Z PIPPIN BUY 1건 (gate.passed=true → risk_rejected) |
| new_entries | 0 | 신규 trade 없음 — `token_safety` (8min < 15min hard floor) |
| closed_rows | 1 | pre-deploy entry `dd2a6b4e` 자연 unwind (TIME_STOP, +0.000542 SOL, exit_slip=35bps clean) |
| candidate_seen | 62 (39 distinct token) | universe 자체는 흐름 있음 |
| candidate_evicted | 54 | **100% idle eviction** — stale pair가 여전히 candidate 점유 |
| admission_skip | 29 | unsupported_dex 21 + no_pairs 8 |
| pre_watchlist_reject | 5 | non_sol_quote |
| trigger_stats_snapshots | 16 (대부분 evals=0, 13:27Z 1회만 evals=6 signals=1) | candle 평가 자체가 희박 |
| exit_anomaly_reason 자연 발생 | 0 / 1 | post-deploy 1건 close는 깨끗 |

**Phase E 배포 효과 (vs Entry 02 7h)**:
- exit_gap 분포: Entry 01(12h, pre-A/B/C1) `avg=-77.59%, max abs 100%` → Entry 02(7h, post-A/B/C1) `-0.30%, 0.58%` → Entry 03(1h12min, post-Phase E) `clean (1 close, 35bps)`. 가격 단위 폭발 사실상 사라짐.
- F1-deep-5 `realized-replay-ratio` anomaly filter: `1 parent groups (2 rows) excluded` (07:50 TP1 partial parent + 07:52 STOP_LOSS child). drop 동작 검증 완료.

**핵심 판정**: **W1.5 idle universe + admission breadth 병목은 Phase E 이후에도 여전히 P0-B다**. 다만 Phase E 이후의 다음 병목은 `exit mechanism / winner preservation`까지 포함한 **mission P0 trio**로 읽어야 한다. 가격 단위 정합성 + fake-fill 격리는 회복됐지만, 50 canary trades 확보와 실제 winner 보존은 아직 열리지 않았다.

**다음 액션 (우선순위순)**:
1. **W1.5 액션 재진입** — idle/stale pair eviction 강화 또는 TTL 단축. Entry 03 1h 표본은 너무 작아 즉시 결정 금지, day-1→day-2 (>19h) 분포 확인 후 결정
2. **exit mechanism 계측 병행** — `monitor_trigger_price → exit_price`, `actual TP2 match`, `pre-TP1 EXHAUSTION rate`를 같은 ops-history 루프에 기록
3. **admission_skip:unsupported_dex=21 분석** — 어느 DEX가 차단되는지 확인 후 확장 여부 판단 (W1.5 액션 이후)
4. Phase M 7일 모니터링 acceptance 누적 — `entry_gap_p95`, `exit_gap_p95`, `exit_anomaly_rows`, `realized_replay_excluded` 4종 metrics_note (`docs/runbooks/live-ops-loop.md:268+`)
5. `volumeSurgeMultiplier 1.8 → 1.6`은 위 4건 후에도 signal 부족 시 검토

**한 줄**: "측정은 정직해졌다 (Phase E). 이제 `fresh flow`를 넓히고, 동시에 `winner 보존`이 실제로 가능한지 계측해야 한다."

#### Edge Cohort 1차 측정 (Entry 04, 2026-04-07 ralph-loop iter7)

> 출처: ops-history Entry 04 / [`CRITICAL_LIVE.md §7G`](../../../CRITICAL_LIVE.md) / [`docs/audits/signal-cohort-2026-04-07.md`](../../audits/signal-cohort-2026-04-07.md)
> 사용자 가설(밈코인 저시총 고거래량 surge edge)을 signal-intents.jsonl 기반으로 1차 측정. trades 테이블에 marketCap 컬럼이 없어 trade 단위 R-multiple은 미산출, **signal 단위 pass rate**로 우회.

| Cohort | Signals | Executed | Exec rate | Outcome |
|---|---:|---:|---:|---|
| low-cap surge (mc<$1M, vol/mc>1.0) | 24 | 7 | **29.2%** | 7/7 loss (n=3 unique token, 표본 부족) |
| high-cap continuation (mc≥$10M, vol/mc<0.5) | 43 | 7 | 16.3% | n=1 (PIPPIN) 집중 |

**verdict**: **inconclusive** — 통과율 측면 partial confirm, 실측 손익 측면 partial reject, 극단 저시총 ($44K 4ytp) 0 trades. axis_3 acceptance는 `[~]` partial로 마킹. **Phase M 7d 누적 후 30 trades / cohort 도달 시 verdict 전환**. 자세한 차단 사유 분포와 Phase A3 false positive 의심 케이스는 §7G 참조.

**현재 active plan과의 관계**: 이 측정은 W1.5 (universe 병목 해소) 이후에 가능해지는 cohort 표본 축적과는 별개로, **signal-level**에서 즉시 가능했던 1차 우회. universe가 흐르기 시작하면 trade-level 측정도 가능해진다.

### Historical Diagnosis (2026-04-06)

> 04-07 Phase E 배포 전 baseline. W1.5 진단 근거.

| metric | value | 의미 |
|--------|-------|------|
| signals | 0 | signal 생성 없음 |
| executed_live | 0 | trade 없음 |
| idleSkip | 736,515 | idle pair가 candle 평가의 대부분 차지 |
| volInsuf | 2,560 | 실제 평가된 candle 중 volume gate 미달 |
| sparseInsuf | 1 | sparse 병목은 현재 주원인 아님 |
| admission_skip | 1 | 이번 12h window에서는 주병목 아님 |
| raw swaps | 46,099 | 유입 자체는 있었음 |

**Market shape (04-06)**: top pair (5ssLca…) 39,788 swaps, quote-volume buy ratio 0.0053 — sell-heavy. 2nd pair buy ratio 0.0.

**주병목 판정 (04-06)**: wallet / overflow / alias / unsupported_dex 가 아님. **idle universe에 stale pair가 오래 남고, 실제 평가 pair도 sell-heavy라 signal을 못 만드는 구조**. → Entry 03 1h12min 윈도에서도 동일 패턴 (idle eviction 100%) 재확인됨.

## Workstreams

### W1. Deployment Baseline

목표:
- VPS / pm2 / DB / env가 재현 가능하게 유지된다

체크:
- [ ] `.env` 운영값 점검
- [ ] `deploy:vps` 경로 확인
- [ ] `pm2 status`, `pm2 logs`, Telegram alert 동작 확인
- [ ] TimescaleDB migration / persistence sanity 확인

완료 기준:
- paper runtime을 재기동해도 운영 경로를 다시 설명할 수 있다

### W1.2. Source-of-Truth & Wallet Reconciliation

목표:
- live 판단이 stale dump / wrong wallet / attribution mismatch로 오염되지 않게 만든다
- DB `pnl` / `entry_price` / `exit_price` 컬럼을 "참고용"으로 강등하고, wallet delta를 유일한 ground truth로 확립

액션:
- [ ] **Patch A/B1을 VPS에 배포** — 신규 duplicate / close race 생성 차단 (04-17 commit 대기)
- [ ] `npm run ops:reconcile:wallet -- --days 14` 실행하여 wallet delta vs DB per-strategy pnl 비교. 전략별 drift 확정
- [ ] `npm run ops:cleanup:stuck` (dry-run) → Pnut 10 + SOYJAK 1 OPEN row 실잔고 대조
- [ ] stuck 토큰 중 실제 잔고 있는 건 **봇 정상 close 경로로 unwind 대기**, 없는 건 `--execute --i-understand-phantom`으로 DB 정리
- [ ] **`bootstrap_10s` 실거래 16건 감사**: STRATEGY.md `executionRrReject=99.0` 주장 vs 실 DB 기록 불일치 root cause 확인 (env 미반영? 가드 우회?)
- [ ] VPS에서 cupsey executor 가 실제 어떤 wallet을 사용하는지 운영값 기준 재확인
- [ ] `sync-vps-data.sh` 결과가 current session 시각과 맞는지 24h 기준 검증
- [ ] `executed-buys.jsonl` / `executed-sells.jsonl` / `trades` / Telegram notifier 를 txSignature 기준으로 교차 검증
- [ ] `wallet-reconcile` + `cleanup:stuck` 루프를 주 1회 이상 자동화 (cron 또는 OPERATIONS.md runbook)

완료 기준:
- `실제 체결`, `DB row`, `wallet delta`가 같은 거래로 설명된다
- stale dump 때문에 운영 결론이 뒤집히지 않는다
- 최근 20~30 closed cupsey trade의 `sum(wallet_delta) ≈ sum(DB.pnl)` (±5% 이내)

### W1.5. Live Freshness & Idle Eviction ✅ 부분 완료 (2026-04-15)

목표:
- stale pair를 빠르게 순환시켜 **live signal 발생 → 50 canary trades 확보**

현상 (04-06 진단):
- idleSkip=736K가 candle 평가의 대부분 점유 → 좁은 universe에 stale pair가 오래 남음
- 실제 평가 pair도 sell-heavy (buy ratio <0.01) → signal 불가
- sparseInsuf=1이므로 replay sparse 병목은 live의 주원인이 아님

액션:
- [x] idle/stale pair eviction TTL 단축: `scannerIdleEvictionMs` 1800000 → 600000 (10분)
- [x] `scannerReentryCooldownMs` 완화: 900000 → 300000 (5분)
- [x] `scannerTrendingPollMs` 단축: 900000 → 300000 (5분)
- [x] 위 적용 후 24h live 관측 → activePairs 6→9, signal/h 2.2→3.9 확인
- [x] cupsey gate soft fail-open (2026-04-16): vol_accel 1.5→1.2, buy_ratio 0.55→0.50, price_chg 0.001→0
- [ ] 50 canary trades 목표 달성 (현재 진행 중)

완료 기준:
- live에서 signal > 0 상태 24h 이상 유지 ✅
- 50 canary trades 목표 진입 (진행 중)

### W1.6. Sparse Bottleneck Resolution (04-05, replay path)

목표:
- replay backtest에서 **replay baseline sparse 차단율을 81% → <30%로** 낮춘다

현상:
- Feature 4(zero-volume skip)로 persist candle이 불연속 → lookback window 내 active candle 부족
- 4 sessions 중 1개만 edge pass, 나머지 reject → edge 재현성 판단 불가

액션:
- [ ] `minActiveCandles` / `calcSparseAvgVolume` 로직 정량 분석
- [ ] Active candle 기반 lookback 전환 검토 (시간 기반 200s → 최근 20 non-zero candle)
- [ ] Persist 시 주기적 anchor candle 삽입 검토
- [ ] 04-04 edge 재현성 검증 (per-token PnL 분해, runner vs flat 비율)
- [ ] Legacy 세션 OOM 해결 (`NODE_OPTIONS='--max-old-space-size=8192'`)

완료 기준:
- sparse 차단율 <30%, 다수 세션에서 일관된 edge 또는 명확한 edge 없음 판정

### W1.7. Mission Lane Expansion

목표:
- cupsey primary가 **wallet 기준으로 증명된 뒤** 새 lane을 **하나만** 추가하고, lane별 역할을 겹치지 않게 정리한다

진입 조건 (전제):
- W1.2 완료 (wallet↔DB 정합성, bootstrap 감사 closure)
- 최근 20~30 closed cupsey trade가 wallet delta 기준 **양의 기대값 증명** (또는 음의 기대값이면 cupsey 파라미터 재튜닝 → 재측정)

순서:
- [ ] `cupsey_flip_10s`를 current primary execution lane으로 운영 문서/판단 문맥에 일치시킨다
- [ ] `Migration Handoff Reclaim` 설계 문서 착수 — 이벤트 소스(Raydium LaunchLab 졸업, Pump.fun → PumpSwap canonical), 진입 트리거, exit 구조, ticket sizing 정의 (paper only)
- [ ] Tier 1이 paper/replay에서 최소 기준을 통과하기 전에는 Tier 2 이상 동시 live 추가 금지
- [ ] `Recent + Organic + Event Anchor`를 shared discovery upgrade로 정의하고 lane 문서와 분리
- [ ] `Liquidity Shock Reclaim`는 Tier 1 이후 backlog 1순위로 유지

완료 기준:
- active plan에 `current primary lane`과 `next lane`이 하나씩만 명시된다
- 운영자가 지금 어떤 lane을 살리고 어떤 lane을 아직 만들지 않는지 혼동하지 않는다

### W2. Paper Validation Loop

목표:
- paper에서 충분한 표본과 운영 품질을 확보한다

집중 지표:
- expectancy after fees/slippage
- quote decay
- gate rejection mix
- hold time / exit reason distribution
- explained entry ratio
- bootstrap replay sweep 결과와 live canary가 같은 방향을 가리키는지
- actual-cost accounting 이후 DB PnL과 wallet PnL 차이

완료 기준:
- [ ] `paper-report`로 해석 가능한 표본 확보
- [ ] 운영 노이즈와 전략 문제를 분리할 수 있음
- [ ] live 전환 판단을 문서로 설명 가능

### W3. Live Enablement Gate

목표:
- live를 "기능 확인"이 아니라 "운영 기준 충족 후 전환"으로 다룬다

전환 전 확인:
- [ ] paper 기대값 재확인
- [ ] bootstrap stable baseline (`1.8 / 0.60 / 20`)의 live cadence 확인
- [ ] operator blacklist runtime hit / false block 여부 확인
- [ ] live buy actual-cost accounting이 wallet delta와 크게 어긋나지 않음
- [ ] risk guard / halt / wallet limit 정상
- [ ] quote / sell impact / execution telemetry 해석 가능
- [ ] 운영 개입 없이 일정 시간 유지 가능

완료 기준:
- live enablement를 yes/no로 판정할 근거가 준비됨

### W4. Optional External Backlog

이 항목들은 active 핵심이 아니다.

- X Filtered Stream 실연동
- Strategy D listing source 확대
- 추가 social/discovery source 실험

원칙:
- core validation을 밀어내지 않는다

## Operational Rules

### Do

- active 판단은 이 문서와 [`OPERATIONS.md`](../../../OPERATIONS.md)를 기준으로 본다
- historical 근거가 필요하면 [`PLAN_CMPL.md`](../../../PLAN_CMPL.md)를 참고한다
- 파라미터 튜닝보다 운영 관측성과 표본 품질을 먼저 본다
- replay sweep 결과는 live canary 후보 압축용으로 쓰고, 실운영 증거와 혼동하지 않는다

### Do Not

- archive 문서를 current plan처럼 읽지 않는다
- 과거 canary 메모를 현재 상태 요약에 다시 복붙하지 않는다
- optional backlog를 core validation보다 앞세우지 않는다

## Exit Criteria

현재 active plan은 아래 중 하나가 되면 종료한다.

1. paper / live enablement 기준이 명확히 충족된다
2. 운영 검증 결과를 바탕으로 새 active plan이 필요해진다
3. 현재 문서의 체크리스트가 모두 archive 가능한 상태가 된다

## One-Line Summary

> Phase E P0~P3 fake-fill 정합성은 04-07 배포 완료, Phase D acceptance 통과, Phase M day-1 baseline 기록. **현재 P0는 quartet다: `P0-0 source-of-truth closure`, `P0-A exit mechanism`, `P0-B fresh flow`, `P0-C winner preservation`**. Strategy A/C 5m은 여전히 dormant.
>
> **2026-04-17 실측 현실**: wallet 1.3 → 1.07 SOL (−0.23), 같은 기간 DB pnl 합계 +18.11. drift +18.34 SOL — DB 기반 모든 전략 평가는 환상이었다. duplicate 24% + close race가 근본 원인, Patch A/B1 구현 완료 / VPS 배포 대기. `cupsey_flip_10s`는 **조건부 current primary** (wallet 기준 expectancy 증명 전까지 메인 wallet/risk 확정 금지). 다음 lane `Migration Handoff Reclaim`은 Tier 0 증명 완료 전까지 설계만, live 배포 금지.
