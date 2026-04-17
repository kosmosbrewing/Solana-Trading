# HWM Axis Oxidation Audit (2026-04-17)

> Status: root cause confirmed + fix merged (commit 대기)
> Source data: `data/vps-trades-20260417-215918.jsonl` (277 rows), cupsey_flip_10s CLOSED 2026-04-17 24h
> Parent plan: [`../exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md) §Wallet Truth Finding

## One-Line Conclusion

`pos.peakPrice` / DB `high_water_mark` 컬럼이 **Phase A 이전 price-axis 잔재 + ingestClosedCandle 경로의 sanity bound 우회**로 오염되어, `WINNER` 판정과 trailing stop 로직 전반을 환상 수치 위에서 계산하고 있었다. cupsey_flip_10s WINNER_TIME_STOP 11/11 건이 HWM=+500%+ 허수로 기록됐고, 실 exit는 ±1% 범위였다. Patch B2 (`cupseyMaxPeakMultiplier=15` sanity guard) 배포로 신규 생성 차단, `ops:sanitize:hwm` 스크립트로 기존 row clamp.

## Test Evidence

### 1) VPS dump 관측 (cupsey_flip_10s CLOSED 2026-04-17 24h)

| exit_reason | n | HWM min | HWM p50 | HWM max | HWM ≤ +0.5% | HWM ≥ +2% (MFE 도달) |
|---|---|---|---|---|---|---|
| WINNER_TIME_STOP | 11 | +69.91% | +542.08% | +591.10% | 0/11 | 11/11 |
| REJECT_HARD_CUT | 2 | +0.00% | +0.00% | +0.00% | 2/2 | 0/2 |
| REJECT_TIMEOUT | 1 | +0.66% | +0.66% | +0.66% | 0/1 | 0/1 |

### 2) HWM vs 실 exit price 불일치 (WINNER_TIME_STOP 샘플)

```
pippin entry=0.0004107 → HWM=+504.70% → exit=-2.16%   (peak→exit -83.82%)
pippin entry=0.0004065 → HWM=+513.80% → exit=+0.20%   (peak→exit -83.67%)
Pnut   entry=0.0007701 → HWM=+69.91%  → exit=+0.23%   (peak→exit -41.01%)
pippin entry=0.0003832 → HWM=+591.10% → exit=-0.60%   (peak→exit -85.62%)
```

HWM가 +500% 실현됐다면 trailing 4% stop이 peak에서 −4% 반락 시점에 트리거되어야 한다. 그러나 11/11 모두 720초 time stop까지 hold → 실 price가 오염 peak 근처에 간 적 없다는 증거. peakPrice 자체가 환상 수치.

### 3) recomputed vs stored pnl (30 cupsey CLOSED 전체)

- `stored_pnl_sum = 0.747 SOL`
- `recomputed_sum = (exit - entry) × qty = 0.726 SOL`
- `diff = 0.021 SOL` (전체 cupsey 한정, HWM 영향은 이 diff 외에도 WINNER 판정/trailing/runner 분석 전반 오염)

즉 `pnl` 컬럼 자체는 `(exit - entry) × qty`와 대체로 일치하지만, **WINNER 승격 여부를 HWM 기반으로 판정**하므로 오염된 HWM가 "flat drift인데 WINNER로 승격" → 12분 hold → time stop이라는 지배적 패턴을 만든다.

## Root Cause Decomposition

### (a) `realtimeCandleBuilder.ingestClosedCandle` sanity bound 우회

[`microCandleBuilder.ts:92-98`](../../src/realtime/microCandleBuilder.ts):
```ts
ingestClosedCandle(candle: Candle, emitEvents = true): void {
  this.lastPriceByPool.set(candle.pairAddress, candle.close);
  // ↑ isSaneTick() 검사 없음
  ...
}
```

Phase E1 `isSaneTick` (±50%)은 `applySwapEvent` 경로에만 적용. `ingestClosedCandle`은 backfill, replay, internal candle source 등에서 호출되며 sanity bound 우회. **한 번만 오염된 axis candle이 들어오면 `lastPriceByPool` 오염 baseline 확정.**

### (b) 신규 pool 첫 swap 자동 accept

[`microCandleBuilder.ts:53-56`](../../src/realtime/microCandleBuilder.ts):
```ts
private isSaneTick(pool: string, priceNative: number): boolean {
  if (this.tickSanityBoundPct <= 0) return true;
  const lastPrice = this.lastPriceByPool.get(pool);
  if (lastPrice == null || !Number.isFinite(lastPrice) || lastPrice <= 0) return true;
  // ↑ 신규 pool 은 무조건 accept
  ...
}
```

신규 pool의 첫 tick이 spurious axis면 오염된 baseline 확정 → 이후 ±50% 내로 drift하면 sanity pass로 누적 이동. 10 tick × +49% = 52배 cumulative drift 가능.

### (c) `pos.peakPrice = Math.max(peak, currentPrice)` — entry 대비 sanity 없음

[`cupseyLaneHandler.ts` (수정 전 line 694)](../../src/orchestration/cupseyLaneHandler.ts):
```ts
pos.peakPrice = Math.max(pos.peakPrice, currentPrice);
// entry 대비 비율 검증 없음. currentPrice 가 한 번이라도 spurious spike 받으면 peak 영구 고정
```

### (d) DB `updateHighWaterMark` 쿼리 — `GREATEST` 영구 고착

[`tradeStore.ts:275-282`](../../src/candle/tradeStore.ts):
```sql
UPDATE trades
SET high_water_mark = GREATEST(COALESCE(high_water_mark, 0), $2)
WHERE id = $1
```

오염된 값이 한 번 들어가면 이후 정상 값으로 덮을 수 없음. 영구 고착.

## Judgment

### 실행 경로는 대부분 정상

REJECT_HARD_CUT 3건(SOYJAK/BOME/unc) 분석에서 `exit_slippage_bps` = 5 / 2 / 92 bps, decision→exit gap = −0.34% / −0.09% / −0.98%로 **swap execution latency는 정상 범위**. 실 손실은 전부 entry → decision 사이 (−10~−18%)에서 발생.

### 진짜 병목 3개

1. **HWM axis oxidation** (본 문서) — 측정 기반 무너짐. **최우선 수정.**
2. **Entry = peak**: REJECT_HARD_CUT 8/8 HWM=0%. cupsey STALK(−0.1% pullback)이 spike top entry 못 막음.
3. **Liquidity crash**: thin liquidity pair에서 single swap −10% drop. entry gate에 liquidity 검증 부재.

HWM가 고쳐져야 나머지 두 개를 측정 기반으로 판단 가능.

## Fix (2026-04-17 merged, VPS 배포 대기)

### (1) Config

`src/utils/tradingParams.ts`:
```ts
cupseyMaxPeakMultiplier: 15,  // env: CUPSEY_MAX_PEAK_MULTIPLIER
```

entry 대비 15배 초과 peak은 spurious spike로 간주. Cupsey winner 프로필(+500~700%) 대비 2-3배 여유.

### (2) 3곳 guard (cupseyLaneHandler.ts)

- `updateCupseyPositions` PROBE/WINNER tick loop — `currentPrice > entry × 15`면 peak 갱신 skip + 로그 (`[CUPSEY_PEAK_SPIKE_SKIP]`)
- `recoverCupseyOpenPositions` — DB HWM이 threshold 초과면 entry로 clamp (`[CUPSEY_RECOVER_HWM_CLAMP]`)
- `inferRecoveredCupseyState`에 sanitized HWM 주입 — 오염 HWM로 인한 잘못된 WINNER 분류 방어

### (3) Migration lane 동일 패턴 적용

`migrationLaneHandler.ts` PROBE/WINNER tick에 동일 guard. 같은 config 재사용.

### (4) DB 기존 오염 row 청소 스크립트

`scripts/sanitize-oxidized-hwm.ts`:
```bash
npm run ops:sanitize:hwm                       # dry-run
npm run ops:sanitize:hwm -- --execute          # clamp (HWM = entry_price)
npm run ops:sanitize:hwm -- --multiplier 20    # threshold override
```

`WHERE entry_price > 0 AND high_water_mark > entry_price × multiplier` 조건으로 조회/정정. BEGIN/COMMIT 원자성.

### (5) Unit tests (test/cupseyLaneHandler.test.ts)

4 cases:
- spurious spike rejected (2000 vs entry 99.8)
- legitimate 10x rally accepted (998)
- oxidized DB HWM clamped on recovery
- legitimate DB HWM preserved (103 → WINNER 유지)

## Out of Scope (후속 작업)

- `ingestClosedCandle` 자체에도 sanity bound 적용 검토 (backfill 경로 방어)
- Cumulative drift 추적 (10 tick 누적으로 50배 drift 가능) — rolling check
- Trailing stop / breakeven의 다른 축 오염 (사용되지 않는 trailing_stop DB column도 `GREATEST`로 고착 가능)

## Follow-up Validation

배포 후 24h 관측 시 다음 확인:
1. `[CUPSEY_PEAK_SPIKE_SKIP]` 로그 발생 빈도 → 실제로 얼마나 자주 spike가 들어왔는지
2. 신규 WINNER_TIME_STOP 건의 HWM 분포 — 정상 범위(+2~+20%)로 수렴하는지
3. WINNER → trailing stop trigger 비율 — 오염 시점엔 0% (time stop 도달). 정상화 시 trailing trigger 증가 예상
4. `ops:sanitize:hwm --execute` 1회 실행 후 `ops:reconcile:wallet`과 crossref — DB 축 정합성 복구 확인

## Change Summary

- 수정: `tradingParams.ts`, `config.ts`, `cupseyLaneHandler.ts`, `migrationLaneHandler.ts`, `cupseyLaneHandler.test.ts`
- 신규: `scripts/sanitize-oxidized-hwm.ts`, `package.json`에 `ops:sanitize:hwm` 등록
- tsc 0 errors / jest 604/605 pass (pre-existing riskManager 실패 무관)
- 실제 content diff ≈ +115 lines
