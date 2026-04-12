# STRATEGY_NOTES.md

> Status: forward strategy memo
> Updated: 2026-04-12
> Purpose: 현재 전략 구조의 한계 가설, v5 방향성, 다음 전략 질문을 분리 관리한다.
> Runtime quick ref: [`STRATEGY.md`](./STRATEGY.md)

## 2026-04-12 — Cupsey-Primary 전환 + Paper PnL Cost Deduction

### Cupsey-Primary 운영 전환

24시간 운영 로그 분석 결과에 따라 bootstrap → cupsey-primary로 전환:

- **bootstrap_10s**: 99 trades, +0.04 SOL, 26% WR, MFE(0.23%) < cost(0.31%) → 구조적 음의 기대값
- **cupsey_flip_10s**: 17 trades, +0.65 SOL, 59% WR → 명확한 알파 후보
- **핵심 관계**: cupsey는 bootstrap signal에 기생 — bootstrap trigger 없이 작동 불가

**방법**: `executionRrReject: 99.0`으로 bootstrap 실거래 100% gate 차단. signal 생성은 유지 (cupsey의 trigger source). 코드 1줄, env rollback 즉시 가능 (`EXECUTION_RR_REJECT=1.2`).

**추가**: `cupseyMaxConcurrent` 설정 이관 (하드코딩 3 → config), `CUPSEY_LANE_TICKET_SOL` env override 추가 (50-trade 합격 후 ticket 확대용).

### Paper PnL Cost Deduction 도입

**문제**: Paper 모드 PnL에 AMM fee/slippage/MEV 비용이 0% 반영 → 수익을 체계적으로 과대계상. bootstrap_10s가 +0.04 SOL (양수) 보고했으나 비용 차감 시 ~-0.01 SOL (적자) — gate 분석 "MFE < cost" 와 정합.

**수정**: 4개 exit path (closeTrade, TP1 partial, Runner B partial, Degraded exit)에 paper 모드 비용 추정 적용:
- Gate 통과 trade: `trade.roundTripCostPct` 사용 (사전 계산된 entry+exit impact+AMM+MEV)
- Cupsey/fallback: `defaultAmmFeePct + defaultMevMarginPct` = 0.45% (최소 보수 추정)
- **Live 모드: 변경 없음** — wallet balance delta에 모든 비용이 이미 포함

**영향**: Paper 모드 WR과 expectancy가 현실에 더 가까워짐. 기존에 borderline 양수였던 trade가 음수로 정정됨.

---

## 2026-04-08 — Exit 구조 적합성 미검증 메모

Codex의 exit 구조 진단(2026-04-08)에서 다음이 확인됐다.

- **구조의 철학은 정렬돼 있다.** SL 1.5×ATR(짧은 손실) + TP1 partial 30%(작은 부분 실현) + TP2 10×ATR runner(큰 winner 의존)는 "손실 짧게, 수익 길게" 명제와 정합한다.
- **그러나 live에서 작동 여부가 검증되지 않았다.** 2026-04-07T04:01Z~11:01Z 윈도 entry 기준 `0W / 4L`, `realized = -0.000509 SOL`. 큰 runner가 한 건도 잡히지 않았다.
- **TP1 30%는 명목 0.3R 실현.** 손실 1R을 상쇄하려면 win rate ≥ 77%가 필요하다 — 현재 표본에서 비현실적.
- **TP2 10×ATR은 sweep 최적 5×ATR에서 v5 runner-centric 확장.** Open Question(아래)에서 이미 `Live 50-trade 후 도달률로 판단` 으로 적혀 있었으나 표본 누적 전이다.
- **표본은 결론을 내릴 수 없는 크기다(n=4).** "구조가 틀렸다"가 아니라 "구조를 판단할 측정 인프라가 부족하다"가 정확한 진단.
- **현재 forbidden**: `tradingParams.ts:56-64` orderShape (`tp1Multiplier`, `tp2Multiplier`, `tp1PartialPct`, `realtimeSlAtrMultiplier`) 직접 변경 금지. Phase X2 측정 통과 전까지 lock.
- **next**: `docs/exec-plans/active/exit-structure-validation-2026-04-08.md` Phase X1 (Hygiene 누적) → Phase X2 (Distribution Audit, ≥20 clean closed trades) → Phase X3 (가설 옵션 분기). 측정 도구는 `scripts/analysis/exit-distribution-audit.ts`.
- **mission 정렬 한 줄**: 측정이 정직해진 이후의 데이터만 exit 구조 결정의 근거가 된다.

### Phase X2 v2 measurement gap (2026-04-08, n=18)

`exit-distribution-audit.ts` v2가 intent vs actual outcome cross-tabulation을 출력하기 시작한 후, 첫 audit (n=18, sample-gate 미달)에서 다음이 드러났다:

- **TP2 intent rate** (`exit_reason='TAKE_PROFIT_2'` 카운트): 55.6% (10/18)
- **Actual TP2 reach rate** (`exit_price ≥ take_profit2`): **0.0% (0/18)**
- **TP2 intent → actual TP2 match**: 0/10 = **0%**
- 10건의 TP2 intent 모두 swap latency 동안 price reverse → 실제 fill은 SL_OR_WORSE(5건) 또는 BELOW_ENTRY(5건)에서 체결됨

이것은 stamping bug가 아니다. 코드는 의도대로 동작한다 — `exit_reason`은 monitor loop가 발동시킨 *trigger intent*고 `exit_price`는 Jupiter swap의 *actual fill*이다. 두 값은 분리된 metric이며 메모코인 빠른 변동에서는 자주 어긋난다.

**함의**: 표본은 여전히 18 < 20이라 단정 금지이지만, 만약 누적 후에도 actual TP2 reach가 0%에 가깝다면 Phase X3 Scenario A 옵션 (`tp2Multiplier` 5.0 축소)만으로는 부족할 수 있다. Multiplier만 낮춰도 swap latency 동안의 price reverse 자체는 해결되지 않는다. 그 경우 exit *mechanism* 개선 (candle observation → tick observation, market sell → limit, sub-second monitoring)을 동반해야 하며 이는 본 plan의 Out of Scope로 분리됐다. 후보 plan: `exit-execution-mechanism-YYYY-MM-DD.md`.

지금은 측정 정직성만 확보됐다. 결정은 표본 누적 후로 미룬다.

## 2026-04-07 — 가격 정합성 회복 메모

CRITICAL_LIVE(`CRITICAL_LIVE.md` §7)의 Phase A/B/C1이 배포됐다. 전략 관점에서의 파급:

- **Pre-guard ledger는 전략 근거로 쓰지 말 것.** `buildEntryExecutionSummary` fallback mix, `alignOrderToExecutedEntry` 광적 증폭, `closeTrade` decision/fill 축 혼재가 복합 작용했을 가능성이 확인됐다. 2026-04-07 이전 closed trade의 `entryPrice / exitPrice / pnl`은 "축이 섞인 값"으로 간주하고, 전략 튜닝·edge 가설 평가에서 제외한다.
- **EdgeTracker 입력이 이제 sanitizer를 통과한다.** `planned/actual ratio [0.5, 2.0]` 밖이면 drop, `TP + 음수 PnL`도 drop. 기존에 `Pair blacklisted by edge tracker`로 막혔던 pair 중 일부는 sanitize 후 blacklist에서 빠질 가능성이 있다. 따라서 "blacklist가 옳다"는 판단을 재평가해야 한다. `ledger-audit --full-history`로 FLIPPED 목록을 먼저 확인한다.
- **새로운 baseline은 가드 이후 데이터로만 집계한다.** Open Questions의 `04-04 edge가 runner outlier인가` 질문은 pre-guard 데이터로 답해도 오염 위험이 있다. Phase C2 12h paper canary가 통과한 후의 trade set을 새 측정 기준점으로 고정한다.
- **전략 튜닝 동결.** Phase D(50-trade 동결) 기간 동안 bootstrap 파라미터/gate/risk rule을 건드리지 않는다. 측정 축이 안정화된 뒤에만 "signal 희소 vs 과잉" 같은 판단을 재시작한다.
- **mission 정렬 한 줄**: 측정이 정직해진 이후의 데이터만 `1 SOL → 100 SOL` 경로의 근거가 된다.

## Role

이 문서는 현재 runtime quick reference가 아니다.

- 현재 파라미터나 gate 순서를 확인할 때는 [`STRATEGY.md`](./STRATEGY.md)를 본다
- 이 문서는 왜 현재 구조가 그렇게 생겼는지와 다음 실험 질문을 기록한다
- 구현 완료 여부나 active execution work는 다루지 않는다

## Why v5 Exists

현재 Strategy A는 이미 움직인 뒤의 작은 ATR 움직임을 잡는 경향이 있었고,
Solana 밈코인 시장의 기대값은 소수의 fat-tail winner에서 나오는 경우가 많다.

그래서 현재 runtime은 아래 방향으로 정렬됐다.

- TP1 축소
- TP2 사실상 확장
- SL의 ATR 기준 정규화
- trailing을 TP1 이후로 지연
- execution RR을 TP2 기준으로 전환 (runner-centric 전략 정합)

## Current Strategic Thesis

- `effectiveRR` 문제는 단순 버그가 아니라 기존 구조의 한계를 gate가 드러낸 것일 수 있다.
- Strategy D는 장기적으로 더 mission-fit일 수 있지만, 아직 sandbox/live 검증이 부족하다.
- runner 중심 구조가 실제로 fat-tail을 포착하는지 계속 봐야 한다.

## Bootstrap Trigger Rationale

MomentumTrigger (core)는 3-AND (volume + 20봉 breakout + 3봉 confirm) 조건을 요구했으나,
live RejectStats에서 noBreakout=100%, confirmFail=100%로 signal 0을 생산했다.
밈코인 모멘텀은 1~2봉이면 끝나므로 3봉 confirm은 구조적으로 너무 늦다.

VolumeMcapSpikeTrigger (bootstrap)는 breakout/confirm을 제거하고 volume acceleration + buy ratio 2-gate만으로 발화한다.
Watchlist 내 토큰만 대상이므로 Mission Gate(설명된 진입 ≥90%) 위반 없음.

### 판단 보류 질문
- bootstrap trigger의 false positive rate가 실제로 어느 정도인가
- buy ratio threshold(`0.60` 운영 baseline / `0.55` code default)가 적절한가, 시장 상황에 따라 조정이 필요한가
- bootstrap → core 전환 시점을 무엇으로 판단할 것인가
- mcap enrichment (volumeMcapPct)가 gate/scoring에서 추가 활용 가능한가

### 2026-04-04 replay sweep 메모

5개 live 세션 replay + `estimated-cost-pct=0.003` + `gate-mode=stored` 기준:

- 안정형: `vm=1.8 / buyRatio=0.60 / lookback=20`
  - `762 signals`
  - fixed-notional 추정 `+10.0080 SOL`
  - `keep/5 = 5/5`
- 공격형: `vm=2.2 / buyRatio=0.60 / lookback=20`
  - `704 signals`
  - fixed-notional 추정 `+9.9625 SOL`
  - `keep/5 = 4/5`
- replay blacklist 반영형:
  - `34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb`
  - `82MmG1uH2BWLyoU7VCFYMohP9CT63q5paiKHAAAn3zWx`
  - `Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump`
  위 3종 제외 시 fixed-notional 추정 `+10.7871 SOL`

현재 해석:
- 운영 기본값은 안정형이 맞다
- 공격형은 짧은 canary 실험 후보로 유지한다
- replay blacklist는 runtime code path는 준비돼 있으므로, 운영 env의 `OPERATOR_TOKEN_BLACKLIST`로 반영해 live 검증을 시작한다

## Core Trigger Re-Challenge 기준 (P2-4a)

> 정의일: 2026-04-04 · 실행 시점: bootstrap 50+ trades 축적 후

MomentumTrigger (core)는 현재 standby 상태다. bootstrap이 충분한 baseline을 형성한 후
core를 재실험하기 위한 기준을 미리 정의한다.

### Bootstrap 유지 조건

core 재도전 전까지 bootstrap이 최소한 아래 기준을 만족해야 한다.

- EdgeState ≥ Calibration (20+ closed trades)
- WR ≥ 0.40
- Sharpe ≥ 0.3

위 조건 미달 시 bootstrap 자체의 파라미터 튜닝이 우선이며 core 실험을 시작하지 않는다.

### Core 재실험 전제

1. bootstrap 50+ closed trades 축적 (안정 baseline)
2. bootstrap WR/Sharpe/PF가 안정 기준선 이상
3. core 파라미터 수정 후보 3가지 이상 준비:
   - confirm bar 조건 완화 (3봉 → 1봉 또는 제거)
   - breakout lookback 축소 (20봉 → 10봉)
   - volume threshold 하향 (3.0x → 2.0x)

### A/B 비교 방법

- 두 trigger를 동시에 signal 생성하되, 실제 execution은 하나만 (bootstrap 우선)
- EdgeTracker에서 `bootstrap_10s`와 `core_momentum`을 분리 집계
- shadow signal로 core의 가상 PnL을 forward-observation으로 추적
- 최소 30 trades 비교 데이터 축적 후 판단

### Core 전환 판정 기준

아래 모든 조건을 만족하면 core를 active로 전환한다.

- 30+ trades (core shadow 기준)
- WR gap ≤ 5%p (core WR ≥ bootstrap WR - 5%)
- Sharpe ≥ bootstrap Sharpe
- 평균 R:R ≥ 1.5

### 롤백 조건

core 활성화 후 아래 중 하나라도 충족 시 즉시 bootstrap으로 롤백한다.

- WR < 0.25 (10 trades 이후)
- 연속 손실 ≥ 5
- Sharpe < 0
- daily halt 발동

## Replay Mode 해석 가이드

### 세 가지 replay 모드

| 모드 | 명령 | 특성 | 해석 |
|------|------|------|------|
| candle (default) | `--input-mode candles` | .jsonl의 non-zero candle + fillCandleGaps | dense-path price replay. Runtime 기대값 아님. |
| swap | `--input-mode swaps` | raw-swaps.jsonl → MicroCandleBuilder | Runtime에 가장 가까움. 단, inactive pair 미포함. |
| stored-gate | `--gate-mode stored` | 기존 gate 결과 적용 | 실제 execution 시뮬레이션에 가장 가까움. |

### Runtime과 Replay의 구조적 차이

1. **구독 범위**: Runtime은 ~168개 pair (active + inactive) 전부 evaluate.
   Replay는 data 파일에 있는 pair만 evaluate. → inactive pair의 sparseDataInsufficient는 replay에 없음.

2. **Candle 생성**: Runtime MicroCandleBuilder는 timer sweep으로 zero-volume synthetic candle 생성.
   Candle replay는 fillCandleGaps로 유사하게 복원하나, active pair가 100% non-zero이면 gap fill 없음.

3. **결론**: Replay 결과는 "active pair의 dense-path 가격 반응"만 보여줌.
   "Runtime에서 이만큼 벌 수 있다"가 아니라 "이 시장에서 price action이 trigger를 통과한 구간의 horizon outcome"으로 읽어야 함.

### 올바른 사용법

- trigger parameter 비교: replay 간 상대 비교에 사용 (absolute 기대값 아님)
- blacklist 후보 선별: per-token PnL 분석으로 반복 손실 token 식별
- gate 효과 검증: `--gate-mode off` vs `--gate-mode stored` 비교

---

## 2026-04-05 Replay-Loop 메모

4 sessions × 2 modes = 8 parallel backtests. 상세: [`results/replay-loop-report-2026-04-05.md`](./results/replay-loop-report-2026-04-05.md)

### Strategy A/C 5m Dormancy 확정

87 pairs × 3 strategies(A/C/combined) = 261 combination 중 **3건만 trade**.
300s candle 해상도에서 밈코인 모멘텀(10-30s)을 포착하는 것이 구조적으로 불가능.
파라미터 튜닝으로 해결 불가. bootstrap_10s가 이 시간대에 적합한 유일한 trigger.

**판단**: Strategy A/C → dormant. 향후 CEX/DEX 대형 토큰 전환 시에만 재활성화 고려.

### Sparse Data Insufficient (최대 병목, 81%)

Feature 4(zero-volume skip) 후유증. 전체 평가의 81%가 차단.
lookback window(20 bars × 10s = 200s) 내 연속 active candle 부족 시 거부.

### Edge 재현성 미검증

04-04 세션만 edgeScore 78 통과 (avgReturn +6.89%, MFE +34.4%).
나머지 3 세션은 edgeScore 8로 reject.
단일 세션 결과이므로 outlier runner token에 의한 과적합 가능성 존재.
per-token PnL 분해로 runner vs flat 비율 확인 필요.

---

## Open Questions

- **Sparse 81% 해소 후 edge가 다수 세션에서 재현되는가** (신규 최우선)
- **04-04 edge가 runner outlier인가 구조적 edge인가** (per-token 분해 필요)
- v5 구조만으로 Strategy A 기대값이 살아나는가
- detection timing을 더 앞당겨야 하는가
- Strategy D를 언제 main live 후보로 올릴 것인가
- runner hold가 실제로 다수 손실을 덮는 구조를 만드는가
- **TP2 10.0 vs 5.0**: sweep 최적 5.0 → v5 runner-centric 10.0 확장. config.ts 기본값은 10.0이나 검증 미완. Live 50-trade 후 TP2 도달률로 판단. 도달률 < 5%면 5.0 복원 검토.
- replay blacklist 후보가 live에서도 반복 손실 토큰인지
- ~~live actual-cost accounting 보정 후 DB PnL과 wallet PnL 차이가 얼마나 줄어드는지~~ **해소 (2026-04-12)**: paper 모드 PnL에 roundTripCostPct 차감 도입. Live는 이미 wallet delta 방식으로 비용 반영 확인됨
- **decision_price 계측 활성화 (04-06)**: TP2 종료인데 PnL 음수인 원인을 exitGap + rtCost로 분해 가능. Live 10건+ 수집 후 TP distance vs actual cost 점검 예정.

## Future: 소셜/온체인 인텔리전스 플랫폼 (Phase 4+)

> 기록일: 2026-04-02 · 도입 시점: Phase 3~4 (5+ SOL, 안정 수익 확인 후)

온체인 지표가 폭발하기 전에 소셜 바이럴/인물 언급을 미리 캐치하는 별도 인텔리전스 플랫폼 구상.
트레이딩 봇이 아닌 정보 수집·분석 시스템. 현재 봇의 EventMonitor/EventScorer 확장 형태로 점진 도입.

### 4개 핵심 모듈

1. **이벤트 캐치** — X/TikTok/뉴스/인플루언서 실시간 모니터링 → AI 스코어링 (0-100)
   - 데이터 소스: X(30-60s), TikTok 트렌딩(5m, 크립토 필터 없이 전체), 뉴스 RSS(5-10m)
   - 인플루언서 티어: S(Elon/CZ 즉시분석), A(Sam Altman/Vitalik), B(바이럴 시만)
   - 80점+: 상세 AI 리포트 + TG 긴급 알림 / 미만: 대시보드 피드만
   - 핵심: 비크립토 밈(67밈 등)이 밈코인 재료가 되므로 TikTok 전체 트렌딩 대상

2. **급변 사례 캐치** — 온체인 급변 감지 → 소셜에서 원인 자동 탐색
   - 대상: pump.fun → Pumpswap 마이그레이션 완료 코인
   - 감지: 5분 거래량 N배, 홀더 N명 급증, 가격 N% 상승 (시총 구간별 차등)
   - 워크플로: 온체인 이상치 → X에서 CA/티커 검색 → pump.fun 소셜링크 → 문맥 보고
   - 스캠 필터: 번들링(동일블록 다수지갑), 봇 패턴(Axiom/Photon/BananaGun)

3. **신규 코인 필터링** — pump.fun WebSocket → 러프 필터 → 1시간 추적 → AI 리서치 리포트
   - 필터: mcap 마일스톤, 홀더 최소치, 봇 비율 상한, 번들링 체크
   - 리포트: 테마/내러티브, 소셜 존재, 번들링 여부, 밈코인 재료 점수, 스캠 점수

4. **전체 코인 트래킹** — watchlist + 조건 알림 (mcap/가격 도달)
   - 향후: 거래량/홀더 급등, 인플루언서 언급, AI 이벤트 예측

### 웹 대시보드
- 단일 피드(시간순) + 모듈별 필터, WebSocket 실시간 업데이트
- Config UI에서 모든 임계치 실시간 조정, 데이터소스 상태 표시

### 도입 전략
- 기존 `EventMonitor`/`EventScorer` 모듈 확장 형태로 점진 도입
- Module 2(급변 사례 캐치)를 가장 먼저 연결 — 봇이 이미 온체인 급변을 감지하므로 소셜 원인만 추가
- 예상 공수: 풀 구현 8-12주 (1인 개발자 기준)

---

## One-Line Summary

> `STRATEGY_NOTES.md`는 현재 runtime이 왜 그런 형태인지와, 다음 전략 질문이 무엇인지를 분리해 적는 forward memo다.
