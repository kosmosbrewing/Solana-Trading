# Tech Debt Tracker

> Last updated: 2026-03-30
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

## Medium Priority

| ID | 항목 | 현재 상태 | 다음 조치 |
|---|---|---|---|
| TD-5 | `risk/` ↔ `reporting/` 순환 의존 | 구조적 위험 잔존 | 공유 타입/계산 경계 재정리 |
| TD-6 | venue-aware cost model | 가정값 비중 큼 | 실거래 cost 실측 후 보정 |
| TD-7 | realtime/watchlist churn 관측성 | 로그는 있으나 요약이 약함 | source별 retained/reject 집계 강화 |

## Resolved Recently

| ID | 항목 | 해결 시점 |
|---|---|---|
| TD-R1 | quote endpoint / executor 401 | 2026-03-25 |
| TD-R2 | BUY sizing SOL/token unit mismatch | 2026-03-25 |
| TD-R3 | Security Gate Birdeye hard dependency | 2026-03-24 |
| TD-R4 | execution viability probe 단위 정합성 | 2026-03-30 |
| TD-R5 | pre-gate / post-size execution telemetry persistence | 2026-03-30 |
