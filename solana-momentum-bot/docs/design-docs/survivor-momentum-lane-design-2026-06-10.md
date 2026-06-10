# Survivor Momentum Lane — 설계 초안 (2026-06-10)

> Status: **PHASE 0 REJECTED (2026-06-10, 같은 날)** — §7 kill criteria 발동. 코드 미구현, 매몰 0.
> 판정: 3 trigger 모두 T+30m gross median ≤ 0 (t1 −2.1% CI[−4.7,−0.6] / t2 −0.2% / t3 −0.3%),
> post-cost 두 ticket 시나리오 전부 음수. **단 universe 필터 자체는 유효** (KOL universe 의
> T+30m −48% bleed → −0.2~−2% 로 제거. 진입 edge 가 없을 뿐).
> 상세: `analysis/survivor-momentum-phase0-2026-06-10/FINDINGS.md`
> 재검정 조건: coverage 레버 1 가동 후 신선 데이터 (universe 확장) 또는 10s bar 바깥 정보
> (holder/dev 행동) 를 쓰는 새 trigger 의 사전 등록.
> Parent: `mission-refinement-v2-2026-06-10.md`
> Evidence constraints: edge audit §8 errata (KOL universe 측정 한계) + 함정 3개 (v2 ADR §5)

## 1. 가설 (한 문장)

초기 1-5분 스나이핑 구간을 **버리고**, 러그 다발 구간을 생존한 + 품질 필터를 ex-ante 통과한 토큰이
**모멘텀을 재점화하는 구간만** 저빈도로 진입하면, ticket 0.05-0.1 SOL 의 비용 구조에서
post-cost 양수 기대값 cohort 가 존재한다.

핵심 차별점 (vs 폐기된 KOL-follow): 신호원이 "남의 매수" (후행, 수명 60s) 가 아니라
"토큰 자체의 상태" (생존 + 품질 + 재점화) — 시간 압박이 구조적으로 약해 latency 군비경쟁에서 빠진다.

## 2. Universe 정의 (전부 ex-ante 관측 가능해야 함)

| 축 | 조건 후보 (offline 에서 캘리브레이션) | 기존 구현 자산 |
|---|---|---|
| 생존 | token age ≥ 30min + 최초 N분 내 미사망 (rug/LP drain 없음) | sessions candle + migrationEventDetector |
| 유동성 | pool 유동성 ≥ X (ticket 0.1 의 slippage 상한 역산) | DexScreener + sellQuoteProbe |
| 컨트랙트 위험 | security gate 전체 통과 (mint/freeze/Token-2022 ext/NO_SECURITY_DATA reject) | `onchainSecurity` (기존, 변경 없음) |
| 출구 가능성 | sell quote probe 왕복 통과 (honeypot-by-liquidity 차단) | `sellQuoteProbe` (기존) |
| 홀더 분포 | top10 비중 ≤ Y + dev wallet negative check | `holderDistribution`, `devWalletRegistry` |
| 측정 가능성 | **WS candle 구독 성립된 pool 만** (coverage 없는 토큰은 universe 제외 — MEASUREMENT_INVALID 재발 방지) | coverage repair lever 1 |
| 소셜 반응 | **v1 범위 제외** (수집 능력 없음 — 신규 수집기는 예산/복잡도상 보류) | — |

## 3. Entry trigger 후보 (offline 에서 경쟁시킬 가설들)

1. **burst 재점화**: pure_ws v2 burst detector (구현 완료, `PUREWS_V2_ENABLED`) 를 survivor universe 에 적용
2. **buy/sell ratio + volume accel 지속성**: cupsey gate 유산 (vol_accel ≥1.2 / buy_ratio ≥0.5 multi-bar)
3. **post-consolidation breakout**: 생존 후 변동성 수축 → 거래량 동반 상방 이탈

각 trigger 는 동일 universe / 동일 비용 가정 / 동일 horizon 으로 비교. 사후 선택은 `hypothesis_only` 라벨.

## 4. 비용 bar (승부 조건)

| ticket | 고정비 (0.0027 SOL) | price-level (~1.5%) | **post-cost bar** |
|---|---|---|---|
| 0.02 SOL | 13.5% | 1.5% | ~15% (실패 입증된 구간) |
| 0.05 SOL | 5.4% | 1.5% | ~7% |
| 0.1 SOL | 2.7% | 1.5% | **~4.2%** |

- offline/paper 평가는 ticket 0.05 와 0.1 두 시나리오로 병행 계산한다.
- ticket > 0.01/0.02 실거래는 **gate 통과 + 별도 ADR + ticket hard-lock 해제 절차** 전 금지 (현행 lock 유지).
- 유동성 필터 X 는 ticket 0.1 의 price impact ≤ 1% 를 만족하도록 역산.

## 5. Exit 골격 (초안)

- 기존 tiered runner 골격 재사용하되, KOL-follow 의 초단기 hardcut (16s median hold) 전제를 제거
- hold horizon 은 trigger 별 offline forward curve 에서 도출 (15min-2h 대역 예상)
- hard cut: 진입가 −8~−12% (offline 캘리브레이션) + 구조적 kill (sell route 소멸) 은 기존 로직 유지
- 5x tail 보존이 목적이 아니라 **median win 이 bar 를 넘는 것**이 1차 목적 (v2 ADR §3 — 복권 아님)

## 6. 검증 사다리 (promotion gate 재사용, 완화 없음)

```
Phase 0 — offline (지금 가능, 비용 0):
  data: sessions 18GB candles + token-quality-observations (4,944) +
        missed-alpha (88k) + pure_ws botflow ledger + admission-skips
  한계 명시: 기존 데이터는 KOL/scanner universe 중심 — survivor universe 의
        완전한 대표성 없음. Phase 0 은 "기각 필터" 로만 사용 (통과 ≠ 증명).
  산출: trigger 별 N / forward curve / post-cost 기대값 / chrono half 안정성
  기각 조건: 전 trigger 의 post-cost median 이 두 ticket 시나리오 모두 음수

Phase 1 — paper lane (observe run 위에서):
  pureWsBotflow* 인프라 재사용 (12 modules, candle coverage 79.75% 의 유일한 정상 lane)
  N ≥ 100, active days ≥ 5, chrono OOS, top5 share ≤ 35%, max loss streak ≤ 10

Phase 2 — mirror + micro-canary:
  기존 gate 그대로 (paired ≥ 30 / sign agreement ≥ 85% / 수동 review)
  이 시점에만 $1,000 투입 + ticket 상향 ADR 논의 자격
```

## 7. Kill criteria (lane 자체의)

- Phase 0 에서 전 trigger 기각 → lane 폐기, 가설 재수립 (구현 비용 0 이므로 매몰 없음)
- Phase 1 에서 paper N 100 도달 전 max loss streak > 10 또는 일관된 음수 → 중단
- 어떤 Phase 에서도 "조금만 완화하면 통과" 류의 gate 완화 금지 (v2 ADR §6)

## 8. Open questions (운영자 결정 필요)

1. ticket 시나리오 우선순위: 0.05 vs 0.1 어느 쪽을 1차 평가 기준으로?
2. Phase 0 기각 시 차순위 가설 후보를 미리 정할 것인가 (예: 시간대/요일 regime 필터)?
3. observe run 연장 여부 — Phase 1 은 신선한 survivor 데이터가 필요하므로 D+7 측정 후 run 지속이 전제됨.
