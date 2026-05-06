# MEMORY.md

> Decision index for this repo. Intentionally short.
> Agent-side detailed memory lives in `~/.claude/projects/.../memory/` (MEMORY.md + per-project notes).

## Current Mission Decision

- 2026-04-21: `1 SOL -> 100 SOL` 은 **deterministic KPI 가 아니라 convex tail outcome**.
- **Current success definition**: current operating `0.7 SOL floor + 200 live trades + 5x+ winner distribution`.
- **Operating model**: survival-first positive-optionality engine.

## Trade-Count 구간 의미 (2026-04-21)

- `50 trades` = **safety checkpoint** (관측 전용, 승격 결정 없음)
- `100 trades` = **preliminary** edge / bleed / quickReject 검토 (Stage 2)
- `200 trades` = **scale / retire decision gate** (Stage 4, 최종 판단)

## Real Asset Guard 정책값 (불변)

- wallet floor: `0.7 SOL`
- canary cumulative loss cap: lane-specific budget caps from current operating profile
- max concurrent: `3`
- fixed ticket: default `0.01 SOL`, KOL `0.02 SOL`

Startup `[REAL_ASSET_GUARD]` 로그에서 effective 값 확인 가능.

## Authority

- `SESSION_START.md` / `MISSION_CONTROL.md` — current operating override
- `docs/design-docs/mission-refinement-2026-04-21.md` — historical mission refinement; original 0.8 floor is superseded by current 0.7 operating floor
- `docs/design-docs/mission-pivot-2026-04-18.md` — pivot 결정 근거
- `PLAN.md`
- `PROJECT.md`
- `MEASUREMENT.md`
- `docs/exec-plans/active/1sol-to-100sol.md`

## 금지 사항

- 50 trades 를 live 승격 기준으로 사용 금지
- 100 SOL 을 성공 KPI 로 표현 금지 (tail outcome 관찰 변수)
- Real Asset Guard 와 Observability Guard 를 섞지 말 것
- DB pnl 단독 판정 금지 (wallet delta 만 ground truth)
