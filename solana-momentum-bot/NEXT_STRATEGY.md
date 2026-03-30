# NEXT_STRATEGY.md — 전략 고도화 방향

> Created: 2026-03-31
> Purpose: 현재 Strategy A의 구조적 한계 분석 + "수익은 길게, 손실은 짧게" 원칙 기반 고도화 설계
> Related: `PLAN4.md`, `20260331.md`, `docs/product-specs/strategy-catalog.md`

---

## Part 1. 사명 달성을 위한 전략 재평가

### 현재 봇이 노리는 것과 실제 100x가 발생하는 곳이 다르다

현재 봇은 **"이미 발견된 토큰의 작은 ATR 움직임"**을 잡으려 한다.
- GeckoTerminal trending / dex_boost에 올라온 시점 → 초기 2-5x는 이미 끝남
- ATR(20) × 1.5 TP1 → 수% 움직임 목표
- roundTripCost 0.65%가 그 수%를 대부분 잡아먹음

Solana DEX에서 100x가 실제로 일어나는 곳은 **fat-tail**이다:
- 대부분의 토큰은 -50~-100% (러그/소멸)
- 극소수가 10x, 50x, 100x+
- **기대값은 소수의 극단적 승리에서 나옴**

### 만약 다시 설계한다면

**Phase 1: 1 → 5 SOL (생존 + 씨앗 확보)**

| 요소 | 현재 | 변경 |
|------|------|------|
| 발견 시점 | GeckoTerminal trending (늦음) | **new pool creation event** (LP 생성 직후) |
| 진입 | volume_spike 후 breakout 확인 | **LP 생성 후 1-5분 내** safety check 통과 시 즉시 |
| 사이즈 | 1% fixed risk | **0.5-1% risk** (작게, 많이) |
| TP | ATR × 1.5 (수%) | **2x~3x entry** (100-200%) |
| SL | candle.low | **-30% hard stop** (넓게) |
| 핵심 필터 | effectiveRR ≥ 1.2 | freeze authority=NO, LP burned/locked, mint authority revoked |

이 구조의 논리:
- 10건 중 7건은 -30% → 총 -2.1% (0.5% risk × 7 × 60% 실현)
- 10건 중 2건은 +100% → 총 +1.0%
- 10건 중 1건은 +500% → 총 +2.5%
- **소수의 승리가 다수의 패배를 덮는 구조** (= crypto alpha의 실제 모양)

**Phase 2: 5 → 30 SOL (검증된 edge 복리)**

- Phase 1에서 실측한 승률/RR로 Kelly fraction 계산
- 검증된 토큰 프로파일(mcap 범위, 유동성, 출처)에 집중
- 동시 포지션 2-3개로 확대
- 일일 손실 한도 5% 유지

**Phase 3: 30 → 100 SOL (보수적 스케일링)**

- 사이즈가 커지면 slippage가 문제 → TVL 높은 풀만 대상
- TP 배수를 낮추되 승률을 올림
- Phase 1-2의 edge가 살아있는지 지속 검증

### 현재 아키텍처에서 가장 가까운 전략

**Strategy D (New LP Sniper)**가 위 방향에 가장 가깝다.
- 이미 paper 모드로 동작 중 (로그 확인됨)
- 다만 live 미검증

| 전략 | 1→100 가능성 | 현재 상태 |
|------|-------------|----------|
| **Strategy A** (현재 live) | **낮음** — 작은 움직임 + 높은 비용 = 구조적 음수 EV | effectiveRR gate에 막혀 체결조차 불가 |
| **Strategy D** (new LP sniper) | **상대적으로 높음** — fat-tail 포착 가능 | paper 모드, live 미검증 |
| **Strategy E** (cascade) | 중간 — TP1 후 runner 확장 | 테스트 단계 |

### Strategy A의 근본 문제

volume_spike breakout은 "이미 움직인 뒤"를 잡는다. 그 시점에서 ATR 기반 수% 타겟은 비용 대비 보상이 구조적으로 부족하다. **effectiveRR < 1.2는 버그가 아니라 전략의 본질적 한계를 gate가 정확히 감지한 것**일 수 있다.

사명 달성을 위해서는:
1. Strategy A의 파라미터 튜닝보다 **Strategy D를 live로 올리는 것**이 더 직접적
2. 또는 Strategy A의 **발견 시점을 앞당기는** 근본적 변경이 필요
3. **넓은 SL + 높은 TP 배수 + 낮은 사이즈**의 비대칭 구조가 crypto alpha의 실제 모양

---

## Part 2. "수익은 길게, 손실은 짧게" 적용 설계

### 현재 구조 vs 원칙

| 원칙 | 현재 봇 | 문제 |
|------|---------|------|
| **손실은 짧게** | SL=candle.low, TimeStop 30분 | trailing이 SL/TimeStop보다 먼저 잡아서 12/12 trailing 청산 |
| **수익은 길게** | TP1=ATR×1.5, **TP2=ATR×3.5 (상한)** | TP2가 상한을 걸어서 10x, 50x 움직임을 원천 차단 |

**핵심 모순**: 수익에 cap(ATR×3.5)을 걸면서 손실은 trailing으로 조기 실현하고 있음. 원칙의 **정반대**다.

### 개선안 1. 손실은 짧게 — "안 되면 빨리 인정"

| 항목 | 현재 | 제안 |
|------|------|------|
| SL | candle.low (거리 가변) | **entry - ATR(20) × 1.0** (일정한 risk 단위) |
| TimeStop | 30분 | **15~20분** (빠른 판정) |
| Break-even | 없음 | **TP1 도달 시 잔여분 SL → entry** (무위험화) |
| 조기 trailing | 2봉 후부터 활성화 | **TP1 도달 전에는 trailing 비활성화** |

효과: 손실 trade의 holding time 단축, 잃는 금액 축소

### 개선안 2. 수익은 길게 — "되면 끝까지"

| 항목 | 현재 | 제안 |
|------|------|------|
| TP1 | ATR×1.5 (50% 청산) | **ATR×1.0** (더 자주 도달, 30% 청산) |
| TP2 | ATR×3.5 (100% 청산) | **제거 또는 ATR×10** (상한 사실상 없음) |
| Runner trailing | ATR(7) fixed | **ATR(20) × 1.5** (넓게, 큰 움직임 허용) |
| 잔여분 관리 | TP2에서 전량 청산 | **30% TP1 청산 → 70% runner** (trailing만으로 청산) |

효과: 5x, 10x 움직임이 오면 실제로 탑승 가능

### 개선안 3. effectiveRR gate 연동

현재 effectiveRR은 **TP2 기준**으로 계산된다:
```
effectiveRR = max(rewardPct - cost, 0) / (riskPct + cost)
rewardPct = (TP2 - entry) / entry   <- ATR×3.5
```

TP2를 제거/확대하면 rewardPct가 비현실적으로 커져서 gate가 무의미해진다.

**변경: effectiveRR을 TP1 기준으로 전환**
```
rewardPct = (TP1 - entry) / entry   <- ATR×1.0
riskPct   = (entry - SL) / entry    <- ATR×1.0
-> raw RR ~ 1.0, 비용 차감 후 ~0.85
-> 기준값도 1.2 -> 0.8 등으로 하향 조정 필요
```

TP1 기준 RR은 "최소한 이만큼은 벌어야 비용을 커버한다"는 의미이고, 실제 수익은 runner에서 fat-tail로 만드는 구조.

### 수학적 기대값 구조

```
1 trade = 1% risk

손실 시: -1% (SL 또는 TimeStop)
TP1 시:  +0.7% (30% 청산 x ATR×1.0, 비용 차감)
Runner:  잔여 70%가 trailing로 2x~10x 구간까지 보유

10건 중 시나리오:
  6건 loss:   -6.0%
  3건 TP1:    +2.1%
  1건 runner: +7~15% (3x~5x 움직임의 70%)
  -> 기대값: +3~11% per 10 trades
```

**핵심: 승률이 40%가 아니어도 1건의 runner가 전체를 양수로 만드는 구조**

### 구현 범위

```
변경 파일 (예상):
src/strategy/volumeSpikeBreakout.ts   <- TP1/TP2/SL 배수 변경
src/gate/executionViability.ts         <- TP1 기준 RR 전환 + 기준값 하향
src/execution/tradeExecution.ts        <- trailing 활성화 조건 (TP1 이후만)
src/execution/positionMonitor.ts       <- runner trailing width 변경
src/risk/riskManager.ts               <- break-even SL 로직
tests/                                 <- 회귀 테스트 업데이트
```

### 검증 순서

1. **backtest 먼저** — 변경 파라미터로 기존 데이터 재검증
2. **paper 카나리아** — live 전 paper 모드로 50건
3. **live 카나리아** — paper 통과 후 live 전환

---

## Decision Log

| 날짜 | 결정 | 근거 |
|------|------|------|
| 2026-03-31 | Strategy A의 한계는 파라미터가 아니라 구조 | effectiveRR < 1.2는 gate가 전략 한계를 감지한 것 |
| 2026-03-31 | "수익 길게, 손실 짧게" 원칙 적용 결정 | 현재 구조가 원칙의 정반대 (수익 cap, 손실 조기 실현) |
| 2026-03-31 | effectiveRR gate를 TP1 기준으로 전환 검토 | TP2 제거 시 기존 gate 무의미화 방지 |
| 2026-03-31 | Strategy D (LP sniper)를 장기적으로 live 후보로 평가 | fat-tail 포착에 가장 적합한 기존 전략 |
