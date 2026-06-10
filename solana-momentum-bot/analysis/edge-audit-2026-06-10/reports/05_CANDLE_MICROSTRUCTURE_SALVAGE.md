# Phase 5 — Candle / Microstructure Salvage

> Data: reports/candle-entry-proof-2026-06-10.{md,json} (2026-06-10 재생성), data/research/candle-entry-proof/*.jsonl, data/realtime/sessions/** (345 candle files, 47.6M candle rows 스캔).

## 5.1 Coverage — 구조적 결손

| Metric | 값 |
|---|---:|
| buy anchors (usable price) | 5,187 |
| pre60 candle 보유 | 141 (2.7%) |
| **full (pre60 + T+300) coverage** | **94 (1.81%)** |
| 결손 원인 1위 | `no_token_candles` 90%+ |

원인은 수집 설계: micro-candle 은 WS session scanner 가 구독한 pair 만 기록되는데, **KOL discovery 토큰의 90% 는 session 구독 대상이 아니었다**. 즉 후보 발견 경로와 microstructure 기록 경로가 분리되어 있었다. (pure_ws lane 만 79.75% coverage — 자기 session 안에서 발견하기 때문.)

## 5.2 Ex-ante rule 평가 (report 인용)

| Rule | Verdict | Rows | 비고 |
|---|---|---:|---|
| rotation_prestable_admission_v2 | DATA_GAP | 0 | 표본 없음 |
| rotation_doa15_failfast_v1 | DATA_GAP | 13 | median delta +13.8%p (방향 긍정적, 표본 미달) |
| rotation_pass30_trail_v1 | DATA_GAP | 6 | median delta +19.5%p (동일) |
| **rotation_fail30_cooldown_v1** | **REJECT** | 34 | post-cost median −22.6%, top5 winner share 100% |
| smartv3_candle_quarantine_v1 | DATA_GAP | 2 | 표본 없음 |

유일하게 표본이 모인 rule (fail30 cooldown) 은 **REJECT**. 나머지는 N<30 으로 판정 불가 — promotion gate (N≥100, 5+ days) 대비 1-2 자릿수 부족.

## 5.3 Phase 5 판정

Core question — *"Can candle-derived filters produce a promotable cohort, or are they only diagnostic due to low coverage?"*

**Diagnostic only.** Coverage 1.81% 는 Phase 0 stop condition 을 발동시키며, 어떤 candle rule 도 승격 근거가 될 수 없다.

측정 수리 경로 (참고, 비용 0): KOL 후보 detect 시점에 해당 pair 를 WS candle 구독에 동적으로 추가하면 (subscribe-on-candidate), 추가 API 비용 없이 향후 full coverage 를 80%+ 로 끌어올릴 수 있다. 단 이것은 **새 신호 검증 인프라의 이야기이고, 현 전략의 구제책이 아니다** — Phase 1-4 가 보여준 부정 판정을 뒤집을 데이터가 아니라, 다음 가설 검증을 싸게 만드는 도구다.
