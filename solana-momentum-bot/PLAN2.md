# PLAN2.md

> Updated: 2026-03-24
> Purpose: 외부 전략 평가를 현재 코드베이스와 대조해, `1 SOL -> 100 SOL` 사명 관점에서 실제로 필요한 추가 개선만 분리 기록한다.
> Scope: `PLAN.md`의 mission-first 원칙을 유지하면서, coverage / discovery / execution realism의 보강 항목만 다룬다.
> Relationship: `PLAN.md`의 상위 원칙/로드맵을 보완하는 세부 검토 문서다.
> Decision rule: 여기서 살아남은 항목만 `PLAN.md` near-term focus로 승격한다.

---

## Verdict
제안된 평가에서 `미션 관점의 핵심 문제는 coverage + discovery latency`라는 결론은 대체로 맞다.
다만 그대로 받아들이면 안 되는 항목도 있다.
- `PumpSwap 미포함` 주장은 현재 저장소 기준으로는 사실이 아니다.
- `Helius transactionSubscribe 중심 전환`은 방향성은 이해되지만, 현재 `Developer` 플랜 기준 즉시 채택 항목으로 보긴 어렵다.
현재 코드 기준 최종 판단:
- `paper 실험기`로는 의미가 있다.
- `1 -> 100 미션 엔진`으로는 아직 늦고 좁다.
- 가장 큰 병목은 `15초봉` 자체가 아니라 `발견 지연 + venue coverage 공백`이다.

---

## What Is Valid
### V1. Discovery latency is a mission-critical gap
- 현재 scanner는 `GeckoTerminal trending` 기반 발견이 중심이다.
- polling 간격도 기본 `5분`이다.
- 발견 뒤에야 realtime watchlist / ingester / measurement가 붙는다.
- 따라서 실제 체감 지연은 `발견 지연 + trigger warmup` 구조로 누적된다.
코드 근거:
- [scannerEngine.ts](./src/scanner/scannerEngine.ts)
- [config.ts](./src/utils/config.ts)
미션 해석:
- `1 -> 100`은 소수 대형 승자의 초반부를 놓치면 기대값이 크게 훼손된다.
- 따라서 이 문제는 단순 품질 개선이 아니라 mission alignment 문제다.

### V2. Warmup is effectively longer than the raw 15s/60s math
- 트리거 자체는 primary interval 기준 `lookback + 1`개가 필요하다.
- 현재 기본값으로는 `15s` 봉 `21개`가 필요해 약 `5분 15초`가 걸린다.
- confirm 봉은 동시에 쌓이므로 별도 `+3분`은 아니지만,
- 실제 운영에선 `trending` 발견 이후부터만 누적되므로 체감 지연은 더 길어진다.
코드 근거:
- [momentumTrigger.ts](./src/strategy/momentumTrigger.ts)
- [realtimeHandler.ts](./src/orchestration/realtimeHandler.ts)

### V3. Raydium CPMM coverage is a real gap
- 현재 realtime parser 지원 목록은 `Raydium V4`, `Raydium CLMM`, `Orca Whirlpool`, `PumpSwap`다.
- `Raydium CPMM`은 현재 지원 목록에 없다.
- Raydium 공식 문서상 LaunchLab 토큰은 Raydium AMM로 migrate되며, docs에는 CPMM 관련 경로가 현재 주요 라인으로 노출된다.
코드 근거:
- [swapParser.ts](./src/realtime/swapParser.ts)
외부 근거:
- Raydium LaunchLab 문서: migrated liquidity continues in a Raydium AMM pool
- Raydium docs/LaunchLab pages: CPMM 관련 post-migration 설정 노출
### V4. Execution realism needs more venue-aware inputs
- 현재 저장소는 quote decay, sell impact, spread/fee 측정은 이미 일부 갖고 있다.
- 하지만 venue별 fee model, 초기 reserve quality, buyer diversity 같은 초기 미세구조 입력은 부족하다.
이미 있는 것:
- [spreadMeasurer.ts](./src/gate/spreadMeasurer.ts)
- [paperMetrics.ts](./src/reporting/paperMetrics.ts)
- [MEASUREMENT.md](./MEASUREMENT.md)

아직 약한 것:

- venue별 fee regime 분리
- unique buyer / buyer concentration proxy
- 발견 직후 reserve quality 기반 early rejection
---
## What Is Not Valid As-Is
### N1. “PumpSwap is excluded” is outdated
- 현재 저장소는 PumpSwap parser와 eligibility를 이미 포함한다.
- 과거 문서에는 미지원으로 적혀 있었지만, 현재 코드는 그 이후 상태다.
코드 근거:
- [pumpSwapParser.ts](./src/realtime/pumpSwapParser.ts)
- [swapParser.ts](./src/realtime/swapParser.ts)
- [realtimeEligibility.ts](./src/realtime/realtimeEligibility.ts)
해석:
- PumpSwap는 여전히 중요하지만, 지금의 핵심 공백으로 적을 항목은 `미지원`이 아니라 `coverage quality / throughput / discovery 연결`이다.
### N2. “Move to transactionSubscribe now” is not an immediate plan item
- 제안 방향은 타당하지만, Helius 공식 문서상 `transactionSubscribe`는 Enhanced WebSocket 계열이며,
- 현재 공개 문서에는 Enhanced WSS가 `Business`와 `Professional` 플랜에서 제공된다고 적혀 있다.
- 따라서 현재 `Developer` 전제라면 즉시 채택 가능한 작업으로 적기는 어렵다.
외부 근거:
- Helius Enhanced WebSockets docs
- Helius transactionSubscribe docs
해석:
- 현재 단계에선 `logsSubscribe 기반 구조를 최대한 활용하면서 coverage/discovery를 먼저 개선`하는 편이 우선이다.
- 플랜 업그레이드가 확인되면 별도 재검토한다.

---

## Required Additions For Mission
아래 4개는 `PLAN.md`의 보완 항목이 아니라, 미션 관점의 사실상 필수 추가 과제로 본다.
### R1. Discovery layer redesign
> Status: in progress — Dex boosts + Dex latest token profiles/community takeovers/ads promoted to discovery sources, Gecko `new_pools` feed added, Gecko `new_pools` cadence separated from slower trending fallback, Dex discovery cadence separated from Dex enrichment, scanner Birdeye WS dependency removed; remaining work is runtime tuning rather than missing feed coverage

목표:
- `trending`을 발견 엔진이 아니라 랭킹/우선순위 신호로 낮춘다.
- 더 빠른 신규 풀 발견 경로를 별도로 둔다.
작업:
1. `new pools` 계열 feed/endpoint 기반 후보 발견 경로 검토
2. `trending`은 ranking/enrichment 용도로 재배치
3. 발견 polling cadence를 `5분`보다 훨씬 짧게 운영할 수 있는 구조 설계
진행:
- DexScreener boosts가 startup/enrichment discovery source로 승격됐다.
- DexScreener `token-profiles/latest`가 startup/enrichment discovery source로 추가됐다.
- DexScreener `community-takeovers/latest`, `ads/latest`도 fast discovery source로 추가됐다.
- Dex discovery polling이 Dex enrichment polling과 분리돼, fresh-source 재탐색을 더 짧게 돌릴 수 있게 됐다.
- Dex source가 watchlist를 채운 경우 Gecko trending poll은 open-slot fallback으로만 동작하도록 축소됐다.
- GeckoTerminal `new_pools` endpoint가 dedicated discovery source로 추가됐다.
- Gecko `new_pools` poll과 Gecko trending fallback poll도 분리돼, fast discovery와 slower ranking fallback budget을 따로 운영할 수 있게 됐다.
- scanner lane-B fallback도 underlying discovery source attribution을 유지한다.
- scanner는 더 이상 Birdeye WS `newListing/newPair` 경로에 의존하지 않는다.
- Strategy D는 Birdeye WS adapter가 없어도 scanner lane-B 후보를 listing fallback source로 사용할 수 있다.
- discovery source attribution은 Strategy D signal/order, signal audit log, trade store, paper metrics summary까지 이어지도록 저장된다.
- AttentionScore / gate trace도 signal audit log와 position signal_data에 snapshot으로 저장된다.
- source별 live outcome은 daily summary에서 `trades / win rate / pnl by source`로 확인 가능하다.
남은 것:
- live 운영 데이터 기준으로 `SCANNER_TRENDING_POLL_MS` / `SCANNER_GECKO_NEW_POOL_MS`를 추가 튜닝
미션 필요성:
- 가장 큰 수익 구간이 첫 `5~15분`에 집중되는 경우, 현재 구조의 발견 지연은 치명적이다.
### R2. Immediate seed after discovery
> Status: implemented — recent swap backfill + trade-based seed + warmup telemetry

목표:
- 발견 직후 최근 거래/초기 캔들로 micro-candle history를 즉시 seed한다.
- “발견 후 5분 대기”를 줄인다.
작업:
1. 발견 직후 recent trades 또는 대체 가능한 시계열 backfill 경로 추가
2. primary/confirm interval의 초기 history를 synthetic이 아니라 실제 trade 기반으로 빠르게 채움
3. trigger warmup latency를 측정 지표로 기록
미션 필요성:
- 초기 폭발 구간 포착률을 높이는 가장 직접적인 개선이다.
### R3. Raydium CPMM coverage
> Status: implemented — parser/eligibility/fallback coverage 추가 완료

목표:
- 현재 Raydium 커버리지를 `V4/CLMM`에서 `CPMM`까지 확장한다.
작업:
1. CPMM program / pool metadata 식별
2. parser / eligibility / replay coverage 추가
3. 기존 Raydium/Orca/PumpSwap 회귀 없이 smoke 검증
미션 필요성:
- 현재 venue coverage 공백 중 가장 명확하고 mission-critical한 항목이다.

### R4. Security Gate: Birdeye → Helius RPC 온체인 전환

> Added: 2026-03-24
> Status: implemented in code — live verification/document cleanup pending

#### 현상

- `securityGate.ts:52-58`: security data가 `null`이면 무조건 reject
- Birdeye API 키가 없거나 호출 실패 시 `TokenSecurityData = null` → 전량 reject
- 현재 VPS live 모드에서 이 경로로 **모든 시그널이 차단**되고 있음

#### 왜 Birdeye가 본질적으로 불필요한가

Security Gate가 검사하는 5개 항목 중 4개는 온체인 데이터로 100% 대체 가능:

| 검사 항목 | 현재 소스 | 대체 소스 (Helius RPC) | 방법 |
|-----------|-----------|----------------------|------|
| freezeAuthority | Birdeye `isFreezable` | `connection.getParsedAccountInfo(mint)` | `parsed.info.freezeAuthority !== null` |
| mintAuthority | Birdeye `isMintable` | 동일 호출 | `parsed.info.mintAuthority !== null` |
| transferFee (Token-2022) | Birdeye `hasTransferFee` | 동일 호출 | `parsed.info.extensions` 내 `transferFeeConfig` 존재 여부 |
| top10 holder 집중도 | Birdeye `top10HolderPct` | `connection.getTokenLargestAccounts(mint)` | 상위 10개 balance / total supply 비율 |
| exitLiquidity (24h sell/buy) | Birdeye API | 직접 대체 불가 | 이미 Quote Gate (priceImpact) + Safety Gate (TVL/liquidity)에서 커버 |

- 추가 API 키 불필요. 기존 `HELIUS_API_KEY`의 RPC endpoint면 충분
- 온체인 직접 조회가 Birdeye API보다 정확하고 실시간
- RPC 호출 2회 (`getParsedAccountInfo` + `getTokenLargestAccounts`)로 완결

#### 작업 항목

| # | 작업 | 상세 |
|---|------|------|
| R4-1 | `src/ingester/onchainSecurity.ts` 신규 모듈 | Helius RPC 기반 `fetchTokenSecurity(mint, connection)` 구현 |
| R4-2 | `TokenSecurityData` 인터페이스 유지 | 기존 `securityGate.ts` 입력 타입을 그대로 채워 gate 로직 변경 최소화 |
| R4-3 | `exitLiquidity` 경로 정리 | Birdeye exitLiquidity 제거, `exitLiquidity = null` 시 기존 soft reject 유지 |
| R4-4 | Gate 호출 경로 수정 | `realtimeHandler.ts`, `candleHandler.ts`에서 Birdeye client 대신 `onchainSecurity` 호출 |
| R4-5 | Birdeye 의존 제거 | security/exitLiquidity 관련 메서드를 dead code로 마킹, 나머지 기능은 optional 유지 |
| R4-6 | 테스트 | freeze/mint/transferFee/holder 각 케이스와 onchain mock 추가 |

#### 미션 필요성

- P1 원칙의 전제 조건은 **시그널이 gate까지 도달해야** 설명 여부를 판단할 수 있다는 점이다.
- Security Gate가 데이터 부재로 전량 reject하면 봇은 사실상 비활성 상태다.
- Birdeye 의존 제거는 외부 API 장애 시 봇 전체 정지를 피하는 안정성 개선이기도 하다.

#### 완료 기준

- [x] Birdeye API 키 없이 `securityGate` 통과 가능
- [x] freeze/mint/transferFee/holder 검사가 온체인 데이터로 정상 동작
- [ ] 기존 테스트 스위트 통과
- [ ] VPS live 모드에서 `security_rejected` (`NO_SECURITY_DATA`) 발생률 0%
---
## Secondary Additions
### S1. Venue-aware cost model
- venue별 fee regime을 measurement에 반영
- early pool reserve/liquidity quality를 별도 feature로 추적
### S2. Buyer diversity proxy
- unique buyer 또는 유사 proxy를 watchlist/gate/measurement 후보 feature로 검토
### S3. PumpSwap quality follow-up
- “지원 여부”가 아니라 `fallback throughput`, `parse rate`, `fee-aware evaluation` 중심으로 후속 개선
---
실행 순서는 `blocker 복구 -> discovery/coverage 확장 -> cost model 보강` 순서로 둔다.

## Priority
1. `Security Gate → Helius RPC 전환`
2. `Discovery redesign`
3. `Immediate seed after discovery`
4. `Raydium CPMM coverage`
5. `Venue-aware cost model`
6. `transactionSubscribe / Enhanced WSS`는 현재 플랜 조건 확인 후 별도 검토

---

## One-Line Summary

> 이 평가에서 실제로 받아들여야 할 핵심은 `PumpSwap 미지원`이 아니라, `발견이 늦고 Raydium CPMM이 비어 있으며 초기 캔들 시드가 느리다`는 점이다. 다만 그 전에 `Security Gate의 Birdeye 의존`이라는 live blocker를 먼저 제거해야 한다.
