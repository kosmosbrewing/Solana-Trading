# Observe Run 결과 분석 — Helius 소진 시점 (2026-06-13)

> Run: 2026-06-10 ~ 06-13 (실 수집 ~2.5일, 6/12 22:07 UTC candle 수집 정지 = API 소진).
> Helius 1M 월 quota 소진 → 봇 정지 (paper, 자본 위험 0). 전 측정 로컬 데이터 / API 0.
> 측정 대상: 레버 1 효과 / 레버 2 결정 / full coverage / H-007 데이터 충족 / Helius 회계.

## 1. 레버 1 — 기술적으로 성공 (검증 완료)

| 지표 | 감사 baseline (05-02..22) | 이번 run (06-11..13) | 변화 |
|---|---|---|---|
| 신규 구독 중 `kol_tx_pool` 비중 | 0% (경로 dead) | **94.8%** (888/937) | 경로 부활 |
| KolTx pool 추출률 | 0% (`requestPool=missing` 100%) | **71.1%** (7,561/10,635) | — |
| `no_pairs` resolveMiss 비중 | 73.4% | **18.7-21.7%** | −70% |
| 구독 성공률 (sub+refresh)/req | 9.2% | **21-26%** | 2.3-2.8x |
| **full candle coverage (pre60+T+300)** | **1.81%** | **10.7%** (n=765) | **5.9x** |

레버 1 은 의도대로 작동했다: DexScreener 색인 대기 없이 KOL swap tx 에서 직접 pool 을 추출해 직행 구독. `no_pairs` 병목을 70% 줄였고, DexScreener resolver 경로는 사실상 죽었다 (구독 4건).

## 2. 그러나 coverage 는 여전히 promotion-grade 가 아니다 — 남은 벽 2개

full coverage 10.7% 는 "측정 불가(1.81%)"에서 "diagnostic-grade"로 올랐을 뿐, 승격 기준(95%)과는 멀다. 남은 격차는 **튜닝이 아니라 구조**다:

### 벽 A — Bonding curve (66%)
- KolTx 추출 pool 의 dexId: **pumpfun 65.8%** / pumpswap 32% / 나머지 2%.
- 신선 buy anchor 의 57% 가 pump.fun bonding curve 토큰.
- 레버 1 은 bonding pool 을 추출은 하되 **구독을 gate** (WS 파서 미지원 → zero-candle 방지). 즉 KOL 매수의 2/3 는 진입 시점에 bonding curve 위에 있어 **원천적으로 candle 관측 불가**.
- → **레버 2 trigger (pumpfun ≥30%) 결정적으로 충족.** bonding curve WS parser 없이는 coverage 상한이 ~34% (non-bonding 비중).

### 벽 B — 구독 지연 (pre-entry window 손실)
- direct-covered anchor 의 **33% 가 첫 candle 이 anchor 이후 시작** (구독이 KOL 매수 감지 시점 = anchor 이후에 성사).
- pre60 coverage 가 12.2% 로 post300 (13.9%) 보다 낮은 이유 — 진입 직전 구간(가장 예측력 높은 창)이 비어 있다.
- KOL-follow 의 구조적 후행성(감사 §A, 신호 수명 60s)이 측정 계층에도 재현됨.

## 3. 전략적 핵심 발견 — coverage 와 H-007 의 불일치 (가장 중요)

이 run 의 명시 목적은 "coverage 수리 → H-007 (holder/dev 행동, PRIMARY 가설) 검정 데이터 확보"였다. **그런데 candle coverage 와 H-007 이 필요로 하는 데이터가 다르다:**

- candle coverage = **가격 경로(price-path)** 완전성. 그런데 가격/거래량 모멘텀은 H-004/5/6 에서 이미 기각됨.
- H-007 이 필요로 하는 것 = **holder 유입 시계열 + dev wallet 행동 시계열**. 이 run 이 실제로 수집한 것:
  - `token-quality-observations`: 신선 +776 rows. 단 schema 는 `operatorDevStatus` / `riskFlags` (point-in-time 거친 분류) — **holder 유입 시계열 아님**.
  - holder snapshot stream: **없음** (파일 미존재).
  - dev wallet 행동 stream: 정적 registry 뿐, 시계열 없음.

→ **현 구성의 observe run 은 충분히 펀딩돼도 H-007 의 신호 데이터를 생산하지 못한다.** 그리고 holder snapshot 수집 (getTokenLargestAccounts / getProgramAccounts) 은 Helius 비용을 *늘린다* — 예산 문제를 악화시킨다.

## 4. Helius 회계 — free tier 는 구조적으로 부족

- 귀속 ledger (6/10-13): 총 210,743 credits, **~100k/day** pace. 최대 항목 = `helius_ws_fallback_single` 157,809 (구독 pool swap 파서, 1/s 캡).
- 월 1M quota / ~100k day = **이 구성의 observe run 은 fresh quota 로도 ~10일 지속이 한계.**
- 대시보드 1M 소진 vs 귀속 210k: 나머지는 직전 cycle (5/24 reset~6/10) baseline. per-day 기준 대시보드 ≈ ledger (6/11: 82k vs 100k) 로 attribution 은 검증됨.
- holder 수집 추가 시 비용 증가 → 무료로는 H-007 수집 불가, Developer($49) 로도 여유 빠듯.

## 5. 종합 판정

레버 1 은 **기술 성공이되 전략적으로는 막다른 길의 지도를 그렸다.** 세 벽이 동시에 확인됐다:

1. **bonding curve 벽**: KOL 매수의 66% 가 우리가 못 읽는 pre-migration 단계.
2. **구독 지연 벽**: 읽는 34% 조차 pre-entry 창을 33% 놓침.
3. **신호 불일치 벽**: 싸게 관측 가능한 것(price path)은 기각됨, edge 가능성 있는 것(holder/dev micro)은 비싼 수집 필요 + 미구축 인프라.

이것은 edge audit 의 `RETIRE_CURRENT_LIVE` 를 데이터 수집 계층에서 재확인한다 — KOL-discovery paradigm 은 $50/월 예산에서 관측 가능한 edge 표면이 거의 없다.

## 6. 다음 결정 (운영자) — 돈 쓰기 전에 $0 검정부터

성급한 결론(Developer 결제 / 레버 2 구축) 전에, **이미 가진 데이터로 답할 수 있는 질문을 먼저 푼다:**

- **Option B (권고, $0, 지금 가능)**: `token-quality-observations` 의 `operatorDevStatus`/`riskFlags` 를 markout forward outcome 에 join → "dev/quality 차원에 ex-ante 예측력이 있는가?" H-007 의 저비용 proxy. 신호가 있으면 그때 holder 수집 투자 정당화. 없으면 H-007 도 기각 → KOL-discovery 관측 종료.
- Option A (레버 2 구축): bonding curve WS parser. 단 pre-migration 은 가장 rug-prone 단계 — Option B 가 dev/quality 신호를 보여줄 때만 정당.
- Option C (관측 종료): 봇의 가치를 "discovery"가 아니라 "손실 통제 universe 정의 + guard rail"로 한정하고 관측 지출 중단.

**공통**: free tier 1M 은 6/24경 reset. 그때까지 봇 정지 유지. Option B 는 reset 과 무관하게 지금 실행 가능.
