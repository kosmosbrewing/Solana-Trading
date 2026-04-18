# Measurement Framework (post-pivot)

> Updated: 2026-04-18
> Goal: convexity 사명 하에서 전략 채택 / 승격 / 폐기 판정을 wallet truth 기준으로 내린다.
> Pivot decision: [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md)
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

## KPI Set (post-pivot)

### KPI 1. Wallet Log Growth Rate (Primary)

```text
log_growth = ln(wallet_sol(t) / wallet_sol(t0)) / days
```

| 기준 | 해석 |
|---|---|
| `> 0` | 성장 구간 |
| `= 0` | 정체 — 비용에 의해 잠식 중일 가능성 |
| `< 0` | 축소 — 즉시 원인 분석 |

100 SOL 도달까지 약 `ln(100) ≈ 4.6` 의 log-growth 가 필요하다. 비율, 속도, drawdown 을 함께 본다.

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
| Hard stop | `wallet < 0.8 SOL` 에 도달하면 모든 lane halt (pivot 불변) |
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

## Per-Stage Usage

| 단계 | 주 KPI | 보조 KPI |
|---|---|---|
| Backtest | Wallet log growth (시뮬) | 5x+ rate, ruin probability (시뮬) |
| Paper | Entry rate, simulated wallet growth | 가상 5x+ rate, max consecutive loss |
| Live canary (`< 50 trades`) | Wallet delta 방향 (양수/음수), hard guardrail 무사고 | bleed per trade |
| Live full (`≥ 50 trades`) | Wallet log growth rate (primary), winner distribution, ruin probability | max DD, loss streak |

---

## Hard Rules

### R1. DB 단독 판정 금지

- DB `pnl` 합계 / WR / PF 만으로 전략 채택 / 폐기 결정 금지.
- 이 항목은 wallet reconcile 뒤에만 참고.

### R2. Single-Session Outlier 금지

- 1개 세션 또는 1개 토큰에서 나온 outlier 결과는 edge 증거 아님.
- 최소 `50 trades` + 복수 세션 + 복수 토큰에서 재현되어야 승격 후보.

### R3. Paper-Only Success 승격 금지

- Paper 에서 signal 재현은 필요 조건이지 승격 근거 아님.
- Live canary 에서 wallet delta 양수 + 가드레일 무사고 여야 확대.

### R4. Pivot Hard Guardrails Override Everything

- Wallet Stop Guard `< 0.8 SOL` → 전 lane halt
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

### 3. Live Canary 단계 (0 ~ 49 trades)

- Ticket: 0.01 SOL, 동시 max 3.
- Wallet Stop Guard 0.8 SOL 작동 확인 필수.
- 매 10 trades 마다 wallet reconcile 실행.

### 4. Live Full 단계 (≥ 50 trades)

- Wallet log growth rate (primary)
- Winner distribution baseline 설정
- Ruin probability 시뮬
- Max DD 확인

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
