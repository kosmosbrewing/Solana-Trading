# Realized vs Replay Ratio — Status Note (2026-04-07)

> Companion to `realized-replay-ratio-2026-04-07.md` (auto-generated empty).
> Records why the ratio cannot be computed yet and what is required to unblock P3.

## Tooling state

- **Script**: `scripts/analysis/realized-replay-ratio.ts` — 작성 완료, type-check 통과, smoke run 정상.
- **Output template**: `docs/audits/realized-replay-ratio-2026-04-07.md` — 매 실행 시 덮어쓰기.
- **Schema graceful degrade**: 구버전 DB(decision_price 등 cost 컬럼 없음)에서도 NULL fallback으로 동작.

## Why "0 matched / 0 closed bootstrap paper trades"

| Source | Records | Era | Strategy | Joinable? |
|---|---:|---|---|---|
| Local DB `trades` table | 19 closed | 2026-03-21 ~ 03-22 | volume_spike | ❌ tradeId가 signal log 보다 이전 시기 |
| Local realtime sessions jsonl | 208 signals | 2026-03-31 ~ 04-06 | bootstrap_10s(89) + volume_spike(119) | tradeId 보유 84개 (executed_live) |
| 84 executed_live signals | 84 | 2026-03-31 ~ 04-06 | mixed | ❌ DB 미존재 (VPS 분리) |

핵심 원인: **84개 executed_live tradeId는 VPS Postgres에 존재**하지만 local DB(localhost:5433)에는 없다. .env.production은 `DATABASE_URL`을 포함하지 않으므로 local에서 VPS DB로 직접 join 불가능.

## Two unblock paths

### Path A — Local paper run (권장, 안전)

P0 audit + P2 LOO 결과로 채택된 best profile을 local paper 모드로 돌려 fresh signal+trade pair를 누적. tradeId가 동일 DB에 존재하므로 join이 즉시 동작.

**Best profile (P2 verdict)**: `vm2.4-br0.65-lb20-cd180`
- volumeMultiplier = 2.4
- minBuyRatio = 0.65
- volumeLookback = 20
- cooldownSec = 180

**Required env (local .env)**:
```
TRADING_MODE=paper
REALTIME_TRIGGER_MODE=bootstrap
REALTIME_PERSISTENCE_ENABLED=true
STRATEGY_TRIGGER_VOLUME_MULTIPLIER=2.4
STRATEGY_TRIGGER_MIN_BUY_RATIO=0.65
STRATEGY_TRIGGER_VOLUME_LOOKBACK=20
STRATEGY_TRIGGER_COOLDOWN_SEC=180
DATABASE_URL=postgresql://...localhost:5433/...
```

**Run**:
```bash
npm run start  # or pm2 start ecosystem.config.js
```

**Wait for**: 20 closed paper trades. Helius signal pace 기준 (직전 9 세션 평균 ~32 signals/session, 가정 trade 변환률 30%) → 약 2-3 active sessions ≈ 24-72시간.

**Verify**:
```bash
npx ts-node scripts/analysis/realized-replay-ratio.ts \
  --strategy bootstrap --horizon 180 \
  --out docs/audits/realized-replay-ratio-2026-04-07.md
```

### Path B — VPS DB sync

VPS Postgres에서 trades 테이블 dump → local restore → 동일 ratio 스크립트 실행. 운영 데이터 sync는 OPERATIONS.md 권한 범위 내에서만.

## Sample size notes

- 20 trades = 신뢰구간 폭 매우 큼 (단순 reference)
- 50 trades = ratio가 ±20% 정밀도로 안정화되기 시작
- 100 trades = paper → live 전환 의사결정에 사용 가능한 표본

P3 verdict는 ratio 자체뿐 아니라 **sample size + ratio variance** 을 함께 본다. 20 trades는 P3의 minimum이며, 진짜 mission 의사결정에는 50+가 필요하다.

## What this script DOES NOT do

1. Live wallet trades 분석 — VPS DB 접근 필요
2. Slippage decomposition — entry_slippage_bps 컬럼 부재 시 NULL
3. MEV / sandwich detection — 별도 지표
4. 모드 자동 분리 — `--strategy` flag로 수동 필터링
