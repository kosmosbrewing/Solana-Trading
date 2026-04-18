# Mission Pivot — Convexity Over Explainability

> Status: decision record
> Date: 2026-04-18
> Supersedes (as mission authority):
> - [`PLAN.md`](../../PLAN.md) (pre-pivot)
> - [`PROJECT.md`](../../PROJECT.md) (pre-pivot)
> - [`MEASUREMENT.md`](../../MEASUREMENT.md) (pre-pivot)
> - [`STRATEGY.md`](../../STRATEGY.md) (pre-pivot)
> Pre-pivot snapshots: [`docs/historical/pre-pivot-2026-04-18/`](../historical/pre-pivot-2026-04-18/)

## 1. Why This Pivot

### 1.1 Trigger

- 시작 wallet `1.30 SOL` → 현재 `1.07 SOL` (`-0.23 SOL`)
- 같은 기간 DB pnl 합계 `+18.11 SOL`
- **drift `+18.34 SOL` — DB pnl은 허수, wallet만 ground truth**
- 기존 사명 `설명 가능한 진입 + 보수적 gate + 반복 가능한 기대값`은 wallet 기준으로 **증명 실패**

### 1.2 Root-cause

현재 bottleneck 분석 ([top-down-mission-bottleneck-analysis-2026-04-18.md](./top-down-mission-bottleneck-analysis-2026-04-18.md)) 기준:

- L3: `STALK 15 → ENTRY 1` (6.7%) — 의도된 throughput 억제, 그러나 wallet 기준 미증명
- L4: WINNER_TIME_STOP 18/23, 최근 12h 4/5건 중 3건 손실 — "긴 runner"가 아니라 time-boxed drift
- "설명 가능성"을 위한 gate 복잡도가 throughput을 먹는데, 그 희생이 돈으로 돌아오지 않음

### 1.3 Decision

목표 함수를 바꾼다.

- **기존**: 설명 가능성 (explainability)
- **신규**: **convexity** — 1 SOL → 100 SOL 달성 확률 최대화

## 2. Mission Restated

### 2.1 New Mission

> 수단과 방법을 가리지 않고 `1 SOL -> 100 SOL` 달성 확률을 최대화한다.
> Wallet truth 기준 log 성장률과 5x+/10x+ winner 빈도로 성과를 측정한다.

### 2.2 전략 재정의

| 축 | 기존 | 신규 |
|---|---|---|
| 목표 함수 | explainability | convexity |
| 후보 선별 | attention / context | pool coverage + WS 초봉 signal |
| 진입 판단 | "왜 오르는가" | "지금 실제로 폭발하는가" |
| 진입 철학 | context → trigger 2-stage | 거래량 급증 + buy pressure + tx density + 최소 price acceleration |
| 보유 구조 | TP1/TP2/trailing | loser quick cut + winner long runner (tiered) |
| 평가 | Mission / Execution / Edge score | Wallet log growth + winner distribution + ruin probability |

### 2.3 유지 (절대 타협 없음)

- **Security hard reject** (top-holder %, mint authority, freeze authority, honeypot sim)
- **최소 liquidity / quote sanity**
- **Exitability 확인**
- **Duplicate / race 방지** (Patch A, Patch B1)
- **Wallet truth accounting** (executed-buys/sells.jsonl + wallet-reconcile + comparator)
- **실제 체결 / 실손익 기준 측정** (wallet delta)
- **HWM / price sanity bound** (Patch B2)

### 2.4 폐기 / 약화

- Attention / Context score (gate로서의 강제)
- 설명 없는 급등 금지 원칙
- 5분봉 확인형 전략 (`volume_spike`, `fib_pullback`)
- 복잡한 reject taxonomy
- `poor_execution_viability` 기본 reject 기준 (convexity와 맞지 않음)

## 3. Lane Map — Post-Pivot

| Tier | Lane | 역할 | 상태 (2026-04-18 말 기준) |
|---|---|---|---|
| Benchmark | `cupsey_flip_10s` | **절대 건드리지 않는** 기존 live baseline | conditional current primary |
| Candidate Primary | `pure_ws_breakout` | 사명에 맞춰 새로 설계한 lane | **implemented (Block 3), paper-first via `PUREWS_LIVE_CANARY_ENABLED` gate** |
| Signal Source | `bootstrap_10s` | signal-only 유지 | signal-only |
| Dormant | `volume_spike`, `fib_pullback` | historical only | dormant |
| Backlog | `Migration Handoff Reclaim` | 설계 완료, paper 대기 | backlog |
| Backlog | `Liquidity Shock Reclaim` | 미구현 | backlog |

핵심 규칙:

- **cupsey lane은 개조하지 않는다** — convexity benchmark이자 유일한 live-proven lane
- `pure_ws_breakout`은 cupsey handler 복사 금지, 별도 상태기계로 설계
- A/B 병렬 측정이 도입되기 전까지 `pure_ws_breakout`은 paper only

## 4. Hard Guardrails (사명 변경에도 불변)

| 가드 | 값 |
|---|---|
| Wallet Stop Guard | `< 0.8 SOL` 도달 시 모든 lane halt |
| RPC fail-safe | 연속 RPC 실패 시 entry halt (lane별) |
| Fixed ticket | `0.01 SOL` (동시 max 3 ticket, canary) |
| Entry integrity | `persistOpenTradeWithIntegrity` 모든 lane 필수 |
| Close mutex | `swapSerializer` 모든 lane 공유 |
| HWM sanity | `cupseyMaxPeakMultiplier = 15x` |
| Security hard reject | top-holder %, mint/freeze authority 불변 |

## 5. Measurement Rework

### 5.1 Retire

- `Mission Score` (explainability 중심)
- `Execution Score`의 RR / effective RR 기반 pass 판정
- `Composite Score`
- `Edge Score` 중 WR / PF / Sharpe (표본 희박 레짐에서 무의미)

### 5.2 Adopt

| KPI | 정의 | 기준 (canary) |
|---|---|---|
| Wallet log growth rate | `ln(wallet_sol / start_sol)` / days | `> 0` |
| 5x+ winner frequency | 5x 이상 close / 100 trades | 관측 후 baseline 설정 |
| 10x+ winner frequency | 10x 이상 close / 100 trades | 관측 후 baseline 설정 |
| Ruin probability | `wallet < 0.3 SOL` 도달 확률 (시뮬) | `< 5%` |
| Max consecutive loss streak | 연속 손실 trade 수 | 정보용, hard threshold 없음 |
| Max drawdown survivability | peak 대비 drawdown % × wallet | wallet ≥ 0.8 SOL 유지 |

### 5.3 Source of Truth

- 유일한 source: **wallet delta**
- DB `pnl` 합계는 `+18.34 SOL drift` 전력 있음 → **절대 단독 판단에 쓰지 않는다**
- 보조: `executed-buys.jsonl`, `executed-sells.jsonl`, FIFO reconcile

## 6. Execution Block Plan

```
Block 0  Mission Pivot 문서화                            ✅ done (2026-04-18)
Block 1  Wallet ownership + always-on comparator         ✅ done (2026-04-18)
Block 2  Coverage expansion (DEX alias + telemetry)      ✅ done (2026-04-18)
Block 3  pure_ws_breakout lane (paper-first code)         ✅ done (2026-04-18)
Block 4  Canary guardrails + A/B eval script             ✅ done (2026-04-18)
(ops)    Paper canary → live canary (50 trades 평가)       pending — operator opt-in
Block 5  Tiered runner tuning  — 조건부 (5x+ winner 관측 후)  pending
```

**50 trades 평가 vs `CANARY_MAX_TRADES=50` 정합**: canary evaluation trigger (ops:canary:eval PROMOTE 판정) 와 per-lane auto-halt budget 은 **같은 50** 을 기본값으로 둔다. 운영자가 필요 시 env 로 override.

## 7. Risks (사용자 이해 필수)

1. **Bleed risk**: 0.01 SOL × 동시 N ticket × 왕복비용 0.45%. Loser quick cut 미작동 시 wallet을 먹어치운다.
2. **Ruin risk**: 동시 N ticket × 최악 -100% = wallet 총손실 가능. Wallet Stop Guard `0.8 SOL`이 반드시 작동해야 한다.
3. **Runner 희소성**: 5x / 10x winner는 실제로 드물다. WINNER 승격 = 승리 아님.
4. **Sniper 경쟁**: pure WS early detection은 bot 대군과 경쟁. latency가 binding constraint.
5. **Pivot 자체의 미증명**: 이 pivot도 가설. 기존 경로의 실패가 pivot의 정답을 보장하지 않는다.

## 8. Document Authority (post-pivot)

| 문서 | 역할 |
|---|---|
| 이 문서 | pivot decision record — 상위 권위 |
| [`PLAN.md`](../../PLAN.md) | mission charter (convexity) |
| [`PROJECT.md`](../../PROJECT.md) | persona / goals (convexity) |
| [`MEASUREMENT.md`](../../MEASUREMENT.md) | wallet 기준 KPI |
| [`STRATEGY.md`](../../STRATEGY.md) | cupsey benchmark + pure_ws_breakout placeholder |
| [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md) | 현재 active execution truth |
| [`docs/historical/pre-pivot-2026-04-18/`](../historical/pre-pivot-2026-04-18/) | pre-pivot snapshot (참고용) |

## 9. One-Line Summary

> `설명 가능성 → convexity` pivot. wallet delta가 유일한 truth. cupsey는 benchmark로 건드리지 않고, `pure_ws_breakout`을 새 primary 후보로 paper부터 시작한다.
