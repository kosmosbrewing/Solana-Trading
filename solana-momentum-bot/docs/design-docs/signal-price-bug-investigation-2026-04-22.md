# Signal Price Bug Investigation (2026-04-22)

> Status: investigation record (infra-level fix pending)
> Date: 2026-04-22
> Scope: bootstrap_10s signal price 가 Jupiter actual fill 대비 12배 부풀림
> Temporary mitigation: `PUREWS_MAX_FAVORABLE_DRIFT_PCT=0.20` 로 실시간 진입 차단 (P2, 2026-04-22)
> Root cause fix: 별도 sprint 필요

## 관측된 문제

2026-04-21 14시간 운영 중 48 PUREWS_LIVE_BUY 중 대부분이 Dfh5DzRgSvvC (pippin) pair 반복:

```
[PUREWS_ENTRY_DRIFT] Dfh5DzRgSvvC signal=0.00346776 expectedFill=0.00028901 drift=-91.67%
[PUREWS_SELL_PROBE]  Dfh5DzRgSvvC outSol=0.000833 impact=0.00% roundTrip=8.3%
```

- **signal price 0.003** vs **Jupiter expected fill 0.000289** — 정확히 **12배 차이**
- 48 trades 전부 `drift ≈ −91.67%` 고정 관측
- Sell probe 의 roundTrip 도 8.3% = negative drift 와 동일 수치

## 증상 분석

### Dual price tracker 가 masking 중

`resolveActualEntryMetrics` 의 **5x multi-account guard** 가 작동:
- actualOutUiAmount (Jupiter 가 준 tokens) = 34.72 UI
- order.quantity (planned) = 2.884 UI
- ratio 12x >> 5x guard → planned 로 force-revert
- 결과: pos.entryPrice = signal.price (엉터리), pos.quantity = order.quantity
- pnl 계산이 signal 기준 → **−0.03% 수준의 작은 loss** 로 masked

### 실제 wallet impact

- Buy: 0.01 SOL 지출, 34.72 tokens 수령 (planned 2.884 의 12배)
- 30s timeout 후 sell: 실제 balance 34.72 tokens 전부 → ~0.01 SOL 회수
- Wallet delta: -0.01 + 0.01 - fee ≈ **-0.0002 SOL (fee only)**
- 48 trades 누적 wallet loss: 약 -0.01 SOL (관측된 DB pnl -0.003 과 거의 일치)

즉 **wallet 은 보호되지만 MAE/MFE/runner promotion 시스템 전체가 엉터리 데이터로 동작**.

## Root cause 가설 (확정 전)

### 가설 1 — Pool stale / multi-pool routing mismatch (가능성 높음)

- Dfh5DzRgSvvC 는 pump.fun migration 토큰
- 2026-04-18 ~ 04-22 사이 실제 시장에서 **12배 덤프** 발생
- 우리 구독 pool (`poolAddress`) 은 **dormant pool** (예: 오래된 raydium pool) 이거나 **pump.fun bonding curve pool**
- 새 swap event 가 적음 → candle close 가 old price (0.003) 유지
- Jupiter 는 active pool (예: migration 된 raydium v2) 에서 quote → 실제 가격 0.000289

### 가설 2 — MicroCandle close price 계산 staleness

- candle 의 close = last swap price in interval
- swap 없는 interval 이면 이전 candle close 유지
- pool 가격이 연속적으로 변동했는데 우리 pool 은 swap 안 들어옴
- 결과: candle close 가 일정 가격에서 stale

### 가설 3 — swap parser 의 decimals 미스매치 (가능성 낮음)

- `parseFromPoolMetadata` 는 preTokenBalances.decimals 사용 → 정확해야 함
- 하지만 pool metadata 의 baseDecimals/quoteDecimals 가 **resolvePoolMetadata** 에서 잘못 resolve 되면 toUiAmount 가 12배 오차
- 근거: `pumpSwapParser.ts:22` 주석에 이미 "5x~30x 부풀림" 전력 기록

## 2026-04-22 mitigation (P2)

`entryDriftGuard` 에 `maxFavorableDriftPct=0.20` 추가:
- drift < −20% 이면 reject
- pippin 같이 drift = −91.67% 인 signal 은 **진입 자체 차단**
- 진입 차단으로 인한 wallet 손실 방지 + 엉터리 데이터 축적 방지

이 mitigation 은 **증상 차단**. 근본 원인은 여전히 미해결.

## Root cause fix 를 위한 필요 작업 (별도 sprint)

### Phase 1 — 원인 진단

1. **Pool subscription 검증**:
   - 문제 pair 의 `subscribed pool address` 조회
   - 실제 active pool (Jupiter routing 기준) 과 비교
   - Helius pool registry 에서 해당 토큰의 pool 목록 조회 → 가장 liquid 한 pool 식별

2. **Candle staleness 측정**:
   - 문제 pair 의 직전 10s interval 동안 swap event 수 측정
   - swap=0 이면 candle stale → signal 자체 drop 로직 필요

3. **Swap parser decimals 검증**:
   - Dfh5DzRg 에 대한 `resolvePoolMetadata` 결과의 baseDecimals/quoteDecimals 로그 찍고 실제 mint decimals 와 대조

### Phase 2 — Infra 개선

1. **Active pool tracking**:
   - 토큰당 여러 pool 구독 가능 시 **가장 liquid 한 pool 에 우선 구독**
   - Helius pool registry 의 TVL / volume 메타데이터 활용

2. **Signal price freshness check**:
   - signal fire 전 Jupiter quick quote 로 market price 확인
   - signal price vs market price 차이 > threshold 이면 drop

3. **Pool resolution 일관성**:
   - `poolMetadata.baseDecimals/quoteDecimals` 가 NULL 로 resolve 되는 케이스 식별
   - 실패 시 Jupiter token list / helius metadata 로 fallback

### Phase 3 — Signal quality validation

- live paper comparison: signal price vs Jupiter quote 전체 분포 측정
- 각 pair 별 drift 중앙값 / p95 / p99 로 pool 품질 tier 분류
- tier 낮은 pool 은 구독 대상 제외

## 예상 sprint 분량

- **Phase 1 (진단)**: 4-8시간 — 로그 수집 + pool metadata 조회 + decimals 추적
- **Phase 2 (infra 개선)**: 1-2일 — active pool tracking + signal freshness
- **Phase 3 (validation)**: 1일 — replay + 튜닝

**총 2-3 업무일**. Stage 2 (100 trades) 진입 전까지는 P2 mitigation 으로 운영 가능.

## 현재 상태 (2026-04-22)

- P2 mitigation 배포 준비 완료 — pippin 같은 signal bug 시 진입 차단
- Root cause fix 는 Tier C follow-up 으로 설계 문서화
- Stage 1 Safety Pass 에는 영향 없음 (drift guard 가 wallet 보호)
- Stage 2 진입 후 **signal quality 관측 데이터** 가 root cause 진단의 primary input

## 현재 배포 후 예상 동작

1. pippin 같은 signal 들어와도 `entryDriftGuard` 에서 reject → `[PUREWS_ENTRY_DRIFT_REJECT] ... suspicious_favorable_drift -91%` 로그
2. 진입 0건 → 48 trades 같은 "엉터리 데이터 축적" 없음
3. v1 cooldown 30분 + drift guard 조합으로 pair diversity 강제
4. 다른 정상 signal (drift < ±2%) 만 진입 → Stage 2 sample 의 품질 확보

## Follow-up 조건

이 문서의 Phase 1 진단이 필요한 시점:
- Stage 2 진입 (100 trades 도달)
- 또는 drift guard rejection 률 > 50% (대부분 signal 이 거부됨)
- 또는 운영자 manual 요청
