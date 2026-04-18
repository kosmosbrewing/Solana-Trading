# Design Docs 카탈로그

> Updated: 2026-04-18 (post-pivot)
> Authority: [`mission-pivot-2026-04-18.md`](./mission-pivot-2026-04-18.md) 최상위

## Post-Pivot Authority (2026-04-18)

| 문서 | 경로 | 상태 | 최종 검증 |
|---|---|---|---|
| **Mission Pivot — Convexity Over Explainability** | `mission-pivot-2026-04-18.md` | ✅ 상위 권위 | 2026-04-18 |
| Top-Down Mission Bottleneck Analysis | `top-down-mission-bottleneck-analysis-2026-04-18.md` | ✅ 분석 프레임 (pivot 근거) | 2026-04-18 |
| Pure WS Breakout Lane | `pure-ws-breakout-lane-2026-04-18.md` | ✅ 구현 완료 (Block 3, paper-first gate) | 2026-04-18 |

## Pre-Pivot (historical — 현재 판정 근거로 사용 금지)

이 아래 문서들은 2026-04-18 pivot 이전 설계 결정이다. `mission-pivot-2026-04-18.md` 와 충돌하면 **pivot 문서가 우선** 한다.

| 문서 | 경로 | 상태 | 최종 검증 |
|---|---|---|---|
| 핵심 운영 원칙 | `core-beliefs.md` | 🕰 pre-pivot | 2026-03-18 |
| 레이어 규칙 | `layer-rules.md` | 🕰 pre-pivot | 2026-03-18 |
| 2-Stage Entry 모델 | `2-stage-entry.md` | 🕰 pre-pivot (context→trigger 사고 기반) | 2026-03-18 |
| Risk Tier 시스템 | `risk-tier-system.md` | 🕰 pre-pivot (composite score 의존) | 2026-03-18 |
| Helius Data Plane Transition | `helius-data-plane-transition.md` | 🕰 제안 (pre-pivot) | 2026-03-31 |
| Buy/Entry 전체 흐름 상세 | `buy-entry-flow.md` | 🕰 pre-pivot | 2026-04-05 |
| Session Replay Parameter Sweep | `session-replay-parameter-sweep.md` | 🕰 pre-pivot edge 분석 | 2026-04-05 |

## Current Gate Chain (post-pivot)

post-pivot gate 체인은 아래와 같다. attention / context 는 hard reject 로 쓰지 않는다.

```
Stage 1 Security (hard)            — honeypot, freeze, mint authority, top-holder %
Stage 2 Liquidity / Quote Sanity    — Jupiter quote, TVL, spread
Stage 3 Exitability                 — sell-side impact probe
Stage 4 Lane-specific factor gate
          cupsey: cupseyGate (vol + price + buy ratio + trade count, 고정)
          pure_ws_breakout: loose factor set (cupsey gate factor 재사용, threshold 완화)
          bootstrap: vol + buyRatio (signal-only)
Stage 5 Integrity                    — persistOpenTradeWithIntegrity (lane별 halt)
Stage 6 Canary                       — auto-halt (loss streak / budget / max trades)
                                       + global concurrency (opt-in, wallet-level 3 ticket)
Exit    close mutex (swapSerializer), sell-side impact
```

## Migration Notes

- Pre-pivot `AttentionScore -> Execution Viability -> Strategy Score` 3-stage gate chain 은 **retired**. attention 은 signal context 용 참고값으로만 남아 있음.
- `Composite Score` / `Mission Score` / `Execution Score` KPI 는 [`MEASUREMENT.md`](../../MEASUREMENT.md) 에서 wallet log growth + winner distribution + ruin probability 로 교체.
- Pre-pivot 문서 내부 링크가 mission / measurement / strategy 를 가리킨다면, 현재 판정은 [`mission-pivot-2026-04-18.md`](./mission-pivot-2026-04-18.md) 기반으로 읽는다.
