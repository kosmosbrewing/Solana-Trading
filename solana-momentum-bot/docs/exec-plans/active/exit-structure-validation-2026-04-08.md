# Execution Plan: Exit Structure Validation

> Status: active (depends on `exit-execution-mechanism-2026-04-08.md` completion)
> Created: 2026-04-08
> Origin: Codex 진단 (2026-04-08) — bootstrap_10s live exit 구조의 적합성 의문 제기
> Scope: TP1 partial 30% / TP2 10×ATR / SL 1.5×ATR runner-centric 구조의 live 적합성 측정 + 가설 옵션 분기 (**parameter side**)
> Depends on: [`exit-execution-mechanism-2026-04-08.md`](./exit-execution-mechanism-2026-04-08.md) — Phase X2 v2 finding (`TP2 intent → actual = 0/10`)이 mechanism issue 임이 확인되어 parameter 결정은 mechanism plan 완료 후에만 valid
> Use with: `STRATEGY.md`, `STRATEGY_NOTES.md` (2026-04-08 메모), `docs/exec-plans/active/edge-cohort-quality-2026-04-07.md` Axis 3, `docs/exec-plans/active/live-ops-integrity-2026-04-07.md` Phase M, `docs/exec-plans/tech-debt-tracker.md` TD-14 / TD-15

## Role

이 문서는 **exit 구조의 live 적합성 판단**을 위한 측정·가설·결정 lifecycle을 고정한다.

- 코드 변경(orderShape 튜닝)은 Phase X3 가설 분기 통과 전까지 금지
- ops-history Entry 02 forbidden 절(*"리포트/실행 품질 불일치 상태에서 1W/3L만 보고 cooldown 완화 금지"*)을 exit 튜닝에도 동일 원칙으로 적용한다
- 측정 인프라가 ops-history 의 입력값이지, ops-history가 measurement 결과를 자체 생성하지 않는다

## Background

### Codex 진단 요약 (2026-04-08)

| 구조 요소 | 현재 값 | Codex 우려 |
|---|---|---|
| SL | ATR × 1.5 | 손실은 짧게 — 구조적으로 OK |
| TP1 | ATR × 1.0, 30% partial | 1R에서 30% 익절 → 명목 0.3R 실현. 상쇄 win rate ≥ 77% 필요 |
| TP1 후 잔여 70% | SL=entry, time stop +30min, runner 대기 | runner 미발생 시 본전 보호로 0이 되거나 trailing stop으로 작은 수익만 |
| TP2 | ATR × 10.0 | sweep 최적 5×ATR에서 v5 runner-centric으로 확장. live 도달율 미검증 |
| Trailing | TP1 이후만 활성화 | 본전 보호와 함께 보수적으로 동작 |

### 측정 데이터 (current)

- 2026-04-07T04:01Z~11:01Z (Entry 02): 4 closed entry, `1W / 3L`, `realized = -0.000509 SOL`, big runner 0건
- 2026-04-07T12:21Z~13:33Z (Entry 03): 1 closed (lingering position 자연 unwind), 신규 entry 0건
- 2026-04-07 cohort audit (Entry 04): low-cap surge cohort 7 trades / 3 unique token / 7 losses
- **표본 합계 ≤ 5 closed entries (post-Phase E clean)** — 통계적 결론 불가

### 핵심 진단

> "exit 구조가 틀렸다"가 아니라 "exit 구조를 판단할 측정 인프라가 부족하다"가 정확한 진단.

따라서 본 plan은 **튜닝 plan이 아니라 측정·결정 lifecycle plan**이다.

---

## Phase X1 — Pre-tuning Hygiene (의존: 진행 중)

### 목표

clean closed trades 누적을 위해 Phase E fake-fill 마킹·필터링이 안정 동작하는지 7일 모니터링.

### 작업

- [ ] `live-ops-integrity-2026-04-07.md` Phase M day-1 ~ day-7 모니터링 누적
- [ ] `exit_anomaly_reason IS NOT NULL` 카운트 일별 ops-history 기록
- [ ] sanitizer `fake_fill_slippage` drop 카운트 일별 기록
- [ ] `realized-replay-ratio` 헤드라인의 `excluded N parent groups / M rows` 추적
- [ ] 7일 후 `FAKE_FILL_SLIPPAGE_BPS_THRESHOLD = 9000` 임계 유지/상향 결정

### Acceptance Criteria

- [ ] 7일 연속 fake-fill 마킹/drop 카운트가 ops-history에 기록됨
- [ ] post-Phase E clean closed trades **≥ 20건** 누적 (Bootstrap → Calibration tier 전환점과 정렬)
- [ ] `exit_anomaly_reason` false positive 0건 또는 명시적 분석 통과

### Lifecycle

- 시작: 2026-04-07 (Phase E 배포일)
- 종결 조건: 위 acceptance 3개 모두 통과 → Phase X2 진입
- 위임: `live-ops-integrity-2026-04-07.md` Phase M acceptance와 동일하게 운영

### Exec Plan Link

- 상위 plan: `docs/exec-plans/active/live-ops-integrity-2026-04-07.md` Phase M

---

## Phase X2 — Exit Distribution Audit (신규)

### 목표

TP1 / TP2 / SL / TRAILING / TIME_STOP 5가지 종료 사유의 도달 빈도 + 평균 R 분포 측정. exit 구조 결론을 위한 clean baseline 확보.

### 작업

- [ ] **신규 script**: `scripts/analysis/exit-distribution-audit.ts`
  - 입력: trades 테이블 (`exit_anomaly_reason IS NULL` AND `status = 'CLOSED'`) 또는 동기화된 `vps-trades-latest.jsonl`
  - parent-grouped: TP1 partial child를 root parent에 합산 (signal-cohort-audit pattern reuse)
  - 출력 1: exit reason × {n, %, avg_realized_R, avg_pnl_sol, p25/p50/p75 R}
  - 출력 2: TP1 도달율, TP2 도달율, SL 도달율 한 줄 헤드라인
  - 출력 3: cohort 분리 (marketCap × volumeMcap, signal-intents.jsonl JOIN 시도) — best-effort
- [ ] **`scripts/trade-report.ts` 확장**: exit reason breakdown 섹션 추가 (도달율 + 평균 R)
- [ ] **신규 audit doc**: `docs/audits/exit-distribution-2026-04-08.md` (또는 첫 표본 누적일 기준 리네이밍)
- [ ] ATR 절대값 분포 측정 (입력: signal-intents.jsonl 또는 trades context):
  - median / p25 / p75 ATR (price 대비 %)
  - ATR이 너무 작은 구간이면 SL 1.5×ATR이 노이즈에 잡히는지 확인
  - **caveat**: 신호 시점 ATR이 signal-intents에 직접 persist되지 않을 수 있음 — 가능한 source 확인 필요

### Target Files

- `scripts/analysis/exit-distribution-audit.ts` (신규)
- `scripts/trade-report.ts` (exit-reason breakdown 섹션 추가, 후순위)
- `docs/audits/exit-distribution-YYYY-MM-DD.md` (출력)

### Owner

`igyubin` (CEO) — 분석 작업 위임 시 OnchainAnalyst(`62f28d7a`) 후보

### Acceptance Criteria

- [ ] `exit-distribution-audit` 첫 실행 — clean trades ≥ 20건 입력 + exit reason 분포 출력
- [ ] TP1 도달율 / TP2 도달율 / SL 도달율 / TRAILING 도달율 / TIME_STOP 도달율 5개 수치가 명확히 산출됨
- [ ] 평균 R per exit reason이 산출됨 (NaN 방어 — 표본 0건 reason은 명시적 표시)
- [ ] `docs/audits/exit-distribution-*.md` 에 결과 기록 + Phase X3 분기 권장값 표시

### Lifecycle

- 시작: Phase X1 종결 직후 (clean trades ≥ 20건 누적 시점)
- **현재 상태**: 측정 도구는 Phase X1 진행 중에도 미리 작성 가능 (이 plan의 즉시 next action)
- 종결 조건: 위 acceptance 4개 모두 통과 → Phase X3 가설 분기 진입

### Exec Plan Link

- 상위 plan: `docs/exec-plans/active/edge-cohort-quality-2026-04-07.md` Axis 3 acceptance 4번째 칸 (2026-04-08 신설)

---

## Phase X3 — Exit Hypothesis Test (조건부, Phase X2 결과 의존)

### 진입 조건

Phase X2의 측정 결과가 다음 시나리오 중 하나를 만족하면 진입한다. 그 전에는 코드 변경 금지.

### Scenario A — "TP2 거의 도달 안 함"

**진입 조건**: TP2 도달율 ≤ 10% (n ≥ 20 clean trades)

**가설**: TP2 10×ATR 너무 낙관적, runner-centric 구조가 live에서 작동 안 함

**옵션**:
- **A1**: `tp2Multiplier` 10.0 → 5.0 축소 (sweep 최적값 복귀)
- **A2**: `tp1PartialPct` 0.3 → 0.5 상향 (TP1 실현 비중 확대)
- **A3**: 위 두 가지 조합

**검증**: paper mode 50건 + live canary 20건, max DD ≤ 3%

### Scenario B — "ATR 자체가 너무 작음"

**진입 조건**: median ATR < 0.3% of price (n ≥ 20 signals)

**가설**: 10s candle ATR이 노이즈에 가까워 SL이 조기 stop-out

**옵션**:
- **B1**: ATR floor 도입 (`max(ATR × 1.5, price × 0.5%)`)
- **B2**: 60s candle ATR로 변경 (long timeframe ATR)
- **B3**: SL multiplier 1.5 → 2.0 상향

**검증**: replay sweep + paper mode

### Scenario C — "TP1 잦지만 TP1 → TP2 전환 부족"

**진입 조건**: TP1 도달율 ≥ 50% AND TP2 도달율 ≤ 10% AND remainder가 TIME_STOP 또는 TRAILING으로 종결

**가설**: 본전 보호 + trailing 구조가 너무 보수적이라 잔여 70%가 의미 없게 종결

**옵션**:
- **C1**: TP1 후 SL을 entry가 아닌 `entry + 0.5 × ATR` 한 단계 더 보수
- **C2**: trailing 활성화 시점을 TP1 직후가 아닌 `entry + 1.5 × ATR` 도달 후로 변경
- **C3**: `tp1TimeExtensionMinutes` 30 → 60 연장

**검증**: replay sweep

### Scenario D — "구조가 작동 중인데 표본이 작아서 안 보였을 뿐"

**진입 조건**: TP2 도달율 ≥ 20% AND avg realized R per TP2 ≥ 5R

**행동**: 튜닝 없음. 추가 표본 누적으로 진행.

### Out of Scope (Phase X3에서 다루지 않음)

- runner Grade A/B 조건 변경 — Phase X3 결과로도 부족 시 별도 plan
- `realtimeSlAtrMultiplier` 1.5 직접 변경 — slippage 고려 결정값이므로 Scenario B에서만 다룸
- `realtimeTimeStopMinutes` 15 변경 — Scenario C 옵션에서만 다룸

### Owner

`igyubin` (CEO)

### Acceptance Criteria

조건부 진입 후:

- [ ] Phase X2 측정 결과 → 1개 시나리오 확정 (또는 D 진단)
- [ ] 시나리오 옵션 중 1개 선택 + 근거 문서화
- [ ] paper mode 검증 통과 (≥ 50 trades, max DD ≤ 3%)
- [ ] live canary 검증 통과 (≥ 20 trades, max DD ≤ 3%)
- [ ] live 전환 시 `tradingParams.ts` PR로 변경 + 본 plan에 결과 추가

### Lifecycle

- 시작: Phase X2 종결 후
- 종결 조건: 위 acceptance 5개 모두 통과 → Phase X4 진입
- 또는 Scenario D 확정 시 즉시 종결 (no-op)

---

## Phase X4 — Decision Window

### 목표

Phase X3에서 적용된 옵션이 live에서 안정적으로 작동하는지 7일 모니터링하고, 실패 시 원복 또는 Phase X2 재측정.

### 작업

- [ ] live 전환 후 7일 daily PnL / max DD 추적
- [ ] 동일 기간 exit reason 분포 재측정 (Phase X2 script 재실행)
- [ ] 변경 전/후 R-multiple 분포 비교
- [ ] 7일 후 결과 기록:
  - **유지**: 변경된 파라미터를 STRATEGY.md / tradingParams.ts 의 새 baseline으로 고정
  - **원복**: `tradingParams.ts` PR revert + Phase X2 재측정 트리거

### Acceptance Criteria

- [ ] 7일 연속 daily PnL 기록 (ops-history)
- [ ] max DD 측정값이 변경 전 baseline 대비 악화되지 않음
- [ ] R-multiple 분포 비교 결과가 본 plan에 추가됨
- [ ] 유지/원복 결정이 명시적으로 기록됨

### Lifecycle

- 시작: Phase X3 live 전환 후
- 종결 조건: 위 acceptance 4개 모두 통과
- 종결 시 archive: 본 plan을 `docs/exec-plans/completed/`로 이동

---

## Current Status Summary

| Phase | Status | Owner | Target Completion |
|---|---|---|---|
| Phase X1 — Hygiene (clean ≥ 20) | 🔴 진행 중 (live-ops-integrity Phase M 의존) | igyubin | 배포 + 7일 |
| Phase X2 — Distribution Audit | 🟢 measurement 도구 v2 완료 + 1차 audit (n=18, sample-gate 미달) | igyubin / OnchainAnalyst | Phase X1 종결 직후 재실행 |
| Phase X3 — Hypothesis Test | 🔴 pending | igyubin | Phase X2 결과 의존 |
| Phase X4 — Decision Window | 🔴 pending | igyubin | Phase X3 live 전환 후 7일 |

## Forbidden (이 plan scope 안의 금지 사항)

- `tradingParams.ts:56-64` `orderShape.tp1Multiplier`, `tp2Multiplier`, `tp1PartialPct` 직접 변경 — Phase X2 결과 없이는 금지
- `tradingParams.ts:184` `realtimeSlAtrMultiplier` 직접 변경 — Scenario B 진입 전 금지
- `tradingParams.ts:186` `realtimeTimeStopMinutes` 직접 변경 — Scenario C 옵션에서만
- runner Grade A/B 조건 변경 — Phase X3 결과로도 부족 시 별도 plan 필요
- 표본 < 20일 때 "구조가 틀렸다"고 단정하는 것

## Out of Scope (이 plan에서 다루지 않음)

- bootstrap trigger 파라미터 튜닝 — `docs/exec-plans/active/1sol-to-100sol.md`
- universe / concentration 개선 — `docs/exec-plans/active/edge-cohort-quality-2026-04-07.md`
- Phase A/B/C1 가드 false-positive rate — `docs/audits/exit-slip-gap-divergence-2026-04-07.md`
- ledger pre-guard cleanup — `CRITICAL_LIVE.md §7E`
- **exit *mechanism* 개선** (candle observation → tick observation, market sell → limit, sub-second monitoring) — 본 plan은 exit *parameter* tuning만 다룬다. exit_reason vs exit_price gap이 측정되면 (Phase X2 v2) 별도 plan으로 분리 필요. 후보 plan 이름: `exit-execution-mechanism-YYYY-MM-DD.md`

## Phase X2 v2 Finding (2026-04-08, n=18)

`scripts/analysis/exit-distribution-audit.ts` v2 — `intent vs actual outcome` cross-tabulation 추가 후 1차 audit:

| metric | value |
|---|---|
| post-Phase E clean trades | 18 (sample-gate 20 미달) |
| TP2 intent rate (exit_reason=TAKE_PROFIT_2) | 55.6% (10/18) |
| **Actual TP2 reach rate (exit_price ≥ TP2)** | **0.0% (0/18)** |
| TP2 intent → actual TP2 match rate | 0/10 = **0%** |
| Actual outcome distribution | SL_OR_WORSE 50%, BELOW_ENTRY 44.4%, BELOW_TP1 5.6% |
| net realized PnL (n=18) | -0.017809 SOL |

### 의미

`exit_reason`은 monitor loop가 trigger를 발동시킨 *intent*고 `exit_price`는 Jupiter swap의 *actual fill*이다. n=18 표본에서 두 값의 분리가 **TP2 intent의 100% 발생**:

- Monitor가 candle `observedHigh ≥ takeProfit2` 조건으로 TP2 trigger 발동
- closeTrade → Jupiter sell 호출
- swap latency 동안 메모코인 price가 reverse → 실제 fill은 SL 근처
- DB에 `exit_reason=TP2, exit_price=SL_level` 으로 stamping

이것은 stamping bug가 아니다 — 코드는 의도대로 동작 중이다. **measurement layer가 intent만 기록하고 actual outcome을 분류하지 않은 것이 문제**였다. v2 audit script가 두 axis를 분리해 노출하므로 issue 자체는 측정 가능 상태로 격상.

### 함의

표본은 여전히 20 미달이므로 단정 금지. 다만:

1. Phase X3 시나리오 판단은 **actual bucket 기반**으로 해야 한다 (intent 기반 hit rate는 over-counting). v2 script가 자동으로 actual rate를 사용한다.
2. 만약 표본 누적 후에도 actual TP2 reach가 0%에 가깝다면, **Scenario A 옵션 (TP2 multiplier 5.0으로 축소)만으로는 부족**할 수 있다. 근본 원인이 swap latency 동안 price reverse라면, multiplier만 낮춰도 fill price는 여전히 monitor tick 대비 늦는다.
3. 그 경우 exit *mechanism* 개선 (별도 plan 필요)을 동반해야 한다. 본 plan의 Out of Scope 절에 명시.

## History

- 2026-04-08: 신규 생성. Codex 진단(2026-04-08)에서 출발. 측정 인프라 부족이 root issue로 확인되어 튜닝 plan이 아닌 measurement·decision lifecycle plan으로 framing.
- 2026-04-08 (later): Phase X2 measurement script v2 (`scripts/analysis/exit-distribution-audit.ts`) 작성 + 첫 audit (n=18). intent vs actual cross-tabulation 추가 결과 TP2 intent → actual TP2 match rate 0/10 = 0% 발견. exit *mechanism* 개선이 별도 plan 후보로 분기. 표본 누적 (Phase X1 ≥20) 전에는 단정 금지 원칙 유지.
