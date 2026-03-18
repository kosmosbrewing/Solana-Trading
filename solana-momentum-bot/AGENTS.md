# AGENTS.md — Solana Momentum Bot

## 프로젝트 개요
- **한 줄 설명:** Event-aware Solana DEX trading bot (1 SOL → 100 SOL)
- **스택:** TypeScript, @solana/web3.js, Jupiter v6, TimescaleDB, Winston, pm2
- **모드:** Paper / Live (TRADING_MODE)
- **아키텍처:** `ARCHITECTURE.md` 참조

## 저장소 Knowledge Base 맵

### 아키텍처
| 문서 | 경로 | 설명 |
|---|---|---|
| 도메인·레이어 맵 | `ARCHITECTURE.md` | 모듈 책임, 의존성 방향, 데이터 흐름 |
| 설계 문서 카탈로그 | `docs/design-docs/index.md` | 전체 설계 문서 목록 + 검증 상태 |
| 핵심 운영 원칙 | `docs/design-docs/core-beliefs.md` | 봇 원칙 + 에이전트 피드백 루프 |
| 레이어 규칙 | `docs/design-docs/layer-rules.md` | 모듈 의존성 방향 강제 규칙 |
| 2-Stage Entry | `docs/design-docs/2-stage-entry.md` | Context → Trigger 모델 |
| Risk Tier | `docs/design-docs/risk-tier-system.md` | Bootstrap→Calibration→Confirmed→Proven |

### 실행 계획
| 문서 | 경로 | 설명 |
|---|---|---|
| 진행 중 계획 | `docs/exec-plans/active/` | 현재 작업 중인 실행 계획 |
| 완료 계획 | `docs/exec-plans/completed/` | 완료된 계획 이력 |
| 기술 부채 | `docs/exec-plans/tech-debt-tracker.md` | 알려진 부채 + 우선순위 |

### 제품 명세
| 문서 | 경로 | 설명 |
|---|---|---|
| 전략 카탈로그 | `docs/product-specs/strategy-catalog.md` | A/C/D/E 전략 상세 |
| Paper 검증 | `docs/product-specs/paper-validation.md` | 50-trade 검증 기준 |

### 컨벤션 & 규칙
| 문서 | 경로 | 설명 |
|---|---|---|
| 코딩 컨벤션 | `docs/CONVENTIONS.md` | 네이밍, 파일 구조, PR 규칙 |
| 보안 | `docs/SECURITY.md` | 지갑 키, API 키, RPC 보안 |
| 안정성 | `docs/RELIABILITY.md` | 헬스체크, 로깅, 크래시 복구 |

### ADR & 참조
| 문서 | 경로 | 설명 |
|---|---|---|
| ADR 목록 | `docs/decisions/` | 주요 아키텍처 결정 이력 (5건: TimescaleDB, Jupiter, Event-First, Risk Tier, Ultra) |

### 운영
| 문서 | 경로 | 설명 |
|---|---|---|
| 프로젝트 목표 | `PROJECT.md` | 목표, 페르소나, 전략 모델, 인프라 |
| 운영 가이드 | `OPERATIONS.md` | VPS 배포, pm2, 모니터링 |
| 개발 셋업 | `SETUP.md` | 로컬 개발 환경 설정 |

## 에이전트 작업 규칙 (반드시 준수)

1. **새 파일 생성 전** `ARCHITECTURE.md`의 의존성 방향을 확인하라.
2. **외부 API 호출**은 반드시 해당 Client 모듈을 경유하라 (직접 axios 금지).
3. **환경변수**는 반드시 `src/utils/config.ts`에서 정의·참조하라 (`process.env` 직접 접근 금지).
4. **파일당 200줄 이내**를 지향하라. 300줄 초과 시 CI 실패.
5. **변수명·함수명·에러 메시지는 영어**, 주석은 한국어.
6. **새 전략 추가 시** `docs/design-docs/`에 설계 문서를 먼저 작성하라.
7. **risk/ 또는 gate/ 로직 변경 시** 관련 테스트를 반드시 업데이트하라.
