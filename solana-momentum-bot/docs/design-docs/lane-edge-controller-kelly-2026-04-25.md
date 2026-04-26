# Lane Edge Controller - Conservative Kelly / Payoff Control

> Date: 2026-04-25
> Status: Proposed control-plane design
> Authority: `mission-pivot-2026-04-18.md`, `mission-refinement-2026-04-21.md`, `MISSION_CONTROL.md`

## 1. Decision

Kelly and reward/risk are not immediate sizing expansion tools.

For this mission, Kelly is a **lane/cohort control signal** used to:

- keep, throttle, or halt a lane,
- quarantine losing cohorts,
- limit max concurrency,
- decide paper-only versus live,
- only later decide whether ticket size can increase.

Kelly is not alpha. It only allocates attempts toward cohorts that already show wallet-truth edge.

## 2. Why

Recent 2026-04-25 operating data exposed three control gaps:

- `pure_ws_breakout` DB PnL can diverge from executed-ledger / wallet cash flow because of duplicate buy and open-row accounting.
- `pure_ws_breakout` and `migration_reclaim` are not fully covered by the legacy `EdgeTracker` strategy list.
- `kol_hunter` is mission-critical but is not a `StrategyName`; forcing it into legacy strategy stats would blur lane identity.

Therefore, Kelly built on DB PnL or legacy strategy-level stats can create false confidence and increase exposure to a broken cohort.

## 3. Non-Goals

- Do not increase ticket size before wallet-truth accounting is clean.
- Do not compute live Kelly from paper-only PnL.
- Do not use nominal TP/SL RR as the final reward/risk estimate for pure DEX lanes.
- Do not collapse all lanes into one portfolio Kelly number.

## 4. Inputs

The controller must consume append-only, wallet-truth-oriented records:

- executed buys ledger,
- executed sells ledger,
- wallet delta comparator,
- DB trade rows only after reconciliation,
- lane/arm metadata.

Required normalized outcome fields: `laneName`, `armName`, `positionId`, `tokenMint`, `pairAddress`, `dex`, `discoverySource`, `entryTime`, `exitTime`, `exitReason`, `paperOnly`, `spentSol`, `receivedSol`, `feesSol`, `realizedPnlSol`, `maxMfePct`, `maxMaePct`.

## 5. Cohorts

The useful edge is likely cohort-specific, not portfolio-wide.

### 5.1 Phase-gated cohort breadth (2026-04-26 update)

Cohort 차원이 너무 넓으면 **200 trades 단계에서 cohort 당 표본 sparse** 해서 LCB 가 비현실적으로 보수적이 된다. 단계별로 점진 확장한다.

| Phase | Cohort 차원 (필수) | 추가 권장 (선택) |
|-------|------------------|------------------|
| **P0 Accounting** | `laneName` × `armName` | (없음 — 단순 reconciliation 만) |
| **P1 Report-only** | `laneName` × `armName` × `kolCluster_or_discoverySource` | `dex` |
| **P2 Active throttle** | + `dex` × `tokenAgeBucket` | `mcapBucket` |
| **P3 (only after Stage 4 SCALE + 별도 ADR)** | + `independentKolCount`, `signalQualityBucket`, `tokenSessionId` | (필요 시 차원 추가) |

→ **P0/P1 시작 시 3 차원 고정**: `laneName × armName × (kolCluster or discoverySource)`. 그 외 차원은 ADR 없이 추가 금지.

### 5.2 Cohort 표본 임계

- `n < 30` 인 cohort 는 Kelly 계산 자체 skip (display-only)
- `n < 50` 인 cohort 는 "preliminary" flag 표시, throttle 결정에 반영 금지
- `n >= 50` 만 conservative Kelly 가 control output 에 영향

Example cohorts (P1 기준): `kol_hunter / lexapro / kolCluster=S`, `pure_ws_breakout / ws_burst_v2 / discoverySource=helius_pool`, `migration_reclaim / launchlab / discoverySource=launchlab_event`.

## 6. Metrics

All live metrics must be wallet-realized unless explicitly labeled as paper.

Per lane and cohort:

```text
n
win_rate
avg_win_sol
avg_loss_sol
reward_risk = avg_win_sol / abs(avg_loss_sol)
expectancy_sol = win_rate * avg_win_sol - (1 - win_rate) * abs(avg_loss_sol)
cash_flow_sol = sum(receivedSol) - sum(spentSol) - sum(feesSol)
log_growth = log(wallet_after / wallet_before)
max_loss_streak
runner_contribution = pnl_from_T2_T3_visit_AND_positive_close / total_winning_pnl
//   분모: total_winning_pnl (= sum of positive realizedPnl)
//   분자: T2/T3 visit + positive close trade 의 pnl (runner failure 는 분자 제외)
//   2026-04-26 (QA F4 + Open Q2): 분모 total_pnl → total_winning_pnl 변경 (음수 cashflow 시 misleading 차단)
```

Paper-only metrics must use a `paper_` prefix and cannot unlock live sizing.

## 7. Conservative Kelly

Raw Kelly:

```text
raw_kelly = win_rate - (1 - win_rate) / reward_risk
```

Production Kelly must use conservative estimates:

```text
p = lower_confidence_bound(win_rate)
rr = lower_confidence_bound_or_bootstrap_p10(reward_risk)
conservative_kelly = max(0, p - (1 - p) / rr)
applied_kelly = min(conservative_kelly * scale, cap)
```

Recommended defaults:

- `scale = 0.125` for canary,
- `scale = 0.25` only after confirmed wallet-truth edge,
- `cap = 0.01` while wallet < 3 SOL,
- `cap = 0.03` **never auto-unlocks**. 200+ reconciled live trades 만으로는 부족.

### 7.1 Ticket cap unlock — Real Asset Guard 와의 정합 (2026-04-26 명시)

**`cap = 0.03` 은 자동 활성 조건이 아니다.** 다음 4 조건 모두 만족 시에만 운영자 수동 승인으로 unlock:

1. **Mission-refinement Stage 4 `SCALE` 판정** (200 trades + wallet log growth > 0 + ruin prob < 5% + 5x+ winner 분포 실측)
2. **별도 ADR** (`docs/design-docs/ticket-cap-unlock-YYYY-MM-DD.md`) 작성 + Real Asset Guard exception 사유 명시
3. **운영자 명시적 ack** (Telegram critical + git commit message `[REAL_ASSET_GUARD_EXCEPT]` tag)
4. **48h cooldown** 후 1-step 만 증가 (0.01 → 0.015 → 0.02 → 0.03 — 단계별 ADR)

→ Kelly Controller 는 `cap` 을 절대 자동 변경하지 않는다. `cap` 은 **`config.kolHunterTicketSol` / `config.pureWsLaneTicketSol` 의 hard lock** 을 그대로 따른다 (`project_ticket_policy_hard_lock_2026_04_21`).

LaneEdgeController 의 `ticket_cap_sol` output 은 **항상 `min(현재 ticket, lane hard lock)` 으로 clip** — Kelly 가 양수여도 자동 증가 없음.

## 8. Control Outputs

The controller emits actions, not just reports: `entry_mode`, `ticket_cap_sol`, `max_concurrent`, `cooldown_sec`, `quarantine_until`, `reason`.

Suggested policy:

| Condition | Action |
|---|---|
| wallet mismatch active | `entry_mode=halted`, Kelly forced to `0` |
| `n < 50` | display only, fixed ticket |
| `50 <= n < 100` and expectancy <= 0 | reduce max concurrent or paper-only |
| `n >= 100` and conservative Kelly <= 0 | throttle or quarantine cohort |
| `n >= 100` and conservative Kelly > 0 | keep live attempts, fixed ticket |
| `n >= 200` and wallet log growth > 0 | consider small ticket cap increase |

## 9. Lane Rules

### Pure WS

Kelly controls token-session quarantine, per-pair cooldown, max concurrency, and whether V2 pass signals are allowed to execute.

Pure WS must not increase ticket size until duplicate/open-row accounting is fixed, quote-based T1 promotion is implemented, and wallet cash flow agrees with DB within drift tolerance.

### KOL Hunter

KOL paper stats may rank KOLs but cannot unlock live sizing.

KOL live Kelly requires a real `enterLivePosition()` path, executed buy/sell ledger, size-aware sell quote probe, wallet-truth PnL, and KOL cohort identity.

### Migration Reclaim

Migration lane can use cohort Kelly only after event type is explicit:

- LaunchLab to Raydium CPMM,
- Pump.fun to PumpSwap canonical,
- Meteora DBC to DAMM/DLMM.

## 10. Implementation Plan — Phase Gates (2026-04-26 강화)

각 Phase 의 시작 조건을 **Option 5 mission timeline 의 명시적 시점** 으로 박는다. 이 게이트 통과 전 다음 Phase 코드 작성 / 머지 금지.

### P0 - Accounting Eligibility (즉시 착수 가능)

**Gate 진입 조건**: 없음 (현 시점 P0 만 즉시 시작).

**작업 범위**:
- Reconcile DB trades against executed buy/sell ledger (FIFO match `entryTxSignature`).
- 신규 outcome record 필드 (single source of truth):
  - `kelly_eligible: boolean` — 모든 reconcile 통과 시 true
  - `reconcile_status: 'ok' | 'duplicate_buy' | 'orphan_sell' | 'open_row_stale' | 'wallet_drift'`
  - `matched_buy_id / matched_sell_id: string | null`
  - `wallet_truth_source: 'executed_ledger' | 'wallet_delta_comparator' | 'db_pnl' | 'unreconciled'` (`db_pnl` 은 fallback only, `unreconciled` → `kelly_eligible=false` 강제)
  - `laneName / armName` (not legacy `StrategyName` only)
- Force Kelly to zero when duplicate/open-row mismatch exists.
- 산출물: `data/realtime/lane-outcomes-reconciled.jsonl` (append-only, P1 input).

**P0 종료 조건**:
- 최근 7일 trade 의 `kelly_eligible=true` 비율 ≥ 95%
- duplicate buy / open-row stale 0건
- canary-eval.ts 가 reconciled outcome 만 사용

→ **이 통과 없이 P1 시작 금지**. P0 가 broken 인 채 Kelly 계산 = false confidence (mission-refinement §3 위반).

### P1 - LaneEdgeController (report-only)

**Gate 진입 조건** (모두 만족):
- P0 종료 조건 통과
- **Option 5 Phase 2 shadow eval `GO` 판정** (ADR §6 Gate 1 통과)
- 별도 commit `[KELLY_CONTROLLER_P1_START]` tag

**작업 범위**:
- Add `src/risk/laneEdgeController.ts`.
- Read **reconciled** lane outcomes (P0 산출물).
- Emit `entry_mode`, `ticket_cap_sol`, `max_concurrent`, `cooldown_sec`, and `reason`.
- **Cohort 차원**: `laneName × armName × (kolCluster or discoverySource)` 만 (5.1 표 P1 row).
- **Report-only 강제**: actual entry path 에 wired 하지 않음. 매일 `reports/kelly-cohort-YYYY-MM-DD.md` 생성만.

**P1 종료 조건**:
- 2주 이상 report 누적
- Cohort 별 LCB 계산 단위 테스트 통과
- 운영자가 1주 이상 report 검토 후 P2 진행 합의

### P2 - Cohort Throttle (active)

**Gate 진입 조건** (모두 만족):
- P1 종료 조건 통과
- **Option 5 Phase 4 live canary 50 trades 완주** (ADR §6 Gate 3 통과)
- Wallet floor 0.8 무위반
- 별도 ADR (`docs/design-docs/cohort-throttle-activation-YYYY-MM-DD.md`)

**작업 범위**:
- Controller 를 entry path 에 wired (Pure WS / KOL Hunter / Migration).
- Token-session quarantine for negative conservative Kelly.
- **Fixed ticket 유지** (cap 변경 금지).

### P3 - Live Sizing Unlock (보류, 매우 엄격)

**Gate 진입 조건** (모두 만족):
- **Mission-refinement §5 Stage 4 `SCALE` 판정** (200+ wallet-reconciled live trades + wallet log growth > 0 + ruin probability < 5%)
- 별도 ADR `docs/design-docs/ticket-cap-unlock-YYYY-MM-DD.md`
- 운영자 명시 승인 + Telegram critical ack
- 48h cooldown 후 시작

**작업 범위**:
- Raise ticket cap by **one step only** (0.01 → 0.015 → 0.02 → 0.03), not continuously.
- 각 단계마다 별도 ADR + 50 trades 관측 필요.

→ **현재 P3 는 hypothetical**. 본 시점에서 코드 작성 금지.

## 11. Acceptance Criteria

- Kelly is never computed from unreconciled DB PnL.
- Paper lanes never unlock live sizing.
- Negative conservative Kelly can reduce attempts, but cannot increase them.
- Ticket increase is impossible while wallet floor, drift halt, or duplicate ledger mismatch is active.
- Reports show raw Kelly and conservative Kelly separately.
- **P0/P1/P2/P3 phase gate** (§10) 명시 시점 외 code merge 금지 — `[KELLY_CONTROLLER_PHASE_VIOLATION]` lint rule 후보.
- **Cohort 차원** P0/P1 = 3 차원 (laneName × armName × kolCluster_or_discoverySource) 만. 추가는 ADR 필수.
- **Outcome record schema** (P0 산출물) 의 5 필드 (`kelly_eligible / reconcile_status / matched_buy_id / matched_sell_id / wallet_truth_source`) 를 모든 lane 이 동일하게 채운다.

## 12. Summary

The practical edge is not the Kelly formula itself.

The edge is using conservative Kelly and realized payoff distribution to decide which lane/cohort deserves more attempts, which cohort must be throttled, and when a promising paper edge is not yet live-tradable.
