# Coding Conventions

## 네이밍

- **변수명, 함수명, 에러 메시지:** 영어
- **주석, 문서:** 한국어
- **파일명:** camelCase (`volumeSpikeBreakout.ts`)
- **클래스/타입:** PascalCase (`RiskManager`, `BotContext`)
- **상수:** UPPER_SNAKE_CASE (`MAX_DAILY_LOSS`)

## 모듈별 파일 네이밍 패턴

| 모듈 | 패턴 | 예시 |
|---|---|---|
| strategy/ | `{strategyName}.ts` | `volumeSpikeBreakout.ts` |
| gate/ | `{gateName}Gate.ts` 또는 `{concern}.ts` | `safetyGate.ts`, `spreadMeasurer.ts` |
| risk/ | `{concern}.ts` | `drawdownGuard.ts`, `riskTier.ts` |
| ingester/ | `{source}Client.ts` | `birdeyeClient.ts` |
| test/ | `{module}.test.ts` | `riskManager.test.ts` |

## 파일 크기

- 200줄 이내 지향
- 300줄 초과 시 CI 실패
- 초과 시 역할 분리하여 별도 파일로 추출

## 환경변수

- 모든 환경변수는 `src/utils/config.ts`에서 정의·참조
- `process.env` 직접 접근 금지 (config.ts, logger.ts 제외)
- 새 환경변수 추가 시 `.env.example`도 동시 업데이트

## 로깅

- `console.log` 직접 사용 금지 (ESLint `no-console: warn`)
- `src/utils/logger.ts`의 `createModuleLogger(moduleName)` 사용
- 예외: `backtest/reporter.ts` (CLI 출력, eslint-disable)

## PR & 머지 규칙

- PR은 단일 기능 또는 단일 수정 단위로 작게 유지한다.
- CI 통과 = 머지 가능. 테스트 flake는 재실행으로 처리.
- **수정은 싸고, 대기는 비싸다.**
- 크리티컬 패스(`risk/`, `gate/`, `executor/`)만 수동 리뷰를 강제한다.
- 파일 분리 PR은 동작 변경 없이 구조만 변경하므로 CI 통과 시 즉시 머지.

## 외부 API 호출

- 직접 `axios.get()` 금지
- 반드시 해당 Client 모듈 경유 (`BirdeyeClient`, `DexScreenerClient` 등)
- 새 외부 API 연동 시 `ingester/` 또는 해당 모듈에 Client 클래스 추가
