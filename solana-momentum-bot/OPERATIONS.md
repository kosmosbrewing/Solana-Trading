# Operations Guide

> Last updated: 2026-04-04
> Scope: VPS 배포 + paper 운영 점검 + risk tier demotion + live 운영 판단

---

## Current Operations Note

- 현재 active execution 기준 문서는 [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md)다.
- 완료된 root plan / canary history는 [`PLAN_CMPL.md`](./PLAN_CMPL.md)에 archive했다.
- 운영에서 계속 중요한 체크포인트는 아래 3개다.
  - paper/live runtime sanity를 재기동 후에도 설명할 수 있는지
  - `execution.preGate` / `execution.postSize` telemetry가 계속 일관되게 남는지
  - data-plane noise와 전략 문제를 섞지 않고 기록하는지
- 2026-04-04 기준 bootstrap 운영 baseline은 `vm=1.8 / buyRatio=0.60 / lookback=20`이다.
- replay 기반 operator blacklist 후보는 `OPERATOR_TOKEN_BLACKLIST`로 runtime에 직접 반영할 수 있다.

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
# TRADING_MODE=paper
# REALTIME_ENABLED=true

# 3. 자동 배포
npm run deploy:vps
```

### Paper Mode .env 핵심 설정

```env
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
REALTIME_TRIGGER_MODE=bootstrap
SAME_PAIR_OPEN_POSITION_BLOCK=true
PER_TOKEN_LOSS_COOLDOWN_LOSSES=2
PER_TOKEN_LOSS_COOLDOWN_MINUTES=240
PER_TOKEN_DAILY_TRADE_CAP=15
# REALTIME_BOOTSTRAP_MIN_BUY_RATIO=0.55 (기본값, 변경 필요 시만 설정)
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
- token concentration 방지를 위해
  `SAME_PAIR_OPEN_POSITION_BLOCK=true`,
  `PER_TOKEN_LOSS_COOLDOWN_LOSSES=2`,
  `PER_TOKEN_LOSS_COOLDOWN_MINUTES=240`,
  `PER_TOKEN_DAILY_TRADE_CAP=15`
  를 운영 `.env`에 명시한다.
- bootstrap canary 기본값은
  `REALTIME_VOLUME_SURGE_MULTIPLIER=1.8`,
  `REALTIME_VOLUME_SURGE_LOOKBACK=20`,
  `REALTIME_BOOTSTRAP_MIN_BUY_RATIO=0.60`
  으로 둔다.
- replay에서 반복 음수였던 토큰은 `OPERATOR_TOKEN_BLACKLIST`로 즉시 차단 가능하다.

### Heartbeat 해석

- heartbeat는 2시간마다 운영 스냅샷을 먼저 보낸다.
- 첫 블록은 항상 현재 잔액, 오늘 거래 수, 종료 거래 수, 오픈 포지션 수를 보여준다.
- `전적 / 역행 / 순행 / TP1` 블록은 최근 24시간에 **종료된 trade가 있을 때만** 붙는다.
- 따라서 `거래 없음`만 보고 봇이 아무 일도 안 했다고 해석하지 않는다. 오늘 진입은 있었지만 아직 청산이 없을 수 있다.

예시:

```text
📊 Paper · 24h
잔액 1.0321 SOL | 손익 +0.0214 SOL
오늘 거래 7건 | 종료 5건 | 오픈 2건

전적 3W 2L (60%)
▼ 역행 -1.20% | ▲ 순행 2.40%
오진 20% | TP1 60%

🔍 시장: 🟢 risk_on (1x)
SOL 🔴약세 | 확산 50% | 후속 50%
```

### 가동 확인 체크리스트

- [ ] `pm2 status` — `momentum-bot` online
- [ ] `pm2 list` — legacy `momentum` 프로세스가 남아 있지 않은지 확인
- [ ] `pm2 logs momentum-bot` — shadow session start / export summary 확인
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
- `RejectStats` (bootstrap trigger rejection 분포)
- `realtime-ready ratio`

### 모니터링 명령어

```bash
pm2 status              # 프로세스 상태
pm2 logs momentum-bot # shadow runner 로그
pm2 logs momentum-bot   # bot 단독 프로필일 때
pm2 monit               # CPU/memory 모니터
pm2 restart momentum-bot # shadow 재시작
pm2 stop momentum-bot   # shadow 중지
```

### Disk Prune

`data/realtime/sessions/`가 커져서 VPS 디스크 사용률이 높아지면,
오래된 세션만 정리하고 현재 세션과 최근 세션은 보호한다.

기본값:

- threshold: `85%`
- target: `80%`
- keep recent: `5`
- keep window: `48h`
- 기본 모드: `dry-run`

예시:

```bash
# 실제 삭제 없이 후보만 확인
bash scripts/prune-realtime-sessions.sh

# 85% 이상일 때만 오래된 세션 정리
bash scripts/prune-realtime-sessions.sh --apply
```

cron 예시:

```cron
17 * * * * cd /root/Solana/Solana-Trading/solana-momentum-bot && /usr/bin/bash scripts/prune-realtime-sessions.sh --apply >> logs/prune-realtime-sessions.log 2>&1
```

주의:

- `current-session.json`이 가리키는 활성 세션은 항상 보호된다.
- `current-session.json`을 못 읽거나 세션 경로가 어긋나면 fail-closed로 종료하고 아무것도 지우지 않는다.
- `runtime-diagnostics.json`과 realtime root 파일은 지우지 않는다.
- 세션 해석/리플레이 근거가 필요하므로 threshold 이하일 때는 아무것도 지우지 않는다.

### Manual Ops Tools

아래 스크립트는 평소 자동 경로에 묶이지 않은 `수동 운영툴`이다.
정리 대상 고아 스크립트로 보지 않고, 장애 복구나 데이터 회수 때만 직접 실행한다.

| 스크립트 | 용도 | 비고 |
|---|---|---|
| `scripts/restart-timescaledb.sh` | TimescaleDB 컨테이너 재기동 | DB 컨테이너 장애 시 수동 복구 |
| `scripts/sync-vps-data.sh` | VPS `data/`를 로컬로 회수 | 세션/리포트 분석용 수동 동기화 |

원칙:

- `pm2` 운영 표준 경로에는 포함하지 않는다.
- cron에 자동 등록하지 않는다.
- 사용 전 대상 경로와 환경을 직접 확인한다.
- 파일 정리 시 위 2개는 `유지 대상`으로 본다.

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
| Bootstrap trigger 0 signals | volume/buyRatio 필터 과도 | `REALTIME_BOOTSTRAP_MIN_BUY_RATIO` 조정, `RejectStats` 로그 확인 |
| Trigger 롤백 필요 | bootstrap→core 전환 | `.env`에서 `REALTIME_TRIGGER_MODE=core` → `pm2 restart momentum-bot` |

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

## Canary Runbook

카나리아(paper/초기 live) 운영 시 반드시 지키는 규칙을 정리한다.

### Max Live Notional

| 항목 | 값 | 근거 |
|------|---|------|
| max risk per trade (Bootstrap/Calibration) | 1% of equity | `tradingParams.risk.maxRiskPerTrade` |
| max position pct | 20% of equity | `tradingParams.position.maxPositionPct` |
| max concurrent absolute | 3 | `tradingParams.position.maxConcurrentAbsolute` |
| max concurrent positions | 2 | runtime_canary (code_default: 1) |

최대 동시 노출 = `equity × maxPositionPct × maxConcurrent` = equity의 40% (2포지션 × 20%).

규칙:
- 카나리아 단계에서 equity의 50% 이상을 동시에 노출하지 않는다.
- `MAX_CONCURRENT_POSITIONS=2`, `MAX_POSITION_PCT=0.20`을 env에 명시한다.

### Daily Halt 조건

| 조건 | 임계값 | 동작 |
|------|--------|------|
| 일일 실현 손실 | equity의 5% | `maxDailyLoss: 0.05` → 자동 신규 진입 차단 |
| drawdown guard | peak 대비 30% 하락 | `maxDrawdownPct: 0.30` → halted |
| 연속 손실 | 3회 | `maxConsecutiveLosses: 3` → cooldown 활성화 |

halt 후 체크리스트:
1. `pm2 logs momentum-bot`에서 halt/cooldown 사유 확인
2. 최근 거래 5건의 `exit_reason`, `slippage`, `pair` 확인
3. 시장 레짐(risk_on/off) 확인
4. 원인이 전략 문제가 아닌 시장 환경이면 다음 날 자동 리셋 대기
5. 원인이 전략/execution 문제면 파라미터 점검 후 수동 restart

### Wallet Kill-Switch

긴급 정지가 필요한 경우:

```bash
# 1. 즉시 정지
pm2 stop momentum-bot

# 2. 오픈 포지션 확인
npx ts-node scripts/trade-report.ts --status open

# 3. 필요 시 수동 청산 (Jupiter CLI 또는 수동 swap)
```

kill-switch를 당기는 조건:
- wallet balance가 예상보다 급격히 감소 (unexplained loss)
- RPC 장애로 trade monitoring 불가
- Solana network congestion으로 transaction 지연 > 60s
- 보안 이슈 의심 (unauthorized transaction)

kill-switch 후 하지 말 것:
- 원인 미파악 상태에서 즉시 재시작
- 오픈 포지션을 확인하지 않고 방치

### Flat 확인 절차

flat = 모든 오픈 포지션이 닫힌 상태.

확인 방법:

```bash
# DB에서 오픈 포지션 확인
npx ts-node scripts/trade-report.ts --status open

# pm2 logs에서 OPEN trade 0건 확인
pm2 logs momentum-bot --lines 50 | grep "openPositions"
```

flat 확인이 필요한 시점:
- 정기 점검 전
- 파라미터 변경 전
- 배포/업데이트 전
- 긴급 정지 후

### Restart 전후 확인 절차

**restart 전:**

1. flat 확인 (오픈 포지션 0건)
2. 변경사항 확인 (`git diff`, `.env` 변경 여부)
3. 현재 잔고 기록

**restart:**

```bash
pm2 restart momentum-bot
```

**restart 후 (5분 이내):**

1. `pm2 status` — online 확인
2. `pm2 logs momentum-bot --lines 20` — `Bot started ... mode: paper` 확인
3. `Scanner started. Watchlist: N entries.` 확인
4. Telegram `Bot started` alert 수신 확인
5. 잔고가 restart 전과 일치하는지 확인

**restart 후 (30분):**

1. `pm2 monit` — memory < 300MB
2. gate 평가 로그가 정상 출력되는지 확인
3. `GeckoTerminal 429` 반복 여부 확인

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

- 점수는 [`MEASUREMENT.md`](./MEASUREMENT.md) 기준 `Realtime Edge Score`로 해석한다.
- gate latency, status mix, admission block은 **점수에 합산되지 않고** 운영 판단용 telemetry로 본다.
- 아래 명령은 `default 운영`과 `tuned 실험`을 분리해서 사용한다.

### Default Collection Command

운영 표준 경로. VPS에서는 `pm2`가 `scripts/vps-realtime-shadow.sh`를 반복 실행한다.

```bash
cd /root/Solana/Solana-Trading/solana-momentum-bot
pm2 start ecosystem.config.cjs --only momentum-bot
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
cd /root/Solana/Solana-Trading/solana-momentum-bot
npm run realtime-shadow -- \
  --dataset-dir ./tmp/realtime-loop-live-20260322-163634 \
  --export-dir ./tmp/realtime-loop-live-runner-export \
  --horizon 30 \
  --json
```

### Bootstrap Replay Command

수집된 realtime session을 fixed-notional 기준으로 비교할 때 사용한다.

```bash
scripts/bootstrap-replay-report.sh \
  --vm-list 1.8,2.2 \
  --buy-ratio-list 0.55,0.60 \
  --lookback-list 20,30 \
  --estimated-cost-pct 0.003 \
  --gate-mode stored \
  --notional-sol 0.1 \
  --save bootstrap-sweep-cost003-stored-notional01
```

용도:

- bootstrap stable / aggressive 파라미터 비교
- 세션별 `Signals / adjReturn / Edge / Decision` 확인
- token leaderboard / blacklist 후보 도출

### Trade Ledger Command

DB 원장과 실현 손익을 분리해서 볼 때 사용한다.

```bash
npx ts-node scripts/trade-report.ts --hours 24
```

해석:

- `opened_at 기준 row`: ledger activity
- `closed_at 기준 실현 row`: realized PnL
- row 수는 partial close 때문에 독립 진입 횟수와 다를 수 있음

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
