# Completed Issues Archive

> Last updated: 2026-03-18
> Purpose: solved items, audit history, migrated completion logs, and historical decisions

---

## 2026-03-17 Completion Snapshot

### Mission Viability

판정: `라이브 준비 완료 (외부 연동 제외)`

| Area | Status |
|------|--------|
| Multi-strategy runtime | ✅ A/C/D/E 전략 배선 완료 |
| Risk tier / Kelly / demotion | ✅ Bootstrap -> Proven + 자동 강등 |
| Security / execution viability | ✅ security gate + Jupiter quote 기반 검증 |
| Drawdown / daily loss / wallet isolation | ✅ 운영 가드레일 완료 |
| Backtest / statistics / reporting | ✅ bootstrap CI + permutation test + 공용 risk metrics |
| Social stream live connection | ⏳ 외부 Bearer Token 및 X rule 검증 대기 |

### Severity Summary

| Severity | Total | Fixed | Remaining |
|----------|-------|-------|-----------|
| CRITICAL | 24 | 24 | 0 |
| HIGH | 33 | 33 | 0 |
| MEDIUM | 20+ | 20+ | 0 |

---

## Migrated From ISSUES.md

### Phase 1A — Event-driven Scanner Core

- C-8: Multi-Pair Scanner + Birdeye WS
- C-9: Security Gate 강화
- C-10: Jupiter Quote Gate
- H-6: DexScreener enrichment

### Phase 1B — Regime + Paper Trading

- C-11: Market Regime Filter
- Paper trade 측정: MAE/MFE, false positive rate, price impact, quote decay

### Phase 2 — Core Live Preparation

- Pre-flight validation gate
- C-1: EventScore DB 영속화 + backtest DB timeline loader
- H-2/H-3: Jupiter quote 기반 spread/fee 실측

### Phase 3 — Strategy D Sandbox

- M-5: Jito bundle 통합
- Strategy D: New LP Sniper
- WalletManager: main/sandbox 지갑 격리

### Phase 4 — Momentum Cascade / Dynamic Sizing

- Strategy E: Momentum Cascade add-on / combined SL / 1R cap
- M-1: TP1 튜닝 자동 비교 스크립트
- Fractional Kelly 활성화
- Recent-window 성과 기반 demotion

---

## Migrated From ISSUES2.md

### Integration Gaps — 배선 완결

| ID | Module | Status |
|----|--------|--------|
| H-01 | WalletManager | ✅ signalProcessor pre-trade 체크 배선 |
| H-02 | SocialMentionTracker | ✅ WatchlistScore.socialScore 연동 |
| H-03 | SpreadMeasurer | ✅ signal.spreadPct -> executionViability 반영 |
| H-04 | resolveRiskTierWithDemotion | ✅ riskManager.checkOrder()에서 호출 |
| H-05 | Strategy D (newLpSniper) | ✅ BirdeyeWS newListing 이벤트 배선 |
| H-06 | Strategy E (momentumCascade) | ✅ |

### CRITICAL Issues

| ID | File | Resolution |
|----|------|------------|
| C-01 | jitoClient.ts | DontFront Memo instruction 전환 |
| C-02 | preflightCheck.ts | `signal_audit` -> `signal_audit_log` |
| C-03 | eventScoreStore.ts | `ON CONFLICT (token_mint, detected_at)` 적용 |
| C-04 | spreadMeasurer.ts | Sell quote 페어 정상화 |
| C-05 | socialMentionTracker.ts | Window reset 순서 수정 |
| C-06 | momentumCascade.ts | Combined SL <= costBasis x 0.99 |
| C-07 | momentumCascade.ts | `updateCascadeState()`로 `tp1Hit` 갱신 |
| C-08 | newLpSniper.ts | stopLoss = price x 0.05 위험값 수정 |
| C-09 | index.ts | `ctx.tradingMode = effectiveMode` |
| C-10 | walletManager.ts | try/catch + 명확한 에러 메시지 |
| C-11 | jitoClient.ts | `Math.floor()` 추가 |
| C-12 | backtestTp1Tuning.ts | try/finally + `pool.end()` |
| C-13 | executor.ts | `waitForConfirmation()` 호출 |
| C-14 | riskTier.ts | ineligible 시 `kellyFraction = 0` |
| C-15 | eventScoreStore.ts | 빈 배열 early return |
| C-16 | jitoClient.ts | `maxWaitMs` 타임아웃 |
| C-17 | preflightCheck.ts | division by zero 방어 확인 |
| C-18 | newLpSniper.ts | `slippageBps=500` 설정 |
| C-19 | momentumCascade.ts | balance NaN 방어 |
| C-20 | spreadMeasurer.ts | stale cache warning + fallback |
| C-21 | executor.ts | Jito -> standard RPC fallback |
| C-22 | walletManager.ts | UTC ISO string 비교 확인 |
| C-23 | candleHandler.ts | `?? poolInfo.spreadPct` fallback |
| C-24 | index.ts | `clearInterval(pruneInterval)` |

### HIGH Issues

| ID | Category | Resolution |
|----|----------|------------|
| H-07 | Logic | DEMOTION_GATES naming -> `minWinRate` |
| H-08 | Logic | `checkDemotion` strategy mode 정리 |
| H-09 | Logic | `detectRecompression` n<5 guard |
| H-10 | Logic | `detectReacceleration` price confirmation |
| H-11 | Logic | Strategy D security/quote 비동기 전환 |
| H-12 | Logic | Sharpe `sqrt(365)` 보정 |
| H-13 | Logic | preflight risk-adjusted R:R |
| H-14 | Logic | Jito 동적 tip 조정 |
| H-15 | Logic | TP1 tuning 통계적 유의성 검정 |
| H-16 | Logic | EventScore batch delete `LIMIT` |
| H-17 | Logic | 중복 spread 제거 |
| H-18 | Logic | Wallet daily loss DB 영속화 |
| H-19 | Logic | EventScore store initialize retry |
| H-20 | Logic | default spread 경고 보강 |
| H-21 | Performance | EdgeTracker pre-group 최적화 |
| H-22 | Performance | EventScore store `LIMIT` 파라미터 |
| H-23 | Performance | replayTieredDrawdownGuard 성능 개선 |
| H-24 | Error Handling | Jito 429 retry/backoff |
| H-25 | Error Handling | SpreadMeasurer timeout 설정 |
| H-26 | Error Handling | DB retry |
| H-27 | Error Handling | DB failure -> paper mode fallback |
| H-28 | Type Safety | `momentum_cascade` 타입 추가 |
| H-29 | Type Safety | Wallet keypair non-nullable |
| H-30 | Type Safety | newLpSniper optional 필드 정리 |
| H-31 | Type Safety | addOnPrice=0 guard |
| H-32 | Type Safety | empty array -> 0 반환 |
| H-33 | Type Safety | null coalescence 정리 |

### MEDIUM Issues

| ID | Category | Resolution |
|----|----------|------------|
| M-01 | Naming | `minWinRate` 변경 |
| M-02 | Naming | `minRewardRisk` 변경 |
| M-03 | Config | Jito tip accounts config 이동 |
| M-04 | Config | Spread cache TTL config 이동 |
| M-05 | Config | SocialMentionTracker window size config |
| M-06 | Testing | Phase 2/3/4 테스트 보강으로 대체 |
| M-07 | Testing | momentumCascade edge case 테스트 |
| M-08 | Testing | edgeTracker demotion 테스트 |
| M-09 | Logging | jitoClient structured logging |
| M-10 | Logging | walletManager PnL 로그 정리 |
| M-11 | Docs | Strategy E 플로우 문서화 |
| M-12 | Docs | Demotion 운영 가이드 |
| M-13 | Code | walletManager/riskManager 책임 정리 |
| M-14 | Code | EdgeTracker 통계 계산 모듈 분리 |
| M-15 | Code | preflightCheck threshold config 확인 |
| M-16 | Code | backtestTp1Tuning CLI scenario 정리 |
| M-17 | Security | sandbox wallet env 기반 유지 |
| M-18 | Resilience | Birdeye WS fallback |
| M-19 | Resilience | DexScreener 429 retry |
| M-20 | Resilience | PG pool exhaustion 방어 |

---

## 2026-03-18 Quality Improvements (HB16+)

### Harness Refactoring Gap Analysis → 코드 반영

| ID | 항목 | 파일 | 내용 |
|----|------|------|------|
| HB-1 | RegimeFilter 데이터소스 버그 | `birdeyeClient.ts`, `index.ts` | SOL_USDC_PAIR(mint주소)를 pair endpoint에 사용 → getTokenOHLCV(mint endpoint) 수정 |
| HB-2 | Exit Gate (Sell-side Impact) 구현 | `gate/index.ts`, `spreadMeasurer.ts`, `candleHandler.ts` | position-sized sell impact 측정 + 3%/1.5% 임계치 gate |
| HB-3 | Jupiter Ultra ADR 확정 | `docs/decisions/005-jupiter-ultra-positioning.md` | Jito 보완재 포지셔닝, config 토글 추가 |
| HB-4 | SOL_MINT 상수 중앙화 | `utils/constants.ts` 생성 | 4파일 중복 제거 (executor, quoteGate, spreadMeasurer, index) |
| HB-5 | gate/index.ts import 순서 수정 | `gate/index.ts` | const log가 import 블록 사이에 위치 → import 후로 이동 |
| HB-6 | getTokenOHLCV 에러 핸들링 일관화 | `birdeyeClient.ts` | return [] → throw error (getOHLCV와 일관) |
| HB-7 | Probe size 스케일링 | `spreadMeasurer.ts`, `candleHandler.ts` | 0.1 SOL probe → position-sized measureSellImpact() |
| HB-8 | Sync path JSDoc 문서화 | `gate/index.ts` | evaluateGates()가 sellImpactPct, security, quote를 무시함을 명시 |
| HB-9 | ADR-005 URL 검증 | `docs/decisions/005-jupiter-ultra-positioning.md` | station.jup.ag → dev.jup.ag 수정 |
| HB-10 | design-docs/index.md 갱신 | `docs/design-docs/index.md` | Gate chain + Exit Gate 문서화 |

### 테스트 추가

- `test/gateEventScore.test.ts`: Sell-side impact exit gate 5건 (passes, sizing reduction, reject, skip undefined, sync ignore)

---

## Historical Completed Work

### Core

- pump_detect 실행 경로 제거
- fib_pullback 동적 스코어링 (`buildFibPullbackScore()`)
- `checkTokenSafety()` -> `checkOrder()` 연결
- lpBurned / ownershipRenounced -> 포지션 사이징 반영
- Daily loss halt -> 실제 trading halt 연결
- HWM 저장 + trailing stop 반영
- TP1 partial exit + 잔여 trailing 유지
- Gate 모듈 추출로 live/backtest 공유 경로 구성
- DrawdownGuard 통합
- EventScore gate 연동
- Risk Tier System 구현
- Risk Tier 승급 품질 게이트 추가
- Execution viability actual-size 재검증 추가
- `minBuyRatio` hard reject 추가
- Backtest `EXHAUSTION` / RSI adaptive trailing parity 추가
- Backtest static + time-series EventScore replay 지원
- Pair-level EdgeTracker stats + 기본 auto blacklist 추가
- Blacklist decay / 재활성화 정책 (`decayWindowTrades` 슬라이딩 윈도우)
- `index.ts` orchestration 분리
- `handleNewCandle()` -> `orchestration/candleHandler.ts` 분리
- Execution viability early probe (`estimatedPositionSol`)
- Multi-period trend alignment 실제 구현 (`calcMultiPeriodAlignment`)

### Quality

- ESLint 9 flat config 생성
- Jest config 경로 수정
- 미사용 import/변수 정리
- EventScore -> AttentionScore/AttentionGate 재명명
- `scripts/backtest.ts` any 타입 제거 + CLI flag rename
- deprecated `getAllActiveScores()` 제거
- `scripts/migrate.ts` `PoolClient` 타입 적용
- `backtest/reporter.ts` 포맷 불일치 수정

---

## Historical Decisions

### Q-1. EventScore -> AttentionGate 재명명

결론:
- 현 구현은 외생 이벤트 스코어라기보다 attention / momentum whitelist에 가깝다.
- 문서와 코드에서 Attention 계열 네이밍을 우선 사용한다.

### Q-2. 10-preset backtest 비교

결론:
- 이론 최적화보다 preset 비교 실험으로 파라미터를 검증한다.

### Q-3. Combined backtest 정합성

결론:
- Strategy E backtest parity 보강으로 해소됐다.
