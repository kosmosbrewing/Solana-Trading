# Helius Data Plane Transition

상태: proposed  
최종 검증: 2026-03-31

## 목적

`GeckoTerminal + DexScreener + Helius + Jupiter`로 분산된 현재 데이터 플레인을,
운영 해석이 가능한 범위까지 `Helius-first` 구조로 점진 전환한다.

핵심 목표:

1. `Gecko 429`가 watchlist / regime / ingester 해석을 오염시키는 문제를 줄인다.
2. `tokenMint -> best pair/pool` 해석을 외부 API 응답 형식에서 분리한다.
3. 실시간 swap 기반 집계를 재사용해 OHLCV와 신규 풀 탐지를 내부화한다.

## 대체 가능 / 불가 구분

### Helius로 대체 가능한 것

- realtime swap ingest
- historical tx / swap replay
- token mint / holder / authority 기반 security
- pool creation / mint creation event stream
- 내부 candle 집계용 원시 거래 데이터
- 내부 pair registry 구축용 원시 transaction/log 데이터

### Helius만으로 직접 대체 불가능한 것

- GeckoTerminal `trending` 같은 외부 랭킹 제품
- DexScreener `boosts / ads / community takeover / profile`
- Jupiter quote / route / execution

즉 목표는 `Helius-only`가 아니라:

- market data / pair registry / discovery는 가능한 한 Helius로
- marketing feature는 DexScreener optional 보조
- execution quote는 Jupiter 유지

## 현재 코드 기준 교체 지점

### 지점 A. tokenMint -> pair 해석

현재:

- scanner discovery 후 `DexScreener.getTokenPairs(tokenMint)`
- regime에서 `getBestPoolAddress(SOL_MINT)`
- universe refresh에서 DexScreener pair lookup 사용

해결:

- `TokenPairResolver` 경계 추가
- `HeliusPoolRegistry -> DexScreener fallback` 구조로 이동

### 지점 B. OHLCV

현재:

- ingester / regime / universe spread proxy가 Gecko OHLCV에 의존

해결:

- Helius realtime swap 저장소에서 `1m/5m/15m/4H`를 내부 집계
- Gecko OHLCV는 fallback 또는 bootstrap 전용으로 축소

### 지점 C. discovery

현재:

- Gecko trending / new_pools
- Dex boosts / profiles / ads / takeover

해결:

- 신규 풀 발견은 Helius webhook / tx stream으로 내부화
- trending은 내부 score로 대체하되, Dex marketing 피처는 optional 유지

## 단계별 로드맵

### Phase 1. Resolver Boundary

목표:

- pair lookup 경계를 분리해 이후 Helius registry를 꽂을 수 있게 한다.

작업:

- `TokenPairResolver` interface 도입
- `HeliusPoolRegistry` 추가
- `CompositeTokenPairResolver`로 `registry -> DexScreener` fallback 구성
- `index.ts`, `UniverseEngine`가 resolver만 사용하도록 전환

### Phase 2. Helius Pool Registry Population

목표:

- 외부 pair lookup을 줄일 수 있을 만큼 내부 registry를 채운다.

작업:

- Helius `CREATE_POOL` / pool init tx를 ingest
- realtime eligibility / subscription 과정에서 확인된 pool metadata를 registry에 적재
- tokenMint별 best SOL pair 캐시 유지

### Phase 3. Internal Candle Aggregation

목표:

- Gecko OHLCV 의존을 regime / spread proxy / ingester에서 단계적으로 제거한다.

작업:

- persisted swap 또는 micro candle에서 `1m/5m/15m/4H` rollup
- regime는 internal 4H candles 우선 사용
- spread proxy는 recent internal candles 우선 사용
- Gecko는 fallback만 담당

### Phase 4. Internal Trending Score

목표:

- Gecko trending을 내부 후보 랭킹으로 치환한다.

작업:

- 최근 `unique swappers`, `swap acceleration`, `buy/sell imbalance`, `new holder growth`, `SOL quote quality`
- scanner candidate source로 `helius_trending` 추가

## 이번 패치에서 실제 반영한 것

- `TokenPairResolver` 경계 추가
- `HeliusPoolRegistry` 추가
- `CompositeTokenPairResolver`로 internal-first fallback 구성
- Helius observed pair / pool metadata를 registry에 적재
- Helius pool-init discovery 추가 (`program logs -> parsed tx -> registry upsert`)
- `InternalCandleSource` 추가
- `UniverseEngine` spread proxy는 internal 1m candles 우선 사용
- `RegimeFilter` SOL 4H 입력은 internal aggregated candles 우선 사용
- realtime position monitoring은 internal aggregated 5m candles 우선 사용
- realtime 모드에서는 Gecko ingester를 시작하지 않음
- paper/legacy ingester는 startup 시 기존 internal candles로 lastFetchTime을 복구하고 recent backfill을 생략
