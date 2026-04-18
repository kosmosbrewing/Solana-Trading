# Execution Plan: 1 SOL → 100 SOL (post-pivot)

> Status: current active execution plan
> Updated: 2026-04-18 (Mission Pivot → convexity, Block 0-4 code 완료)
> Scope: Block 0-4 완료 이후 운영 단계 — paper 관측 → live canary → 50-trade 평가 → primary 승격 판단
> Authority: [`mission-pivot-2026-04-18.md`](../../design-docs/mission-pivot-2026-04-18.md) (상위 결정), [`PLAN.md`](../../../PLAN.md) (mission charter)
> Pre-pivot snapshot: [`docs/historical/pre-pivot-2026-04-18/`](../../historical/pre-pivot-2026-04-18/) 내 PLAN/PROJECT/MEASUREMENT/STRATEGY + git history
> Archive: 완료된 Block 별 설계 문서와 QA 는 [`docs/design-docs/`](../../design-docs/), 메모리는 `project_block{0-4}_*`.

## Role

이 문서는 **post-pivot 운영 authority** 다.

- Block 0-4 구현 완료 이후 wallet-verified mission 진전이 어떻게 일어나는지 정리한다
- mission / KPI 자체는 [`PLAN.md`](../../../PLAN.md) + [`MEASUREMENT.md`](../../../MEASUREMENT.md) 참조
- 전략 / gate / lane 세부는 [`STRATEGY.md`](../../../STRATEGY.md) 참조
- 본 문서는 "**지금 남은 운영 단계**" 만 정리

## Baseline (Ground Truth)

- 미션: wallet 1 SOL → 100 SOL (convexity-first, 2026-04-18 pivot)
- 실제 wallet baseline (2026-04-17 실측): 시작 `1.3 SOL` → 현재 `1.07 SOL` (`−17.7%`)
- **wallet delta 만이 유일한 ground truth**. DB `pnl` 은 drift `+18.34 SOL` 전력 있어 단독 판정 금지.
- 평가 지표는 [`MEASUREMENT.md`](../../../MEASUREMENT.md) 의 wallet log growth + winner distribution + ruin probability.

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
PUREWS_LIVE_CANARY_ENABLED=true   # Block 3 paper-first gate 해제
CANARY_GLOBAL_CONCURRENCY_ENABLED=true  # 전역 동시 3 ticket 강제
CANARY_GLOBAL_MAX_CONCURRENT=3
CANARY_MAX_TRADES=50              # 50 trade 도달 시 halt → 평가
WALLET_STOP_MIN_SOL=0.8
```

Hard guardrails (불변):
- Wallet Stop Guard `< 0.8 SOL` → 전 lane entry halt
- Wallet delta comparator drift ≥ 0.20 SOL → 전 lane halt
- Security hard reject (top-holder %, mint/freeze authority, honeypot)
- Ticket 0.01 SOL fixed, max concurrent 3 (전역)

### Phase O3 — 50-trade 평가 + 승격 판정

Trigger: auto-halt `canary trade count reached 50` 발동 (pure_ws_breakout)

```bash
npm run ops:canary:eval -- --since <canary-start-ISO> --md reports/canary-pureWs-<date>.md
```

판정 기준 (스크립트 자동 출력):
- `PROMOTE`: candidate ≥ 50 trades + wallet log growth > 0 + netSol > benchmark + 5x+ winner ≥ 1 + maxConsecutiveLosers < 10
- `DEMOTE`: netSol ≤ 0 OR maxConsecutiveLosers ≥ 10
- `CONTINUE`: 부분 만족 (더 많은 표본 필요)

`PROMOTE` → primary 승격 후보로 Block 5 고려.
`DEMOTE` → paper 회귀 + threshold / tier 재튜닝.
`CONTINUE` → canary 재개 (auto-halt reset + budget 확대 검토).

### Phase O4 — (조건부) Block 5 Tiered Runner Tuning

- 실제 5x+ winner 관측 후에만 의미
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

> Block 0-4 code 완료. 남은 것은 paper 관측 → live canary opt-in → 50-trade 평가 → wallet-truth 기반 primary 승격 판정.
