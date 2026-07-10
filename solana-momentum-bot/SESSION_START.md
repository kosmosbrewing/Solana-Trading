# SESSION_START — Current Hand-off

> Last verified: 2026-07-10 11:23 (KST)
> Decision state: **`RETIRE_CURRENT_LIVE` 유지 / 운영자 최종 결정 대기**

## 1. One-Line Trust Check

```bash
npm run check:fast
```

2026-07-10 결과: source/scripts typecheck, env catalog, 211 Jest suites 통과.

`npm run lint`는 기존 구조 debt로 18 errors / 32 warnings이며 `check:strict`는 현재 RED다.
문서 하네스와 build는 GREEN이다. 상세 추적은 [`MEMORY.md`](./MEMORY.md)의 Known Issues를 본다.

## 2. What Is Current

| 축 | 현재 상태 |
|---|---|
| Mission | Mission v2: 생존 우선, 반복 가능한 ex-ante edge 없이는 자본 투입 금지 |
| Live strategy | `RETIRE_CURRENT_LIVE`; KOL-follow smart-v3/rotation/broad canary retired |
| Runtime | 마지막 기록은 2026-06-13 paper bot 정지; 현재 원격 상태는 Needs Verification |
| Research | H-007a `PROTOCOL_REQUIRED`: 가설 의도만 등록, 판정 계약 승인 전 실행 금지 |
| Decision | H-007a 결과 후 종료 / guard base-layer 보존 / 좁은 H-007 재개 중 선택 |
| Evidence | 7 hypotheses failed; reusable engineering/guard/measurement assets remain |

## 3. Read Order

1. [`MEMORY.md`](./MEMORY.md)
2. [`20260708.md`](./20260708.md)
3. [`HYPOTHESES.md`](./HYPOTHESES.md)
4. [`docs/design-docs/mission-refinement-v2-2026-06-10.md`](./docs/design-docs/mission-refinement-v2-2026-06-10.md)
5. [`docs/INCIDENT_SUMMARY.md`](./docs/INCIDENT_SUMMARY.md)

코드 작업은 [`AGENTS.md`](./AGENTS.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md),
[`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md), [`docs/SECURITY.md`](./docs/SECURITY.md)를
추가로 읽는다.

## 4. H-007a Is Not Yet Execution-Ready

H-007a는 `token-quality-observations`의 entry-time `operatorDevStatus`/`riskFlags`를
trade markout forward outcome에 시간 정합 join하는 검정이다.

- 기존 `scripts/kol-token-quality-retro.ts`는 paper trade의 `survivalFlags`와 close 결과를
  비교하는 2026-04 Track 2A 도구다.
- 따라서 기존 script 실행을 H-007a 결과로 간주하면 안 된다.
- 전용 구현 전 horizon/outcome axis, join tolerance·tie-break, dedup, flag/control cohort,
  최소 N/coverage, CI·alpha와 multiple-testing, 결측 규칙, verdict 표를 먼저 커밋하고
  운영자 승인을 받아야 한다. 승인 전에는 join 결과를 생성·열람하지 않는다.
- 승인 뒤 전용 구현에는 look-ahead 차단, synthetic tests, 재현 가능한 Markdown/JSON output이 필요하다.

## 5. Hard Safety Boundary

- live, deploy, PM2 restart, remote env sync, ticket/guard 완화 금지.
- 실제 `.env`/`.env.production`/secret 값 열람·출력 금지.
- `ops/env/production.env`는 과거 live 설정을 보존하므로 현재 source of truth가 아니다.
- main의 bot 경로 push는 GitHub Actions 자동 배포를 촉발할 수 있다.
- live 검토 자격은 offline N≥100, active days≥5, promotion-grade join≥95%, chronological OOS,
  wallet-stress positive, paired mirror≥30, sign agreement≥85%를 모두 통과한 뒤 수동 review로만 생긴다.

## 6. Code-Level Guard Snapshot

| Guard | 코드 기본/정책 상한 | 위치 |
|---|---|---|
| trading mode | `paper` | `src/config/helpers.ts` |
| wallet floor | `0.6 SOL` | `src/config/walletAndCanary.ts` |
| drift warn/halt | `0.05 / 0.20 SOL` | 같은 파일 |
| global concurrency | 기본 off; 활성 시 `3` | 같은 파일 |
| ticket | 일반 `0.01`, KOL `0.02 SOL` | `src/utils/policyGuards.ts` |
| soft-kill line | floor + `0.08 SOL` | `src/risk/missionCapitalGuard.ts` |

effective runtime 값은 원격 env/startup log를 확인하기 전에는 확정하지 않는다.

## 7. Commands

```bash
# local, side-effect free
npm run check:fast
npm run docs:lint
npm run build
npm run deploy:preflight

# deeper local validation
npm run check:strict
```

`deploy:preflight`는 정적 검증일 뿐 실제 배포가 아니다. `deploy:vps`, remote deploy,
`restart:bot-ops`는 현재 금지 목록이다. `check:strict`는 위 ESLint debt 때문에 실패가 예상된다.

## 8. Current vs Historical

- Current: `README.md`, 이 문서, `MEMORY.md`, `HYPOTHESES.md`, `20260708.md`, Mission v2
- Current code contract: `package.json`, `src/config/`, source/tests
- Historical: Mission v1/Option 5, `REFACTORING_v1.0.md`, old lane/backlog docs,
  dated design docs, `INCIDENT.md`, `docs/ops-history/`, reports

역사 문서의 `active`, `current`, live commands는 해당 날짜의 기록이다.

## 9. Immediate Next Tasks

1. H-007a 사전 프로토콜을 결과 열람 전에 커밋하고 운영자 승인을 받는다.
2. 승인된 계약으로 runner/tests를 구현해 로컬 데이터로 재현한다.
3. H-007a 결과를 `HYPOTHESES.md`와 `20260708.md` 결정란에 운영자 승인과 함께 반영한다.
4. 별도 승인 아래 원격 bot/ops-bot/VPS 상태를 read-only로 확인한다.
5. live profile과 main auto-deploy를 현재 정지 정책에 맞게 안전화할지 결정한다.

현재 추가 정보 없이 문서·로컬 코드 감사는 가능하다. H-007a 최종 실행에는 로컬 input
artifact 존재/스키마 확인이 필요하고, 최종 폐기/재개와 배포 안전화에는 운영자 결정이 필요하다.
