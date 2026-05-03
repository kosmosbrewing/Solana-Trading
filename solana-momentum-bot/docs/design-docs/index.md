# Design Docs 카탈로그

> Updated: 2026-05-03 (post-pivot)
> Authority: [`mission-pivot-2026-04-18.md`](./mission-pivot-2026-04-18.md) 최상위

## Post-Pivot Authority (2026-04-18)

| 문서 | 경로 | 상태 | 최종 검증 |
|---|---|---|---|
| **Mission Pivot — Convexity Over Explainability** | `mission-pivot-2026-04-18.md` | ✅ 상위 권위 | 2026-04-18 |
| Top-Down Mission Bottleneck Analysis | `top-down-mission-bottleneck-analysis-2026-04-18.md` | ✅ 분석 프레임 (pivot 근거) | 2026-04-18 |
| Pure WS Breakout Lane | `pure-ws-breakout-lane-2026-04-18.md` | ✅ 구현 완료 (Block 3, paper-first gate) | 2026-04-18 |
| Pure WS Breakout V2 — Detector Math Spec | `pure-ws-breakout-v2-detector-2026-04-18.md` | ✅ Phase 1.1-1.3 완료 (pure function + scanner + handler wiring) | 2026-04-18 |
| Lane Edge Controller — Conservative Kelly / Payoff Control | `lane-edge-controller-kelly-2026-04-25.md` | 🟡 제안 — Kelly를 sizing이 아닌 lane/cohort throttle로 사용 | 2026-04-25 |
| External Strategy Report Analysis (Tier 1 + #5) | `external-strategy-report-analysis-2026-04-29.md` | ✅ Tier 1 + #5 구현 완료 (DSR/CSCV + style classifier + missed-alpha retro + co-buy graph) | 2026-04-29 |
| **KOL Academic Report Integration ADR** | `kol-academic-report-integration-2026-04-30.md` | ✅ Sprint 1 + Sprint 2.A1 완료 / Phase 3-4 보류 (트리거 조건 명시) | 2026-04-30 |
| Decu New-Pair Quality Layer | `decu-new-pair-quality-layer-2026-05-01.md` | ✅ Phase A + B (observe-only 골격) 완료 — 5 module + report + dev DB + 67 tests. Enrichment 는 B.1.5 follow-up | 2026-05-01 |
| **Research Ledger Unification** | `research-ledger-unification-2026-05-01.md` | 🟡 인프라 완성 / S3 보류 — S1+S2+S2.5 ADR + types + validator + writer + quarantine + 85 test 완료 (jest 1481). **S3 dual-write wiring 보류** — 옛 12 ledger 1차 측정 후 재평가. 재개 trigger + 결정 항목 3개 §13 명시 | 2026-05-01 |
| **Helius Credit-to-Edge Plan** | `../exec-plans/active/helius-credit-edge-plan-2026-05-01.md` | 🟡 Phase 0-4 인프라 완성 / Stream D-G runtime wiring 일부 미완 — Stream A (credit catalog + ledger), B (token quality 7 flag), C (KolTx slot/parseSource) 완료. Stream D/E/F/G helper + tests 완료, runtime wiring partially 진행 (markout `--rpc-url` opt-in, registry inject). Codex P2 4건 follow-up 명시 (close anchor schema / rejectedAt parser / signature pagination / lookup-table). 정책 결정 evidence 보강 필요 | 2026-05-01 |
| **Helius Phase 4 Policy Candidates Template** | `../exec-plans/active/helius-phase4-policy-candidates-template.md` | 🟡 template — 7-day data 도달 후 채울 4-track 정책 ADR placeholder. Track 1 (token quality hard gate) + Track 2 (pool prewarm) 즉시 / Track 3 (KOL role 자동화) 200-trade gate 까지 대기 / Track 4 (priority fee canary) S3 trigger 정합 | 2026-05-01 |
| **Pure WS Bot-Flow Rebuild** | `pure-ws-botflow-rebuild-2026-05-02.md` | 🟡 Phase 2 sidecar paper simulator 구현 — legacy pure_ws breakout 를 new-pair bot-flow microstructure lane 으로 재정의. `purews:botflow-paper` 로 fee-payer bot-flow 후보/마크아웃/context coverage + paper simulation 산출. Live micro-canary 는 evidence gate 후 | 2026-05-02 |
| **Lane Operating And Ledger Refactor** | `lane-operating-refactor-2026-05-03.md` | ✅ smart-v3 / rotation-v1 / pure_ws 운영 역할 정리 + lane별 trade projection ledger 추가. Aggregate KOL ledgers 유지, shared markout ledger 유지, rotation report/digest projection 우선 + fallback 적용 | 2026-05-03 |
| DEX_TRADE Phase 3 (Quick Reject + Hold Sentinel + Ruin Sim) | — | ✅ 구현 완료 (modules + script + tests) | 2026-04-18 |

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
          pure_ws botflow: paper/observe-only new-pair botflow measurement
          kol_hunter_smart_v3: fresh active KOL velocity / paper fallback
          kol_hunter_rotation_v1: T+15/T+30 post-cost fast-compound measurement
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
