# Solana / Solone

Solana DEX 전략 연구와 실행 인프라를 보존하는 저장소다. 현재 유지되는 코드 프로젝트는
[`solana-momentum-bot/`](./solana-momentum-bot/) 하나이며, 과거 README에 있던 Python v0
스나이퍼 파일은 이 저장소에 존재하지 않는다.

## 현재 상태 — 2026-07-10

| 항목 | 상태 | 근거 |
|---|---|---|
| 실거래 전략 | **중지 유지 (`RETIRE_CURRENT_LIVE`)** | [`20260708.md`](./solana-momentum-bot/20260708.md), [Edge Audit](./solana-momentum-bot/analysis/edge-audit-2026-06-10/EDGE_AUDIT_REPORT.md) |
| 프로젝트 결정 | **운영자 결정 대기** | 승인된 H-007a 결과로 종료/보존/좁은 재개를 결정 |
| 다음 연구 | H-007a `PROTOCOL_REQUIRED`; 실행 전 통계·join 계약 승인 필요 | [`HYPOTHESES.md`](./solana-momentum-bot/HYPOTHESES.md) |
| 코드 건강도 | `npm run check:fast` 통과 | 2026-07-10 로컬 검증, 211 Jest suites |
| 원격 런타임 | **Needs Verification** | 마지막 기록은 2026-06-13 정지. 현재 VPS/PM2 상태는 이번 감사에서 조회하지 않음 |

구현에 live 경로가 남아 있다는 사실은 운영 승인을 뜻하지 않는다. 추적된
`ops/env/production.env`와 자동 배포 workflow에는 과거 live 설정이 남아 있으므로,
새 운영자 결정과 별도 안전 변경 전에는 배포·재시작·live 전환을 하지 않는다.

## 시작 순서

1. [`solana-momentum-bot/SESSION_START.md`](./solana-momentum-bot/SESSION_START.md)
2. [`solana-momentum-bot/MEMORY.md`](./solana-momentum-bot/MEMORY.md)
3. [`solana-momentum-bot/20260708.md`](./solana-momentum-bot/20260708.md)
4. [`solana-momentum-bot/HYPOTHESES.md`](./solana-momentum-bot/HYPOTHESES.md)
5. 코드 작업이면 [`solana-momentum-bot/AGENTS.md`](./solana-momentum-bot/AGENTS.md)와
   [`solana-momentum-bot/ARCHITECTURE.md`](./solana-momentum-bot/ARCHITECTURE.md)

## 저장소 구조

```text
Solana/
├── AGENTS.md                 # 저장소 공통 작업·안전 규칙
├── harness.md                # 현재 에이전트/개발 하네스
├── HARNESS_REFACTORING.md    # 2026-03 하네스 도입 계획(역사 기록)
├── agents/                   # Paperclip 역할별 지침
└── solana-momentum-bot/      # TypeScript 런타임·연구·문서
```

## 로컬 검증

```bash
cd solana-momentum-bot
npm ci
npm run check:fast
npm run docs:lint
npm run build
```

`check:fast`는 source·scripts typecheck, env catalog drift, Jest를 검사한다. `check:strict`는
여기에 ESLint와 문서 하네스를 추가한다. 네트워크·지갑·DB가 필요한 운영 명령은 기본
검증 경로가 아니다.

## 문서 경계

- 현재 상태: `README.md`, `SESSION_START.md`, `MEMORY.md`, `HYPOTHESES.md`, `20260708.md`
- 현재 정책: Mission v2와 Real Asset Guard 코드
- 구현 설명: `ARCHITECTURE.md`, package scripts, `src/`
- 역사 기록: dated design docs, `INCIDENT.md`, `docs/ops-history/`, completed plans, 분석 보고서

역사 기록의 당시 `Status: current`나 live 지시는 그 시점의 스냅샷이다. 현재 실행 승인으로
해석하지 않는다.
