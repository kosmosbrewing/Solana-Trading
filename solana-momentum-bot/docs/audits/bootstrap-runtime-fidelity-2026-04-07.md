# Bootstrap Runtime Fidelity Audit — 2026-04-07

## Purpose

2026-04-06 full sweep 결과에서 동일 profile `vm2.4-br0.65-lb20-cd180`가 input mode에 따라 전혀 다른 verdict를 낸 원인을 규명하고, replay 경로 중 어느 것을 live runtime truth로 신뢰할 수 있는지 확정한다.

| Mode | total signals | gate-pass | keep-like | weighted adj |
|---|---:|---:|---:|---:|
| swaps | 1117 | **6/9** | **5/9** | **+24.62%** |
| candles | 596 | **1/9** | **1/9** | **+5.00%** |

## Scope

다음 3개 경로가 `VolumeMcapSpikeTrigger.onCandle()`에 도달하는 data flow를 코드 레벨로 대조:

1. Live runtime (`src/index.ts`)
2. Replay-swaps (`src/backtest/microReplayEngine.ts::replayRealtimeDataset`)
3. Replay-candles (`src/backtest/microReplayEngine.ts::replayRealtimeCandles*`)

Source of truth 파일:

- `src/index.ts` (line 1025-1070, 1200-1229)
- `src/strategy/volumeMcapSpikeTrigger.ts` (전체)
- `src/realtime/microCandleBuilder.ts` (전체)
- `src/backtest/microReplayEngine.ts` (line 82-342)
- `scripts/session-replay-sweep.ts` (line 153-172)
- `docs/exec-plans/completed/20260406-audit-note.md` (prior facts)

## Verdict

**A: Swaps replay ≡ Live (signal-generation 경로 동일)**
**Candles replay ≠ Live (lossy reconstruction, 체계적 gap 존재)**

## Evidence

### 1. Trigger 호출 시그니처는 세 경로 모두 동일

```typescript
// VolumeMcapSpikeTrigger.onCandle(candle, candleBuilder): Signal | null
// src/strategy/volumeMcapSpikeTrigger.ts line 89
```

trigger는 내부적으로 `candleBuilder.getRecentCandles(pair, intervalSec, totalLookback+1)`로
lookback을 읽는다 (line 99). 즉 trigger 결과는 **builder state**에 의존하고, builder state가
어떻게 형성되었는지가 fidelity를 결정한다.

### 2. Live wiring — src/index.ts

```typescript
// line 1025
realtimeCandleBuilder = new MicroCandleBuilder({
  intervals: realtimeIntervals,
  maxHistory: 200,
});

// line 1200-1229
realtimeCandleBuilder.on('candle', async (candle: Candle) => {
  if (realtimeReplayStore && candle.tradeCount > 0) {
    await realtimeReplayStore.appendCandle({ ...candle, tokenMint: candle.pairAddress });
    // ^^^ tradeCount > 0인 candle만 micro-candles.jsonl에 저장
  }
  ...
  const signal = trigger.onCandle(candle, realtimeCandleBuilder!);
});
```

Helius WS → `heliusIngester` → `realtimeCandleBuilder.onSwap(swap)` (내부 applySwapEvent)
→ bucket close → `'candle'` event emit → `trigger.onCandle(candle, builder)`.

이때 builder 내부에서는:
- `applySwapEvent` (line 64-89): swap별로 open candle에 누적, bucket 경계 넘으면 `closeCandle` + `fillMissingBuckets`
- `fillMissingBuckets`: swap 사이의 빈 bucket을 synthetic zero-volume candle로 채워 closed history에 삽입
- `checkAndCloseCandles` (1초 sweep, line 29-32): 시간 기반 bucket 종료 감지

**→ builder의 `closedCandles` map에는 trade가 있는 bucket + synthetic zero-volume bucket이 모두 들어간다.**
**→ 파일(`micro-candles.jsonl`)에는 `tradeCount > 0`만 저장되지만, trigger가 보는 in-memory state는 완전하다.**

### 3. Swaps replay wiring — microReplayEngine.ts::replayRealtimeDataset

```typescript
// line 89-120
const builder = new MicroCandleBuilder({ intervals: getBuilderIntervals(options), maxHistory: 512 });
const trigger = createTrigger(options);
...
builder.on('candle', (candle) => {
  pendingTasks.push(handleReplayCandle({ candle, builder, trigger, ... }));
});
for (const swap of orderedSwaps) {
  builder.onSwap({ ...swap, pool: swap.pairAddress });
  await drainTasks(pendingTasks);
}

// line 213-236 (handleReplayCandle)
const signal = trigger.onCandle(candle, builder);
```

**→ Live와 100% 동일한 code path.** 유일한 차이:

| 항목 | Live | Swaps replay |
|---|---|---|
| Swap source | Helius WS (real-time) | `raw-swaps.jsonl` (sanitized, time-ordered) |
| Trigger call | `trigger.onCandle(candle, builder)` | `trigger.onCandle(candle, builder)` (identical) |
| Builder feed | `builder.onSwap(swap)` | `builder.onSwap(swap)` (identical) |
| Synthetic zero-volume | `fillMissingBuckets` inside applySwapEvent | `fillMissingBuckets` inside applySwapEvent |
| Execution layer | 실제 Jupiter swap, slippage, MEV | 미시뮬레이션 (signal-only) |

**signal 생성 관점에서 swaps replay는 live의 perfect reproduction**. fidelity gap은 execution layer(slippage/latency/fill/MEV)에만 존재하며, 이건 별도 영역 (P3 paper reality check에서 다룸).

### 4. Candles replay wiring — microReplayEngine.ts::replayRealtimeCandles*

```typescript
// line 154-167 (replayRealtimeCandles)
const sanitized = sanitizeReplayCandles(candles);
const filled = fillCandleGaps(sanitized.candles);  // ← separate reconstruction
return replayOrderedCandles(filled, { ... });

// line 319-342 (processReplayCandle)
async function processReplayCandle(candle, runtime, options) {
  runtime.builder.ingestClosedCandle(candle, false);  // ← swap 경로 우회
  await runtime.outcomeTracker.onCandle(candle);
  if (candle.intervalSec !== getPrimaryIntervalSec(options)) return;
  const signal = runtime.trigger.onCandle(candle, runtime.builder);
}
```

`ingestClosedCandle` (microCandleBuilder.ts line 56-62):

```typescript
ingestClosedCandle(candle: Candle, emitEvents = true): void {
  this.lastPriceByPool.set(candle.pairAddress, candle.close);
  this.pushClosedCandle({ ...candle });
  if (emitEvents) {
    this.emit('candle', { ...candle });
  }
}
```

**→ `applySwapEvent`, `applySwap`, `fillMissingBuckets` 모두 호출되지 않음.**
candles replay는 stored candle을 directly builder의 `closedCandles` map에 push하고, 곧바로 trigger를 호출한다.

### 5. Fidelity gap의 구체 출처

`micro-candles.jsonl` 파일은 `tradeCount > 0` candle만 append된다 (src/index.ts line 1203).
따라서 candles replay의 입력은 **live가 실제로 사용한 in-memory state의 부분집합**이다.

Replay는 `fillCandleGaps` (microReplayEngine.ts line 416-468)로 gap을 복구하려 시도:

```typescript
while (gapMs >= candle.intervalSec * 1000 && fillCount < maxFillCount) {
  result.push({
    pairAddress, timestamp: new Date(fillTimestampMs),
    intervalSec, open: prev.close, high: prev.close,
    low: prev.close, close: prev.close,
    volume: 0, buyVolume: 0, sellVolume: 0, tradeCount: 0,
  });
  ...
}
```

하지만 이건 **stored candles 사이의 gap**만 복구한다. Live의 실제 state와 다음 측면에서 벌어진다:

1. **bucket 경계 정렬**: live의 `checkAndCloseCandles` sweep은 1초 단위로 bucket을 종료한다.
   candles replay는 이미 종료된 candle만 읽으므로, swap이 없는 pair의 bucket 종료 시점이 달라질 수 있다.
2. **cross-pair 시점 정합성**: live는 real-time clock 기준으로 모든 pair bucket을 동시에 처리.
   replay는 candle 파일의 나열 순서를 따르므로, pair 간 interleaving이 다를 수 있다.
3. **`maxFillCount = 200` cap**: 장시간 idle 후 reactivation 시 live는 `applySwapEvent`의 `fillMissingBuckets`로 처리하지만 replay는 200봉에서 끊긴다. sparse session에서 이 차이가 누적된다.
4. **`lastPriceByPool` 업데이트 경로**: live는 swap별 가격, replay는 candle close만 본다. `getCurrentPrice` 정확도가 달라 하위 연산에 영향.

### 6. 실측 증거

동일 profile `vm2.4-br0.65-lb20-cd180`의 9 세션 aggregate:

| Metric | Swaps | Candles | Ratio |
|---|---:|---:|---:|
| total processed signals | 1117 | 596 | 53% |
| gate-pass | 6/9 | 1/9 | 17% |
| weighted adj return | +24.62% | +5.00% | 20% |

Candles mode는 swaps 대비 **signal 수의 절반**만 만든다. 이건 candles replay가 동일 세션에서
trigger 기회를 근본적으로 적게 제공한다는 뜻이다 — 누락된 synthetic zero-volume lookback 때문에
`insufficientCandles` 또는 `idlePairSkipped`에서 더 많이 drop되거나, lookback 평균 계산이
다르게 나와 `volumeInsufficient`로 reject되는 것으로 추정.

이 차이는 "parameter의 실제 차이"가 아니라 **replay infrastructure의 fidelity 차이**다.

## Consequences

### 즉시 조치

1. **Swaps sweep 결과만 신뢰**. candles sweep은 P1-P3 의사결정에 사용 금지.
2. 2026-04-06 bootstrap-candles sweep 결과는 **historical artifact**로 분류 (삭제는 하지 않되, best profile selection의 근거로 쓰면 안 됨).
3. `STRATEGY_NOTES.md`에 "candles replay는 lossy reconstruction, swaps가 truth" 1 문장 고정.

### 04-06 swaps sweep 결과 재해석

`vm2.4-br0.65-lb20-cd180` signal-weighted +24.62% = **signal generation 관점에서 live와 동등한 결과**.
단, 이는 여전히:
- 2 outlier 세션(03-31, 04-06)이 75% 기여 (LOO 검증 필요 — P2)
- execution layer(slippage/latency/MEV)가 반영 안 된 upper bound (paper reality check 필요 — P3)

### candles mode의 미래 역할

candles replay는 폐기하지 않되 다음 용도로만 유지:
- raw-swaps 파일이 없는 세션의 emergency fallback
- micro-candles.jsonl의 storage integrity 확인용 sanity check
- storage-level 재해석 (lossy reconstruction임을 명시)

**사명 관련 의사결정에는 사용 금지.**

## Answer to P0 Question

> "어느 입력 경로가 live에 더 가까운가?"

**Swaps replay는 live signal generation의 perfect reproduction이다.**
- Swap source 차이(WS vs file)를 제외하면 code path 100% 일치.
- Execution layer는 replay의 범위 밖이며, 이는 P3 paper reality check에서 측정한다.

**Candles replay는 체계적으로 더 보수적인(fewer signals) 결과를 낸다.**
- 원인은 `micro-candles.jsonl`이 `tradeCount > 0` candle만 저장하고,
  replay의 `fillCandleGaps`가 live의 `fillMissingBuckets` + `checkAndCloseCandles` sweep을
  완벽히 재현하지 못하기 때문.
- 9 세션에서 processed signals가 swaps의 53%, gate-pass 17%로 드러남.

## Remaining Open Items

1. **swap sanitizer 차이**: `sanitizeReplaySwaps` (replay)와 live의 `swapSanitizer.ts` 간 drop rule 동등성 검증 — 다음 audit 사이클 스코프. 현재 가정: 동일한 drop rule.
2. **pool context 차이**: live는 `bootstrapTrigger.setPoolContext(pair, { marketCap })`을 universe engine에서 주입. Replay는 sweep 실행 시 marketCap context가 없는 상태로 trigger가 돌 수 있음. 이게 `volumeMcapBoosted` trigger path를 차단할 수 있으므로 signal 수에 영향 가능. P1 이후 조사 권고.
3. **ATR 계산 일관성**: `calcATR` 입력 window가 양 경로에서 동일하게 형성되는지 sanity test 권고 (micro-backtest test case).

## References

- Verdict 근거 코드:
  - `src/index.ts` line 1025 (live builder construction), line 1220 (live trigger call)
  - `src/backtest/microReplayEngine.ts` line 89-128 (swaps path), line 319-342 (candles path)
  - `src/realtime/microCandleBuilder.ts` line 56-62 (ingestClosedCandle), line 64-89 (applySwapEvent)
  - `src/strategy/volumeMcapSpikeTrigger.ts` line 89-99 (onCandle, getRecentCandles usage)
- Data artifact (2026-04-06 full sweep):
  - `results/session-replay-sweep-bootstrap-swaps-full-2026-04-06.md`
  - `results/session-replay-sweep-bootstrap-candles-full-2026-04-06.md`
- Prior context: `docs/exec-plans/completed/20260406-audit-note.md`
