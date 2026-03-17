# Issues & Quality Tracker

> Last reviewed: 2026-03-17
> Mission: 1 SOL -> 100 SOL
> Scope: active issues only
> Archive: `ISSUES_CMPL.md`

---

## Mission Readiness: 7/10

| Capability | Status | Remaining Gap |
|------|------|------|
| **Multi-pair scanner** | ✅ | Phase 1A 완료 — Birdeye WS + DexScreener 동적 watchlist |
| **Real-time data** | ✅ | Birdeye WS 연결, price/txs/OHLCV 실시간 수신 |
| **Security gate** | ✅ | honeypot/freeze/transfer_fee/exit-liquidity 검증 완료 |
| **Market regime filter** | ✅ | SOL 4H EMA + breadth + follow-through 3-factor 분류 |
| **Paper metrics** | ✅ | MAE/MFE/FP rate/price impact/quote decay 추적 |
| **Pre-flight gate** | ✅ | Paper 검증 미통과 시 live 모드 자동 차단 |
| **EventScore 수집** | ✅ | DB 영속화 + 30일 보관 + backtest replay 지원 |
| **Social mentions** | ⚠️ | SocialMentionTracker 구현, X API 연동 대기 |
| **Spread/fee 실측** | ✅ | Jupiter quote 기반 실측 (H-2/H-3 해결) |
| Drawdown protection | ✅ | mark-to-market DD 반영 완료 |
| Risk tier quality gates | ✅ | 강등 메커니즘, Kelly cap 재조정 잔여 |
| TP1 partial + trailing | ✅ | TP1 폭 재튜닝 여지 |
| Slippage-aware RR gate | ✅ | Jupiter quote 기반 실측 완료 |
| Kelly activation | ⚠️ | 라이브 표본 부족, 최근 성과 기반 강등 필요 |
| MEV protection (Jito) | ❌ | Strategy D 전제조건 |

---

## Completed (Phase 1A/1B/2)

### Phase 1A — Event-driven Scanner Core ✅

- C-8: Multi-Pair Scanner + Birdeye WS 전환
- C-9: Security Gate 강화 (exit-liquidity + token_security)
- C-10: Jupiter Quote Gate (실행 가능성 실측)
- H-6: DexScreener enrichment (WatchlistScore 보강)

### Phase 1B — Regime + Paper Trading ✅

- C-11: Market Regime Filter (3-factor: SOL 4H + breadth + follow-through)
- Paper trade 측정: MAE/MFE, false positive, price impact, quote decay
- Regime → 사이징 배선 (risk_off: 진입 차단, neutral: 0.7x)

### Phase 2 — Core Live Preparation ✅

- Pre-flight validation gate (50 trades, 40% WR, 2.0 R:R → live 허용)
- C-1: EventScore DB 영속화 + backtest replay pipeline
- C-2: SocialMentionTracker (X social_mention_count 피처)
- H-2/H-3: Jupiter quote 기반 spread/fee 실측

---

## Active Issues

### High — Remaining Phase 2

#### C-2. X Filtered Stream 실연동

> 상태: 인프라 완료, API 연동 대기

- SocialMentionTracker 구현 완료 (recordMention → calcSocialScore)
- X API v2 Bearer Token 필요 (TWITTER_BEARER_TOKEN env)
- Elevated access (Filtered Stream) 요구 — 승인 후 연동

#### C-1. Historical EventScore replay 고도화

> 상태: 부분 해결 → DB 영속화 완료

완료:
- EventScoreStore: DB 테이블 + insert/query/export/prune
- EventMonitor: poll 시 자동 영속화
- backtest timeline export 지원

남은 작업:
- backtest engine에서 DB 기반 timeline 자동 로드 (현재 JSON 파일만 지원)
- pair-level EventScore correlation 분석 도구

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
- Birdeye WS price 스트림으로 전환 시 해결 (WS 인프라 완료, 배선 잔여)

#### M-7. Strategy E (Momentum Cascade) — Phase 4

조건:
- Strategy A가 라이브에서 expectancy > 0 확인 (최소 50 트레이드)
- 첫 진입 +1R 이상 → 재압축/재가속에서만 추가 진입
- 총 리스크 1R 이내

---

## Priority Order (현재 기준)

```
Phase 2 — 마무리 (잔여)
  1. C-2   X Filtered Stream 실연동 (Bearer Token 필요)
  2. C-1   backtest engine DB timeline 로드

Phase 3 — Strategy D Sandbox
  3. M-5   Jito 통합
  4. Strategy D: New LP Sniper (별도 지갑, 옵션성 베팅)

Phase 4 — 검증 후 확장
  5. M-1   TP1 튜닝 backtest
  6. M-7   Strategy E (Momentum Cascade)
  7. Kelly 본격 활성화
```

---

## Notes

- 완료 이력, 해결된 항목 상세, 과거 결정 로그는 `ISSUES_CMPL.md`로 이동
- 현재 `ISSUES.md`는 "지금 남은 것"만 관리한다
- Mission Readiness 7/10 → Phase 3 완료 시 9/10, Phase 4 완료 시 10/10 예상
- Phase 2 Pre-flight gate: `PREFLIGHT_ENFORCE_GATE=true` (default) — paper 미검증 시 live 차단
