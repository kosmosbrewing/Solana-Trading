# 2-Stage Entry Model — Context → Trigger

## 개요

> "가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다."

## Stage 1: Context — 왜 이 코인이 움직일 수 있는가?

**입력:** EventMonitor (Birdeye trending), ScannerEngine (DexScreener), SocialMentionTracker (X)

**출력:** AttentionScore (0–100, confidence: high/medium/low)

```
후보 소스:
  Lane A: Trending tokens (age 5–300s)
  Lane B: New listings (age 300s–24h)

AttentionScore 결정 요소:
  - Liquidity / Market Cap ratio
  - Volume spike 크기
  - Social mention velocity
  - Source 가중치 (trending > social > manual)
```

**핵심:** AttentionScore가 없거나 낮으면 Gate에서 reject.
`requireEventScore=true` 시 이벤트 없는 토큰은 `no_event_context`로 거부.

## Stage 2: Trigger — 지금 들어가도 되는가?

**게이트 시스템 (순차 필터, 점수 합산 아님):**

| Gate | 이름 | 역할 | 실패 시 |
|---|---|---|---|
| 0 | SecurityGate | honeypot, freeze, 전송 수수료 | 즉시 거부 |
| 1 | ScoreGate | AttentionScore + BreakoutScore | 즉시 거부 또는 사이즈 조정 |
| 2 | ExecutionViability | stale signal, 슬리피지, 추격 금지 | 즉시 거부 |
| 3 | SizingGate | 유동성, Kelly, risk tier | 사이즈 클램핑 |

**통과 시:** RiskManager.checkOrder() → Executor.executeBuy()
