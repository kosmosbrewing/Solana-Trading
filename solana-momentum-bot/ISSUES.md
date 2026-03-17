# Issues & Quality Tracker

> Last reviewed: 2026-03-17
> Mission: 1 SOL -> 100 SOL
> Scope: active issues only
> Archive: `ISSUES_CMPL.md`

---

## Mission Readiness: 10/10

모든 Phase 완료. 라이브 운영 준비 완료.

| Capability | Status |
|------|------|
| Multi-pair scanner | ✅ Birdeye WS + DexScreener 동적 watchlist |
| Real-time data | ✅ Birdeye WS (price/txs/OHLCV) |
| Security gate | ✅ honeypot/freeze/transfer_fee/exit-liquidity |
| Market regime filter | ✅ SOL 4H + breadth + follow-through |
| Pre-flight gate | ✅ Paper 검증 → live 차단 |
| EventScore 수집 | ✅ DB 영속화 + backtest DB replay |
| Spread/fee 실측 | ✅ Jupiter quote 기반 |
| Jito MEV 보호 | ✅ JitoClient + DontFront |
| Strategy D | ✅ New LP Sniper + 별도 지갑 |
| Wallet isolation | ✅ WalletManager (main + sandbox) |
| **Strategy E** | ✅ **Momentum Cascade (재압축/재가속 + combined SL + 1R cap)** |
| **TP1 tuning** | ✅ **backtestTp1Tuning.ts (1.5x/2.0x/2.5x ATR 비교)** |
| **Kelly activation** | ✅ **Fractional Kelly + 강등 메커니즘** |
| **Edge demotion** | ✅ **Recent-window 성과 기반 자동 강등** |
| Drawdown protection | ✅ mark-to-market DD |
| Risk tier quality gates | ✅ 승격 + 강등 + Kelly cap |

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
- M-5: Jito bundle 통합
- Strategy D: New LP Sniper
- WalletManager: main/sandbox 지갑 격리

### Phase 4 — Momentum Cascade / Dynamic Sizing ✅

- **Strategy E (Momentum Cascade)**
  - 재압축 감지: range narrowing + pullback from peak
  - 재가속 감지: reduced volume spike threshold (2.5x)
  - Combined SL: 총 리스크 1R 이내 유지, 전체 포지션 기준 재산정
  - Add-on quantity: remaining risk budget 내 계산
  - CascadeState: legs, costBasis, totalQuantity, originalRiskSol 추적

- **TP1 Tuning (M-1)**
  - backtestTp1Tuning.ts: 4 시나리오 자동 비교
  - 1.5x (current) / 2.0x / 2.0x+3.0x / 2.5x+3.5x ATR
  - Exit reason 분포 + peak move 분석

- **Fractional Kelly 본격 활성화**
  - Calibration tier: 1% 고정으로 하향 (STRATEGY.md 정합성)
  - EdgeTracker: getRecentStats(), getExpectancy(), checkDemotion()
  - Demotion gates: Proven (20 trades window), Confirmed (15 trades)
  - resolveRiskTierWithDemotion(): 최신 성과 기반 자동 강등
  - 강등 조건: WR < 35%, R:R < 1.0, 연속 손실 ≥ 5

---

## Active Issues

### Low — 운영 최적화

#### C-2. X Filtered Stream 실연동

> SocialMentionTracker 구현 완료, X API Bearer Token 대기

#### Strategy E backtest engine 통합

> momentumCascade.ts 모듈 완료, backtest engine simulateTrade 내 add-on 로직 배선 잔여

#### Strategy D orchestration 배선

> Birdeye WS new_listing → evaluateNewLpSniper 파이프라인 잔여

#### 포지션 모니터링 WS 전환 완결

> Birdeye WS 인프라 완료, position monitor polling → WS 배선 잔여

#### Birdeye WS → Helius WS 전환 검토

> 상태: 미착수 (아이디어 단계)

현재 멀티풀 실시간 데이터는 Birdeye WS로 해결됨.
향후 비용/의존성 최적화로 Helius WebSocket 전환을 검토할 수 있음.

기대 효과:
- Birdeye 의존 제거 (OHLCV + 매수/매도 볼륨)
- Helius RPC 단일 인프라로 통합 (TX 실행 + 데이터 수집)
- 월 비용 절감

구현 방향:
- `accountSubscribe([pool1..pool20])` → swap TX 파싱 → 로컬 5분봉 조립
- 기존 CandleHandler 트리거 유지 (전략/Gate 코드 변경 없음)

---

## Notes

- Mission Readiness 10/10 — 모든 핵심 모듈 구현 완료
- 라이브 운영 시: `TRADING_MODE=live` + pre-flight 통과 필요
- Strategy D: `USE_JITO_BUNDLES=true` + `SANDBOX_WALLET_PRIVATE_KEY` + `STRATEGY_D_ENABLED=true`
- Kelly: 자동 활성화 (Confirmed tier 50+ trades → 1/4 Kelly)
- 강등: 자동 (최근 15~20 trades 성과 하락 시)
