# Mission Pivot: A/B Parallel Strategy — 2026-04-11

> Status: active implementation
> Origin: 5일간 live 운영 진단 (entry timing = root cause 확정) + cupsey 벤치마크 + GPT 품질 검토
> Scope: Path A (cupsey-inspired lane) + Path B (Strategy D live + KOL wallet tracker) 병렬 구현

## 0. 왜 pivot 하는가

5일간 진단 결과:
- 48h clean expectancy: **-0.00108 SOL/trade** (음수)
- TP2 actual reach: **0%** (전 구간)
- TP1 fill: **8/8 = 100% loss** (noise reversion)
- 14h post-W1.5: **0W/3L** (all SL, XSLOTH +6% entry gap)
- Post-entry trajectory: 30s MFE p50 = **+0.03%** (noise 수준)

**근본 원인**: bootstrap_10s volume spike trigger = **lagging indicator**. 가격이 이미 올라간 뒤 감지 → spike 꼭대기에서 매수 → 자연 reversion → loss.

**인프라는 작동 중**: defense layers (P0-M2/M3/M5), Phase E1 telemetry, ATR floor, PRICE_ANOMALY guard — 모두 OK. **entry thesis 가 틀린 것.**

## 1. Path A — Cupsey-Inspired Lane

### 핵심 가설
"entry timing 은 고치지 않되, post-entry 30-45초 판정으로 winner/loser 를 빠르게 분류하면 avg loss 를 극소화할 수 있다"

### 데이터 근거
post-entry trajectory 분석 (53 executed, 48 with outcome):
```
"no momentum at 30s" group (41 trades): total PnL +0.096 SOL, avg +0.002/trade
"early momentum" group (7 trades):      total PnL -0.004 SOL, avg -0.001/trade
Quick reject savings estimate: +0.059 SOL net improvement
```

### 설계

```
Strategy ID: cupsey_flip_10s
Entry: bootstrap_10s signal 재사용 (새 trigger 없음)
Gate: 기존 gate chain 재사용
Sizing: 0.01 SOL fixed micro-ticket (risk-per-trade X, fixed ticket)

Post-entry state machine:
  [PROBE]   0-45s:  monitor tick price 관찰
                    MFE < +0.1% AND 45s 경과 → REJECT
                    MFE ≥ +0.3% → WINNER_MODE
                    MAE ≤ -1.0% → REJECT (hard cut)
  [REJECT]  즉시:   market sell, loss 기록
  [WINNER]  45s-5m: trailing stop only (SL = entry + 0.1%, trail 0.5%)
  [WINNER]  5m:     hard time stop → close
```

### 코드 위치
- `src/orchestration/cupseyLaneHandler.ts` (신규) — state machine + trade 관리
- `src/utils/tradingParams.ts` — cupseyLane 섹션
- `src/utils/config.ts` — `CUPSEY_LANE_ENABLED` flag
- `src/index.ts` 1247-1250 — signal 분기 추가

### 파이프라인 연결
```typescript
// index.ts, after handleRealtimeSignal
if (signal && config.cupseyLaneEnabled) {
  await handleCupseyLaneSignal(signal, realtimeCandleBuilder!, ctx);
}
```

### metric (lane 전용)
- `quick_reject_count` / `winner_mode_count`
- `avg_probe_mfe_at_45s`
- `winner_avg_hold_sec`
- `lane_net_pnl_sol`
- `lane_win_loss_ratio`

## 2. Path B — Entry Signal 개선

### B1: Strategy D Live Enable (이미 scaffold)

`src/strategy/newLpSniper.ts` 에 이미 구현:
- `evaluateNewLpSniper()` — signal 생성
- `buildNewLpOrder()` — order 생성 (fixed ticket 0.02 SOL)
- `prepareNewLpCandidate()` — security/quote gate

**누락**: executor 연결 (line 551 "Jito bundle + sandbox wallet 통합 후 활성화")

Fix: Jito 없이 Jupiter Ultra 로 sandbox wallet 에서 실행.
```typescript
// index.ts handleStrategyDListingCandidate 수정
if (effectiveMode === 'live' && config.strategyDLiveEnabled) {
  const buyResult = await ctx.executor.executeBuy(order);
  // ... record trade
}
```

### B2: KOL Wallet Tracker

`src/discovery/kolWalletTracker.ts` (신규):
- Helius WS `connection.onLogs(walletPublicKey, ...)` 로 cupsey wallet 구독
- wallet 의 token buy tx 감지 → 해당 token 을 scanner watchlist 에 즉시 추가
- 기존 admission/gate 재사용
- **이건 entry signal 이 아니라 discovery source** — cupsey 가 산 token 을 우리 universe 에 추가

Helius 구독 패턴은 `heliusWSIngester.ts` 의 `subscribePools()` 와 동일.

### B 우선순위
B1 (Strategy D) 먼저 (이미 코드 존재, 3일), B2 (KOL tracker) 이후 (5-7일).

## 3. 병렬 실행 구조

```
Main wallet (Option β):
  └→ 계속 가동 — baseline + 소액 loss 감수

Path A sandbox:
  └→ cupseyLaneHandler
  └→ 0.01 SOL fixed ticket
  └→ 30-45s probe → reject/winner
  └→ feature flag: CUPSEY_LANE_ENABLED

Path B sandbox:
  └→ Strategy D (newLpSniper) live
  └→ 0.02 SOL fixed ticket
  └→ feature flag: STRATEGY_D_LIVE_ENABLED

Path B2 discovery:
  └→ KOL wallet tracker
  └→ cupsey wallet → scanner watchlist
  └→ feature flag: KOL_WALLET_TRACKING_ENABLED
```

## 4. 판정 (2주 후)

| A 결과 | B 결과 | 판정 |
|---|---|---|
| expectancy > 0 | expectancy > 0 | 🟢 둘 다 승격 |
| expectancy > 0 | < 0 | 🟡 A 만 승격 |
| < 0 | expectancy > 0 | 🟡 B 만 승격 |
| 둘 다 < 0 | — | 🔴 Path C (market pivot) 또는 포기 |

## History

- 2026-04-11: 초기 작성. 5일간 live 진단 → entry timing 이 root cause → A/B 병렬 pivot.
