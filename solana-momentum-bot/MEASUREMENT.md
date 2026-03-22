# Measurement Framework

> Created: 2026-03-22
> Goal: 사명 달성도와 백테스트/페이퍼/라이브 결과를 같은 프레임으로 비교한다

---

## 왜 필요한가

현재는 아래가 섞여 있다.

- 사명: `1 SOL -> 100 SOL`
- 전략 원칙: 설명 없는 급등 추격 금지
- 운영 목표: 무인 paper/live 운영
- 백테스트 결과: PnL, WR, Sharpe, PF

이 상태로는 수익률이 좋아도 사명에 반하는 전략을 잘못 채택할 수 있다.

예:

- PnL은 양수인데 설명 없는 진입 비율이 높음
- Sharpe는 높지만 trades 수가 너무 적음
- 백테스트는 좋지만 paper에서 quote decay가 심함

따라서 평가는 3층으로 나눈다.

1. **Mission Score**: 사명/원칙에 맞는가
2. **Execution Score**: 실제 운영 가능한가
3. **Edge Score**: 통계적으로 기대값이 있는가

최종 의사결정은 이 3가지를 합친 **Composite Score**를 목표로 하되,
현재 구현 상태에서는 **Stage별로 측정 가능한 항목만 사용한 Stage Score**를 먼저 쓴다.

---

## Measurement Policy

### 정책 결정

이 문서는 **단계별 분리**를 기본 정책으로 한다.

| 단계 | 기본 점수 | 허용 범위 | 비고 |
|---|---|---|---|
| Backtest | `Edge Score` | `Mission/Execution = optional` | 현재 파이프라인은 Edge 중심 |
| Realtime Shadow | `Realtime Edge Score` | `Execution telemetry displayed separately` | trigger/outcome 계측 단계 |
| Paper | `Paper Stage Score` | `Mission/Execution/Edge 중 측정 가능한 항목만 반영` | 부분 Composite |
| Live | `Composite Score` | 전체 3축 필수 | 타겟 상태 |

### Target State 인정

현재 코드베이스는 `Mission Score`와 `Execution Score`의 모든 입력값을 자동 산출하지 않는다.
따라서 아래를 인정한다.

- **현재 상태(Current State)**: `Backtest = Edge 중심`, `Paper = 부분 Composite`
- **현재 상태(Current State)**: `Realtime Shadow = Edge-only score + execution telemetry`
- **목표 상태(Target State)**: `Live = full Composite`

### Stage Score 규칙

측정 불가능한 항목은 `0점`이 아니라 `N/A`로 둔다.

```text
Stage Score =
  (측정 가능한 항목의 가중합) / (측정 가능한 항목의 가중치 합)
```

예:

- Backtest에서 Mission/Execution 데이터가 없으면 `Edge Score = Stage Score`
- Realtime Shadow에서 현재 점수는 `Edge-only`이며, Execution은 별도 telemetry로만 본다
- Paper에서 일부 Execution telemetry가 없으면 나머지 항목만 정규화
- Live에서만 full Composite를 강제

---

## Level 1: Mission Score

사명 적합도 점수. 단순 수익보다 우선한다.

총점: 100

| 항목 | 배점 | 기준 |
|---|---:|---|
| 설명된 진입 비율 | 25 | source attribution 있는 trade 비율 |
| Context -> Trigger 일관성 | 20 | AttentionScore/Trigger/Gate path가 누락 없이 남는가 |
| 설명 없는 급등 추격 억제 | 20 | unexplained candidate 대비 진입 비율이 낮은가 |
| Safety discipline | 20 | TVL/age/holder/exit gate 위반 진입이 없는가 |
| Traceability | 15 | 후보 -> 게이트 -> 진입 -> 청산까지 역추적 가능한가 |

### Mission Gate

아래 중 하나라도 깨지면 전략은 채택하지 않는다.

| 항목 | 정량 기준 | 적용 단계 |
|---|---|---|
| 설명된 진입 비율 | 최근 `50 executed trades` 기준 `< 90%`면 실패 | paper, live |
| Source attribution completeness | 최근 `50 executed trades` 중 `source attribution missing > 0`이면 실패 | paper, live |
| Context -> Trigger 일관성 | 최근 `50 executed trades` 중 `AttentionScore / breakoutScore / gateResult / exitReason` 중 하나라도 누락된 trade 비율 `> 5%`면 실패 | paper, live |
| 설명 없는 급등 추격 억제 | 최근 `30일` 또는 `최근 100 unexplained candidates` 중 `unexplained -> executed conversion > 5%`면 실패 | paper, live |
| Safety bypass | 최근 `30일` 기준 `hard reject condition bypass count > 0`이면 실패 | paper, live |

Backtest에서는 Attention timeline / attribution 데이터가 없는 경우 Mission Gate를 `N/A` 처리한다.

---

## Level 2: Execution Score

실제 운영 가능성 점수. paper/live 전환 판단에 직접 사용한다.

총점: 100

| 항목 | 배점 | 기준 |
|---|---:|---|
| Quote quality | 20 | quote decay, sell impact, slippage 안정성 |
| Fill realism | 15 | paper 추정과 live 체결 괴리 정도 |
| Rejection quality | 15 | gate rejection이 일관되고 설명 가능한가 |
| Stability | 20 | 크래시/429/재연결 실패 없이 운용 가능한가 |
| Hold/exit quality | 15 | TP1/TP2/SL/time stop 분포가 전략 의도와 맞는가 |
| Automation readiness | 15 | 무인 운영 가능성, 수동 개입 필요도 |

### Execution Gate

| 항목 | 정량 기준 | 적용 단계 |
|---|---|---|
| Stability | 최근 `24h` 기준 `unhandled crash > 1` 또는 `uptime < 95%`면 실패 | paper, live |
| Risk enforcement | 최근 `30일` 기준 `daily loss halt` 또는 `drawdown guard` 미작동 사례 `> 0`이면 실패 | paper, live |
| Quote gate enforcement | 측정 구간 중 `quote gate disabled execution count > 0`이면 실패 | live |
| Quote quality | 최근 `20 measured trades` 기준 `median quote decay > 1.0%` 또는 `p95 > 2.0%`면 실패 | paper, live |
| Sell impact realism | 최근 `20 measured exits` 기준 `median sell impact > 1.5%` 또는 `p95 > 3.0%`면 실패 | live |
| Automation readiness | 최근 `24h` 기준 `manual intervention > 1회`면 실패 | paper, live |

위 조건이면 점수와 무관하게 보류한다.

### Realtime Shadow Execution Interpretation

realtime shadow 단계에서는 아래를 우선 본다.

| 항목 | 현재 사용 여부 | 비고 |
|---|---|---|
| Gate latency | 사용 | `avg/p50/p95` 집계 가능 |
| Signal-to-fill latency | 부분 사용 | 실제 체결이 없으면 `0` 또는 `N/A` |
| Processing status mix | 사용 | `executed_paper`, `gate_rejected`, `execution_viability_rejected` 등 |
| Admission block stats | 사용 | blocked pool 비율과 상위 blocked pool 확인 가능 |
| Quote decay / fill realism | 제한적 | live fill 전까지 partial |

따라서 realtime shadow는 아래처럼 해석한다.

- `Realtime Edge Score`: observed signal outcomes 기준의 Edge-only 점수
- `Execution telemetry`: gate latency, status mix, admission block, signal-to-fill latency

즉 realtime shadow의 현재 점수는 Execution을 합산하지 않는다.

---

## Level 3: Edge Score

전략 기대값 점수. 백테스트와 paper validation 모두 이 프레임으로 평가한다.

총점: 100

| 항목 | 배점 | 기준 |
|---|---:|---|
| Net PnL | 20 | 비용 반영 후 양수인가 |
| Expectancy | 20 | fees/slippage 포함 기대값 |
| Profit Factor | 15 | 1.3 이상 선호 |
| Sharpe | 15 | 변동성 대비 성과 |
| Max Drawdown | 10 | tier 한도 대비 안전한가 |
| Total Trades | 10 | 표본 충분성 |
| Positive Token Ratio | 10 | 여러 토큰에서 일관성 있는가 |

### Edge Gate

백테스트/페이퍼에서 아래 중 하나라도 만족하면 탈락 후보다.

| 항목 | 정량 기준 | 적용 단계 |
|---|---|---|
| Expectancy | `<= 0R` | backtest, paper, live |
| Net PnL | `<= 0%` | backtest, paper, live |
| Profit Factor | `< 1.0` | backtest, paper, live |
| Positive Token Ratio | `< 40%` | multi-token backtest |
| Total Trades | `< 20`이면 weak, `< 10`이면 fail | backtest |
| Paper sample size | `< 50 trades`면 live gate 불통과 | paper |

---

## Composite Score

최종 의사결정 점수. **Live 단계의 타겟 상태에서만 hard requirement**로 사용한다.

```text
Composite Score =
  Mission Score   * 0.40 +
  Execution Score * 0.25 +
  Edge Score      * 0.35
```

이유:

- 이 프로젝트의 핵심 엣지는 단순 차트 패턴이 아니라 `설명 가능한 후보 선별 + 게이트 + 실행` 조합이다.
- 따라서 Mission Score를 가장 높게 둔다.
- Edge가 좋아도 Mission/Execution이 낮으면 채택하지 않는다.

### 채택 기준

| Composite | 판단 |
|---:|---|
| `>= 80` | 채택 후보 |
| `70 ~ 79` | 조건부 채택, paper 추가 검증 |
| `60 ~ 69` | 파라미터 수정 후 재검증 |
| `< 60` | 폐기 또는 전략 재설계 |

추가 하드게이트:

- Mission Gate 실패 -> 즉시 탈락
- Execution Gate 실패 -> live 금지
- Edge Gate 실패 -> 파라미터/전략 탈락

---

## Backtest Parameter Scorecard

파라미터 스윕 결과는 아래처럼 기록한다.

| Strategy | Params | Trades | AvgExpR | AvgPnL | PF | Sharpe | MaxDD | +Token Ratio | Edge Score | Decision |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| volume_spike | `vm=3.5,tp1=2.0,tp2=3.5` | 53 | measured | 0.76% | 4.08 | 46.68 | 1.95% | 62.5% | recompute | keep |
| volume_spike | `vm=4.0,tp1=2.0,tp2=3.0` | 28 | measured | 0.97% | 5.86 | 3.13 | 1.30% | 50.0% | recompute | keep-watch |
| fib_pullback | `imp=0.10,tp1=0.85` | 14 | measured | 0.19% | 1.81 | -2.16 | 0.70% | 60.0% | recompute | weak |

주의:

- `Edge Score`는 위 표의 **측정 가능한 열만으로 재계산 가능해야 한다**
- 예시 값이 문서에 있더라도, 실제 의사결정은 최신 JSON/CLI 출력 기준으로 계산한다

### 현재 7일 스윕 기준 잠정 해석

- `volume_spike`가 `fib_pullback`보다 우세
- `volumeMultiplier`, `tp1`, `tp2` 민감도가 큼
- `minBreakoutScore`는 현 표본에서 민감도가 낮음
- 7일 데이터는 후보 압축용이고 최종 채택용은 아님

---

## Suggested Edge Score Mapping

백테스트 자동 스코어링용 권장 기준.

### 1. Net PnL (20점)

| 조건 | 점수 |
|---|---:|
| `<= 0%` | 0 |
| `0 ~ 0.5%` | 5 |
| `0.5 ~ 1.0%` | 10 |
| `1.0 ~ 2.0%` | 15 |
| `> 2.0%` | 20 |

### 2. Expectancy (20점)

| 조건 | 점수 |
|---|---:|
| `<= 0` | 0 |
| `0 ~ 0.1R` | 5 |
| `0.1R ~ 0.25R` | 10 |
| `0.25R ~ 0.5R` | 15 |
| `> 0.5R` | 20 |

### 3. Profit Factor (15점)

| 조건 | 점수 |
|---|---:|
| `< 1.0` | 0 |
| `1.0 ~ 1.29` | 5 |
| `1.3 ~ 1.79` | 10 |
| `1.8 ~ 2.49` | 13 |
| `>= 2.5` | 15 |

### 4. Sharpe (15점)

| 조건 | 점수 |
|---|---:|
| `<= 0` | 0 |
| `0 ~ 0.49` | 5 |
| `0.5 ~ 0.99` | 10 |
| `1.0 ~ 1.99` | 13 |
| `>= 2.0` | 15 |

### 5. Max Drawdown (10점)

| 조건 | 점수 |
|---|---:|
| `> 15%` | 0 |
| `10% ~ 15%` | 3 |
| `5% ~ 10%` | 6 |
| `2% ~ 5%` | 8 |
| `< 2%` | 10 |

### 6. Total Trades (10점)

| 조건 | 점수 |
|---|---:|
| `< 10` | 0 |
| `10 ~ 19` | 3 |
| `20 ~ 49` | 6 |
| `50 ~ 99` | 8 |
| `>= 100` | 10 |

### 7. Positive Token Ratio (10점)

| 조건 | 점수 |
|---|---:|
| `< 40%` | 0 |
| `40% ~ 49%` | 3 |
| `50% ~ 59%` | 6 |
| `60% ~ 69%` | 8 |
| `>= 70%` | 10 |

---

## Backtest Automation Rules

스윕 자동화는 아래 규칙을 사용한다.

- `edgeScore`: 위 `Suggested Edge Score Mapping`의 합계
- `backtestStageScore`: multi-token backtest에서는 측정 항목이 모두 있으므로 기본적으로 `edgeScore`와 동일
- `stageDecision`:
  - `reject_gate`: Expectancy/NetPnL/PF/Positive Token Ratio/Trade count 하드게이트 실패
  - `weak_sample`: `10 <= totalTrades < 20`
  - `keep`: `edgeScore >= 80`
  - `keep_watch`: `70 <= edgeScore < 80`
  - `retune`: `60 <= edgeScore < 70`
  - `reject`: `edgeScore < 60`

주의:

- `stageDecision`은 objective 정렬 결과와 별개다
- 예를 들어 `expectancyR` objective 상위라도 `Net PnL <= 0`이면 `reject_gate`가 될 수 있다

---

## Realtime Shadow Scorecard

realtime shadow 결과는 아래 표로 본다.

| Dataset | Signals | Executed | GateRejected | AvgAdjReturn(30s) | AvgMFE | AvgMAE | p95 Gate Latency | Realtime Edge Score | Decision |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `tmp/realtime-loop-live-20260322-163634` | 2 | 0 | 1 | 0.27% | 0.27% | -0.26% | 59ms | 50 | reject_gate |

현재 해석:

- runtime trigger/outcome 계측 경로는 검증 완료
- 현재 sample은 `2 signals`라서 전략 판단용으로는 약함
- stage decision이 `reject_gate`인 이유는 주로 `totalTrades<10`
- 위 표의 수익률과 점수는 `executed trades`가 아니라 `observed signal outcomes` 기준이다
- 따라서 지금 단계의 핵심은 `표본 축적`이지, 점수 해석 고도화가 아니다

### Realtime Automation Rules

realtime shadow 운영은 아래 규칙을 사용한다.

- 수집 실행: `scripts/realtime-shadow-runner.ts`
- dataset export: runner가 자동 수행
- summary JSON: `shadow-summary.json`
- telegram digest: `--telegram` 옵션으로 전송

권장 운영 기준:

| 조건 | 판단 |
|---|---|
| `signals < 10` | 점수 참고만, 의사결정 금지 |
| `10 <= signals < 50` | weak sample |
| `50 <= signals < 100` | 비교 가능, 아직 보수적 |
| `signals >= 100` | trigger density / rejection mix / avg return 해석 시작 |

실행 명령은 [OPERATIONS.md](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/OPERATIONS.md)의
`Realtime Shadow Operations` 섹션을 따른다.

---

## Paper Validation Scorecard

Paper는 아래와 같이 본다.

| 항목 | 기준 | 사용 문서 |
|---|---|---|
| 총 trades | `>= 50` | `docs/product-specs/paper-validation.md` |
| Win Rate | `>= 40%` | `docs/product-specs/paper-validation.md` |
| Expectancy | `> 0` | `docs/product-specs/paper-validation.md` |
| Max DD | tier 한도 내 | `docs/product-specs/paper-validation.md` |
| TP1 Hit Rate | `>= 50%` | `docs/product-specs/paper-validation.md` |
| 설명된 진입 비율 | `>= 90%` | `docs/product-specs/paper-validation.md` |

권장 운영 규칙:

- Backtest는 `Composite`가 아니라 `Edge Score` 또는 `Backtest Stage Score`만 사용
- 백테스트 점수가 높아도 paper 50 trades 검증 전 live 금지
- paper에서 Mission Score가 떨어지면 백테스트 우수 결과도 무효

---

## 운영 절차

### 1. 백테스트 단계

- 스윕 결과를 `Backtest Parameter Scorecard`에 기록
- 상위 3~5개 파라미터만 남김
- Edge Gate 실패 조합 제거

### 2. Paper 단계

- 상위 파라미터를 paper로 50 trades 검증
- Mission Score와 Execution Score 중심으로 재평가

### 3. Live 단계

- Composite `>= 80`
- Paper Validation 통과
- Execution Gate 문제 없음

---

## 현재 권장 해석

현재 7일 데이터셋은:

- 표본 수가 작고 토큰별 캔들 길이가 불균일함
- 따라서 **파라미터 후보 압축용**으로만 사용
- 현재 잠정 1순위는 `volume_spike`
- 최종 채택은 `30~90일 5m` 또는 paper 50 trades 이후 결정

즉:

```text
7일 스윕 = ranking
30~90일 스윕 = validation
paper 50 trades = go/no-go
```
