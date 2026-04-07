# Tech Debt Tracker

> Last updated: 2026-04-08
> Scope: 현재 운영과 직접 맞닿은 기술 부채만 남긴다.

## Current Mission Readiness

- 인프라 블로커: 해소
- 운영 해석 부채: 남아 있음
- 핵심 문제: 기능 부재보다 live canary 해석 품질

## High Priority

| ID | 항목 | 현재 상태 | 다음 조치 |
|---|---|---|---|
| TD-1 | `effectiveRR` 해석 표본 부족 | telemetry patch는 완료, BUY 표본 없음 | 첫 BUY 시그널에서 pre/post-size 비교 확인 |
| TD-2 | blacklist pair 재유입 통제 부족 | 동일 loser pair 재점유 가능성 남음 | scanner cooldown 보강 필요 여부 판단 |
| TD-3 | Gecko `429` data-plane noise | 지속 발생 | cadence 해석과 분리 추적 |
| TD-4 | oversized file debt | 일부 핵심 문서/모듈 여전히 큼 | 기능 작업과 분리해 점진 정리 |
| TD-14 | TP1 partial 30% / TP2 10×ATR / SL 1.5×ATR 의 live 적합성 미검증 | Codex 진단(2026-04-08): 구조 철학은 OK이나 live 4 trades 표본에서 win 0건 — runner-centric 가설이 작동 중인지 측정 인프라가 부재. 표본 부족(n=4)으로 결론 불가 | **재진입 조건**: post-Phase E clean closed trades ≥ 20건 누적 후 `exit-distribution-audit` 실행 → exit reason 분포 확정 → `exit-structure-validation-2026-04-08.md` Phase X3 가설 옵션 분기. 표본 누적 전 직접 튜닝 금지 (`tradingParams.ts:56-64` orderShape lock) |

## Medium Priority

| ID | 항목 | 현재 상태 | 다음 조치 |
|---|---|---|---|
| TD-5 | `risk/` ↔ `reporting/` 순환 의존 | 구조적 위험 잔존 | 공유 타입/계산 경계 재정리 |
| TD-6 | venue-aware cost model | 가정값 비중 큼 | 실거래 cost 실측 후 보정 |
| TD-7 | realtime/watchlist churn 관측성 | 로그는 있으나 요약이 약함 | source별 retained/reject 집계 강화 |
| TD-9 | `round_trip_cost_pct` 값이 entry-time snapshot (라벨만 정정됨) | 2026-04-07 PR 로 라벨만 `(entry-time gate snapshot)` 표기 | `realized_round_trip_cost_pct` 컬럼 신설 + closeTrade 시 실측값 기록 — `live-ops-integrity-2026-04-07.md` Phase S-2 |
| TD-10 | paper mode `decision == fill` 가정 → fake-fill path 미시뮬 | canary 신뢰도 저하 | paper 실행 시 가짜 slippage 분포 주입 — Phase S-3 |

## Low Priority

| ID | 항목 | 현재 상태 | 다음 조치 |
|---|---|---|---|
| TD-11 | Sanitizer drop 81%+ 상태가 운영자 실시간 가시성 없음 | log 로만 확인 가능 | 일간 drop summary 를 Telegram `OpsDigest` 채널에 push — Phase S-4 |
| TD-13 | `runtime_signal_rows` (realtime-signals.jsonl row 수) vs `trigger_signals` (`trigger_stats:*` 이벤트 수) drift 자동 감지 부재 | Entry 02에서 `8 vs 9` 1건 gap 관측. 두 카운터 정의가 다르고 정상 분포 표본이 없어 임계값 정의 불가. 매뉴얼 분리 기록 룰만 `docs/runbooks/live-ops-loop.md:266`에 존재. 두 카운터 자체는 `ops:check:helius` (`trigger_stats:*`) + `ops:check:sparse` (jsonl row 수)로 이미 노출됨 | **재진입 조건**: ops-history entry가 5건 이상 누적되어 `(trigger_signals - runtime_signal_rows)` 분포의 mean/p95를 정의할 수 있게 된 시점. 그 전에는 임계값 추측 = over-engineering이므로 코드 변경 금지. 재진입 시 `scripts/ops-helius-check.ts:printVerdict` 다음에 두 값과 diff를 한 줄로 출력하는 enhancement만 우선 검토 |

## Resolved Recently

| ID | 항목 | 해결 시점 |
|---|---|---|
| TD-R1 | quote endpoint / executor 401 | 2026-03-25 |
| TD-R2 | BUY sizing SOL/token unit mismatch | 2026-03-25 |
| TD-R3 | Security Gate Birdeye hard dependency | 2026-03-24 |
| TD-R4 | execution viability probe 단위 정합성 | 2026-03-30 |
| TD-R5 | pre-gate / post-size execution telemetry persistence | 2026-03-30 |
| TD-R6 | decision_price + cost decomposition DB/report/Telegram 계측 | 2026-04-06 |
| TD-R7 | fake-fill fallback 4경로 중복 + `currentPrice` 가장 (Phase E P0~P3) | 2026-04-07 |
| TD-R8 | `tradeStore.closeTrade()` positional 11개 → `CloseTradeOptions` 객체 (Phase S-1) | 2026-04-07 |
| TD-R9 | bps ↔ decimal 변환 매직넘버 → `src/utils/units.ts` (Phase S-5) | 2026-04-07 |
