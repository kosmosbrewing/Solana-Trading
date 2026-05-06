# Solana Momentum Bot

> **Mission (current operating)**: `0.7 SOL floor + 200 live trades + 5x+ winner 실측` 이 성공 기준. 100 SOL 은 tail outcome (관찰 변수).
> **Active paradigm (2026-04-23)**: **Option 5 — KOL Wallet Discovery + 자체 Execution**.

Solana DEX 순수 실전형 momentum / sniper 봇이다.

---

## 🚀 새로 합류하셨나요? — 5분 paradigm 파악

> 새 AI 세션은 [`CLAUDE.md`](./CLAUDE.md) 또는 [`AGENTS.md`](./AGENTS.md) 의 진입 순서를 자동으로 따라갑니다.
> 사람 세션도 **이 순서로** 읽으면 코드 변경 가능 상태에 도달.

1. **[`SESSION_START.md`](./SESSION_START.md)** — 1 페이지 hand-off (Lane 표 + Real Asset Guard + 1줄 신뢰 명령)
2. **[`MISSION_CONTROL.md`](./MISSION_CONTROL.md)** — 6 control framework
3. **[`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`](./docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md)** — 현 active paradigm
4. **[`REFACTORING_v1.0.md`](./REFACTORING_v1.0.md)** — Phase 진행 상태
5. **[`INCIDENT.md`](./INCIDENT.md)** — 최근 결정 연표

빠른 검증 명령: `npm run check:fast` (typecheck + jest + env drift)

---

## Paradigm 진화

| 시기 | Paradigm | 문서 |
|------|---------|------|
| Pre-2026-04-18 | Context → Trigger → old gate chain | [`docs/historical/pre-pivot-2026-04-18/`](./docs/historical/pre-pivot-2026-04-18/) |
| 2026-04-18 | Mission pivot — explainability → convexity | [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md) |
| 2026-04-21 | Mission refinement — 100 SOL = tail outcome, 5x+ winner 실측 = 성공 | [`docs/design-docs/mission-refinement-2026-04-21.md`](./docs/design-docs/mission-refinement-2026-04-21.md) |
| **2026-04-23 (현재)** | **Option 5 — KOL Discovery + 자체 Execution** | [`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`](./docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md) |

## Current Status (2026-05-06)

- **Active paradigm**: Option 5 — KOL Wallet Discovery + 자체 Execution ([ADR](./docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md)).
- **Current operating floor**: 0.7 SOL. Historical 0.8 SOL mission-refinement 문서는 원 사명 정의로만 읽고, 운영 판단은 `SESSION_START.md` / `MISSION_CONTROL.md` / `STRATEGY.md`를 따른다.
- **Lane 상태**:
  - `kol_hunter_smart_v3` — main 5x lane. live canary + paper arms, 2+ fresh active KOL 중심, dev quality는 보조신호, MAE fast-fail / bounded recovery-hold / pre-T1 giveback telemetry 적용.
  - `kol_hunter_rotation_v1` — fast-compound 보조 lane. canonical rotation live는 닫고, 검증된 `rotation_chase_topup_v1`만 별도 live canary 키로 열 수 있다. S/A 1-KOL better-entry, chase/top-up arm, partialized sell-follow, T+ evidence를 본다.
  - `pure_ws` botflow — new-pair paper/observer candidate. Mayhem copy가 아니라 new-pair 기준 관측 lane이며, live 승격은 evidence 확보 전 금지.
  - `cupsey_flip_10s` — frozen benchmark, disabled.
- **운영 분석 표준**: 먼저 `bash scripts/sync-vps-data.sh`로 `data/`, `logs/`, `reports/`를 동기화한다. DB dump는 opt-in. 결론은 lane별 `OK / WATCH / PAUSE_REVIEW / INVESTIGATE`로 끝낸다.
- **운영 env 표준**: `.env`는 Git 추적 금지. Git으로 동기화할 수 있는 값은 secret 없는 [`ops/env/production.env`](./ops/env/production.env)에 둔다. `scripts/deploy.sh`가 배포 중 해당 profile을 원격 `.env`에 병합한다.
- **유일한 truth**: wallet delta. DB `pnl` drift 전력이 있어 단독 판정 금지.

## Read Order

### Current Source Of Truth

| 문서 | 역할 |
|---|---|
| [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md) | **상위 권위** — pivot decision record |
| [`AGENTS.md`](./AGENTS.md) | 에이전트 규칙 + 문서 우선순위 |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 모듈 책임, 의존성 방향 |
| [`PLAN.md`](./PLAN.md) | mission charter (convexity) |
| [`PROJECT.md`](./PROJECT.md) | persona / goals / hard guardrails |
| [`docs/exec-plans/active/20260503_BACKLOG.md`](./docs/exec-plans/active/20260503_BACKLOG.md) | 현재 active backlog |
| [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md) | historical post-pivot execution plan |
| [`STRATEGY.md`](./STRATEGY.md) | runtime quick reference (lane / gate / guardrail) |
| [`OPERATIONS.md`](./OPERATIONS.md) | 운영 절차 + Block 1-4 runbook |
| [`MEASUREMENT.md`](./MEASUREMENT.md) | wallet log growth + winner 분포 + ruin probability |

### Workflow Guides

| 문서 | 역할 |
|---|---|
| [`BACKTEST.md`](./BACKTEST.md) | backtest 워크플로 |
| [`REALTIME.md`](./REALTIME.md) | realtime shadow / replay 워크플로 |
| [`SETUP.md`](./SETUP.md) | VPS / DB / env 초기 셋업 |

### Design Docs / QA

| 문서 | 역할 |
|---|---|
| [`docs/design-docs/`](./docs/design-docs/) | post-pivot 설계 decision records (block별) |
| [`docs/historical/pre-pivot-2026-04-18/Block_QA.md`](./docs/historical/pre-pivot-2026-04-18/Block_QA.md) | Block 0-4 QA findings + closure 기록 (pre-pivot archive) |

### Historical

| 문서 | 역할 |
|---|---|
| [`docs/historical/pre-pivot-2026-04-18/`](./docs/historical/pre-pivot-2026-04-18/) | pre-pivot PLAN/PROJECT/MEASUREMENT/STRATEGY snapshot (현재 판정 근거 사용 금지) |
| [`PLAN_CMPL.md`](./PLAN_CMPL.md) | 완료된 plan / canary history archive |
| [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md) | forward memo / 다음 가설 |

## Runtime Shape (post-pivot)

```text
Stage 1: Discovery
  scanner / DEX alias normalize / pair resolver / admission telemetry

Stage 2: Signal
  bootstrap_10s trigger (signal-only)

Stage 3: Lane (parallel A/B)
  kol_hunter_smart_v3 (main 5x lane, live canary + paper arms)
  kol_hunter_rotation_v1 (fast-compound aux lane, canonical live off; chase-topup arm canary only)
  pure_ws botflow (new-pair paper/observer candidate)
  cupsey_flip_10s (frozen benchmark, disabled)

Stage 4: Gate (loose factor-based)
  security hard reject → liquidity / quote sanity → exitability
  lane-specific factor gate (vol accel + buy ratio + tx density + price acceleration)

Stage 5: Guard (shared hard guardrails, 불변)
  Wallet Stop Guard < 0.7 SOL
  Wallet delta comparator (always-on drift halt)
  entryIntegrity per-lane halt
  canary auto-halt (consecutive losers / budget / max trades)
  canary global concurrency (opt-in, wallet-level max 3 ticket)
  close mutex (shared across lanes)

Stage 6: Execute
  default ticket 0.01 SOL / KOL ticket 0.02 SOL, Jupiter executor, lane wallet mode 명시

Stage 7: Observe
  executed-buys/sells ledger (wallet-aware) + runtime diagnostics
  sync-health / kol-live-canary / smart-v3-evidence / trade-markout / lane reports
  ops:reconcile:wallet (FIFO RPC 감사)
```

## Main Commands

```bash
npm run build
npm test
npm run dev                        # local run
npm run deploy:vps                 # VPS 배포 (pm2 + monitoring)

# Operations
npm run ops:reconcile:wallet       # FIFO wallet ↔ ledger/DB 대조
npm run ops:canary:eval            # cupsey vs pure_ws 50-trade A/B + promotion verdict
npm run ops:check                  # realtime runtime diagnostics
npm run ops:check:sparse           # admission / discovery funnel

# Backtest
npm run backtest
npm run realtime-shadow
npm run paper-report
```

## One-Line Summary

> Convexity mission, wallet delta 가 유일한 판정 기준, smart-v3 는 main 5x lane, rotation-v1 은 fast-compound 보조 lane, pure_ws 는 new-pair paper/observer 후보, cupsey 는 frozen benchmark.
