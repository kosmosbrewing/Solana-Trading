# Phase 0 — Survivor Momentum Trigger 판정

- generated: 2026-06-10T11:45:42Z (seed 20260610, bootstrap 1000)
- events: 3020 / unique pairs: 318
- cost bars: ticket 0.05 → 6.9% / ticket 0.1 → 4.2%
- primary horizon: T+30min (median 기준 판정)

## t1_burst

- events 151 / pairs 24 / active days 18

| horizon | N | median | mean(cap10) | P(>0) | P(<=-20%) | P(>=+50%) | stale | censored |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| T+5m | 151 | -2.4% | -4.3% | 30% | 12% | 0% | 0% | 0% |
| T+15m | 150 | -1.8% | -4.8% | 37% | 17% | 2% | 1% | 1% |
| T+30m | 142 | -2.1% | -3.0% | 37% | 18% | 3% | 7% | 6% |
| T+60m | 129 | -4.3% | -5.6% | 30% | 19% | 2% | 18% | 15% |
| T+120m | 105 | -4.6% | -3.8% | 34% | 23% | 3% | 34% | 30% |

- primary (T+30m) median CI95: [-4.7%, -0.6%]
- **post-cost median**: ticket 0.05 → -9.0% / ticket 0.1 → -6.3%
- chrono: 전반 -2.3% (n=134) / 후반 +2.5% (n=8)
- first-event-per-pair: -7.4% (n=22)

## t2_persist

- events 2622 / pairs 307 / active days 52

| horizon | N | median | mean(cap10) | P(>0) | P(<=-20%) | P(>=+50%) | stale | censored |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| T+5m | 2619 | -0.1% | -0.3% | 46% | 3% | 0% | 0% | 0% |
| T+15m | 2531 | -0.1% | -0.7% | 48% | 6% | 1% | 4% | 3% |
| T+30m | 2424 | -0.2% | -0.8% | 48% | 8% | 1% | 9% | 8% |
| T+60m | 2222 | -0.5% | -1.1% | 46% | 11% | 2% | 17% | 15% |
| T+120m | 1908 | -0.8% | -0.2% | 46% | 14% | 4% | 29% | 27% |

- primary (T+30m) median CI95: [-0.4%, -0.0%]
- **post-cost median**: ticket 0.05 → -7.1% / ticket 0.1 → -4.4%
- chrono: 전반 -0.1% (n=1091) / 후반 -0.3% (n=1333)
- first-event-per-pair: -1.4% (n=257)

## t3_breakout

- events 247 / pairs 78 / active days 49

| horizon | N | median | mean(cap10) | P(>0) | P(<=-20%) | P(>=+50%) | stale | censored |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| T+5m | 247 | -0.0% | -0.8% | 48% | 2% | 0% | 0% | 0% |
| T+15m | 237 | -0.0% | -1.8% | 49% | 8% | 1% | 4% | 4% |
| T+30m | 227 | -0.3% | -3.4% | 45% | 9% | 0% | 9% | 8% |
| T+60m | 211 | -0.4% | -5.0% | 45% | 12% | 1% | 15% | 15% |
| T+120m | 172 | -0.8% | -6.1% | 42% | 16% | 1% | 31% | 30% |

- primary (T+30m) median CI95: [-0.6%, +0.0%]
- **post-cost median**: ticket 0.05 → -7.2% / ticket 0.1 → -4.5%
- chrono: 전반 +0.0% (n=107) / 후반 -0.6% (n=120)
- first-event-per-pair: -3.6% (n=71)

## 판정

**REJECT_ALL** — 기각 조건: 전 trigger 의 T+30m post-cost median 이 두 ticket 시나리오 모두 음수.

주의: Phase 0 은 기각 필터다. CANDIDATE 가 나와도 N/active days/chrono/first-per-pair 를 통과해야 Phase 1 paper 설계 자격이 생긴다 (통과 ≠ 증명).
