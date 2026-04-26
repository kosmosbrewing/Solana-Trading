# `src/risk/paper/` — Pre-gate Phase Outputs

> **Status**: ADR phase gate 미통과 산출물.
> **Authority**: [`docs/design-docs/lane-edge-controller-kelly-2026-04-25.md`](../../../docs/design-docs/lane-edge-controller-kelly-2026-04-25.md) §10
>
> 본 디렉토리의 모듈은 **명시적 Phase gate 통과 전** 작성된 산출물입니다.
> ADR §10 의 진입 조건이 만족되면 `src/risk/` 정식 위치로 이동.

## 현 상태 (2026-04-26)

| 모듈 | Phase | 진입 조건 | 통과 여부 |
|------|-------|-----------|----------|
| `laneEdgeStatistics.ts` | P1 | Option 5 Phase 2 shadow eval `GO` + `[KELLY_CONTROLLER_P1_START]` tag | ❌ 미통과 |
| `laneEdgeController.ts` | P1 | 동일 | ❌ 미통과 |

## 사용 정책

- ✅ **테스트 / report 용도** 만 OK (현재 그것만 사용 중)
- ✅ `npm run lane:edge-report` (CLI report-only) — entry path 영향 0
- ❌ **production runtime path 에서 import 금지** — orchestration / handler 가 이 모듈을 직접 참조하지 말 것
- ❌ **별도 `[KELLY_CONTROLLER_P1_START]` commit tag + Phase 2 GO 기록 없이 정식 위치로 이동 금지**

## 정식 진입 절차

1. Option 5 Phase 2 shadow eval `GO` 판정 (ADR §6 Gate 1)
2. INCIDENT.md 에 결정 기록
3. `git mv src/risk/paper/* src/risk/` + `[KELLY_CONTROLLER_P1_START]` commit tag
4. 본 README 갱신 ("정식 진입 완료")

---

*2026-04-26: P1 코드 작성 후 Phase gate 미명시 — directory 격리로 status 표시.*
