# Code Quality Review — Full Audit (2026-03-17)

> Scope: Phase 2 / 3 / 4 전체 신규 코드 + 기존 코드 수정분
> Mission: 1 SOL → 100 SOL
> Reviewer: Automated deep review (4-way parallel audit)

---

## Mission Viability Assessment

### 판정: 조건부 유효 (Conditionally Viable)

1 SOL → 100 SOL (100x) 달성을 위한 **아키텍처와 전략 프레임워크는 충분**하다.
그러나 아래 CRITICAL 이슈들이 해결되지 않으면 **라이브 운영 시 자금 손실 위험**이 존재한다.

| 항목 | 평가 |
|------|------|
| Multi-strategy 아키텍처 | ✅ 4개 전략 (A/C/D/E) 독립 실행 가능 |
| Risk tier 체계 | ✅ Bootstrap → Proven 4단계 + Kelly |
| MEV 보호 (Jito) | ⚠️ DontFront 구현 버그로 실 보호 불가 |
| Drawdown guard | ✅ Mark-to-market + tier-based DD limit |
| 실시간 데이터 | ✅ Birdeye WS (price/txs/OHLCV) |
| Security gate | ✅ Honeypot/freeze/transfer_fee/exit-liq |
| 배선 완결성 | ❌ 5개 모듈 dead code (미연결) |
| 버그 밀도 | ❌ CRITICAL 24건 — 라이브 전 필수 수정 |

**핵심 블로커**: CRITICAL 이슈 24건 중 자금 손실 직결 7건을 우선 해결해야 라이브 진입 가능.

---

## Issue Summary

| Severity | Count | Description |
|----------|-------|-------------|
| 🔴 CRITICAL | 24 | 자금 손실 / 런타임 크래시 / 데이터 손실 |
| 🟠 HIGH | 33 | 기능 불완전 / 잘못된 결과 / 성능 문제 |
| 🟡 MEDIUM | 20+ | 코드 품질 / 유지보수성 / 명명 혼동 |

---

## 🔴 CRITICAL Issues

### C-01. DontFront 전송 실패 (jitoClient.ts)

`SystemProgram.transfer`로 DontFront 계정(non-system account)에 0 lamports 전송 시도 → **트랜잭션 실패**.

```typescript
// 현재 (잘못된 코드)
SystemProgram.transfer({ fromPubkey, toPubkey: DONT_FRONT, lamports: 0 })
// 수정: Memo program instruction 또는 단순 제거
```

**영향**: Jito MEV 보호가 실질적으로 작동하지 않음 → 샌드위치 공격 노출

### C-02. signal_audit 테이블명 오류 (preflightCheck.ts)

```typescript
// 현재: signal_audit (존재하지 않는 테이블)
// 실제: signal_audit_log
const signals = await pool.query('SELECT * FROM signal_audit WHERE ...');
```

**영향**: Pre-flight check 항상 실패 또는 빈 결과 → live 모드 전환 불가

### C-03. ON CONFLICT 구문 오류 (eventScoreStore.ts)

```typescript
// 현재: ON CONFLICT DO NOTHING (conflict target 누락)
// 수정: ON CONFLICT (token_mint, detected_at) DO NOTHING
```

**영향**: EventScore 중복 삽입 시 PostgreSQL 에러 → 데이터 영속화 실패

### C-04. SpreadMeasurer 재귀 sell quote 페어 반전 (spreadMeasurer.ts)

sell quote 호출 시 `inputMint`/`outputMint`가 반전되어 있음 → 잘못된 spread 계산

**영향**: 실제 round-trip cost 과소평가 → 손실 트레이드 진입

### C-05. SocialMentionTracker window reset 시점 오류 (socialMentionTracker.ts)

윈도우 리셋 체크가 `count++` 이후에 실행 → 리셋 시 현재 mention이 소실됨

```typescript
// 현재: increment → check reset (mention 소실)
// 수정: check reset → increment
```

### C-06. calculateCombinedStopLoss가 cost basis 위 SL 생성 가능 (momentumCascade.ts)

다중 leg의 combined SL 계산 시 SL이 cost basis보다 높아질 수 있음 → **진입 즉시 손실 확정**

```typescript
// 수정: Math.min(combinedSL, costBasis * 0.99) 같은 상한 제약 필요
```

**영향**: Momentum Cascade add-on 시 guaranteed loss position 생성

### C-07. CascadeState.tp1Hit 미갱신 (momentumCascade.ts)

`tp1Hit`이 항상 `false` → `isFirstLegQualified`가 항상 실패 → **Strategy E add-on 불가**

```typescript
// initCascadeState에서 tp1Hit: false 설정 후 갱신 로직 없음
// 수정: position monitor에서 TP1 도달 시 state.tp1Hit = true 설정 필요
```

### C-08. stopLoss=0 (newLpSniper.ts)

`acceptFullLoss=true`일 때 `stopLoss: 0` → SL이 절대 트리거되지 않음 → **무한 손실**

```typescript
// 수정: stopLoss = entryPrice * (1 - maxLossPct) 같은 실제 SL 필요
```

### C-09. tradingMode vs effectiveMode 불일치 (index.ts:263)

```typescript
// Line 263: tradingMode 사용 (pre-flight 결과 무시)
// 수정: effectiveMode 사용
```

**영향**: Pre-flight 실패해도 live 트레이딩 실행 가능

### C-10. Wallet private key 파싱 오류 무시 (walletManager.ts)

`bs58.decode(key)` 실패 시 예외 처리 없음 → **앱 크래시**

### C-11. Jito tip 계정 선택 시 index 오류 가능성 (jitoClient.ts)

`Math.random() * TIP_ACCOUNTS.length`를 `Math.floor` 없이 사용하면 배열 범위 초과

### C-12. DB pool 미정리 (backtestTp1Tuning.ts)

스크립트 조기 종료 시 PostgreSQL pool이 정리되지 않음 → connection leak

### C-13. Executor Jito 경로에서 confirmation 미대기 (executor.ts)

Jito bundle 제출 후 confirmation 없이 성공 반환 → 실패 트랜잭션을 성공으로 처리

### C-14. Demotion 후 Kelly eligibility 미재계산 (riskTier.ts)

```typescript
// 현재: kellyEligible을 단순 state 비교로 설정
const demotedStats = { ...stats, edgeState: demotedState,
  kellyEligible: demotedState === 'Confirmed' || demotedState === 'Proven' };
// 문제: Calibration으로 강등 시에도 kellyEligible=false이지만
//        kellyFraction은 원래 값 유지 → 의도치 않은 Kelly 적용 가능
```

### C-15 ~ C-24. 추가 CRITICAL

| # | File | Issue |
|---|------|-------|
| C-15 | eventScoreStore.ts | `insertScores` batch가 빈 배열일 때 invalid SQL 생성 |
| C-16 | jitoClient.ts | Bundle status polling에 max retry 없음 → 무한 루프 가능 |
| C-17 | preflightCheck.ts | `trades.length < minTrades` 체크 누락 시 division by zero |
| C-18 | newLpSniper.ts | `buildNewLpOrder`에서 slippage 미설정 → Jupiter default 사용 |
| C-19 | momentumCascade.ts | `calculateAddOnQuantity`에서 balance undefined 시 NaN 반환 |
| C-20 | spreadMeasurer.ts | Cache TTL 1분이지만 stale quote로 의사결정 가능 |
| C-21 | executor.ts | Jito fallback 경로 없음 — Jito 장애 시 트레이딩 중단 |
| C-22 | walletManager.ts | 일별 리셋이 UTC 자정 기준이지만 timezone 미설정 |
| C-23 | candleHandler.ts | measuredSpreadPct가 undefined일 때 기존 spread 덮어쓰기 |
| C-24 | index.ts | pruneInterval clearInterval 미처리 → graceful shutdown 불완전 |

---

## 🟠 HIGH Issues

### Integration Gaps (Dead Code / Orphaned Modules)

| # | Module | Status | Impact |
|---|--------|--------|--------|
| H-01 | WalletManager | 생성만 됨, 호출 없음 | Strategy D 자금 격리 미작동 |
| H-02 | SocialMentionTracker | 생성만 됨, WatchlistScore 미연결 | Social score 항상 0 |
| H-03 | SpreadMeasurer | signal.meta에만 기록 | executionViability gate에 미반영 |
| H-04 | resolveRiskTierWithDemotion | export만 됨 | 강등 메커니즘 실제 미작동 |
| H-05 | Strategy D (newLpSniper) | candleHandler에서 미호출 | New LP Sniper 실행 불가 |
| H-06 | Strategy E (momentumCascade) | backtest engine 미배선 | Cascade add-on 실행 불가 |

### Logic Issues

| # | File | Issue |
|---|------|-------|
| H-07 | edgeTracker.ts | `DEMOTION_GATES` 필드명 `maxWinRate`가 실제로는 최소 임계값 (naming confusion) |
| H-08 | riskTier.ts | `resolveRiskTierWithDemotion`이 portfolio mode만 demotion 체크 (strategy mode 무시) |
| H-09 | momentumCascade.ts | `detectRecompression` ATR 기반인데 최소 candle 수 체크 없음 |
| H-10 | momentumCascade.ts | `detectReacceleration`이 volume spike만 보고 price confirmation 없음 |
| H-11 | newLpSniper.ts | Security check가 동기 함수지만 실제 API 호출 필요 (미래 비동기 전환 필요) |
| H-12 | edgeTracker.ts | `calcSharpe`가 `√252` 연율화 — crypto 365일 거래에 부적합 |
| H-13 | preflightCheck.ts | R:R 계산이 closed trades의 pnl 기반 — risk-adjusted R:R이 아님 |
| H-14 | jitoClient.ts | Tip amount가 고정 — 네트워크 혼잡도에 따른 동적 조정 없음 |
| H-15 | backtestTp1Tuning.ts | 4 시나리오 비교에서 통계적 유의성 검정 없음 |
| H-16 | eventScoreStore.ts | pruneOlderThan이 DELETE without LIMIT → 대량 삭제 시 DB lock |
| H-17 | candleHandler.ts | Strategy A와 C 모두 동일 spread 측정 → 불필요한 중복 호출 |
| H-18 | walletManager.ts | Daily loss tracking이 메모리 기반 — 재시작 시 초기화 |
| H-19 | index.ts | EventScoreStore.initialize()가 앱 시작 시 1회만 — migration 실패 시 무한 실패 |
| H-20 | spreadMeasurer.ts | Jupiter quote 실패 시 default spread 사용 — 실제 spread 급등 감지 불가 |

### Performance Issues

| # | File | Issue |
|---|------|-------|
| H-21 | edgeTracker.ts | `getBlacklistedPairs`가 O(n²) — 페어 수 증가 시 성능 저하 |
| H-22 | eventScoreStore.ts | `exportTimeline` LIMIT 없이 전체 로드 가능 |
| H-23 | riskTier.ts | `replayTieredDrawdownGuard`가 매 trade마다 EdgeTracker 전체 재계산 |

### Missing Error Handling

| # | File | Issue |
|---|------|-------|
| H-24 | jitoClient.ts | HTTP 429 rate limit 처리 없음 |
| H-25 | spreadMeasurer.ts | Jupiter API timeout 미설정 |
| H-26 | eventScoreStore.ts | DB connection 실패 시 retry 없음 |
| H-27 | preflightCheck.ts | DB query 실패 시 pre-flight pass로 처리될 위험 |

### Type Safety

| # | File | Issue |
|---|------|-------|
| H-28 | types.ts | StrategyName에 'momentum_cascade' 미포함 (Strategy E 전용 타입 없음) |
| H-29 | walletManager.ts | WalletProfile.keypair가 nullable이지만 null check 미수행 |
| H-30 | newLpSniper.ts | NewListingCandidate 인터페이스에 optional 필드 과다 |
| H-31 | momentumCascade.ts | CascadeLeg.price가 0일 수 있음 (division by zero 위험) |
| H-32 | edgeTracker.ts | summarizeTrades에서 empty array → winRate=0, rewardRisk=0 → 항상 Bootstrap |
| H-33 | candleHandler.ts | SpreadMeasurement | null 반환값 처리 불완전 |

---

## 🟡 MEDIUM Issues

| # | Category | Issue |
|---|----------|-------|
| M-01 | Naming | `DEMOTION_GATES.maxWinRate` → `minWinRate`로 변경 필요 |
| M-02 | Naming | `DEMOTION_GATES.maxRewardRisk` → `minRewardRisk`로 변경 필요 |
| M-03 | Config | Jito tip accounts 하드코딩 → config로 이동 |
| M-04 | Config | SpreadMeasurer cache TTL 하드코딩 (60s) |
| M-05 | Config | SocialMentionTracker window size 하드코딩 |
| M-06 | Testing | Phase 2/3/4 신규 모듈 단위 테스트 없음 |
| M-07 | Testing | momentumCascade edge case 테스트 없음 |
| M-08 | Testing | edgeTracker demotion 로직 테스트 없음 |
| M-09 | Logging | jitoClient에 structured logging 없음 |
| M-10 | Logging | walletManager PnL 기록에 로그 없음 |
| M-11 | Docs | Strategy E 진입/청산 플로우 문서 없음 |
| M-12 | Docs | Demotion 메커니즘 운영 가이드 없음 |
| M-13 | Code | walletManager와 riskManager 책임 중복 (daily loss) |
| M-14 | Code | EdgeTracker가 God class 경향 (6개 책임) |
| M-15 | Code | preflightCheck 하드코딩 threshold → config 추출 필요 |
| M-16 | Code | backtestTp1Tuning.ts 내 inline config → 외부 파일 분리 |
| M-17 | Security | sandboxWalletKey가 환경변수로 평문 노출 |
| M-18 | Resilience | Birdeye WS 재연결 실패 시 fallback 없음 |
| M-19 | Resilience | DexScreener rate limit 시 graceful degradation 없음 |
| M-20 | Resilience | PostgreSQL connection pool exhaustion 대비 없음 |

---

## Priority Fix Order (라이브 운영 전 필수)

### Tier 1 — 자금 손실 방지 (즉시)

1. **C-01** DontFront 수정 또는 제거
2. **C-06** Combined SL 상한 제약
3. **C-07** tp1Hit 갱신 로직 추가
4. **C-08** stopLoss=0 제거, 실제 SL 설정
5. **C-09** tradingMode → effectiveMode
6. **C-04** SpreadMeasurer sell quote 페어 수정
7. **C-13** Jito confirmation 대기 추가

### Tier 2 — 데이터 무결성 (1일 내)

8. **C-02** signal_audit → signal_audit_log
9. **C-03** ON CONFLICT target 추가
10. **C-05** Window reset 순서 수정
11. **C-15** 빈 배열 체크
12. **C-16** Bundle polling max retry
13. **C-14** Demotion Kelly 재계산

### Tier 3 — 기능 완결 (라이브 전)

14. **H-01~H-06** Dead code 배선 완결
15. **H-07~H-08** Demotion naming + strategy mode
16. **H-28** StrategyName 확장

### Tier 4 — 운영 안정성 (라이브 후 1주)

17. **H-18** WalletManager 영속화
18. **H-20~H-27** Error handling 강화
19. **M-06~M-08** 핵심 모듈 테스트 추가

---

## 1 SOL → 100 SOL 달성 가능성 분석

### 수학적 검증

- **Kelly 기반 복리**: WR 50%, R:R 2.0 가정 시 Kelly f* = 0.25
- **1/4 Kelly (Confirmed tier)**: 6.25% per trade
- **100x 도달**: ln(100)/ln(1+0.0625×E[R]) ≈ 200~300 trades (이론적)
- **현실 조정**: 수수료, slippage, regime filter로 인한 미체결 고려 시 500~1000 trades

### 전략별 기여도 예상

| Strategy | 역할 | 기대 기여 |
|----------|------|----------|
| A (Volume Spike) | 주력 수익원 | 60% |
| C (Fib Pullback) | 보조 수익원 | 20% |
| D (New LP) | 고위험 고수익 | 10% |
| E (Cascade) | A 수익 극대화 | 10% |

### 결론

**아키텍처적으로 100x 달성이 가능한 프레임워크**이나:

1. Tier 1 CRITICAL 버그 7건 해결 필수
2. Dead code 6개 모듈 배선 완결 필수
3. Paper trading으로 최소 50 trades 검증 후 live 전환
4. Market regime이 유리할 때 (Bull/Neutral) 운영 시작 권장

---

## Active Issues (ISSUES.md에서 이관)

- C-2: X Filtered Stream 실연동 (Bearer Token 대기)
- Strategy E backtest engine 통합
- Strategy D orchestration 배선
- 포지션 모니터링 WS 전환 완결
