# Solana Momentum Bot — Agent Instructions

## 🚀 새 세션 진입 순서 (이 순서로 읽으세요)

새 AI/사람 세션이 별도 지시 없이도 paradigm 을 자동 파악할 수 있도록 **이 순서로** 문서를 읽으세요.
필수 2건만 읽으면 (2-3분) 코드 변경 가능. 나머지는 필요 시.

### Stage 0-2 — 필수 (2-3분)
1. **[`MISSION_CONTROL.md`](./MISSION_CONTROL.md)** — 6 control framework (survival/universe/payoff/execution/experiment/discipline)
2. **[`docs/INCIDENT_SUMMARY.md`](./docs/INCIDENT_SUMMARY.md)** — 반복 패턴 교훈 + 최근 30일 인시던트 (왜 이 상태인가)

### 필요 시 참조 (2026-07-05 필수 목록에서 강등 — 내용은 여전히 유효)
- [`SESSION_START.md`](./SESSION_START.md) — 1 페이지 hand-off. 1줄 신뢰 명령 / Lane 표 / Real Asset Guard / 금지 사항.
- [`REFACTORING_v1.0.md`](./REFACTORING_v1.0.md) — Option 5 Phase 0-5 진행 상태 (어디까지 왔나)
- [`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`](./docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md) — 현 active paradigm
- [`docs/design-docs/mission-refinement-2026-04-21.md`](./docs/design-docs/mission-refinement-2026-04-21.md) — 원 사명 정의 (historical 0.8 SOL; 현재 운영 floor 는 `SESSION_START.md`의 0.6 SOL)
- [`INCIDENT.md`](./INCIDENT.md) — append-only 전체 연표 (요약은 `docs/INCIDENT_SUMMARY.md`)

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
- **⚠ 2026-07-08 기로 점검 (폐기 vs 재개) — 운영자 결정 대기**: [`20260708.md`](./20260708.md) — 엔지니어링 저력 증명 / edge 저력 미증명 (가설 7전 7패 + 구조 벽 3개). 마지막 $0 게이트 = **H-007a** (token-quality flags ⋈ markout forward, `HYPOTHESES.md`). 그 결과가 폐기/재개를 가른다. 결정 기록란은 문서 §8.
- **운영 로그 / 거래 분석 표준 (2026-05-05)**: [`AGENTS.md`](./AGENTS.md)의 "운영 로그 / 거래 분석 표준" 섹션 참조 (원본 — sync 절차 / DB dump opt-in / kol-transfers.jsonl 캐시 규칙 / 판정 산출물 순서 / 표준 판정 축 / `OK · WATCH · PAUSE_REVIEW · INVESTIGATE` 결론 규칙 전부 그쪽이 기준).
- **2026-06-10 Mission Refinement v2 (생존 우선 재정의)**: [`docs/design-docs/mission-refinement-v2-2026-06-10.md`](./docs/design-docs/mission-refinement-v2-2026-06-10.md) — 운영자 선언 채택. "1→100 빠르게" 명시 폐기, 목표 = 손실 통제 / 데이터 축적 / 소액 실전 검증 / 반복 가능한 승리 조건. 예산 hard constraint: Helius ≤$50/월, VPS $8/월, **예비금 $1,000 동결** (OFFLINE_COHORT_FOUND 전 투입 금지). 저빈도 × ex-ante 필터 × (검증 후) ticket 상향 = 실측 사망 원인 (고정비 13.5%@0.02) 직접 제거. 신규 lane 설계 초안: [`survivor-momentum-lane-design-2026-06-10.md`](./docs/design-docs/survivor-momentum-lane-design-2026-06-10.md) (DRAFT, Phase 0 offline 검증 전 코드 구현 금지). Gate/guard/floor 전부 불변.
- **2026-06-10 KOL Candle Coverage Repair ADR**: [`docs/design-docs/kol-candle-coverage-repair-2026-06-10.md`](./docs/design-docs/kol-candle-coverage-repair-2026-06-10.md) — Lever 1 (KolTx poolAddress 추출 → `kol_tx_pool` 직행 구독, WS 지원 프로그램 gate) 구현 완료. Lever 2 (pump.fun bonding curve WS parser) 보류 + trigger 3개 명시. 차기 신호 가설 검증 인프라 (observe-only, live 판단 영향 0).
- **2026-06-10 Edge Audit 최종 판정 `RETIRE_CURRENT_LIVE`**: [`analysis/edge-audit-2026-06-10/EDGE_AUDIT_REPORT.md`](./analysis/edge-audit-2026-06-10/EDGE_AUDIT_REPORT.md) — live wallet-truth 음수 확정 (475 closes / −1.128 SOL, P(net>0)=0.0000), 승격 통과 cohort 0. 신호 수명 ~60s × 왕복 고정비 13.6% × 5x tail 92% exit-후-발생 의 3중 자기모순. KOL-follow live (smart-v3/rotation/broad canary) archive, bot 정지 유지, 차기 신호 연구는 offline-only (kill criteria 는 report §7). 측정 부채 수리: offline-sim positionId dedup / token-only sanity clamp / jest ledger 오염 차단 + `ops:quarantine:synthetic-markouts` / candle 구독 TTL 15min + funnel telemetry (observe-only). 감사 prompt: [`docs/exec-plans/active/solone-edge-audit-prompt-2026-06-10.md`](./docs/exec-plans/active/solone-edge-audit-prompt-2026-06-10.md).
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
