# ARCHITECTURE.md — Solana Momentum Bot

> 이 문서는 모듈 구조, 의존성 방향, 데이터 흐름을 정의한다.
> 새 파일 생성 전 반드시 이 문서의 의존성 규칙을 확인하라.

---

## 1. 2-Stage Entry Model

```
Stage 1: Context — 왜 이 코인이 움직일 수 있는가?
  → EventMonitor (AttentionScore) + ScannerEngine (trending/social)
  → "뉴스 없는 급등 = 조작 가능성" → 추격 금지

Stage 2: Trigger — 지금 들어가도 되는가?
  → Strategy (breakout/pullback 시그널) → Gate (5+1단계 필터) → Risk (사이징) → Executor (체결)
```

## 2. 모듈 맵 (19개)

| 모듈 | 책임 | 핵심 export |
|---|---|---|
| **utils/** | 설정, 로거, 공유 타입, 상수 | `config`, `logger`, `constants`, `Candle`, `Signal`, `Order` |
| **candle/** | OHLCV/트레이드 영속화 | `CandleStore`, `TradeStore` |
| **state/** | 포지션 상태 머신, 크래시 복구 | `PositionStore`, `ExecutionLock` |
| **ingester/** | 외부 데이터 수집 (Birdeye, Gecko) | `BirdeyeClient`, `BirdeyeWSClient`, `Ingester` |
| **event/** | AttentionScore 계산/캐시 | `EventMonitor`, `EventScoreStore` |
| **scanner/** | 후보 탐색/감시 목록 관리 | `ScannerEngine`, `SocialMentionTracker` |
| **universe/** | 풀 필터링/랭킹 | `UniverseEngine` |
| **realtime/** | 마이크로캔들 빌더, 결과 추적 | `MicroCandleBuilder`, `RealtimeOutcomeTracker` |
| **discovery/** | Helius WebSocket 풀 탐지, 큐 관리 | `HeliusPoolDiscovery` |
| **strategy/** | 시그널 생성 (A/C/D/E) | `evaluateVolumeSpikeBreakout`, `evaluateFibPullback`, ... |
| **gate/** | 5+1단계 시그널 필터링 | `evaluateGates`, `evaluateGatesAsync`, `SpreadMeasurer` |
| **risk/** | 포지션 사이징, 드로다운 관리 | `RiskManager`, `DrawdownGuard`, `RiskTier` |
| **executor/** | Jupiter 스왑/Jito 번들 실행 | `Executor`, `WalletManager` |
| **reporting/** | 성과 집계, 엣지 추적, 런타임 진단 | `EdgeTracker`, `PaperValidation`, `RuntimeDiagnosticsTracker` |
| **ops/** | 세션 관리, 헬스 모니터 | `SessionManager`, `HealthMonitor` |
| **notifier/** | Telegram 4-Level 알림 | `Notifier` |
| **audit/** | 시그널 감사 로그 | `SignalAuditLogger` |
| **backtest/** | 백테스트 엔진/리포터/스윕 | `BacktestEngine`, `BacktestReporter`, `ParamSweep` |
| **orchestration/** | 최상위 조율 (BotContext) | `handleNewCandle`, `checkOpenPositions`, `BotContext` |

## 3. 의존성 방향 규칙

### 실제 검증된 의존성 다이어그램

```
                      ┌─────────────┐
                      │ utils/      │ ← 모든 모듈이 참조 가능
                      │ config      │
                      │ logger      │
                      │ types       │
                      └──────┬──────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
   ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
   │ candle/     │   │ state/      │   │ ingester/   │  ← 데이터/인프라 레이어
   │ (DB 영속)   │   │ (상태 머신)  │   │ (외부 API)  │
   └─────────────┘   └─────────────┘   └──────┬──────┘
                                               │
                         ┌─────────────────────┤
                         │                     │
                  ┌──────▼──────┐       ┌──────▼──────┐
                  │ event/      │       │ scanner/    │  ← 수집/탐색 레이어
                  │ (Attention) │       │ (후보 관리)  │
                  └──────┬──────┘       └─────────────┘
                         │
          ┌──────────────┤
          │              │
   ┌──────▼──────┐      │
   │ strategy/   │◄─────┘                              ← 시그널 생성 레이어
   │ (A/C/D/E)   │ (ingester: newLpSniper만)
   └──────┬──────┘
          │
   ┌──────▼──────┐
   │ gate/       │ ← event/, ingester/, strategy/ 참조  ← 필터링 레이어
   └──────┬──────┘
          │
   ┌──────▼──────┐    ┌──────────────┐
   │ risk/       │◄──►│ reporting/   │  ⚠️ 순환 의존   ← 리스크/보고 레이어
   └──────┬──────┘    └──────────────┘
          │
   ┌──────▼──────┐
   │ executor/   │                                      ← 실행 레이어
   └──────┬──────┘
          │
   ┌──────▼──────┐
   │orchestration/│ ← 모든 모듈 참조 가능                ← 최상위 조율
   └─────────────┘

독립 모듈 (orchestration에서만 호출):
  notifier/    ← utils/만 참조
  audit/       ← utils/만 참조
  universe/    ← utils/만 참조
  backtest/    ← strategy, gate, risk 참조 (런타임과 격리)
  realtime/    ← utils/만 참조 (MicroCandleBuilder, RealtimeOutcomeTracker)
  discovery/   ← utils/ 참조 (HeliusPoolDiscovery — Helius WebSocket 풀 탐지)
  ops/         ← utils/ 참조 (SessionManager, HealthMonitor)
```

### ⚠️ 알려진 순환 의존성

```
risk/riskTier.ts → reporting/edgeTracker (EdgeTracker, EdgeState)
reporting/paperValidation.ts → risk/drawdownGuard (replayDrawdownGuardState)
```

**현상:** risk/와 reporting/이 서로를 참조. 현재 런타임 문제 없음 (Node.js lazy resolution).
**향후 해결:** 공유 타입을 `utils/types.ts`로 추출하거나 reporting/의 risk 의존을 interface로 역전.

### 금지 규칙

| 금지 | 이유 |
|---|---|
| executor/ → strategy/ | 실행 레이어가 시그널 생성에 의존하면 안 됨 |
| strategy/ → executor/ | 시그널 생성이 실행 결과에 의존하면 안 됨 |
| strategy/ → orchestration/ | 하위 → 상위 역참조 금지 |
| candle/ → gate/ | 데이터 레이어가 비즈니스 로직에 의존하면 안 됨 |
| risk/ → orchestration/ | 하위 → 상위 역참조 금지 |
| utils/ → 다른 모듈 | 기반 레이어는 독립적이어야 함 |

## 4. 데이터 흐름

```
외부 데이터 수집:
  Birdeye REST/WS ──→ Ingester ──→ CandleStore (TimescaleDB)
  DexScreener     ──→ Scanner  ──→ Watchlist (in-memory)
  Birdeye Trending ──→ EventMonitor ──→ AttentionScore cache

시그널 처리 (handleNewCandle):
  CandleStore → Strategy(A/C/D/E) → Signal
    → Gate 0: SecurityGate (async — honeypot, freeze, transferFee, holder 집중도)
    → Gate 1: AttentionScore (트렌딩 화이트리스트)
    → Gate 2A: ExecutionViability (R:R + round-trip cost)
    → Gate 2B: QuoteGate (async — Jupiter entry price impact)
    → Gate 3: StrategyScore (전략별 점수, A/B/C 등급)
    → Gate 4: SafetyGate (pool 유동성, token age, LP burn)
    → Exit Gate: Sell-side Impact (async — 포지션 크기 기반 exit 유동성)
  → RiskManager.checkOrder()
  → Executor.executeBuy() → Jupiter Swap / Jito Bundle

포지션 관리 (checkOpenPositions, 5초 간격):
  PositionStore → 현재 가격 조회 → SL/TP/TimeStop/Exhaustion 체크
  → Executor.executeSell() → TradeStore.closeTrade()
```

## 5. BotContext

모든 orchestration 핸들러에 전달되는 중앙 컨텍스트 객체.
`src/orchestration/types.ts`에 정의.

**필수 필드:** tradingMode, candleStore, tradeStore, riskManager, executor, notifier, healthMonitor, universeEngine, eventMonitor, executionLock, positionStore, auditLogger

**선택 필드 (Phase별 활성화):** scanner, geckoClient, birdeyeClient, onchainSecurityClient, regimeFilter, paperMetrics, socialMentionTracker, spreadMeasurer, eventScoreStore, walletManager

## 6. 핵심 전략

| 전략 | 파일 | 진입 조건 | 상태 |
|---|---|---|---|
| A: Volume Spike | `strategy/volumeSpikeBreakout.ts` | volume ≥2.5x + 20-candle high 돌파 | 활성 |
| C: Fib Pullback | `strategy/fibPullback.ts` | 15%+ 임펄스 → fib 0.5–0.618 되돌림 | 활성 |
| D: New LP Sniper | `strategy/newLpSniper.ts` | 신규 LP 탐지 (샌드박스) | 샌드박스 |
| E: Momentum Cascade | `strategy/momentumCascade.ts` | Strategy A 멀티레그 추가 진입 | 활성 |
