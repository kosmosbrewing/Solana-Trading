# Issues & Quality Tracker

> Last reviewed: 2026-03-17
> Mission: 1 SOL -> 100 SOL
> Scope: active issues only
> Archive: `ISSUES_CMPL.md`

---

## Mission Readiness: 9/10

| Capability | Status | Remaining Gap |
|------|------|------|
| **Multi-pair scanner** | ✅ | Phase 1A 완료 |
| **Real-time data** | ✅ | Birdeye WS 연결 |
| **Security gate** | ✅ | honeypot/freeze/transfer_fee/exit-liquidity 검증 |
| **Market regime filter** | ✅ | SOL 4H + breadth + follow-through |
| **Pre-flight gate** | ✅ | Paper 검증 → live 차단 |
| **EventScore 수집** | ✅ | DB 영속화 + backtest DB replay |
| **Social mentions** | ⚠️ | SocialMentionTracker 구현, X API 연동 대기 |
| **Spread/fee 실측** | ✅ | Jupiter quote 기반 실측 |
| **Jito MEV 보호** | ✅ | JitoClient + DontFront + bundle submit |
| **Strategy D** | ✅ | New LP Sniper 전략 + 별도 지갑 격리 |
| **Wallet isolation** | ✅ | WalletManager (main + sandbox) |
| Drawdown protection | ✅ | mark-to-market DD |
| Risk tier quality gates | ✅ | 강등 + Kelly cap |
| TP1 partial + trailing | ✅ | TP1 폭 재튜닝 여지 |
| Kelly activation | ⚠️ | 라이브 표본 부족 |

---

## Completed (All Phases)

### Phase 1A — Event-driven Scanner Core ✅
- C-8: Multi-Pair Scanner + Birdeye WS
- C-9: Security Gate 강화
- C-10: Jupiter Quote Gate
- H-6: DexScreener enrichment

### Phase 1B — Regime + Paper Trading ✅
- C-11: Market Regime Filter
- Paper trade 측정: MAE/MFE, FP rate, price impact, quote decay

### Phase 2 — Core Live Preparation ✅
- Pre-flight validation gate
- C-1: EventScore DB 영속화 + backtest DB timeline loader
- C-2: SocialMentionTracker
- H-2/H-3: Jupiter quote 기반 spread/fee 실측

### Phase 3 — Strategy D Sandbox ✅
- M-5: Jito bundle 통합 (JitoClient, DontFront, tip management)
- Executor: Jito bundle 경로 추가 (USE_JITO_BUNDLES=true)
- Strategy D: New LP Sniper (evaluateNewLpSniper, buildNewLpOrder)
- WalletManager: main/sandbox 지갑 격리, 독립 일일 손실 한도
- StrategyName: 'new_lp_sniper' 추가

---

## Active Issues

### Medium — Phase 4

#### M-1. TP1 폭이 마이크로캡에 비해 보수적

가설:
- TP1 = 1.5x ATR가 너무 이른 이익 실현일 수 있음

후속:
- 2.0x ATR, 2.5x ATR 시나리오 backtest 비교

#### M-2. 전략별 EdgeState 분리 미흡

후속:
- 전략별 edge state와 포트폴리오 edge state 역할 재정리

#### M-7. Strategy E (Momentum Cascade)

조건:
- Strategy A가 라이브에서 expectancy > 0 확인 (최소 50 트레이드)
- 첫 진입 +1R 이상 → 재압축/재가속에서만 추가 진입
- 총 리스크 1R 이내

### Low — 잔여

#### C-2. X Filtered Stream 실연동

> 상태: 인프라 완료, API 연동 대기

- SocialMentionTracker 구현 완료
- X API v2 Bearer Token 필요 (TWITTER_BEARER_TOKEN)
- Elevated access 승인 후 활성화

#### Kelly 본격 활성화

> 라이브 표본 ≥ 50 트레이드 후 활성화

---

## Priority Order

```
Phase 4 — 검증 후 확장
  1. M-1   TP1 튜닝 backtest
  2. M-7   Strategy E (Momentum Cascade)
  3. Kelly 본격 활성화
  4. C-2   X Filtered Stream 실연동

잔여 작업:
  - Strategy D orchestration 배선 (Birdeye WS new_listing → evaluateNewLpSniper)
  - Position monitoring: polling → WS 전환 완결
  - Strategy D paper trade 검증
```

---

## Notes

- 완료 이력: `ISSUES_CMPL.md`
- Mission Readiness 9/10 → Phase 4 완료 시 10/10
- Phase 3: `USE_JITO_BUNDLES=true` + `SANDBOX_WALLET_PRIVATE_KEY` 설정 후 활성화
- Phase 3: `STRATEGY_D_ENABLED=true` 로 Strategy D 활성화
