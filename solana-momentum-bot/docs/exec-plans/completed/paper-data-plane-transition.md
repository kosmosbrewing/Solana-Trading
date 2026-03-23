# Birdeye -> GeckoTerminal + DexScreener 전환 정리

> Last updated: 2026-03-21
> Scope: Paper runtime 기준 데이터 플레인 전환 결과와 운영 제약 정리
> Status: 전환 구현 완료, 운영 안정화 진행 중
> Document type: operational note
> Authority: 전환 배경과 제약을 설명하는 참고 문서. 현재 운영값은 `OPERATIONS.md`를 우선한다.

---

## 한 줄 요약

Birdeye 무료 쿼터 의존으로는 paper 검증을 지속할 수 없어서, 현재 paper runtime은 **GeckoTerminal + DexScreener 중심**으로 전환했다. 다만 평균 요청량 계산만으로는 충분하지 않았고, 실제 병목은 **burst/concurrency + watchlist churn**이었다.

---

## 현재 상태

### 전환 완료 범위

| 영역 | 현재 소스 | 메모 |
|------|-----------|------|
| 5m/4h OHLCV | GeckoTerminal | ingester + regime에서 사용 |
| Trending discovery | GeckoTerminal | scanner + event monitor 공용 |
| 토큰 메타/보강 | DexScreener | pair 매핑, liquidity/volume 보강 |
| Watchlist 운영 | ScannerEngine | score cutoff + reentry cooldown 적용 |

### 아직 Birdeye가 남아 있는 영역

| 영역 | 상태 | 메모 |
|------|------|------|
| `scripts/fetch-candles.ts` | 유지 | 백테스트 CSV 수집은 아직 Birdeye 사용 |
| Security / exit-liquidity gate | live 경로 중심 | premium 의존 기능은 paper에서 비활성 또는 선택 경로 |
| WebSocket 실시간 소스 | optional | 구조는 남아 있으나 현재 paper 핵심 경로는 polling 기반 |
| `scripts/deploy.sh` env 체크 | legacy | 아직 `BIRDEYE_API_KEY` 존재 여부를 검사함 |

---

## 운영에서 확인된 실제 병목

### 틀렸던 가정

- `16 pairs x 5분 poll`만 보고 평균 요청량을 계산하면 GeckoTerminal 30 req/min 한도 안에 들어가는 것처럼 보였다.
- 실제 문제는 평균 req/min이 아니라 **동시 호출이 한 시점에 몰리는 burst**였다.
- scanner가 prune 전에 후보를 내보내면서, 곧바로 탈락할 후보까지 `backfill`을 일으켜 호출량을 불필요하게 키웠다.

### 실제로 들어간 안정화 패치

| 차수 | 변경 | 목적 |
|------|------|------|
| 1차 | Gecko 요청 직렬화 + pair별 poll offset | 동시 OHLCV burst 완화 |
| 1차 | startup backfill 간격 확대 | 초기 기동 시 과도한 연속 호출 완화 |
| 2차 | survive-prune 후보만 `candidateDiscovered` emit | 즉시 탈락 후보 backfill 차단 |
| 2차 | `SCANNER_REENTRY_COOLDOWN_MS` 도입 | evict 직후 재진입 churn 억제 |
| 3차 | trending in-flight dedupe | scanner/event 중복 호출 제거 |
| 3차 | SOL 4H regime cache | 15분마다 4h 캔들 재조회 방지 |

---

## 현재 운영 기준값

| 항목 | 현재 값 | 이유 |
|------|---------|------|
| `MAX_WATCHLIST_SIZE` | `8` | Gecko 한도와 churn을 동시에 보수적으로 관리 |
| `SCANNER_REENTRY_COOLDOWN_MS` | `1_800_000` (30분) | 같은 후보 재백필 루프 차단 |
| startup backfill gap | `5s` | 초기 queue 압력 완화 |
| Gecko request gap | 직렬화 + 동적 backoff | 429 대응 |
| SOL 4H regime cache TTL | `1h` | 같은 4h 버킷 재조회 축소 |

---

## 현재 해석

### 개선된 점

- `poll failed`는 초기 상태 대비 유의미하게 감소했다.
- watchlist churn으로 인한 불필요한 `dynamic pair added / backfill`도 크게 줄였다.
- scanner / event monitor / regime가 같은 Gecko 데이터를 덜 중복해서 쓰게 됐다.

### 아직 남은 리스크

- Gecko `429`가 완전히 0은 아니다.
- 병목은 이제 단일 scanner보다 **EventMonitor + Regime + Ingester 합산 호출량**에 더 가깝다.
- paper DB/HWM 오염은 별개 문제다. 수익성 검증 전 baseline 정리가 필요하다.

---

## 운영 원칙

1. watchlist breadth보다 **설명 가능한 후보의 안정적 유지**를 우선한다.
2. 평균 req/min 계산보다 **burst/concurrency**를 먼저 의심한다.
3. 후보 발견은 넓게 하되, 실제 backfill은 **survive-prune 후보**에만 허용한다.
4. paper 검증은 수익률보다 먼저 **데이터 연속성**을 통과해야 유효하다.

---

## 당장 볼 지표

- `GeckoTerminal 429 count`
- `Poll failed count`
- `No candle received` 경고 빈도
- `dynamic pair added / backfilled` churn
- `Signal -> Trade` 전환 수

---

## 다음 단계

1. 6~24시간 paper run으로 429/lag/churn이 실제로 안정화되는지 확인한다.
2. paper DB의 HWM / closed trade state를 분리하거나 초기화해 baseline을 재설정한다.
3. 안정화가 확인되면 `MAX_WATCHLIST_SIZE`를 `8 -> 12 -> 16` 순으로 단계적으로 올린다.
