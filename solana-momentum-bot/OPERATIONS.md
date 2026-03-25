# Operations Guide

> Last updated: 2026-03-25
> Scope: VPS 배포 + paper 운영 점검 + risk tier demotion + live 운영 판단

---

## VPS Paper Trading 배포

### Prerequisites

| 항목 | 요구사항 |
|------|---------|
| OS | Ubuntu 22.04 LTS |
| Node.js | >= 20.x |
| DB | TimescaleDB (PostgreSQL 16 + timescaledb extension) |
| pm2 | `npm install -g pm2` |
| Memory | 최소 1GB RAM |

### 배포 절차

```bash
# 1. 코드 클론
git clone <repo> && cd solana-momentum-bot

# 2. .env 설정
cp .env.example .env
# 필수 값 입력: SOLANA_RPC_URL, WALLET_PRIVATE_KEY, DATABASE_URL
# VPS_APP_PROFILE=shadow
# TRADING_MODE=paper
# REALTIME_ENABLED=true

# 3. 자동 배포
npm run deploy:vps
```

### Paper Mode .env 핵심 설정

```env
VPS_APP_PROFILE=shadow
TRADING_MODE=paper
REALTIME_ENABLED=true
REALTIME_PERSISTENCE_ENABLED=true
SCANNER_ENABLED=true
MAX_WATCHLIST_SIZE=8
REALTIME_MAX_SUBSCRIPTIONS=5
REALTIME_SEED_BACKFILL_ENABLED=false
REALTIME_DISABLE_SINGLE_TX_FALLBACK_ON_BATCH_UNSUPPORTED=true
REALTIME_SEED_ALLOW_SINGLE_TX_FALLBACK=false
SCANNER_REENTRY_COOLDOWN_MS=1800000
EVENT_POLLING_INTERVAL_MS=1800000
SHADOW_RUN_MINUTES=1440
SHADOW_SIGNAL_TARGET=100
SHADOW_HORIZON_SEC=30
# WS/Strategy D는 기본 false — 설정 불필요
# BIRDEYE_WS_ENABLED=false (기본값)
# STRATEGY_D_ENABLED=false (기본값)
```

### 현재 권장 운영 메모

- `MAX_WATCHLIST_SIZE=8`은 paper 안정화용 보수값이다.
- watchlist를 늘리기 전에 `429`, `Poll failed`, `No candle received`가 먼저 안정화돼야 한다.
- scanner churn 억제를 위해 `SCANNER_REENTRY_COOLDOWN_MS=1800000`을 유지한다.
- 현재 live/paper bootstrap 기본은 Helius `Developer` tier 기준이다.
- startup burst가 남아 있으면 `REALTIME_SEED_BACKFILL_ENABLED=false`를 유지한다.
- `REALTIME_DISABLE_SINGLE_TX_FALLBACK_ON_BATCH_UNSUPPORTED=true`,
  `REALTIME_SEED_ALLOW_SINGLE_TX_FALLBACK=false`는 Helius 플랜과 무관하게 유지한다.

### 가동 확인 체크리스트

- [ ] `pm2 status` — `momentum-shadow` online
- [ ] `pm2 list` — legacy `momentum` 프로세스가 남아 있지 않은지 확인
- [ ] `pm2 logs momentum-shadow` — shadow session start / export summary 확인
- [ ] child runtime log에서 `Bot started ... mode: paper` 확인
- [ ] child runtime log에서 `Scanner started. Watchlist: 8 entries.` 확인
- [ ] `candidateDiscovered`가 실제 retained watchlist 후보에만 발생하는지 확인
- [ ] Gate 평가 로그 출력
- [ ] Telegram alert 수신 (`Bot started` 메시지)
- [ ] `GeckoTerminal 429 rate limited`가 반복적으로 쌓이지 않는지 확인
- [ ] `No candle received for ... minutes` 경고가 장시간 누적되지 않는지 확인
- [ ] 24시간 후: `pm2 monit` — memory < 300MB, restart 0

### 핵심 운영 지표

- `GeckoTerminal 429 count`
- `Poll failed count`
- `No candle received` 경고 빈도
- `dynamic pair added / backfilled` churn
- `explained entry ratio`
- `gate reject (unique token)` 상위 이유
- `pre-watchlist reject` / `realtime skip` 상위 이유
- `realtime-ready ratio`

### 모니터링 명령어

```bash
pm2 status              # 프로세스 상태
pm2 logs momentum-shadow # shadow runner 로그
pm2 logs momentum-bot   # bot 단독 프로필일 때
pm2 monit               # CPU/memory 모니터
pm2 restart momentum-shadow # shadow 재시작
pm2 stop momentum-shadow   # shadow 중지
```

### Telegram Alert 연결

`.env`에 설정:
```env
TELEGRAM_BOT_TOKEN=<BotFather에서 발급>
TELEGRAM_CHAT_ID=<봇에게 메시지 보낸 후 getUpdates API로 확인>
```

4-level alert: Critical / Warning / Trade / Info.

### 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| `Missing required env var` | .env 누락 | .env.example 참고 후 값 입력 |
| DB connection refused | TimescaleDB 미실행 | `sudo systemctl start postgresql` |
| `TimescaleDB not available` | extension 미설치 | `CREATE EXTENSION IF NOT EXISTS timescaledb;` |
| Memory > 500MB | 메모리 릭 가능성 | `pm2 restart momentum-bot` + 로그 확인 |
| Scanner 0 candidates | 시장 비활성, Gecko/Dex 소스 문제, 필터 과도 | `Trending discovery` 로그, `SCANNER_MIN_WATCHLIST_SCORE`, `MIN_POOL_TVL` 확인 |
| `GeckoTerminal 429 rate limited` 반복 | burst/concurrency 또는 watchlist churn | `MAX_WATCHLIST_SIZE=8` 유지, `SCANNER_REENTRY_COOLDOWN_MS` 확인, startup/backfill churn 로그 확인 |
| `Realtime seed backfill failed ... 429` 반복 | Helius startup burst | `REALTIME_SEED_BACKFILL_ENABLED=false` 유지, `REALTIME_MAX_SUBSCRIPTIONS=5` 확인 |
| `No candle received for ... minutes` | 특정 pair poll 누락 또는 Gecko 지연 | pair별 backfill/poll 로그 확인, regime/event 주기 과도 여부 점검 |

### Daily Summary 해석 원칙

- `gate reject`는 `FILTERED 전체`가 아니라 **gate-origin reject만** 본다.
- count는 event 수가 아니라 **unique token 수** 기준으로 해석한다.
- `realtime-ready ratio`는 단순 watchlist accept 비율이 아니라,
  `prefilter reject + admission skip + ready candidate`를 모두 포함한 **실제 realtime-ready 비율**이다.
- `24h Data Plane` 수치는 `data/realtime/runtime-diagnostics.json`을 통해 PM2 restart 후에도 이어진다.

### 운영 해석 메모

- 평균 req/min 계산만으로는 Gecko 안정성을 판단하지 않는다.
- 한 시점에 몰리는 burst와 watchlist churn이 실제 병목이다.
- paper 기준으로는 “더 많은 후보”보다 “설명 가능한 후보를 끊김 없이 추적”하는 것이 우선이다.

---

## Demotion Runbook

자동 강등은 최근 성과 악화를 감지했을 때 위험 노출을 한 단계 내리는 안전장치다. 승급 이력을 지우는 기능이 아니라, 최근 구간이 망가졌을 때 **현재 사이징만 즉시 보수화**하는 장치로 본다.

### 적용 위치

- 포트폴리오 모드: `resolveRiskTierWithDemotion(edgeTracker, recoveryPct, 'portfolio')`
- 전략 모드: `resolveRiskTierWithDemotion(edgeTracker, recoveryPct, strategyName)`
- 실제 주문 경로: `riskManager.checkOrder()`

### 강등 규칙

| 현재 티어 | 최근 구간 | 강등 조건 |
|----------|-----------|-----------|
| `Proven` | 최근 20 trades | WR `< 35%` 또는 R:R `< 1.0` 또는 연속 손실 `>= 5` |
| `Confirmed` | 최근 15 trades | WR `< 30%` 또는 R:R `< 0.8` 또는 연속 손실 `>= 5` |

강등 결과:

- `Proven -> Confirmed`
- `Confirmed -> Calibration`
- `Bootstrap`, `Calibration`은 추가 강등 없음

### 강등 시 즉시 바뀌는 것

| 항목 | 변화 |
|------|------|
| `maxRiskPerTrade` | 하위 티어 정책으로 축소 |
| `maxDailyLoss` | 하위 티어 한도로 축소 |
| `maxDrawdownPct` | 하위 티어 기준 적용 |
| `kellyFraction` | 강등 후 Kelly 비적격이면 `0`으로 리셋 |
| `kellyMode` | `half -> quarter` 또는 `fixed`로 축소 |

### 운영 해석

- 강등은 "전략 폐기" 신호가 아니다. 최근 구간의 edge가 약해졌다는 신호다.
- 강등 직후 가장 먼저 볼 것은 최근 15~20트레이드의 `fill quality`, `slippage`, `filterReason`, `pair concentration`이다.
- 포트폴리오 강등과 전략 강등은 구분해서 본다. 특정 전략만 망가졌다면 전체 포트폴리오보다 전략 단위 수정이 우선이다.

### 운영 체크리스트

1. 강등 이유 확인: WR 저하, R:R 저하, 연속 손실 중 무엇인지 분류.
2. 최근 거래 샘플 검토: 같은 페어 반복 손실인지, 시장 레짐 변화인지, execution 문제인지 확인.
3. quote/security gate 로그 점검: `quote_rejected`, `security_rejected`, `poor_execution_viability` 비율 변화 확인.
4. live/paper 괴리 확인: 백테스트가 아닌 실거래 슬리피지와 체결 지연이 원인인지 분리.
5. 필요 시 전략만 비활성화: 포트폴리오 전체 중단보다 문제 전략 격리가 우선.

### 강등 후 하지 말 것

- 손실 회복을 위해 티켓 사이즈를 임의 상향하지 말 것.
- 최근 손실 몇 건만 보고 파라미터를 즉시 과최적화하지 말 것.
- Strategy D/E 같은 비핵심 전략으로 손실 복구를 시도하지 말 것.

### 복구 판단

- 강등은 자동 복귀가 아니라, 이후 성과가 다시 상위 티어 승급 조건을 충족할 때 자연스럽게 해제된다.
- 복구 확인 전까지는 강등된 티어를 "정상 상태"로 간주하고 운영한다.
- 운영 메모에는 최소 다음을 남긴다:
  - 강등 시각
  - 강등 이유
  - 최근 구간 trade 수
  - 대응 조치

---

## Strategy E Operational Note

- Strategy E는 Strategy A가 `Confirmed` 이상이고 expectancy가 양수일 때만 검토한다.
- 강등 상태에서 Strategy E add-on을 live로 켜지 않는다.
- `momentum_cascade`의 backtest parity는 확보됐지만, live enable 전에는 backtest 결과와 paper 로그를 함께 검토해야 한다.

---

## Realtime Shadow Operations

`realtime shadow`는 Helius realtime paper session을 돌리면서
`raw-swaps -> micro-candles -> realtime-signals -> export -> summary`
를 자동 수집하는 운영 경로다.

중요:

- 점수는 [MEASUREMENT.md](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/MEASUREMENT.md) 기준 `Realtime Edge Score`로 해석한다.
- gate latency, status mix, admission block은 **점수에 합산되지 않고** 운영 판단용 telemetry로 본다.
- 아래 명령은 `default 운영`과 `tuned 실험`을 분리해서 사용한다.

### Default Collection Command

운영 표준 경로. VPS에서는 `pm2`가 [vps-realtime-shadow.sh](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/scripts/vps-realtime-shadow.sh)를 반복 실행한다.

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
pm2 start ecosystem.config.cjs --only momentum-shadow
```

용도:

- 장시간 shadow 수집
- 표본 축적
- 일일 summary/digest 생성

출력:

- session dataset dir
- export bundle
- `shadow-summary.json`
- Telegram digest (`--telegram` 사용 시)

### Report-Only Command

이미 수집된 dataset을 다시 실행 없이 요약할 때 사용한다.

```bash
cd /Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot
npm run realtime-shadow -- \
  --dataset-dir ./tmp/realtime-loop-live-20260322-163634 \
  --export-dir ./tmp/realtime-loop-live-runner-export \
  --horizon 30 \
  --json
```

### 운영 해석 규칙

| 조건 | 해석 |
|------|------|
| `signals < 10` | 점수 참고만, 전략 판단 금지 |
| `10 <= signals < 50` | weak sample |
| `50 <= signals < 100` | 비교 가능, 아직 보수적 |
| `signals >= 100` | trigger density / rejection mix / avg return 해석 시작 |

현재 우선순위:

1. `default` 경로로 shadow signal 100건 이상 누적
2. `execution_viability_rejected` 비중 확인
3. 필요 시 `tuned` 경로로 density 실험
