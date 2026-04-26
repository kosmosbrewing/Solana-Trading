# architecture-pre-pivot.md — Historical Snapshot

> **이 문서는 historical reference 입니다.** 현 active paradigm 의 구조 판단에 사용 금지.
> 현 active: [`ARCHITECTURE.md`](../../ARCHITECTURE.md) 의 3-layer 모델 (Real Asset Guard / Lane / Observability).
>
> **Status**: archived 2026-04-26 (Phase H2.1)
> **Why preserved**: 신규 lane 설계 시 "왜 단일 Context→Trigger 모델을 떠났는가" 의 근거.

---

## 1. Pre-pivot 구조 (2026-04-18 이전)

### 1.1 단일 2-Stage Entry Model

```
Stage 1: Context — 왜 이 코인이 움직일 수 있는가?
  → EventMonitor (AttentionScore) + ScannerEngine (trending/social)
  → "뉴스 없는 급등 = 조작 가능성" → 추격 금지

Stage 2: Trigger — 지금 들어가도 되는가?
  → Strategy (breakout/pullback 시그널)
  → Gate (5+1단계 필터: ScamRisk, EventScore, OnchainBreakout, ExecutionViability, RiskTier)
  → Risk (사이징)
  → Executor (체결)
```

### 1.2 핵심 가정

- **Single lane**: 모든 entry 가 동일 pipeline 통과
- **Explainability 우선**: "왜 오를 만한가" 가 entry 정당성
- **Sizing 동적**: 사이즈가 신호 강도에 비례 (Kelly / risk tier 기반)
- **5x+ winner 사냥은 부산물** — 주 목표는 expectancy 양수

---

## 2. 왜 이 모델을 떠났는가

### 2.1 Mission Pivot (2026-04-18)

- DB pnl drift `+18.34 SOL` 발견 — explainability 기반 평가가 wallet truth 와 무관
- `cupsey_flip_10s` 가 유일하게 wallet-positive (다른 strategy 는 explainable 했지만 손실)
- 결론: **explainability → convexity** 전환

자세한 결정: [`docs/design-docs/mission-pivot-2026-04-18.md`](../design-docs/mission-pivot-2026-04-18.md)

### 2.2 Mission Refinement (2026-04-21)

- 100 SOL 은 tail outcome (관찰 변수, 판단 KPI 아님)
- 성공 기준 = `0.8 SOL floor + 200 trades + 5x+ winner 실측`
- Stage 1-4 maturity gate 도입

자세한 결정: [`docs/design-docs/mission-refinement-2026-04-21.md`](../design-docs/mission-refinement-2026-04-21.md)

### 2.3 Option 5 (2026-04-23)

- pure_ws_breakout 7d 83 trades / net 5x+ = 0 — paradigm 자체 한계 확정
- KOL Wallet Activity 를 1st-class Discovery trigger 로 격상
- Lane 분리 (cupsey benchmark / pure_ws baseline / kol_hunter tail)

자세한 결정: [`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`](../design-docs/option5-kol-discovery-adoption-2026-04-23.md)

---

## 3. Pre-pivot 잔존 코드 (현재도 일부 활용)

| 모듈 | 현재 상태 |
|------|----------|
| `src/event/EventMonitor` | AttentionScore — Scanner 의 watchlist 입력으로 일부 잔존 |
| `src/strategy/volumeMcapSpikeTrigger` | bootstrap_10s 로 명칭 유지, signal-only (executionRrReject=99) |
| `src/strategy/fibPullback` / `volumeSpike` | dormant — 5m 해상도, 밈코인 비적합 |
| `src/gate/*` (5+1 chain) | survival / drift / sell_probe 만 active. 나머지 비활성 |

---

## 4. 본 문서를 다시 읽어야 할 때

- 신규 lane 설계 시 "왜 단일 pipeline 이 아닌 다중 lane 인가" 의 근거 확인
- "왜 explainability 가 아니라 convexity 인가" 질문 받았을 때
- Pre-pivot 시기 코드 의도 파악 (legacy comment 해석)

---

*Archived 2026-04-26 by Phase H2.1 (architecture re-layering).*
