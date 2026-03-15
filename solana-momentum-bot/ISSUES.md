# Phase 0 Code Review Issues

> Reviewed: 2026-03-15
> Base: v0.3 post-cleanup (pump_detect removed, safety wired, HWM added)

## Completed

- [x] pump_detect execution path removed from index.ts
- [x] fib_pullback dynamic scoring via `buildFibPullbackScore()`
- [x] `checkTokenSafety()` wired into `checkOrder()` approval flow
- [x] lpBurned / ownershipRenounced affect position sizing (50% each)
- [x] Daily loss halt enforces actual trading stop via `tradingHaltedReason`
- [x] High-water mark persisted in DB and used for trailing stop
- [x] `highWaterMark` column added to trades table and migration
- [x] Daily loss halt auto-resumes when daily PnL is back within limit
- [x] Existing open trades backfill `highWaterMark` conservatively to `entry_price`
- [x] `checkTokenSafety()` multiplier/result semantics split (`sizeMultiplier` vs `adjustedQuantity`)
- [x] TP1 now performs partial exit and keeps the remainder open

## Open Issues

## Remaining Work Summary

### Lower priority (Phase 1 이후)

- `6` Make position monitoring timeframe-aware
- `7` Confirm spread data is real and reaches the filter path (Universe 미사용 상태로 현재 영향 없음)

## Recently Resolved

- `0b` ✅ Live/backtest decision-path divergence — Gate 모듈 추출로 해결 (SOL-4)
- `1` ✅ `pump_detect` StrategyName에서 완전 제거 (SOL-5)
- `4` ✅ `minBuyRatio`, `minBreakoutScore` — Gate 평가 로직에 연결 완료
- `5` ✅ `multiTfAlignment` — volume_spike 단일 TF는 의도적 설계, fib_pullback은 동적 계산
- `8` ✅ `safeAddColumn` — 화이트리스트 검증 추가로 안전 (코스메틱 이슈만 잔존)
- `9` ✅ HWM migration 중복 — tradeStore.ts에서 제거, migrate.ts로 통합
### P0 — Must fix

#### 0b. Live/backtest strategy divergence (fib_pullback and shared)

`src/backtest/engine.ts:97-117`

Backtest does not apply breakout scoring, Grade filtering, Grade-based sizing, or token safety checks. Live does. This means backtest results are systematically more optimistic.

| Step | Live | Backtest |
|------|------|----------|
| Breakout Score calculation | Yes | **No** |
| Grade C filter (reject) | Yes | **No** |
| Grade B half-sizing | Yes | **No** |
| Token safety check | Yes | **No** |
| LP burn / ownership sizing | Yes | **No** |

Additionally, TP1 handling diverges in the **opposite direction**:

| TP1 behavior | Live | Backtest |
|--------------|------|----------|
| Action | Full close (`closeTrade()`) | Move SL to breakeven, keep position open |
| Effect | Cuts winners early | Lets winners run to TP2/trailing |

The backtest TP1 model (`engine.ts:314-318`) is actually closer to the partial-exit behavior requested in REFACTORING.md.

Also, `engine.ts:5-8` still imports `evaluatePumpDetection` and `buildPumpOrder`, and `runCombined()` at line 173 runs pump_detect backtest. Dead strategy is removed from live but alive in backtest.

**Fix:** Extract gate/scoring logic into a shared module so live and backtest use identical decision paths.

```
src/gate/
  scoreGate.ts      # breakout score → grade filter
  safetyGate.ts     # token safety check
  sizingGate.ts     # grade + safety based sizing

index.ts   → gate/* calls
engine.ts  → gate/* same calls (+ slippage deduction)
```

**Decision:** Align backtest to live model. Keep `--raw-signals` flag for unfiltered signal analysis.

---

### P1 — Should fix before Phase 1

#### 1. `pump_detect` remains in StrategyName type

`src/utils/types.ts:48`

```typescript
export type StrategyName = 'volume_spike' | 'pump_detect' | 'fib_pullback';
```

Execution path is removed but the type still includes it. Remove `pump_detect` from the union or keep it only if the type is intentionally forward-looking.

#### 4. `minBuyRatio` and `minBreakoutScore` config values unused

`src/utils/config.ts:80-81`

Both are defined and exposed but never referenced in entry logic. Either wire them into the decision flow or remove them to avoid misleading tuning.

### P2 — Should fix but not blocking

#### 5. `multiTfAlignment` hardcoded for volume_spike

`src/index.ts:289`

```typescript
multiTfAlignment: 1, // Single TF for now
```

fib_pullback now computes a heuristic 1-2 value in `buildFibPullbackScore()`, but volume_spike still passes a fixed `1`. This means multi-TF score contributes nothing to Grade calculation for the primary strategy. Either implement real multi-TF or remove the score component.

#### 6. Position monitor uses fixed 5m candles

`src/index.ts:660`

```typescript
const recentCandles = await ctx.candleStore.getRecentCandles(
  trade.pairAddress,
  300,  // always 5m
  10
);
```

All open trades are monitored with 5-minute candles regardless of entry strategy timeframe. Currently both live strategies use 5m so this is not a bug, but it will break when a shorter-timeframe strategy is added.

#### 7. spread filter still receives zero

Universe engine fetches spread data but it is not confirmed whether real values reach the filter path. If `spreadPct` is always 0, the `maxSpreadPct` config is ineffective.

### P3 — Low priority / cosmetic

#### 8. `safeAddColumn` uses string interpolation

`scripts/migrate.ts:258`

```typescript
await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
```

No parameterized binding for DDL identifiers. All current callers pass hardcoded strings so the real risk is zero, but it sets a bad pattern for future migration additions.

#### 9. Duplicate HWM migration

`high_water_mark` column is added both in `TradeStore.initialize()` (`src/candle/tradeStore.ts:46-48`) and in `scripts/migrate.ts:110`. Both use `IF NOT EXISTS` so there is no runtime error, but the duplication should be consolidated to the migration script only.
