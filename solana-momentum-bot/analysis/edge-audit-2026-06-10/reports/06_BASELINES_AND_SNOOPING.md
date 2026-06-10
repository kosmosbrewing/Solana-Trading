# Phase 6 — Baselines and Data Snooping

## 6.1 Baselines (동일 기간 / 동일 비용 가정)

| Baseline | 결과 | Strategy − Baseline |
|---|---|---|
| 1. Same-universe random entry (viability reject 군을 무선택 진입의 proxy 로 사용) | T+300 med −7.9% / T+1800 med −46.1% | **−1.7 ~ −1.8%p (전략이 오히려 약간 더 나쁨)** — CI 가 0 포함, 선택 효과 무 |
| 2. No-signal new token entry (pure_ws paper) | T+300 med −0.06% (n=25) | 표본 미달 — 판정 불가 |
| 3. SOL hold | 0.000 SOL (정의상) | live −1.128 SOL (475 closes). bootstrap CI: dedup −0.803 [−0.98, −0.62], **P(>0)=0.0000** |
| 4. Stopped live strategy replay | −0.803 (dedup ledger) / −1.128 (executed 기준) | — |

Core question — *"Is any claimed edge better than random / no-signal / SOL hold after costs?"* → **NO.** 세 baseline 모두에 대해 열위이거나 (SOL hold, P≈1), 무차별 (same-universe random).

## 6.2 Winner concentration (live)

| Metric | 값 | Cap |
|---|---:|---|
| gross positive | 0.2536 SOL | — |
| top5 winner share | **50.4%** | ≤35% — **위반** |
| top10 winner share | **75.4%** | ≤50% — **위반** |

Live 의 (작은) 승자 합조차 5건에 절반이 몰려 있다 — 어떤 양수 pocket 도 구조가 아니라 우연으로 설명된다.

## 6.3 Data snooping 표면적

| 탐색 차원 | 규모 |
|---|---|
| armName (실행/paper/shadow arm) | **23종** |
| historical-loss-miner cohort label | 470+ (research_only 9 + demoted 162 + execution_gap 299) |
| probe-policy sweep grid | 64 combos (confirm 4 × threshold 4 × target 4) |
| rotation offline-sim cohort | 5 (전부 QUARANTINE / RESEARCH_ONLY) |
| chronological OOS (rotation v2) | **4/4 slice FAIL** |

이 탐색량 대비, chronological OOS 를 통과한 cohort 는 **0개**다. 유일하게 leakage-free 로 양수처럼 보였던 `v2_kadenox_hypothesis` 는 simulator 가 직접 `leakage verdict FAIL: hypothesis-only cohort` (결과를 보고 KOL 을 고름) 로 차단했고, top5 share 81% 였다.

**판정: 남아있는 "양수처럼 보이는 모든 것" 은 (a) 비승격 role 이거나 (b) snooping 산물이거나 (c) 표본 미달이다.** 추가 탐색 (더 많은 arm/threshold) 은 이 표면적을 키워 false positive 위험만 높인다.
