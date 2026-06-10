# Phase 3 — Gate and Admission Funnel

> Data: kol-tx.jsonl (201,995 rows), kol-policy-decisions.jsonl (113,654), missed-alpha.jsonl (21,293 unique rejects), kol-live-trades.jsonl (dedup 325), mission-offline-sim veto search.

## 3.1 Funnel (전 기간)

| 단계 | N | 비고 |
|---|---:|---|
| KOL buy tx 관측 | 136,373 (unique mints 28,450) | kol-tx.jsonl |
| policy 평가 reject | 105,511 | currentAction=block |
| policy 평가 entry | 3,186 (관측 대비 ~2.3%) | |
| paper close (전 arm union) | 5,384 | multi-arm 중복 포함 |
| **mirror close (translation 증거)** | **21** | 2026-05-19 도입, 표본 미달 |
| live close | 475 (executed 기준) / 325 (close ledger) | |
| live 중 T1 winner exit | 22 | winner_trailing_t1 |
| live 중 T2 도달 | **1** | winner_trailing_t2 |
| live 중 T3 도달 | **0** | |

## 3.2 Gate 분리력 — pass vs reject forward return

| Cohort | T+60 med | T+300 med | T+1800 med |
|---|---:|---:|---:|
| 진입 (pass) | +0.25% | −9.6% | −47.9% |
| viability reject (n=19,773, 측정 754@T300) | −0.23% | −7.9% | −46.1% |
| **pass − reject delta** | **+0.5%p** | **−1.7%p** | **−1.8%p** |

Admission gate 의 forward-return 분리력은 **사실상 0**. Gate 는 "더 나쁜 것" 을 거르지 못했다 — universe 전체가 같은 모양으로 썩기 때문이다 (security/honeypot 차단의 비측정 가치는 별도 — quote 로는 honeypot 손실 방지가 관측되지 않음).

entry_drift reject (med −91% cluster) 는 signal-price bug 와 얽혀 diagnostic only. survival reject 는 ok-coverage 미달로 판정 불가.

## 3.3 Admission-loss veto ablation (offline-sim 재인용 + dedup 주의)

| Veto | rows | saved loss | missed 5x MFE | after-veto live net* |
|---|---:|---:|---:|---:|
| probe_hard_cut | 88 | +0.459 | 0 | −1.147 |
| entry_advantage_emergency_exit | 145 | +0.373 | 0 | −1.204 |
| rotation_dead_on_arrival | 48 | +0.261 | 0 | −1.304 |
| smart_v3_mae_fast_fail | 24 | +0.130 | 0 | −1.436 |
| **4종 동시 적용** | 305 | **+1.222** | 0 | **−0.394** |

\* offline-sim 의 596-row (이중 계산) 기준 — 절대값은 부풀려졌으나 빼도 부호는 동일 (vetoed row 도 같은 비율로 중복).

**모든 veto 조합이 live 를 음수에 남긴다.** missed 5x = 0 이므로 veto 자체는 안전하지만, **"loss reduction is useful, but not sufficient edge."**

## 3.4 Live 손실 귀속 (dedup ledger, n=325, −0.8029 SOL)

| Exit bucket | N | Net SOL |
|---|---:|---:|
| probe_hard_cut | 59 | −0.256 |
| entry_advantage_emergency_exit | 71 | −0.171 |
| rotation_dead_on_arrival | 23 | −0.125 |
| insider_exit_full | 69 | −0.069 |
| smart_v3_mae_fast_fail | 12 | −0.065 |
| 기타 방어 exit 합 | 68 | −0.154 |
| winner_trailing_t1 | 22 | +0.013 |
| winner_trailing_t2 | 1 | +0.024 |
| tail (max_hold 등) | 13 | −0.003 |

승자 측 총 기여 **+0.037 SOL** vs 패자 측 **−0.840 SOL** — 비율 1:23.
Payoff 구조 (PROBE→T1→T2→T3) 는 325 close 에서 **T2 1회 / T3 0회**. "few large preserved winners" 가 존재한 적이 없으므로, "many small controlled losses" 는 회수원 없는 순수 bleed 였다.

## 3.5 Phase 3 판정

Core question — *"Are gates filtering losers, or also killing the few winners? Can admission vetoes alone turn live replay positive?"*

- Gate 는 loser 를 분리하지 못한다 (delta ≈ 0). 다만 winner 를 죽인 것도 admission gate 가 아니다 — winner 를 죽인 것은 **exit 구조 (16s median hold)** 다 (Phase 1.3 / 2.5).
- Admission veto 4종 동시 적용으로도 live 음수 유지. **veto 최적화는 bleed 속도를 늦출 뿐 edge 를 만들지 못한다.**
