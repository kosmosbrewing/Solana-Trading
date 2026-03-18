# Operations Guide

> Last updated: 2026-03-18
> Scope: VPS 배포 + risk tier demotion + live 운영 판단

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
# 필수 값 입력: SOLANA_RPC_URL, WALLET_PRIVATE_KEY, BIRDEYE_API_KEY, DATABASE_URL
# TRADING_MODE=paper
# SCANNER_ENABLED=true

# 3. 자동 배포
bash scripts/deploy.sh
```

### Paper Mode .env 핵심 설정

```env
TRADING_MODE=paper
SCANNER_ENABLED=true
# WS/Strategy D는 기본 false — 설정 불필요
# BIRDEYE_WS_ENABLED=false (기본값)
# STRATEGY_D_ENABLED=false (기본값)
```

### 가동 확인 체크리스트

- [ ] `pm2 status` — `momentum-bot` online
- [ ] `pm2 logs momentum-bot` — `Bot started (v0.5 — Phase 2 Core Live, mode: paper)` 확인
- [ ] Scanner watchlist 갱신 로그: `Scanner: new candidate ...`
- [ ] Gate 평가 로그 출력
- [ ] Telegram alert 수신 (`Bot started` 메시지)
- [ ] 24시간 후: `pm2 monit` — memory < 300MB, restart 0

### 모니터링 명령어

```bash
pm2 status              # 프로세스 상태
pm2 logs momentum-bot   # 실시간 로그
pm2 monit               # CPU/memory 모니터
pm2 restart momentum-bot # 재시작
pm2 stop momentum-bot   # 중지
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
| Scanner 0 candidates | API 키 이슈 또는 시장 비활성 | Birdeye API 키 확인, DexScreener 키 확인 |

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
