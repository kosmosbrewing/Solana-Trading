# Solana Momentum Bot — Agent Instructions

## 🚀 새 세션 진입 순서 (이 순서로 읽으세요)

새 AI/사람 세션이 별도 지시 없이도 paradigm 을 자동 파악할 수 있도록 **이 순서로** 문서를 읽으세요.
Stage 1-2 만 읽으면 (5-10분) 코드 변경 가능. Stage 3+ 는 필요 시.

### Stage 0 — 즉시 진입 (1-2분)
1. **[`SESSION_START.md`](./SESSION_START.md)** — 1 페이지 hand-off. 1줄 신뢰 명령 / Lane 표 / Real Asset Guard / 금지 사항.

### Stage 1 — Paradigm authority (5분)
2. **[`MISSION_CONTROL.md`](./MISSION_CONTROL.md)** — 6 control framework (survival/universe/payoff/execution/experiment/discipline)
3. **[`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`](./docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md)** — 현 active paradigm
4. **[`docs/design-docs/mission-refinement-2026-04-21.md`](./docs/design-docs/mission-refinement-2026-04-21.md)** — 원 사명 정의 (historical 0.8 SOL; 현재 운영 floor 는 `SESSION_START.md`의 0.6 SOL)

### Stage 2 — 현재 active 작업 (10분)
5. **[`REFACTORING_v1.0.md`](./REFACTORING_v1.0.md)** — Option 5 Phase 0-5 진행 상태 (어디까지 왔나)
6. **[`INCIDENT.md`](./INCIDENT.md)** — 최근 운영 관측 + 결정 연표 (왜 이 상태인가)

### Stage 3 — 깊이 들어갈 때 (필요 시)
7. **[`ARCHITECTURE.md`](./ARCHITECTURE.md)** — 모듈 구조 / 의존성 방향
8. **[`docs/debates/`](./docs/debates/)** — 의사결정 history (대담 기록)

### Stage 4 — 작업 종류별 참조
- 코드 변경 전: [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md), [`docs/SECURITY.md`](./docs/SECURITY.md)
- 트러블슈팅: [`OPERATIONS.md`](./OPERATIONS.md), [`INCIDENT.md`](./INCIDENT.md)
- 측정 / KPI: [`MEASUREMENT.md`](./MEASUREMENT.md)
- 사명 roadmap / backlog: [`docs/exec-plans/active/20260503_BACKLOG.md`](./docs/exec-plans/active/20260503_BACKLOG.md)
- 작업 시작 전 에이전트 규칙: [`AGENTS.md`](./AGENTS.md)

---

## Quick Reference (legacy, Stage 1-2 의 alias)
- **운영 로그 / 거래 분석 표준 (2026-05-05)**: 먼저 `bash scripts/sync-vps-data.sh` 실행. DB dump 는 기본 사용 금지 (`RUN_TRADES_DUMP=true`일 때만). Helius `getTransfersByAddress` posterior 입력인 `data/research/kol-transfers.jsonl` 은 local-only 분석 캐시이며 sync 기본 rsync 제외 + API 호출 0건이다. stale 경고가 뜨면 `npm run kol:transfer-refresh` 를 별도 sidecar 로 실행한다. 판정 순서: `sync-health` → `kol-live-canary` → `kol-transfer-posterior` → `smart-v3-evidence` → `trade-markout` → `winner-kill` → `token-quality` → `kol-paper-arms`. 표준 판정 축은 freshness / KOL transfer posterior freshness / current-session 이후 entry / live closed-open-orphan / wallet-truth net SOL / actual T1-T2-5x / smart-v3 evidence / buy-sell T+ coverage / winner-kill / token-quality observations / wallet drift / recent ERROR-WARN. 결론은 `OK / WATCH / PAUSE_REVIEW / INVESTIGATE` 중 하나로 끝낸다. 공통 규칙은 [`AGENTS.md`](./AGENTS.md)의 "운영 로그 / 거래 분석 표준"을 따른다.
- **2026-05-01 Decu New-Pair Quality Layer ADR**: [`docs/design-docs/decu-new-pair-quality-layer-2026-05-01.md`](./docs/design-docs/decu-new-pair-quality-layer-2026-05-01.md) — Phase A + B (observe-only) 구현 완료. 5 observability module + 4-jsonl cohort report + dev wallet DB. paper/live/shadow cohort dedup (codex F1) + missed-alpha winnerKill join (codex F2). enrichment (holder/vamp/fee 실 호출) 은 Phase B.1.5 follow-up.
- **2026-04-30 KOL Academic Report Integration ADR**: [`docs/design-docs/kol-academic-report-integration-2026-04-30.md`](./docs/design-docs/kol-academic-report-integration-2026-04-30.md) — 외부 학술 리포트 11개 권고 결정 매트릭스. Sprint 1 + Sprint 2.A1 + Phase 2.A2 partial take + Phase D live tail wiring 채택. Phase 3-4 (RCK/DRK) 보류 + 트리거 조건 명시. 신규 close reason `'structural_kill_sell_route'` + structural kill default ON. **2026-05-01 추가**: canary cap 50→200 / 0.2→0.3 SOL, partial take @ T1, Decu Phase B 통합.
- **2026-04-25 Mission Control Framework (control-plane policy)**: [`MISSION_CONTROL.md`](./MISSION_CONTROL.md) — survival/universe/payoff/execution/experiment/discipline 6 controls. mission-refinement 의 운영 항목화. 모든 변경의 4-layer reporting + adaptive change log 의무.
- **2026-04-23 Option 5 Adoption (현 active paradigm)**: [`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`](./docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md) — KOL Wallet = 1st-class Discovery, 자체 Execution 구조 유지 + Lane T 파라미터 재조정. Real Asset Guard 불변. Phase 2 shadow eval = go/no-go first filter.
- **대담 기록 (append-only)**: [`docs/debates/kol-discovery-debate-2026-04-23.md`](./docs/debates/kol-discovery-debate-2026-04-23.md)
- **현 active refactoring plan**: [`REFACTORING_v1.0.md`](./REFACTORING_v1.0.md) — Phase 0-5 checkbox
- **2026-04-21 Mission Refinement (historical refinement)**: [`docs/design-docs/mission-refinement-2026-04-21.md`](./docs/design-docs/mission-refinement-2026-04-21.md) — 100 SOL 은 tail outcome, 판단 KPI 아님. 원 성공 기준은 0.8 SOL floor + 200 trades + 5x+ winner 실측이며, 현재 운영 floor 는 2026-05-14 운영자 override 이후 0.6 SOL.
- **2026-04-18 Mission Pivot** (하위): [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md) — explainability → convexity. Cupsey는 benchmark로 유지(개조 금지), `pure_ws_breakout` 새 primary 후보.
- 아키텍처/의존성 방향: [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- 에이전트 규칙 + 문서 맵: [`AGENTS.md`](./AGENTS.md)
- mission / plan hierarchy: [`PLAN.md`](./PLAN.md)
- 현재 active backlog: [`docs/exec-plans/active/20260503_BACKLOG.md`](./docs/exec-plans/active/20260503_BACKLOG.md)
- **현재 운영 모드 (2026-04-21 refined)**: Stage 1 (Safety Pass). 판단 KPI 는 일/주 수익률 아님 — 4개 질문 (drift / survival pass rate / trade count / bleed per probe).
- **현재 binding constraint (2026-05-06)**: lane별 실거래/페이퍼 evidence 품질. smart-v3는 MAE fast-fail/recovery/pre-T1 giveback을 live+paper 동일하게 관측하고, rotation은 canonical live를 닫은 채 `rotation_chase_topup_v1`만 canary로 검증하며, pure_ws는 paper evidence 확보 전 live 승격 금지.
- **Ground truth**: wallet delta 만 유일한 판정 기준. DB pnl 단독 판정 금지 (drift `+18.34 SOL` 전력).
- **Success redefined (current operating)**: 0.6 SOL floor 유지 + 200 live trades + 5x+ winner 분포 실측 = 기술적 성공. 100 SOL 달성 여부 무관.
- **Trade-count 구간 의미 (2026-04-21)**: `50 trades` = safety checkpoint (관측 전용, 승격 결정 없음) / `100 trades` = preliminary edge/bleed/quickReject 검토 (Stage 2) / `200 trades` = scale/retire decision gate (Stage 4). 50 을 승격 기준으로 쓰지 말 것.
- **Real Asset Guard 정책값 (current)**: `wallet floor=0.6 SOL` / default ticket `0.01 SOL` / `kol_hunter=0.02 SOL` / max concurrent `3` / wallet drift halt `0.2 SOL` / canary budgets는 current operating profile과 env report를 따른다. smart-v3 MAE fast-fail/recovery knobs는 default-on이며 운영 env override 불필요. 운영 override profile은 `ops/env/production.env`가 기준이고, runtime secret `.env`는 Git 추적 금지.
- archive: [`PLAN_CMPL.md`](./PLAN_CMPL.md), [`docs/historical/pre-pivot-2026-04-18/`](./docs/historical/pre-pivot-2026-04-18/)
- 현재 전략 quick reference: [`STRATEGY.md`](./STRATEGY.md)
- 전략 방향/다음 가설: [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md)
- 기술 부채: [`docs/exec-plans/tech-debt-tracker.md`](./docs/exec-plans/tech-debt-tracker.md)
- 코딩 컨벤션: [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md)
- 보안 규칙: [`docs/SECURITY.md`](./docs/SECURITY.md)

## Document Roles
- 현재 동작의 기준 문서:
  - `AGENTS.md`
  - `ARCHITECTURE.md`
  - `PROJECT.md`
  - `PLAN.md`
  - `docs/exec-plans/active/20260503_BACKLOG.md`
  - `docs/exec-plans/active/1sol-to-100sol.md` (historical)
  - `OPERATIONS.md`
  - `STRATEGY.md`
  - `docs/product-specs/strategy-catalog.md`
  - `MEASUREMENT.md`
- forward memo:
  - `STRATEGY_NOTES.md`
- 워크플로 가이드:
  - `BACKTEST.md`
  - `REALTIME.md`
- historical note:
  - `PLAN_CMPL.md`
  - `docs/exec-plans/completed/*.md`
