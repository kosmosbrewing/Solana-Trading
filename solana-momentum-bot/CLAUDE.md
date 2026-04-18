# Solana Momentum Bot — Agent Instructions

작업 시작 전 [`AGENTS.md`](./AGENTS.md)를 읽고, 현재 태스크에 필요한 문서만 Progressive Disclosure로 참조하라.

## Quick Reference
- **2026-04-18 Mission Pivot**: [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md) — explainability → convexity. Cupsey는 benchmark로 유지(개조 금지), `pure_ws_breakout` 새 primary 후보.
- 아키텍처/의존성 방향: [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- 에이전트 규칙 + 문서 맵: [`AGENTS.md`](./AGENTS.md)
- mission / plan hierarchy: [`PLAN.md`](./PLAN.md)
- 현재 active execution plan: [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md)
- **현재 운영 모드 (2026-04-18)**: Cupsey benchmark + new-lane design — bootstrap signal-only (`executionRrReject=99.0`), cupsey_flip_10s 유지, `pure_ws_breakout` 설계 예정
- **현재 binding constraint (2026-04-18)**: Wallet ownership + always-on comparator (Block 1 P0)
- **Ground truth**: wallet delta 만 유일한 판정 기준. DB pnl 단독 판정 금지 (drift `+18.34 SOL` 전력).
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
