# Migration Handoff Reclaim — Design Doc

> Status: Phase 2 Tier 1 lane, 2026-04-17 design (user override of Phase Gate)
> Depends on: Patch A/B1 VPS deploy (source-of-truth closure pending)
> Parent plan: [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md) W1.7

## Thesis

2026년 솔라나 밈코인 시장은 "pure breakout 추격"보다 **이벤트 앵커가 있는 reclaim**이 더 깔끔한 edge다. CoinGecko 2026 narrative (fairer launches, anti-sniper), Pump.fun graduation → PumpSwap canonical pool, Raydium LaunchLab 졸업은 **명시적 가격/유동성 이벤트**를 만든다. 이 이벤트 직후 **first overshoot(과열)가 빠진 뒤 reclaim**이 진입점.

"Cupsey-style quick reject + winner hold"가 Tier 0 primary에서 어떻게 분포를 만드는지는 별개로, Tier 1은 **이벤트 앵커로 confusion-free entry**를 노린다.

## Entry Framework

### Event Sources

| # | 이벤트 | Detection | Confidence |
|---|---|---|---|
| 1 | **Pump.fun graduation** | Pump.fun bonding curve → PumpSwap canonical pool 생성 tx | 높음 (on-chain explicit) |
| 2 | **Raydium LaunchLab 졸업** | LaunchLab 졸업 → Raydium CPMM pool 생성 + LP burn | 높음 |
| 3 | **PumpSwap new pool** | PumpSwap canonical pool init | 중간 (전체 volume 추적 필요) |

Phase 2 첫 구현은 **#1 (Pump.fun graduation)** 에 집중. 가장 명확한 이벤트, Helius trigger 재사용 가능, 현재 scanner 파이프라인과 자연 연결.

### Entry State Machine

```
[MIGRATION_EVENT]  graduation tx 감지
      ↓
[COOLDOWN]         60-120s 관찰 (first overshoot 통과 대기)
      ↓
[RECLAIM_STALK]    가격이 event price의 -10~-30%로 pullback 확인
      ↓
[RECLAIM_ENTRY]    pullback 후 reclaim candle (녹색 + buy_ratio>0.55) 확인 시 매수
      ↓
[PROBE]            30-45s MFE/MAE 관찰 (cupsey와 동일 패턴 재사용)
      ↓
[WINNER | REJECT]  cupsey와 동일한 분기
```

### Rejection Gates

cupsey signal gate + 추가:
- `migration_age_sec > 900` (15분 초과 — edge 사라짐)
- `cooldown 구간 중 crash >-50% from event` (rug suspicion)
- `post-reclaim buy_ratio < 0.50` (회복 신호 없음)

### Ticket / Risk

- **Ticket**: 0.01 SOL 고정 (override 하드 가드레일)
- **maxConcurrent**: 1 (cupsey와 독립 카운트, Patch A lock 동일 적용)
- **독립 wallet tag**: sandbox executor 사용, trades 테이블 `source_label='migration_reclaim'`으로 attribution 분리
- **Stop**: `−0.8% hard cut` (cupseyProbeHardCutPct 재사용)
- **TP**: 기본 `5 ATR`, Grade A 조건 시 runner extension

## Module Structure

### Files

```
src/strategy/migrationHandoffReclaim.ts    # trigger logic + gate
src/realtime/migrationEventDetector.ts     # Helius subscription for graduation tx
src/orchestration/migrationLaneHandler.ts  # state machine (mirror of cupseyLaneHandler)
src/utils/migrationConfig.ts               # env-backed config
```

### Config Keys (env → config.ts)

```
MIGRATION_LANE_ENABLED=false              # default OFF
MIGRATION_LANE_TICKET_SOL=0.01
MIGRATION_COOLDOWN_SEC=90
MIGRATION_STALK_WINDOW_SEC=180
MIGRATION_STALK_MIN_PULLBACK_PCT=0.10     # -10% pullback minimum
MIGRATION_STALK_MAX_PULLBACK_PCT=0.30     # -30% pullback maximum (past is rug)
MIGRATION_RECLAIM_BUY_RATIO_MIN=0.55
MIGRATION_PROBE_WINDOW_SEC=45             # cupsey와 동일
MIGRATION_PROBE_HARD_CUT_PCT=0.008        # cupsey와 동일
MIGRATION_MAX_CONCURRENT=1
MIGRATION_MAX_AGE_SEC=900                 # 15분 이후 edge expired
MIGRATION_SOURCE_LABEL=migration_reclaim
```

## Paper Validation Path

### Signal-Only Phase (즉시 가능, Phase 0 배포 이전에도)

1. `MigrationEventDetector` 만 enable → graduation tx 감지 → `signal-intents.jsonl`에 marker 기록
2. 실거래 없음. 단, 이후 N분간 price trajectory를 `realtime-signals.jsonl`에 기록
3. 24h 누적 후 graduation→reclaim 패턴의 **natural occurrence rate** 측정

### Paper Trade Phase (Patch A/B1 VPS 배포 후)

4. `MIGRATION_LANE_ENABLED=true`, `TRADING_MODE=paper`
5. state machine 완전 가동, paper wallet delta로 pnl 산출
6. 목표: **50 paper trades**, expectancy > 0 확인 후 live canary 진입

### Live Canary Phase (paper 통과 후)

7. `TRADING_MODE=live`, 0.01 SOL ticket
8. 독립 wallet 또는 attribution tag 분리, **cupsey와 분리 측정**
9. 20~30 trade 누적 → wallet 기준 양의 기대값 증명 후 보강

## Risk Containment

- **Cupsey와 독립 concurrency**: Patch A의 `enteringLock` 패턴 동일하게 복제 (reentrancy 차단)
- **Close path serialization**: Patch B1의 `closeMutex`와 공유 (한 mutex에서 두 lane 모두 직렬화 — receivedSol race 원천 제거)
- **Wallet stop**: 통합 wallet stop `< 0.8 SOL` 발동 시 **두 lane 모두 정지**
- **Roll-back**: `MIGRATION_LANE_ENABLED=false` 한 줄로 즉시 OFF

## Out of Scope (Phase 2에서 구현 안 함)

- Raydium LaunchLab 졸업 detection (Phase 2.5 추가 source)
- PumpSwap arbitrary new pool (Phase 3)
- Liquidity Shock Reclaim (Tier 2, 별도 lane)
- Recent + Organic discovery는 shared input이라 별도 task에서 다룸

## Open Questions

- **Q1**: Pump.fun graduation tx 형태/식별자 — Helius program-log 또는 instruction pattern 확정 필요
- **Q2**: PumpSwap pool 가격을 realtime candle builder에 어떻게 feed할 것인가 (기존 scanner 경로 재사용 vs 직접 subscription)
- **Q3**: Migration event 후 초기 유동성이 cupsey entry criteria(price_chg ≥ 0, buy_ratio ≥ 0.50)를 자연스럽게 충족하는지 — 이 경우 cupsey lane이 이미 잡고 있을 가능성. 중복 entry 방어 필요.
