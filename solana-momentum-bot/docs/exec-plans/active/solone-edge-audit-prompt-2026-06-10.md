# Solone Edge Audit Prompt v2 — 엣지 부재 진단 및 재발굴

> Date: 2026-06-10  
> Scope: Solana Momentum Bot / Option 5 KOL Discovery / Rotation / Smart-v3  
> Status: handoff prompt for external agent or new research session  
> Authority: `MISSION_CONTROL.md`, `SESSION_START.md`, `docs/exec-plans/active/mission-reassessment-protocol-2026-05-22.md`

## 사용법

이 문서 전체를 Claude Code / Codex / 다른 분석 에이전트 세션에 붙여넣고 실행한다.

이 프롬프트는 **전략 구현 프롬프트가 아니다.** 목적은 현재 중단된 Solana KOL 추종 봇(Solone)이 왜 live wallet-truth 기준 엣지를 증명하지 못했는지 판정하고, 재개 가능한 최소 조건이 존재하는지 검증하는 것이다.

기본 원칙:

- 새 live 거래 금지
- 새 paid Helius 수집 금지
- 기존 로컬 데이터 우선
- wallet-truth 우선
- paper headline 금지
- role contamination 금지
- 진단 완료 전 전략 수정 금지

## ROLE

당신은 정량 트레이딩 리서치 엔지니어이자 실험 무결성 감사자다.

목표는 중단된 Solana KOL 추종 봇의 "live compounding edge 미입증" 결론을 데이터로 재검증하고, 원인을 다음 중 하나 이상으로 특정하는 것이다.

1. **신호 자체 무효**  
   KOL buy / consensus / tier / rotation trigger가 미래 수익을 예측하지 못한다.

2. **gross alpha는 있으나 비용·지연·체결 drag로 소멸**  
   markout 또는 token-only gross는 양수지만 wallet/refund/cost-stress 후 음수다.

3. **측정/승격 방법 오염**  
   lookahead, paper role contamination, research/shadow 혼합, low coverage, bad join, stale KOL posterior, 생존 편향 때문에 엣지 판단이 왜곡됐다.

4. **부분 cohort만 생존 가능**  
   broad KOL/live는 폐기해야 하지만, ex-ante로 정의 가능한 작고 비용 통과한 cohort만 paper/mirror 재검증 가치가 있다.

진단이 끝나기 전까지 기능 구현, live env 변경, 전략 수정, 파라미터 튜닝을 금지한다. 분석만 수행한다.

## CURRENT PROJECT CONTEXT

현재 프로젝트의 live mission은 다음이다.

```text
0.6 SOL floor를 지키고,
반복 손실을 최소화하며,
wallet-truth/cost-aware 기준으로 양수인 작은 cohort가 있는지 찾고,
증명된 cohort만 tiny micro-canary로 검증한다.
```

중요한 현재 판정 기준:

- `100 SOL`은 계획 KPI가 아니라 right-tail outcome이다.
- 현재 목표는 "매일 무조건 이기는 봇"이 아니라 "손실을 제한하며 천천히 복리 가능한 cohort가 있는지 증명"이다.
- live 재개는 `READY`나 `MICRO_CANARY_READY`가 아니라면 금지다.
- raw paper profit은 live promotion evidence가 아니다.
- `research_arm`, `shadow`, `unknown_role` 수익은 가설 생성용이지 live 승격 근거가 아니다.

2026-06-07 기준 마지막 내부 판정은 아래와 같았다. 이 숫자는 참고 baseline이며, 반드시 재계산하라.

- VPS `momentum-bot`: stopped
- fresh 24h live/paper trades: 0
- live replay: 596 rows, net `-1.565482 SOL`
- live canary report: 475 closes, net `-1.127613 SOL`, win rate `16%`
- comparable mirror: 42 rows, net `-0.145452 SOL`
- mission offline simulator final decisions:
  - `broad_live_canary`: `KILL`
  - `rotation_underfill_cost_aware_exit_v2`: `QUARANTINE`
  - `smart_v3`: `QUARANTINE`
  - `helius_paid_collection`: `QUARANTINE`
  - `rotation_micro_canary`: `QUARANTINE`

## LOCAL DATA AND COMMANDS

Repository root:

```text
/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
```

Start with:

```bash
git status --short
bash scripts/sync-vps-data.sh
npm run check:fast
```

`sync-vps-data.sh` is allowed because it syncs local artifacts and does not run paid Helius backfills by default. Do not set these unless explicitly approved:

```bash
RUN_TRADES_DUMP=true
RUN_SHADOW_EVAL=true
RUN_CANDLE_ENTRY_PROOF_REPORT=true
npm run kol:transfer-refresh
```

Core ledgers:

```text
data/realtime/kol-live-trades.jsonl
data/realtime/rotation-v1-live-trades.jsonl
data/realtime/smart-v3-live-trades.jsonl
data/realtime/kol-paper-trades.jsonl
data/realtime/rotation-v1-paper-trades.jsonl
data/realtime/smart-v3-paper-trades.jsonl
data/realtime/pure-ws-paper-trades.jsonl
data/realtime/capitulation-rebound-paper-trades.jsonl
```

Decision / attribution:

```text
data/realtime/kol-policy-decisions.jsonl
data/realtime/kol-live-equivalence.jsonl
data/realtime/trade-markout-anchors.jsonl
data/realtime/trade-markouts.jsonl
data/realtime/missed-alpha.jsonl
data/realtime/token-quality-observations.jsonl
data/realtime/kol-execution-guards.jsonl
data/realtime/executed-buys.jsonl
data/realtime/executed-sells.jsonl
```

KOL / market / candle context:

```text
data/realtime/kol-tx.jsonl
data/realtime/sessions/**
data/research/kol-transfers.jsonl
data/research/candle-entry-proof/anchor_feature_mart.jsonl
data/research/candle-entry-proof/horizon_outcome_mart.jsonl
data/research/candle-entry-proof/fold_summary_mart.jsonl
data/research/candle-entry-proof/reentry_cluster_mart.jsonl
```

Cost / infra:

```text
data/realtime/helius-credit-usage.jsonl
reports/sync-health-*.md
reports/sync-health-*.json
```

Existing report scripts:

```bash
npm run kol:mission-offline-sim -- --realtime-dir data/realtime --reports-dir reports --json reports/mission-offline-sim-$(date -u +%F).json --md reports/mission-offline-sim-$(date -u +%F).md

npm run kol:historical-loss-report -- --realtime-dir data/realtime --min-rows 20 --max-p90-mfe 0.03 --md reports/historical-loss-miner-$(date -u +%F).md --json reports/historical-loss-miner-$(date -u +%F).json

npm run kol:candle-entry-proof-report -- --realtime-dir=data/realtime --md-out=reports/candle-entry-proof-$(date -u +%F).md --json-out=reports/candle-entry-proof-$(date -u +%F).json --mart-dir=data/research/candle-entry-proof
```

Use existing scripts first. Only create new analysis scripts when a required question is not already covered.

## OUTPUT LOCATION

Write all new audit artifacts under:

```text
analysis/edge-audit-2026-06-10/
```

Expected structure:

```text
analysis/edge-audit-2026-06-10/scripts/
analysis/edge-audit-2026-06-10/reports/
analysis/edge-audit-2026-06-10/cache/
analysis/edge-audit-2026-06-10/EDGE_AUDIT_REPORT.md
```

Do not modify production source code. If a helper is needed, write it under `analysis/edge-audit-2026-06-10/scripts/`.

## HARD RULES — 위반 시 분석 전체 무효

1. **No new live risk.**  
   Do not start `momentum-bot`, change live env, enable live canary, or alter tickets.

2. **No paid data expansion.**  
   Do not call Helius backfills, transfer refresh, shadow eval, or external APIs unless explicitly approved.

3. **Wallet-truth first.**  
   Live wallet delta beats DB PnL, token-only PnL, and raw paper PnL.

4. **Separate evidence roles before any profitability claim.**  
   At minimum separate:
   - `live`
   - `paper_mirror`
   - `fallback_execution_safety`
   - `research_arm`
   - `shadow`
   - `unknown_role`

5. **Promotion-comparable roles only.**  
   Live promotion evidence may use only `live`, `paper_mirror`, and carefully labeled `fallback_execution_safety`.  
   `research_arm`, `shadow`, `unknown_role`, and fuzzy token/time joins are diagnostic only.

6. **Lookahead is forbidden.**  
   A decision at time `t0` may use only data available at or before `t0`. Forward returns may be used only for evaluation.

7. **Gross, refund-adjusted, wallet-stress, and net must be reported separately.**

8. **Every table must include N.**  
   N < 30 is reference-only. N < 100 cannot justify live risk.

9. **Bootstrap confidence intervals are required only for final cited claims.**  
   Use fast analytic CI for screening. For final verdict numbers, use bootstrap >= 1,000 resamples.

10. **No cherry-picking.**  
    If a cohort is chosen after seeing results, label it `hypothesis_only` or `research_only`.

11. **Chronological OOS is mandatory.**  
    Random split is not acceptable for promotion claims.

12. **Current stopped state is not an accident to fix.**  
    The stopped bot is part of capital preservation. Restarting it is out of scope.

## REQUIRED FINAL VERDICTS

The final report must choose exactly one primary verdict:

| Verdict | Meaning | Required action |
|---|---|---|
| `MEASUREMENT_INVALID` | Data/join/coverage defects prevent edge judgment | Fix measurement first; no live |
| `RETIRE_CURRENT_LIVE` | Current KOL/rotation/smart-v3 live system has no wallet-truth edge | Keep bot stopped; archive live strategy |
| `REBUILD_SIGNAL_SOURCE` | KOL signal itself has no gross predictive edge | Retire KOL source; research new source |
| `EXECUTION_ALPHA_DECAY` | Gross edge exists but net decays through latency/cost | No live until execution stack changes and replay proves net positive |
| `OFFLINE_COHORT_FOUND` | A small ex-ante cohort passes offline gates but not forward shadow | Free/local forward shadow only |
| `MICRO_CANARY_READY` | A cohort passes offline + mirror + cost + ruin gates | Manual tiny micro-canary review only, never auto-enable |

Default bias:

```text
If uncertain, do not promote.
If paper and live disagree, trust live.
If coverage is low, verdict is MEASUREMENT_INVALID or COLLECT, not edge.
If only research/shadow is positive, verdict is not MICRO_CANARY_READY.
```

## PHASE 0 — DATA AND MEASUREMENT AUDIT

Output:

```text
analysis/edge-audit-2026-06-10/reports/00_DATA_AUDIT.md
```

Tasks:

1. Inventory all core ledgers:
   - rows
   - file size
   - modified time
   - first/last `closedAt` or event timestamp
   - live/paper/research role counts

2. Verify process freshness:
   - `pm2 list` if VPS reachable
   - `logs/bot.log` tail
   - whether `momentum-bot` is stopped or running
   - whether any fresh 24h trading rows exist

3. Join audit:
   - signal/candidate/decision/trade/markout join coverage
   - join method counts
   - promotion-grade coverage
   - unjoined live rows

4. Role audit:
   - net by `paperRole` / inferred role
   - prove whether paper headline is promotion-comparable

5. Candle audit:
   - total candle rows scanned
   - direct candle coverage
   - full pre60 + T+300 coverage
   - coverage by family and source

6. Cost audit:
   - Helius credits by feature and purpose
   - paid path share
   - whether paid path produced promotion-grade evidence

Stop condition:

- If promotion-grade join coverage < 95% for a cohort, that cohort cannot be promoted.
- If candle full coverage is too low for a family, candle-derived rules are diagnostic only.
- If fresh 24h rows are zero, do not claim current market edge.

## PHASE 1 — RAW SIGNAL EVENT STUDY

Output:

```text
analysis/edge-audit-2026-06-10/reports/01_SIGNAL_EVENT_STUDY.md
```

Purpose: test whether KOL-triggered events predict forward return before gates and exits.

Event definition:

```text
t0 = KOL buy detection timestamp or earliest available candidate anchor timestamp
```

Use only events whose t0 is available without future data.

Forward horizons:

```text
15s, 30s, 60s, 300s, 1800s, 6h, 24h
```

Required segment axes:

- strategy family: rotation / smart_v3 / pure_ws / other
- independent KOL count: 1 / 2 / 3+
- KOL tier or quality bucket if known at t0
- token age bucket
- route proof present / missing
- sell route proof present / missing
- token quality known / unknown
- UTC 4h time bucket
- role: live / mirror / fallback / research / shadow / unknown

Report:

- N
- median gross forward return
- mean gross forward return
- positive rate
- <= -20% rate
- >= +50% rate
- bootstrap CI for final cited segments

Core question:

```text
Is there any ex-ante segment with gross forward expectancy above zero,
N >= 100, multiple active days, and CI excluding zero?
```

If no, primary verdict trends toward `REBUILD_SIGNAL_SOURCE`.

## PHASE 2 — COST, LATENCY, AND WALLET DRAG

Output:

```text
analysis/edge-audit-2026-06-10/reports/02_COST_LATENCY_WALLET_DRAG.md
```

Tasks:

1. Compute live execution delay:
   - signal to reference
   - reference to submit
   - submit to confirmed or close
   - buy lag p50/p90/p99

2. Compute cost and drag:
   - token-only PnL
   - refund-adjusted PnL
   - wallet-truth PnL
   - slippage
   - priority fee
   - Jito tip if present
   - failed tx cost
   - rent/ATA overhead if available

3. Alpha decay:
   - compare entry at t0, t0+5s, t0+10s, t0+15s, t0+30s, t0+60s where local markouts/candles allow
   - do not use future pass/fail conditions as entry rules

4. Break-even latency:
   - define break-even delay where expected net crosses <= 0
   - compare with observed p50/p90 delay

Core question:

```text
Does any gross-positive segment remain positive after realistic p90 cost and observed latency?
```

If gross > 0 but net <= 0 and break-even latency < observed p50, primary verdict trends toward `EXECUTION_ALPHA_DECAY`.

## PHASE 3 — GATE AND ADMISSION FUNNEL

Output:

```text
analysis/edge-audit-2026-06-10/reports/03_GATE_ADMISSION_FUNNEL.md
```

Tasks:

1. Build funnel:

```text
all KOL events
-> scam/security eligible
-> event score eligible
-> onchain breakout/rotation condition
-> execution viability
-> paper entry
-> mirror entry
-> live entry
-> closed live
```

2. For each gate:
   - pass N
   - reject N
   - pass forward return
   - reject forward return
   - pass vs reject delta

3. Gate ablation:
   - remove one gate at a time
   - recompute gross, refund-adjusted, wallet-stress where possible
   - mark as diagnostic if no comparable live/mirror path exists

4. Admission-loss focus:
   - quantify `probe_hard_cut`
   - quantify `entry_advantage_emergency_exit`
   - quantify `rotation_dead_on_arrival`
   - quantify `smart_v3_mae_fast_fail`
   - simulate removing them
   - state whether removal makes historical live positive

Core question:

```text
Are gates filtering losers, or are they also killing the few winners?
Can admission vetoes alone turn live replay positive?
```

If vetoes reduce loss but do not turn live positive, state clearly:

```text
loss reduction is useful, but not sufficient edge.
```

## PHASE 4 — PAPER / MIRROR / LIVE TRANSLATION

Output:

```text
analysis/edge-audit-2026-06-10/reports/04_TRANSLATION_PROOF.md
```

Tasks:

1. Separate all rows by evidence role.

2. Compute:
   - net by role
   - win rate by role
   - max loss streak by role
   - MFE bucket by role

3. Pair mirror/live where possible:
   - paired rows
   - live without mirror
   - mirror without live
   - sign agreement
   - median delta
   - strategy loss vs execution drag classification

4. Declare paper headline contaminated if:
   - most positive PnL comes from `shadow`, `research_arm`, or `unknown_role`
   - mirror is negative
   - paired rows < 30

Core question:

```text
Can paper results predict live wallet-truth results?
```

If no, live promotion is blocked even when paper is positive.

## PHASE 5 — CANDLE / MICROSTRUCTURE SALVAGE

Output:

```text
analysis/edge-audit-2026-06-10/reports/05_CANDLE_MICROSTRUCTURE_SALVAGE.md
```

Use:

```text
reports/candle-entry-proof-*.json
data/research/candle-entry-proof/*.jsonl
data/realtime/sessions/**
```

Tasks:

1. Recompute or read:
   - `anchor_feature_mart`
   - `horizon_outcome_mart`
   - `fold_summary_mart`
   - `reentry_cluster_mart`

2. Evaluate only ex-ante rules:
   - pre-stable admission
   - DOA 15s fail-fast
   - pass30 survivor trail
   - fail30 same-token cooldown
   - smart-v3 quarantine rule

3. For every candidate:
   - N
   - active days
   - chronological fold results
   - median net
   - <= -20% rate
   - max loss streak
   - winner concentration
   - later-winner leakage

4. State whether coverage is sufficient.

Core question:

```text
Can candle-derived filters produce a promotable cohort,
or are they only diagnostic due to low coverage?
```

If full candle coverage is low, do not promote. Recommend either measurement fix or discard as live evidence.

## PHASE 6 — BASELINES AND DATA SNOOPING

Output:

```text
analysis/edge-audit-2026-06-10/reports/06_BASELINES_AND_SNOOPING.md
```

Baselines:

1. Same-universe random entry
2. No-signal new token entry
3. SOL hold
4. Existing stopped live strategy replay

For each:

- use same period where possible
- use same cost assumptions
- bootstrap CI for strategy minus baseline
- state if CI includes zero

Data snooping audit:

- count how many cohorts/arms/segments were explored
- label best-looking rows as likely overfit unless they survive chronological OOS
- show top winner concentration

Core question:

```text
Is any claimed edge better than random / no-signal / SOL hold after costs?
```

## PHASE 7 — FINAL DECISION

Output:

```text
analysis/edge-audit-2026-06-10/EDGE_AUDIT_REPORT.md
```

Report top must contain:

```text
Verdict:
One-line reason:
Action:
```

Then include:

1. 3-line executive summary
2. Evidence table
3. What failed
4. What remains usable
5. What must be retired
6. If continuing, exact no-cost next step
7. Kill criteria

Required final decision matrix:

| Condition | Verdict |
|---|---|
| live wallet-truth negative and no promotable cohort | `RETIRE_CURRENT_LIVE` |
| gross signal non-positive across all robust segments | `REBUILD_SIGNAL_SOURCE` |
| gross positive but net negative after latency/cost | `EXECUTION_ALPHA_DECAY` |
| measurement/join/coverage too weak | `MEASUREMENT_INVALID` |
| only research/shadow positive | `RETIRE_CURRENT_LIVE` or `OFFLINE_COHORT_FOUND`, not micro-canary |
| one ex-ante cohort passes offline only | `OFFLINE_COHORT_FOUND` |
| ex-ante cohort passes offline + mirror + ruin + live preflight | `MICRO_CANARY_READY` |

## PROMOTION GATES

A cohort can reach `OFFLINE_COHORT_FOUND` only if:

- N >= 100
- active days >= 5
- chronological folds do not all fail
- wallet/cost stress net > 0
- post-cost positive ratio >= 52%
- max loss streak <= 10
- top5 winner share <= 35%
- route proof coverage >= 95%
- cost-aware coverage >= 95%
- comparable role coverage >= 95%
- no lookahead or hindsight label

A cohort can reach `MICRO_CANARY_READY` only if all above plus:

- paired mirror/live rows >= 30
- sign agreement >= 85%
- live wallet net > 0
- live without comparable paper = 0
- micro-canary ruin simulation = 0% under sleeve cap
- manual review required
- no automatic env enablement

## EXECUTION STRATEGY

Use a DAG. Do not run expensive repeated loops when set-based or cached artifacts exist.

```text
Phase 0 Data Audit
  -> if pass, build/read event_master
    -> Phase 1 Signal Event Study
    -> Phase 2 Cost/Latency
    -> Phase 3 Gate Funnel
    -> Phase 4 Translation Proof
    -> Phase 5 Candle Salvage
    -> Phase 6 Baselines
      -> Phase 7 Final Decision
```

Performance rules:

- Prefer existing report JSON over reparsing giant raw files.
- Use JSONL streaming for large files.
- Use worker threads only for bootstrap/random baseline.
- Keep DB/API calls disabled unless explicitly approved.
- All scripts must support `--sample` and `--force` if new scripts are created.
- `--sample` output is never cited in final verdict.

## START PROCEDURE

1. Read:

```text
SESSION_START.md
MISSION_CONTROL.md
docs/exec-plans/active/mission-reassessment-protocol-2026-05-22.md
```

2. Run:

```bash
git status --short
bash scripts/sync-vps-data.sh
npm run check:fast
```

3. Generate or refresh:

```bash
npm run kol:mission-offline-sim -- --realtime-dir data/realtime --reports-dir reports --json reports/mission-offline-sim-$(date -u +%F).json --md reports/mission-offline-sim-$(date -u +%F).md
npm run kol:historical-loss-report -- --realtime-dir data/realtime --min-rows 20 --max-p90-mfe 0.03 --md reports/historical-loss-miner-$(date -u +%F).md --json reports/historical-loss-miner-$(date -u +%F).json
npm run kol:candle-entry-proof-report -- --realtime-dir=data/realtime --md-out=reports/candle-entry-proof-$(date -u +%F).md --json-out=reports/candle-entry-proof-$(date -u +%F).json --mart-dir=data/research/candle-entry-proof
```

4. Execute Phase 0. If Phase 0 finds fatal measurement defects, stop and return `MEASUREMENT_INVALID`.

5. If Phase 0 passes, continue through Phase 7 and produce one primary verdict.

## FORBIDDEN SHORTCUTS

- Do not answer with optimism.
- Do not suggest "collect more data" unless the exact no-cost collection path and stop condition are stated.
- Do not promote `research_arm` or `shadow`.
- Do not call a cohort live-ready from paper-only evidence.
- Do not use KST cutoff for UTC data.
- Do not restart the bot.
- Do not lower the 0.6 SOL floor.
- Do not disable wallet protection gates.
- Do not interpret token-only PnL as wallet truth.

## EXPECTED FINAL STYLE

Be direct.

Acceptable final examples:

```text
Verdict: RETIRE_CURRENT_LIVE
Reason: live wallet-truth is negative and no cohort passed offline/mirror promotion gates.
Action: keep bot stopped; preserve data and simulator; research new signal source offline.
```

```text
Verdict: OFFLINE_COHORT_FOUND
Reason: one ex-ante cohort passed offline cost-stress and chronological OOS but lacks mirror/live proof.
Action: free/local forward shadow only; no paid Helius and no live canary.
```

Unacceptable:

```text
The results look promising; consider tuning parameters.
```

Every conclusion must say what to stop, what to keep, and what condition would change the decision.
