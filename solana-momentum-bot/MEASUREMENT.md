# Measurement Framework (post-pivot, refined 2026-04-21)

> Updated: 2026-05-06
> Goal: convexity 사명 하에서 전략 채택 / 승격 / 폐기 판정을 wallet truth 기준으로 내린다.
> Authority chain: [`SESSION_START.md`](./SESSION_START.md) / [`MISSION_CONTROL.md`](./MISSION_CONTROL.md) (current operating override) → [`mission-refinement-2026-04-21.md`](./docs/design-docs/mission-refinement-2026-04-21.md) (historical refinement) → [`mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md) → 본 문서
> Pre-pivot snapshot: [`docs/historical/pre-pivot-2026-04-18/MEASUREMENT.md`](./docs/historical/pre-pivot-2026-04-18/MEASUREMENT.md)
> Document type: reference policy

---

## 왜 재정의했는가

Pre-pivot 프레임 (`Mission Score + Execution Score + Edge Score → Composite`) 은:

- 설명 가능성 / attention context / RR 기반 pass 판정 중심
- DB `pnl` / WR / PF / Sharpe 같은 derived metric 에 의존
- 2026-04-17 wallet truth finding 으로 **DB pnl drift `+18.34 SOL`** 확인 → 해석 전체가 오염

따라서 measurement 를 아래 3원칙으로 재정의한다.

1. **Truth는 wallet delta 하나** — 그 외는 전부 reconciliation evidence.
2. **Objective function은 convexity** — log growth + winner 분포 + ruin probability.
3. **Explainability KPI는 retire** — attention / context / RR 기반 score 폐기.

---

## Source of Truth

| 우선순위 | 데이터 소스 | 용도 |
|---|---|---|
| 1 | Wallet balance delta | 최종 판정의 유일한 truth |
| 2 | `executed-buys.jsonl` / `executed-sells.jsonl` (FIFO) | wallet delta 구성 요소 분해 |
| 3 | `trades` DB | reconciliation evidence (단독 판정 금지) |
| 4 | Notifier / Telegram | 사용자 인지용 |

### Reconciliation Key

```text
BUY  = txSignature
SELL = dbTradeId or entryTxSignature
```

### Verification Cadence

- `npm run ops:reconcile:wallet -- --days N` — 수동, canary 전후 필수
- Runtime always-on wallet delta comparator — Block 1 구축 대상

---

## KPI 4단계 Maturity Gate (2026-04-21 refinement)

> **운영 판단은 이 4단계 외의 숫자를 보지 않는다.**
> 자세한 근거: [`mission-refinement-2026-04-21.md §5`](./docs/design-docs/mission-refinement-2026-04-21.md)

100 SOL 은 **tail outcome — 판단 변수 아님**. 진행 방향은 다음 Stage 통과 여부로 본다.

### Stage 1 — Safety Pass (현재)

| 체크 | 기준 |
|------|------|
| Wallet truth 정합 | 48h drift `< 0.01 SOL` |
| Survival filter 통과율 | 진입 pair 중 `>= 90%` safe |
| 0.7 SOL floor 유지 | 절대 위반 없음 |
| 0.01 SOL ticket | 고정 |
| RPC fail-safe | 무사고 |

통과 시 → Stage 2.

### Stage 2 — Sample Accumulation

| 체크 | 기준 |
|------|------|
| Live trade 누적 | `>= 100 trades` |
| Wallet max DD | `< 30%` |
| Paper vs live pnl gap | 측정 완료 (분포 기록) |
| Wallet stop halt | 0회 |

통과 시 → Stage 3.

### Stage 3 — Winner Distribution

| 체크 | 기준 |
|------|------|
| 5x+ winner | `>= 1건` 실측 |
| 10x+ winner | 분포 관측 (0건 가능) |
| Runner coverage | loser + bleed 를 덮는 trend 관측 |

통과 시 → Stage 4.

### Stage 4 — Scale Decision

| 체크 | 기준 |
|------|------|
| Trade 누적 | `>= 200 trades` |
| Wallet log growth | lane 별 `> 0` (primary) |
| Ruin probability | `< 5%` (block bootstrap) |
| Winner distribution | 5x+ rate, 10x+ rate 확정 |

이 단계에서 처음으로 ticket size 증가 / infra 확장 / lane 추가 결정.

---

## Detailed KPI (Stage 평가용)

### KPI 1. Wallet Log Growth Rate

```text
log_growth = ln(wallet_sol(t) / wallet_sol(t0)) / days
```

| 기준 | 해석 |
|---|---|
| `> 0` | 성장 구간 |
| `= 0` | 정체 — 비용에 의해 잠식 중일 가능성 |
| `< 0` | 축소 — 즉시 원인 분석 |

**주의**: `ln(100) ≈ 4.6` 도달까지의 속도는 **관찰 대상이지 판단 기준이 아님**. "언제까지 도달?" 계산 금지 (2026-04-21 refinement).

### KPI 2. Winner Distribution

| 항목 | 정의 |
|---|---|
| `5x+ rate` | 5x 이상 close trade 수 / 100 trades |
| `10x+ rate` | 10x 이상 close trade 수 / 100 trades |
| `Median winner R` | 양수 close 의 median R |
| `Max winner R` | 최대 R 기록 |

Baseline 은 **관측 후 설정** 한다. 관측 전 임의 threshold 도입 금지.

### KPI 3. Ruin Probability

- 정의: `wallet_sol < 0.3 SOL` 도달 확률 (Monte Carlo / bootstrap 시뮬)
- 기준: `< 5%`
- 계산: 최근 `N trades` 분포에서 block bootstrap

### KPI 4. Max Drawdown Survivability

| 항목 | 기준 |
|---|---|
| `peak-to-trough DD %` | wallet 기준으로 계산 |
| Hard stop | `wallet < 0.7 SOL` 에 도달하면 모든 lane halt (current operating floor) |
| 보조 | DD 후 복구 trade 수, DD 지속 시간 |

### KPI 5. Loss Streak / Bleed

- Max consecutive loss streak (정보용, hard threshold 없음)
- Per-100-trade wallet bleed: 왕복 비용(slippage + fee) × 체결 수

---

## Retired KPIs

Pre-pivot 프레임에서 유지하지 않는 항목:

- `Mission Score` (설명된 진입 비율, attention coverage, Context→Trigger 일관성)
- `Execution Score` 중 RR / effective RR gate 기반 pass 판정
- `Composite Score` (3-score 가중합)
- `Edge Score` 중 WR / PF / Sharpe (표본 희박 레짐에서 무의미)
- `positive token ratio` 기반 hard reject

이들은 historical 분석 / 파라미터 스윕 참고용 으로만 사용하고, **라이브 판정에는 쓰지 않는다**.

---

## Per-Stage Usage (2026-04-21 refined — trade count 구간별 목적 분리)

> **중요**: 50 / 100 / 200 trades 는 각각 다른 목적의 체크포인트이다. 아래 표의 `판단 성격` 컬럼을 반드시 확인한다. 50 trades 는 **승격 gate 아님** — safety 점검 목적 체크포인트일 뿐.

| 단계 | 주 KPI | 보조 KPI | 판단 성격 |
|---|---|---|---|
| Backtest | Wallet log growth (시뮬) | 5x+ rate, ruin probability (시뮬) | 설계 검증 |
| Paper | Entry rate, simulated wallet growth | 가상 5x+ rate, max consecutive loss | 코드 검증 |
| Live canary — Stage 1 (Safety Pass, 48h) | Wallet truth drift, survival pass rate, 0.7 floor 무위반 | hard guardrail 무사고 | stage gate |
| Live canary — **50-trade safety checkpoint** | bleed per probe, quick-reject 동작 여부, halt 빈도 | wallet delta 방향 | **관측 전용 — 승격 결정 없음** |
| Live canary — Stage 2 (100 trades preliminary check) | Live friction (paper vs live gap), max DD (< 30%), wallet stop 0회 | 5x+ winner 조짐 | preliminary edge/bleed/quickReject 검토 |
| Live canary — Stage 3 (Winner Distribution) | 5x+ winner 발생 여부, runner coverage | 10x+ winner 빈도 관측 | stage gate |
| Live canary — **Stage 4 scale/retire decision (200 trades)** | Wallet log growth rate (primary), lane log growth > 0, winner distribution, ruin probability | max DD, loss streak | **scale / retire / hold 최종 결정** |

---

## Real Asset Guard vs Observability Guard (2026-04-21)

모든 guard/halt 조건은 **2범주**로 분류한다. 운영 태도가 다르다.

### Real Asset Guard (타협 불가)

실제 자산을 보호한다. 발동 시 **운영자 개입 필수**. 이 범주는 절대 완화하지 않는다.

| Guard | 현 값 | 역할 |
|-------|-------|------|
| Wallet Stop | `wallet_sol < 0.7` | 전 lane halt |
| Canary Budget Cap | `cumulativePnlSol <= -0.3` (lane별) | 해당 lane halt |
| Security Hard Reject | mint/freeze authority, honeypot sim | 진입 차단 |
| Wallet Delta HALT | drift `>= 0.2 SOL` | 전 lane halt |
| Daily Bleed Budget | `wallet × 0.05` | 해당 lane probe 중단 |

### Observability Guard (튜닝 대상)

실험의 trade distribution 을 관찰하기 위한 circuit breaker. 발동이 반복되면 **guard 자체를 재평가** 한다.

| Guard | 현 값 | 역할 |
|-------|-------|------|
| Consecutive Losers | `>= 8` | canary halt trigger |
| Canary Auto-Reset | 30분 경과 시 자동 해제 | observability halt 해제 |
| V2 detector minPassScore | 50 | signal 빈도 조절 |
| V2 per-pair cooldown | 300s | pair diversity |
| V1 bootstrap per-pair cooldown | 300s | pair diversity |
| Entry drift guard | `> +2%` (asymmetric) | bad fill 차단 |

### 운영 태도 규칙

- 운영자가 "halt 가 자주 걸린다" 고 느끼면 → **먼저 observability guard 완화 검토**
- real asset guard 는 **절대 건드리지 않음**
- observability guard 완화는 운영 데이터 근거 필요 ([`PUREWS_V2_SUMMARY`] 로그 등)

---

## Daily / Weekly Review Questions (2026-04-21)

매일/주 리뷰는 **오직 아래 4개 질문에만 답한다**. 수익률 %, 100 SOL 도달 예상일 등은 금지.

1. **Wallet delta 와 DB pnl 의 drift 가 허용 범위 내인가?** (> 0.03 SOL = warn, > 0.2 SOL = halt)
2. **Survival filter 통과율은?** (진입 pair 중 Layer 1 safe 비율)
3. **Trade count 진행률은?**
   - 현재 어느 Stage 인가 (1 Safety / 2 Sample / 3 Winner / 4 Scale)
   - 50 trades 도달 시: safety checkpoint 만 수행 (승격 결정 없음)
   - 100 trades 도달 시: preliminary edge/bleed/quickReject 검토
   - 200 trades 도달 시: scale / retire / hold 최종 결정
4. **Bleed per probe 추이는?** (비용 구조 개선 중인가)

이 4개에 대한 답이 나오지 않으면 운영 로그/텔레메트리에 문제가 있는 것 — 코드 fix 대상.

---

## Hard Rules

### R1. DB 단독 판정 금지

- DB `pnl` 합계 / WR / PF 만으로 전략 채택 / 폐기 결정 금지.
- 이 항목은 wallet reconcile 뒤에만 참고.

### R2. Single-Session Outlier 금지

- 1개 세션 또는 1개 토큰에서 나온 outlier 결과는 edge 증거 아님.
- 최소 `100 live trades` (preliminary check) + 복수 세션 + 복수 토큰에서 재현돼야 관찰 가치가 있으며, 최종 scale/retire 판정은 `200 trades` (Stage 4) 에서만 내린다.

### R3. Paper-Only Success 승격 금지

- Paper 에서 signal 재현은 필요 조건이지 승격 근거 아님.
- Live canary 에서 wallet delta 양수 + 가드레일 무사고 여야 확대.

### R4. Pivot Hard Guardrails Override Everything

- Wallet Stop Guard `< 0.7 SOL` → 전 lane halt
- RPC fail-safe → lane halt
- Security hard reject (top-holder %, mint/freeze authority, honeypot)
- 이 가드는 KPI 점수와 무관하게 무조건 작동.

### R5. Cupsey 개조 금지

- `cupsey_flip_10s`는 benchmark 로 사용. 파라미터 튜닝 / 구조 변경 금지.
- 새 lane 의 wallet 성과를 cupsey 대비로 평가.

---

## Operational Procedures

### 1. Backtest 단계

- 시뮬 wallet log growth + 시뮬 winner distribution 만 기록.
- WR / PF / Sharpe 는 부록으로만 기록 (판정 금지).

### 2. Paper 단계

- Entry rate, simulated wallet growth, 가상 5x+ 빈도, loss streak 측정.
- cupsey benchmark 와 paper-paper A/B 비교.

### 3. Live Canary 단계 (Stage 1 Safety Pass, 0 ~ 48h)

- Ticket: default 0.01 SOL, KOL 0.02 SOL, 동시 max 3.
- Wallet Stop Guard 0.7 SOL 작동 확인 필수.
- 매 10 trades 마다 wallet reconcile 실행.

### 4. Live Canary — 50-trade safety checkpoint (관측 전용)

- **승격 결정 없음**. bleed per probe, quick-reject 동작, halt 빈도 점검만.
- 여기서 나온 결과로 ticket 확대 / lane 추가 결정 금지.
- 이슈 발견 시 Observability Guard 튜닝 (Real Asset Guard 는 건드리지 않음).

### 5. Live Canary — 100-trade preliminary check (Stage 2)

- Live friction (paper vs live pnl gap) 분포 기록.
- Max DD `< 30%` 확인.
- Wallet stop halt 0회 확인.
- 5x+ winner 조짐 유무 관찰 (Stage 3 통과 여부 판단 근거).

### 6. Live Canary — Stage 3 (Winner Distribution)

- 5x+ winner `>= 1건` 실측 여부.
- Runner 가 누적 loser + bleed 를 덮는 방향 관측.

### 7. Live Canary — 200-trade scale/retire decision (Stage 4)

- Wallet log growth rate (primary), lane 별 `> 0` 여부.
- Ruin probability `< 5%` (block bootstrap) 재확인.
- Winner distribution 5x+ / 10x+ rate 확정.
- **처음으로** ticket size 증가 / infra 확장 / lane 추가 / retire 여부 판정.

---

## Tooling

| 도구 | 용도 |
|---|---|
| `scripts/wallet-reconcile.ts` | FIFO pair matching, wallet delta 구성 분해 |
| `scripts/ledger-audit.ts` | executed ledger ↔ DB 정합성 |
| `scripts/trade-report.ts` | per-trade 비용 + winner 분포 |
| (planned) Runtime wallet comparator | always-on drift 감지 |

---

## One-Line Summary

> 측정은 wallet log growth + winner 분포 + ruin probability. DB 단독 판정 금지, cupsey 개조 금지, hard guardrail 절대 불변.
