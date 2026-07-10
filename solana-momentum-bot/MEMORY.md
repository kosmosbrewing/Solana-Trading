# MEMORY.md — Solana Momentum Bot

> Project status memory; policies live in `AGENTS.md`, Mission v2, and code guards.
> Last verified: 2026-07-10 12:06 (KST)

## Current Status

### Done

- [x] 2026-06-10 Edge Audit: `RETIRE_CURRENT_LIVE` (475 closes, wallet-truth -1.128 SOL).
- [x] KOL-follow, multi-KOL consensus, rebound, survivor momentum, majors low-frequency hypotheses rejected/retired.
- [x] Loss-control, wallet reconciliation, promotion, reporting, credit-attribution infrastructure preserved.
- [x] 2026-07-10 local baseline: `npm run check:fast` PASS (211 Jest suites, 2,131 tests), `npm run docs:lint` PASS, `npm run build` PASS.
- [x] Current/historical 문서 catalog와 Paperclip agent harness를 현재 코드·프로젝트 cwd 계약에 맞게 정합화.

### In Progress

- [ ] H-007a 사전 프로토콜 고정: outcome/join/dedup/cohort/N·coverage/통계 판정 계약.

### Blocked

- [ ] H-007a 실행 | why: 사전 프로토콜과 운영자 승인이 아직 없음.
- [ ] 최종 종료/guard base-layer 보존/좁은 H-007 재개 결정 | why: 승인된 H-007a 결과와 운영자 결정 필요.
- [ ] H-007 본검정·유료 holder/dev 수집 | why: H-007a에서 ex-ante signal이 확인되기 전 지출 금지.

### Needs Verification

- [ ] 원격 `momentum-bot`, `momentum-ops-bot`, VPS 현재 상태 | how: 별도 승인 후 read-only PM2/status 확인.
- [ ] 2026-06-13 이후 Helius quota/reset·billing 상태 | how: secret 노출 없이 provider dashboard/usage 확인.
- [ ] H-007a input artifact의 현재 존재, row count, timestamp/schema coverage | how: 구현 전 로컬 data inventory.
- [ ] tracked production profile이 다음 배포에서 live를 재활성화하는지 | how: env merge/preflight를 secret 없는 fixture로 검증.

## Decisions Log

- 2026-06-10 | 결정: `RETIRE_CURRENT_LIVE` | 이유: wallet-truth 음수·통과 cohort 0 | ref: Edge Audit.
- 2026-06-10 | 결정: Mission v2 채택 | 이유: 속도 경쟁 대신 생존·저빈도·사전 검정 | ref: Mission v2 ADR.
- 2026-06-13 | 결정: 돈 쓰기 전 H-007a $0 proxy 우선 | 영향: paid Helius/Lever 2/예비금 투입 보류.
- 2026-07-08 | 결정: 최종 go/no-go는 H-007a 결과 후 운영자가 기록 | 상태: pending.

## Operational Params

- trading mode default: `paper` | source: `src/config/helpers.ts` | runtime effective: Needs Verification.
- wallet hard floor: `0.6 SOL` | source: `src/config/walletAndCanary.ts`.
- wallet drift warn/halt: `0.05 / 0.20 SOL` defaults | source: 같은 파일.
- global concurrency: default disabled, enabled limit `3` | tracked production override: enabled, `2`.
- ticket policy max: default lanes `0.01 SOL`, KOL `0.02 SOL` | source: `src/utils/policyGuards.ts`.
- mission soft-kill: floor + `0.08 SOL` recommends shadow-only | source: `src/risk/missionCapitalGuard.ts`.
- budget policy: Helius ≤$50/month, VPS $8/month, reserve $1,000 frozen until qualified cohort | source: Mission v2; current billing Needs Verification.

## Known Issues

- 이슈: current decision과 tracked production profile이 충돌한다.
  - severity: high
  - evidence: `ops/env/production.env` has historical live mode/canary overrides.
  - next probe: secret 없는 fixture로 profile merge와 effective toggles 검증; 운영자 승인 전 deploy 금지.
- 이슈: main bot-path push가 자동 VPS deploy/restart를 수행한다.
  - severity: high
  - evidence: `.github/workflows/deploy.yml`.
  - next probe: manual approval/environment gate 또는 workflow disable 여부 결정.
- 이슈: H-007a는 가설 의도만 등록됐고 판정 프로토콜·runner/test/result가 없다.
  - severity: high
  - evidence: horizon/outcome/join/dedup/cohort/N·coverage/CI·alpha/multiple-testing이 미고정이고 기존 token-quality retro는 다른 contract.
  - next probe: 결과를 열람하기 전에 별도 프로토콜 문서를 커밋하고 운영자 승인.
- 이슈: `npm run lint`가 18 errors / 32 warnings로 실패해 `check:strict`가 RED다.
  - severity: medium
  - evidence: 2026-07-10 local run; init→orchestration 및 risk→executor import boundary가 주 오류.
  - next probe: 실제 bootstrap boundary를 ARCHITECTURE/ESLint 중 어디에 정합할지 별도 code refactor로 결정.
- 이슈: `env:check`는 `src/config/*.ts`만 검사하며 source의 legacy `process.env` 직접 접근 15개를 카탈로그화하지 않는다.
  - severity: medium
  - evidence: executor/gate/bootstrap/test 경계의 직접 접근과 `.env.example.generated` 대조.
  - next probe: 직접 접근을 `src/config/`로 이동하거나 env catalog의 전체-source 감사 범위를 설계.
- 이슈: 4~5월 current/live 문구가 dated history와 root reference에 남는다.
  - severity: medium
  - mitigation: current index/banner가 우선하며 dated 본문은 역사 기록으로 보존.

## Next Tasks

- [ ] (P0) H-007a 사전 프로토콜 작성·커밋·운영자 승인(결과 열람 전).
- [ ] (P0) 승인된 계약으로 input/schema inventory와 runner/unit tests/deterministic report 구현.
- [ ] (P0) 운영자에게 H-007a 결과와 최종 decision 요청.
- [ ] (P0) auto-deploy/live profile 안전화 여부 결정; 결정 전 push/deploy 금지.
- [ ] (P1) 원격 runtime과 비용 상태 read-only 검증.
