# Execution Plan: Live Ops Integrity (Phase E follow-ups)

> Status: active (post-implementation, pending deploy/verify)
> Updated: 2026-04-07
> Origin: Plan `snuggly-toasting-donut.md` (P0~P3 + 품질 개선) 구현 완료 후 남은 작업 트래킹
> Scope: 2026-04-07 fake-fill 감지/마킹 PR 배포~검증~장기 정리까지의 실행 바인딩
> Use with: `CRITICAL_LIVE.md` Section 7E/7F, `docs/exec-plans/tech-debt-tracker.md`

## Role

이 문서는 Live Ops Integrity PR(P0~P3)의 **구현 이후** 작업만 추적한다.

- 구현/테스트/리팩토링은 끝. 코드 측면 "당장 할 일"은 없음.
- 남은 작업은 **배포 / 실데이터 검증 / 1주일 모니터링 / 별도 PR로 분리할 부채** 4축.
- Git commit 작업은 이 문서 scope에 포함하지 않는다 (작업 주체가 별도 관리).

완료 기준: 모든 Phase(D → V → M) acceptance 통과 시 `completed/` 로 이동.

---

## Phase D — Deploy & DB Migration

### 목표
`exit_anomaly_reason` 컬럼 + 11번째 positional 인자 변경이 프로덕션 VPS에서 사고 없이 반영되도록 한다.

### 작업
- [ ] VPS pm2 재배포 절차가 `tradeStore.initialize()` 에서 `ALTER TABLE IF NOT EXISTS exit_anomaly_reason TEXT` 를 자동 실행하는지 `OPERATIONS.md` 절차로 사전 확인
- [ ] 자동 실행 안 되면 수동 SQL 1회 선제 실행 후 배포
- [ ] 배포 직후 `SELECT exit_anomaly_reason FROM trades LIMIT 1;` 로 컬럼 존재 검증
- [ ] pm2 로그에 `[FAKE_FILL]` prefix가 신규로 출력될 경우 대비해 로그 rotation 사이즈 여유 확인

### Target Files
- `src/candle/tradeStore.ts` (migration 실행 사이트)
- `OPERATIONS.md` (배포 절차)
- 운영 VPS PostgreSQL (prod)

### Owner
`igyubin` (CEO)

### Acceptance Criteria
- [ ] pm2 재기동 후 `trades` 테이블에 `exit_anomaly_reason TEXT` 컬럼 존재
- [ ] 재기동 후 첫 closeTrade 호출이 에러 없이 성공 (pm2 logs 확인)

### Lifecycle
- 시작: 배포 당일
- 종결 조건: 위 2개 acceptance 통과

---

## Phase V — End-to-End Verification on Real Data

### 목표
04-07 세션의 실 데이터로 fake-fill 마킹·warning·ratio floor가 실제로 표시되는지 육안 확인.

### 작업
- [ ] 04-07T03-53 세션 + 4 trades 데이터셋으로 trade-report 재생성
  ```bash
  FETCH_TRADE_REPORT=true npm run ops:refresh:vps-analysis
  ```
- [ ] row #1 (07:52, `exit_slip=10000bps`) 의 per-row 서브라인에 `anomaly=fake_fill_no_received(closeTrade),slippage_saturated=10000bps` 가 표시되는지 확인
- [ ] 리포트 말미에 `FAKE-FILL WARNING: N/4 rows contain saturated slippage or anomaly markers` 섹션 존재 확인
- [ ] W/L 라인이 `(row)` / `(entry)` 두 줄로 출력되고, TP1 partial 있는 entry에서 값이 다름을 확인
- [ ] `realized-replay-ratio` 재실행 후 헤드라인이 `N/A — predicted edge ≈ 0, ratio not meaningful` 으로 바뀌었는지 확인
- [ ] `mean of per-trade ratios` 라인이 `(n=N finite, M excluded by |denom|<0.05% floor)` 포맷으로 출력되는지 확인
- [ ] Finite ratio가 0건인 경우 verdict 섹션이 `표본 부족 (predicted edge ≈ 0)` 으로 강제 표시되는지 확인

### Target Files
- `scripts/trade-report.ts` (출력 검증)
- `scripts/analysis/realized-replay-ratio.ts` (헤드라인 검증)
- `docs/ops-history/2026-04-07.md` (검증 결과 기록)

### Owner
`igyubin` (CEO)

### Acceptance Criteria
- [ ] 모든 checkbox 통과 + 스크린샷/로그를 `docs/ops-history/2026-04-07.md` 하단 "Phase E verification" 섹션에 첨부

### Lifecycle
- 시작: Phase D 종결 직후
- 종결 조건: 위 acceptance 통과

---

## Phase M — 1 Week Monitoring

### 목표
Fake-fill 임계값(9000bps)의 false positive 여부와 edge 표본 감소 정도를 관찰해 튜닝 판단 근거 확보.

### 작업
- [ ] 일별 `exit_anomaly_reason IS NOT NULL` 카운트 쿼리를 `ops:check` 산출물에 포함
- [ ] sanitizer `fake_fill_slippage` drop 카운트를 기존 drop breakdown 옆에 노출 (log 레벨 info)
- [ ] 1주일 후:
  - false positive 0건 → 임계 9000bps 유지
  - false positive 있음 → `src/utils/constants.ts` 의 `FAKE_FILL_SLIPPAGE_BPS_THRESHOLD` 를 9500 또는 9900 으로 상향 후 1주일 재관찰
- [ ] 동일 기간 동안 `matched ≥ 20 & |predicted_adj| ≥ 0.05% 비율 ≥ 50%` 달성 여부 체크 (realized-replay-ratio verdict 확정 조건)

### Target Files
- `docs/ops-history/YYYY-MM-DD.md` (일별 기록)
- `src/utils/constants.ts` (임계 조정 시)

### Owner
`igyubin` (CEO)

### Acceptance Criteria
- [ ] 7일 연속 fake-fill 마킹/drop 카운트가 ops-history에 기록됨
- [ ] 임계값 결정(유지 or 상향)과 근거가 문서화됨
- [ ] realized-replay-ratio 가 finite ratio 10건 이상 확보했는지 여부가 명시됨

### Lifecycle
- 시작: Phase V 종결 직후
- 종결 조건: 위 acceptance 통과

---

## Phase S — Split-Out PRs (범위 외 부채)

> **이 PR에 포함하지 않고 별도 PR로 분리할 항목**. 각각 tech-debt-tracker 에 ID로 등록.

### S-1. TD-8 closeTrade positional → options object
- 이번 PR로 positional 인자가 10개 → 11개로 증가 (부채 +1)
- 다음 PR에서 `{id, exitPrice, pnl, slippage, exitReason?, quantity?, exitSlippageBps?, degradedTriggerReason?, degradedQuoteFailCount?, decisionPrice?, exitAnomalyReason?}` 객체 인자로 일괄 전환
- 우선순위: High (가독성 리스크)

### S-2. `round_trip_cost_pct` exit-time 갱신
- 현재 상태: 라벨만 `(entry-time gate snapshot)` 으로 정정, 값 자체는 entry-time 그대로
- 개선안: closeTrade 시점에 `realized_round_trip_cost_pct` 별도 컬럼에 실제 실현 비용을 기록
- 필요 작업: schema migration + closeTrade signature 확장 + trade-report 집계 업데이트
- 우선순위: Medium

### S-3. Paper mode slippage simulation
- 현재 상태: paper 모드는 `decision == fill` 가정 → fake-fill path 미시뮬
- 개선안: paper 실행 시 가짜 slippage 분포를 주입해 canary 신뢰도 제고
- 우선순위: Medium (canary 신뢰도)

### S-4. Sanitizer drop Telegram 노출
- 현재 상태: EdgeTracker drop 81%+ 인데 운영자 실시간 가시성 없음
- 개선안: 일간 drop summary 를 Telegram `OpsDigest` 채널에 1회 push
- 우선순위: Low (monitoring-only)

### S-5. `bpsToDecimal` / `decimalToBps` util
- 현재 상태: `/ 10000`, `* 10000` 매직넘버가 코드베이스 곳곳에 반복
- 개선안: `src/utils/units.ts` (신규) 로 변환 util 추출
- 우선순위: Low (cosmetic)

---

## Current Status Summary

| Phase | Status | Owner | Target Completion |
|---|---|---|---|
| Implementation (P0~P3) | ✅ completed | claude_local | 2026-04-07 |
| Code refactor quality | ✅ completed | claude_local | 2026-04-07 |
| Phase D — Deploy | 🔴 pending | igyubin | 배포일 |
| Phase V — Verify | 🔴 pending | igyubin | 배포 당일 |
| Phase M — Monitor 7d | 🔴 pending | igyubin | 배포 + 7일 |
| Phase S-1 TD-8 | 🟡 queued | — | 다음 PR |
| Phase S-2 round_trip_cost | 🟡 queued | — | Medium |
| Phase S-3 paper slip sim | 🟡 queued | — | Medium |
| Phase S-4 sanitizer telegram | 🟡 queued | — | Low |
| Phase S-5 bps util | 🟡 queued | — | Low |

---

## Test Baseline (Implementation 완료 시점)

- `npx tsc --noEmit`: 0 errors
- `npx jest`: 87 suites / 466 tests pass
- 신규 테스트:
  - `test/tradeExecution.test.ts`: fake-fill 라이브 마킹 2건
  - `test/edgeInputSanitizer.test.ts`: `fake_fill_slippage` 필터 5건
- 수정된 기존 테스트: `test/tradeExecution.test.ts` L385 (closeTrade 11번째 인자 `undefined` 추가)

이 baseline 은 Phase D 배포 전까지 drift 없이 유지되어야 한다. 다른 작업으로 tsc/jest 가 red 로 바뀌면 먼저 복구하고 배포 진행.
