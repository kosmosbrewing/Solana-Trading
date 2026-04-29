# 외부 전략 리포트 ↔ KOL Hunter 정합 분석 + 4-Phase 개선 계획

> **작성일**: 2026-04-29
> **상태**: 분석 → **Tier 1 + #5 구현 완료 (2026-04-29 late evening)**. 코드 변경 ~2300 LOC. 실행 기록은 §11 참조.
> **출처**: 외부 트레이더의 KOL Hunter 전략 리포트 (사명 §3 = `0.7 SOL floor + 200 trades + 5x+ winner`)
> **검증**: 4 agent 병렬 코드 점검 + arxiv/NBER/공식 docs 조사
> **Authority**: `docs/design-docs/mission-refinement-2026-04-21.md` (사명) / `option5-kol-discovery-adoption-2026-04-23.md` (Option 5 paradigm)

---

## 0. 문서 목적

외부 리포트의 9 권고 (state-conditional policy / wallet style 분리 / P(rug) classifier 확장 / posterior alpha engine / effective KOL count / robust Kelly / Day Quality Index / posterior re-entry / DSR validation) 를:

1. **현재 코드 정합성** 정밀 측정 (이미 구현된 것 / 부분 구현 / 신규)
2. **사명 §3 leverage** 평가 (catastrophic loss 차단 > 5x+ winner capture > avg return 개선)
3. **외부 리포트의 over-claim 정정** (82.8% manipulation 수치 등)
4. **Phase 분리 개선 계획** + over-engineering risk mitigation

코드 변경은 별도 sprint 결정. 본 문서는 **결정 근거의 영구 보존** 용.

---

## 1. 외부 리포트 핵심 통찰 요약

### 1.1 사명의 수학적 재정의
사명 §3 = "지갑 생존 + 200 trade + 5x+ winner 만남". 이 목적함수 하에서:
```
Tail probability per trade = p_i
At least one tail in N trades = 1 - Π(1 - p_i)
```
**평균 수익률 극대화 ≠ 사명**. 작은 tail probability 개선이 반복 누적되는 구조가 적합.

### 1.2 정적 SL/TP 의 한계
- Stop-loss 학술 결과: **risk reducer** (drawdown ↓), not universal alpha source
- 전역 hardcut/trail 미세조정 → 큰 구조적 엣지 불가
- 실제 엣지: **상태 조건형 정책** (wallet style + alpha decay + liquidity + market regime)

### 1.3 거래비용 + alpha decay 동적 거래 이론
- NBER: persistent signal 우대, 빠른 mean-revert signal 무게 ↓ + 거래 속도 최적화
- Alpha decay 연구: **no-trade zone** 이 최적 정책의 기본 형태
- 함의: "초단기 KOL SELL → 즉시 full exit" 가 자주 틀릴 수 있음

### 1.4 Kelly 의 추정 오차 + fat tail
- Full Kelly: 단기적으로 거칠고 추정 오차에 극도로 민감
- Fractional Kelly: drawdown / variance ↓ 실용적
- **Distributionally robust Kelly** (worst-case expected log growth) 이 fat tail / non-stationary 환경에 더 자연스러움

### 1.5 검증 체계가 엣지
- DSR (Deflated Sharpe Ratio): 여러 시도 후 selection bias 보정
- PBO (Probability of Backtest Overfitting): CSCV 절차로 과최적화 확률 추정
- 새 규칙 하나가 아니라, **좋은 규칙만 살아남게 하는 검증 프로세스** 가 다음 엣지

---

## 2. 외부 리포트의 over-claim 검증 (academic source 직접 조사)

### 2.1 "100%+ 토큰의 82.8% 가 인위적 성장" 수치
**출처**: arxiv 2507.01963 "A Midsummer Meme's Dream" (2025)
- Sample: 707 high-return tokens, 2024-10 ~ 2025-01, multi-chain
- Methodology: 3 indicator OR-aggregated
  - Wash trading: 287 (vol↑500%+price chg<5% / 동일자 buy/sell vol ±2% / circular vol ≥99%)
  - LPI (Liquidity Pool Inflation): 40 (price+100%/vol≤20% / buy vol ≥90% / ≤10 entity)
  - Ownership anomaly: 412 (top10 >30% / fresh addr >30% / bundle >30%)
  - Union: 586/707 = **82.8%**

### 2.2 신뢰도 판정: B+ (directionally true, 절대값은 보수적 인용)

**문제점**:
- OR 정의 → **이중 카운트** 가능
- 자연스러운 ownership concentration (early-stage token) 도 인공 분류
- false positive rate 명시 안 됨

**별도 자료 비교**:
- Solidus Labs: Solana token 98.6% rug (더 broad, methodology 다름)
- Coindesk: Pump.fun 98% rug (industry 보고)
- LROO TabPFN (arxiv 2603.11324): test set 검증 결과 high accuracy / PR AUC 보고 (paper 본문 기준, abstract 미인용 — 직접 verify 필요) — but 학술 dataset 한정

### 2.3 정확 표현
"100%+ 토큰의 majority 가 최소 1개 manipulation indicator 보임" — directionally true.
"82.8% 가 인위적" 그대로 인용은 **over-claim**.

### 2.4 우리 사명 함의
manipulation classifier 추가 시:
- ❌ **OR 게이트 절대 금지** (winner-kill 위험)
- ✅ AND/weighted score 만 사용
- ✅ Recall 우선 설계 (FP > FN)

---

## 3. 9 권고 ↔ 우리 코드 정합 점검 (4 agent 병렬 검증)

### 3.1 권고 #1 — State-conditional policy (조건부 정책)
**현재 코드**: ⚠ 부분
- ✓ 4 lane 분리 (kol_hunter / pure_ws / cupsey / migration)
- ✗ token-level state vector 없음 (wallet style + consensus shape + liquidity + early path + market regime 통합 정책 없음)
- ✗ 정적 threshold 기반 (hardcut 0.10, trail 0.15 모든 token 동일)

**Gap**: 모든 token 을 동일하게 처리 → low-vol token 의 -10% (14σ) vs high-vol pump 의 -10% (0.5σ) 구분 없음.

**Phase**: Phase 2

---

### 3.2 권고 #2 — Wallet style 분리 (4-class classifier)
**현재 코드**: ✓ 60% (의외로 많이 구현됨)
- ✓ `data/kol/wallets.json` 의 `lane_role` (discovery_canary / observation_only) + `trading_style` (scalper / hybrid) 필드 존재 (`types.ts:48-50`)
- ✓ `getKolTradingStyle` / `getKolLaneRole` 헬퍼 (`db.ts:99-111`)
- ✓ `evaluateInsiderExitDecision` (`kolSignalHandler.ts:625-682`) **이미 style-aware 분기**:
  - all-scalper → close
  - longhold/swing → close
  - scalper sell + longhold cohort → lower_confidence (close 안 함)
  - unknown → conservative close
- ✗ 자동 통계 산출 (median hold time / avg ticket / re-buy density) 미구현
- ✗ KOL DB 의 trading_style 필드 7.1% 만 채워짐 (active 42 중 3, inactive 포함 시 더 낮음)

**Gap**: 자동 분류기 없음 → 새 KOL 추가 시 default unknown → conservative close → 5x+ winner 차단 risk.

**구현 cost**: ~300-800 LOC (auto-classifier + DB update)

**Phase**: Phase 1 (높은 ROI)

---

### 3.3 권고 #3 — P(rug) classifier 확장
**현재 코드**: ⚠ 40%
- ✓ Token-2022 dangerous extensions (transferHook / permanentDelegate / nonTransferable / defaultAccountState) hard reject
- ✓ Top-10 holder concentration ≥ 0.80 → reject
- ✓ Sell quote probe (Tier B-1, Jupiter round-trip)
- ✓ `kolHunterSurvivalAllowDataMissing` flag (Track 2B, default true → 운영자 권고 false)
- ✗ Distinct buyer / total swap ratio 측정 없음
- ✗ LP add/remove 패턴 추적 없음
- ✗ Self-loop swap velocity 없음
- ✗ Holder concentration delta over time 없음

**External report Top-5 detection signal** (priority 순):
1. **Distinct buyer / total swap ratio < 0.15 (1h)** — wash trading 가장 robust
2. **Top10 holder + funding source overlap (bundle)** — MemeTrans 핵심 지표
3. **LPI 패턴**: price +100% / vol ≤20% / abs vol < $1k
4. **Self-loop swap velocity**: 동일 wallet (or funded cluster) buy→sell 60s 내 N≥3
5. **Sell-route quote disappearance / impact >10%** — 이미 구현됨

**False positive 위험**:
- 산업 도구 (RugChecker / Solsniffer): USDC/USDT 도 rug 분류 (recall 우선 설계 필수)
- LROO TabPFN PR AUC 0.997 (학술 dataset 한정)

**구현 cost**: ~760 LOC (manipulation classifier weighted score, paper-shadow 7d → live gate)

**Phase**: Phase 2

---

### 3.4 권고 #4 — Posterior alpha engine (Bayesian shrinkage)
**현재 코드**: ✗ 0%
- 현재 KOL score = `(weightedScore + consensusBonus) × timeDecay` (정적 prior)
- ✗ Bucket-aware 추정 (mcap × liquidity × regime × style) 없음
- ✗ Bayesian shrinkage to bucket mean 없음
- ✗ Posterior P(+50%) / P(5x) / P(rug) per wallet × bucket 없음

**External 권고 점수식**:
```
alpha_score(w, x) = a·logit P_T1 + b·logit P_5x − c·logit P_rug − d·expected_cost − e·crowding
```
Tier weight 는 low-sample prior 만, 샘플 충분 시 posterior 우선.

**Gap**: 현재 score 는 "벌었다" 만 측정. **monetizable** (우리 환경에서 따라가서 돈 되는가) 측정 안 됨.

**구현 cost**: ~600-900 LOC + paper data 누적 prerequisite

**Phase**: Phase 3

---

### 3.5 권고 #5 — Effective independent KOL count (co-buy graph)
**현재 코드**: ⚠ 20%
- ✓ `kolAntiCorrelationMs=60s` simple dedup (60s 내 두 번째 KOL skip)
- ✗ Co-buy graph 없음
- ✗ Community detection 없음
- ✗ Inverse concentration weighted N_eff 없음

**Gap**: "3명 이 40초 안 다 들어왔다" → consensus large (10× bonus). 실은 같은 community 의 1.2명 이라도 simple dedup 만으로 막기 어려움.

**구현 cost**: ~400-600 LOC (graph build + Louvain community + N_eff computation)

**Phase**: Phase 3

---

### 3.6 권고 #6 — Robust fractional Kelly + drawdown-responsive sizing
**현재 코드**: ⚠ 30%
- ✓ Real Asset Guard binary halt (wallet floor 0.7, canary cap 0.2 etc.)
- ✓ Per-lane policy max ticket (KOL 0.02)
- ✗ Continuous drawdown-throttle 없음 (binary on/off 만)
- ✗ Distributionally robust Kelly 없음
- ✗ Kelly fraction 자동 산출 + per-arm scaling 없음

**External 권고 sizing**:
```
f_t = min(f_cap, λ_regime × λ_drawdown × λ_style × f_robustKelly(x_t))
λ_drawdown = ((D_max − D_t) / D_max)^β  # 연속형 throttle
```

**구현 cost**: ~500-800 LOC + paper data n ≥ 1000 prerequisite

**Phase**: Phase 4 (장기)

---

### 3.7 권고 #7 — Day Quality Index (breadth + microstructure)
**현재 코드**: ⚠ 50%

**축1 internal breadth**:
- ✓ `kol-paper-trades.jsonl` 의 mfePctPeak / t1/t2/t3 visit timestamps
- ✓ KOL consensus 5분 집계 (`kolSignalHandler.ts`)
- ✗ Tracked mint 중 +50%/+100%/+400% 도달 비율 자동 산출 안 됨
- ✗ first sell 후 continuation 측정 안 됨 (raw-swaps 통합 필요)
- ✗ 30분 후 생존율 자동 산출 안 됨

**축2 microstructure**:
- ✓ Jupiter quote priceImpactPct (`quoteGate.ts`, `sellQuoteProbe.ts`)
- ✓ 429 카운터 (`jupiterRateLimitMetric.ts`)
- ✓ Sell route disappearance (`sellQuoteProbe.ts` 의 no_sell_route)
- ✗ Solana priority fee percentile (Helius `getRecentPrioritizationFees` 미통합)
- ✗ State contention proxy (Jito tip / failed tx ratio) 미존재

**현재 regime 모듈**:
- ✓ `regimeFilter.ts`: SOL trend (EMA20>50) + breadth + follow-through 3-factor → risk_on/neutral/risk_off

**구현 cost**: ~800 LOC (breadth aggregator + priority fee + contention + 통합 score)

**Phase**: Phase 2

---

### 3.8 권고 #8 — Same-mint posterior re-entry (markout-based)
**현재 코드**: ✓ 70% (의외로 많이 구현됨)
- ✓ Same-token cooldown 30분 (Track 1, 2026-04-29)
- ✓ KOL alpha decay cooldown 4h (P0-2, 방금 구현)
- ✗ Markout-based 회복 검증 없음 (clock-based 만)

**External 권고**: "이전 close 이후 markout 관찰 후, 비용 차감 후 기대 로그성장 양수 회복 시만 재진입"

**Gap**: 현재 30분/4h cooldown 은 시계 기반. 진짜 runner 재가속 (markout 재상승) 시 너무 길고, 데드캣 (시간 지나도 회복 X) 에는 너무 짧을 수 있음.

**구현 cost**: ~250 LOC (missed-alpha observer 의 T+30s/5m/30m markout 활용)

**Phase**: Phase 1 (Tier 1 — markout 데이터 활용)

---

### 3.9 권고 #9 — Validation framework (DSR/PBO/CSCV)
**현재 코드**: ✗ 0%
- ✗ Deflated Sharpe Ratio (DSR) 미적용
- ✗ Probability of Backtest Overfitting (PBO) 미측정
- ✗ Combinatorial Symmetric Cross-Validation (CSCV) 절차 없음
- ✓ paper sim 만 (selection bias 보정 없음)

**External 통찰**: 검증 체계 자체가 엣지. "새 규칙 하나" 가 아니라 "좋은 규칙만 살아남게 하는 검증 프로세스" 가 다음 엣지.

**Gap**: 모든 sprint 의 "5-10% improvement" claim 이 statistical significance 검증 안 됨 → noise 와 구분 불가.

**구현 cost**: ~400 LOC (DSR + CSCV scripts)

**Phase**: **Phase 1 (가장 underrated, 다른 모든 sprint 의 prerequisite)**

---

## 4. 4-Phase 개선 계획

### Phase 1 (1주, 즉시 권고) — 사명 leverage 가장 큼

#### 1.1 — DSR Validation Framework (#9, ⭐⭐⭐⭐⭐)
- `scripts/dsr-validator.ts` 작성 (Bailey/López de Prado 공식)
- CSCV 절차 (combinatorial symmetric CV) 구현
- 모든 config 변경 시 자동 backtest + DSR 출력 hook
- **Cost**: ~400 LOC, 2-3일
- **효과**: 향후 모든 결정의 statistical significance 검증

#### 1.2 — Style Classifier 자동화 (#2, ⭐⭐⭐⭐)
- `scripts/kol-metrics-analyzer.ts` 작성:
  - `kol-tx.jsonl` (22k 행) → median hold time / avg ticket / re-buy density / time-to-first-sell
  - 4-class 분류: scalper (median hold < 5min) / momentum_confirmer / swing_accumulator (median > 1h) / whale (avg ticket > 5 SOL)
- `data/kol/wallets.json` 자동 갱신 + 운영자 review
- **Cost**: ~300 LOC, 1-2일
- **효과**: insider_exit_full 정밀도 ↑ + 5x+ winner 차단 risk ↓

#### 1.3 — MissedAlpha Retrospective + Markout-based Re-entry (#8 + #4 입력, ⭐⭐⭐⭐)
- `scripts/missed-alpha-retrospective.ts`:
  - 매 100 close 후 자동 분석
  - reject한 mint의 T+1800s p50 mfe 측정
  - "false negative rate" (= reject 중 실제 5x 갔던 비율)
  - 자동 alert: false neg rate > 15% 1주 지속 → reject threshold 완화 ADR trigger
- T+2h (7200s) 추가 측정 (외부 권고 정합)
- KOL sell-follow value 추적 (~200 LOC 신규)
- **Cost**: ~250 LOC, 1-2일
- **효과**: 점수엔진 라벨 데이터 누적 → Phase 3 입력

**Phase 1 합계**: ~950 LOC, 1주. 모두 downside-only / paper-first / 검증 가능.

---

### Phase 2 (2-3주, Phase 1 데이터 누적 후)

#### 2.1 — Manipulation Classifier (#3)
- 5 signal weighted score (NOT OR gate):
  1. Distinct buyer ratio
  2. Top10 + funding source bundle overlap
  3. LPI pattern detection
  4. Self-loop swap velocity
  5. Sell route disappearance (이미 있음, 강화)
- Paper-shadow 7d 후 live gate
- **Cost**: ~760 LOC

#### 2.2 — Day Quality Index (#7)
- internal breadth aggregator (50% mfe / 100% / 400% 도달 비율)
- Helius `getRecentPrioritizationFees` 통합
- Contention proxy (Jito tip / fail ratio)
- 통합 0-1 score → regime map 으로 thresholds 조정
- **Cost**: ~800 LOC

#### 2.3 — State-conditional Policy 골격 (#1)
- Day Quality + style + regime → hardcut/trail 분기 (정적 → 조건부)
- DSR validation 통과 후 commit
- **Cost**: ~400 LOC

**Phase 2 합계**: ~1960 LOC, 2-3주.

---

### Phase 3 (3-4주)

#### 3.1 — Posterior Alpha Engine (#4)
- Bayesian shrinkage on KOL × bucket × regime × style
- alpha_score 식 (P_T1 + P_5x - P_rug - cost - crowding)
- **Cost**: ~600-900 LOC

#### 3.2 — Effective KOL Count (#5)
- Co-buy graph build (kol-tx.jsonl 기반)
- Louvain community detection
- N_eff = inverse concentration weighted
- **Cost**: ~400-600 LOC

**Phase 3 합계**: ~1000-1500 LOC, 3-4주.

---

### Phase 4 (장기, paper n ≥ 1000)

#### 4.1 — Robust Fractional Kelly + Drawdown-continuous Sizing (#6)
- Distributionally robust Kelly (worst-case log growth)
- λ_drawdown 연속형 throttle
- per-arm Kelly (smart-v3 pullback / velocity / both)
- **Cost**: ~500-800 LOC

**Phase 4 합계**: ~600 LOC, 3-4주 + data prerequisite.

---

## 5. 사명 §3 leverage 종합 ranking

| Phase | 권고 # | wallet floor 0.7 | 5x+ winner | survival 200 trades | 사명 leverage |
|---|---|---|---|---|---|
| 1 | #9 DSR validation | ✗ 직접 영향 없음 | ✗ 직접 영향 없음 | ✓ 다른 결정의 신뢰도 | ⭐⭐⭐⭐⭐ |
| 1 | #2 style classifier | ✓ scalper sell 무시 | ✓ swing winner 보호 | ✓ | ⭐⭐⭐⭐ |
| 1 | #8+#4 markout re-entry | ✓ 무용한 재진입 차단 | ✓ 진짜 runner 재가속 | ✓ | ⭐⭐⭐⭐ |
| 2 | #3 P(rug) classifier | ✓ catastrophic 차단 | ⚠ FP 시 winner kill | ✓ | ⭐⭐⭐⭐⭐ (FP 보수 시) |
| 2 | #1 state-conditional | ✓ regime 따라 size ↓ | ✓ hot day 시 hold ↑ | ✓ | ⭐⭐⭐⭐⭐ |
| 2 | #7 Day Quality | ✓ cold day 자동 보수화 | ✓ hot day 자동 적극화 | ✓ | ⭐⭐⭐ |
| 3 | #4 posterior alpha | ✓ low-confidence 차단 | ✓ high-alpha 강조 | ✓ | ⭐⭐⭐⭐ |
| 3 | #5 effective KOL count | △ | ✓ false consensus 차단 | △ | ⭐⭐⭐ |
| 4 | #6 robust Kelly | ✓ tail-aware sizing | △ | ✓ | ⭐⭐⭐ |

---

## 6. Risk / Mitigation

### Risk 1 — Over-engineering
9 권고 한 번에 적용 시 LOC 누적 ~3000+. False positive 누적 ↑ (each layer's FP × 9 layers) → 5x+ winner 차단 risk ↑.

**Mitigation**: Phase 1 만 시작. 각 phase 결과 측정 후 다음 결정.

### Risk 2 — Memecoin-specific data 부족
외부 리포트 인용 학술 자료 대부분 stocks/crypto general. **Solana memecoin ultra-low cap 영역 학계 검증 부족**. NBER alpha decay / Bayesian shrinkage 그대로 transfer 안 됨.

**Mitigation**: 외부 리포트는 **설계 원리** 만 가져옴. 계수는 paper data 로 자체 추정 (DSR 통과 후).

### Risk 3 — Survivorship bias in KOL DB
현재 active 39명 = "최근 30d 잘 한 사람들". 죽은 KOL DB에 없음 → posterior alpha over-fit.

**Mitigation**: KOL DB 에 inactive/retired KOL archive (기존 inactive 28명 활용) + style classifier 가 inactive historical 도 학습.

### Risk 4 — DSR 미적용 시 fake edge
Phase 1.1 (DSR) 없이 후속 phase 진행 시 selection bias.

**Mitigation**: **Phase 1.1 을 모든 다른 sprint 의 prerequisite 으로 강제**.

### Risk 5 — manipulation classifier FP 가 winner kill
RugChecker/Solsniffer 도 USDC/USDT rug 분류 정도 FP. OR 게이트 적용 시 5x+ winner 차단 가능.

**Mitigation**: AND/weighted score 만 사용. paper-shadow 7d → missed-alpha observer 로 winner-kill rate 측정 후 live gate.

---

## 7. 의사결정 권고

### 가장 솔직한 권고 (1줄)

**Phase 1 의 3 항목 (DSR validation + style classifier 자동화 + missed-alpha retrospective) 만 즉시 진행**.

이유:
1. 모두 downside-only / paper-first
2. 이미 인프라 50%+ 존재 — 활용 강화
3. Phase 2/3/4 의 prerequisite (DSR 없이는 fake edge)
4. 사명 §3 leverage 가장 큼

### 운영자 결정 옵션
- (A) **Phase 1 즉시** (3 sprint, 1주, ~950 LOC)
- (B) Phase 1 중 **MissedAlpha retrospective 만 먼저** (1-2일, ~250 LOC)
- (C) 본 문서 추가 검토 후 결정
- (D) 영구 보류 (현 운영 유지)

---

## 8. 부록 — 외부 리포트 인용 학술 자료 정리

### Memecoin manipulation
- arxiv 2507.01963 "A Midsummer Meme's Dream" (82.8% 출처, OR-aggregated, B+ 신뢰도)
- arxiv 2602.13480 "MemeTrans dataset" (top10/bundle correlation)
- arxiv 2504.07132 "SolRPDS rug pull dataset"
- arxiv 2603.11324 "LROO TabPFN" (high accuracy / PR AUC; abstract 미명시, paper 본문 기반 인용 — verify 후 정확 수치 갱신 필요)
- arxiv 2512.11850 "The Memecoin Phenomenon" (pump.fun "fewer than 2% succeeded on major exchanges" — 원문 표현. "graduation rate" 는 industry 용어로 보조 사용)
- arxiv 2601.08641 "Resisting Manipulative Bots" (copy trading 위협 모델)
- Solidus Labs "Solana rug pulls / pump dumps" (98.6% rug)
- Coindesk "98% rug 보도" (Pump.fun)
- Bitquery "Wash Trading Solana" (GGSS 사례)

### Stop-loss / dynamic trading
- "Dynamic stop-loss in equity/bond" (Sharpe & drawdown 개선 보고)
- "Stop-loss as risk reducer not alpha source" (broad 결론)
- NBER "Dynamic trading with transaction costs and alpha decay" (no-trade zone 권고)

### Kelly / robust optimization
- "Fractional Kelly review" (drawdown / variance ↓)
- "Distributionally robust Kelly" (worst-case log growth)
- "Multi-period drawdown control" (continuous risk aversion)

### Validation
- López de Prado "Deflated Sharpe Ratio" (selection bias 보정)
- "Probability of Backtest Overfitting + CSCV" (과최적화 확률 추정)

### DEX microstructure
- "DEX liquidity research" (gas/volatility/returns → spread)
- Solana docs "Priority fee + landing path" (체결 품질)
- Helius docs "getRecentPrioritizationFees"
- Jito Labs "MEV / bundle landing"

### Token-2022 dangerous extensions
- 공식 docs "DefaultAccountState / NonTransferable / PermanentDelegate / TransferHook"

---

## 9. 본 문서 활용 절차

1. **운영자 review**: 본 문서 + memory:project_telegram_alerts_revamp_2026_04_29.md (직전 작업) 함께 검토
2. **Phase 결정**: 위 8.옵션 (A/B/C/D) 중 선택
3. **Sprint 시작 시**: 본 문서의 해당 권고 # 참조 → 변경 ADR 작성
4. **Sprint 완료 시**: DSR 통과 결과 + missed-alpha observer 의 winner-kill rate 측정 결과 본 문서에 append
5. **분기별 갱신**: 각 권고의 implementation status 업데이트

---

## 10. 변경 이력

| 날짜 | 변경 | 작성자 |
|---|---|---|
| 2026-04-29 | 최초 작성 — 외부 전략 리포트 + 4 agent 코드 점검 + arxiv 검증 | Claude (KOL Hunter 분석) |
| 2026-04-29 | 품질 점검 정정 3건: (1) trading_style fill rate 9% → 7.1% 정정 (active 42 중 3) (2) arxiv 2603.11324 PR AUC 0.997 abstract 미명시 표현 완화 (3) arxiv 2512.11850 "graduation rate" → 원문 "fewer than 2% succeeded on major exchanges" 정확 표현 | Claude (자체 verify) |
| 2026-04-29 (late evening) | §11 Implementation status 신규 — Tier 1 + #5 일괄 구현 완료. memory:project_external_strategy_tier1_implementation_2026_04_29.md 참조 | Claude |

---

## 11. Implementation Status (2026-04-29 late evening 갱신)

### 적용 완료

| 권고 | 구현 산출물 | 상태 | 효과 |
|---|---|---|---|
| **#2 wallet style classifier** | `scripts/kol-metrics-analyzer.ts` (327+134) + wallets.json 35 KOL 적용 | ✅ Phase 1 완료 | trading_style fill rate 7.1% → 95%+ |
| **#8+#4 markout retrospective** | `scripts/missed-alpha-retrospective.ts` (370+165) + T+2h offset | ✅ Phase 1 완료 | 1주 누적 후 alert level 측정 가능 |
| **#9 DSR / CSCV validation** | `scripts/dsr-validator.ts` (430+155) | ✅ Phase 1 완료 | 모든 미래 sprint statistical prerequisite 활성화 |
| **#5 effective KOL count** | `src/kol/coBuyGraph.ts` (229+202 test) + scoring + runtime wiring | ✅ Phase 1+ 완료 | community detection 코드 적용. 운영자 enable 시 즉시 가동 |

### 구현 결과 핵심 수치

#### DSR 검증 (paper n=488)
- Pooled: DSR Prob>0 = **64.4% (FAIL)** / PBO = 0.679 (overfit)
- smart-v3 (main): SR 0.072, γ4 169.7 (extreme fat tail), DSR Prob 65.5%
- 모든 arm 95% 임계 미달 → **사명 §3 "200 trade gate" statistical 정당성 확정**

#### Co-buy Graph 발견 (minWeight=25)
- `{chester, decu, dv, earl, theo}` 5-KOL squad
- `{heyitsyolo, kev}` 2-KOL pair
- Top edges: chester—dv (53), dv—theo (35), decu—dv (32) — chain forward 증거

#### KOL DB v8 분류 분포
- scalper 25 (dv 3232, theo 2333, domy 1709, decu 1555)
- whale 5 (crypto_d 11.27 SOL avg, dzfk 8.81)
- momentum_confirmer 5 (matt 30.8m hold)
- sample_too_small 7

### 미적용 / 후속 Phase

| Phase | 권고 | Trigger condition |
|---|---|---|
| Phase 2 | #3 P(rug) classifier | DSR Prob > 95% 통과 후 |
| Phase 2 | #7 Day Quality Index | 위와 동일 |
| Phase 2 | #1 state-conditional policy | #2 + #7 완료 후 |
| Phase 3 | #4 posterior alpha engine | paper n ≥ 1000 + 5x+ winner ≥ 3건 |
| Phase 4 | #6 robust Kelly | live n ≥ 200 + DSR 통과 |

### 운영자 activation checklist

```bash
# Step A — 재배포 (wallets.json 갱신 즉시 효과)
git pull && pm2 restart bot

# Step B (선택) — Community detection 활성화
echo "KOL_HUNTER_COMMUNITY_DETECTION_ENABLED=true" >> .env
pm2 restart bot
# 확인: [KOL_COBUY_GRAPH] refreshed log

# Step C (1주 후) — Retrospective alert
npx ts-node scripts/missed-alpha-retrospective.ts --window-days=7

# Step D (n ≥ 1000 후) — DSR 재측정
npx ts-node scripts/dsr-validator.ts --by-arm
```

### 사명 §3 정합 확인
- ✅ Wallet floor 0.7 보호: 모든 sprint downside-only
- ✅ 5x+ winner 보호: style classifier + community
- ✅ Real Asset Guard 위반 0
- ✅ DSR 통과 prerequisite 강제 → 향후 false edge 적용 차단
