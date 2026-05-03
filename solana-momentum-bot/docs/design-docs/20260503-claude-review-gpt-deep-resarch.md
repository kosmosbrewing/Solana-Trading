# Solone 전략 품질 점검 v2 — 진단 우선 운영 계획

- 작성일: 2026-05-03, Asia/Seoul.
- 대상: smart-v3 / rotation-v1 / pure_ws 3-lane 구조.
- 기준 자료: 2026-05-03 live canary report, paper arms report, rotation report, pure-ws botflow/markout report.
- 본 문서의 위치: 외부 리서치(`KOL Hunter가 아직 놓치고 있는 엣지`)에 대한 내부 재평가 + 실행 계획.

---

## 0. 문서의 목적

외부 리서치는 문제 정의(monetization 부족, copyability 부재, execution 약함)를 정확히 짚었다. 그러나 처방 우선순위와 단정 강도가 1인 개발자 운영 현실에 맞지 않는 부분이 있다. 본 문서는 **진단되지 않은 가설 위에 처방을 쌓지 않는다**는 원칙으로 외부 리서치를 재배열한다.

핵심 원칙 세 가지:

1. **현재 P0는 행동이 아니라 측정이다.** paper-live gap의 원인이 분해되지 않은 상태에서 priority fee 튜닝부터 들어가는 것은, 외부 리서치가 비판한 "엣지 위치보다 한 단계 아래에서 잘하기" 패턴의 변형이다.
2. **표본 크기 자각.** 208 closed live trades는 통계적으로 거의 아무 결론도 단정하지 못하는 크기다. 모든 후속 결정은 이 위에 쌓인다.
3. **arm을 늘리지 않는다.** 외부 리서치가 권한 새 lane(origin/dev/funder)도 paper shadow로만 추가한다. 본선 trigger를 대체하지 않는다.

---

## 1. 현재 상태 재진단

### 1.1 첨부 데이터 요약

| 레인                        | 표본          | 결과                                                    | 판정                   |
| --------------------------- | ------------- | ------------------------------------------------------- | ---------------------- |
| smart-v3 live canary        | 208 closed    | net -0.363525 SOL, win 21.15%, hardcut 103, actual 5x 0 | PAUSE_REVIEW           |
| smart-v3 paper pullback     | 315 closed    | net +0.102212 SOL, 5x 1건                               | 관찰 지속              |
| smart-v3 paper velocity     | 73 closed     | net +0.027170 SOL, 5x 0                                 | 표본 부족              |
| rotation underfill v1 paper | 5 closed      | net -0.000386 SOL, rent-stress -0.010928 SOL            | 표본 무의미            |
| pure_ws botflow             | 22 sim trades | 전부 unresolved (`missing_entry_price`)                 | 데이터 파이프라인 결손 |
| pure_ws markout             | 256 anchors   | okCoverage 7.8%, T+1800 median post-cost -2.5%          | INVESTIGATE            |

### 1.2 데이터로 단정 가능한 것

- smart-v3 paper와 live의 부호가 반대다. 어딘가에서 값이 새고 있다.
- rotation underfill은 token-only는 약한 양수 가능성, rent-adjusted는 음수다. 표본이 5건이라 가설 보존 외 의미 없음.
- pure_ws는 입력 데이터가 비어 있어 전략 평가 단계가 아니다.

### 1.3 데이터로 단정 불가능한 것 (외부 리서치가 단정한 것 포함)

- **paper-live gap의 주원인이 execution latency라는 주장**: telemetry 부재로 검증 불가.
- **consensus bonus가 사실상 crowding tax라는 주장**: 기관 거래 문헌의 결론을 밈코인에 직이식. 우리 데이터로 검증된 적 없음.
- **origin/dev/funder lane이 가장 ROI 큰 보강이라는 주장**: 구현 비용을 생략한 추정. 우리 환경의 비용/효과 모름.
- **Kelly·DSR/PBO가 필요하다는 주장**: edge가 양수임이 증명되지 않은 상태에서 sizing/검증 도구는 시기상조.

이 네 가지는 **가설로만 보관**하고, 채택 전에 paper shadow 측정을 거친다.

### 1.4 paper-live gap의 가능 원인 분해

원인을 한 가지로 단정하지 말고 셋 모두를 동시에 의심한다.

1. **Execution latency / landing quality**: signal→submit→landed 사이에 가격이 도망간다. priority fee, CU limit, retry 정책으로 개선 가능.
2. **Paper simulation fidelity 부족**: paper close가 실제 Jupiter route impact를 반영하지 않거나, look-ahead bias가 숨어 있다. priority fee를 아무리 올려도 안 풀리는 갭이다.
3. **Adverse selection**: live에서만 작동하는 toxicity가 신호에 섞여 있다. 신호 자체를 좁혀야 풀린다.

P0의 진짜 작업은 이 셋 중 어느 비중이 큰지를 가르는 것이다.

---

## 2. 외부 리서치 재평가

| 외부 리서치 권고                                   | 본 문서 평가                               | 처분                                              |
| -------------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| origin/dev/funder lane 신설 (P1급)                 | 학술적으로 옳음. 구현 비용 큼. 즉효성 약함 | **P3 paper shadow로 강등**. mini 버전만           |
| copyable-edge gate                                 | 옳음. 단, 초기 버전은 estimable 항만       | **P0 병행 채택**. slippage 항은 telemetry 후 합류 |
| execution stack 강화                               | 옳음. 단, 진단 후 우선순위 조정            | **P1 (진단 결과 따라)**                           |
| effective independent KOL count + crowding penalty | 가설로 합리적. 단정 근거 약함              | **P2 paper shadow 측정 후 채택 결정**             |
| state-conditional no-trade / hold policy           | 옳음. 단, 측정 도구 먼저                   | **P2 (day quality metric 구축 후)**               |
| Kelly / robust sizing                              | edge 양수 증명 후의 문제                   | **보류**. 본 문서 범위 밖                         |
| DSR/PBO 검증 체계                                  | 방향 옳음. 1인 개발자에게 거창             | **P3 경량판 (jsonl + notebook)**                  |
| KOL 수 확장 보류                                   | 동의                                       | **유지**                                          |
| 글로벌 hardcut 완화 보류                           | 동의                                       | **유지**                                          |
| rotation/pure_ws live 승격 보류                    | 동의                                       | **유지**                                          |

핵심 변화: 외부 리서치의 **"origin lane → copyable gate → execution → effective count → state-conditional → sizing"** 순서를, **"진단 → execution(검증된 만큼) + estimable gate → simulation 충실도 점검 → 그 다음 단계"**로 재배열.

---

## 3. 단계별 실행 계획

### P0 (이번 주): 진단 인프라 구축

**목적**: paper-live gap의 원인 비중을 측정 가능하게 만든다. 본 단계에서 신호 로직과 본선 파라미터는 일체 변경하지 않는다.

#### P0-A. Execution telemetry 의무 로깅

모든 live trade entry/exit에 다음 필드 기록.

```typescript
interface ExecutionTelemetry {
  // 시간 추적
  signal_emit_ts: number; // KOL signal handler가 candidate 확정한 시각
  decision_ts: number; // trigger 평가 완료 시각
  tx_build_ts: number; // tx 직렬화 완료 시각
  tx_submit_ts: number; // RPC 제출 시각
  tx_landed_slot: number | null; // 체결 slot (실패 시 null)
  tx_landed_ts: number | null;

  // 비용
  priority_fee_lamports: number;
  cu_limit_requested: number;
  cu_used: number | null;
  ata_rent_paid_lamports: number;

  // 가격 충실도
  signal_price: number; // signal 발생 시점 quote
  expected_fill_price: number; // tx build 시점의 Jupiter quote
  actual_fill_price: number | null;
  slippage_bps_signal_to_expected: number;
  slippage_bps_expected_to_actual: number | null;

  // 라우팅
  route_provider: "jupiter" | "jito" | "sender";
  route_legs: number;
  retry_count: number;

  // 실패 분류
  failure_reason:
    | "none"
    | "tx_dropped"
    | "simulation_failed"
    | "slippage_exceeded"
    | "rpc_error"
    | "other";
}
```

저장: `logs/execution-telemetry/{date}.jsonl`. 기존 trade ledger와 trade_id로 join 가능해야 함.

#### P0-B. Paper-Live shadow comparator

같은 KOL signal이 paper arm과 live canary에 동시 도달했을 때, 두 경로의 결과를 trade_id 기준으로 매칭하여 **diff 분포**를 산출한다.

측정 항목:

- entry_price_diff_bps (paper assumed vs live actual)
- exit_price_diff_bps
- realized_pnl_diff_sol
- holding_duration_diff_seconds

산출물: `reports/paper-live-diff-{date}.json`. 30건 누적 시 1차 분석.

#### P0-C. Pre-trade monetizable-edge gate (estimable-only 버전)

live entry 직전에 다음 의사코드 평가. **slippage 분포가 P0-A telemetry로 쌓이기 전까지는 slippage 항을 0으로 둔다**(과적합 방지).

```typescript
function preTradeMonetizableEdgeGate(ctx: EntryContext): GateResult {
  // 모두 SOL 단위
  const ataRent = 0.00207408;
  const networkFee = 0.000105;
  const priorityFeeEst = ctx.recentPriorityFeeP75; // Helius dynamic fee
  const sellRouteImpact = ctx.jupiterSellQuoteImpactSol; // 이미 계산됨

  // P1+에서 합류시킬 항목 (현 단계 0)
  const expectedLandingDrag = 0;
  const slippageDrag = 0;

  const fixedAndExecCost =
    ataRent +
    networkFee +
    priorityFeeEst +
    sellRouteImpact +
    expectedLandingDrag +
    slippageDrag;

  // ticket 대비 비용 비율
  const costRatio = fixedAndExecCost / ctx.ticketSizeSol;

  // 최소 임계: ticket의 6% 이하여야 진입 (내부 휴리스틱, 측정 후 재조정)
  if (costRatio > 0.06) {
    return { pass: false, reason: "cost_ratio_exceeded", costRatio };
  }

  // arm-specific 기대 수익 floor
  // smart-v3는 5x 본선이라 cost ratio 6%는 무시 가능, 단 이 gate는 안전망
  return { pass: true, costRatio };
}
```

이 gate는 **차단**과 **로깅** 두 모드를 둔다. P0 동안은 **로깅만** (shadow). 차단 전환은 P1 진단 결과 본 뒤 결정.

#### P0-D. Sample 수집 가속

현재 ticket 사이즈를 유지하면서 표본을 늘리는 방법이 없다면, **ticket을 일시 축소**해서 동일 dev-week에 더 많은 live trade를 모은다. 정보 수집 비용으로만 운영.

대안: live canary를 일시 중단하고 paper arm 표본만 키우는 선택지. 이 경우 P0-B(paper-live diff) 측정 자체가 불가하므로, P0-A telemetry는 _과거_ trade 재추출 가능 범위까지 소급 적용.

**선택은 운영자 판단**. 본 문서는 두 옵션의 trade-off만 명시.

#### P0 종료 조건

- Telemetry 누적 ≥ 100건 live trade.
- Paper-live diff 매칭 누적 ≥ 30 pair.
- Gate 의사코드 동작 확인 (shadow 로그).

---

### P1 (P0 종료 후 1–2주): 진단 결과에 따른 분기

P0-B 결과를 보고 다음 셋 중 비중이 큰 원인부터 처리.

#### Case A. Execution latency가 주원인 (entry slippage 분포가 큼)

처방:

- Helius dynamic priority fee API 채택. 75th percentile 기준.
- CU limit simulation (`simulateTransaction`) 후 +20% buffer. 과지급 축소.
- `maxRetries=0` + 자체 retry (지수 백오프, 최대 3회).
- Jito Sender 또는 dual-route 평가. **paper에서 latency benchmark 먼저**, 그 다음 live 일부 비중에 적용.
- `dontfront` 옵션 적용 (sandwich 방어).

측정: P0-A telemetry로 before/after slippage_bps 분포 비교.

#### Case B. Paper simulation fidelity 부족이 주원인 (live가 paper보다 체계적으로 나쁨, 단 entry slippage는 작음)

처방:

- paper close logic이 Jupiter sell-route impact를 반영하는지 점검.
- paper의 fill assumption(`signal_price 그대로` 또는 `+ε`)을 live의 평균 expected_to_actual diff로 대체.
- look-ahead bias 점검: paper가 미래 price를 참조하고 있지 않은지 코드 리뷰.
- 수정 후 paper arm 결과를 **재계산하여 신뢰성 재평가**. 이 재평가 결과 paper도 음수면 신호 자체 문제(Case C로 이동).

#### Case C. Adverse selection이 주원인 (paper도 음수 또는 paper-live diff가 일정하지 않고 패턴이 mint별로 분산)

처방:

- KOL filter 좁힘. live eligibility를 더 보수적으로 (예: S급 KOL 2명 이상).
- mint context 기반 toxicity flag 도입 (P2의 origin layer mini가 여기서 합류).
- 본선 trigger 조건 자체를 paper에서 재튜닝.

#### P1 단계의 금지 사항

- 세 케이스가 동시에 작은 비중이라고 판명되면, 추가 paper arm을 만들지 말고 **표본을 더 모은다**. P0로 회귀.
- 본선 hardcut/trail/floor 글로벌 변경 금지 (외부 리서치 결론 그대로).

---

### P2 (P1 종료 후 2–3주): 신호 품질 보강

본 단계는 P0–P1로 paper-live gap이 일정 수준 좁혀진 뒤에만 의미가 있다. 그 전에 시작하면 측정 노이즈에 묻힌다.

#### P2-A. Effective independent KOL count + crowding penalty (paper shadow)

기존 raw consensus count와 effective count를 **병렬 계산**. 즉시 채택하지 않는다.

```typescript
interface KolSignalContext {
  rawIndependentCount: number; // 기존
  effectiveIndependentCount: number; // 신규
}

function computeEffectiveIndependence(buys: KolBuy[]): number {
  // 1. funder dedup: 최근 30일 내 같은 funder에서 SOL 받은 KOL은 같은 단위로
  // 2. same-block coordination: 같은 slot ±1에서 buy한 KOL 군집은 1로 카운트
  // 3. 과거 N회 동일 mint에 함께 등장한 KOL pair는 correlation score로 가중
  // 결과: rawCount ≥ effectiveCount
}
```

병렬 측정 ≥ 200 trades 후, smart-v3 paper arm에서 effective 기준 trigger와 raw 기준 trigger의 net SOL 차이를 비교. 차이가 통계적으로 유의하면 채택.

#### P2-B. Day quality metric (간이판)

```typescript
interface DayQuality {
  windowMinutes: 60; // rolling
  trackedMintCount: number;
  pct_reach_50pct: number; // +50% 도달 비율
  pct_reach_100pct: number;
  pct_reach_400pct: number;
  pct_continue_after_first_sell_30s: number;
  median_sell_route_stability: number;
  score: number; // 0–1 normalized
}
```

이 score는 **글로벌 hardcut 완화에 쓰지 않는다**. 다음에만 쓴다:

- 특정 hold-phase sentinel의 timeout을 day quality 상위 25%일 때 30% 연장.
- T1 trail을 day quality 상위 25%일 때 paper에서 1단계 완화 (paper 검증).

전역 완화 금지 원칙은 외부 리서치와 일치.

#### P2-C. Pre-trade gate에 slippage 항 합류

P0-A telemetry로 누적된 slippage 분포의 P75를 `slippageDrag`로 합류. 이 시점부터 gate를 **shadow → 차단** 모드로 전환 검토. 차단 전환 시 1주간 trigger 빈도/net SOL 영향 모니터.

---

### P3 (P2 종료 후): origin layer mini + 검증 체계

#### P3-A. Origin layer mini (paper shadow only)

풀 funder graph 대신 다음 세 신호만 합산.

```typescript
interface OriginContext {
  creator_address: string;
  creator_history_rug_ratio: number | null; // 과거 N개 mint 중 rug 비율
  first_30_buyers_funder_concentration: number; // Helius enriched에서 산출
  creator_linked_sell_within_10s_before_signal: boolean;
}

function originRiskScore(ctx: OriginContext): number {
  // 0–1, 1이 가장 위험
}
```

이 score는 smart-v3 본선 trigger를 **대체하지 않고**, paper에서 추가 gate로만 평가한다. ≥ 100 trade 후 채택 여부 결정.

데이터 소스 비용/한도 점검(Helius enriched API rate limit) 선행 필수.

#### P3-B. 검증 체계 경량판

- 새 paper arm 추가 시 사전 등록 룰: `arm_name`, `hypothesis`, `expected_edge_per_trade_sol`, `expected_sample_size`, `kill_criteria`를 yaml로 PR 직전 등록.
- 등록되지 않은 arm은 ledger에서 자동 제외.
- 월 1회 noteboook으로 PBO/CSCV 간이 점검 (arm 5+ 누적 시).

---

## 4. 동결 / 보류 항목

| 항목                            | 결정               | 사유                                                                           |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| smart-v3 글로벌 파라미터 튜닝   | **동결**           | 손실이 파라미터 문제라는 증거 없음                                             |
| rotation-v1 신규 paper arm 추가 | **동결**           | 기존 4개 arm 표본 부족. 가설 추가 전 cost 차감 후 양수 가능 사유 1줄 작성 의무 |
| pure_ws live canary             | **보류**           | entry_price/pair_age/context 비어 있음                                         |
| KOL 수 확장                     | **보류**           | crowding 가설 검증 전                                                          |
| 글로벌 hardcut 완화             | **보류**           | state-conditional 측정 도구 부재                                               |
| Kelly / robust sizing           | **범위 밖**        | edge 양수 증명 후 검토                                                         |
| 풀 funder graph                 | **P3 mini로 대체** | 구현 비용 대비 즉효성 약함                                                     |

**동결 기간 손실 처리**: live canary 유지 시 ticket 축소, 또는 paper-only 전환 중 택일. 본 문서는 권고 없이 운영자 결정으로 둠.

---

## 5. 표본 신뢰도 메모

- 208 closed의 21.15% win rate에 대한 95% 신뢰구간은 대략 ±5–6%p. "PAUSE_REVIEW" 자체는 net SOL 음수 + actual 5x 0건이라는 *분포*로 정당화되지만, **win rate 절대값은 단정 근거가 못 됨**.
- 5건 표본의 rotation underfill 결과는 어떤 방향으로도 의사결정에 사용하지 않는다.
- pure_ws의 22 unresolved sim trade는 데이터 결손 신호이지 전략 신호 아님.
- 본 문서의 모든 P1+ 처방은 **표본이 충분히 쌓였을 때만 의사결정에 들어간다**.

---

## 6. 한 줄 요약

외부 리서치는 **무엇이 부족한지**는 정확히 짚었다. 본 문서는 **무엇을 먼저 측정하고, 무엇을 paper에서 검증하고, 무엇을 본선에 합류시킬지**의 순서를 우리 표본 크기와 1인 개발자 운영 비용에 맞춰 다시 짠 것이다. 핵심은 단 하나 — **측정되지 않은 가설 위에 처방을 쌓지 않는다.**
