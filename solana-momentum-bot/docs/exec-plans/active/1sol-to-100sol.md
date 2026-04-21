# Execution Plan: Positive-Optionality Engine (post-pivot, refined 2026-04-21)

> Status: current active execution plan
> Updated: 2026-04-21 (Mission Refinement — 100 SOL 은 tail outcome)
> Scope: Stage 1-4 maturity gate 진행 + Survival Layer P0 구현
> **Authority chain**: [`mission-refinement-2026-04-21.md`](../../design-docs/mission-refinement-2026-04-21.md) (최상위) → [`mission-pivot-2026-04-18.md`](../../design-docs/mission-pivot-2026-04-18.md) → [`PLAN.md`](../../../PLAN.md)
> Pre-pivot snapshot: [`docs/historical/pre-pivot-2026-04-18/`](../../historical/pre-pivot-2026-04-18/) 내 PLAN/PROJECT/MEASUREMENT/STRATEGY + git history
> Archive: 완료된 Block 별 설계 문서와 QA 는 [`docs/design-docs/`](../../design-docs/), 메모리는 `project_block{0-4}_*`.

## Role

이 문서는 **post-pivot 운영 authority** 다.

- Block 0-4 + DEX_TRADE Phase 1-3 + 2026-04-19~21 refinement 구현 완료 이후 wallet-verified **Stage 진행**이 어떻게 일어나는지 정리한다
- mission / KPI 자체는 [`PLAN.md`](../../../PLAN.md) + [`MEASUREMENT.md`](../../../MEASUREMENT.md) 참조
- 전략 / gate / lane 세부는 [`STRATEGY.md`](../../../STRATEGY.md) 참조
- 본 문서는 "**지금 남은 Stage 통과 단계**" 만 정리

## Baseline (Ground Truth)

- 미션 (2026-04-21 refined): **Positive-optionality engine** — 100 SOL 은 tail outcome 으로 관찰, 판단 KPI 아님
- 성공 기준: 0.8 SOL floor 유지 + 200 live trades + 5x+ winner 분포 실측
- 실제 wallet baseline (2026-04-17 실측): 시작 `1.3 SOL` → 현재 `1.07 SOL` (`−17.7%`)
- **wallet delta 만이 유일한 ground truth**. DB `pnl` 은 drift `+18.34 SOL` 전력 있어 단독 판정 금지.
- 평가 지표: [`MEASUREMENT.md`](../../../MEASUREMENT.md) 의 **4단계 Stage gate** + wallet log growth + winner distribution + ruin probability.

## Block 0-4 구현 완료 요약 (2026-04-18)

| Block | 결과 | 핵심 산출물 |
|---|---|---|
| Block 0 | Mission pivot 문서화 | `mission-pivot-2026-04-18.md` + PLAN/PROJECT/MEASUREMENT/STRATEGY 재작성 |
| Block 1 | Wallet ownership + always-on comparator | `CUPSEY/MIGRATION/PUREWS_WALLET_MODE` + `src/risk/walletDeltaComparator.ts` (wallet-aware) + startup fail-fast |
| Block 2 | Coverage expansion | DEX ID alias normalization + `admission-skips-dex.jsonl` telemetry |
| Block 3 | pure_ws_breakout lane (paper-first) | `src/orchestration/pureWsBreakoutHandler.ts` + `PUREWS_LIVE_CANARY_ENABLED` gate |
| Block 4 | Canary guardrails + A/B eval | `src/risk/canaryAutoHalt.ts` + `src/risk/canaryConcurrencyGuard.ts` + `scripts/canary-eval.ts` (wallet-truth metrics 포함) |

## 현재 남은 운영 단계

### Phase O1 — Paper 관측 (pending operator action)

전제: VPS 배포 + paper 모드 진입

```env
TRADING_MODE=paper
PUREWS_LANE_ENABLED=true
CUPSEY_LANE_ENABLED=true         # benchmark 유지
PUREWS_WALLET_MODE=main           # 명시 (auto 대신)
CUPSEY_WALLET_MODE=main           # 명시 (auto 대신)
WALLET_DELTA_COMPARATOR_ENABLED=true
WALLET_PUBLIC_KEY=<live wallet pubkey>  # wallet-reconcile 도구용
```

Exit criteria:
- ≥ 20 paper trade 수집 (cupsey + pure_ws 합산 또는 각각)
- `npm run ops:canary:eval` 실행 → dashboard 확인
- auto-halt 무사고 (consecutive losers / budget / max trades)
- wallet delta comparator 로그 주기 작동 확인 (baseline 캡처 + 5분 poll)

### Phase O2 — Live Canary (조건부 opt-in)

전제: Phase O1 통과 + 운영자 판단

```env
TRADING_MODE=live
PUREWS_LIVE_CANARY_ENABLED=true           # Block 3 paper-first gate 해제
CANARY_GLOBAL_CONCURRENCY_ENABLED=true    # 전역 동시 3 ticket 강제
CANARY_GLOBAL_MAX_CONCURRENT=3
CANARY_MAX_TRADES=200                     # Stage 4 scale/retire decision gate 에서 halt
CANARY_MAX_BUDGET_SOL=0.3                 # Real Asset Guard — cumulative loss cap
WALLET_STOP_MIN_SOL=0.8                   # Real Asset Guard — wallet floor
```

Hard guardrails (Real Asset Guard, 불변):
- Wallet Stop Guard `< 0.8 SOL` → 전 lane entry halt
- Canary cumulative loss cap `-0.3 SOL` → 해당 lane halt
- Wallet delta comparator drift ≥ 0.20 SOL → 전 lane halt
- Security hard reject (top-holder %, mint/freeze authority, honeypot)
- Ticket 0.01 SOL fixed, max concurrent 3 (전역)

### Phase O3 — 50-trade safety checkpoint (관측 전용)

Trigger: live canary 운영 중 50 trades 누적 (halt 발생하지 않음)

**판정 없음**. 다음 항목을 로그/reconcile 로만 점검하고 운영을 계속한다:

- Bleed per probe 추이 (비용 구조 개선 중인가)
- Quick-reject classifier 실제 동작 여부 (`[PUREWS_LOSER_HARDCUT]` / `[PUREWS_LOSER_TIMEOUT]` 분포)
- halt 빈도 (observability guard 튜닝 필요한지)
- wallet reconcile drift 이상 여부

여기서 "promote / demote" 판정을 절대 내리지 않는다. 이슈가 있으면 **Observability Guard 완화** 검토 (Real Asset Guard 는 건드리지 않음).

### Phase O4 — 100-trade preliminary check (Stage 2)

Trigger: 100 live trades 누적

```bash
npm run ops:canary:eval -- --since <canary-start-ISO> --md reports/canary-pureWs-100t-<date>.md --stage preliminary
```

점검 포인트:
- Live friction (paper vs live pnl gap) 분포 기록
- Max DD `< 30%` 확인
- Wallet stop halt 0회 확인
- 5x+ winner 조짐 유무 관찰 (Stage 3 통과 여부 판단 근거)

여전히 최종 판정은 아님. 결과가 심각하면 paper 회귀 검토.

### Phase O5 — 200-trade scale/retire decision gate (Stage 4)

Trigger: 200 live trades 누적 + Stage 3 통과 (5x+ winner >= 1건 실측)

```bash
npm run ops:canary:eval -- --since <canary-start-ISO> --md reports/canary-pureWs-200t-<date>.md --stage scale
```

최종 판정 기준:
- `SCALE`: 200+ trades + wallet log growth > 0 + netSol > benchmark + 5x+ winner >= 1 + ruin probability < 5% + maxConsecutiveLosers < 10
- `RETIRE`: netSol ≤ 0 OR ruin probability >= 10% OR 5x+ winner = 0 이고 bleed 누적 크기가 포지티브 기대값 가정 붕괴
- `HOLD`: 부분 만족 (다음 canary 윈도 추가 관측)

`SCALE` → primary 승격 후보로 Block 6 (Tiered Runner Tuning) 고려.
`RETIRE` → paper 회귀 + threshold / tier 재튜닝 또는 lane 폐기.
`HOLD` → canary 재개 (auto-halt reset + 관찰 기간 연장).

### Phase O6 — (조건부) Block 6 Tiered Runner Tuning

- Stage 4 에서 `SCALE` 결정된 경우에만 의미
- trailing % 조정, T2 lock 조정, T3 hold 확장 등
- 별도 design-doc + QA 필요

## 비목표 (이 문서에서 다루지 않음)

- attention / context / old gate chain 재도입
- 5m 확인형 전략 재활성화 (`volume_spike`, `fib_pullback` 은 dormant 유지)
- cupsey 파라미터 / 구조 개조 (benchmark 로 유지)
- DB pnl 기반 단독 판정
- Composite Score / Mission Score / Execution Score 재도입

## 의사결정 규칙

### Do

- wallet delta 기준 판정
- canary phase gate 는 operator 가 수동 승격
- 새 lane 은 paper-first → canary → A/B 평가 순서
- QA findings 는 Block_QA.md 에서 추적

### Do Not

- explainability 중심 판정
- 자동 primary 승격 (수동 필수)
- hard guardrail 완화 (Wallet Stop Guard / RPC fail-safe / security / entry integrity / close mutex / HWM 15x)
- cupsey handler 개조

## One-Line Summary

> Block 0-4 + DEX_TRADE Phase 1-3 + post-deploy fixes 코드 완료.
> 운영 단계: Stage 1 Safety Pass → 50-trade safety checkpoint (관측) → Stage 2 100-trade preliminary check → Stage 3 winner distribution → Stage 4 200-trade scale/retire decision.
> 50 trades 는 승격 gate 가 아니라 관측용 체크포인트 (2026-04-21 refinement).
