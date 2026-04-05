# Design Docs 카탈로그

| 문서 | 경로 | 상태 | 최종 검증 |
|---|---|---|---|
| 핵심 운영 원칙 | `core-beliefs.md` | ✅ 확정 | 2026-03-18 |
| 레이어 규칙 | `layer-rules.md` | ✅ 확정 | 2026-03-18 |
| 2-Stage Entry 모델 | `2-stage-entry.md` | ✅ 확정 | 2026-03-18 |
| Risk Tier 시스템 | `risk-tier-system.md` | ✅ 확정 | 2026-03-18 |
| Helius Data Plane Transition | `helius-data-plane-transition.md` | 🟡 제안 | 2026-03-31 |
| Buy/Entry 전체 흐름 상세 | `buy-entry-flow.md` | ✅ 확정 | 2026-04-05 |
| Session Replay Parameter Sweep | `session-replay-parameter-sweep.md` | ✅ 확정 | 2026-04-05 |

## Gate 체인 개요

```
Gate 0: Security Gate (async) — honeypot, freeze, transferFee, holder 집중도
Gate 1: AttentionScore — 트렌딩 화이트리스트
Gate 2A: Execution Viability — R:R + round-trip cost
Gate 2B: Quote Gate (async) — Jupiter entry price impact
Gate 3: Strategy Score — 전략별 점수 (A/B/C 등급)
Gate 4: Safety Gate — pool 유동성, token age, LP burn
Exit Gate: Sell-side Impact (async) — 포지션 크기 기반 exit 유동성 검증
```

- Exit Gate는 `evaluateGatesAsync()` 에서만 적용 (sync 경로/백테스트 제외)
- sell impact 측정은 시그널 발생 시에만 position-sized probe로 수행
