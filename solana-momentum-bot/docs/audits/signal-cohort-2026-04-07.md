# Signal Cohort Audit

Generated: 2026-04-07T14:20:22.897Z
Source: signal-intents.jsonl across 4 sessions
Total rows: 86, with marketCapUsd: 71

## Status Distribution

| Status | Count |
|---|---:|
| executed_live | 15 |
| execution_failed | 6 |
| gate_rejected | 11 |
| risk_rejected | 54 |

## marketCap × status (signal counts)

| marketCap band | executed_live | execution_failed | gate_rejected | risk_rejected | total | exec rate |
|---|---:|---:|---:|---:|---:|---:|
| <$100K | 0 | 3 | 0 | 0 | 3 | 0.0% |
| $100K-1M | 7 | 1 | 3 | 10 | 21 | 33.3% |
| $1M-10M | 1 | 0 | 3 | 0 | 4 | 25.0% |
| $10M-100M | 7 | 2 | 1 | 33 | 43 | 16.3% |
| unknown | 0 | 0 | 4 | 11 | 15 | 0.0% |

## volumeMcap_ratio × status (signal counts)

| volumeMcap_ratio | executed_live | execution_failed | gate_rejected | risk_rejected | total | exec rate |
|---|---:|---:|---:|---:|---:|---:|
| 0.1-0.5 | 7 | 2 | 1 | 33 | 43 | 16.3% |
| 0.5-1.0 | 1 | 0 | 3 | 0 | 4 | 25.0% |
| 1.0-3.0 | 2 | 1 | 0 | 3 | 6 | 33.3% |
| >3.0 | 5 | 3 | 3 | 7 | 18 | 27.8% |
| unknown | 0 | 0 | 4 | 11 | 15 | 0.0% |

## Hypothesis Verdict

| Cohort | Definition | Signals | Executed | Exec Rate |
|---|---|---:|---:|---:|
| **low-cap surge** | mc<$1M AND ratio>1.0 | 24 | 7 | 29.2% |
| **high-cap continuation** | mc≥$10M AND ratio<0.5 | 43 | 7 | 16.3% |

### low-cap surge per-signal detail

| session | symbol | mc | ratio | status | filterReason |
|---|---|---:|---:|---|---|
| 2026-04-06T03-20-29 | LLM | $207,981 | 5.23 | executed_live | — |
| 2026-04-06T03-20-29 | LLM | $207,981 | 5.23 | risk_rejected | Cooldown active: 6 consecutive losses |
| 2026-04-06T03-20-29 | LLM | $207,981 | 5.23 | risk_rejected | Cooldown active: 6 consecutive losses |
| 2026-04-06T03-20-29 | LLM | $207,981 | 5.23 | executed_live | — |
| 2026-04-06T03-20-29 | LLM | $207,981 | 5.23 | risk_rejected | Cooldown active: 7 consecutive losses |
| 2026-04-06T03-20-29 | LLM | $207,981 | 5.23 | risk_rejected | Per-token cooldown active: 2 recent losses until 2026-04-06T |
| 2026-04-06T03-20-29 | LLM | $207,981 | 5.23 | gate_rejected | quote_rejected: Quote error: getaddrinfo ENOTFOUND api.jup.a |
| 2026-04-06T03-20-29 | LLM | $207,981 | 5.23 | risk_rejected | Cooldown active: 9 consecutive losses |
| 2026-04-06T14-17-04 | stonks | $495,415 | 12.76 | executed_live | — |
| 2026-04-06T14-17-04 | stonks | $495,415 | 12.76 | gate_rejected | quote_rejected: Quote error: write EPROTO C01C554A1C770000:e |
| 2026-04-06T14-17-04 | stonks | $495,415 | 12.76 | gate_rejected | quote_rejected: Quote error: getaddrinfo ENOTFOUND api.jup.a |
| 2026-04-06T14-17-04 | stonks | $495,415 | 12.76 | executed_live | — |
| 2026-04-06T14-17-04 | stonks | $495,415 | 12.76 | executed_live | — |
| 2026-04-06T14-17-04 | stonks | $495,415 | 12.76 | risk_rejected | Cooldown active: 10 consecutive losses |
| 2026-04-06T14-17-04 | stonks | $495,415 | 12.76 | risk_rejected | Per-token cooldown active: 2 recent losses until 2026-04-06T |
| 2026-04-06T14-17-04 | BTW | $110,735 | 1.23 | executed_live | — |
| 2026-04-06T14-17-04 | BTW | $110,735 | 1.23 | risk_rejected | Cooldown active: 10 consecutive losses |
| 2026-04-06T14-17-04 | BTW | $110,735 | 1.23 | executed_live | — |
| 2026-04-06T14-17-04 | BTW | $110,735 | 1.23 | risk_rejected | Cooldown active: 10 consecutive losses |
| 2026-04-06T14-17-04 | BTW | $110,735 | 1.23 | risk_rejected | Per-token cooldown active: 2 recent losses until 2026-04-07T |
| 2026-04-06T14-17-04 | 49 | $631,306 | 1.93 | execution_failed | Swap failed after 3 attempts: Request failed with status cod |
| 2026-04-07T03-53-05 | 4ytpZgVoNB66bF | $44,606 | 3.48 | execution_failed | [PRICE_ANOMALY_BLOCK] Entry ratio 0.000000 outside [0.7, 1.3 |
| 2026-04-07T03-53-05 | BTW | $47,670 | 3.29 | execution_failed | [PRICE_ANOMALY_BLOCK] Entry ratio 0.000000 outside [0.7, 1.3 |
| 2026-04-07T03-53-05 | BTW | $47,670 | 3.29 | execution_failed | [PRICE_ANOMALY_BLOCK] Entry ratio 0.000000 outside [0.7, 1.3 |

## Interpretation Notes

- 이 audit은 **signal 단위**다. 즉 cohort별 R-multiple은 산출하지 못한다 (axis_3 두 번째 acceptance).
- 그러나 cohort별 **pass rate**(signal → executed_live 진입률)를 직접 보여주므로, 사용자 가설 (저시총 surge edge)이 데이터 부족 때문인지, 가드 차단 때문인지 1차 분리 가능.
- low-cap surge cohort exec rate가 high-cap continuation 대비 현저히 낮으면 → universe 부족이 아니라 **가드 차단이 가설 검증을 봉인 중**이라는 정량 근거.
- 다음 단계: low-cap surge cohort에서 차단된 signal의 `filterReason`을 보고, `assertEntryAlignmentSafe` 가드의 false positive rate를 별도 측정 (F1-deep audit과 연동).