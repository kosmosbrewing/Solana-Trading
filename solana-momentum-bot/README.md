# Solana Momentum Bot

> **Mission (2026-04-21 refined)**: `0.8 SOL floor + 200 live trades + 5x+ winner 실측` 이 성공 기준. 100 SOL 은 tail outcome (관찰 변수).
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

## Current Status (2026-04-27)

- **Active paradigm**: Option 5 — KOL Wallet Discovery + 자체 Execution ([ADR](./docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md))
- **Phase 진행도** ([`REFACTORING_v1.0.md`](./REFACTORING_v1.0.md)):
  - Phase 0-3 완료 (KOL DB v6 / tracker / shadow-eval / paper lane state machine)
  - Phase 3.5 / 3.6 완료 (smart-v3 main + swing-v2 shadow A/B / pure_ws swing-v2 paper+live canary 코드)
  - **Phase 4 코드 완료** (commit 1469a08, 2026-04-27): KOL `enterLivePosition` + `closeLivePosition` + Triple-flag gate
  - Phase 4 활성화 — **gate 부분 미충족**: paper 212 trade ✅ / 5x+ winner 0건 ❌
- **KOL paper 누적 (2026-04-23 ~ 04-27)**:
  - 212 trade / smart-v3 +4.79% / swing-v2 +7.31% / v1 fallback −0.65%
  - 누적 net **+0.0568 SOL** (paper)
  - **5x+ winner 0건** (가장 가까움 +186% net / +285% mfe)
- **Wallet baseline**: 시작 `1.3 SOL` → 현재 `1.07 SOL` (`-0.23 SOL`, paper 영향 0)
- **유일한 truth**: wallet delta. DB `pnl` drift `+18.34 SOL` 전력 있어 단독 판정 금지.
- **Lane / arm 상태**:
  - `cupsey_flip_10s` — benchmark **frozen** (env disabled)
  - `pure_ws_breakout` — Lane S baseline (live opt-in, 현재 `LIVE_CANARY_ENABLED=false`)
  - `pure_ws_swing_v2` — Lane S long-hold A/B (paper shadow / live canary 코드 완료, opt-in)
  - `kol_hunter` v1 / smart-v3 (main) / swing-v2 (shadow) — Lane T
    - **paper-only 강제 + live canary 코드 완료** (Triple-flag gate, opt-in)
  - `bootstrap_10s` — signal-only
  - `migration_reclaim` — signal-only
  - `volume_spike` / `fib_pullback` — dormant (5m 해상도 비적합)
  - ~~Strategy D / `new_lp_sniper`~~ — **2026-04-26 retire**

## Read Order

### Current Source Of Truth

| 문서 | 역할 |
|---|---|
| [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md) | **상위 권위** — pivot decision record |
| [`AGENTS.md`](./AGENTS.md) | 에이전트 규칙 + 문서 우선순위 |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 모듈 책임, 의존성 방향 |
| [`PLAN.md`](./PLAN.md) | mission charter (convexity) |
| [`PROJECT.md`](./PROJECT.md) | persona / goals / hard guardrails |
| [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md) | 현재 active execution plan (post-pivot) |
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
  cupsey_flip_10s (benchmark, STALK→PROBE→WINNER)
  pure_ws_breakout (candidate, immediate PROBE → tiered runner 2x/5x/10x)

Stage 4: Gate (loose factor-based)
  security hard reject → liquidity / quote sanity → exitability
  lane-specific factor gate (vol accel + buy ratio + tx density + price acceleration)

Stage 5: Guard (shared hard guardrails, 불변)
  Wallet Stop Guard < 0.8 SOL
  Wallet delta comparator (always-on drift halt)
  entryIntegrity per-lane halt
  canary auto-halt (consecutive losers / budget / max trades)
  canary global concurrency (opt-in, wallet-level max 3 ticket)
  close mutex (shared across lanes)

Stage 6: Execute
  ticket 0.01 SOL fixed, Jupiter executor, lane wallet mode 명시

Stage 7: Observe
  executed-buys/sells ledger (wallet-aware) + runtime diagnostics
  ops:canary:eval (cupsey vs pure_ws wallet-truth A/B + promotion verdict)
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

> Convexity mission, wallet delta 가 유일한 판정 기준, cupsey 는 건드리지 않는 benchmark, `pure_ws_breakout` 은 paper-first opt-in gate 로 분리, `pure_ws_swing_v2` / `kol_hunter` 는 swing 손익비 A/B 측정 (paper-first → opt-in live canary).
