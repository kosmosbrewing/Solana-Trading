# v4 개선 계획: 100x 병목 해소

> 작성일: 2026-03-18
> **구현 완료: 2026-03-19** (Step 1~6 전체 + 품질 점검 2회)
> 근거: 1→100 SOL 달성 조건 점검 결과
> 전제: v3 (Runner, Ultra, TP1 연장) 구현 완료

---

## 구현 상태 요약

| Step | 설명 | 상태 | 테스트 |
|------|------|------|--------|
| 1A | Age Bucket 설정 가능화 | **완료** | safetyGate.test.ts |
| 1B | Position Cap 설정 가능화 | **완료** | riskManager.test.ts |
| 1C | Execution R:R 임계값 | **완료** | liveGateInput.test.ts |
| 1D | ABSOLUTE_MAX 설정 가능화 | **완료** | runnerConcurrent.test.ts |
| 2 | Age Bucket 곡선 완화 (3-tier) | **완료** (1A에 통합) | safetyGate.test.ts |
| 3 | 포트폴리오 스케일 Concurrent | **완료** | runnerConcurrent.test.ts |
| 4 | Kelly 보간 | **완료** | riskTier.test.ts |
| 5A | 동적 TVL 최소 기준 | **완료** | safetyGate.test.ts |
| 5B | 동적 maxPoolImpact | **완료** | riskManager.test.ts |
| 6 | 파라미터 스윕 엔진 | **완료** | paramSweep.test.ts |

**검증:** `tsc --noEmit` 0 errors, 24 suites / 123 tests 통과

---

## 핵심 병목 요약

| 순위 | 병목 | 영향 | v4 이전 상태 | v4 해결 |
|------|------|------|----------|---------|
| **1** | 유동성 천장 | 5+ SOL 이후 포지션 사이즈 정체 | maxPoolImpact 2% 고정, 20% cap 하드코딩 | Step 1B + 5A + 5B |
| **2** | Age Bucket 과도한 페널티 | 최고 기회(20m~2h)에서 0.25x | 임계값 5개 전부 하드코딩 | Step 1A + 2 |
| **3** | Kelly 급변 (cliff) | 50 trade에서 1%→3% 급등 | 계단식 전환, 보간 없음 | Step 4 |
| **4** | Concurrent 고정 | 포트폴리오 성장과 무관하게 1~2개 | ABSOLUTE_MAX=2 하드코딩 | Step 1D + 3 |

---

## Step 1: 하드코딩 상수 → 설정 가능화 (난이도 낮음, 영향 높음)

**목적**: 코드 변경 없이 운영 중 파라미터 조정 가능하게.

### 1A: Age Bucket 설정 가능화

**파일**: `src/gate/safetyGate.ts`, `src/utils/config.ts`

**현재 (하드코딩)**:
```
< 20min      → reject
20min ~ 2h   → × 0.25
2h ~ 24h     → × 0.5
≥ 24h        → × 1.0
```

**변경**:
- config에 6개 파라미터 추가:
  ```
  AGE_BUCKET_HARD_FLOOR_MIN=20         # reject 기준 (분)
  AGE_BUCKET_1_UPPER_HOURS=2           # 구간1 상한 (시간)
  AGE_BUCKET_1_MULTIPLIER=0.25         # 구간1 승수
  AGE_BUCKET_2_UPPER_HOURS=24          # 구간2 상한 (시간)
  AGE_BUCKET_2_MULTIPLIER=0.5          # 구간2 승수
  ```
- `safetyGate.ts`의 `applyAgeBucket()`에서 config 값 사용

**테스트**: 기존 `test/safetyGate.test.ts` 확장 — 커스텀 임계값 동작 확인

### 1B: Position Cap 설정 가능화

**파일**: `src/risk/riskManager.ts`, `src/utils/config.ts`

**현재**: `portfolio.balanceSol * 0.2` (20%, 하드코딩, 라인 230/245)

**변경**:
- config에 `MAX_POSITION_PCT` 추가 (기본값: 0.20)
- riskManager에서 `this.riskConfig.maxPositionPct ?? 0.20` 사용

### 1C: Execution Viability R:R 임계값

**파일**: `src/gate/executionViability.ts`, `src/utils/config.ts`

**현재**: `MIN_EFFECTIVE_RR_REJECT = 1.2`, `MIN_EFFECTIVE_RR_PASS = 1.5` (하드코딩)

**변경**:
- config에 `EXECUTION_RR_REJECT=1.2`, `EXECUTION_RR_PASS=1.5` 추가
- 함수 파라미터로 전달

### 1D: ABSOLUTE_MAX 설정 가능화

**파일**: `src/risk/riskManager.ts`, `src/utils/config.ts`

**현재**: `const ABSOLUTE_MAX = 2` (하드코딩)

**변경**:
- config에 `MAX_CONCURRENT_ABSOLUTE=3` 추가 (기본값: 3, 안전 상한)
- `this.riskConfig.maxConcurrentAbsolute ?? 3` 사용

---

## Step 2: Age Bucket 곡선 완화 (난이도 낮음, 영향 중)

**목적**: 20m~2h 토큰의 0.25x 페널티를 세분화. 최고 기회 구간 exposure 회복.

Step 1A 완료 후, 기본값을 아래로 조정:

```
기존:  < 20min reject / 20m~2h 0.25x / 2h~24h 0.5x / ≥24h 1.0x
제안:  < 15min reject / 15m~1h 0.25x / 1h~4h 0.5x / 4h~24h 0.75x / ≥24h 1.0x
```

**변경**: Step 1A의 2-구간 구조를 3-구간으로 확장
- config에 `AGE_BUCKET_3_UPPER_HOURS=24`, `AGE_BUCKET_3_MULTIPLIER=0.75` 추가
- `applyAgeBucket()` 로직을 구간 배열 순회로 리팩토링

**효과**:
- 1h~4h 토큰: 0.25x → 0.5x (2배)
- 4h~24h 토큰: 0.5x → 0.75x (1.5배)
- 총 기회 exposure ~40% 증가 추정

**테스트**: 3-구간 경계값 테스트 추가

---

## Step 3: 포트폴리오 스케일 Concurrent (난이도 중, 영향 중)

**목적**: 포트폴리오 성장에 따라 동시 포지션 수 자동 확대.

**파일**: `src/risk/riskManager.ts`, `src/utils/config.ts`

**현재**: `maxConcurrentPositions` 고정 (기본 1, runner bypass 시 최대 2)

**제안 로직**:
```typescript
// 기본: 1 포지션
// 5+ SOL: 2 포지션 (runner 없이도)
// 20+ SOL: 3 포지션
const equityTiers = [
  { minEquity: 0, maxConcurrent: 1 },
  { minEquity: 5, maxConcurrent: 2 },
  { minEquity: 20, maxConcurrent: 3 },
];

// Runner bypass는 위 결과 + 1 (ABSOLUTE_MAX 이내)
```

**변경**:
- config에 `CONCURRENT_EQUITY_TIERS` 추가 (JSON 또는 3개 env var)
  ```
  CONCURRENT_TIER_1_SOL=5    # 2 concurrent부터
  CONCURRENT_TIER_2_SOL=20   # 3 concurrent부터
  ```
- `checkOrder()`에서 portfolio.equitySol 기반 동적 maxConcurrent 계산
- ABSOLUTE_MAX는 Step 1D에서 설정 가능화된 값 사용

**테스트**: `test/runnerConcurrent.test.ts` 확장
- equitySol=3 → max 1
- equitySol=8 → max 2
- equitySol=25 → max 3
- equitySol=25 + runner → max 4 (ABSOLUTE_MAX 이내)

---

## Step 4: Kelly 보간 (난이도 중, 영향 낮~중)

**목적**: 50 trade에서 1%→3% 급변(cliff) 방지. 점진적 전환으로 드로다운 리스크 감소.

**파일**: `src/risk/riskTier.ts`

**현재**: EdgeState 기반 계단식 전환

**제안**: 경계 근처에서 선형 보간

```typescript
// Calibration→Confirmed 전환 (trades 40~60)
if (tradeCount >= 40 && tradeCount < 60) {
  const progress = (tradeCount - 40) / 20; // 0→1
  const calibrationRisk = 0.01;  // 1% fixed
  const confirmedRisk = resolvedKellyRisk; // up to 3%
  maxRiskPerTrade = lerp(calibrationRisk, confirmedRisk, progress);
}

// Confirmed→Proven 전환 (trades 85~115)
if (tradeCount >= 85 && tradeCount < 115) {
  const progress = (tradeCount - 85) / 30;
  maxRiskPerTrade = lerp(confirmedRisk, provenRisk, progress);
}
```

**핵심**: 승급 조건(WR, R:R, Sharpe)은 그대로 유지. 통과 시에도 risk 할당만 점진 증가.

**테스트**: `test/riskTier.test.ts` 확장
- trade 45: 1%~2% 사이
- trade 50: Confirmed Kelly 적용 (조건 충족 시)
- trade 55: Confirmed Kelly 풀 적용

---

## Step 5: 유동성 적응 사이징 (난이도 중, 영향 높음)

**목적**: 포트폴리오 10+ SOL 이후 유동성 바인딩을 완화하는 전략 레벨 변경.

이것은 코드 변경이 아닌 **운영 전략 가이드**.

### 5A: TVL 최소 기준 동적 상향

**파일**: `src/gate/safetyGate.ts`, `src/utils/config.ts`

```
portfolio < 5 SOL   → minPoolLiquidity = $50K (현재)
portfolio 5~20 SOL  → minPoolLiquidity = $100K
portfolio 20+ SOL   → minPoolLiquidity = $200K
```

**변경**:
- config에 `MIN_POOL_LIQUIDITY_TIERS` 추가 (equity 기반)
- `checkTokenSafety()`에 portfolio 파라미터 추가

**효과**: 큰 포트폴리오가 저유동성 토큰에 진입하지 않도록 자동 방지

### 5B: maxPoolImpact 동적 축소

**현재**: 2% 고정

```
portfolio < 5 SOL   → maxPoolImpact = 2% (현재)
portfolio 5~20 SOL  → maxPoolImpact = 1.5%
portfolio 20+ SOL   → maxPoolImpact = 1%
```

**효과**: 포트폴리오 성장 시 시장 영향력 자동 제한. slippage 감소.

---

## 구현 순서 및 의존 관계

```
Step 1 (설정 가능화)      ← 최우선. 모든 후속 작업의 기반
  ├── 1A (Age Bucket)     ← 독립
  ├── 1B (Position Cap)   ← 독립
  ├── 1C (R:R 임계값)     ← 독립
  └── 1D (ABSOLUTE_MAX)   ← 독립

Step 2 (Age Bucket 완화)  ← Step 1A 이후

Step 3 (Concurrent 스케일) ← Step 1D 이후

Step 4 (Kelly 보간)       ← 독립

Step 5 (유동성 적응)       ← Step 1B 이후
  ├── 5A (TVL 최소)       ← 독립
  └── 5B (Impact 축소)    ← 독립
```

**1A~1D는 병렬 가능 → Step 2,3,4,5는 순차 또는 병렬**

---

## 예상 효과

| 개선 | 컴파운딩 기여 | 타임라인 단축 |
|------|-------------|-------------|
| Age Bucket 완화 | 기회 exposure +40% | -15~20% |
| Concurrent 스케일 | 거래 빈도 +50% (5+ SOL) | -10~15% |
| Kelly 보간 | 드로다운 감소 → 중단 빈도↓ | -5~10% |
| 유동성 적응 | 대형 토큰 진입 → R:R 안정 | -10~15% |
| **합산** | | **보수 시나리오 5~8개월 → 3~5개월** |

---

## 검증 기준

```bash
npx tsc --noEmit              # 0 errors
npx jest --no-cache           # 기존 테스트 + 신규 전부 통과
```

각 Step 완료 후:
1. 기존 테스트 회귀 없음
2. 신규 테스트 통과
3. STRATEGY.md 파라미터 테이블 동기화
4. README.md 업데이트 (해당 시)

---

## Step 6: 파라미터 스윕 엔진 (난이도 중, 영향 높음)

**목적**: 30개 백테스트 파라미터 중 고영향 8개를 자동 탐색하여 최적 조합 발견.

### 현황

현재 백테스트 엔진(`src/backtest/engine.ts`)은 **단일 설정 1회 실행**만 지원.
파라미터 30개가 튜닝 가능하지만 조합 탐색 도구가 없어 수동 반복만 가능.

### 튜닝 가능한 30개 파라미터

**리스크 관리 (7개)**:
`maxRiskPerTrade(0.01)`, `maxDailyLoss(0.05)`, `maxDrawdownPct(0.30)`,
`recoveryPct(0.85)`, `maxConsecutiveLosses(3)`, `cooldownMinutes(30)`, `initialBalance(10)`

**게이트/필터 (5개)**:
`minBreakoutScore(50)`, `minBuyRatio(0.65)`, `minPoolLiquidity(50K)`,
`minTokenAgeHours(24)`, `maxHolderConcentration(0.80)`

**Strategy A — Volume Spike (7개)**:
`volumeMultiplier(3.0)`, `lookback(20)`, `tp1Multiplier(1.5)`, `tp2Multiplier(2.5)`,
`timeStopMinutes(30)`, `atrPeriod(20)`, `spreadFilterK(2.0)`

**Strategy C — Fib Pullback (11개)**:
`impulseMinPct(0.15)`, `impulseWindowBars(18)`, `fibEntryLow(0.5)`, `fibEntryHigh(0.618)`,
`fibInvalidation(0.786)`, `volumeClimaxMultiplier(2.5)`, `minWickRatio(0.4)`,
`atrPeriod(14)`, `tp1Multiplier(0.90)`, `tp2Multiplier(1.0)`, `timeStopMinutes(60)`

### 6A: 고영향 파라미터 그리드 서치

**파일**: `src/backtest/paramSweep.ts` (신규)

**스윕 대상 (8개, 결과 영향 최대)**:

| 파라미터 | 탐색 범위 | 단계 |
|---------|----------|------|
| `volumeMultiplier` | 2.0 ~ 4.0 | 0.5 (5단계) |
| `minBreakoutScore` | 40 ~ 70 | 10 (4단계) |
| `minBuyRatio` | 0.55 ~ 0.75 | 0.05 (5단계) |
| `tp1Multiplier` (A) | 1.0 ~ 2.0 | 0.25 (5단계) |
| `tp2Multiplier` (A) | 2.0 ~ 3.5 | 0.5 (4단계) |
| `maxRiskPerTrade` | 0.005 ~ 0.025 | 0.005 (5단계) |
| `impulseMinPct` (C) | 0.10 ~ 0.20 | 0.025 (5단계) |
| `tp1Multiplier` (C) | 0.80 ~ 0.95 | 0.05 (4단계) |

**전체 조합**: 5×4×5×5×4×5×5×4 = **200,000** (전수 탐색 시)
**실용 접근**: 2-Phase 탐색

```
Phase 1: Coarse sweep (각 3단계) → 3^8 = 6,561 조합
Phase 2: Fine sweep (Phase 1 top-10 주변 ±1 step) → ~2,000 조합
총: ~8,500 조합 × 0.05초/run ≈ 7분
```

**인터페이스**:
```typescript
interface SweepConfig {
  /** 탐색할 파라미터와 범위 */
  params: Record<string, { min: number; max: number; step: number }>;
  /** 최적화 대상 메트릭 */
  objective: 'sharpeRatio' | 'netPnlPct' | 'profitFactor' | 'custom';
  /** 최소 제약 (이 기준 미달 조합 제외) */
  constraints?: {
    minTrades?: number;      // 최소 거래 수 (과적합 방지)
    minWinRate?: number;     // 최소 승률
    maxDrawdownPct?: number; // 최대 허용 드로다운
  };
  /** 상위 N개 결과 반환 */
  topN: number;
}

interface SweepResult {
  rank: number;
  config: Partial<BacktestConfig>;
  metrics: {
    netPnlPct: number;
    winRate: number;
    sharpeRatio: number;
    profitFactor: number;
    maxDrawdownPct: number;
    totalTrades: number;
  };
}
```

**출력 예시**:
```
┌──────┬────────────┬────────┬───────┬─────────┬──────┬────────┐
│ Rank │ volMult    │ score  │ WR    │ Sharpe  │ PF   │ PnL%   │
├──────┼────────────┼────────┼───────┼─────────┼──────┼────────┤
│  1   │ 2.5        │ 45     │ 52.1% │ 1.23    │ 2.1  │ +34.2% │
│  2   │ 3.0        │ 50     │ 48.3% │ 1.18    │ 1.9  │ +28.7% │
│  3   │ 3.5        │ 55     │ 45.0% │ 1.15    │ 2.3  │ +25.1% │
└──────┴────────────┴────────┴───────┴─────────┴──────┴────────┘
```

### 6B: 과적합 방지 장치

| 장치 | 설명 |
|------|------|
| **최소 거래 수** | `constraints.minTrades ≥ 20` — 표본 부족 조합 제외 |
| **Walk-forward** | 전체 데이터를 70/30 분할. 70%에서 최적화 → 30%에서 검증 |
| **Cross-validation** | 3-fold time-series split (시간순 보장) |
| **Stability filter** | top-10 중 인접 파라미터 조합 성능 차이 > 50%면 제외 (날카로운 최적해 = 과적합) |
| **Penalty term** | `score = sharpe - 0.1 × abs(trades - median_trades)` — 극단 거래 빈도 벌점 |

### 6C: CLI 인터페이스

**파일**: `scripts/param-sweep.ts` (신규)

```bash
# Strategy A 파라미터 최적화
npx ts-node scripts/param-sweep.ts \
  --strategy volume_spike \
  --candles data/BONK-5m.csv \
  --objective sharpeRatio \
  --min-trades 20 \
  --top 10

# Strategy C + walk-forward 검증
npx ts-node scripts/param-sweep.ts \
  --strategy fib_pullback \
  --candles data/WIF-5m.csv \
  --objective profitFactor \
  --walk-forward 0.7 \
  --top 5

# 전 전략 combined 스윕
npx ts-node scripts/param-sweep.ts \
  --strategy combined \
  --candles data/BONK-5m.csv \
  --objective netPnlPct \
  --cross-validate 3 \
  --top 10
```

**출력**: 콘솔 테이블 + `results/sweep-{strategy}-{timestamp}.json` 저장

### 6D: 결과 리포터

**파일**: `src/backtest/sweepReporter.ts` (신규)

- Top-N 결과 테이블 (콘솔 + JSON)
- 기본값 대비 개선률 (%) 표시
- Walk-forward 결과: in-sample vs out-of-sample 비교
- 파라미터 민감도 히트맵 (각 파라미터별 메트릭 변화량)

---

## 구현 순서 및 의존 관계 (업데이트)

```
Step 1 (설정 가능화)       ← 최우선. 모든 후속 작업의 기반
  ├── 1A (Age Bucket)      ← 독립
  ├── 1B (Position Cap)    ← 독립
  ├── 1C (R:R 임계값)      ← 독립
  └── 1D (ABSOLUTE_MAX)    ← 독립

Step 2 (Age Bucket 완화)   ← Step 1A 이후
Step 3 (Concurrent 스케일)  ← Step 1D 이후
Step 4 (Kelly 보간)        ← 독립
Step 5 (유동성 적응)        ← Step 1B 이후
  ├── 5A (TVL 최소)        ← 독립
  └── 5B (Impact 축소)     ← 독립

Step 6 (파라미터 스윕)      ← 독립 (기존 엔진 활용, 변경 불필요)
  ├── 6A (Grid Search)     ← BacktestEngine 기반
  ├── 6B (과적합 방지)     ← 6A 이후
  ├── 6C (CLI)             ← 6A 이후
  └── 6D (리포터)          ← 6A 이후
```

**Step 6은 기존 BacktestEngine을 감싸는 래퍼**이므로 Step 1~5와 완전 독립.
Step 1~5 완료 후 스윕하면 최적화 대상 파라미터가 더 많아져서 효과 극대화.

---

## 예상 효과 (업데이트)

| 개선 | 컴파운딩 기여 | 타임라인 단축 |
|------|-------------|-------------|
| Age Bucket 완화 | 기회 exposure +40% | -15~20% |
| Concurrent 스케일 | 거래 빈도 +50% (5+ SOL) | -10~15% |
| Kelly 보간 | 드로다운 감소 → 중단 빈도↓ | -5~10% |
| 유동성 적응 | 대형 토큰 진입 → R:R 안정 | -10~15% |
| **파라미터 최적화** | **WR/R:R/Sharpe 개선** | **-10~25%** |
| **합산** | | **보수 시나리오 5~8개월 → 2~4개월** |

---

## 미구현/보류 사항

| 항목 | 이유 | 조건 |
|------|------|------|
| Kelly 1/4 → 1/2 복원 | 유동성 천장 해소 후에야 안전 | Proven + 100 trades + DD < 20% |
| maxConcurrent > 3 | 포트폴리오 분산 효과 미검증 | 50+ SOL + 라이브 데이터 |
| Strategy D (LP Sniper) | Jito 필수 + 별도 지갑 | VPS + Jito 인프라 완료 후 |
| X Filtered Stream | Bearer Token 미확보 | API 접근 확보 후 |
| Bayesian 최적화 | Grid search로 충분 (8개 파라미터) | 파라미터 15개+ 탐색 시 전환 |
| 실시간 파라미터 적응 | Paper 검증 선행 필요 | Paper 100+ trades 데이터 확보 후 |
