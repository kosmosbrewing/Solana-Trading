# Pure WS Breakout Lane — Design

> Status: design / implementation (Block 3)
> Date: 2026-04-18
> Mission source: [`mission-pivot-2026-04-18.md`](./mission-pivot-2026-04-18.md)
> Authority: cupsey benchmark 유지 + 새 primary 후보 lane 신설

## 1. Why

Mission pivot 이후 **convexity 사명**에 맞는 entry / exit 구조 필요.

- cupsey benchmark (`cupsey_flip_10s`) 는 **STALK 60s + pullback 대기** → Layer 3 에서 `STALK 15 → ENTRY 1 (6.7%)` conversion 저하 확인됨.
- 이 저전환은 "의도된 품질 filter" 이지만 convexity 사명에서는 **throughput sacrifice** 가 wallet log growth 에 불리.
- 동시에 cupsey 를 개조하면 baseline 비교가 불가 → **별도 lane 으로 신설**.

## 2. Design Principles (Mission-aligned)

| 축 | cupsey (benchmark) | pure_ws_breakout (new) |
|---|---|---|
| Entry 구조 | STALK 60s → pullback -0.5% → PROBE | **immediate PROBE** (no STALK) |
| Entry gate | cupseyGate (vol 1.2 / price 0 / buy 0.50 / trade 1.0) | **loose gate** (vol 1.0 / price -0.5% / buy 0.45 / trade 0.8) |
| PROBE window | 45s | 30s |
| Loser cut | MAE ≤ -0.8% | **MAE ≤ -3.0%** OR 30s flat (broader, quick) |
| Winner 승격 | MFE ≥ +2% → WINNER (1-tier) | **tiered runner** — T1 (2x), T2 (5x), T3 (10x) |
| Trailing | 4% fixed | **tiered** — PROBE 3% / T1 7% / T2 15% / T3 25% |
| Time stop | 12min (720s) | **0–2x 5min / T2+ 시간 제한 없음** |
| Breakeven | entry + 0.5% (MFE > 4%) | **+200% lock at T2 entry (3x 이상 절대 손실 X)** |

## 3. Lane Architecture

### 3.1 Handler File

- NEW: `src/orchestration/pureWsBreakoutHandler.ts`
- **Separate state machine** — cupsey handler 복사 금지 (mission-pivot 문서 명시)
- cupsey 와 동일 signal source (`bootstrap_10s`) 소비, 단 gate / entry / exit 전 과정 독립

### 3.2 Shared Guards (절대 완화 금지)

| 가드 | 출처 | 역할 |
|---|---|---|
| Wallet Stop Guard | `isWalletStopActive()` | wallet < 0.8 SOL halt |
| Entry Integrity | `isEntryHaltActive('pure_ws_breakout')` | DB persist 실패 halt |
| Wallet Delta Comparator | Block 1 comparator | drift halt 시 모든 lane 동시 halt |
| Close mutex | `swapSerializer` | 모든 lane 공유 |
| Security Hard Reject | 기존 gate chain | top-holder %, mint/freeze authority, honeypot |
| HWM sanity | `pureWsMaxPeakMultiplier` (15x 기본) | HWM oxidation 방지 |

### 3.3 Signal Source

- `bootstrap_10s` signal 재사용 (cupsey 와 동일 pool)
- cupsey 가 gate-reject 한 signal 도 `pure_ws_breakout` 에서 재평가 (looser gate)
- A/B 비교: 동일 signal input → cupsey vs pure_ws_breakout wallet delta

## 4. State Machine

```text
  [signal]
     │
     ▼
  [PROBE] ─ 30s ──────────────────► [LOSER_TIMEOUT]  (MFE < +X, flat)
     │
     ├─ MAE ≤ -3.0% ──► [LOSER_HARDCUT]
     │
     ├─ MFE ≥ +100% (2x) ──► [RUNNER_T1]
     │
  [RUNNER_T1]
     ├─ trail 7% ──► [T1_TRAIL_EXIT]
     ├─ MFE ≥ +400% (5x) ──► [RUNNER_T2]
     │
  [RUNNER_T2]
     ├─ lock: never close below entry × 3 (breakeven+)
     ├─ trail 15% ──► [T2_TRAIL_EXIT]
     ├─ MFE ≥ +900% (10x) ──► [RUNNER_T3]
     │
  [RUNNER_T3]
     ├─ trail 25% ──► [T3_TRAIL_EXIT]
     └─ (no time stop — runner)
```

### 4.1 PROBE window

- Entry: immediate market buy at current signal price
- Duration: 30s
- Exit conditions:
  - MAE ≤ -3.0%: **LOSER_HARDCUT** (quick loser cut)
  - MFE ≥ +100%: **RUNNER_T1** 승격
  - 30s 경과 & MFE < +100% & flat (currentPct 범위 ±10% 내): **LOSER_TIMEOUT** (flat cut)
  - trail 3% on peak (if peak > entry)

### 4.2 RUNNER tiers

- **T1 (100–400%, 2x–5x)**
  - trail 7% on peak
  - MFE ≥ +400% → T2 승격
- **T2 (400–900%, 5x–10x)**
  - **lock = entry × 3.0** (절대 3x 이하로 close 금지, trailing stop = max(trail 15%, entry×3))
  - MFE ≥ +900% → T3 승격
- **T3 (900%+, 10x+)**
  - trail 25% on peak
  - no time stop — 무한 hold
  - lock 유지 (entry × 3)

### 4.3 HWM sanity

모든 tier 업데이트 시 `pureWsMaxPeakMultiplier = 15` 초과하는 peak 은 spurious spike 로 간주하고 **peakPrice 업데이트 skip** (cupsey Patch B2 동일 로직 이식).

## 5. Params (초기 canary)

```ts
pureWsLane: {
  pureWsLaneTicketSol: 0.01,              // fixed micro-ticket
  pureWsMaxConcurrent: 3,                 // canary: 동시 진입 max 3
  pureWsProbeWindowSec: 30,               // 30s 관찰 창
  pureWsProbeHardCutPct: 0.03,            // -3% 즉시 loser cut
  pureWsProbeFlatBandPct: 0.10,           // ±10% 이내 → flat 으로 간주
  pureWsProbeTrailingPct: 0.03,           // PROBE 구간 trail 3%
  pureWsT1MfeThreshold: 1.0,              // +100% (2x)
  pureWsT1TrailingPct: 0.07,              // T1 trail 7%
  pureWsT2MfeThreshold: 4.0,              // +400% (5x)
  pureWsT2TrailingPct: 0.15,              // T2 trail 15%
  pureWsT2BreakevenLockMultiplier: 3.0,   // T2 도달 시 entry × 3 lock
  pureWsT3MfeThreshold: 9.0,              // +900% (10x)
  pureWsT3TrailingPct: 0.25,              // T3 trail 25%, no time stop
  pureWsMaxPeakMultiplier: 15,            // HWM sanity (Patch B2 동일)
}
```

### Gate (loose vs cupsey)

```ts
pureWsGate: {
  pureWsGateEnabled: true,
  pureWsGateMinVolumeAccelRatio: 1.0,     // cupsey 1.2 → 1.0
  pureWsGateMinPriceChangePct: -0.005,    // cupsey 0 → -0.005 (하락 중 reclaim 진입 허용)
  pureWsGateMinAvgBuyRatio: 0.45,         // cupsey 0.50 → 0.45
  pureWsGateMinTradeCountRatio: 0.8,      // cupsey 1.0 → 0.8
}
```

## 6. Measurement (Mission-aligned)

| KPI | 목표 |
|---|---|
| wallet log growth / 100 trades | cupsey 대비 positive |
| 5x+ rate / 100 trades | 관측 baseline 수립 |
| 10x+ rate / 100 trades | 관측 baseline 수립 |
| max consecutive loser streak | 정보 (hard threshold 없음) |
| PROBE → RUNNER_T1 conversion | cupsey `STALK→ENTRY 6.7%` 대비 비교 |
| Ruin probability (0.3 SOL 도달) | < 5% (Block 4 canary 후 재측정) |

## 7. Rollout Plan

### Phase 3.1 Paper first (immediate after merge)
- `PUREWS_LANE_ENABLED=true` + `TRADING_MODE=paper`
- cupsey 와 동시 작동 — 같은 signal pool 을 paper 로 병렬 소비
- 20-50 paper trade 도달까지 관측

### Phase 3.2 Live canary (조건부)
- Paper 20+ trade + hard guardrails 무사고 확인 후
- `TRADING_MODE=live` + `CUPSEY_LANE_ENABLED=true` (benchmark 유지) + `PUREWS_LANE_ENABLED=true`
- **추가 opt-in 필수**: `PUREWS_LIVE_CANARY_ENABLED=true` — 이 flag 없으면 live mode 에서도 pure WS buy suppressed (paper-first 코드 강제)
- ticket 0.01 SOL, max 3 concurrent — **wallet-level 전역** cap 원하면 `CANARY_GLOBAL_CONCURRENCY_ENABLED=true` 추가
- Wallet Stop Guard 0.8 SOL 필수, wallet delta comparator 작동 확인
- 50 trade 도달 시 (`CANARY_MAX_TRADES=50` entry pause 발동) wallet delta + winner distribution 평가

### Phase 3.3 Promotion 판정
- Wallet delta cupsey 대비 positive & 가드레일 무사고 → primary 승격 후보
- 아니면 paper 로 회귀 + tier 재튜닝 (trailing %, threshold)

## 8. Hard Rules

- **cupsey handler 복사 / 개조 금지** — 별도 file, 별도 state
- **attention / context gate 재도입 금지** — gate 는 factor-based 만
- **5x+ winner baseline 관측 없이 trailing 임의 튜닝 금지**
- **canary 50 trade 전 ticket 확대 금지**
- **Wallet Stop Guard / RPC fail-safe / security hard reject 완화 금지**

## 9. Open Questions (post-implementation)

1. `bootstrap_10s` signal 외에 pure WS burst 감지 모듈을 별도로 만들 것인가 (Block 3.1 후보)
2. PROBE → T1 conversion 이 실전에서 cupsey 보다 낮을 가능성 (loose gate 가 noise 증가)
3. T2 lock (entry × 3) 이 실제 runner 경로를 끊을 위험 — tier 2 도달 분포 확인 후 조정 필요
