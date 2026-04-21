# Survival Layer — Tier B Follow-up Design

> Status: design record (implementation pending)
> Date: 2026-04-21
> Scope: mission-refinement-2026-04-21 § 4 Layer 1 (Survival) 의 Tier B 항목
> Related: `docs/design-docs/mission-refinement-2026-04-21.md` §4 / `Block_QA.md` Survival Layer P0
> Implementation authority chain: 본 문서 → 각 항목 구현 sprint 별 상세 설계

## Tier A (완료 2026-04-21)

Tier A 는 security gate 재연결 + Token-2022 dangerous extension hard reject + Active Sell Quote Probe 로 구성됨. 상세: `Block_QA.md` / `project_survival_layer_p0_2026_04_21.md` / `project_survival_layer_tier_b1_2026_04_21.md`.

## Tier B 후보 (본 문서 대상)

| # | 항목 | 우선순위 | 구현 비용 | 본 문서 범위 |
|---|------|---------|----------|-------------|
| B-1 | Active Sell Quote Probe (exitability) | **완료 (2026-04-21)** | 중 | 이미 `src/gate/sellQuoteProbe.ts` |
| B-2 | LP Lock / Unlock 확인 | 중 | 중 | 설계 기술 |
| B-3 | Bundler same-slot tx cluster 감지 | 중 | 상 | 설계 기술 |
| B-4 | Dev Wallet Pattern DB | 하 | 상 | 설계 기술 |

이하 B-2 ~ B-4 각각의 **요구사항 / 데이터 소스 / 구현 윤곽 / 통합 위치 / 위험** 을 정리한다.

---

## B-2. LP Lock / Unlock 확인

### 목적

Pool liquidity provider (LP) 토큰 이 소각 (burn) 또는 **lock authority (예: lockProgram, Streamflow)** 에 묶여있지 않으면, LP 생성자가 **rug pull** 로 liquidity 를 빼갈 수 있다. 특히 pump.fun graduation 후 migration 되지만 lock 되지 않은 pool 이 흔한 rug 벡터.

### Raydium CPMM / CLMM 기준 데이터 소스

1. **LP mint 주소**: Raydium pool keys 에서 얻는다.
   - CPMM v4: `poolKeys.lpMint`
   - CLMM: position NFT 기반, 별도 방식
2. **LP token supply**: `getParsedAccountInfo(lpMint)` → `supply`, `decimals`
3. **LP token holders 상위**: `getTokenLargestAccounts(lpMint)` → top-N accounts
4. **소각 여부**: supply 의 상당 부분 (e.g. 95%+) 이 **burn address** `1nc1nerator11111111111111111111111111111111` 에 있는가
5. **Lock 여부**: lock program (Streamflow, GoFundMeme lock) 의 PDA 에 있는가

### 외부 Orca Whirlpool

Concentrated liquidity 특성상 "lock" 개념이 다름 — 포지션 NFT 이동 제한 / Streamflow 에 묶여있는가 확인.

### 구현 윤곽

```ts
// src/gate/lpLockGate.ts
export interface LpLockStatus {
  lpMint: string | null;
  totalSupplyRaw: string;
  burnedRaw: string;
  lockedRaw: string;
  burnedPct: number;      // 0~1
  lockedPct: number;
  effectiveLockedPct: number; // max(burned, locked, burned+locked)
}

export async function evaluateLpLockGate(
  tokenMint: string,
  poolAddress: string,
  connection: Connection,
  cfg: { minEffectiveLockedPct: number; burnAddresses: string[]; lockProgramIds: string[] },
): Promise<{ approved: boolean; reason?: string; status: LpLockStatus }>;
```

### Threshold 초안

- `minEffectiveLockedPct`: 0.80 ~ 0.95 (보수적)
- Burn addresses: incinerator + known token burn programs
- Lock program IDs: Streamflow (Solana), GoFundMeme, lockProgram v2 등 — **사전 수집 목록** 필요

### pure_ws 통합 위치

- `checkPureWsSurvival` 내부에서 `poolAddress` 가 resolve 된 경우만 호출
- pair 가 여러 pool 에 걸쳐있으면 primary pool (liquidity 가장 큰) 기준

### 주요 위험

1. **pool resolution**: signal.pairAddress 는 token mint 이지만 lpMint 는 pool registry 조회 필요. Helius pool registry 또는 Jupiter quote response 에서 추출 가능.
2. **Lock program 목록 유지**: 새 lock program 이 등장하면 false negative. 주기 업데이트 필요.
3. **False positive on CLMM**: concentrated liquidity 는 lp token 방식이 다름 — CLMM 은 별도 handling.

### 성과 지표

- `burned+lockedPct < 0.8` 인 pool 을 차단했을 때 rug event (WALLET_DELTA HALT / emergency close) 감소율
- false positive rate (오차단된 pool 중 실제 매도 가능했던 비율)

---

## B-3. Bundler Same-Slot Cluster Detection

### 목적

Pump.fun / Moonshot 류 토큰에서 **bundler** (여러 지갑으로 동일 slot 에 동시에 buy 하여 price 를 펌핑) 가 흔함. 봇이 bundler pump 의 꼭대기에 탑승하면 즉시 dump 당함. 봇의 진입 시점 기준 최근 N slot 의 same-slot tx cluster 를 감지하면 이를 사전 차단 가능.

### 데이터 소스 (후보)

1. **Helius Geyser stream** (최선): slot 별 tx 원본 stream. 특정 토큰 swap tx 의 signer 분포 + slot 분포 추출.
2. **Helius enhanced transactions API**: 특정 pool 의 최근 tx 를 slot 과 함께 가져옴. cold-call 이라 latency 높음.
3. **Jupiter swap aggregation 통계**: 제한적, cluster 감지에는 부족.

### 검출 Heuristic

```
최근 M slot (e.g. M=5) 내 해당 pool 에 대한 BUY tx 수 집계:
  - unique signers 수 / total BUY tx 수 → diversity ratio
  - diversity > 0.8 → 정상 (많은 독립 지갑)
  - diversity < 0.3 → bundler 의심
  - total BUY tx >= N (e.g. 10) + diversity < threshold → reject

또는 signer 클러스터링:
  - 최근 M slot 의 BUY signer 들 중 동일 funding source (1-hop) 비율
  - > 50% → bundler 의심
```

### 통합 위치 / 방식

- 진입 직전 `evaluateBundlerCluster(tokenMint, connection)` 호출
- latency 영향 고려 — 실시간 stream 이 아니면 async precompute + cache 필요
- pure_ws handler 의 survival check 최하단 (optional)

### 주요 위험

1. **Latency**: 실시간 slot history 조회는 RPC 부하 큼. geyser stream 이 현실적.
2. **False positive**: high-volume legit 토큰도 순간 diversity 낮아질 수 있음.
3. **Infra 투자**: geyser 통합은 기존 Helius WS 와 별도 stream 필요.

### 성과 지표

- Bundler-detected pair 진입 차단 후, 같은 pair 의 후속 30분 price 가 signal 대비 -30% 이하로 dump 되는 비율
- false positive rate (차단됐지만 실제 legit 이었던 pair)

---

## B-4. Dev Wallet Pattern DB

### 목적

Solana meme 에코시스템은 **동일 dev 가 반복 launch**하는 rug pattern 이 많다. 과거 rug 전력이 있는 지갑이 deploy / initial LP provider 인 토큰을 사전 차단하면 예측 가능한 rug 회피 가능.

### 데이터 소스 (후보)

1. **자체 DB 구축**:
   - Solana blockchain history backfill: 최근 90일 토큰 mint 이벤트 수집
   - 각 mint 의 creator / first LP provider / 주요 초기 holder 식별
   - 해당 mint 의 "rug score" (liquidity 고갈 이벤트 / honeypot 판정 / 90일 later price) 태깅
   - 지갑별 aggregate: `N_tokens_launched`, `rug_rate`, `median_10x_rate`
2. **External**:
   - RugCheck.xyz API
   - Bitquery / Helius enhanced transactions

### 구현 윤곽

```ts
// src/ingester/devWalletDb.ts
export class DevWalletDb {
  // deployer wallet 의 rug 전력 + 성공 전력 조회
  async getWalletReputation(wallet: string): Promise<{
    totalLaunches: number;
    rugRate: number;   // 0~1
    successRate10x: number;
    lastLaunchAt: Date | null;
    verdict: 'clean' | 'neutral' | 'watchlist' | 'blacklist';
  } | null>;
}
```

### 통합 위치

- token deploy event 감지 시 즉시 deployer wallet 조회 (Helius enhanced tx API 로 mint authority 확인)
- `pureWsSurvivalCheckEnabled` 에 옵션으로 추가
- `blacklist` 판정 시 hard reject, `watchlist` 시 size reduction 또는 drift guard tighter

### 주요 위험

1. **Backfill 규모**: Solana 90일 × 하루 수천 토큰 → 상당한 지갑/tx 수. ingester 구축 비용 큼.
2. **False positive**: 단일 성공 dev 도 실패 전력 있을 수 있음. 다양한 지표 가중치 필요.
3. **Data freshness**: rug 이후 24h 내 식별 필요. pipeline 주기 < 1h 권장.
4. **Privacy / ethics**: 특정 지갑을 "blacklist" 하는 것은 트레이딩 봇 관점에서 적법하지만, 오분류 대비 appeal 경로 고려.

### 성과 지표

- Blacklist wallet 의 신규 launch 중 rug 재발 비율 (기존 통계 대비)
- Watchlist wallet 의 sizing 감소가 wallet log growth 에 미친 영향

---

## 통합 순서 제안

1. **B-1 (완료)**: Active Sell Quote Probe — Jupiter quote 기반, 단독 모듈, infra 의존성 낮음.
2. **B-2 Next**: LP Lock — pool registry 가 이미 있으면 구현 범위 작음. 구현 우선순위 2순위.
3. **B-3 다음**: Bundler detection — geyser infra 필요. 별도 sprint.
4. **B-4 마지막**: Dev wallet DB — 가장 큰 인프라 투자. Stage 2 통과 후 "Stage 3 데이터 축적 중 병렬 구축" 이 적합.

## Mission Refinement 와의 정합성

Tier B 는 모두 **Real Asset Guard 가 아니라 Survival Layer 의 확장**이다. 운영자는:

- B-2 ~ B-4 가 없더라도 **Stage 1 Safety Pass 통과 가능** (Tier A + B-1 으로 pass 기준 `survival filter pass rate >= 90%` 달성 가능)
- B-2 ~ B-4 는 Stage 2 sample accumulation 진행 중 **관측 중 rug event 가 얼마나 남는가** 에 따라 우선순위 동적 조정
- 구현은 별도 sprint, 각 항목에 대해 본 문서 갱신 + Block_QA 섹션 추가
