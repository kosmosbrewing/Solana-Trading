# HARNESS.md — Solana 에이전트·개발 하네스

> Status: current
> Updated: 2026-07-10
> Scope: `Solana/` 저장소와 `solana-momentum-bot/`

## 1. 하네스의 현재 목적

이 저장소의 하네스는 에이전트가 오래된 live 문서를 현재 승인으로 오독하지 않게 하고,
코드·설정·테스트에 근거한 검증을 반복 가능하게 만드는 장치다.

현재 최우선 안전 조건은 다음과 같다.

```text
RETIRE_CURRENT_LIVE 유지
→ H-007a는 통계·join 프로토콜을 먼저 승인·고정
→ 승인 뒤에만 로컬/API 0 분석으로 진행
→ 결과와 운영자 결정 전에는 deploy/restart/live 금지
```

## 2. 지식 계층

| 계층 | 문서/코드 | 용도 |
|---|---|---|
| 현재 hand-off | `solana-momentum-bot/SESSION_START.md`, `solana-momentum-bot/MEMORY.md` | 상태, blocker, 다음 작업 |
| 결정 대기 | `solana-momentum-bot/20260708.md`, `solana-momentum-bot/HYPOTHESES.md` | H-007a와 go/no-go |
| 현재 mission | `solana-momentum-bot/docs/design-docs/mission-refinement-v2-2026-06-10.md` | 생존 우선, 예비금 동결, promotion gate |
| 구현 truth | `solana-momentum-bot/package.json`, `solana-momentum-bot/src/`, tests | 실제 가능한 동작과 기본값 |
| 정책 guard | `solana-momentum-bot/src/utils/policyGuards.ts`, `solana-momentum-bot/src/risk/` | ticket/floor/drift/자본 안전장치 |
| 역사 | dated docs, `solana-momentum-bot/INCIDENT.md`, `solana-momentum-bot/docs/ops-history/`, reports | 당시 근거; 현재 실행 지시 아님 |

`AGENTS.md`는 진입 목차, `docs/`는 세부 근거, 테스트는 실행 가능한 계약으로 사용한다.

## 3. 표준 세션 루프

```text
git status
→ solana-momentum-bot/SESSION_START.md / MEMORY.md
→ 작업별 authority와 코드 확인
→ 변경
→ check:fast + docs:lint (+ build/check:strict)
→ diff와 미확인 외부 상태 보고
```

기본 명령:

```bash
cd solana-momentum-bot
npm run check:fast
npm run docs:lint
npm run build
```

`check:fast`는 typecheck(source/scripts), env catalog, Jest를 실행한다. `docs:lint`는 현재
authority 문구, current/historical 경계, 주요 상대 링크와 package script target을 검사한다.
`check:strict`는 ESLint까지 포함한다.

## 4. 고위험 경계

- 실제 secret env 파일은 읽지 않는다. 예시·추적 profile·config parser만 감사한다.
- live, 배포, 재시작, migration, 데이터 삭제는 문서 정리의 부수 작업으로 실행하지 않는다.
- `ops/env/production.env`는 `TRADING_MODE=live`와 과거 canary flag를 포함한다.
- `.github/workflows/deploy.yml`은 main의 `solana-momentum-bot/**` push 후 VPS를 자동 재시작한다.
- 따라서 현재 문서 변경도 push 시 외부 상태를 바꿀 수 있다. workflow/profile을 안전화하거나
  운영자가 명시 승인하기 전에는 push·deploy를 별도 고위험 작업으로 취급한다.

## 5. 문서 수명 규칙

- `MEMORY.md`: 변하는 현황만 기록. Done/In Progress/Blocked/Needs Verification 유지.
- `AGENTS.md`: 100줄 이하 진입점. 상세 이력 금지.
- dated design/report/ops history: 내용 보존. 최신 index에서 역사 상태만 분류.
- 현재 문서의 수치에는 source와 검증 시각을 붙인다.
- 원격/VPS 상태를 직접 확인하지 않았으면 “정지”를 확정 사실로 쓰지 않고 마지막 기록과
  `Needs Verification`을 함께 쓴다.

## 6. 에이전트 역할

| 역할 | 현재 책임 | 금지 |
|---|---|---|
| CEO | H-007a/종료 결정 조율, 예산·승인 경계 유지 | live 승인 추정 |
| EventScout | 명시 과제의 offline research | EventScore로 live 추천 |
| OnchainAnalyst | 코드/데이터 감사, H-007a 구현·재현 | 배포·funded 실행 |

역할별 세부 지침은 `agents/`에 있다. 모든 memory 작업은 PARA 지침을 따르고, Paperclip
조정은 Paperclip 도구를 통해서만 수행한다.

## 7. 현재 하네스 gap

- H-007a는 가설 의도만 등록됐고 통계·join·판정 프로토콜, 실행기, 결과 artifact가 없다.
- 원격 bot/ops-bot/VPS 상태는 로컬 저장소만으로 확인할 수 없다.
- tracked production profile과 `RETIRE_CURRENT_LIVE` 사이에 config drift가 있다.
- main push 자동 배포가 문서-only 변경도 재시작시키므로 안전한 수동 gate가 필요하다.
- ESLint는 2026-07-10 기준 18 errors / 32 warnings로 `check:strict`가 RED다. import boundary와
  실제 bootstrap 구조를 별도 refactor에서 정합해야 한다.

이 다섯 항목은 `solana-momentum-bot/MEMORY.md`의 `Blocked`/`Needs Verification`에서 추적한다.
