# KOL Candle Coverage Repair — Pool Resolution ADR

> Date: 2026-06-10
> Status: **Lever 1 구현 완료** / Lever 2 보류 (trigger 조건 명시)
> Authority: `analysis/edge-audit-2026-06-10/reports/07_CANDLE_COVERAGE_ROOT_CAUSE.md`
> Scope: observe-only 관측 인프라. live entry/exit 판단 경로 변경 0, Real Asset Guard 무접촉, 신규 paid API 0.

## 1. Context

Edge audit 07 이 KOL candle full coverage 1.81% 의 원인을 정량 분해했다:

| 버킷 | 비중 (post-deploy 요청 기준) | 이번 ADR 대응 |
|---|---|---|
| `no_pairs` (DexScreener 미색인) | 73.4% | **Lever 1** (WS 지원 프로그램 분) + Lever 2 (bonding curve 분) |
| `unsupported_pool_program` (pump.fun bonding) | 24.7% | Lever 2 |
| TTL misalignment | 7.6%p | 기존 fix (TTL 7→15min) 완료 |

핵심 관찰: **KOL swap tx 자체가 pool 주소를 이미 담고 있다.** DexScreener 색인을 기다릴 이유가 없다 — `getParsedTransaction` 결과의 DEX instruction 계정 배열에서 pool 을 추출하면 resolver 1순위 경로(`kol_tx_pool`, 기존 dead — `requestPool=missing` 100%)가 살아난다.

차기 신호 가설이 무엇이든 candle coverage 없이는 또 "측정 불가(MEASUREMENT_INVALID)"로 끝난다 — 이 수리는 특정 전략이 아니라 **차기 검증 인프라**다.

## 2. Lever 1 — KolTx poolAddress 추출 (구현 완료)

### 구현

| 파일 | 내용 |
|---|---|
| `src/realtime/kolSwapPoolExtractor.ts` (신규) | pure function `extractKolSwapPool(tx, tokenMint, wallet)` — top-level + inner instruction 에서 프로그램별 인덱스로 pool 추출 |
| `src/ingester/kolWalletTracker.ts` | `handleLog` 에서 추출 후 `KolTx.poolAddress/dexId/dexProgram/routeKind` 채움 (실패해도 swap emit 불변) |
| `src/realtime/realtimeEligibility.ts` | `isWsSupportedPoolProgram()` — WS candle parser 지원 프로그램 union |
| `src/realtime/kolCandleCoverageResolver.ts` | `kol_tx_pool` 직행은 **WS 지원 프로그램일 때만** — 미지원 pool 구독은 candle 0 인 채 capacity slot 만 소모 (07 의 (d') 버킷 재발 방지) |

### 프로그램별 pool 계정 인덱스 (IDL swap layout 기준)

| 프로그램 | dexId | pool index | WS 지원 |
|---|---|---|---|
| Raydium V4 / CLMM / CPMM | raydium | 1 / 2 / 3 | ✅ |
| Orca Whirlpool (swap / swapV2) | orca | 2 / 4 | ✅ |
| Meteora DLMM / DAMM v1 / v2 | meteora | 0 / 0 / 1 | ✅ |
| PumpSwap AMM | pumpswap | 0 | ✅ |
| pump.fun bonding curve | pumpfun | 3 | ❌ (Lever 2) |

### 오인 방지 (인덱스 가정의 안전망)

1. 해당 instruction 이 **이 tokenMint 의 token account 를 실제로 포함**할 때만 추출 (pre/post token balances 교차 검증).
2. 추출 계정이 mint / wallet / token account / 알려진 시스템·프로그램 계정이면 기각.
3. Jupiter aggregator program 존재 시 `routeKind='aggregator'` — inner instruction 의 실 DEX hop 에서 추출.
4. 잘못 추출돼도 영향 반경 = 관측 구독 slot 1개 (거래 판단 무관). telemetry 의 zero-candle 버킷으로 표면화.

### 기대 효과

- `no_pairs` 73.4% 중 **WS 지원 프로그램에서 거래된 분**은 DexScreener 없이 즉시 구독. fresh pumpswap/raydium pair 가 주 수혜.
- bonding curve 거래분은 추출은 되나 (provenance 기록) 구독은 gate 가 차단 — Lever 2 착륙 시 코드 변경 없이 자동 활성.
- 검증 지표 (다음 observe run): telemetry `resolveMiss` 분포 감소 + subscribed 로그의 `source=kol_tx_pool` 등장 + candle-entry-proof full coverage 재측정.

## 3. Lever 2 — pump.fun bonding curve WS parser (보류)

**내용**: `SUPPORTED_REALTIME_POOL_PROGRAMS` 에 bonding curve program (`6EF8rrec…`) 추가 + bonding curve swap 의 candle 변환 parser (pumpSwapParser 의 `parseFromPoolMetadata` 패턴 — token balance delta 기반, instruction payload 파싱 금지: price-anomaly-ratio-2026-04-08 교훈).

**보류 이유**: 신규 parser 는 WS ingester 의 hot path 에 들어가므로 (구독 메시지 파싱), 검증 없이 추가하면 잘못된 candle 이 차기 가설의 측정을 오염시킨다. Lever 1 의 telemetry 로 실수요를 먼저 측정한다.

**착수 trigger (하나라도 충족 시)**:
1. 다음 observe run 에서 KolTx 추출 중 `dexId=pumpfun` 비중 ≥ 30% (bonding 거래가 coverage 의 실 병목임이 확인)
2. Lever 1 적용 후 full coverage 가 20% 미만에서 plateau
3. 차기 신호 가설이 bonding curve 단계 토큰을 명시적으로 요구

**완료 기준**: synthetic fixture + 실 기록 swap replay 로 candle 정합 검증 후에만 prod 활성. observe run 1회에서 기존 pumpswap candle 과 가격 연속성 확인.

## 4. 부수 결정

- **negative-cache TTL 단축 재시도** (no_pairs 부분 완화책): 비채택 — Lever 1 이 같은 버킷을 API 호출 0 으로 해소하므로 DexScreener rate-limit trade-off 를 질 이유 없음.
- capacity cap 8 유지: resolution 이 좋아지면 cap 이 새 병목이 된다 (07 §counterfactual — resolution 100% 가정 시 eviction 57.7%). `capacityEvicted` telemetry 가 누적되면 `KOL_REALTIME_CANDLE_TARGET_MAX` 상향을 별도 검토 (Helius 구독 30 cap 내 clamp).

## 5. Tests

- `test/kolSwapPoolExtractor.test.ts` (7) — 직행/aggregator/bonding/swapV2 memo skip/token-account 미접촉 기각/비정상 layout 오인 방지.
- `test/kolCandleCoverageResolver.test.ts` — WS 지원 gate (bonding 차단 + dexProgram 미상 시 fallback) 추가.
- 기존 `kolWalletTracker` suite 회귀 통과.
