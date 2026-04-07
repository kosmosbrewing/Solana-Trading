# Execution Plan: Edge Cohort Quality (Universe / Concentration / Measurement)

> Status: current active execution plan
> Updated: 2026-04-07
> Origin: `docs/ops-history/2026-04-07.md` Entry 02 Long-Term Improvement Plan
> Scope: ops-history에서 출발한 3축 장기 개선의 owner / target_files / acceptance_criteria 바인딩
> Use with: `docs/ops-history/2026-04-07.md`, `docs/exec-plans/active/1sol-to-100sol.md`, `STRATEGY_NOTES.md`

## Role

이 문서는 ops-history Entry 02 Long-Term Plan 3축의 실행 바인딩이다.

- ops-history는 진단 기록 (목표/근거/방향만 짧게 immutable)
- 이 exec-plan은 실행 기록 (target_files / owner / acceptance / lifecycle)
- ops-history Entry 02는 `exec_plan_link`로만 이 문서를 가리킨다

3축은 axis_1_universe_quality, axis_2_concentration_control, axis_3_edge_measurement_by_cohort 이며, 각각의 owner / acceptance / files를 아래에 고정한다.

원칙:

- 하나의 axis를 종결하기 전까지 다른 axis로 우선순위 이동 금지
- acceptance_criteria는 metric으로만 정의 (정성 표현 금지)
- 모든 acceptance metric은 기존 ops:check / trade-report / scripts/analysis 산출물로 측정 가능해야 한다 (새 도구 필요 시 별도 task)

---

## Axis 1 — Universe Quality

### 목표
`더 많은 pool` 확보가 아니라 `더 맞는 pool` 확보. executable low-cap universe의 정제.

### 근거 (2026-04-07T04:01:48Z ~ 11:01:48Z)
- `candidate_seen_recent_7h: 246`
- `candidate_evicted_recent_7h: 253`
- `idle_evicted_recent_7h: 252`
- `non_sol_quote_recent_7h: 39`
- `unsupported_dex_recent_7h: 45`
- `pre_watchlist_reject_recent_7h: 39`

### Target Files
- `src/scanner/scannerBlacklist.ts`
- `src/scanner/scannerCandidate*.ts` (idle eviction / residency 로직)
- `src/scanner/admission*.ts` (admission 단계 SOL quote / supported dex / TVL / marketCap band / token age band 사전 필터)
- `src/utils/config.ts` (scannerMinimumResidencyMs, scannerReentryCooldownMs 등 임계값)

### Owner
`igyubin` (CEO) — 작업 위임 시 OnchainAnalyst(`62f28d7a`) 후보

### Acceptance Criteria
모두 충족 시 axis_1 종결:

- [ ] `candidate_evicted / candidate_seen` 비율이 7h window 기준 ≤ 0.9 로 안정화 (현재 1.03)
- [ ] `idle_evicted / candidate_seen` 비율이 7h window 기준 ≤ 0.7 로 안정화 (현재 1.02)
- [ ] `non_sol_quote + unsupported_dex` 합이 동일 window에서 ≥ 50% 감소 (현재 84/7h)
- [ ] 위 3개 조건이 연속 3개 ops loop entry에서 유지

### Measurement Source

- 명령: `npm run ops:check:helius -- --hours 7`
- 출력 라벨 매핑 (`scripts/ops-helius-check.ts:280` regex 기반):
  - `realtime_candidate_seen` → Axis 1 분모 `candidate_seen` (단, `distinctTokenSet` 기반 dedup된 set size, `src/reporting/runtimeDiagnosticsTracker.ts:222`)
  - `candidate_evicted` → Axis 1 분자 `candidate_evicted` (`summarizeTokenEventCount` 기반 raw 이벤트 카운트, `:240`)
  - `candidate_evicted:idle` → Axis 1 분자 `idle_evicted`
  - `pre_watchlist_reject:non_sol_quote` → Axis 1 `non_sol_quote`
  - `admission_skip:unsupported_dex` → Axis 1 `unsupported_dex`
- **측정 caveat (2026-04-07 검증)**: `candidate_seen`(분모)과 `candidate_evicted`(분자)는 집계 방식이 비대칭이라 ratio가 1.0을 초과할 수 있다. Entry 02의 1.03은 산술 모순이 아니라 `Set size vs raw event count` 차이다 (`docs/ops-history/2026-04-07.md` Entry 02 metrics_note 참조). 따라서 acceptance ≤ 0.9 임계는 **상대 개선** 지표이지 **물리적 상한** 지표가 아니다 — 연속 3 entry 추세 안정화로 판정한다.
- ratio 계산은 operator 수동(`evicted / seen`). 자동화는 별도 task로 분리(필요 시 `ops-helius-check.ts:printVerdict` 다음에 Axis 1 ratio 3줄 출력 enhancement 검토).

### Lifecycle
- 시작: 2026-04-07
- 다음 점검: 2026-04-08 첫 ops loop entry
- 종결 조건: 위 acceptance 4개 모두 통과
- 종결 시 archive: `PLAN_CMPL.md`로 이동

### Exec Plan Link
- 상위 plan: `docs/exec-plans/active/1sol-to-100sol.md` § "현재 남은 것" P0 (Idle universe)

---

## Axis 2 — Concentration Control

### 목표
진짜 edge가 만든 집중과 나쁜 universe가 만든 집중을 구분하고 후자만 억제.

### 근거 (2026-04-07T04:01:48Z ~ 11:01:48Z)
- `runtime_signal_rows_recent_7h: 8` 중 `PIPPIN: 6/8` (75%)
- 진입 2건 모두 `PIPPIN`, 이후 cooldown 차단 4건
- `unique_signaled_tickers_recent_7h: 3`
- closed `1W / 3L`, `realized_recent_7h: -0.000509 SOL`

### Target Files
- `src/risk/riskManager.ts` (PER_TOKEN_LOSS_COOLDOWN_*, SAME_PAIR_OPEN_POSITION_BLOCK 유지)
- `src/orchestration/signalProcessor.ts` (recent signal concentration cap 후보 위치)
- `src/reporting/edgeTracker.ts` (per-mint concentration metric 노출)
- 신규 후보: `src/risk/concentrationGuard.ts` (사전 분산 장치 — same-ticker shadow demotion)

### Owner
`igyubin` (CEO)

### Acceptance Criteria
모두 충족 시 axis_2 종결:

- [ ] 상시 ops loop에 `top_mint_concentration` 지표가 포함됨 (live-ops-loop.md Section 4D 또는 신규 metric)
- [ ] 임의 7h window에서 `top_signal_pair / total_signals` 비율이 ≤ 0.5 로 안정화 (Entry 02 7h: 0.75 PIPPIN=6/8 → Entry 05 7h: pippin=14/28=0.50, swarms=14/28=0.50 — **임계 상한 정확히 도달, top_signal 단일 ticker가 아니라 두 ticker가 100% 점유**)
- [ ] `recent signal concentration cap` 또는 동등 사전 분산 장치가 코드로 들어가 있음 (블록 사유 분리 가능)
- [ ] 위 조건 3개가 연속 3개 ops loop entry에서 유지

**측정 caveat (2026-04-08, ralph-loop iter8)**: 단일 top_signal_pair가 0.5 이하로 떨어졌어도 상위 N개 누적 점유율(`top2_signal_pairs / total`)이 1.0이면 분산 효과는 0이다. Entry 05 window에서 두 ticker(pippin/swarms)가 정확히 7건씩 분할하면서 acceptance metric을 우회한 케이스 발생 — `top_mint_concentration` 지표 정의에 `top1`만 보지 말고 `top2/top3`까지 함께 두는 것을 추가로 검토해야 한다 (별도 task로 분리).

### Lifecycle
- 시작: 2026-04-07
- 의존: axis_1 부분 진척 (universe quality가 너무 좁으면 concentration control 자체가 false positive를 만든다)
- 종결 시 archive: `PLAN_CMPL.md`

### 주의 (Codex 피드백 반영)
- `CRITICAL_LIVE.md §7E` sanitizer는 **execution / report quality 도구**이지 concentration 도구가 아니다. 이 axis와 직접 연결하지 않는다.
- §7E는 별도로 axis 외부의 P1 audit으로 다루며, F1-deep audit (`docs/audits/exit-slip-gap-divergence-2026-04-07.md`) 안에서만 cross-reference한다.

---

## Axis 3 — Edge Measurement by Cohort

### 목표
bootstrap edge가 어디에서 나오는지 `marketCap / volumeMcap / freshness` cohort별로 분리해 측정.

### 근거 (2026-04-07T04:01:48Z ~ 11:01:48Z)
- `PIPPIN`은 대형 밈 continuation에 가까움
- `4ytp...`는 저시총 / high volume-mcap edge 가설에 더 가까웠음 (PRICE_ANOMALY_BLOCK으로 차단되어 표본 없음)
- 현재 `volumeMcap`은 boost로만 사용, ranking/admission에서는 미사용

### Target Files
- `src/reporting/realtimeMeasurement.ts` (cohort 분리 집계 추가)
- `src/reporting/realtimeShadowReport.ts` (cohort별 outcome 출력)
- `src/reporting/edgeTracker.ts` (cohort별 win-rate / R-multiple)
- `scripts/analysis/realized-replay-ratio.ts` (cohort 단위 replay 비교)
- 신규 후보: `src/reporting/cohortClassifier.ts` (marketCap band / volumeMcap band / freshness band 분류 헬퍼)

### Owner
`igyubin` (CEO) — 분석 작업 위임 시 OnchainAnalyst(`62f28d7a`) 또는 EventScout(`ef3f7d71`) 후보

### Acceptance Criteria
모두 충족 시 axis_3 종결:

- [~] signal / trade / realized PnL이 `marketCap cohort` × `volumeMcap cohort` × `freshness cohort` 3차원으로 분리 집계 가능
  - **partial (signal-level only, 2026-04-07)**: `scripts/analysis/signal-cohort-audit.ts` 신설로 signal-intents.jsonl을 입력으로 marketCap × volumeMcap × processing.status 분리 가능. trades 테이블에 marketCap 컬럼이 없어 trades-level 집계는 미충족 — 추후 trades schema 확장 또는 JOIN 로직으로 보강 필요. freshness cohort는 미구현 (`discoveryTimestamp` 필드는 signal-intents에 있으나 band 정의 미정).
- [ ] 7d 누적 표본에서 cohort별 win-rate / R-multiple 차이가 통계적으로 의미 있는 구간 (≥ 30 trades / cohort) 1개 이상 식별
  - 현재(2026-04-07): low-cap surge cohort 7 trades / 3 unique token / 7 losses (Entry 04 audit). 표본 부족, 7d 누적 대기.
- [~] live/paper 결과 기준으로 "low-cap surge" 가설이 cohort 단위로 confirm 또는 reject 됨 (replay 결과만으로는 종결 불가)
  - **inconclusive (2026-04-07)**: signal pass rate 측면 partial confirm (29.2% > 16.3%), 실측 손익 측면 partial reject (7/7 loss, n=3 unique token), 극단 저시총 ($44K) cohort 0 trades — confirm/reject 모두 단정 불가. Entry 04 참조.
- [ ] **(2026-04-08 신설)** exit reason × cohort 교차 측정 가능 — closed trades 의 `TP1 / TP2 / SL / TRAILING / TIME_STOP` 도달 빈도와 평균 R 분포를 marketCap/volumeMcap cohort별로 분리 조회. exit 구조 적합성 판단의 입력값.
  - 의존: `docs/exec-plans/active/exit-structure-validation-2026-04-08.md` Phase X2 (`scripts/analysis/exit-distribution-audit.ts`). cohort 분리는 trades schema 확장 또는 signal-intents.jsonl JOIN 후 가능.

### Lifecycle
- 시작: ~~axis_1 1차 통과 후 (universe가 fresh candidate를 충분히 공급해야 cohort별 표본이 확보된다)~~ → **2026-04-07 보강**: signal-level 측정은 axis_1 의존을 떠나 즉시 가능. trade-level 측정만 axis_1 의존 (universe quality가 표본 다양성을 결정).
- 진행: 2026-04-07 ralph-loop iter7 — signal-level 1차 측정 완료 (Entry 04)
- 종결 조건: 위 acceptance 3개 모두 통과
- 종결 시 archive: `PLAN_CMPL.md`

### Exec Plan Link
- 상위 plan: `docs/exec-plans/active/1sol-to-100sol.md` § "Latest Live Diagnosis" 다음 액션 후순위

---

## Cross-Axis Notes

- Axis 1 → 3 의존: universe가 좁으면 cohort 표본이 안 쌓인다
- Axis 2 → 1 의존: concentration이 universe 결함의 결과인지 edge 결과인지 구분 가능해야 axis_2의 acceptance metric이 의미 있다
- 따라서 실행 순서는 권장: **Axis 1 → Axis 2 → Axis 3** (병렬 금지)

## Out of Scope (이 plan에서 다루지 않음)

- Phase A/B/C1 가드 자체의 false-positive rate 측정 — `docs/audits/exit-slip-gap-divergence-2026-04-07.md` (F1-deep audit)에서 다룸
- ledger pre-guard cleanup — `CRITICAL_LIVE.md §7E`에서 다룸
- bootstrap trigger 파라미터 튜닝 — `docs/exec-plans/active/1sol-to-100sol.md`에서 다룸
- risk cooldown 완화 — execution/report quality audit 통과 전까지 forbidden

## History

- 2026-04-07: ops-history Entry 02 Long-Term Plan 3축에서 분리 생성
- 2026-04-07 (ralph-loop iter7): signal-level cohort 측정 도입 — `scripts/analysis/signal-cohort-audit.ts` + `docs/audits/signal-cohort-2026-04-07.md`. axis_3 acceptance 첫·셋째 칸 partial 충족. 4 sessions / 86 signals / 71 with marketCap 표본. 사용자 가설 (저시총 surge edge) 1차 verdict는 inconclusive — Entry 04 참조
- 2026-04-08 (ralph-loop iter8): Phase 1 read-only PRICE_ANOMALY ratio audit (`docs/audits/price-anomaly-ratio-2026-04-08.md`). 7h window 28 signals 중 pippin=14/swarms=14 100% 두 ticker 점유 → axis_2 acceptance metric `top_signal_pair / total ≤ 0.5` 임계 정확 도달지만 top2 누적은 1.0으로 분산 효과 zero. caveat 명시 + iter9 PumpSwap IDL discriminator code-only verification 다음 단계로 예약 — Entry 05 참조
