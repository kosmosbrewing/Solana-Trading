# STRATEGY.md (post-pivot)

> Status: current quick reference
> Updated: 2026-04-18
> Purpose: 현재 runtime 에서 읽어야 할 전략 / gate / risk / 핵심 파라미터를 짧게 정리한다.
> Pivot decision: [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md)
> Pre-pivot snapshot: [`docs/historical/pre-pivot-2026-04-18/STRATEGY.md`](./docs/historical/pre-pivot-2026-04-18/STRATEGY.md)
> Forward memo: [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md)

## Role

이 문서는 quick reference 다.

- 현재 구현 / 운영 기준만 짧게 담는다
- 전략의 구조적 한계나 다음 방향 메모는 [`STRATEGY_NOTES.md`](./STRATEGY_NOTES.md) 로 분리한다
- pivot 상세 근거는 [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md)

## Core Principle (post-pivot)

> 수단과 방법을 가리지 않고 `1 SOL -> 100 SOL` 달성 확률을 최대화한다.
> "왜 오르는가"보다 "지금 실제로 폭발하는가"를 본다.

## Runtime Lane Set

| Lane | 상태 | 역할 |
|---|---|---|
| **`cupsey_flip_10s`** | **benchmark (live-proven)** | 기존 구조 그대로 유지. A/B 비교 기준선. **개조 금지.** |
| `bootstrap_10s` | **signal-only** | cupsey trigger source. `executionRrReject=99.0` 로 실거래 100% 억제. |
| **`pure_ws_breakout`** | **implemented (paper-first, default off)** | convexity 사명 첫 구현 lane — immediate PROBE + tiered runner. `PUREWS_LANE_ENABLED=true` 로 활성. |
| `migration_reclaim` | backlog (code only) | Migration Handoff Reclaim lane. paper 대기. |
| `liquidity_shock_reclaim` | backlog | 미구현 |
| `volume_spike` | **dormant** | 5m 해상도, 밈코인 비적합 (04-05 확인) |
| `fib_pullback` | **dormant** | 5m 해상도, 밈코인 비적합 |
| `core_momentum` | standby | 3-AND trigger, 현재 비활성 |
| `new_lp_sniper` (Strategy D) | sandbox (live 미연결) | sandbox executor 미구현으로 live 차단 |

## Cupsey Benchmark Lane (개조 금지)

`cupsey_flip_10s` 는 현재 유일한 live-proven lane 이며 benchmark 로 유지한다.
pivot 이후에도 파라미터 / 구조 변경 없이 운영한다. 새 lane 의 wallet 성과를 여기 대비로 평가한다.

### 현재 파라미터 (변경 금지)

```text
Ticket            = 0.01 SOL fixed
STALK window      = 60s  (pullback entry 대기)
STALK drop        = -0.5% (cupseyStalkDropPct = 0.005)
STALK max drop    = -1.5% (crash skip)
PROBE window      = 45s
PROBE → WINNER    : MFE ≥ +2.0%
PROBE → REJECT    : MAE ≤ -0.8% OR 45s timeout
WINNER trailing   = 4.0%
WINNER max hold   = 12min (720s)
WINNER breakeven  = entry + 0.5% (MFE > +4% 일 때 활성)
HWM peak sanity   = entry × 15 (cupseyMaxPeakMultiplier)
Max concurrent    = 5
```

### Cupsey Signal Quality Gate

참고: 이 gate 는 **attention gate 가 아니다**. multi-bar momentum 지속성 (volume accel + price momentum + buy ratio + trade count) 검증 gate 다.

```text
Volume Acceleration   ≥ 1.2x
Price Momentum        ≥ 0%
Buy Ratio Consistency ≥ 0.50
Trade Count Density   ≥ 1.0x
```

cupsey benchmark 유지 방침에 따라 이 threshold 역시 변경 금지.
새 lane 에서는 같은 factor set 을 재사용하되, threshold 만 사명에 맞춰 재조정.

## Pure WS Breakout Lane (Block 3, 2026-04-18 구현 완료, paper-first)

Convexity 사명 첫 구현 lane. 설계: [`docs/design-docs/pure-ws-breakout-lane-2026-04-18.md`](./docs/design-docs/pure-ws-breakout-lane-2026-04-18.md)

### 상태기계

```text
[signal] → loose gate → immediate PROBE (NO STALK)
[PROBE] 30s  MAE≤-3% → LOSER_HARDCUT | flat → LOSER_TIMEOUT | trail 3% → close | MFE≥+100% → T1
[T1] trail 7%  |  MFE≥+400% → T2 (set lock=entry×3)
[T2] trail max(15%, lock)  |  MFE≥+900% → T3  |  절대 3x 미만 close 금지
[T3] trail 25%, no time stop (runner)
```

### 파라미터 (canary 기본)

```text
Ticket                 = 0.01 SOL
Max concurrent         = 3
PROBE window           = 30s
PROBE hardcut          = MAE ≤ -3%
PROBE flat band        = ±10% (window 만료 + flat → close)
PROBE trail            = 3%
T1 MFE threshold       = +100% (2x)
T1 trail               = 7%
T2 MFE threshold       = +400% (5x)
T2 trail               = 15%
T2 breakeven lock      = entry × 3 (T2 도달 시 영구 lock)
T3 MFE threshold       = +900% (10x)
T3 trail               = 25% (no time stop)
HWM peak sanity        = entry × 15 (cupsey Patch B2 동일)
```

### Gate (cupseyGate factor 재사용, threshold 완화)

```text
vol_accel   ≥ 1.0   (cupsey 1.2)
price_chg   ≥ -0.5% (cupsey 0)
buy_ratio   ≥ 0.45  (cupsey 0.50)
trade_count ≥ 0.8   (cupsey 1.0)
env overrides: PUREWS_GATE_* / PUREWS_LANE_TICKET_SOL / PUREWS_MAX_CONCURRENT / PUREWS_PROBE_HARD_CUT_PCT
```

### Wallet mode

- `PUREWS_WALLET_MODE=auto|main|sandbox` (default `auto`)
- `sandbox` 명시 시 `SANDBOX_WALLET_PRIVATE_KEY` 필수 (startup throw if missing)
- 기본 상태: `PUREWS_LANE_ENABLED=false` (paper-first, 운영자 opt-in 필요)

### 운영 방침

- **Phase 3.1** Paper: `PUREWS_LANE_ENABLED=true` + `TRADING_MODE=paper`, 20-50 trade 관측
- **Phase 3.2** Live canary: paper 20+ trade + 가드레일 무사고 확인 후 진입 (여전히 ticket 0.01 × max 3)
- **Phase 3.3** 승격 판정: wallet delta cupsey 대비 positive + 50 trade 달성 → primary 승격 후보

### Shared Guardrails (Block 1/2 공유, 불변)

- Wallet Stop Guard `< 0.8 SOL` halt
- Wallet delta comparator halt (Block 1)
- `entryIntegrity('pure_ws_breakout')` halt
- Close mutex (`swapSerializer`)
- Security hard reject
- HWM peak sanity (15x)

## Bootstrap Signal Source

`bootstrap_10s` 는 signal-only 로 유지한다.

```text
Primary interval : 10s
Volume lookback  : 20
Volume multiplier: 1.8
Min buy ratio    : 0.60
Cooldown         : 300s
executionRrReject: 99.0  (실거래 100% 억제)
```

### 사용 방식

- cupsey lane 의 trigger source
- pure_ws_breakout lane 도 bootstrap signal 을 소비할지 여부는 Block 3 설계에서 결정

### Rollback

실거래 재개 필요 시: `EXECUTION_RR_REJECT=1.2` → pm2 restart.

## Dormant Strategies

### `volume_spike` (dormant)

- 5m 해상도 + breakout 기반
- 4 sessions × 87 pairs × 3 strategies 중 단 3건 trade → 밈코인 비적합 (2026-04-05 확인)
- CEX/DEX 대형 토큰 전환 시에만 재활성화 고려

### `fib_pullback` (dormant)

- 5m 해상도 + pullback 확인형
- 밈코인 비적합. `volume_spike` 와 같은 사유.

### `core_momentum` (standby)

- 3-AND trigger (volume surge + breakout + confirm)
- 검증 후 사용

## Gate Chain (post-pivot)

```text
Gate 0  Security (hard)
Gate 1  Liquidity / Quote Sanity (hard)
Gate 2  Exitability (hard)
Gate 3  Lane-specific signal filter
        - cupsey: cupseyGate (변경 금지)
        - pure_ws_breakout: 설계 시 확정
        - bootstrap: vol + buyRatio
Gate 4  Integrity (persistOpenTradeWithIntegrity)
Close   Sell-side impact
```

### Retired Gates

- `Attention / Context` gate (hard reject 로 사용 금지)
- `Execution Viability` RR gate 기반 hard reject (bootstrap 억제용 env 는 유지)

## Risk And Exit

### Canary Risk (post-pivot)

| 항목 | 값 |
|---|---|
| Ticket | `0.01 SOL` fixed |
| Max concurrent | `3` ticket (canary) |
| Wallet Stop Guard | `< 0.8 SOL` lane halt |
| RPC fail-safe | 연속 RPC 실패 시 lane halt |
| Per-trade loss floor | lane 별 설계 시 확정 |

### Exit Guards (benchmark cupsey 유지)

- PROBE hard cut (MAE ≤ -0.8%)
- WINNER trailing / breakeven / max hold
- Sell-side impact exit
- Decision price tracking

새 lane 의 exit 구조는 Block 3 설계에서 별도 정의.

## Block 4 Canary Guardrails (2026-04-18)

Block 3 canary 단계 per-lane circuit breaker + A/B 평가.

| 변수 | 기본값 | 역할 |
|---|---|---|
| `CANARY_AUTO_HALT_ENABLED` | `true` | per-lane 자동 halt on/off |
| `CANARY_MAX_CONSEC_LOSERS` | `5` | 연속 loser 회차 임계 |
| `CANARY_MAX_BUDGET_SOL` | `0.5` | 누적 손실 임계 (SOL) |
| `CANARY_MAX_TRADES` | `100` | canary window 최대 trade 수 |
| `CANARY_MIN_LOSS_TO_COUNT_SOL` | `0` | flat close 를 loser로 세지 않는 임계 |

Halt 발동 시: 해당 lane 에 `entryIntegrity.triggerEntryHalt` — 다른 lane entry 는 영향 없음. 운영자 `resetEntryHalt(lane)` 수동 해제 필요 (자동 복구 없음 — false unblock 보다 false halt 가 안전).

### A/B 평가 도구

```bash
npm run ops:canary:eval [-- --since ISO8601] [--json out.json] [--md out.md]
```

cupsey_flip_10s (benchmark) vs pure_ws_breakout (candidate) — executed-buys/sells ledger FIFO pair matching + winner distribution + promotion verdict (`PROMOTE`/`CONTINUE`/`DEMOTE`).

## Block 2 Coverage Expansion (2026-04-18)

### DEX ID Alias Normalization

Layer 3 병목 (`unsupported_dex=77.8%`) 대응 — DexScreener 태그 변형을 모두 canonical 로 normalize.

| Canonical | 허용 alias |
|---|---|
| `pumpswap` | `pumpswap`, `pumpfun`, `pump-swap`, `pump.fun`, `pump_swap`, `pumpdotfun`, `pumpswap-amm`, `pumpfun-amm`, `pump` |
| `meteora` | `meteora`, `meteora-dlmm`, `meteora-damm`, `meteora-damm-v1`/`-v2`, `meteoradbc`, `meteora-dbc`, `meteora_*`, `meteora-dynamic`, `dlmm`, `damm`, `damm-v1`/`-v2`, `damm_v1`/`_v2` |
| `raydium` | `raydium`, `raydium-v4`, `raydium-clmm`, `raydium-cpmm`, `raydium-launchpad`, `raydium-launchlab`, `raydium-amm` (+ `_` 변형) |
| `orca` | `orca`, `orca-whirlpool`, `orca_whirlpool`, `whirlpool` |

알려지지 않은 DEX (Phoenix, Lifinity, SolFi 등) 는 여전히 `unsupported_dex` 로 차단.

### Admission Skip Telemetry

파일: `data/realtime/admission-skips-dex.jsonl`
기록 조건: `unsupported_dex` / `no_pairs` / `unsupported_pool_program` 발생 시 dexId + samplePair + tokenMint + resolvedCount 기록. dex+mint 60초 dedup.
용도: 24-48h 후 실제 어느 DEX 가 Solana 운영에서 주로 차단되는지 empirical 판정 → 다음 coverage 확장 방향 결정.

## Block 1 Runtime Wiring (2026-04-18)

### Lane Wallet Mode

| 변수 | 값 | 동작 |
|---|---|---|
| `CUPSEY_WALLET_MODE` | `auto` / `main` / `sandbox` | cupsey lane executor 명시 선택 (default `auto` backward compat) |
| `MIGRATION_WALLET_MODE` | `auto` / `main` / `sandbox` | migration lane executor 명시 선택 |

`sandbox` 명시했는데 `SANDBOX_WALLET_PRIVATE_KEY` 미설정 시 startup throw (fail-closed).

### Wallet Delta Comparator (always-on)

| 변수 | 기본값 | 동작 |
|---|---|---|
| `WALLET_DELTA_COMPARATOR_ENABLED` | `true` | live 모드에서만 작동 |
| `WALLET_DELTA_POLL_INTERVAL_MS` | `300000` (5분) | poll 주기 |
| `WALLET_DELTA_DRIFT_WARN_SOL` | `0.05` | Telegram 경고 임계 |
| `WALLET_DELTA_DRIFT_HALT_SOL` | `0.20` | 전 lane entry halt 임계 |
| `WALLET_DELTA_MIN_SAMPLES` | `2` | 연속 breach 누적 전 alert 억제 |

Halt 발동 시: 모든 lane(cupsey/migration/main/strategy_d)의 `entryIntegrity` halt 설정 → 운영자 `resetEntryHalt` 수동 복구.

## Guardrails (pivot 불변)

- **Cupsey 개조 금지**
- **Security hard reject 완화 금지**
- **DB pnl 단독 판정 금지** — wallet reconcile 필수
- **Attention / context score hard reject 재도입 금지**
- **cupsey handler 복사해서 pure_ws_breakout 만들기 금지** (별도 상태기계)
- **Kelly / 확대 sizing 은 live 50 trades + wallet 기준 양수 expectancy 확인 후에만**
- **DexScreener / X 데이터 매수 trigger 금지**
- **`OPERATOR_TOKEN_BLACKLIST` 는 scanner / realtime / candle path 에서 모두 차단**

## One-Line Summary

> cupsey 는 건드리지 않는 benchmark, pure_ws_breakout 은 별도 상태기계로 신설, bootstrap 은 signal-only 유지, attention/context gate retire, wallet delta 가 유일한 판정 기준.
