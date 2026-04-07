# Execution Plan: 1 SOL → 100 SOL

> Status: current active execution plan
> Updated: 2026-04-07 (Phase E deploy reflection)
> Scope: 구현 완료 이후의 운영 검증, 배포, 표본 축적, live enablement gate
> Archive: 완료된 root plan과 dated canary history는 [`PLAN_CMPL.md`](../../../PLAN_CMPL.md)에 보관한다.
> Sub-plans: [`live-ops-integrity-2026-04-07.md`](./live-ops-integrity-2026-04-07.md) (Phase E P0~P3 fake-fill 운영 후속 트래킹)

## Role

이 문서는 현재 active execution plan이다.

- 구현 완료 여부를 기록하는 문서가 아니다
- historical canary를 해석하는 문서도 아니다
- 지금 남아 있는 운영 검증과 배포 우선순위를 정하는 문서다

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

구현 완료 이력과 canary history는 [`PLAN_CMPL.md`](../../../PLAN_CMPL.md)를 본다.

### 현재 남은 것

- **P0: Idle universe + volume gate 병목 해소** — stale pair eviction + freshness 개선으로 live signal 확보
- **P1: Replay baseline sparse 차단율 81% 해소** — edge 측정 자체를 가능하게 만들기 (replay path)
- 04-04 edge (score 78)의 재현성 검증 — runner outlier vs 구조적 edge
- Legacy 세션 재검증 (OOM 해결, 113 stored signals)
- paper 표본을 운영 가능한 방식으로 쌓는다
- live enablement 기준을 명확히 통과시킨다

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

**핵심 판정**: **W1.5 idle universe + admission breadth 병목은 Phase E 이후에도 여전히 1차 binding constraint다**. Phase E는 가격 단위 정합성 + fake-fill 격리를 해결했지만, 50 canary trades 확보를 위한 universe 흐름 자체는 아직 트리거되지 않았다.

**다음 액션 (우선순위순)**:
1. **W1.5 액션 재진입** — idle/stale pair eviction 강화 또는 TTL 단축. Entry 03 1h 표본은 너무 작아 즉시 결정 금지, day-1→day-2 (>19h) 분포 확인 후 결정
2. **admission_skip:unsupported_dex=21 분석** — 어느 DEX가 차단되는지 확인 후 확장 여부 판단 (W1.5 액션 이후)
3. Phase M 7일 모니터링 acceptance 누적 — `entry_gap_p95`, `exit_gap_p95`, `exit_anomaly_rows`, `realized_replay_excluded` 4종 metrics_note (`docs/runbooks/live-ops-loop.md:268+`)
4. `volumeSurgeMultiplier 1.8 → 1.6`은 위 3건 후에도 signal 부족 시 검토

**한 줄**: "측정은 정직해졌다 (Phase E). 이제 universe를 흐르게 만들어야 표본이 쌓인다 (W1.5)".

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

### W1.5. Live Freshness & Idle Eviction (신규, 04-06)

목표:
- stale pair를 빠르게 순환시켜 **live signal 발생 → 50 canary trades 확보**

현상 (04-06 진단):
- idleSkip=736K가 candle 평가의 대부분 점유 → 좁은 universe에 stale pair가 오래 남음
- 실제 평가 pair도 sell-heavy (buy ratio <0.01) → signal 불가
- sparseInsuf=1이므로 replay sparse 병목은 live의 주원인이 아님

액션:
- [ ] idle/stale pair eviction 로직 추가 또는 기존 TTL 단축
- [ ] `scannerMinimumResidencyMs` / `scannerReentryCooldownMs` 소폭 완화
- [ ] 위 적용 후 24h live 관측 → signal 발생 확인
- [ ] signal 발생 but trade 없으면 `volumeSurgeMultiplier` 1.8 → 1.6 검토
- [ ] unsupported_dex 확장은 위 액션 후에도 breadth 부족 시만

완료 기준:
- live에서 signal > 0 상태를 24h 이상 유지, 50 canary trades 목표 진입

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

> Phase E P0~P3 fake-fill 정합성은 04-07 배포 완료, Phase D acceptance 통과, Phase M day-1 baseline 기록. **다음 P0는 W1.5 idle universe 병목 해소** — Phase E 직후 1h12min 표본도 candidate 100% idle eviction 재확인. Phase M 7일 누적 + W1.5 액션 진입 + 50 canary trades 확보 후 live enablement 판단. Strategy A/C 5m은 여전히 dormant.
