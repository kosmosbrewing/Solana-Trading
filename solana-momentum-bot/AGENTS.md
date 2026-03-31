# AGENTS.md — Solana Momentum Bot

## 프로젝트 개요
- 한 줄 설명: Event-aware Solana DEX trading bot (`1 SOL -> 100 SOL`)
- 스택: TypeScript, `@solana/web3.js`, Jupiter, TimescaleDB, Winston, pm2
- 모드: `paper` / `live` (`TRADING_MODE`)
- 아키텍처 기준: [`ARCHITECTURE.md`](./ARCHITECTURE.md)

## 현재 우선 문서

### 운영 기준
| 문서 | 설명 |
|---|---|
| [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md) | 현재 active execution plan |
| [`OPERATIONS.md`](./OPERATIONS.md) | 현재 운영 runbook |

### 구조/정책 기준
| 문서 | 설명 |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 모듈 책임, 의존성 방향, 데이터 흐름 |
| [`PROJECT.md`](./PROJECT.md) | 목표, 비목표, 현재 phase 정의 |
| [`MEASUREMENT.md`](./MEASUREMENT.md) | Mission / Execution / Edge 기준 |
| [`docs/product-specs/strategy-catalog.md`](./docs/product-specs/strategy-catalog.md) | 전략/Gate/Risk 제품 명세 |
| [`OPERATIONS.md`](./OPERATIONS.md) | VPS/pm2 운영 가이드와 live 점검 체크포인트 |

### 참조 문서
| 문서 | 설명 |
|---|---|
| [`README.md`](./README.md) | 저장소 개요와 문서 가이드 |
| [`PLAN.md`](./PLAN.md) | mission charter와 plan hierarchy |
| [`STRATEGY.md`](./STRATEGY.md) | 현재 전략/Gate/Risk quick reference |
| [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md) | 전략 구조적 한계와 다음 전략 가설 memo |
| [`REALTIME.md`](./REALTIME.md) | realtime shadow / replay 워크플로 |
| [`BACKTEST.md`](./BACKTEST.md) | batch backtest 워크플로 |
| [`docs/exec-plans/tech-debt-tracker.md`](./docs/exec-plans/tech-debt-tracker.md) | 현재 기술 부채 목록 |

### historical notes
| 문서 | 설명 |
|---|---|
| [`PLAN_CMPL.md`](./PLAN_CMPL.md) | 완료된 plan / canary history archive |

## 에이전트 작업 규칙

1. 새 파일 생성 전 [`ARCHITECTURE.md`](./ARCHITECTURE.md)의 의존성 방향을 확인한다.
2. 외부 API 호출은 반드시 해당 client 모듈을 경유한다. 직접 `axios` 호출 금지.
3. 환경변수는 반드시 `src/utils/config.ts`에서 정의·참조한다. `process.env` 직접 접근 금지.
4. 파일당 200줄 이내를 지향한다. 300줄 초과 시 분리를 우선 검토한다.
5. 변수명·함수명·에러 메시지는 영어, 주석은 한국어를 사용한다.
6. 새 전략 추가 시 `docs/design-docs/`에 설계 문서를 먼저 작성한다.
7. `risk/` 또는 `gate/` 변경 시 관련 테스트를 반드시 갱신한다.

## 문서 정리 원칙

- 현재 동작의 기준은 `PLAN.md`, `docs/exec-plans/active/1sol-to-100sol.md`, `STRATEGY.md`, `OPERATIONS.md`를 우선한다.
- 완료된 root plan/handoff는 `PLAN_CMPL.md`로 이관하고, 원본 파일은 필요 없으면 삭제한다.
- dated handoff는 historical note로만 유지하고, 현재 판단과 충돌하면 최신 plan 문서를 따른다.
- 중복 메모는 남기지 않는다. 새로운 운영 해석은 기존 handoff를 덧붙이기보다 기준 문서에 흡수한다.
- root stub 파일은 `README.md`나 active 문서 목록에 개별 나열하지 않는다.
