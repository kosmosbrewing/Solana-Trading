# AGENTS.md — Solana Momentum Bot

## 🚀 새 세션 진입 순서 (Codex / Cursor / Claude Code 모두 동일)

> 본 프로젝트는 **paradigm 이 여러 번 진화**했습니다 (pre-pivot → mission-pivot 2026-04-18 → mission-refinement 2026-04-21 → **Option 5 KOL Discovery 2026-04-23**).
> 새 세션이 정확한 active paradigm 을 빠르게 파악하려면 **이 순서로** 읽으세요.

### Stage 0 (1-2분)
1. **[`SESSION_START.md`](./SESSION_START.md)** — 1 페이지 hand-off (Lane 표 + Real Asset Guard + 1줄 신뢰 명령)

### Stage 1 (5분) — Paradigm authority
2. **[`MISSION_CONTROL.md`](./MISSION_CONTROL.md)** — 6 control framework (survival/universe/payoff/execution/experiment/discipline)
3. **[`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`](./docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md)** — **현 active paradigm**
4. **[`docs/design-docs/mission-refinement-2026-04-21.md`](./docs/design-docs/mission-refinement-2026-04-21.md)** — 원 사명 정의 (historical 0.8 SOL; 현재 운영 floor 는 `SESSION_START.md`의 0.7 SOL)

### Stage 2 (10분) — 현재 작업
5. **[`REFACTORING_v1.0.md`](./REFACTORING_v1.0.md)** — Option 5 Phase 0-5 진행 상태
6. **[`INCIDENT.md`](./INCIDENT.md)** — 최근 운영 관측 + 결정 연표

### Stage 3 (필요 시)
7. **[`ARCHITECTURE.md`](./ARCHITECTURE.md)** — 모듈 구조
8. **[`docs/debates/`](./docs/debates/)** — 의사결정 history

### 코드 작업 시작 전
- 1줄 신뢰 명령: `npm run check:fast` (typecheck + jest + env drift)
- Real Asset Guard (wallet floor 0.7 / KOL ticket 0.02 / default ticket 0.01 / default canary -0.3 / KOL canary -0.2 / drift halt 0.2 / max concurrent 3) **변경 금지**
- `npm run check:strict` (lint + structure 포함) 빨강은 **Phase H2-H4 에서 점진 해소 deferred**, 의도

### 운영 로그 / 거래 분석 표준
- 운영 분석은 먼저 `bash scripts/sync-vps-data.sh`를 실행해 로컬 `data/`, `logs/`, `reports/`를 같은 시점으로 맞춘다.
- DB trades dump 는 기본 사용 금지. 필요할 때만 `RUN_TRADES_DUMP=true bash scripts/sync-vps-data.sh`로 opt-in 한다.
- Helius `getTransfersByAddress` 기반 `data/research/kol-transfers.jsonl` 은 로컬 분석 캐시다. `sync-vps-data.sh`는 이 파일을 기본 rsync 제외하고 API를 호출하지 않는다. stale 경고가 뜨면 `npm run kol:transfer-refresh`를 별도 sidecar로 실행한다.
- 분석 기준 산출물은 아래 순서로 본다.
  1. `sync-health` daily report — 파일 freshness / row count / missing artifact 확인. `logs/bot.log`가 30분 이상 stale 이면 결론 보류.
  2. `kol-live-canary` daily report — live canary wallet-truth, net SOL, actual 5x, Phase 4 gate. `phase4=PAUSE_REVIEW`면 승격 금지.
  3. `kol-transfer-posterior` daily report — KOL별 rotation/smart-v3 fit posterior. 진단 전용이며 precise swap PnL 이 아니므로 정책 승격 전 gTFA drill-down 이 필요하다.
  4. `smart-v3-evidence` daily report — smart-v3 projection + shared T+ 기반 cohort verdict. `minCov`는 close-anchor coverage이며, W/L은 copyable/wallet-first다.
  5. `trade-markout` daily report — 실제 buy/sell/paper anchor 이후 T+30/60/300/1800 관측률과 continuation. `coverage < 80%`이면 T+ 기반 결론은 보류한다.
  6. `winner-kill` daily report — close 후 5x winner-kill rate. winner-kill 존재 시 exit/tail 정책을 먼저 검토한다.
  7. `token-quality` daily report — token-quality / dev-candidate cohort. `observations=0`이면 dev-quality 결론 금지.
  8. `kol-paper-arms` daily report — paper/shadow arm 비교. live 결정보다 낮은 권위.
- 운영 판정은 wallet truth 를 우선한다. DB PnL 단독 판정 금지.
- 표준 판정 축: sync freshness, KOL transfer posterior freshness, current session 이후 entry 유무, live closed/open/orphan, net SOL / max drawdown, actual MFE/T1/T2/5x, smart-v3 evidence verdict, buy/sell T+ markout coverage/continuation, winner-kill, token-quality observations, wallet drift, recent ERROR/WARN.
- 한 줄 판정은 `OK / WATCH / PAUSE_REVIEW / INVESTIGATE` 중 하나로 끝낸다.

---

## 프로젝트 개요
- 한 줄 설명: Convexity-first Solana momentum/sniper bot (Option 5: KOL Discovery + 자체 Execution)
- 스택: TypeScript, `@solana/web3.js`, Jupiter, TimescaleDB, Winston, pm2
- 모드: `paper` / `live` (`TRADING_MODE`)
- 아키텍처 기준: [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- 현 active paradigm: [`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`](./docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md)
- 이전 pivot (하위 권위): [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md)

## 현재 우선 문서

- 현재 진입/운영 기준은 `SESSION_START.md`, `MISSION_CONTROL.md`, `STRATEGY.md`, `OPERATIONS.md`, `docs/design-docs/lane-operating-refactor-2026-05-03.md`, `docs/exec-plans/active/20260503_BACKLOG.md`를 우선한다.
- 오래된 pivot/mission 문서는 historical context 로만 본다. 현재 판단과 충돌하면 최신 lane/refactor 문서를 따른다.

## 에이전트 작업 규칙

1. 새 파일 생성 전 [`ARCHITECTURE.md`](./ARCHITECTURE.md)의 의존성 방향을 확인한다.
2. 외부 API 호출은 반드시 해당 client 모듈을 경유한다. 직접 `axios` 호출 금지.
3. 환경변수는 반드시 `src/utils/config.ts`에서 정의·참조한다. `process.env` 직접 접근 금지.
4. 파일당 200줄 이내를 지향한다. 300줄 초과 시 분리를 우선 검토한다.
5. 변수명·함수명·에러 메시지는 영어, 주석은 한국어를 사용한다.
6. 새 전략 추가 시 `docs/design-docs/`에 설계 문서를 먼저 작성한다.
7. `risk/` 또는 `gate/` 변경 시 관련 테스트를 반드시 갱신한다.

## 문서 정리 원칙

- 현재 동작의 기준은 `docs/design-docs/mission-pivot-2026-04-18.md`, `PLAN.md`, `docs/exec-plans/active/1sol-to-100sol.md`, `STRATEGY.md`, `OPERATIONS.md` 순서로 우선한다.
- 완료된 root plan/handoff는 `PLAN_CMPL.md`로 이관하고, 원본 파일은 필요 없으면 삭제한다.
- dated handoff는 historical note로만 유지하고, 현재 판단과 충돌하면 최신 plan 문서를 따른다.
- 중복 메모는 남기지 않는다. 새로운 운영 해석은 기존 handoff를 덧붙이기보다 기준 문서에 흡수한다.
- root stub 파일은 `README.md`나 active 문서 목록에 개별 나열하지 않는다.
- Pre-pivot 문서(2026-04-18 이전)는 `docs/historical/pre-pivot-2026-04-18/`에 보존한다 — 현재 판정 근거로 사용 금지.
