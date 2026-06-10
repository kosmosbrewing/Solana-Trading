# Phase 7 — KOL Candle Coverage 1.81% Root Cause

- Status: completed
- Updated: 2026-06-10
- Purpose: 05 리포트의 coverage 1.81% 가 "왜" 인지 가설 4개 (wiring / capacity / resolution / persistence) 를 코드 + 로컬 로그/ledger 로 정량 분해하고, bounded observe-only fix 의 근거를 기록.
- Data: `logs/bot-out.log` (05-18..05-22 KOL_CANDLE_COVERAGE 13,093 lines), `data/realtime/kol-tx.jsonl` (104,258 buys), `data/realtime/trade-markout-anchors.jsonl`, `data/research/candle-entry-proof/anchor_feature_mart.jsonl` (5,187 buy anchors), git history.

## 7.1 결론 (dominant cause 순)

| # | 가설 | 판정 | 기여도 (buy anchors 5,187 기준) |
|---|---|---|---|
| 1 | (a) Hook 자체가 audit window 대부분에 존재하지 않음 | **CONFIRMED — dominant** | **4,058 anchors (78.2%)** 가 hook 도입 전. 해당 구간 coverage 1.63% (scanner-session 우연 overlap 만) |
| 2 | (c) Pair/pool resolution 실패 (fresh pump.fun) | **CONFIRMED — post-deploy dominant** | post-deploy 1,129 anchors 중 **779 (69.0%) 구독 0회** → covered 0 |
| 3 | (b') TTL 7min 과 anchor 관측 창의 misalignment | CONFIRMED — secondary | post-deploy 1,129 중 174 (15.4%) — candle 은 있으나 [anchor−60s, anchor+300s] 창 미커버 |
| 4 | (d') 구독했는데 candle row 0 | partial | post-deploy 1,129 중 148 (13.1%, 35 unique mints) — parse miss / TTL 내 무거래 / 다른 pool 추정 |
| 5 | (b) Capacity starvation (8 targets) | **REJECTED (현 시점)** | live 구간 실측 max concurrent **7/8, eviction 0건** — resolution 8% 에선 cap 미달 |
| 6 | (d) Session-scoped persistence gating | **REJECTED** | `RealtimeReplayStore.appendCandle` 은 구독된 모든 pool 의 tradeCount>0 candle 을 active session dir 에 기록 — scanner session 과 무관 (`src/index.ts` candle handler, `src/realtime/replayStore.ts`) |

## 7.2 증거

### (a) Hook 도입 시점 — audit window 의 78% 에 메커니즘 부재

- `requestRealtimeCandleCoverage` / `ensureRealtimeCandleCoverage` / `kolRealtimeCandleTargets` 는 모두 **commit `35c6923` (2026-05-18 22:06 KST)** 에서 최초 도입 (`git log -S`). 그 이전 이력 없음.
- 첫 `[KOL_CANDLE_COVERAGE]` 로그: **2026-05-18 14:21:51 UTC** (`logs/bot-out.log`). audit window 05-02..05-22 의 마지막 ~3.5일만 hook 가동.
- Pre-deploy 4,058 anchors 의 covered 66건 (1.63%) 은 전부 scanner watchlist 우연 overlap (per-day 표에서 05-03 15.5% / 05-04 8.2% 가 출처).

### (c) Resolution 실패 — live 구간에서도 unique 후보의 92% 가 구독 실패

`bot-out.log` 05-18 14:21 .. 05-22 00:44 (13,093 requests):

| outcome | requests | share |
|---|---:|---:|
| `no_pool_context` | 11,893 | 90.8% |
| `subscribed` | 1,200 | 9.2% |

`no_pool_context` 의 resolverReason 분해:

| resolverReason | count | share | 해석 |
|---|---:|---:|---|
| `no_pairs` | 8,729 | 73.4% | DexScreener 에 pair 미색인 (fresh pump.fun, resolvedDex=none) |
| `unsupported_pool_program` | 2,935 | 24.7% | resolvedDex=pumpfun 2,462건 — **pump.fun bonding curve program 은 WS parser 미지원** (`SUPPORTED_REALTIME_POOL_PROGRAMS` = raydium/orca/pumpswap/meteora) |
| `non_sol_quote` | 196 | 1.6% | |
| `unsupported_dex` | 33 | 0.3% | |

- Unique mint 기준: 후보 2,910 mints 중 **234 (8.0%) 만 구독 성공** (898 registry_context + 302 token_pair_resolver, `kol_tx_pool` 경로 **0건** — KolTx 의 `poolAddress` 가 항상 미파싱 `requestPool=missing`).
- 실제 진입 (anchor) 토큰조차 post-deploy 312 unique mints 중 78 (25%) 만 구독됨.

### (b') TTL misalignment — 구독은 됐는데 창이 어긋남

post-deploy 1,129 anchors 중 구독 이력 있는 mint 의 350 anchors 분해:

| coverageReason | rows | share | TTL 연장으로 회수 가능? |
|---|---:|---:|---|
| `no_token_candles` | 148 | 42.3% | × (구독 자체가 candle 0) |
| `candles_end_before_pre_window` | 47 | 13.4% | **○** (TTL 만료 후 anchor) |
| `candles_start_after_horizon` | 44 | 12.6% | × (anchor 이후에야 구독 성공 — resolution 지연) |
| `post_window_missing` | 39 | 11.1% | **○** (anchor+300s 전 TTL 만료) |
| `candle_gap_around_anchor` | 30 | 8.6% | △ (sparse 거래) |
| `pre_window_missing` | 14 | 4.0% | △ (seed backfill miss) |
| **`covered`** | **28** | **8.0%** | — |

구독 시작 (KOL buy) → smart_v3/rotation entry 까지 stalk/관측 지연 + chase/topup 재anchor 가 7분 TTL 을 초과하는 구조. TTL 직접 회수 대상 = 47+39 = **86 rows (post-deploy 의 7.6%p)**.

### (b) Capacity — 현재는 non-binding, resolution 개선 시 binding 전환

- Live 구간 실측 (subscribed 로그 1,200 events, per-mint dedup): newSubs 408, **max concurrent 7 (cap 8), eviction 0건**. TTL 15min 가정 재시뮬에서도 eviction 0.
- Counterfactual (resolution 100% 가정, `kol-tx.jsonl` 05-02..22 실 arrival: 104,258 buys / 21,804 unique mints / ~1,090 mints/day):

| cap | TTL | eviction rate | ≥360s 생존 |
|---:|---:|---:|---:|
| 8 | 7min | 57.7% | 58.6% |
| 12 | 7min | 26.0% | 86.0% |
| 16 | 7min | 8.4% | 96.8% |
| 16 | 15min | 54.9% | 96.7% |

→ resolution 이 고쳐지는 순간 cap 8 이 새 병목이 된다. 이번에 추가한 eviction telemetry 가 그 전환 시점을 알려준다.

### (d) Persistence — 기각

`realtimeCandleBuilder.on('candle')` → `realtimeReplayStore.appendCandle` 은 **구독된 모든 pool** 의 tradeCount>0 candle 을 현재 session dir (`data/realtime/sessions/<startup>/micro-candles.jsonl`) 에 기록한다. scanner session 소속 여부 gating 없음. "no scanner session covers them" 가설은 코드상 성립하지 않음. (148건의 zero-candle 은 persistence 가 아니라 구독 자체가 데이터를 못 만든 경우 — 35 mints 중 34 가 token_pair_resolver 경로.)

## 7.3 Expected coverage

| 시나리오 | full coverage 기대치 |
|---|---|
| 현행 유지 (hook 가동만) | ~2.5% (post-deploy 실측 2.48%) |
| **이번 fix (TTL 7→15min + telemetry)** | **~6-9%** (회수 가능 86 rows 의 50-100% + 기존 28 → 71-114/1,129) |
| + resolution fix (아래 follow-up) | 신호 발생 pool 의 parse 가능 비율에 종속 — pumpfun bonding 지원 + KolTx poolAddress 파싱 시 **50-80%** (05 리포트의 80%+ 는 resolution 없인 도달 불가) |

### Follow-up levers (이번 scope 밖, resolution 70% 버킷의 실제 해법)

1. **KolTx `poolAddress` 추출**: KOL swap parse (heuristic) 가 pool 을 안 넘겨서 `kol_tx_pool` 직행 경로가 dead (`requestPool=missing` 100%). 추출되면 DexScreener resolution 자체가 불필요.
2. **pump.fun bonding curve WS parser**: `unsupported_pool_program` 24.7% (resolvedDex=pumpfun 2,462건) 직접 해소. 신규 parser 작업 — 별도 ADR 필요.
3. `no_pairs` (73.4%) 는 1번이 해결하거나, negative-cache TTL 단축 재시도 (DexScreener rate-limit trade-off) 로 부분 완화.

## 7.4 구현된 bounded fix (observe-only)

| 항목 | 내용 | 기본값 |
|---|---|---|
| `KOL_REALTIME_CANDLE_TARGET_TTL_MS` | KOL 후보 candle 구독 TTL env knob (`src/config/kolHunter.ts`) | **900000 (15min, 기존 7min hardcode 에서 상향)** — live 구간 재시뮬 eviction 0 확인 |
| `KOL_REALTIME_CANDLE_TARGET_MAX` | 동시 구독 target 수 env knob | **8 (기존값 유지)** — `realtimeMaxSubscriptions` (30) 으로 hard clamp |
| `src/realtime/kolCandleCoveragePolicy.ts` | clamp (`resolveKolCandleCoverageLimits`) + capacity eviction 선택 (`selectKolCandleCoverageEvictions`) 순수 함수 | TTL 하한 60s / max 하한 1 / NaN → default |
| `src/realtime/kolCandleCoverageTelemetry.ts` | 일별 funnel counter → `data/realtime/kol-candle-coverage-telemetry.jsonl` (requested / resolveMiss by reason / subscribedNew / refreshed / seedSwaps / capacityEvicted / ttlExpired / replaced). UTC day rollover `day_final` + 60min `interval` snapshot, fail-open append | 자동 (realtime mode 한정) |
| `src/index.ts` | hardcode 상수 → config, eviction/TTL/replace cause 별 telemetry 계측, startup 에 limits 로그 | — |
| `src/init/setupShutdown.ts` | 종료 시 telemetry timer stop + partial flush | — |

**불변 보장**: live entry/exit 판단 경로 변경 0. Real Asset Guard / cupsey lane 미접촉. WS churn guard (watchdog 300s / reconnect cooldown 300s, `heliusWSIngester.ts`) 미변경 — TTL 연장은 오히려 subscribe/unsubscribe churn 을 줄이는 방향. 신규 paid RPC 0 (pair resolve cache 10min 유지, seed backfill 경로 불변).

**다음 run 검증 방법**: `kol-candle-coverage-telemetry.jsonl` 의 `day_final` 라인에서 `subscribedNew / requested` (resolution rate), `capacityEvicted` (cap 병목 전환 여부), `resolveMiss` 분포 (no_pairs vs unsupported_pool_program) 를 읽고, `npm run` candle-entry-proof 재생성으로 post-fix full coverage 를 비교한다.

## 7.5 Tests

- `test/kolCandleCoveragePolicy.test.ts` (6) — env clamp / cap / NaN fallback / eviction 선택 (max 하향 포함).
- `test/kolCandleCoverageTelemetry.test.ts` (4) — funnel 누적 / UTC rollover day_final / interval flush idle-skip / fail-open.
- 기존 `kolCandleCoverageResolver` / `kolSignalHandler` / `realtimeEligibility` suites 통과, `npm run typecheck` + `npm run env:check` 통과.
