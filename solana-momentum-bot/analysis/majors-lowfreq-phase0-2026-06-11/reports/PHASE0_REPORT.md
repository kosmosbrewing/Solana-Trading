# H-009 Phase 0 — 메이저 페어 저빈도 룰 판정

> Verdict: **REJECTED** (사전 등록 kill criteria 발동 — HYPOTHESES.md H-009, 등록 commit `e5e5414`)
> Data: Binance 공개 4h klines — SOL 12,780 bars (2020-08..2026-06) / BTC·ETH 19,304 bars (2017-08..)
> 비용: RT 0.6% (보수 주판정), 체결 = 신호 bar 다음 bar open. 판정 구간: 2024-06-11..2026-06-11.

## 1. 판정 (SOL = 주판정 자산, RT 0.6%)

| rule | full-history | full maxDD | **recent 2y** | trades | 발동 kill |
|---|---:|---:|---:|---:|---|
| A_tsmom_180 | — | >50% | ≤0 | — | K1+K2 |
| A_tsmom_360 | +4,174% | 84% | **−72.7%** | 157 | K1+K2 |
| A_tsmom_540 | — | >50% | ≤0 | — | K1+K2 |
| B_ma_20_100 | — | >50% | ≤0 | — | K1+K2 |
| B_ma_50_200 | +13,155% | 79% | **−19.9%** | 36 | K1+K2 |
| C_rsi_pullback | +83% | 53% | **−39.0%** | 70 | K1+K2+K3 |

(SOL buy&hold: full +2,108% / maxDD 97% / recent 2y −60%)

**6/6 전 family 기각 → kill criterion 5: H-009 `REJECTED`, 재검정 조건 없음 (영구).**

## 2. 엔진 정합성 (이 판정이 버그가 아닌 근거)

- full-history 는 문헌과 일치: BTC golden cross +2,707%, ETH MA cross +9,477%, SOL TSMOM +4,174% — TSMOM anomaly 는 **실재했다**.
- 연도별 분해도 알려진 regime 재현: 2021 대폭 양수 / 2022 음수 / 2023 회복.
- 즉 결론은 "전략이 원래 안 됨" 이 아니라 **"존재했던 edge 가 판정 구간 (2024-06 이후) 에서 SOL 기준 사망"** — H-009 가 검정하려던 바로 그 질문에 대한 답이 '아니오'.

## 3. 판정을 넘어서는 구조적 발견 — maxDD 가 사명과 비호환

edge 유무와 무관하게, **모든 rule 의 full-history maxDD 가 53~84%** 다. 역사상 가장 좋았던 구간을 포함해도 그렇다. mission v2 의 생존 우선 원칙 (wallet floor 사수, drawdown 비관용) 과 long/flat 메이저 추세 전략은 **구조적으로 비호환**이다 — 통과했어도 sizing 을 줄여 deploy 했어야 했고, 그러면 기대 절대수익 (연 $200-300) 은 더 쪼그라든다.

## 4. 사후 관측 (hypothesis_only — 등록하지 않음)

- ETH 는 recent 2y 에서 TSMOM_360 +70.5% / MA 50/200 +47.3% 로 양수, BTC 는 ~0, SOL 은 음수.
- 그러나 이것은 **결과를 본 후의 자산 선택** (3개 중 1개 양수 = multiple comparison) 이고, ETH 조차 maxDD 60-73% 로 §3 비호환 그대로다. 자산 로테이션/상대 모멘텀 류의 새 가설로 발전시키려면 별도 사전 등록 + 신선 forward 검증이 필요하며, **현 시점 등록을 권하지 않는다** (§3 의 구조 문제가 먼저).

## 5. 의미

- 두 아티클에서 건진 salvage 경로가 모두 해소됨: 복리형 연구 루프 (가설 원장 가동 — 이 판정이 첫 산출물), 메이저 저빈도 가설 (기각).
- H-009 의 부수 가치는 실현됨: **가설 원장의 첫 완주** (사전 등록 → 검정 → 판정 → 영구 기록) 를 데이터 다운로드 포함 ~1시간, $0 에 완료.
- 연구 초점은 전면적으로 H-007 (holder/dev 행동, PRIMARY) + H-008 (레버 1 재검정, D+7) 로 복귀.
