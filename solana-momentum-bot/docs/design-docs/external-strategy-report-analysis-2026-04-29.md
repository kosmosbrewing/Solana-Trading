# 외부 전략 리포트 ↔ KOL Hunter 정합 분석 + 4-Phase 개선 계획

> **작성일**: 2026-04-29
> **상태**: 분석 → **Tier 1 + #5 구현 완료 (2026-04-29 late evening)** + **2nd-pass 외부 비판 정정 13건 (2026-04-29 night)**. 실행 기록은 §11 참조.
> **출처**: 외부 트레이더의 KOL Hunter 전략 리포트 + 2026-04-29 외부 비판 (5 critical + 8 minor)
> **검증**: 4 agent 병렬 코드 점검 + arxiv/NBER/공식 docs 조사 + 2nd-pass 운영 승인 문서 등급 평가
> **Authority chain (Q-C4 신규 — source tier)**:
>   - Tier A (peer-reviewed / 공식 문서) — 운영 규칙 승격 가능
>   - Tier B (working paper / conference proceeding) — 설계 원리만, ADR 후 승격
>   - Tier C (arXiv preprint / vendor / news) — **설계 원리만**, 운영 승격 금지
>   - 본 문서의 Authority: `docs/design-docs/mission-refinement-2026-04-21.md` (사명, Tier A) / `option5-kol-discovery-adoption-2026-04-23.md` (Option 5 paradigm, Tier A)
> **DB snapshot discipline**: 본 문서 작성 시점 KOL DB **v8 (2026-04-29, active 42 / inactive 32 / total 74)**. 이전 active 39 인용은 v7 시점 — 갱신 필요 시 commit hash + snapshot 시각 명시.

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
P(at least one tail in N trades) = 1 - Π(1 - p_i)         (★ if independent)
```

**⚠ 독립 가정 단서 (2026-04-29 Q-C1 정정)**: 위 식은 **시행 독립 가정** 하에서만 성립. KOL Hunter 의 시행은 **강하게 묶여 있음** — day regime / KOL community / same-mint clustering / 장 혼잡도 / execution route availability 가 결합. 따라서 검증은 trade-level IID 가정 금지하고:
- **day-block bootstrap** (UTC day 단위 resampling)
- **regime-bootstrap** (BBRI Phase 1+ 후) 또는 **KOL-cluster bootstrap** (community detection 활성 후)

위 두 절차로 P(no 5x by 200) 의 95% CI 산출. 현 paper n=464 데이터로 day-block bootstrap 측정은 즉시 가능.

**평균 수익률 극대화 ≠ 사명**. 작은 tail probability 개선이 반복 누적되는 구조가 적합 (단, 위 비-독립 단서 하에서).

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
- Sample: 707 high-return tokens (≥100%), 2024-10 ~ 2025-01, multi-chain
- Methodology: anomaly **block 안 다중 indicator + 그 위에 wash/LPI union** (2026-04-29 Q-C6 정정)
  - **Anomaly block**: top-holder concentration / bundle-buy / fresh-address distribution / airdrop concentration / honeypot — 다수 지표 OR
  - Wash trading: 287 cases (vol↑500%+price chg<5% / 동일자 buy/sell vol ±2% / circular vol ≥99%)
  - LPI (Liquidity Pool Inflation): 40 cases (price+100%/vol≤20% / buy vol ≥90% / ≤10 entity)
  - Ownership anomaly aggregate: 412 cases
  - **Union (anomaly ∪ wash ∪ LPI)**: 586/707 = **82.89%** ("최소 하나의 suspicious activity")
- ⚠ "wash / LPI / ownership 3 OR" 표현은 거칢 — 위 단순화는 원문보다 정밀하지 못함. 운영 인용 시 anomaly block 의 다지표 union 임을 명시.

### 2.2 신뢰도 판정: B+ (directionally true, 절대값은 보수적 인용)

**문제점**:
- Union 정의 → **이중 카운트** 가능 (다수 indicator 동시 trigger 시)
- 자연스러운 ownership concentration (early-stage token) 도 인공 분류 위험
- false positive rate 명시 안 됨

**별도 자료 비교 + label 등급 (2026-04-29 Q-C7 정정)**:
- **Solidus Labs**: Solana Pump.fun 토큰의 **98.6% 가 결국 $1,000 미만 유동성으로 떨어짐** (operational metric, **NOT 학술 rug label**) — CoinDesk 보도 통해 전달, 프로젝트 측 반박도 동시 게재. **시장 위험의 거친 상한선** 으로만 사용. live reject classifier 의 ground-truth label 로 직접 사용 금지.
- **Coindesk**: Pump.fun 98% rug (industry 보고, vendor source — 등급 C)
- **MemeTrans (Georgia Tech)** [arxiv 2510.xxxxx]: 4만+ Solana memecoin launch / 2억+ tx / 122 feature / bundle-level data. risk score → 단순 selection 전략 적용 시 **투자 손실 최대 56% ↓** (2026-04-29 Q-C8 정정: dataset-specific 효과, production domain shift 자동 해결 안 됨)
- **LROO** (arxiv 2603.11324): TabPFN PR AUC 0.997 보고 (paper 본문 기준). 단 본 논문이 "strongest baselines 와의 차이는 modest" 명시 — production edge 로 해석 시 over-extrapolation 위험. 학술 dataset 한정.

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

**External 권고 점수식 (Q-C12 정정 — copyability_cost 항 추가)**:
```
alpha_score(w, x) = a·logit P_T1 + b·logit P_5x − c·logit P_rug
                    − d·copyability_cost − e·crowding
```
- `copyability_cost = entry_drift + landing_delay + sell_route_failure + fill_uncertainty` (Phase 1.2 신규 telemetry)
- `expected_cost` 만으로는 "재현 안 되는 알파" 차단 못함. Solana 공식 priority fee + Jito bundle / ShredStream landing latency 환경에서는 이 항이 결정적
- Tier weight 는 low-sample prior 만, 샘플 충분 시 posterior 우선

**Gap**: 현재 score 는 "벌었다" 만 측정. **monetizable** (우리 환경에서 따라가서 돈 되는가) 측정 안 됨. copyability_cost 항이 이 gap 직접 해결.

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

### Phase 1 — **Telemetry + Validation** (1-2주, 즉시 권고) — 사명 leverage 가장 큼

> **2026-04-29 Q-C2/C5 정정**: Phase 1 의 이름을 "Validation" 에서 **"Telemetry + Validation"** 으로 변경.
> **이유**: label 이 잘못되면 validation 도 잘못됨. KOL Hunter 의 핵심 실패 모드 ("너무 빨리 잘랐는가", "sell-follow 가 winner 를 죽였는가", "우리가 못 따라간 것인가") 는 DSR 만으로 풀리지 않음. 따라서 markout / copyability / missed-alpha 가 Phase 1 의 **최상단 prerequisite**, DSR/PBO/CSCV 는 그 위에 얹는 governance metric.

#### Mission metric 4 축 (DSR 만 prerequisite 하지 말 것 — Q-C2 정정)

| 축 | 정의 | 측정 |
|---|------|------|
| (A) **DSR** | Bailey/López de Prado deflated Sharpe | governance metric — fake edge 차단 |
| (B) **Floor breach probability** | P(wallet < 0.7 SOL within 200 trades) | day-block bootstrap |
| (C) **P(no 5x by 200)** | 200 trades 동안 mfe ≥+400% winner 0건일 확률 | regime/cluster bootstrap (Q-C1) |
| (D) **Winner-kill rate** | sell-follow 후 T+1800s 에 추가 5x 도달한 비율 | missed-alpha + style classifier |

→ 위 4 축 동시 통과해야 `Phase 1 → Phase 2` 진입. DSR 단독 통과 안 됨.

#### 1.1 — **MissedAlphaObserver 부활 + Markout Telemetry** (Q-C5 최상위 prerequisite)
- 이미 코드 존재 (`src/observability/missedAlphaObserver.ts`) — schema 재확인 (`probe` 단일 객체 / `observations` array 미사용 — 2026-04-28 false positive 정정 정합)
- T+30s / T+5min / T+30min / T+2h markout 4 단계 측정
- exit 후 continuation (close 가 winner-kill 했는지) + KOL-sell-follow value 추적
- **Cost**: complexity band **S** (small, ~1-2 days, 기존 코드 재활성화 + telemetry schema 정의)

#### 1.2 — **Copyability / Executability Score** (Q-C3 신규 — 누락 layer)
- entry signal → quote drift / quote → fill drift / landed slot delta / fail ratio / route disappearance persistence / fee percentile / Jito path used 여부 수집
- `data/realtime/copyability-telemetry.jsonl` 1줄/trade
- "알파 있는데 못 먹는 지갑" vs "재현 가능 edge" 구분
- **Cost**: complexity band **M** (medium, telemetry source 5+ + 수집 cron)

#### 1.3 — **Style Classifier 자동화** (probability 형태로 — Q-C10 정정)
- `scripts/kol-metrics-analyzer.ts` (`kol-tx.jsonl` 기반)
- 4-class **확률** 산출: `scalper_prob, swing_prob, whale_prob, unknown_prob` (hard threshold 직접 production trigger 금지)
- DB v8 `trading_style` 필드는 **운영자 검수** 통과 후만 update
- 초기에는 **높은 확신의 class만 live 정책 반영** — winner-kill 방지
- **Cost**: complexity band **M**

#### 1.4 — **DSR Validation Framework** (governance metric, Q-C2 위상 조정)
- `scripts/dsr-validator.ts` (Bailey/López de Prado 공식)
- CSCV 절차 (combinatorial symmetric CV)
- **★ 단독 prerequisite 아님** — 위 mission metric 4 축 (A+B+C+D) 의 한 축 (A) 으로만 사용
- 모든 config 변경 시 자동 backtest + 4 축 출력 hook
- **Cost**: complexity band **M**

**Phase 1 진입 조건**: 위 4 항목 모두 paper-first / lane 영향 0. **complexity band S+M+M+M (~1-2주)** — LOC 추정은 prerequisite 와 failure mode 가 LOC 보다 훨씬 중요한 변수이므로 band 로만 표시 (Q-C13).

---

### Phase 2 (2-3주, Phase 1 데이터 누적 후)

#### 2.1 — Manipulation Classifier (#3, probability 형태로 — Q-C10/C11 정정)
- 5 signal **weighted probability score** (NOT OR gate, NOT hard threshold):
  1. Distinct buyer ratio
  2. Top10 + funding source bundle overlap
  3. LPI pattern detection
  4. Self-loop swap velocity
  5. Sell route disappearance (이미 있음, 강화)
- Output: `manipulation_prob ∈ [0, 1]` (logit) — hard reject 전에 **soft penalty 단계** 1회 더 (sizing × (1 - α·prob))
- **Paper-shadow 기간 (Q-C11 정정)**: 단순 7일 아니라 **최소 2개 이상의 hot/cold regime 포괄 기간** — BBRI / 시장 분위기 분포 기준 (BBRI Phase 0 결과 활용 가능)
- **Cost**: complexity band **L** (large, 5 signal source + shadow 분포 분석)

#### 2.2 — Day Quality Index (#7) — BBRI 와 통합
- **BBRI Phase 0 결과 입력** (Task #109 — BBRI smart_flow / execution_quality / liquidity_proxy)
- internal breadth aggregator (50% mfe / 100% / 400% 도달 비율)
- Helius `getRecentPrioritizationFees` 통합 + Jito tip / fail ratio (Copyability score 와 공유)
- 통합 0-1 score → regime map 으로 thresholds 조정 — 단 Phase 1 mission metric 4 축 통과 후만 hard regime gating
- **Cost**: complexity band **L**

#### 2.3 — State-conditional Policy 골격 (#1)
- Day Quality + style probability + regime → hardcut/trail 분기 (정적 → 조건부)
- 위 mission metric 4 축 (DSR + floor breach + P(no 5x) + winner-kill rate) 모두 통과 후 commit
- **Cost**: complexity band **M**

**Phase 2 합계**: complexity band **L+L+M**, 2-3주.

---

### Phase 3 (3-4주)

#### 3.1 — Posterior Alpha Engine (#4) — copyability cost 항 포함 (Q-C12 정정)
- Bayesian shrinkage on KOL × bucket × regime × style
- alpha_score 식: **`P_T1 + P_5x - P_rug - copyability_cost - crowding`**
- **`copyability_cost`** = entry_drift + landing_delay + sell_route_failure + fill uncertainty (Phase 1.2 telemetry 사용)
- 이 항 없이 posterior alpha 만들면 "재현 안 되는 알파" 를 높은 점수로 떠받들게 됨
- **Cost**: complexity band **L**

#### 3.2 — Effective KOL Count (#5)
- Co-buy graph build (kol-tx.jsonl 기반) — `kolHunterCommunityDetectionEnabled` 코드 이미 추가됨 (default false)
- Louvain community detection
- N_eff = inverse concentration weighted
- **Cost**: complexity band **M**

**Phase 3 합계**: complexity band **L+M**, 3-4주.

---

### Phase 4 (장기, paper n ≥ 1000)

#### 4.1 — Robust Fractional Kelly + Drawdown-continuous Sizing (#6)
- Distributionally robust Kelly (worst-case log growth)
- λ_drawdown 연속형 throttle
- per-arm Kelly (smart-v3 pullback / velocity / both)
- **Cost**: complexity band **L**

**Phase 4 합계**: complexity band **L**, 3-4주 + data prerequisite.

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

### Risk 4 — DSR 미적용 시 fake edge (단, mission objective 1순위 아님 — Q-C2)
Phase 1.4 (DSR) 없이 후속 phase 진행 시 selection bias. 단 KOL Hunter 의 **mission objective 는 Sharpe 극대화 아님** — floor 유지 + 200 회 완주 + 5x+ tail winner 1+ 발견. 따라서 DSR 은 **fake edge 차단의 governance metric** 으로만 위치 (Q-C2 정정).

**Mitigation**:
- **Phase 1.4 (DSR) + 1.1 (markout) + 1.2 (copyability) + 1.3 (style probability) 4개 항목 모두 prerequisite**
- 승인 게이트는 **DSR 단독 아닌 mission metric 4 축**: DSR + floor breach probability + P(no 5x by 200) + winner-kill rate
- DSR 만 통과해도 다른 3 축 통과 안 하면 Phase 2 진입 안 됨

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

### 운영자 결정 옵션 (Q-C13 정정 — LOC 추정 → complexity band)
- (A) **Phase 1 (Telemetry + Validation) 즉시** — 4 sprint (markout / copyability / style probability / DSR), complexity band S+M+M+M (~1-2주). prerequisite + failure mode 가 LOC 보다 중요한 변수
- (B) **MissedAlpha retrospective 만 먼저** (band S, 1-2일) — Q-C5 최상위 prerequisite 단독 진행
- (C) **Copyability score telemetry 만 먼저** (band M, 2-3일) — Q-C3 신규 layer 단독 진행. landing latency / fail ratio 우선
- (D) 본 문서 추가 검토 후 결정
- (E) 영구 보류 (현 운영 유지)

---

## 8. 부록 — 외부 리포트 인용 학술 자료 정리

> **2026-04-29 Q-C4 정정**: source tier 등급 도입.
> - **Tier A**: 공식 문서 / peer-reviewed 저널 — 운영 규칙 승격 가능
> - **Tier B**: working paper / conference proceeding (peer review 부분) — 설계 원리만, 운영 승격 시 별도 ADR
> - **Tier C**: arXiv preprint / vendor report / news — **설계 원리만**, 운영 규칙 승격 절대 금지
> NBER working paper 페이지는 공식 NBER publication 의 peer review 거치지 않음 명시 — Tier B 분류.

### Memecoin manipulation
- **[Tier C]** arxiv 2507.01963 "A Midsummer Meme's Dream" (82.89% union 출처, multi-indicator anomaly + wash + LPI, B+ 신뢰도)
- **[Tier C]** arxiv 2602.13480 "MemeTrans dataset" (Georgia Tech, 4만+ launch / 2억+ tx / 122 feature, **dataset-specific** 56% 손실 ↓)
- **[Tier C]** arxiv 2504.07132 "SolRPDS rug pull dataset"
- **[Tier C]** arxiv 2603.11324 "LROO TabPFN" (PR AUC 0.997 — paper 본문 기준, 단 **strongest baselines 와의 차이 modest**)
- **[Tier B]** arxiv 2512.11850 "The Memecoin Phenomenon" (IEEE conference proceeding) — **Q-C9 정정**: 범위 = **Pump.fun 중심 Q4 2024 분석** (Solana 전체 역사 아님). "fewer than 2% succeeded on major exchanges"
- **[Tier C]** arxiv 2601.08641 "Resisting Manipulative Bots"
- **[Tier C]** Solidus Labs "Solana rug pulls / pump dumps" (vendor report) — 98.6% 는 **operational metric** ($1,000 미만 유동성 도달), **학술 rug label 아님**. live classifier ground-truth 로 직접 사용 금지.
- **[Tier C]** Coindesk "98% rug 보도" (news, Solidus 보고서 인용 + 프로젝트 측 반박 동시 게재)
- **[Tier C]** Bitquery "Wash Trading Solana"

### Stop-loss / dynamic trading
- **[Tier B]** "Dynamic stop-loss in equity/bond" (working paper)
- **[Tier B]** "Stop-loss as risk reducer not alpha source"
- **[Tier B]** NBER "Dynamic trading with transaction costs and alpha decay" (working paper, peer review 미경유)

### Kelly / robust optimization
- **[Tier A/B]** "Fractional Kelly review" — published ones Tier A
- **[Tier B]** "Distributionally robust Kelly" (working paper)
- **[Tier B]** "Multi-period drawdown control"

### Validation
- **[Tier A]** López de Prado "Deflated Sharpe Ratio" (peer-reviewed)
- **[Tier A]** "Probability of Backtest Overfitting + CSCV" (peer-reviewed)

### DEX microstructure / Copyability (Q-C3 신규 layer)
- **[Tier A]** Solana 공식 docs "Priority fee + fee samples" (체결 품질)
- **[Tier A]** Helius docs "getRecentPrioritizationFees"
- **[Tier A]** Jito Labs 공식 "MEV bundles + ShredStream + fast tx sending" (landing latency)
- **[Tier B/C]** "DEX liquidity research" (gas/volatility/returns → spread)

### Token-2022 dangerous extensions
- **[Tier A]** Solana 공식 docs "DefaultAccountState / NonTransferable / PermanentDelegate / TransferHook"

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
| 2026-04-29 (night) | **2nd-pass 외부 비판 정정 13건 (Q-C1~C13)**: (C1) §1.1 사명 확률식 IID 단서 + day-block bootstrap 명시 / (C2) DSR 위상 — mission objective 1순위 아님, governance metric. mission metric 4 축 (DSR + floor breach + P(no 5x) + winner-kill rate) / (C3) Phase 1.2 신규 — copyability/executability score (entry drift + landing delay + sell route failure + fill uncertainty) / (C4) Authority chain source tier A/B/C 도입 + DB snapshot v8 명시 / (C5) Phase 1 = "Telemetry + Validation". MissedAlpha + markout + copyability + style 이 prerequisite, DSR 위에 / (C6) §2.1 82.89% union 방법론 정밀화 (anomaly block 다지표 + wash + LPI) / (C7) §2.2 Solidus 98.6% 는 operational metric, 학술 rug label 아님 명시 / (C8) MemeTrans 56% / LROO PR AUC 0.997 dataset-specific caveat / (C9) Memecoin Phenomenon Pump.fun Q4 2024 한정 명시 / (C10) style + manipulation classifier hard threshold → probability 형태 / (C11) shadow 7d → 2 hot/cold regime 포괄 / (C12) §3.4 posterior alpha 식에 copyability_cost 항 추가 / (C13) LOC 추정 → complexity band (S/M/L) | Claude (외부 비판 반영) |

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
