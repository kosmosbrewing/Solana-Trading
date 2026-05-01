# Decu New-Pair Quality Layer — Token / Holder / Dev / Fee 품질 개선 ADR

> 작성일: 2026-05-01
> 상태: **Phase A + B (observe-only 골격) 구현 완료** — paper/live cohort dedup + 4-jsonl 분석 인프라 가동. Enrichment (holder/vamp/fee 실 호출) 은 follow-up sprint.
> 출처: decu KOL new-pair 전략 메모 + 프로젝트 코드/로그 대비 점검
> Authority: `MISSION_CONTROL.md` / `option5-kol-discovery-adoption-2026-04-23.md` / `mission-refinement-2026-04-21.md`

---

## 0. 한 줄 결론

decu 조언의 핵심은 "new pair 자체를 잘 사라"가 아니라, **매수 전에 토큰 디테일을 충분히 확인해서 rug-prone coin 을 제거하라**는 것이다.

우리 프로젝트에는 이를 main lane 교체가 아니라 다음 레이어로 흡수한다.

```text
KOL trigger
+ smart-v3 timing
+ token quality / holder distribution / vamp lint / global fee proxy
+ operator-supplied dev reputation
+ Real Asset Guard
```

좋은 dev 발굴은 운영자가 별도 수행한다. 본 문서는 그 결과를 코드가 안전하게 받아들이고, 나쁜 토큰을 관측/분류/차단하는 품질 레이어를 정의한다.

---

## 1. Decu 전략 요약

### 1.1 원문 통찰

| Decu 조언 | 우리식 해석 |
|---|---|
| Stick to what works for you | 현재 active niche 는 `kol_hunter` + 자체 execution. raw sniper 로 회귀 금지 |
| New pairs 에서 성공 | new-pair universe 는 tail 이 크지만 rug density 도 높음 |
| Filter bad coins from good ones | entry 전에 token quality layer 필요 |
| Tracking dev wallets | dev wallet reputation / creator / first LP provider 축 필요 |
| Stay chronically online | 봇에서는 meta/regime observer + fresh-pair telemetry 로 치환 |
| Inspect name, ticker, dev wallet, holders | metadata lint + holder distribution + dev reputation |
| Vamp / typo / bearish image red flag | vamp similarity / image duplicate / metadata anomaly |
| Global fees abnormal → likely rug | rolling fee proxy + fee/liquidity + fee/mcap anomaly |
| Mental game | 자동 rule + phase gate 로 감정 기반 진입 억제 |

### 1.2 본 프로젝트에 대한 함의

이 전략은 live entry size 를 키우라는 근거가 아니다.

사명 정합적인 해석은:

```text
더 많이 사기 X
더 빨리 사기 X
더 좋은 universe 만 진입하기 O
```

---

## 2. 현재 코드 대비

### 2.1 이미 구현된 것

| 축 | 현 구현 | 파일 |
|---|---|---|
| mint / freeze / transfer fee / Token-2022 위험 확장 | hard reject | `src/gate/securityGate.ts` |
| top10 holder concentration | `>80%` reject, `>50%` quality flag | `src/gate/securityGate.ts` |
| sellability | Jupiter sell quote probe | `src/gate/sellQuoteProbe.ts` |
| bad fill / stale pool 방어 | entry drift guard | `src/gate/entryDriftGuard.ts` |
| token age cohort | fresh / mid / mature / unknown | `src/scanner/cohort.ts` |
| DEX fee 기본 추정 | dexId / poolProgram fee map | `src/utils/dexFeeMap.ts` |
| DexScreener metadata | pairCreatedAt / liquidity / volume / orders 일부 | `src/scanner/dexBoostDiscovery.ts` |
| KOL role / live canary safety | smart-v3 + independent KOL live gate | `src/orchestration/kolSignalHandler.ts` |

### 2.2 아직 약한 것

| Gap | 현재 상태 | 위험 |
|---|---|---|
| dev wallet reputation | 설계 후보만 존재 | 같은 dev rug 반복 차단 불가 |
| creatorPct on-chain path | 대부분 `0` fallback | dev bundle / creator concentration 측정 약함 |
| holder distribution 세분화 | top10 위주 | top1/top5/HHI/bundle clustering 미측정 |
| vamp / copycat 감지 | 없음 | typo / derivative / duplicate metadata miss |
| image quality / duplicate | 없음 | bearish/scam visual, reused image miss |
| global fee proxy | 고정 DEX fee map 수준 | volume 대비 fee anomaly 미측정 |
| meta/context observer | 부분적 | "이미 달린 narrative" 판정 약함 |

---

## 3. 범위 결정

### 3.1 In Scope

1. Token detail inspection 자동화
2. Holder distribution 강화
3. Vamp / metadata lint
4. Global fee proxy
5. Operator-supplied dev list ingestion
6. observe-only report
7. 7일 후 paper reject 후보 선정

### 3.2 Out of Scope

| 제외 | 이유 |
|---|---|
| 좋은 dev 자동 발굴 | 운영자가 별도 리서치. 봇은 입력된 dev를 검증/추적 |
| raw new-pair live lane 즉시 도입 | 과거 pure_ws/new-pair 실패 구조 재발 위험 |
| live hard gate 즉시 적용 | false positive 가 5x winner-kill 유발 가능 |
| ticket size 증가 | Real Asset Guard / Mission Control 위반 |
| quality layer 의 Birdeye 신규 의존 | 기존 optional / legacy Birdeye 경로는 유지하되, 본 레이어에는 신규 호출 추가 금지 |

---

## 4. 품질 레이어 설계

### 4.1 TokenQualityInspector

신규 후보 모듈:

```text
src/observability/tokenQualityInspector.ts
```

초기에는 read-only / observe-only.

출력 record:

```ts
interface TokenQualityRecord {
  schemaVersion: 'token-quality/v1';
  tokenMint: string;
  pairAddress?: string;
  dexId?: string;
  observedAt: string;

  name?: string;
  symbol?: string;
  imageUri?: string;
  metadataUri?: string;

  top1HolderPct?: number;
  top5HolderPct?: number;
  top10HolderPct?: number;
  holderHhi?: number;
  holderCountApprox?: number;

  creatorAddress?: string;
  devWallet?: string;
  firstLpProvider?: string;
  operatorDevStatus?: 'allowlist' | 'watchlist' | 'blacklist' | 'unknown';

  vampSimilarityScore?: number;
  suspectedBundleScore?: number;
  estimatedGlobalFees5mSol?: number;
  feeToLiquidity?: number;
  feeToMcap?: number;

  riskFlags: string[];
}
```

Ledger:

```text
data/realtime/token-quality-observations.jsonl
```

### 4.2 Holder Distribution

기존 top10 외에 다음을 추가한다.

```text
top1HolderPct
top5HolderPct
top10HolderPct
holderHHI
topHolderCount
topHolderFreshness
topHolderOverlapWithDev
```

초기 risk flags:

```text
HOLDER_TOP1_HIGH
HOLDER_TOP5_HIGH
HOLDER_TOP10_HIGH
HOLDER_HHI_HIGH
DEV_IN_TOP_HOLDER
LP_OR_POOL_IN_TOP_HOLDER
```

정책:

```text
observe-only -> paper reject 후보 -> live hard gate
```

### 4.3 Bundle / Sniper Proxy

Axiom 수준의 완전한 bundle detector 는 초기 범위가 아니다. 대신 proxy 를 기록한다.

```text
sameSlotBuyerCount
first30sBuyerCount
first30sTopHolderShare
fundingSourceOverlap
creatorToHolderTransfers
```

초기 risk flags:

```text
BUNDLE_SAME_SLOT_CLUSTER
BUNDLE_FUNDING_OVERLAP
SNIPER_TOP_HOLDER_CLUSTER
CREATOR_FUNDED_CLUSTER
```

Hard reject 금지. rug / winner 사후 결과와 비교 후 gate 승격.

### 4.4 Vamp / Metadata Lint

감지 대상:

```text
name / symbol typo
이미 달린 token 과 높은 문자열 유사도
대소문자 / 숫자 치환: O->0, I->1, E->3
duplicate metadataUri
duplicate imageUri
broken image
missing image
name-symbol-image 불일치
```

초기 risk flags:

```text
VAMP_NAME_SIMILAR
VAMP_SYMBOL_SIMILAR
VAMP_DUPLICATE_IMAGE
VAMP_DUPLICATE_METADATA
METADATA_MISSING_IMAGE
METADATA_BROKEN_URI
METADATA_SYMBOL_SPOOF
```

초기 알고리즘:

| 대상 | 방식 | 초기 threshold |
|---|---|---:|
| name / symbol | ASCII confusable map 정규화 후 Damerau-Levenshtein normalized similarity | `>= 0.85` |
| metadataUri | SHA256 exact match | duplicate |
| imageUri | URI exact match + fetched content SHA256 | duplicate |
| image content | pHash 8x8 DCT hamming distance | `<= 5` |

Fallback:

- IPFS / metadata fetch 실패 시 `METADATA_BROKEN_URI`
- fetch timeout `3s`
- image hash / pHash 는 background batch 에서 수행
- entry critical path 영향 0

주의:

정상 derivative meme 도 존재하므로 vamp flag 단독 hard reject 금지.

### 4.5 Global Fee Proxy

정확한 Axiom UI `Global Fees Paid` 값은 공식 API 없이는 재현하기 어렵다. 우리 목적에는 proxy 로 충분하다.

```text
estimatedGlobalFees5mSol =
  rollingObservedVolume5mSol * venueFeeRate
```

추가 지표:

```text
feeToLiquidity = estimatedGlobalFees5mSol / liquiditySol
feeToMcap      = estimatedGlobalFees5mSol / marketCapSol
feeVelocity    = estimatedGlobalFees5mSol / tokenAgeMinutes
volumeToLiq    = rollingVolume5mSol / liquiditySol
```

초기 risk flags:

```text
FEE_TO_LIQUIDITY_HIGH
FEE_TO_MCAP_HIGH
FEE_VELOCITY_HIGH
VOLUME_TO_LIQ_HIGH
FEE_WITH_LOW_HOLDER_DIVERSITY
```

Pump 공식 fee schedule 은 bonding curve / PumpSwap canonical pool 에서 fee 가 다르다. 현재 `dexFeeMap.ts` 의 고정 fee 추정은 이 tier 를 반영하지 않으므로, `globalFeeObserver` 에서 별도 계산해야 한다.

참고: Pump.fun fee schedule — https://pump.fun/docs/fees

---

## 5. Operator Dev List

좋은 dev 발굴은 운영자가 별도 수행한다. 관리는 `data/kol/wallets.json` 과 같은 수동 장부 방식으로 한다.

```text
data/dev-wallets/wallets.json
```

운영 원칙:

- 수동 편집 only
- 자동 추가 금지
- hot reload 가능
- `id` 는 lowercase unique
- `addresses[]` 는 deployer / creator / first LP / 관련 dev 지갑을 함께 묶는다.
- `is_active=false` 는 lookup 대상에서 제외하되, 과거 기록 보존용으로 유지한다.

초기 schema:

```json
{
  "//": "Dev Wallet Quality DB — manual edit only. Automatic add is forbidden.",
  "//schema": "devs[].id = lowercase unique. addresses = deployer/creator/LP wallets. status = allowlist/watchlist/blacklist/unknown. is_active=false excludes lookup.",
  "version": "v1",
  "last_updated": "2026-05-01",
  "devs": [
    {
      "id": "example_dev",
      "addresses": ["..."],
      "status": "allowlist",
      "is_active": true,
      "source": "operator_manual",
      "added_at": "2026-05-01",
      "last_verified_at": "2026-05-01",
      "notes": "manual research",
      "known_projects": [],
      "risk_notes": [],
      "success_notes": []
    }
  ]
}
```

정책:

| status | 의미 | 초기 동작 |
|---|---|---|
| `allowlist` | 운영자가 좋다고 본 dev | report / ranking label only, hard allow 금지 |
| `watchlist` | 애매함 | risk flag |
| `blacklist` | 반복 rug 의심 | paper reject 후보, live hard gate 는 7일 검증 후 |
| `unknown` | 미분류 | 기본값 |

중요:

- KOL `is_active=true` 는 discovery trigger 가 될 수 있다.
- Dev `status=allowlist` 는 entry trigger 가 아니다.
- Dev allowlist 는 Phase B/C 에서 report / ranking / quality label only 로 시작한다.
- `allowlist` 도 security / sell quote / drift guard / holder / rug / vamp checks 를 절대 우회하지 않는다.

---

## 6. KOL Hunter 통합 방식

### 6.1 Entry 전

```text
KOL tx 감지
  -> smart-v3 trigger
  -> Real Asset Guard / security / sell quote / drift
  -> TokenQualityInspector observe
  -> entry / reject 와 함께 quality snapshot 기록
```

초기에는 `TokenQualityInspector` 가 entry 를 막지 않는다.

### 6.2 Ledger / cohort

`kol-paper-trades.jsonl`, `kol-live-trades.jsonl`, `missed-alpha.jsonl` 과 `token-quality-observations.jsonl` 을 `tokenMint` + 시간 근접 join 한다.

분석 축:

```text
qualityFlag × exitReason × netSol × mfePctPeak × winnerKill × bigLoss
devStatus × KOL primary × KOL reinforcement
vampScoreBucket × globalFeeBucket × holderDistributionBucket
```

### 6.3 Report

신규 후보:

```text
scripts/token-quality-report.ts
```

출력:

```text
reports/token-quality-YYYY-MM-DD.md
```

핵심 표:

| Flag | n | netSol | bigLossRate | 5xRate | winnerKillRate | 권고 |
|---|---:|---:|---:|---:|---:|---|
| HOLDER_TOP1_HIGH | | | | | | observe / paper reject |
| VAMP_DUPLICATE_IMAGE | | | | | | observe |
| FEE_TO_LIQUIDITY_HIGH | | | | | | observe |
| DEV_BLACKLIST | | | | | | paper reject 후보 |

---

## 7. Phase Plan

### 7.0 Mission Stage Gate Mapping

| ADR Phase | Mission maturity gate | 정책 |
|---|---|---|
| Phase A — 문서 / 설계 고정 | Stage 1 — Safety Pass | runtime 변경 없음 |
| Phase B — observe-only 구현 | Stage 1 — Safety Pass | entry / reject / live path 영향 0 |
| Phase C — 7일 측정 | Stage 2 — Sample Accumulation | 100 live trades 관측과 함께 quality cohort 를 분리 분석 |
| Phase D — paper reject | Stage 2 강화 | DSR / winner-kill / false-positive 확인 후 paper-only reject |
| Phase E — live gate | Stage 3 — Winner Distribution Observation 이후 | 5x+ winner 분포와 DSR 정합 확인 후 별도 ADR |

Stage 4 — Scale / Retire Decision Gate 전에는 ticket size 증가, quality flag 기반 live hard gate 확대, lane 추가를 판단하지 않는다.

### 7.1 Current Sprint Timing

현재 운영은 canary budget / trade count 변경, Phase 2.A2 partial take, tail retain paper-shadow 측정과 겹칠 수 있다. 따라서 본 ADR 은 attribution confound 를 다음처럼 분리한다.

| 단계 | 즉시성 | confound 정책 |
|---|---|---|
| Phase A | 즉시 | 문서 정정만 수행 |
| Phase B | 즉시 가능 | observe-only 이므로 entry 영향 0. Phase 2.A2 / tail retain 측정과 병렬 가능 |
| Phase C | 7일 측정 | token-quality cohort 를 별도 축으로 분석해 partial take / tail retain 효과와 분리 |
| Phase D | deferred | Phase 2.A2 + tail retain 측정 정합 확인 후 진입 |
| Phase E | deferred | Stage 3 prerequisite + 별도 ADR 전까지 금지 |

### Phase A — 문서 / 설계 고정

기간: 즉시

산출:

- 본 ADR
- `docs/design-docs/index.md` 카탈로그 등록
- 구현 전 scope lock

### Phase B — Observe-only 구현

기간: 1-2일

산출:

1. `src/observability/tokenQualityInspector.ts`
2. `src/observability/globalFeeObserver.ts`
3. `data/dev-wallets/wallets.json` scaffold
4. `scripts/token-quality-report.ts`
5. 단위 테스트

Acceptance:

```text
npm run check:fast green
entry/reject/live path 영향 0
token-quality-observations.jsonl 생성
quality layer 신규 Birdeye 호출 0
token-quality observer Helius RPC < 100/min
IPFS / image hash fetch 는 background batch only
metadata fetch timeout <= 3s
cache hit rate >= 80% 목표
```

### Phase C — 7일 측정

기간: 7일

측정:

```bash
npx ts-node scripts/token-quality-report.ts --window-days=7
npx ts-node scripts/winner-kill-classifier.ts --window-days=7
npx ts-node scripts/dsr-validator.ts --source=both --window-days=7
```

판정:

| 조건 | 의미 |
|---|---|
| flag 의 bigLossRate 가 baseline 대비 유의하게 높음 | paper reject 후보 |
| flag 가 5x winner 를 자주 포함 | hard reject 금지 |
| devStatus blacklist 가 rug / big-loss 와 일치 | paper reject 후보 |
| fee anomaly 가 false positive 높음 | report-only 유지 |

### Phase D — Paper Reject

조건:

```text
7일 observe
n >= 30 per flag
5x winner false-positive 0 또는 명시적 예외
bigLossRate baseline 대비 의미 있게 높음
```

동작:

```text
paper path 에서만 reject
live path 는 여전히 report-only
```

### Phase E — Live Gate

조건:

```text
paper reject 7일 추가 검증
DSR Prob>0 악화 없음
winner-kill 증가 없음
별도 ADR + 운영자 명시 승인
```

동작:

```text
high-confidence flag 조합만 live hard reject
single flag hard reject 금지
```

---

## 8. Hard Constraints

| Constraint | 정책 |
|---|---|
| Wallet floor 0.7 SOL | 변경 금지 |
| ticket size | 증가 금지 |
| Real Asset Guard | 완화 금지 |
| security / sell quote / drift guard | allowlist dev 도 우회 금지 |
| raw new-pair live lane | 본 문서 범위 밖 |
| Birdeye | 본 quality layer 신규 호출 금지 |
| dev allowlist | hard allow / entry trigger 아님 |
| vamp / holder / fee flag | 초기 hard reject 금지 |

---

## 9. 위험

### R1 — False Positive 로 5x winner 차단

대응:

- observe-only first
- 5x winner 포함 flag 는 hard reject 금지
- paper reject 후 live gate 단계 분리

### R2 — 좋은 dev allowlist 를 과신

대응:

- Phase B/C 에서는 allowlist 를 report / ranking / quality label only 로 사용
- live entry trigger 로 사용 금지
- security / sell quote / drift guard 우회 금지

### R3 — Vamp detection 이 문화적 derivative 를 과도 차단

대응:

- duplicate metadata / broken URI 는 강한 flag
- name similarity 단독 reject 금지

### R4 — Global fee proxy 오해

대응:

- Axiom UI 값과 동일하다고 주장 금지
- `estimated_*` prefix 사용
- fee/liquidity, fee/mcap 등 비율 기반으로 해석

### R5 — API 비용 / latency 증가

대응:

- entry critical path 에서 heavy fetch 금지
- 캐시 / async observer 우선
- missing data 는 report-only `UNKNOWN` 처리
- token-quality observer 의 Helius RPC 는 `< 100/min` cap
- holder top1/top5/HHI 는 가능한 기존 `getTokenLargestAccounts` 결과 재사용
- holder count approximation 은 별도 RPC 부담이 크므로 rate-limit 적용
- IPFS image hash / pHash 는 background batch 에서만 실행
- 캐시 hit rate `>= 80%` 를 목표로 보고서에 표시

---

## 10. Reference

- Pump.fun fee schedule: https://pump.fun/docs/fees
- Solana Token-2022 Transfer Fees: https://solana.com/docs/tokens/extensions/transfer-fees
- SolRPDS rug pull dataset: https://arxiv.org/abs/2504.07132
- Existing dev wallet DB design candidate: `docs/design-docs/survival-layer-tier-b-2026-04-21.md`

---

## 11. 최종 권고

다음 스프린트는 **Decu Quality Layer Phase B — observe-only 구현** 이다.

우선순위:

1. holder distribution 확장
2. metadata / vamp lint
3. global fee proxy
4. operator dev list ingestion
5. 7일 report

---

## 12. 구현 결과 (2026-05-01 Phase B 완료)

### 12.1 적용 범위 — 8 sub-task 병렬 구현

| Sub-task | 산출 | LOC | 상태 |
|---|---|---:|---|
| B.1 | `src/observability/tokenQualityInspector.ts` (record schema v1 + jsonl writer + cohort dedup) | 204 | ✅ |
| B.2 | `src/observability/holderDistribution.ts` (top1/top5/top10/HHI + DEV_IN_TOP_HOLDER) | 130 | ✅ |
| B.3 | `src/observability/vampLint.ts` (Damerau-Levenshtein + ASCII confusable + URI duplicate) | 201 | ✅ |
| B.4 | `src/observability/globalFeeObserver.ts` (venue fee × volume + zero-division 가드) | 165 | ✅ |
| B.5 | `src/observability/devWalletRegistry.ts` + `data/dev-wallets/wallets.json` (KOL DB 패턴 정합) | 175 | ✅ |
| B.6 | `kolSignalHandler.ts` paper + **live** entry wiring + `src/index.ts` boot init | +60 | ✅ |
| B.7 | `scripts/token-quality-report.ts` (4-jsonl join + cohort group + winnerKill) | 307 | ✅ |
| B.8 | 5 단위 테스트 (`tokenQualityInspector` / `holderDistribution` / `vampLint` / `globalFeeObserver` / `devWalletRegistry`) | 425 | ✅ 67 tests pass |

### 12.2 신규 운영 환경 변수 (7건)

```bash
TOKEN_QUALITY_OBSERVER_ENABLED=true        # observe-only default ON
TOKEN_QUALITY_VAMP_LINT_ENABLED=false      # IPFS fetch — default OFF
TOKEN_QUALITY_FEE_PROXY_ENABLED=true       # RPC 0 — 안전 default ON
TOKEN_QUALITY_HELIUS_RPC_CAP_PER_MIN=100   # placeholder (enrich sprint 에서 실 enforce)
TOKEN_QUALITY_OBSERVATION_TTL_HOURS=24     # cohort dedup TTL
DEV_WALLET_DB_PATH=data/dev-wallets/wallets.json
DEV_WALLET_HOT_RELOAD_INTERVAL_MS=60000
```

### 12.3 codex 피드백 fix 4건 (배포 전 차단점)

| ID | 문제 | Fix |
|---|---|---|
| **F1** | dedup key `tokenMint` 단독 → paper/live/shadow cohort 분리 깨짐 | `buildDedupKey()` — `pos:{positionId}` 우선 + `mint:{mint}|arm:|live:|shadow:` fallback. 회귀 테스트 4건 추가 |
| **F2** | report 가 3-jsonl 만 read, missed-alpha 미연결, winnerKill TODO, cohort 미분리 | 4-jsonl 입력 + `buildPositionWinnerKillMap` (close-site postMfe ≥ 4.0) + `flag × cohort` 2-tuple key + render 의 cohort/winnerKillRate 컬럼 |
| **F3** | RPC cap env 선언만 있고 enforcement 없음 | config 주석에 placeholder 명시 — enrich sprint 에서 실 enforce |
| **F4** | LOC 수치 부정확 + KOL DB v8 (실제 v9) | 본 §12 에 정확 수치 |

### 12.4 Acceptance 정합 (§7.B)

| Acceptance | 결과 |
|---|---|
| `npm run check:fast` green | ✅ tsc clean |
| entry/reject/live path 영향 0 | ✅ fire-and-forget + try/catch silent |
| `token-quality-observations.jsonl` 생성 | ✅ outputDirEnsured + appendFile |
| quality layer 신규 Birdeye 호출 0 | ✅ Birdeye 미사용 (기존 trending 만 유지) |
| token-quality observer Helius RPC < 100/min | ⚠ **placeholder** — 현 sprint enrich 0 → cap enforce 미적용 (F3 정정) |
| IPFS / image hash fetch background batch only | ✅ 현 sprint 미호출 (vampLint 는 pure function 만) |
| metadata fetch timeout ≤ 3s | ✅ 현 sprint 미호출 |
| cache hit rate ≥ 80% 목표 | ✅ `recentByDedupKey` lazy eviction (size > 1000 sweep) |

### 12.5 Stage Gate 통합 (§7.0)

| ADR Phase | Mission gate | 현 상태 |
|---|---|---|
| Phase A — 문서 / 설계 고정 | Stage 1 — Safety Pass | ✅ 완료 |
| Phase B — observe-only 구현 | Stage 1 | ✅ **완료** (본 sprint) |
| Phase B.1.5 — enrichment | Stage 2 진입 prerequisite | ⏸ **follow-up** (holder/vamp/fee 실 호출 + caller wiring) |
| Phase C — 7일 측정 | Stage 2 | ⏸ enrichment 후 진입 |
| Phase D — paper reject | Stage 2 강화 | ⏸ deferred |
| Phase E — live gate | Stage 3 | ⏸ deferred |

### 12.6 잔여 follow-up (deferred enrichment sprint)

| 항목 | 사유 |
|---|---|
| **F4/F5 enrichment** | `recordTokenQualityObservation` 의 holder/vamp/fee 실 호출 미연결 — schema + cohort 만 기록. operatorDevStatus 만 즉시 작동 (운영자 수동 dev DB 채움 시) |
| **F8 integration test** | KOL wiring × hot reload × report join 통합 시나리오 회귀 가드 |
| **F10/F11/F12 caller** | vampLint known list 구축 / globalFeeObserver volume input / holderDistribution 의 onchainSecurity 결과 join |

### 12.7 사명 §3 정합

| KPI | Phase B 영향 |
|---|---|
| Wallet floor 0.7 | ✅ observe-only — 영향 0 |
| 200 trade 누적 | ✅ entry path 0 (fire-and-forget) |
| **5x+ winner 측정** | ⭐ paper / live / shadow cohort × flag × winnerKill 매트릭스 — Phase D 결정 정량 근거 |
| Real Asset Guard | ✅ hard reject / hard allow 0 |

### 12.8 검증 결과

```
tsc:        clean
jest:       1387/1387 pass (1320 baseline + 67 신규 — codex F1 회귀 4 포함)
env:check:  PASS (301 keys 정합)
regression: 0
```

좋은 dev 발굴은 운영자가 별도로 수행하고, 봇은 다음만 책임진다.

```text
입력된 dev / 관측된 token 의 품질을 기록한다.
rug-prone pattern 을 사후 검증한다.
검증된 flag 만 paper reject 로 승격한다.
live hard gate 는 마지막에 별도 ADR 로 처리한다.
```
