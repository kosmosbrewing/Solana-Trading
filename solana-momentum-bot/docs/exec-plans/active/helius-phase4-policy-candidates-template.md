# Helius Phase 4 — Policy Candidates ADR Template (2026-05-01)

> Status: 🟡 **template** — 7-day data 도달 후 채워질 placeholder ADR.
> Authority: `docs/exec-plans/active/helius-credit-edge-plan-2026-05-01.md` §7 Phase 4 + §11 rollout rules.
> 4-track 정책 분리 (운영자 결정 #4 답변 정합).
> Trigger: §1 의 "data evidence 도달" 조건 충족 시 본 template 채움 → ADR 승인 → Stream H sprint.

## §0 Decision Status

| Track | 정책 | 시점 트리거 | 현재 상태 |
|---|---|---|---|
| 1 | Token quality hard gate (HOLDER_TOP1_HIGH 등) | 7-day 측정 후 즉시 | 🟡 측정 대기 |
| 2 | Pool prewarm policy (sparse admission 보강) | 7-day 측정 후 즉시 | 🟡 측정 대기 |
| 3 | KOL role 자동화 (Stream G diff 채택) | **200-trade gate 도달까지 대기** | 🔴 보류 (sample 신뢰성) |
| 4 | Priority fee canary (Stream F 정책화) | `mode='live'` close 100 row 도달 시 (S3 trigger 정합) | 🔴 보류 (별도 ADR) |

## §1 7-day data 도달 acceptance gate

본 ADR 가 활성 status (template → proposal) 로 진행되기 위한 trigger 조건:

```text
ALL must be true:
  - kol-paper-trades.jsonl  rows  ≥ 200 (window 7d)
  - kol-live-trades.jsonl  rows  ≥ 50  (window 7d)
  - missed-alpha.jsonl  rows  ≥ 100 (window 7d)
  - data/research/helius-markouts.jsonl  rows ≥ 100 + coveragePct ≥ 0.70 ratio ≥ 60%
  - token-quality-observations.jsonl  rows ≥ 200 (riskFlags non-empty ratio ≥ 90%)
```

도달 시 Stream H sprint 운영자 승인 후 본 template 의 §2-§5 채움.

## §2 Track 1 — Token Quality Hard Gate

채택 시 entry 차단 (Real Asset Guard 강화 only — entry 확장 0).

### §2.1 측정 input
- `data/realtime/token-quality-observations.jsonl` 의 7-day window
- `data/realtime/kol-paper-trades.jsonl` ⨝ outcome
- `data/research/helius-markouts.jsonl` ⨝ markout

### §2.2 후보 hard gate flag
```text
[TBD — 7-day evidence 후 채움]

후보:
  HOLDER_TOP1_HIGH (top1 > 0.20)         → big-loss rate ?% / 5x rate ?%
  HOLDER_TOP10_HIGH (top10 > 0.80)       → big-loss rate ?% / 5x rate ?%
  HOLDER_HHI_HIGH (HHI > 0.25)            → big-loss rate ?% / 5x rate ?%
  EXIT_LIQUIDITY_UNKNOWN                  → big-loss rate ?% / 5x rate ?%
  POOL_NOT_PREWARMED                      → big-loss rate ?% / 5x rate ?%

채택 기준:
  - flag → big-loss rate ≥ all-loss rate × 1.5
  - flag → 5x rate ≤ all-5x rate × 0.5
  - 두 조건 모두 충족 시 hard gate 후보
```

### §2.3 acceptance
- 5x false-negative impact ≤ 5% (사명 §3 의 5x bucket 손실 제한)
- big-loss reduction ≥ 20%
- wallet floor margin 영향 0 (rule 2: entry 확장 안 함)
- Helius credit cost 영향 없음 (gate 자체는 cache 재사용)

## §3 Track 2 — Pool Prewarm Policy

채택 시 sparse admission 분류 활용 → POOL_NOT_PREWARMED 시 cooldown / retry 정책.

### §3.1 측정 input
- `data/realtime/admission-skips-dex.jsonl` (운영자 wiring 후)
- `data/research/helius-markouts.jsonl` (POOL_NOT_PREWARMED 후 5x 비율)

### §3.2 후보 정책
```text
[TBD]
- POOL_NOT_PREWARMED 시 60초 cooldown 후 재진입 시도
- registry hit count ≥ N 도달 후만 entry 허용
```

### §3.3 acceptance
- 진입 expansion 0 (정합)
- pool prewarm hit rate 향상 측정 가능
- credit cost 추가 미미

## §4 Track 3 — KOL Role 자동화 (Stream G)

**상태**: 🔴 **200-trade gate 도달까지 대기** (Plan §7 Phase 4 결정).

### §4.1 trigger
- `mode='live'` 의 `kol-live-trades.jsonl` 누적 close ≥ 200
- 동시에 사명 §3 의 0.7 SOL wallet floor 유지

### §4.2 채택 시
- `scripts/kol-wallet-style-backfill.ts` 의 diff report 가 7-day 마다 자동 생성
- 운영자 검토 → KOL DB 수동 적용 (rollout rule 4 정합 — auto-mutation 0 유지)

### §4.3 acceptance
- false-positive promote rate < 5% (이전 cycle 대비)
- 신규 active KOL 의 7-day 측정 5x 비율 측정 가능

## §5 Track 4 — Priority Fee Canary (Stream F)

**상태**: 🔴 **`mode='live'` close 100 row 도달 시 별도 ADR**.

### §5.1 trigger
- Research Ledger ADR §13 의 S3 dual-write trigger 와 정합
- `mode='live'` close 100 row 도달 + `priorityFeeEstimate` 측정 90%+ row 보유

### §5.2 채택 시
- canary fee escalation (Min → Medium 자동 승격)
- `landingLatencyMs` p95 측정 + 회귀 검증

### §5.3 acceptance
- 자동 escalation 은 별도 canary 사이클에서만 (rollout rule 5 정합)
- escalation 후 wallet floor 영향 0
- credit cost: priority fee API = 1c per call (영향 미미)

## §6 Rollout / Risk

- 4 track 모두 Plan §11 rollout rules 정합 — 일률 채택 안 함
- track 별 independent ADR (template 의 §2-§5 가 각 track 의 ADR §-부분)
- track 채택 후 1 sprint 단위 회귀 — wallet floor / 5x rate / big-loss rate / credit cost 4 metric 측정

## §7 Open Questions

- Track 1 의 holder threshold (top1 > 0.20) 가 7-day evidence 와 정합한지
- Track 2 의 cooldown 길이 (60s vs 300s) 운영자 선호
- Track 3 의 200-trade gate 가 사명 §3 의 200 trades 와 동일 trigger 인지 (예: trade vs close 정의 통일)
- Track 4 의 canary 사이클 길이 (1주 vs 2주)

## §8 Template 채움 절차

1. `npm run dsr-validator -- --source=both` 실행 → DSR Prob>0 측정
2. `scripts/winner-kill-analyzer.ts` 실행 → 5x winner 분포
3. `scripts/research-report.ts` 실행 (Research Ledger S5 sprint 후) → cohort breakdown
4. `scripts/kol-helius-markout-backfill.ts --since 7d` 실행 → markout report
5. `scripts/kol-wallet-style-backfill.ts --since 30d --dry-run` → KOL diff report
6. 본 template 의 §1 acceptance 통과 시 §2-§5 채움 → ADR 승인 → Stream H sprint
