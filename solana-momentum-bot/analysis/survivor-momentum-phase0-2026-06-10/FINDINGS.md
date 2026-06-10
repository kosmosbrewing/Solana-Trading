# Phase 0 Findings — Survivor Momentum (2026-06-10)

> Verdict: **REJECT_ALL** (사전 등록 기각 조건 발동 — lane design §6/§7)
> Artifacts: `reports/PHASE0_REPORT.md`, `cache/events.jsonl` (3,020 events), `cache/phase0_summary.json`
> Data: sessions micro-candles 810개 세션 (2026-03-31..05-22), unique pairs 1,334, 10s bars (중복 최종본 dedup)

## 1. 판정 요지

세 trigger 모두 T+30m gross median 이 음수 또는 0 — **비용을 빼기도 전에 edge 가 없다**:

| trigger | N | T+30m gross median | CI95 | post-cost (0.1 ticket) | first-per-pair |
|---|---:|---:|---|---:|---:|
| t1_burst | 142 | −2.1% | [−4.7%, −0.6%] | −6.3% | −7.4% |
| t2_persist | 2,424 | −0.2% | [−0.4%, −0.0%] | −4.4% | −1.4% |
| t3_breakout | 227 | −0.3% | [−0.6%, +0.0%] | −4.5% | −3.6% |

- t1 (burst 추격) 은 **gross 부터 유의하게 음수** — burst 매수 = 단기 고점 매수. KOL universe 에서 본 패턴의 재현.
- t2/t3 는 gross ≈ 0 (효율적) — 4.2~6.9% 비용 bar 를 넘을 재료가 없다.
- P(≥+50%) 0~4% — **이 universe 에는 수확할 우상단 tail 자체가 얇다** (KOL universe 의 5x rate ~2.2% 와 대조적으로, 생존 필터가 tail 도 같이 깎는다).

## 2. 단 하나의 긍정적 발견 — 필터는 작동한다

KOL universe (edge audit Phase 1): T+5m median −9.6%, T+30m −47.9%.
Survivor universe (이번): T+30m median −0.2~−2%, P(≤−20%) 8~18%.

**생존 + 나이 + 활동 필터는 death-spiral bleed 를 실제로 제거했다.** 문제는 그 위에 "진입 edge" 가 없다는 것 — universe 는 살아남지만, 가격/거래량 모멘텀만으로는 비용을 넘는 진입 시점을 고를 수 없었다.

함의: 손실 통제 (mission v2 목표 ①) 의 universe 정의로는 유효. 수익 신호 (목표 ④) 는 10s 가격/거래량 bar 바깥의 정보가 필요하다.

## 3. 한계 (이 판정이 말하지 않는 것)

1. **Universe 대표성**: 1,334 pairs = 우리가 구독했던 pool (scanner watchlist + 일부 KOL coverage). "시장의 모든 생존 토큰" 이 아니다. coverage 레버 1 이 가동된 신선 데이터에서는 universe 가 넓어진다 — 재검정 가치 있음.
2. **Trigger 근사**: t1 은 pure_ws v2 detector 의 Python 근사 (원 구현과 파라미터 차이 가능). t2 는 cupsey gate 유산의 재구성. 단 세 trigger 의 방향이 일치하므로 (gross ≈ 0 또는 음수) 파라미터 미세조정으로 +4.2% bar 를 넘을 가능성은 낮다.
3. **Fill 현실성**: entry = trigger bar close (낙관적). 실제는 이보다 나쁘다 — 판정을 강화하는 방향.
4. **출생 proxy**: first-seen = 구독 시작 시각. 진짜 token age 보다 늦을 수 있어 "30min 생존" 필터가 실제보다 느슨하게/엄격하게 적용된 pair 혼재.

## 4. 다음 가설 방향 (사전 등록 대상 — 이번 판정의 잔해에서)

이번 데이터가 지지하지 않는 것: 가격/거래량 모멘텀 추격 (3 형태 모두).
아직 검정 안 된 것 (새 가설로 사전 등록 후 검정해야 함):

1. **10s bar 바깥 정보**: holder 분포 변화 / dev wallet 행동 / 신규 holder 유입 속도 — tokenQualityInspector·devWalletRegistry 계열 데이터와 join (현재 4,944 obs 로 N 부족 → observe run 적립 필요).
2. **Regime/시간대 조건부**: trigger × UTC 시간대 / 시장 전체 활동 수준 조건부 — 이번 cache (events.jsonl) 로 추가 슬라이스 가능하나, 사후 선택이므로 `hypothesis_only` 라벨 필수.
3. **Coverage 수리 후 재검정**: 레버 1 가동 데이터 (D+7 이후) 에서 같은 trigger 를 동일 조건 재실행 — universe 확장의 효과 분리.

## 5. 결론 (mission v2 정합)

- Lane design §7 kill criteria 그대로 적용: **survivor momentum lane (현 trigger 정의) 폐기. 코드 구현 없음, 매몰 비용 0.**
- 이것은 시스템이 설계대로 작동한 것이다 — 가설 하나를 paper 수개월/live 손실 없이 ~40분, $0 에 기각했다.
- 관측 인프라 (observe run + coverage 레버 1) 의 가치는 불변 — 다음 가설의 검정 재료가 그것에서 나온다.
