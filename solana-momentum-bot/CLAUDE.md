# Solana Momentum Bot — Agent Instructions

작업 시작 전 [`AGENTS.md`](./AGENTS.md)를 읽고, 현재 태스크에 필요한 문서만 Progressive Disclosure로 참조하라.

## Quick Reference
- **2026-04-21 Mission Refinement (최상위 authority)**: [`docs/design-docs/mission-refinement-2026-04-21.md`](./docs/design-docs/mission-refinement-2026-04-21.md) — 100 SOL 은 tail outcome, 판단 KPI 아님. 성공 기준 = 0.8 SOL floor + 200 trades + 5x+ winner 실측. Stage 1-4 maturity gate. Real Asset Guard vs Observability Guard 구분.
- **2026-04-18 Mission Pivot** (하위): [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md) — explainability → convexity. Cupsey는 benchmark로 유지(개조 금지), `pure_ws_breakout` 새 primary 후보.
- 아키텍처/의존성 방향: [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- 에이전트 규칙 + 문서 맵: [`AGENTS.md`](./AGENTS.md)
- mission / plan hierarchy: [`PLAN.md`](./PLAN.md)
- 현재 active execution plan: [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md)
- **현재 운영 모드 (2026-04-21 refined)**: Stage 1 (Safety Pass). 판단 KPI 는 일/주 수익률 아님 — 4개 질문 (drift / survival pass rate / trade count / bleed per probe).
- **현재 binding constraint (2026-04-21)**: **Survival Layer P0** — rug/honeypot/Token-2022/top-holder filter. pure_ws 가 security gate 우회 중, 다음 구현 순위 1번.
- **Ground truth**: wallet delta 만 유일한 판정 기준. DB pnl 단독 판정 금지 (drift `+18.34 SOL` 전력).
- **Success redefined (2026-04-21)**: 0.8 SOL floor 유지 + 200 live trades + 5x+ winner 분포 실측 = 기술적 성공. 100 SOL 달성 여부 무관.
- **Trade-count 구간 의미 (2026-04-21)**: `50 trades` = safety checkpoint (관측 전용, 승격 결정 없음) / `100 trades` = preliminary edge/bleed/quickReject 검토 (Stage 2) / `200 trades` = scale/retire decision gate (Stage 4). 50 을 승격 기준으로 쓰지 말 것.
- **Real Asset Guard 정책값 (불변)**: `wallet floor=0.8 SOL` / `canary cumulative loss cap=-0.3 SOL` / `pure_ws max concurrent=3` / `fixed ticket=0.01 SOL`. Startup 에 `[REAL_ASSET_GUARD]` 로그로 effective 값 확인 가능.
- archive: [`PLAN_CMPL.md`](./PLAN_CMPL.md), [`docs/historical/pre-pivot-2026-04-18/`](./docs/historical/pre-pivot-2026-04-18/)
- 현재 전략 quick reference: [`STRATEGY.md`](./STRATEGY.md)
- 전략 방향/다음 가설: [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md)
- 기술 부채: [`docs/exec-plans/tech-debt-tracker.md`](./docs/exec-plans/tech-debt-tracker.md)
- 코딩 컨벤션: [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md)
- 보안 규칙: [`docs/SECURITY.md`](./docs/SECURITY.md)

## Document Roles
- 현재 동작의 기준 문서:
  - `AGENTS.md`
  - `ARCHITECTURE.md`
  - `PROJECT.md`
  - `PLAN.md`
  - `docs/exec-plans/active/1sol-to-100sol.md`
  - `OPERATIONS.md`
  - `STRATEGY.md`
  - `docs/product-specs/strategy-catalog.md`
  - `MEASUREMENT.md`
- forward memo:
  - `STRATEGY_NOTES.md`
- 워크플로 가이드:
  - `BACKTEST.md`
  - `REALTIME.md`
- historical note:
  - `PLAN_CMPL.md`
  - `docs/exec-plans/completed/*.md`
