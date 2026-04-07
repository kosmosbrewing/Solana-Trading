# Audit: exit_slippage_bps vs exit_gap_pct Divergence

> Status: complete
> Updated: 2026-04-07
> Origin: `docs/ops-history/2026-04-07.md` Entry 02 — F1 (Action escalation)
> Source incident: `avg_exit_slippage_bps_recent_7h=2500.5` vs `avg_exit_gap_pct_recent_7h=-0.30%`

## Question

Entry 02 (post-guard session, 2026-04-07T04:01:48Z ~ 11:01:48Z, 4 closed rows)에서:

- `avg_exit_slippage_bps_recent_7h: 2500.5` (= 25%)
- `avg_exit_gap_pct_recent_7h: -0.30%`

두 metric은 같은 row 집합에서 계산됐는데 산술적으로 25%와 0.30%가 동시에 나올 수 있는가? 단위 또는 reference 가격 버그인가?

## Code Path Comparison

### 1) `exit_slippage_bps` 산출 경로 — `src/orchestration/tradeExecution.ts:closeTrade`

```typescript
// line 583-624
const tokenBalance = await ctx.executor.getTokenBalance(trade.pairAddress);
if (tokenBalance > 0n) {
  const solBefore = await ctx.executor.getBalance();
  const sellResult = await ctx.executor.executeSell(trade.pairAddress, tokenBalance);
  // ...
  const solAfter = await ctx.executor.getBalance();
  const receivedSol = solAfter - solBefore;

  if (receivedSol > 0 && trade.quantity > 0) {
    exitPrice = receivedSol / trade.quantity;       // ← (A) bot이 계산한 fill price
  }
  // ...
  executionSlippage = sellResult.slippageBps / 10000;  // ← (B) Jupiter Ultra 보고값
}

// line 633
const exitSlippageBps =
  ctx.tradingMode === 'live' ? Math.round(executionSlippage * 10000) : undefined;
```

핵심:
- `exit_slippage_bps`는 **Jupiter Ultra Execute API의 `sellResult.slippageBps`를 원본 그대로 저장**.
- 즉 `slippageBps`는 Jupiter route quote 시점의 `expected price` 대비 `executed price`의 차이를 Jupiter가 자체 계산한 값. quote-to-fill 측정.
- 이 값은 **bot의 decision price와 직접 관련 없음**. quote는 swap 직전에 호출된다.

### 2) `decision_price` 산출 경로 — `src/orchestration/tradeExecution.ts:closeTrade`

```typescript
// line 631
const decisionPrice = paperExitPrice;  // 트리거 판정 시 currentPrice (e.g. takeProfit2Price, stopLossPrice)
```

호출 사이트 예 (line 451, 487, 506, 535):
- `takeProfit2Price = currentPrice >= trade.takeProfit2 ? currentPrice : trade.takeProfit2`
- `stopLossPrice = currentPrice <= trade.stopLoss ? currentPrice : trade.stopLoss`

→ `decision_price`는 **트리거 판정 시점의 candle/realtime price**이며 swap 전에 결정된다. swap 실행 시점과 시간차가 있을 수 있다.

### 3) `exit_gap_pct` 산출 경로 — `scripts/trade-report.ts:printCostAggregation`

```typescript
// line 330-339
if (withGap.length > 0) {
  const gaps = withGap.map((t) => {
    const dp = Number(t.decision_price!);
    const xp = Number(t.exit_price!);
    return dp > 0 ? ((xp - dp) / dp) * 100 : 0;
  });
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  // ...
}
```

핵심:
- `exit_gap_pct = (exit_price − decision_price) / decision_price * 100`
- 두 값 모두 DB column에서 직접 읽음
- exit_price = `receivedSol / trade.quantity` (bot 계산 fill)
- decision_price = `paperExitPrice` (트리거 판정가)
- **이 값은 Jupiter slippage와 무관하게 bot의 자체 측정**

## Reference Price Comparison Table

| Metric | Reference (numerator) | Reference (denominator) | Source |
|--------|-----------------------|--------------------------|--------|
| `exit_slippage_bps` | Jupiter executed price (route fill) | Jupiter quoted price (route quote) | Jupiter Ultra Execute API |
| `exit_gap_pct` | bot 계산 fill price (`receivedSol / qty`) | bot decision price (트리거 currentPrice) | bot 자체 측정 |

→ **두 metric은 서로 다른 reference로 측정**된다. quote vs decision은 다른 시점, 다른 가격이며 단위 호환 불가.

## Conclusion: 단위 버그 아님 — Outlier 1건이 평균을 끌어올린 결과

### 산술 검증

Entry 02 closed rows: 4건

- 가설 A: 1건이 saturated (10000 bps), 나머지 3건이 ~0 bps
  - 평균 = (10000 + 0 + 0 + 0) / 4 = **2500 bps** ← 측정값 2500.5와 정확히 일치
- 가설 B: 4건 모두 ~2500 bps
  - 가능하나, ops-history note line 167 (`exit_slip=10000bps가 동시에 기록`)이 outlier 존재를 시사

→ **가설 A가 강력 지지**된다.

### 왜 `exit_gap_pct`는 -0.30%인가?

가설 A의 saturated row가 fake-fill일 경우, 두 가지 케이스:

1. **fake-fill but receivedSol > 0 case**: Jupiter가 saturated slippage를 보고했지만 swap이 부분 체결됨. `exitPrice = receivedSol / quantity`는 정상 산출되고 decision_price에 우연히 가까울 수 있다.
2. **fake-fill detection이 작동한 경우**: `tradeExecution.ts:47` `detectFakeFill`이 (line 96 `resolveExitFillOrFakeFill` 안에서) 호출되어 `fakeFillAnomalyReason` 플래그가 set. 그러면 row의 `exit_anomaly_reason` 컬럼에 마킹된다.

이미 `trade-report.ts:369-376`에 다음 경고가 있다:

```typescript
const fakeFillRows = trades.filter((t) =>
  (t.exit_anomaly_reason != null && t.exit_anomaly_reason.length > 0) ||
  (t.exit_slippage_bps != null && t.exit_slippage_bps >= FAKE_FILL_SLIPPAGE_BPS_THRESHOLD)
);
if (fakeFillRows.length > 0) {
  console.log(`\n ⚠ FAKE-FILL WARNING: ${fakeFillRows.length}/${trades.length} rows contain saturated slippage or anomaly markers.`);
  console.log(`   → Aggregations above (esp. exit slippage avg) are distorted. Filter and re-run for clean view.`);
}
```

즉 trade-report는 **이미 이 outlier 효과를 인지하고 경고를 출력**하고 있으나, ops-history Entry 02의 metric 발췌에는 그 경고 문구가 포함되지 않았다.

## Cross-Reference: CRITICAL_LIVE §7E sanitizer

`src/reporting/edgeInputSanitizer.ts:117` 도 동일 임계값(9000 bps)을 사용해 EdgeTracker 입력에서 saturated slippage row를 자동 격리한다:

```typescript
if (trade.exitSlippageBps != null && trade.exitSlippageBps >= FAKE_FILL_SLIPPAGE_BPS_THRESHOLD) {
  // drop reason: saturated_exit_slippage
}
```

→ EdgeTracker 학습 측면에서는 이미 outlier가 격리되고 있다. 따라서 sanitizer는 **execution / report quality 도구로 작동 중**이며 별도 수정 불필요.

## Anomaly Marker Catalog

`exit_anomaly_reason` 컬럼에 저장되는 모든 marker token. F1-deep-3 측정 시 이 카탈로그를 기준으로 카운트한다. `mergeAnomalyReasons`(`src/orchestration/tradeExecution.ts:120`)가 fake-fill helper와 Phase A4 reasons를 dedup한 뒤 comma-joined로 저장한다.

### Group 1 — fake-fill helper (`detectFakeFill` / `resolveExitFillOrFakeFill`)

`src/orchestration/tradeExecution.ts:47-58` (`detectFakeFill`) + `:75-114` (`resolveExitFillOrFakeFill`) — 4개 exit path 공통 호출 사이트(`closeTrade:257`, `handleDegradedExitPhase1:635`, `handleTakeProfit1Partial:1114`, `handleRunnerGradeBPartial:1242`).

| Marker | Trigger | 의미 |
|--------|---------|------|
| `fake_fill_no_received(<exitPath>)` | `receivedSol <= 0` | sell tx는 성공했으나 SOL 수령 0 — Jupiter Ultra `outputAmountResult="0"` 패턴. exitPrice는 fallback(decisionPrice/currentPrice)으로 마스킹됨 |
| `slippage_saturated=<bps>bps` | `slippageBps >= 9000` | Jupiter route quote 대비 fill price가 saturated 임계 도달. fallback path 또는 정상 path 양쪽에서 발생 가능 |

### Group 2 — Phase A4 close-time guards (`closeTrade` only)

`src/orchestration/tradeExecution.ts:662-720` — `closeTrade` 직후 ratio/gap/slippage 3중 cross-check (`exitAnomalyReasons`(:665) → `mergeAnomalyReasons`(:720)).

| Marker | Trigger | 임계 | 의미 |
|--------|---------|------|------|
| `exit_ratio=<value>` | `(exitPrice - entryPrice)/entryPrice` 가 `[EXIT_RATIO_MIN, EXIT_RATIO_MAX]` 밖 | `[-0.95, +10]` (line 24-25) | -95% 손실보다 더 크거나 +1000% 초과 — 단위 오염/fill 이상 의심 |
| `decision_fill_gap=<pct>%` | `\|gap\|` >= `DECISION_FILL_GAP_ALERT_PCT` | `0.5` (= 50%, line 29) | trigger 판정가 vs 실제 fill 가격 50% 이상 차이 — execution 시간차 또는 단위 오염 |
| `slippage_saturated=<bps>bps` | `tradingMode === 'live'` + `slippageBps >= 9000` | 9000 bps | Phase A4가 별도 감시(Group 1과 dedup됨). live 모드에서만 set |

### Group 3 — 병합 규칙 (`mergeAnomalyReasons`)

`src/orchestration/tradeExecution.ts:120-129`

- 입력: `fakeFillAnomalyReason` (Group 1, comma-joined string) + `exitAnomalyReasons[]` (Group 2, string[])
- 처리: split → trim → empty 제거 → `Set` 으로 dedup → comma join
- `slippage_saturated=<bps>bps`는 Group 1/2 양쪽에서 push될 수 있으나 dedup 후 1건으로 축소
- 결과가 빈 문자열이면 `undefined` 반환 → DB column NULL

### F1-deep-3 측정 절차

다음 ops loop entry 작성 시 아래 SQL 또는 동등 grep으로 카운트한다:

```sql
SELECT
  COUNT(*) FILTER (WHERE exit_anomaly_reason IS NOT NULL) AS marked_rows,
  COUNT(*) FILTER (WHERE exit_anomaly_reason LIKE '%fake_fill_no_received%') AS fake_fill_no_received,
  COUNT(*) FILTER (WHERE exit_anomaly_reason LIKE '%slippage_saturated%') AS slippage_saturated,
  COUNT(*) FILTER (WHERE exit_anomaly_reason LIKE '%exit_ratio=%') AS exit_ratio_violation,
  COUNT(*) FILTER (WHERE exit_anomaly_reason LIKE '%decision_fill_gap=%') AS decision_fill_gap_violation,
  COUNT(*) AS closed_rows
FROM trades
WHERE status = 'CLOSED' AND closed_at >= NOW() - INTERVAL '7 hours';
```

`fake_fill_rows_recent_7h` ops-history 필드는 `marked_rows / closed_rows`로 기록한다.

## Recommendation

**버그 아님 → 표시(presentation) 개선만 필요**:

1. `trade-report.ts`의 FAKE-FILL WARNING이 ops-history 작성 시 발췌 누락되지 않도록, ops-history Entry의 `metrics_note`에 saturated row count를 명시 필드로 추가
2. `avg_exit_slippage_bps`를 raw average와 outlier-removed average 두 줄로 출력 (median 또는 trimmed mean)
3. ops-history Entry 02 DB Anomalies note line 167은 이미 정확히 이 현상을 짚고 있음 → Action으로 escalation은 본 audit 결과로 종결

**근본 해결이 필요한 부분**:
- saturated slippage의 fake-fill 비율이 4 closed rows 중 1건 (=25%)이라는 사실. 표본이 너무 작아 일반화 어려우나, 다음 ops loop에서 동일 outlier 비율이 재현되는지 확인 필요.
- `next_window_utc: 2026-04-07T11:00:00Z ~ 2026-04-07T18:00:00Z` 측정 시 `fakeFillRows / closed_rows` 비율을 함께 기록.

## Action Items

| ID | Action | Owner | Status |
|----|--------|-------|--------|
| F1-deep-1 | trade-report에 raw vs trimmed avg slippage 두 줄 출력 | igyubin | done (2026-04-07, `scripts/trade-report.ts:290` `printSlippageRawAndTrimmed`) |
| F1-deep-2 | ops-history template `metrics_note`에 `fake_fill_rows / closed_rows` 권장 필드 추가 | igyubin | done (2026-04-07, `docs/ops-history/README.md` 핵심 관측치 + `docs/runbooks/live-ops-loop.md` Section 3A + Entry 02 소급 기록) |
| F1-deep-3 | 다음 ops loop entry에서 fake-fill ratio 재측정 | igyubin | open |
| F1-deep-4 | (해소) 단위/reference 버그 가설은 기각 — sanitizer가 이미 격리, 두 metric은 서로 다른 reference | — | resolved |
| F1-deep-5 | `scripts/analysis/realized-replay-ratio.ts`에 saturated/fake-fill row 격리 — parent group 단위 drop, edgeInputSanitizer와 동일 임계(`>=9000bps` 또는 `exit_anomaly_reason` set) | igyubin | done (2026-04-07, `filterAnomalousTradeGroups`) |

## History

- 2026-04-07: ops-history Entry 02 F1 escalation에서 시작, code path 비교로 단위 버그 가설 기각, outlier 1건 가설 확정
- 2026-04-07: F1-deep-1 적용 — `scripts/trade-report.ts`의 `printSlippageRawAndTrimmed` helper로 entry/exit slippage avg를 raw + trimmed(`>=9000bps` 제외) 두 줄로 출력하도록 변경. trimmed가 raw와 동일하면 contamination 없음을 시각적으로 확인 가능.
- 2026-04-07: F1-deep-2 적용 — `docs/ops-history/README.md` 핵심 관측치 권장 필드와 `docs/runbooks/live-ops-loop.md` Section 3A 기록 규칙에 `fake_fill_rows / closed_rows`를 추가. Entry 02 metrics에 측정값 1건(`1 / 4`) 소급 기록.
- 2026-04-07: Anomaly Marker Catalog 추가 — `tradeExecution.ts`의 fake-fill helper(Group 1)와 Phase A4 close-time guards(Group 2)가 set하는 5개 marker token을 카탈로그화. F1-deep-3 측정용 SQL 절차를 같이 고정.
- 2026-04-07: F1-deep-5 적용 — `scripts/analysis/realized-replay-ratio.ts`에 `filterAnomalousTradeGroups` 추가. saturated slippage(`>=9000bps`) 또는 `exit_anomaly_reason` set인 row가 포함된 parent group을 통째로 drop해 realized vs replay ratio가 1건 fake-fill로 왜곡되지 않도록 격리. 마크다운 헤더에 `raw / clean / excluded` 카운트 명시. 사전에 trade-report와 edgeInputSanitizer가 이미 동일 임계로 격리 중이었으나 본 스크립트만 누락되어 있던 drift를 해소.
