# AGENTS.md — Solana Momentum Bot

## Current Authority

1. [`20260708.md`](./20260708.md) — go/no-go 결정 대기
2. [`HYPOTHESES.md`](./HYPOTHESES.md) — H-007a 선행조건과 기각 가설 원장
3. [Mission v2](./docs/design-docs/mission-refinement-v2-2026-06-10.md) — 현재 mission
4. [`docs/INCIDENT_SUMMARY.md`](./docs/INCIDENT_SUMMARY.md) — 마지막 검증된 운영 맥락
5. [`SESSION_START.md`](./SESSION_START.md) / [`MEMORY.md`](./MEMORY.md) — 현재 hand-off, blocker, 검증 상태
6. Source, `package.json`, tests — runtime capability/default; live 승인과는 별개

현재 판정은 `RETIRE_CURRENT_LIVE`; H-007a 프로토콜·결과와 운영자 결정 전 live 재개 금지다.
Option 5, lane backlog, `REFACTORING_v1.0.md`, dated docs는 역사/구현 참고다.

## Start Protocol

- `git status --short --branch`와 대상 파일을 먼저 확인한다.
- 사용자 변경과 append-only `INCIDENT.md`/ops history를 보존한다.
- 구현 판단은 source, `package.json`, tests, tracked example/profile만 사용한다.
- 원격 상태를 확인하지 않았으면 `Needs Verification`으로 남긴다.

## High-Risk Guard

- deploy, PM2 restart, live 전환, 지갑/예비금 사용, ticket/guard 완화는 별도 운영자 승인 없이는 금지.
- 실제 `.env`, `.env.production`, private key, RPC/API token을 읽거나 출력하지 않는다.
- tracked `ops/env/production.env`는 현재 판정과 충돌하는 역사적 live profile이다.
- main의 `solana-momentum-bot/**` push는 자동 배포 workflow를 촉발할 수 있다.
- wallet truth만 최종 손익 근거로 사용한다. DB PnL 단독 판정 금지.

## Code Rules

1. 새 파일은 [`ARCHITECTURE.md`](./ARCHITECTURE.md)의 의존성 방향을 따른다.
2. 새 env 정의는 `src/config/`의 도메인 section에 둔다. `src/utils/config.ts`는 import 호환 shim이다.
   기존 executor/gate/bootstrap 직접 접근은 Known Issue이며 새 직접 접근을 추가하지 않는다.
3. 외부 API는 기존 client/ingester를 경유하고 timeout·backoff·credit budget을 유지한다.
4. `risk/`, `gate/`, executor, wallet/ledger 변경은 관련 테스트와 rollback 근거가 필수다.
5. 변수·함수·에러는 영어, 설명·Why 주석은 한국어를 사용한다.
6. 기각 가설은 재검정 조건 없이 다시 구현하지 않는다.
7. H-007a는 기존 retro script와 다르다. 결과를 열람하기 전에 outcome/join/dedup/cohort/
   N·coverage/통계 판정 계약을 커밋하고 운영자 승인을 받아야 한다.

## Documentation Rules

- 현재 사실은 README/SESSION_START/MEMORY/HYPOTHESES에 반영한다.
- `docs/design-docs/mission-refinement-v2-2026-06-10.md` 외 design/report/ops-history 본문은 당시 스냅샷으로 보존한다.
- current vs historical 분류는 [`docs/design-docs/index.md`](./docs/design-docs/index.md)에서 관리한다.
- project `MEMORY.md`에는 가변 상태만 기록하고 정책은 이 파일/mission 문서에 둔다.

## Validation

```bash
npm run check:fast
npm run docs:lint
npm run build
```

- 변경 범위가 넓으면 `npm run check:strict`도 실행한다.
- `deploy:preflight`는 배포 없는 정적 점검에만 사용한다.
- 미실행 항목, 외부 상태, 데이터 부족은 이유와 리스크를 보고한다.

## Handoff Format

- 변경 파일과 코드 근거
- 검증 명령과 결과
- `Blocked` / `Needs Verification`
- 거래·secret·배포 관련 미수행 사항
