# AGENTS.md — Solana 저장소

## 현재 상태

- 유지 코드: `solana-momentum-bot/` (TypeScript / Node.js >=20 / Solana / Jupiter / PostgreSQL).
- 현재 판정: `RETIRE_CURRENT_LIVE`; 운영자 최종 결정 대기.
- 다음 후보 gate: H-007a 로컬 $0 분석. 사전 프로토콜·승인·실행기·결과가 아직 없음.
- 구현된 live 경로와 과거 live profile은 운영 승인이 아니다.

## 세션 진입

1. Git 상태를 확인하고 사용자 변경을 보존한다.
2. `solana-momentum-bot/SESSION_START.md`를 읽는다.
3. `solana-momentum-bot/MEMORY.md`, `solana-momentum-bot/20260708.md`,
   `solana-momentum-bot/HYPOTHESES.md`에서 현재 결정과 gate 선행조건을 확인한다.
4. 코드 작업은 하위 `solana-momentum-bot/AGENTS.md`를 추가 적용한다.

## 안전 규칙

- 새 운영자 승인과 별도 안전 변경 전에는 live 전환, 배포, PM2 재시작, ticket/guard 완화 금지.
- 실제 `.env`, `.env.production`, 지갑 키, RPC/API token을 읽거나 문서·로그에 전재하지 않는다.
- 근거는 추적된 `.env.example*`, `ops/env/production.env`, `src/config/`, 테스트만 사용한다.
- `ops/env/production.env`는 현재 승인 상태와 충돌하는 역사적 profile로 취급한다.
- `main`의 `solana-momentum-bot/**` 변경은 GitHub Actions 자동 배포 대상이다. push는 별도 확인 사항이다.
- `INCIDENT.md`, dated design/report, `docs/ops-history/`는 역사 원장이다. 삭제·현재화하지 않는다.

## 검증

```bash
cd solana-momentum-bot
npm run check:fast
npm run docs:lint
npm run build
```

- 코드 변경은 관련 테스트와 함께 검증한다.
- 문서 변경은 `docs:lint`; 구조·린트까지는 `check:strict`를 사용한다.
- 실행하지 못한 검증과 외부 상태는 `Needs Verification`으로 보고한다.

## 응답

- 현재 사실과 역사 스냅샷을 분리한다.
- 거래 판정은 wallet truth만 사용하며 DB PnL 단독 결론을 금지한다.
- 변경 파일, 코드 근거, 검증 명령, 고위험 미확인 사항을 함께 보고한다.
