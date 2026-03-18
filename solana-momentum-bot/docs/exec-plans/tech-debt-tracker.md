# Tech Debt Tracker

> 통합 출처: issues-archive.md + 하네스 리팩토링 갭 분석
> Last updated: 2026-03-18

## Mission Readiness: 9.5/10

코어 런타임, 전략 배선, 리스크 관리, 백테스트/리포팅 완료.
감사 결과: CRITICAL 24건, HIGH 33건, MEDIUM 20건+ 전부 해결.
최근 완료: SOL_MINT 상수 중앙화, Exit Gate 구현, RegimeFilter 데이터소스 수정.
남은 외부 연동: X Filtered Stream 1건.

---

## 🔴 Critical

| ID | 항목 | 현재 상태 | 해결 방안 |
|---|---|---|---|
| TD-1 | `backtest/engine.ts` 1082줄 | 300줄 제한 3.6배 초과 | 전략 라우팅/집계/루프 3파일 분리 |
| TD-2 | 300줄 초과 파일 13개 | CI 검증 미적용 | P1b에서 Tier별 분리 |
| TD-3 | risk/ ↔ reporting/ 순환 의존성 | 런타임 문제 없으나 구조적 위험 | 공유 타입 utils/ 추출 |

## 🟡 Medium

| ID | 항목 | 현재 상태 | 해결 방안 |
|---|---|---|---|
| TD-4 | process.env 직접 접근 3건 | config.ts 우회 | P1a-2에서 중앙화 |
| TD-5 | console.log 46건 (reporter.ts) | no-console: off | eslint-disable 예외 + warn 활성화 |
| TD-6 | 6개 모듈 테스트 부재 | orchestration 등 핵심 흐름 미테스트 | P1b-2에서 우선 추가 |
| TD-7 | X Filtered Stream 미검증 | 코드 완료, 외부 인증 대기 | Bearer token + rule 등록 필요 |

## 🟢 Low

| ID | 항목 | 현재 상태 | 해결 방안 |
|---|---|---|---|
| TD-8 | Health endpoint HTTP 미노출 | HealthMonitor 내부용 | P2에서 HTTP endpoint 추가 |
| TD-9 | DB 스키마 문서 미자동화 | 수동 관리 | P2-1에서 자동 생성 |
| TD-10 | Birdeye WS → Helius WS 전환 | 아이디어 단계 | 비용/안정성 이슈 발생 시 검토 |

## ✅ Recently Resolved

| ID | 항목 | 해결 일시 | 내용 |
|---|---|---|---|
| TD-R1 | SOL_MINT 상수 4파일 중복 | 2026-03-18 | `utils/constants.ts` 추출, 4파일 import 전환 |
| TD-R2 | RegimeFilter 데이터소스 버그 | 2026-03-18 | SOL_USDC_PAIR(mint)→getTokenOHLCV(mint) 수정 |
| TD-R3 | Exit Gate 미구현 | 2026-03-18 | SpreadMeasurer.measureSellImpact + gate/index.ts Exit Gate 추가 |
| TD-R4 | getTokenOHLCV 에러 핸들링 불일치 | 2026-03-18 | return [] → throw error (getOHLCV와 일관) |
| TD-R5 | gate/index.ts import 순서 버그 | 2026-03-18 | const log 위치 수정 |
