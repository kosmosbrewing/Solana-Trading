# HYPOTHESES.md — 가설 원장 (단일 권위 장부)

> 목적: 모든 전략 가설의 사전 등록 / 상태 / kill criteria / 증거 링크를 한 곳에 유지한다.
> 규칙:
> 1. **결과를 보기 전에 등록한다** — 룰·파라미터·판정 조건을 먼저 커밋하고 검정한다.
> 2. 기각된 가설의 재제안 금지 — 명시된 재검정 조건 충족 시에만 새 항목으로 재등록.
> 3. 사후 발견 cohort/슬라이스는 `hypothesis_only` 라벨로 별도 등록 (승격 증거 아님).
> 4. 상태: `PROTOCOL_REQUIRED`(가설 의도만 등록, 판정 계약 고정 전) / `REGISTERED`(판정 계약까지 등록) /
>    `TESTING`(검정 중) / `DATA_STARVED`(데이터 대기) /
>    `CANDIDATE`(Phase 0 통과, 다음 gate 대기) / `REJECTED`(기각) / `RETIRED`(영구 폐기)
> 5. promotion gate (N≥100 / active days≥5 / promotion-grade join≥95% / chrono OOS /
>    wallet-stress / paired mirror≥30 / sign agreement≥85%) 는
>    어느 가설에도 완화 불가 (`MISSION_CONTROL.md`, mission v2 ADR §6).

마지막 가설 의도 갱신: 2026-06-13 (H-007a 제안)
현재 결정 상태 확인: 2026-07-10 — H-007a `PROTOCOL_REQUIRED`, 전용 runner/result 없음,
운영자 최종 결정 대기 ([`20260708.md`](./20260708.md)).

---

## REJECTED / RETIRED (재제안 금지)

| ID | 가설 | 판정 | 증거 | 재검정 조건 |
|---|---|---|---|---|
| H-001 | KOL-follow live (smart-v3 / rotation / broad canary) | **RETIRED** (2026-06-10 edge audit `RETIRE_CURRENT_LIVE`) | live 475 closes / −1.128 SOL, P(>0)=0.0000. 신호 수명 60s × 고정비 13.6% × tail 92% exit 후 | audit §7 kill criteria 통과 cohort 발견 시에만 (사실상 없음) |
| H-002 | multi-KOL consensus 진입 트리거 | **RETIRED** | consensus 역예측: 2-KOL −64.5% / 3+ −68.1% @T+1800 (E7) | 없음 — 구조적 후행 장치 |
| H-003 | capitulation rebound (낙폭 매수) | **REJECTED** (audit 08) | 전 d300 bucket gross median 음수, chrono 양쪽 sign-stable | bounce-confirmation 검정용 dense post-low markout 수집 체계 구축 시 |
| H-004 | survivor momentum — t1 burst 추격 | **REJECTED** (2026-06-10 Phase 0) | T+30m gross −2.1% CI[−4.7,−0.6] n=142, first-per-pair −7.4% | H-008 |
| H-005 | survivor momentum — t2 ratio+accel 지속 | **REJECTED** (동일) | T+30m gross −0.2% n=2,424 — 효율적, 비용 bar 못 넘음 | H-008 |
| H-006 | survivor momentum — t3 consolidation breakout | **REJECTED** (동일) | T+30m gross −0.3% n=227 | H-008 |
| H-009 | 메이저 페어 저빈도 룰 (long/flat) | **REJECTED** (2026-06-11 Phase 0, 영구) | 6/6 rule K1+K2 발동: recent-2y SOL 전부 음수 + maxDD 53~84%. 상세는 하단 TESTING 항목 | 없음 (kill criterion 5) |

> 공통 음의 지식: **가격/거래량 모멘텀 추격은 우리 universe 들에서 전부 기각.**
> 0.02 SOL ticket 의 고정비 13.6% 구조에서는 어떤 미세 edge 도 생존 불가.

## DATA_STARVED / REGISTERED (활성)

### H-007 — holder/dev 행동 기반 진입 (PRIMARY)
- 상태: `DATA_STARVED` — **2026-06-13 관측으로 데이터 미생산 확정** (`analysis/coverage-postfix-2026-06-13/FINDINGS.md` §3).
- 가설: 10s 가격/거래량 bar 바깥의 정보 (holder 유입 속도 / dev wallet 행동 / 분포 변화) 가
  survivor universe 위에서 진입 edge 를 제공한다.
- **발견된 장애**: 현 observe run 구성은 H-007 신호 데이터를 생산하지 못한다. token-quality obs 는
  point-in-time `operatorDevStatus`/`riskFlags` (거친 분류, 시계열 아님), holder snapshot stream 부재,
  holder 수집은 Helius 비용 증가. 따라서 "더 돌리면 데이터 쌓임"이 성립 안 함.
- 검정 경로 분기: 먼저 H-007a (저비용 proxy) 로 dev/quality 차원에 신호 유무부터 확인.

### H-007a — dev/quality ex-ante 예측력 (H-007 의 $0 proxy) — **가설 의도 등록 (2026-06-13)**
- 상태: `PROTOCOL_REQUIRED` (API 비용은 0이지만 아직 실행·결과 열람 금지)
- 가설: 이미 수집된 `token-quality-observations` 의 `operatorDevStatus`/`riskFlags` 가
  markout forward outcome 을 ex-ante 예측한다 (dev/quality 차원에 신호 존재 여부).
- 데이터: token-quality-observations (5,970 rows) ⋈ trade-markout-anchors/markouts (tokenMint+시점 join).
- 판정 방향: flag 별 forward outcome 분포가 무차별이면 dev/quality 차원 무신호로 H-007 투자
  근거가 닫히고, 신호가 있으면 holder 수집과 H-007 본검정 검토로 이동한다.
- **실행 전 고정·승인할 계약**: horizon/outcome axis, entry-time join tolerance와 tie-break,
  dedup 단위, flag whitelist/control cohort, 최소 N/coverage, CI 방식·alpha, multiple-testing 처리,
  결측/중복 규칙, 최종 verdict 표. 이 계약을 별도 문서로 커밋하고 운영자가 승인하기 전에는
  join 결과를 생성·열람하거나 cohort를 선택하지 않는다.

### H-008 — survivor momentum 재검정 (레버 1 신선 데이터)
- 상태: **`BLOCKED` (재검정 불가 — 2026-06-13)**
- 결과: 레버 1 로 universe 확장은 실재 (no_pairs miss 73→19%) 했으나 **full candle coverage 10.7%**
  (1.81%→5.9x 개선이지만 promotion-grade 95% 와 멀고, bonding curve 66% + 구독지연 33% 가 구조적 상한).
  price-path 재검정에 필요한 coverage 미달 → H-004~006 재검정 무의미. 단 universe 탓 가설은 약화되었으므로
  `RETIRED` 격상은 보류, bonding parser (레버 2) 후 재평가 가능.

## TESTING

### H-009 — 메이저 페어 저빈도 룰 기반 (long/flat) — **사전 등록 (2026-06-11, 결과 미확인 상태에서 커밋)**
- 상태: **`REJECTED` (2026-06-11 같은 날, kill criterion 5 — 재검정 조건 없음, 영구)**
- 판정: 6/6 rule 전부 K1 (recent-2y SOL post-cost ≤ 0: −19.9%~−72.7%) + K2 (maxDD 53~84% > 50%) 발동.
  full-history 는 크게 양수 (+83%~+13,155% — TSMOM anomaly 실재 확인) → "원래 안 됨" 이 아니라
  **"존재했던 edge 가 2024-06 이후 SOL 에서 사망"**. 구조 발견: 전 rule maxDD > 50% 는 역사상
  최고 구간 포함 — 생존 우선 사명과 long/flat 메이저 추세는 **구조적 비호환**.
  ETH recent-2y 양수 (+70.5%) 는 사후 자산 선택 → `hypothesis_only`, 등록 비권고 (§3 비호환 우선).
  상세: `analysis/majors-lowfreq-phase0-2026-06-11/reports/PHASE0_REPORT.md`
- 가설: BTC/ETH/SOL 4h 봉의 단순 룰 기반 long/flat 전략에 post-cost 양수 +
  buy&hold 대비 생존성 개선 (max DD 감소) 이 2024-06 이후 regime 에서도 존재한다.
- 동기: TSMOM 은 문헌·실증 prior 가 있는 anomaly (우리가 측정한 밈코인 모멘텀과 다른 모집단).
  SOL/USDC 는 Jupiter 에서 기존 executor 로 집행 가능 — 신규 인프라/커스터디 0.
  단 현 자본 ($1,000 예비금 기준) 의 기대 절대수익은 연 $200-300 수준 —
  가치는 승격 파이프라인 첫 완주 + 생존형 base layer (mission v2 ADR §3).

**사전 등록 룰 (이 커밋 이후 변경 금지, 추가 파라미터 탐색 금지):**

| family | 정의 (4h bar close 기준, long/flat only) | 파라미터 |
|---|---|---|
| A. TSMOM | close > close[N] → long, else flat | N ∈ {180, 360, 540} bars (30/60/90d) |
| B. MA cross | SMA(fast) > SMA(slow) → long, else flat | (fast,slow) ∈ {(20,100), (50,200)} |
| C. RSI pullback-in-trend | close > EMA(200) AND RSI(14) < 40 → 진입; RSI(14) > 60 OR close < EMA(200) → 청산 | 고정 |

- 자산: SOL/USDT (주 판정), BTC/USDT·ETH/USDT (robustness — 방향 일치 확인용)
- 데이터: Binance 공개 klines 4h 전 이력 (SOL: 2020-08~). 수수료 가정: **RT 0.6% (보수)** /
  0.3% (참고). 체결 = signal bar 다음 bar open (look-ahead 차단).
- 평가 구간: full history + **판정 구간 = 2024-06-11..2026-06-11 (최근 2y)** + 연도별 분해.

**Kill criteria (전부 사전 고정):**
1. 최근 2y post-cost 총수익 ≤ 0 → 해당 family 기각
2. full-history post-cost 총수익 ≤ 0 또는 max DD > 50% → 기각
3. full-history return/maxDD 비율이 buy&hold 보다 나쁨 → 기각 (생존성 개선 없음)
4. SOL 통과 + BTC/ETH 둘 다 방향 불일치 (음수) → `hypothesis_only` 강등 (자산 특이 overfit 의심)
5. **전 family 기각 → H-009 `REJECTED`, 재검정 조건 없음 (영구)**
- 통과 family 존재 시: `CANDIDATE` — 다음 gate 는 paper (기존 promotion gate 그대로),
  live ticket 논의는 mirror 이후에만.

---

## 등록 백로그 (검토 후 등록 여부 결정)

- 시간대/regime 조건부 슬라이스 (Phase 0 cache 사후 발견 — `hypothesis_only` 라벨 필수)
- pump.fun bonding curve 단계 토큰 관측 (레버 2 착륙 후)
