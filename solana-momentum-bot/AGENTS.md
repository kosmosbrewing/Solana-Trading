# AGENTS.md — Solana Momentum Bot

## 🚀 새 세션 진입 순서 (Codex / Cursor / Claude Code 모두 동일)

> 본 프로젝트는 **paradigm 이 여러 번 진화**했습니다 (pre-pivot → mission-pivot 2026-04-18 → mission-refinement 2026-04-21 → **Option 5 KOL Discovery 2026-04-23**).
> 새 세션이 정확한 active paradigm 을 빠르게 파악하려면 **이 순서로** 읽으세요.

### Stage 0 (1-2분)
1. **[`SESSION_START.md`](./SESSION_START.md)** — 1 페이지 hand-off (Lane 표 + Real Asset Guard + 1줄 신뢰 명령)

### Stage 1 (5분) — Paradigm authority
2. **[`MISSION_CONTROL.md`](./MISSION_CONTROL.md)** — 6 control framework (survival/universe/payoff/execution/experiment/discipline)
3. **[`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`](./docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md)** — **현 active paradigm**
4. **[`docs/design-docs/mission-refinement-2026-04-21.md`](./docs/design-docs/mission-refinement-2026-04-21.md)** — 사명 정의 (0.8 SOL floor + 200 trades + 5x+ winner)

### Stage 2 (10분) — 현재 작업
5. **[`REFACTORING_v1.0.md`](./REFACTORING_v1.0.md)** — Option 5 Phase 0-5 진행 상태
6. **[`INCIDENT.md`](./INCIDENT.md)** — 최근 운영 관측 + 결정 연표

### Stage 3 (필요 시)
7. **[`ARCHITECTURE.md`](./ARCHITECTURE.md)** — 모듈 구조
8. **[`docs/debates/`](./docs/debates/)** — 의사결정 history

### 코드 작업 시작 전
- 1줄 신뢰 명령: `npm run check:fast` (typecheck + jest + env drift)
- Real Asset Guard (ticket 0.01 / floor 0.8 / canary -0.3 / drift halt 0.2 / max concurrent 3) **변경 금지**
- `npm run check:strict` (lint + structure 포함) 빨강은 **Phase H2-H4 에서 점진 해소 deferred**, 의도

---

## 프로젝트 개요
- 한 줄 설명: Convexity-first Solana momentum/sniper bot (Option 5: KOL Discovery + 자체 Execution)
- 스택: TypeScript, `@solana/web3.js`, Jupiter, TimescaleDB, Winston, pm2
- 모드: `paper` / `live` (`TRADING_MODE`)
- 아키텍처 기준: [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- 현 active paradigm: [`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`](./docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md)
- 이전 pivot (하위 권위): [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md)

## 현재 우선 문서

### Mission / Pivot 헌장
| 문서 | 설명 |
|---|---|
| [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md) | **pivot decision record (상위 권위)** |
| [`PLAN.md`](./PLAN.md) | mission charter (convexity) |

### 운영 기준
| 문서 | 설명 |
|---|---|
| [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md) | 현재 active execution plan |
| [`OPERATIONS.md`](./OPERATIONS.md) | 현재 운영 runbook |

### 구조/정책 기준
| 문서 | 설명 |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 모듈 책임, 의존성 방향, 데이터 흐름 |
| [`PROJECT.md`](./PROJECT.md) | persona, 목표, 비목표 (post-pivot) |
| [`MEASUREMENT.md`](./MEASUREMENT.md) | wallet log growth + winner 분포 + ruin probability |
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
| [`docs/historical/pre-pivot-2026-04-18/`](./docs/historical/pre-pivot-2026-04-18/) | 2026-04-18 pivot 이전 PLAN/PROJECT/MEASUREMENT/STRATEGY snapshot |

## 에이전트 작업 규칙

1. 새 파일 생성 전 [`ARCHITECTURE.md`](./ARCHITECTURE.md)의 의존성 방향을 확인한다.
2. 외부 API 호출은 반드시 해당 client 모듈을 경유한다. 직접 `axios` 호출 금지.
3. 환경변수는 반드시 `src/utils/config.ts`에서 정의·참조한다. `process.env` 직접 접근 금지.
4. 파일당 200줄 이내를 지향한다. 300줄 초과 시 분리를 우선 검토한다.
5. 변수명·함수명·에러 메시지는 영어, 주석은 한국어를 사용한다.
6. 새 전략 추가 시 `docs/design-docs/`에 설계 문서를 먼저 작성한다.
7. `risk/` 또는 `gate/` 변경 시 관련 테스트를 반드시 갱신한다.

## 문서 정리 원칙

- 현재 동작의 기준은 `docs/design-docs/mission-pivot-2026-04-18.md`, `PLAN.md`, `docs/exec-plans/active/1sol-to-100sol.md`, `STRATEGY.md`, `OPERATIONS.md` 순서로 우선한다.
- 완료된 root plan/handoff는 `PLAN_CMPL.md`로 이관하고, 원본 파일은 필요 없으면 삭제한다.
- dated handoff는 historical note로만 유지하고, 현재 판단과 충돌하면 최신 plan 문서를 따른다.
- 중복 메모는 남기지 않는다. 새로운 운영 해석은 기존 handoff를 덧붙이기보다 기준 문서에 흡수한다.
- root stub 파일은 `README.md`나 active 문서 목록에 개별 나열하지 않는다.
- Pre-pivot 문서(2026-04-18 이전)는 `docs/historical/pre-pivot-2026-04-18/`에 보존한다 — 현재 판정 근거로 사용 금지.
