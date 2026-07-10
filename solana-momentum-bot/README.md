# Solana Momentum Bot

TypeScript 기반 Solana DEX 연구·실행 인프라다. 실시간 수집, Jupiter 실행, wallet/ledger
정산, 전략 승격 gate, 보고 도구를 포함한다. 현재는 실거래 전략이 아니라 **보존된 연구
시스템**으로 읽어야 한다.

## Current Status — 2026-07-10

> **`RETIRE_CURRENT_LIVE` 유지 / 운영자 최종 결정 대기 / live 재개 금지.**

- 2026-06-10 Edge Audit: 475 live closes, wallet-truth `-1.128 SOL`, 통과 cohort 0.
- 2026-06-13 마지막 기록: Helius free quota 소진 뒤 paper bot 정지.
- quota reset 예상일 이후 재가동 여부와 현재 VPS/PM2 상태는 **Needs Verification**이다.
- 남은 저비용 gate 후보는 H-007a: 기존 token-quality flags와 forward markout join.
- H-007a는 `PROTOCOL_REQUIRED`다. 통계·join·판정 계약과 운영자 승인 전에는 실행하거나
  결과를 열람하지 않는다.
- 2026-07-10 `npm run check:fast`는 211 Jest suites와 type/env 검증을 통과했다.

결정 근거는 [`20260708.md`](./20260708.md), 상태 원장은 [`MEMORY.md`](./MEMORY.md),
가설 원장은 [`HYPOTHESES.md`](./HYPOTHESES.md)다.

## Start Here

1. [`SESSION_START.md`](./SESSION_START.md) — 현재 hand-off와 안전 경계
2. [`MEMORY.md`](./MEMORY.md) — Done/In Progress/Blocked/Needs Verification
3. [`20260708.md`](./20260708.md) — 종료/보존/좁은 재개 결정 트리
4. [`HYPOTHESES.md`](./HYPOTHESES.md) — 기각 가설과 H-007a protocol
5. [`docs/design-docs/mission-refinement-v2-2026-06-10.md`](./docs/design-docs/mission-refinement-v2-2026-06-10.md) — 현재 mission
6. [`docs/INCIDENT_SUMMARY.md`](./docs/INCIDENT_SUMMARY.md) — 반복 교훈과 마지막 운영 기록

코드 변경 시 [`AGENTS.md`](./AGENTS.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md), [`docs/SECURITY.md`](./docs/SECURITY.md)를
추가로 읽는다.

## Runtime vs Approval

코드에는 paper/live 모드, KOL/pure-ws/migration lane, PM2, deploy script가 남아 있다. 이는
재현과 자산 보존을 위한 **runtime capability**이며 현재 live 승인 상태가 아니다.

특히 다음 두 항목은 현재 판정과 충돌한다.

- `ops/env/production.env`: 과거 `TRADING_MODE=live`와 live canary override 보존
- `.github/workflows/deploy.yml`: main의 `solana-momentum-bot/**` push 후 VPS 자동 재시작

새 운영자 결정과 별도 안전 변경 전에는 `deploy:vps`, remote deploy, PM2 restart, live env
병합을 실행하지 않는다.

## Stack and Code Map

- Node.js `>=20`, TypeScript 5.6, Jest, ESLint
- `@solana/web3.js`, Jupiter, Helius, PostgreSQL/TimescaleDB, Winston, PM2
- 신규 환경변수 정의: `src/config/`; `src/utils/config.ts`는 호환 shim. executor/gate/bootstrap의
  legacy 직접 접근 15개는 `env:check` 범위 밖 Known Issue다.
- 핵심 조율: `src/index.ts`, `src/init/`, `src/orchestration/`
- 안전장치: `src/risk/`, `src/state/`, `src/utils/policyGuards.ts`
- 수집/관측: `src/realtime/`, `src/ingester/`, `src/observability/`, `src/reporting/`
- 연구/운영 CLI: `scripts/`; 계약은 `package.json`의 scripts가 기준

구현 아키텍처는 [`ARCHITECTURE.md`](./ARCHITECTURE.md)를 보되, 그 안의 4~5월 lane 상태
표는 역사적 runtime inventory로 읽는다.

## Local Setup and Validation

```bash
npm ci
npm run check:fast
npm run docs:lint
npm run build
```

| 명령 | 범위 |
|---|---|
| `npm run check:fast` | source/scripts typecheck + env catalog + Jest |
| `npm run check` | 명시적 전체 Jest 포함 검증 |
| `npm run check:strict` | check + ESLint + docs harness |
| `npm run deploy:preflight` | 추적 runtime path + script target + type/env 확인; **배포하지 않음** |
| `npm run backtest` | 과거 backtest CLI |
| `npm run kol:mission-offline-sim` | 기존 mission offline simulator; H-007a 실행기는 아님 |

로컬 개발 실행이 필요하면 secret 없는 dummy/test 환경 또는 `TRADING_MODE=paper`를 사용한다.
실제 지갑 키와 RPC/API token은 문서, 이슈, 로그, Git에 남기지 않는다.

2026-07-10 기준 `build`, `check:fast`, `docs:lint`는 GREEN이다. ESLint는 기존 구조 debt
(18 errors / 32 warnings)로 RED이므로 `check:strict`도 RED다. 이 상태를 우회하거나 disable하지
말고 [`MEMORY.md`](./MEMORY.md)의 Known Issues에서 별도 refactor로 추적한다.

## Safety Invariants in Code

| 항목 | 코드 기본/상한 | 근거 |
|---|---|---|
| mode | `paper` | `src/config/helpers.ts` |
| wallet hard floor | `0.6 SOL` | `src/config/walletAndCanary.ts` |
| drift warning / halt | `0.05 / 0.20 SOL` | 같은 파일 |
| concurrency | 기본 off, 활성 시 `3` | 같은 파일 |
| ticket policy max | 일반 `0.01`, KOL `0.02 SOL` | `src/utils/policyGuards.ts` |
| near-floor soft line | floor + `0.08 SOL` | `src/risk/missionCapitalGuard.ts` |

tracked production profile은 일부 값을 다르게 override한다. 실제 effective 값은 startup log와
원격 상태 확인 없이는 확정하지 않는다.

## Documentation Boundary

- **Current:** 이 README, `SESSION_START.md`, `MEMORY.md`, `HYPOTHESES.md`, `20260708.md`
- **Current policy:** Mission v2, wallet-truth, promotion gates, Real Asset Guard 코드
- **Implementation reference:** `ARCHITECTURE.md`, `package.json`, source/tests
- **Historical:** Option 5/mission v1, dated design docs, old active plans, `REFACTORING_v1.0.md`,
  `INCIDENT.md`, `docs/ops-history/`, reports

역사 문서의 `current`, `active`, live 명령은 작성 당시 상태다. 현재 실행 승인을 뜻하지 않는다.
