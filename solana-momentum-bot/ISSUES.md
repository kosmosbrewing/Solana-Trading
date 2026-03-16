# Issues & Quality Tracker

> Last reviewed: 2026-03-16
> Mission: 1 SOL -> 100 SOL
> Scope: active issues only
> Archive: `ISSUES_CMPL.md`

---

## Mission Readiness: 4/10

| Capability | Status | Remaining Gap |
|------|------|------|
| **Multi-pair scanner** | ❌ | 단일 TARGET_PAIR_ADDRESS만 감시 — 기회 탐지 불가 |
| **Real-time data** | ❌ | Birdeye WS 미연결, 5초 polling + 30분 trending 폴링 |
| **Security gate** | ⚠️ | honeypot/freeze/transfer_fee/exit-liquidity 미검증 |
| Market regime filter | ❌ | 없음 — risk-off 구간에서 손실 가속 가능 |
| Drawdown protection | ✅ | mark-to-market DD 반영 완료 |
| Risk tier quality gates | ✅ | 강등 메커니즘, Kelly cap 재조정 잔여 |
| TP1 partial + trailing | ✅ | TP1 폭 재튜닝 여지 |
| Event/attention gating | ⚠️ | Birdeye trending 단일 소스, 가격 파생 지표 |
| Slippage-aware RR gate | ✅ | Jupiter quote 기반 probe로 전환 필요 |
| Kelly activation | ⚠️ | 라이브 표본 부족, 최근 성과 기반 강등 필요 |
| Backtest parity | ⚠️ | historical EventScore dataset 미완료 |
| Pair-level controls | ✅ | decay window 기반 재활성화 구현 |
| Social event detection | ❌ | Phase 2 미착수 |
| MEV protection (Jito) | ❌ | Strategy D 전제조건 |

---

## Active Issues

### Critical — Phase 1A (지금 시작)

#### C-8. Multi-Pair Scanner + Birdeye WS 전환

> 상태: 미착수 — **최우선**

현재:
- `TARGET_PAIR_ADDRESS` 하나만 감시
- 5초 polling + 30분 trending 폴링
- 기회 탐지 자체가 불가능

구현:
- Birdeye WS: price, txs, OHLCV, new_listing, new_pair 구독
- Dual-Lane Scanner: Lane A (Mature, age > 60m) / Lane B (Fresh, Phase 3)
- 동적 watchlist 관리 (maxWatchlistSize 기반)
- 5초 polling → WS price 스트림으로 포지션 모니터링 전환

#### C-9. Security Gate 강화 (exit-liquidity + token_security)

> 상태: 미착수

현재:
- Pool TVL, token age, holder concentration만 검사
- honeypot, freezable, mintable, transfer fee 미검증
- exit-liquidity (실제로 팔 수 있는지) 미확인

구현:
- Birdeye `/defi/token_security` 연동
  - is_honeypot, is_freezable, is_mintable → reject
  - has_transfer_fee (Token-2022) → reject
  - freeze_authority_present → reject
- Exit-liquidity 프록시: 24h sell volume / buy volume ratio, sell-side depth
- Gate 파이프라인에서 **Gate 0 (Security)** 으로 최우선 배치

#### C-10. Jupiter Quote Gate (실행 가능성 실측)

> 상태: 미착수

현재:
- execution viability가 수식 기반 추정치
- 실제 Jupiter route/price impact 미확인

구현:
- 진입 전 Jupiter Swap API quote 호출
- priceImpact ≤ maxPoolImpact 검증
- route 존재 여부 확인
- stale quote 거부

### Critical — Phase 1B

#### C-11. Market Regime Filter

> 상태: 미착수

브레이크아웃 전략은 시장 상태에 따라 follow-through가 완전히 다르다.

구현:
- SOL 4H trend (EMA20 vs EMA50)
- Watchlist breadth (후보군 중 돌파 후 연장 성공 비율)
- Recent follow-through (최근 1~2일 breakout → TP1 도달률)
- Regime → 사이징/진입 제어 (risk-on: 1.0x / neutral: 0.7x / risk-off: 0x)

#### C-1. Historical EventScore replay 미완료

> 상태: 부분 해결

- shared gate, static EventScore, time-series EventScore file replay는 구현됨
- 실제 과거 시점별 dataset 수집/적재가 없어 live와 완전 동일한 backtest는 아님

남은 작업:
- pair/time 기준 historical EventScore dataset 수집
- backtest input pipeline에 운영 데이터셋 연결

### High

#### H-6. DexScreener Enrichment (WatchlistScore 보강)

> 상태: 미착수

DexScreener 공식 API에서 boost/ad/order 데이터를 WatchlistScore 피처로 사용.

구현:
- `GET /token-boosts/latest` — 최근 부스트 토큰
- `GET /token-boosts/top` — 상위 부스트 토큰
- `GET /orders/v1/solana/:token` — 유료 주문/광고 존재
- **매수 트리거가 아닌 랭킹 보조 피처로만 사용**

#### C-2. 외생 이벤트 소스 부재

> 상태: 역할 재정의

현재 EventScore는 Birdeye Trending 단일 소스 + 30분 폴링.

**변경:** X/Telegram은 매수 트리거가 아닌 WatchlistScore 피처로 역할 한정.
- X Filtered Stream: P99 ≈ 6~7초 지연 → 트리거로는 늦음 → social_mention_count 피처
- Telegram: 알림/모니터링 채널 유지
- 우선순위: Phase 2 (DexScreener enrichment 이후)

#### H-2. Spread proxy 정확도 한계

> 상태: 부분 해결

완료:
- UniverseEngine에서 1분봉 high/low 기반 spread proxy 계산

남은 작업:
- Jupiter quote 기반 실측으로 교체 (C-10과 연계)

#### H-3. Pool fee 실측값 반영 미완료

> 상태: 부분 해결

완료:
- execution viability 비용 설정 가능화
- 기본값 보수적 상향

남은 작업:
- pool별 `ammFeePct`를 안정적으로 실측/주입

### Medium

#### M-1. TP1 폭이 마이크로캡에 비해 보수적

가설:
- TP1 = 1.5x ATR가 너무 이른 이익 실현일 수 있음

후속:
- 2.0x ATR, 2.5x ATR 시나리오 backtest 비교
- Phase 4에서 검증

#### M-2. 전략별 EdgeState 분리 미흡

후속:
- 전략별 edge state와 포트폴리오 edge state 역할 재정리

#### M-5. MEV 보호 없음 (Jito)

> Strategy D 전제조건 — Phase 3에서 도입

구현:
- Jito bundle: fast landing, MEV protection, revert protection
- Strategy A/C 소형 거래: 상위권이지만 1순위 아님
- Strategy D New LP Sniper: **사실상 전제조건**

#### M-6. 포지션 모니터링 5초 polling

후속:
- C-8 Birdeye WS 전환 시 함께 해결

#### M-7. Strategy E (Momentum Cascade) — Phase 4

조건:
- Strategy A가 라이브에서 expectancy > 0 확인 (최소 50 트레이드)
- 첫 진입 +1R 이상 → 재압축/재가속에서만 추가 진입
- 총 리스크 1R 이내
- 추가 진입 후 stop 전체 포지션 기준 재산정

---

## Priority Order (피드백 반영 최종)

```
Phase 1A — 지금 시작
  1. C-8   Multi-Pair Scanner + Birdeye WS
  2. C-9   Security Gate 강화 (exit-liquidity + token_security)
  3. C-10  Jupiter Quote Gate

Phase 1B — Scanner 완성 후
  4. C-11  Market Regime Filter
  5. C-1   Historical EventScore dataset

Phase 2 — Paper → Core Live
  6. H-6   DexScreener enrichment (WatchlistScore)
  7. C-2   X social_mention_count 피처
  8. H-2/H-3 market microstructure 정밀화

Phase 3 — Strategy D Sandbox
  9. M-5   Jito 통합
  10. Strategy D: New LP Sniper (별도 지갑, 옵션성 베팅)

Phase 4 — 검증 후 확장
  11. M-1   TP1 튜닝 backtest
  12. M-7   Strategy E (Momentum Cascade)
  13. Kelly 본격 활성화
```

---

## Notes

- 완료 이력, 해결된 항목 상세, 과거 결정 로그는 `ISSUES_CMPL.md`로 이동
- 현재 `ISSUES.md`는 "지금 남은 것"만 관리한다
- Mission Readiness 4/10 → Phase 1A 완료 시 6/10, Phase 2 완료 시 8/10 예상
