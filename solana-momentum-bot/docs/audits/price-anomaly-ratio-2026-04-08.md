# Price Anomaly Ratio Investigation

> Generated: 2026-04-08 (ralph-loop iter8, Phase 1 read-only diagnosis)
> Updated: 2026-04-08 (ralph-loop iter9, Phase 1B IDL verification — 1순위 100% 확정)
> Window: 2026-04-07T15:13:02.733Z ~ 2026-04-07T22:13:02.733Z (7h)
> Source: live session `2026-04-07T14-35-58-100Z-live`
> Trigger: Codex 운영로그 분석 (15/28 signals = `[PRICE_ANOMALY_BLOCK]`)

## TL;DR

`assertEntryAlignmentSafe` 가드는 **올바르게 작동 중**이다 — true positive 차단이지 false positive가 아니다. 다만 **차단의 원인은 timing/sandwich가 아니라 candle.close 산출 path의 오염**이다. 7h window 15건 차단은 모두 두 토큰(pippin, swarms)에서 발생했고, 각 토큰별로 ratio가 거의 일정하다 (pippin ~0.185, swarms ~0.031). 같은 토큰에서 성공/실패가 interleave한다는 점이 결정적 — 토큰 고정 unit bug가 아니라 **swap parser path 분기 차이**가 원인 후보다.

코드 변경은 본 audit 단독으로 결정하지 않는다. **Phase 1B**에서 1건의 txSignature를 on-chain으로 직접 verify한 뒤, 4 후보 중 하나로 verdict를 좁혀 fix를 결정한다.

## Hard Data

### Status distribution (7h)

| Status | Count |
|---|---:|
| execution_failed | 15 |
| risk_rejected | 9 |
| executed_live | 4 |
| **Total** | **28** |

### Ticker distribution

100% 두 ticker: pippin 14, swarms 14

### Per-ticker × status

| ticker | execution_failed | risk_rejected | executed_live |
|---|---:|---:|---:|
| pippin | 7 | 5 | 2 |
| swarms | 8 | 4 | 2 |

### Time-ordered sequence (PRICE_ANOMALY_BLOCK)

```
16:59 pippin fail ratio=0.189321 planned=0.00230067 actual=0.00043557
17:15 pippin fail ratio=0.189805 planned=0.00230129 actual=0.00043679
17:21 pippin fail ratio=0.189749 planned=0.00229953 actual=0.00043633
17:28 pippin fail ratio=0.184347 planned=0.00233329 actual=0.00043014
17:33 pippin fail ratio=0.181929
17:51 pippin SUCCESS  ← 성공 interleaved
18:01 pippin fail ratio=0.183856
18:09 pippin fail ratio=0.182588
18:16 pippin SUCCESS  ← 성공 interleaved
20:01 swarms fail ratio=0.032247
20:11 swarms fail ratio=0.032666
20:28 swarms fail ratio=0.031573
20:35 swarms fail ratio=0.031059
20:40 swarms fail ratio=0.030974
20:55 swarms fail ratio=0.031667
21:04 swarms fail ratio=0.031633
21:13 swarms SUCCESS  ← 성공 interleaved
21:48 swarms fail ratio=0.030023
21:58 swarms SUCCESS  ← 성공 interleaved
```

### Per-ticker constants

| ticker | mc | volumeMcap | TVL | failure ratio (mean) | inflation |
|---|---:|---:|---:|---:|---:|
| pippin | $34.2M | 0.15 | $4.7M | 0.185 | 5.41× |
| swarms | $14.7M | 0.17 | $1.6M | 0.031 | 32.26× |

**핵심 관찰**:
1. ratio가 토큰별로 다르지만 같은 토큰 내에서는 거의 일정 (pippin σ < 5%, swarms σ < 8%)
2. 같은 토큰에서 성공/실패가 30분 내에 interleave — 토큰 영구 unit bug 아님
3. inflation 5.41× / 32.26× — 정수 decimals shift (10^k) 가 아니므로 단순 decimals 누락 아님

## Code Path Analysis

### Guard implementation
`src/orchestration/tradeExecution.ts:893-935` `assertEntryAlignmentSafe`
```typescript
const ratio = actualEntryPrice / plannedEntryPrice;
if (ratio < 0.7 || ratio > 1.3) throw PriceAnomalyError(...);
```
- planned는 `executionSummary.plannedEntryPrice = order.price = signal.price`
- actual은 `executionSummary.entryPrice = actualInputUiAmount / actualOutUiAmount`

### Builder path (signalProcessor.ts:396-466)
`buildEntryExecutionSummary`은 `hasActualIn && hasActualOut` 양쪽 set일 때만 실측 사용. 한쪽만 있으면 둘 다 planned로 fallback (Phase A2 fix). 따라서 ratio 0.18~0.19이 나온다는 것은 **양쪽 다 실측 데이터**라는 의미.

### Executor (executor.ts:341-356)
`executeBuy`는 `executeSwap(SOL_MINT, order.pairAddress, amountLamports)`. Jupiter Ultra/v6 응답에서 `outputAmountResult`가 raw bigint, `getMintDecimals`로 decimals 해결. 로그의 `outputDecimals=6`이 정상 출력되는 것 확인 — **decimals 해결 path는 OK**.

### candle.close 산출 path
`microCandleBuilder.ts:144-180`: candle.close = swap.priceNative — 마지막 swap 그대로.

`swapParser.ts`에는 **5개 분기**가 있고 각각 priceNative 산출 방식이 다르다:

1. **`parseFromPoolMetadata`** (line 281, 신뢰 path):
   - `sumMintDelta`로 baseMint/quoteMint별 모든 account delta 합산
   - 잠재 위험: pool vault + user ATA + fee/cashback account 모두 합산되면 net delta가 swap volume이 아닌 fee 잔여로 나올 수 있음 (단, 둘 다 0이면 line 292 reject)

2. **`parsePumpSwapFromTransaction` → `parsePumpSwapInstruction`** (`pumpSwapParser.ts:86-129`):
   - instruction data offset 8/16에서 `baseRaw`/`quoteRaw` 직접 디코딩
   - **잠재 큰 위험**: PumpSwap의 buy 함수가 `(amount, max_sol_cost)` 시그니처면 offset 16의 `quoteRaw`는 **사용자가 지정한 slippage upper bound**이지 actual fill 아님
   - max_sol_cost 5× 설정 시 → priceNative 5× 인플레이션 → 정확히 pippin 패턴
   - max_sol_cost 32× 설정 시 → 정확히 swarms 패턴
   - 같은 토큰의 거래라도 각 트레이더가 다른 max_sol_cost를 설정할 수 있으므로 **success/failure interleave 설명 가능**

3. **`parsePumpSwapFromLogs`** (line 29-57): log regex 기반, raw integer를 그대로 읽어 decimals 미보정. CRITICAL_LIVE에서 이미 P0-B로 식별되어 disable됨

4. **Generic logs** (`tryParseSwapFromLogs` line 92-140): regex `price_native|price|execution_price` 직접 추출, decimals 미보정. PumpSwap pool은 line 95에서 reject되므로 pippin/swarms는 미해당

5. **Largest-delta fallback** (line 188-208): pool metadata 없을 때, `tokenDeltas`의 첫 positive/negative 값. 멀티홉 swap에서 intermediate token이 잡히면 inflation 가능

## Suspect Ranking

**1순위**: `parsePumpSwapInstruction` offset 16 = `max_sol_cost` 디코딩 (확률 ~70%)
- 패턴 일치: 토큰별 일정 ratio + 성공/실패 interleave + 정수 아닌 inflation
- 검증: PumpSwap on-chain instruction layout 확인 1건 + 해당 swap의 actual SOL movement vs decoded quoteRaw 비교

**2순위**: `parseFromPoolMetadata` sumMintDelta가 멀티 account 사이에서 partial delta만 잡음 (확률 ~20%)
- 패턴 부분 일치: 토큰별 다른 inflation 가능
- 검증: 1건의 tx의 preTokenBalances/postTokenBalances 직접 dump

**3순위**: `pickLargestTokenDelta` fallback에서 router/intermediate token이 잡힘 (확률 ~5%)
- 패턴 부분 일치
- 검증: pool metadata 존재 여부 확인. 있으면 line 162에서 reject되므로 미해당

**4순위**: Helius WS feed 자체가 잘못된 priceNative를 emit (확률 ~5%)
- 검증: heliusWSIngester.ts read

## Decisive Verification (Phase 1B prerequisite)

**1단계 — code-only 확인** (즉시 가능, no on-chain):
- `pumpSwapParser.ts` BUY_DISCRIMINATOR `[102, 6, 61, 18, 1, 218, 235, 234]` 의 PumpSwap 공식 IDL과 비교
- 만약 함수 시그니처가 `buy(amount: u64, max_sol_cost: u64, ...)`이면 offset 16은 100% max_sol_cost — **1순위 확정, fix 즉시**

**2단계 — on-chain 1건 verify** (1순위 확정 못 한 경우):
- 운영자가 1건의 PRICE_ANOMALY_BLOCK txSignature를 Solscan/Helius에서 조회
- preTokenBalances / postTokenBalances dump
- 어느 path가 이 swap을 candle에 넣었는지 (sourceLabel = `transaction` vs `logs`)
- 실제 base/quote uiAmount 측정해 candle.close 5×/32× inflation 재현 또는 부정

## Phase 1B Fix Candidates (verdict 의존)

| 1순위 확정 시 | parsePumpSwapInstruction 폐기. PumpSwap은 `parseFromPoolMetadata` 또는 신뢰 가능한 logs/event parser만 사용. tradeExecution.ts에 `[PUMP_SWAP_INSTRUCTION_PATH]` warning 추가 |
| 2순위 확정 시 | `sumMintDelta`에 user-account-only 필터링 (주소 기준 user wallet 한정). 또는 max(positive)·min(negative)만 사용 |
| 3순위 확정 시 | poolMetadata 강제 검증. fallback path 자체 차단 |
| 4순위 확정 시 | heliusWSIngester에 priceNative sanity check (last 5 ticks vs new tick > 3× → drop) |

## Operational Verdict (배포 결정 입력값)

**Phase A3 가드는 그대로 유지**. 이 가드가 잘못된 가격을 ledger에 진입시키지 않게 막아왔다. 옵션 D (운영 유지 + 진단 병행)는 안전 확인:
- 차단 path가 정상이고 손실은 cooldown으로 누적 보호 중
- 실손실 -0.0029 SOL은 daily 한도의 6%
- 단, 4 entry 0W 4L 100% 손실률은 Phase 2 (per-trade decomposition)에서 별도 분해 필요

**즉시 차단 우선순위**:
1. PumpSwap instruction-decode path 확인 (1순위, code-only)
2. 확인되면 즉시 disable + 단위 테스트 추가 + VPS 배포

**Phase A3 임계 조정 금지**: 5×/32× inflation이 사실이면 [0.7, 1.3]는 정확한 임계다. 늘리면 ledger 오염을 풀어준다.

## Phase 1B Verdict (iter9, 2026-04-08)

**1순위 100% 확정 — `parsePumpSwapInstruction` offset 16 = `max_quote_amount_in` (slippage upper bound)**

### IDL evidence

PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`) `buy` 함수 시그니처:

```
buy(
  base_amount_out: u64,        // offset 8 — 사용자가 받기를 원하는 정확한 base token 수량
  max_quote_amount_in: u64,    // offset 16 — 사용자가 지불 의사가 있는 quote token 최대치
  track_volume: OptionBool     // offset 24+ — volume 추적 여부
)
discriminator: [102, 6, 61, 18, 1, 218, 235, 234]  // sha256("global:buy")[0..8], 우리 코드와 일치
```

**소스**:
- [PumpSwap IDL Gist](https://gist.github.com/Taylor123/dcd9f3285ca105efdcdf98089a2b3198) — discriminator + arg 순서
- [pump-public-docs Program Instructions](https://deepwiki.com/pump-fun/pump-public-docs/4.2-program-instructions) — `buy(base_amount_out, max_quote_amount_in, track_volume)` 공식 시그니처
- [PumpSwap AMM Mechanism](https://deepwiki.com/pump-fun/pump-public-docs/4.1-pumpswap-amm-mechanism) — "instruction reverts if quote_amount_in > max_quote_amount_in"

### 의미

두 u64 필드 모두 **user intent** (worst case bound)이지 actual fill이 아니다:

- `base_amount_out` = 사용자가 받기를 원하는 lower bound (보통 expected_output × (1 − slippage_tolerance))
- `max_quote_amount_in` = 사용자가 지불 의사가 있는 upper bound (보통 expected_input × (1 + slippage_tolerance))

따라서 우리 코드 `parsePumpSwapInstruction`이 산출하는:

```typescript
priceNative = amountQuote / amountBase
            = max_quote_amount_in / base_amount_out
            ≈ expected_price × ((1 + slippage) / (1 − slippage))
```

는 **사용자의 worst-case price**이지 actual fill price가 아니다. 사용자가 큰 슬리피지 톨러런스를 설정할수록 ratio가 inflate된다:

| 슬리피지 톨러런스 | (1+s)/(1−s) | 우리가 본 패턴 |
|---:|---:|---|
| 50% | 3.0× | (관찰 안 됨) |
| 65~70% | ~5× | **pippin 5.41×** |
| 90~94% | ~30× | **swarms 32.26×** |

**3가지 모든 관찰 사실과 정합**:

1. ratio가 토큰별로 다르다 (✓) — 토큰별 typical 슬리피지 분포 다름 (멤코인 변동성 × volume 분포)
2. 같은 토큰 내에서 30분 내 success/failure interleave (✓) — swap별 (트레이더별) 슬리피지 설정 다름. 작은 슬리피지 swap이 candle.close가 되면 정상, 큰 슬리피지 swap이 candle.close가 되면 anomaly
3. inflation이 정수 decimals shift 아님 (✓) — 슬리피지는 임의 실수 비율

### Code path 정밀 확인 (iter9에서 추가 발견)

`src/realtime/swapParser.ts:142-209` `parseSwapFromTransaction`을 다시 읽었다:

```typescript
const metadataAware = meta ? parseFromPoolMetadata(tx, context) : null;
if (metadataAware && isPumpSwapPool(context.poolMetadata)) {
  return metadataAware;  // (a) PumpSwap pool은 parseFromPoolMetadata 우선
}
const parsedPump = parsePumpSwapFromTransaction(tx, context);
if (parsedPump) return parsedPump;  // (b) fallback: instruction decode
```

→ `parsePumpSwapInstruction`은 **fallback path**다. `parseFromPoolMetadata`가 null을 반환할 때만 호출된다.

production에서 PRICE_ANOMALY가 100% 발생한다는 것은 다음 둘 중 하나:

- **시나리오 X (1순위 진짜 fallback path)**: `parseFromPoolMetadata`가 어떤 이유로 null을 반환하고 있다 (예: pool vault 주소가 metadata.baseMint/quoteMint와 다른 ATA 구조, 또는 baseDelta/quoteDelta 중 하나가 0). 그래서 fallback인 `parsePumpSwapInstruction`이 worst-case price를 candle.close로 넣고 있다.
- **시나리오 Y (2순위)**: `parseFromPoolMetadata`는 정상 호출되고 return value도 null이 아니지만, sumMintDelta가 잘못된 값을 산출해 priceNative 자체가 inflated다. (이 경우 path label은 'transaction'으로 동일해서 source label로는 X/Y 구별 불가)

**추가 instrumentation 없이 X/Y를 구별할 수 없다.** 그러나 fix path는 동일하지 않다:

- 시나리오 X 해결책: `parsePumpSwapInstruction`을 priceNative 산출에서 폐기 (instruction이 user intent라 actual price를 알 수 없음). `parseFromPoolMetadata`가 null이면 swap 자체를 drop.
- 시나리오 Y 해결책: `sumMintDelta`에 user-account-only 필터링 또는 max(positive)·min(negative)만 사용.

### iter10 fix 결정

**옵션 A (보수적, 권장)**: 시나리오 X 가설로 즉시 fix.

1. `parsePumpSwapInstruction`을 즉시 폐기 또는 priceNative 산출 path에서 제외
2. `parseFromPoolMetadata`가 null이면 PumpSwap swap을 drop (skip), candle 생성 skip
3. unit test 추가:
   - PumpSwap buy instruction을 입력으로 받았을 때 priceNative 산출 안 함 (또는 throw)
   - `parseFromPoolMetadata`가 정상 작동하면 PRICE_ANOMALY 안 일어나는지 합성 tx로 검증
4. VPS 배포 후 7h 운영 → PRICE_ANOMALY rate 측정
5. **Decision tree**:
   - PRICE_ANOMALY rate < 10% → **시나리오 X 확정, 1순위 fix 성공, iter10 종결**
   - PRICE_ANOMALY rate 변화 없음 → **시나리오 Y 확정, iter11 sumMintDelta filter 진행**
   - PRICE_ANOMALY rate 일부 감소 (예: 50%) → 시나리오 X+Y 동시 발생, iter11도 병렬 진행

**옵션 B (계측 후 결정)**: `parsePumpSwapInstruction`에 진입할 때 `[PUMP_SWAP_INSTRUCTION_FALLBACK]` warning + count 로깅. 1주일 운영 후 호출 빈도가 N건/일이면 옵션 A로 진행, 0건이면 시나리오 Y 확정. 단점: 1주일 동안 PRICE_ANOMALY 계속 발생.

→ **옵션 A를 iter10에서 진행한다**. 1주일을 기다리는 비용 > 1순위 가설이 틀릴 위험.

## Next ralph-loop iter

- ~~iter9: 1단계 code-only verification (PumpSwap IDL discriminator 확인) → verdict~~ ✅ **완료, 1순위 100% 확정**
- **iter10**: 1순위 fix code 작성
  1. `src/realtime/pumpSwapParser.ts` `parsePumpSwapInstruction` priceNative 산출 path 폐기 (또는 명시적 throw, 또는 instruction parser 함수 자체 제거)
  2. `src/realtime/swapParser.ts` `parseSwapFromTransaction`에서 PumpSwap pool은 `parseFromPoolMetadata`만 사용하도록 수정 (fallback 차단)
  3. unit test 추가 (PumpSwap buy instruction 합성 tx → priceNative null/throw 확인)
  4. `npx tsc --noEmit` + `npx jest` 검증
  5. VPS 배포 + 7h 모니터링
- **iter11 (decision-tree)**: iter10 배포 후 PRICE_ANOMALY rate 변화 미관측 시 → 시나리오 Y 확정, `sumMintDelta` user-account-only 필터 추가
- **Phase 2 (별도 iter)**: 4 entries (PIPPIN×2, SWARMS×2) per-trade timeline decomposition (Phase 1과 분리)

## Cross-references

- [`CRITICAL_LIVE.md`](../../CRITICAL_LIVE.md) §7G — 이전 framing은 4-session 평균 (PRICE_ANOMALY 18%). 이번 7h live window는 100% (15/15). 두 framing 모두 유효, 적용 cohort/window 다름
- [`docs/exec-plans/active/edge-cohort-quality-2026-04-07.md`](../exec-plans/active/edge-cohort-quality-2026-04-07.md) Axis 2 — 두 ticker 100% 집중은 axis_2 acceptance 위반 (7h window `top_signal_pair / total_signals = 14/28 = 0.5`)
- F1-deep audit `docs/audits/exit-slip-gap-divergence-2026-04-07.md` — Phase A3 false positive rate가 본 audit 결과로 정량화되면 그쪽 최신화
