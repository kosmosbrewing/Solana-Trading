# Layer Rules — 모듈 의존성 방향 규칙

> 상세 다이어그램은 `../../ARCHITECTURE.md` §3 참조

## 의존성 방향 (단방향만 허용)

```
utils/ (config, logger, types)     ← 모든 모듈이 참조 가능
candle/, state/                    ← 데이터 레이어
ingester/                          ← 외부 API 클라이언트 (완전 독립)
event/ → ingester/                 ← 수집 레이어
scanner/ → ingester/               ← 탐색 레이어
strategy/ → utils/, ingester/      ← 시그널 생성
gate/ → event/, ingester/, strategy/ ← 필터링
risk/ → gate/, reporting/          ← 리스크 관리
executor/ → utils/                 ← 실행 (완전 독립)
orchestration/ → 모든 모듈          ← 최상위 조율
```

## 금지 규칙

| 금지 import | 이유 |
|---|---|
| `executor/` → `strategy/` | 실행이 시그널 생성에 의존 금지 |
| `strategy/` → `executor/` | 시그널이 실행 결과에 의존 금지 |
| `strategy/` → `orchestration/` | 하위 → 상위 역참조 금지 |
| `candle/` → `gate/` | 데이터가 비즈니스 로직에 의존 금지 |
| `risk/` → `orchestration/` | 하위 → 상위 역참조 금지 |
| `utils/` → 다른 모듈 | 기반 레이어 독립성 유지 |

## 알려진 예외

`risk/` ↔ `reporting/` 순환 의존 — 향후 공유 타입 추출로 해결 예정.
- `risk/riskTier.ts` → `reporting/edgeTracker` (EdgeTracker, EdgeState)
- `reporting/paperValidation.ts` → `risk/drawdownGuard` (replayDrawdownGuardState)

## ESLint 강제

`eslint.config.js`의 `no-restricted-imports` 규칙으로 기계적으로 강제.
위반 시 lint 에러 발생.
