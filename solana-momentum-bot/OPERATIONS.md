# Operations Guide

> Last updated: 2026-05-06
> Scope: VPS 배포 + paper 운영 점검 + risk tier demotion + live 운영 판단

---

## Current Operations Note

Current lane/report 기준은 `SESSION_START.md`, `STRATEGY.md`, `docs/design-docs/lane-operating-refactor-2026-05-03.md`, `docs/exec-plans/active/20260503_BACKLOG.md`를 우선한다. 아래 2026-04-18 DEX_TRADE/pure_ws_breakout 섹션은 legacy runbook 이며, 현재 pure_ws live 승격 정책으로 사용하지 않는다.

### DEX_TRADE Phase 3 — Quick Reject + Hold Sentinel + Ruin Sim (2026-04-18)

**기본 활성** — pure_ws lane 에 자동 적용. 기존 lane (cupsey / migration) 미연결 (handler별 wiring 필요).

**Env defaults (운영자 조정 가능)**:
```env
QUICK_REJECT_CLASSIFIER_ENABLED=true
HOLD_PHASE_SENTINEL_ENABLED=true
# 필요 시 threshold 튜닝:
# QUICK_REJECT_WINDOW_SEC=45 / QUICK_REJECT_MIN_MFE_PCT=0.005
# HOLD_PHASE_PEAK_DRIFT=0.35 / HOLD_PHASE_DEGRADED_FACTOR_COUNT=2
```

**관측 로그**:
- `[PUREWS_QUICK_REJECT]` — PROBE 구간 microstructure 기반 exit
- `[PUREWS_QUICK_REJECT_WARN]` — 1 factor + weak MFE (reduce candidate)
- `[PUREWS_HOLD_DEGRADED]` — RUNNER tier degraded exit trigger
- `[PUREWS_HOLD_WARN]` — 단일 warn factor

**승격 판정 (50-trade 축적 후)**:
```bash
# paired PnL → ruin probability (DEX_TRADE Section 11 승격 기준 <5%)
npm run ops:ruin:simulate -- --strategy pure_ws_breakout \
  --start-sol <current-wallet> --ruin-threshold 0.3 \
  --since <canary-start-ISO> --md docs/audits/ruin-sim-<date>.md
```

**판정 기준**:
- **`< 5%`**: 승격 후보 (`docs/historical/pre-pivot-2026-04-18/DEX_TRADE.md` §11 — pre-pivot archive)
- **`5-10%`**: paper 회귀 또는 threshold 재튜닝
- **`> 10%`**: canary 중단, strategy 재검토

### DEX_TRADE Phase 2 — Viability Floor + Bleed Budget (2026-04-18)

Pure DEX trading bot 전환의 viability 하한 인프라. **기본 활성** — 배포 시 기존 wallet runtime 에 자동 적용.

**기본 env (명시 없으면 default)**:
```env
PROBE_VIABILITY_FLOOR_ENABLED=true         # default
PROBE_VIABILITY_MIN_TICKET_SOL=0.005
PROBE_VIABILITY_MAX_BLEED_PCT=0.06         # round-trip 6% cap
# PROBE_VIABILITY_MAX_SELL_IMPACT_PCT=0    # 0 = disabled until Phase 3 reverse quote
DAILY_BLEED_BUDGET_ENABLED=true            # default
DAILY_BLEED_ALPHA=0.05                     # wallet 5%
DAILY_BLEED_MIN_CAP_SOL=0.05
# DAILY_BLEED_MAX_CAP_SOL=0                # 0 = unlimited
```

**관측 할 로그**:
- `[PUREWS_VIABILITY_REJECT]` — pair/reason/bleed/budget 표시. 빈도로 floor 적정성 판단
- `[BLEED_BUDGET] rolled` — 매 UTC day 시작 + 초기 wallet 기준 cap 계산
- `[BLEED_BUDGET_EXHAUSTED]` — 예산 소진 (추가 entry 자동 halt)

**조정 포인트**:
- `viability_reject` 대량 발생 (>50% rate) → `MAX_BLEED_PCT` 상향 또는 `MIN_TICKET_SOL` 점검
- 예산 소진 너무 빠름 → `alpha` 상향 OR 전략 미검증 → canary 재조정

### DEX_TRADE Phase 1.3 — V2 Detector Scan (2026-04-18)

Bootstrap signal 과 독립된 WS burst detector. **default off** — paper replay 검증 완료 후 opt-in.

```env
# Stage B+ (signal 관측만) 또는 Stage C (live canary with v2 detector):
PUREWS_V2_ENABLED=true                     # opt-in
# 이하 전부 default 사용 권장 (audit 기반 tuned):
# PUREWS_V2_MIN_PASS_SCORE=50
# PUREWS_V2_FLOOR_VOL=0.15
# PUREWS_V2_N_BASELINE=6
# PUREWS_V2_BPS_PRICE_SATURATE=1000
# PUREWS_V2_PER_PAIR_COOLDOWN_SEC=300
```

**효과**: 매 candle close 에서 watchlist 전체를 detector 로 평가. pass 시 synthetic signal 생성 → `handlePureWsSignal` 로 PROBE 진입 (v1 cupseyGate 건너뜀).

**운영 흐름**:
1. `PUREWS_V2_ENABLED=true` + (기존 `PUREWS_LIVE_CANARY_ENABLED=true`) 로 배포
2. 24h 관측: `[PUREWS_V2_PASS]` / `[PUREWS_V2_REJECT]` 빈도 → paper replay 예측과 비교
3. pass rate mismatch 시 threshold 조정 (audit doc 참조)
4. 50 trade 축적 후 `ops:canary:eval` 로 승격 판정

**paper replay 재실행 (threshold tuning 전)**:
```bash
npm run ops:burst:replay -- --all --json results/ws-burst-<date>.json --md docs/audits/ws-burst-detector-calibration-<date>.md
```

### Block 4 — Canary Guardrails + A/B Evaluation (2026-04-18)

Block 3 pure_ws_breakout 의 canary 단계 운영 tooling.

**자동 차단 (canary auto-halt)**:
- `CANARY_AUTO_HALT_ENABLED=true` (default)
- `CANARY_MAX_CONSEC_LOSERS=5` — 연속 loser 5회 → 해당 lane entry halt
- `CANARY_MAX_BUDGET_SOL=0.5` — 누적 손실 0.5 SOL → 해당 lane entry halt
- `CANARY_MAX_TRADES=100` — canary window 100 trade 도달 → entry pause (promotion review)
- Halt 경로: `entryIntegrity.triggerEntryHalt(lane, reason)` 로 전파 → 운영자 `resetEntryHalt` 수동 해제 필요

**50-trade A/B 평가**:
```bash
# 전체 ledger 기준
npm run ops:canary:eval

# 캔ary 시작 이후만
npm run ops:canary:eval -- --since 2026-04-18T00:00:00Z --md canary-report.md

# JSON dump (CI / 외부 분석용)
npm run ops:canary:eval -- --json canary.json
```

출력:
- cupsey_flip_10s vs pure_ws_breakout trade count / net SOL / winner distribution (2x+, 5x+, 10x+)
- Max consecutive losers
- Promotion verdict: `PROMOTE` / `CONTINUE` / `DEMOTE`
  - `PROMOTE`: candidate ≥ 50 trades + net SOL > benchmark + 5x+ winner 존재 + loser streak < 10
  - `DEMOTE`: candidate net SOL ≤ 0 OR loser streak ≥ 10
  - `CONTINUE`: 그 외 (< 50 trades OR 조건 부분 만족)

**Phase 3.2 → 3.3 체크리스트**:
1. Paper 20+ trade 확인 (`TRADING_MODE=paper` + `PUREWS_LANE_ENABLED=true`)
2. Wallet Stop Guard, wallet delta comparator, canary auto-halt 무사고 확인
3. `npm run ops:canary:eval` paper 결과 검토
4. Live 전환: `TRADING_MODE=live`, ticket 0.01 SOL, max 3 concurrent 유지
5. 50 trade 도달 시 `npm run ops:canary:eval` + promotion verdict 확인
6. `PROMOTE` 시 primary 후보 — `DEMOTE` 시 paper 회귀 + tier 재튜닝

### Block 3 — Pure WS Breakout Lane (2026-04-18, paper-first)

Mission pivot convexity 첫 구현 lane. 배포 후 **paper 20-50 trade** 로 관측. cupsey benchmark 는 그대로 유지.

**배포 전 env 권장**:
```env
# Paper 단계 (초기)
PUREWS_LANE_ENABLED=true
PUREWS_WALLET_MODE=auto          # 또는 main 명시 (canary 원칙)
TRADING_MODE=paper               # 또는 live (canary 시)

# 기본값 사용 — 필요 시 override
# PUREWS_LANE_TICKET_SOL=0.01
# PUREWS_MAX_CONCURRENT=3
# PUREWS_PROBE_HARD_CUT_PCT=0.03
# PUREWS_GATE_MIN_VOLUME_ACCEL_RATIO=1.0
# PUREWS_GATE_MIN_AVG_BUY_RATIO=0.45
```

**관측 체크리스트**:
- 시작 로그 `[PUREWS_WALLET] mode='...' resolved='...'` 확인
- `[PUREWS_PROBE_OPEN]` / `[PUREWS_T1]` / `[PUREWS_T2]` / `[PUREWS_T3]` / `[PUREWS_LOSER_HARDCUT]` / `[PUREWS_LOSER_TIMEOUT]` 분포 확인
- 20 trade 도달 시 T1 conversion rate (cupsey STALK→ENTRY 6.7% 대비)
- 50 trade 도달 시 wallet delta + winner distribution (5x+, 10x+) 측정

**승격 기준 (Phase 3.3)**:
- wallet delta cupsey 대비 positive
- Wallet Stop Guard / comparator halt 무사고
- 50 trade 달성

### Block 2 — Coverage Telemetry (2026-04-18)

배포 후 24-48h 동안 `data/realtime/admission-skips-dex.jsonl` 를 수집하여 실제 차단되는 DEX ID 분포를 파악한다. 분석 예시:

```bash
# 가장 자주 차단되는 DEX ID 상위 10
jq -r '.dexId' data/realtime/admission-skips-dex.jsonl | sort | uniq -c | sort -rn | head -10

# reason 별 분포
jq -r '.reason' data/realtime/admission-skips-dex.jsonl | sort | uniq -c

# no_pairs 가 많이 나는 discovery source
jq -r 'select(.reason=="no_pairs") | .source' data/realtime/admission-skips-dex.jsonl | sort | uniq -c
```

수집된 empirical 분포에 따라 추가 coverage 확장 여부 결정.

### Block 1 — Wallet Truth (2026-04-18)

Mission pivot 이후 운영 판정은 **wallet delta 만이 유일한 truth** 다. 아래 체크리스트는 매 pm2 restart 후 필수 확인.

1. **Lane wallet ownership 확인**:
   - `.env` 에 `CUPSEY_WALLET_MODE` / `MIGRATION_WALLET_MODE` 명시 (`main` / `sandbox` / `auto`)
   - 기본 `auto` 는 backward compat — 새 배포는 반드시 `main` 또는 `sandbox` 명시
   - 시작 로그에 `[CUPSEY_WALLET] mode='...' resolved='...'` 출력 확인
2. **Wallet delta comparator 작동 확인**:
   - live 모드 시 `[WALLET_DELTA] poller started` 로그 확인
   - 5분 간격 `[WALLET_DELTA] observed= expected= drift=` 로그 흐름 확인
   - Drift 경고 임계: `WALLET_DELTA_DRIFT_WARN_SOL=0.05`, halt 임계: `WALLET_DELTA_DRIFT_HALT_SOL=0.20`
3. **사후 감사 도구**:
   - `npm run ops:reconcile:wallet -- --days 14` — `.env` 에 `WALLET_PUBLIC_KEY` 설정 권장 (read-only, private key 불필요)
   - `WALLET_PUBLIC_KEY` 미설정 시 `WALLET_PRIVATE_KEY` derivation fallback

- 현재 active execution 기준 문서는 [`docs/exec-plans/active/1sol-to-100sol.md`](./docs/exec-plans/active/1sol-to-100sol.md)다.
- VPS 데이터 동기화 -> 로컬 점검 -> Codex 분석 요청 루프는 [`docs/runbooks/live-ops-loop.md`](./docs/runbooks/live-ops-loop.md) 를 따른다.
- `bootstrap_10s` replay / outlier / runner-vs-noise 반복 검증은 [`docs/runbooks/backtest-bootstrap-replay-loop.md`](./docs/runbooks/backtest-bootstrap-replay-loop.md) 를 따른다.
- `volume_spike` / `fib_pullback` 5분 replay 반복 검증은 [`docs/runbooks/backtest-core-5m-replay-loop.md`](./docs/runbooks/backtest-core-5m-replay-loop.md) 를 따른다.
- historical fetch -> replay 반복 검증은 [`docs/runbooks/backtest-historical-replay-loop.md`](./docs/runbooks/backtest-historical-replay-loop.md) 를 따른다.
- heartbeat / daily summary / paper validation / mission-execution-edge 해석은 [`docs/runbooks/measurement-review-loop.md`](./docs/runbooks/measurement-review-loop.md) 를 따른다.
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
SCANNER_REENTRY_COOLDOWN_MS=300000
EVENT_POLLING_INTERVAL_MS=1800000
SHADOW_RUN_MINUTES=1440
SHADOW_SIGNAL_TARGET=100
SHADOW_HORIZON_SEC=30
REALTIME_TRIGGER_MODE=bootstrap
SAME_PAIR_OPEN_POSITION_BLOCK=true
PER_TOKEN_LOSS_COOLDOWN_LOSSES=2
PER_TOKEN_LOSS_COOLDOWN_MINUTES=240
PER_TOKEN_DAILY_TRADE_CAP=15
REALTIME_VOLUME_SURGE_MULTIPLIER=1.8
REALTIME_VOLUME_SURGE_LOOKBACK=20
REALTIME_BOOTSTRAP_MIN_BUY_RATIO=0.60
# ↑ 운영 baseline (code default는 vm=3.0/buyRatio=0.55이나, replay 검증 결과 위 값을 명시 설정)
# 2026-04-26 cleanup: Strategy D / Birdeye WS 영구 retire — env key 자체 미존재.
```

### 현재 권장 운영 메모

- `MAX_WATCHLIST_SIZE=8`은 paper 안정화용 보수값이다.
- watchlist를 늘리기 전에 `429`, `Poll failed`, `No candle received`가 먼저 안정화돼야 한다.
- scanner churn 억제를 위해 `SCANNER_REENTRY_COOLDOWN_MS=300000` (5분) 을 유지한다. (2026-04-15: 1800000 → 300000으로 단축하여 idle 토큰 빠른 순환)
- idle 토큰 빠른 퇴출: `SCANNER_IDLE_EVICTION_MS=600000` (10분) 권장. (2026-04-15: 1800000 → 600000 복원)
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

- heartbeat는 KST 기준 24시간 내내 2시간마다 운영 스냅샷을 먼저 보낸다.
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

#### `sync-vps-data.sh` 동작 (2026-04-16 강화 / 2026-05-03 lane report 추가)

- **DB trades dump opt-in (2026-05-01)**: 기본 sync 는 DB를 사용하지 않고 `data/realtime/*.jsonl` 파일을 truth 로 쓴다. 과거 trades table snapshot 이 필요할 때만 `RUN_TRADES_DUMP=true`로 활성화한다.
- **DB URL 자동 해결 (opt-in)**: `RUN_TRADES_DUMP=true`이고 `VPS_DATABASE_URL` 미설정 시 pm2 app(`momentum-bot`)에서 자동으로 `DATABASE_URL` 추출. `VPS_PM2_APP_NAME` env로 app 이름 재정의 가능.
- **DB 신선도 검증 (opt-in)**: 덤프 전 `max(created_at)`를 로컬 `current-session.json`의 `startedAt`과 비교. DB가 현재 세션 시작보다 오래됐으면 에러로 중단.
- **강제 허용 (opt-in)**: `ALLOW_STALE_DB_DUMP=true` 설정 시 신선도 경고만 출력하고 진행.
- **교차 검증 (opt-in)**: 덤프 후 JSONL 내 실제 `dump_max_created`와 DB preflight 값 비교.
- **자동 paper-arm-report (2026-04-26)**: sync 직후 `kol-paper-trades.jsonl` 기준 sub-arm 통계 생성 → `reports/kol-paper-arms-YYYY-MM-DD.md`. Jupiter API 0건 (file-only) — default ON.
- **자동 token-quality-report (2026-05-01)**: sync 직후 `token-quality-observations.jsonl` + paper/live/missed-alpha + dev-wallet candidate JSON join → `reports/token-quality-YYYY-MM-DD.md`. Jupiter/RPC API 0건 (file-only) — default ON.
- **자동 live-canary-report (2026-05-01)**: sync 직후 live canary wallet-truth / 5x / catastrophic / runner 진단 생성 → `reports/kol-live-canary-YYYY-MM-DD.md`. Jupiter/RPC API 0건 (file-only) — default ON.
- **자동 KOL transfer posterior report (2026-05-05)**: sync 직후 `data/research/kol-transfers.jsonl` 을 읽어 KOL별 rotation/smart-v3 posterior 진단 생성 → `reports/kol-transfer-posterior-YYYY-MM-DD.md/json`. API 호출 0건 (file-only) — default ON. 원본 backfill 은 `npm run kol:transfer-backfill` 로 별도 실행한다.
- **자동 smart-v3-evidence-report (2026-05-03 / 2026-05-05 posterior join / 2026-05-06 MAE diagnostics / 2026-05-07 live-block audit / 2026-05-08 MFE floor)**: sync 직후 `smart-v3-paper-trades.jsonl`, `smart-v3-live-trades.jsonl`, shared `trade-markouts.jsonl`, 선택적 `data/research/kol-transfers.jsonl` 로 smart-v3 cohort verdict + KOL transfer posterior 진단 생성 → `reports/smart-v3-evidence-YYYY-MM-DD.md/json`. T+ verdict coverage 는 close `positionId × anchorType × horizon` 기준이며, Closed Trades W/L 은 copyable/wallet-first 로 계산하고 token-only W/L 은 별도 표시한다. Closed Trades 는 `smart_v3_mae_fast_fail`, recovery-hold, MFE floor-exit/stage counts, pre-T1 MFE band counts 도 함께 표시한다. Paper rows that would have been blocked from live are summarized by `smartV3LiveBlockReason` and `smartV3LiveBlockFlags`. Jupiter/RPC API 0건 (file-only) — default ON.
- **자동 trade-markout-report (2026-05-02)**: sync 직후 `trade-markout-anchors.jsonl` + `trade-markouts.jsonl` 로 실제 buy/sell/paper anchor 의 T+30/60/300/1800 coverage / continuation 진단 생성 → `reports/trade-markout-YYYY-MM-DD.md`. Jupiter/RPC API 0건 (file-only) — default ON.
- **자동 pure_ws trade-markout-report (2026-05-03)**: sync 직후 pure_ws paper T+15/30/60/180/300/1800 coverage / post-cost behavior 생성 → `reports/pure-ws-trade-markout-YYYY-MM-DD.md`. Jupiter/RPC API 0건 (file-only) — default ON.
- **자동 rotation-report (2026-05-03 / 2026-05-05 posterior join)**: sync 직후 rotation control/arms/no-trade markout / T+15/30/60 post-cost / KOL transfer posterior 진단 생성 → `reports/rotation-lane-YYYY-MM-DD.md`. Jupiter/RPC API 0건 (file-only) — default ON.
- **자동 capitulation-rebound-report (2026-05-09)**: sync 직후 `capitulation-rebound-paper-trades.jsonl`, shared `trade-markouts.jsonl`, `missed-alpha.jsonl` 로 paper-only rebound close / T+15/30/60/180/300/1800 / no-trade counterfactual 진단 생성 → `reports/capitulation-rebound-YYYY-MM-DD.md/json`. Jupiter/RPC API 0건 (file-only) — default ON.
- **자동 winner-kill-report (2026-05-01)**: sync 직후 missed-alpha close-site markout 으로 5x winner-kill rate 생성 → `reports/winner-kill-YYYY-MM-DD.md`. Jupiter/RPC API 0건 (file-only) — default ON.
- **자동 sync-health manifest (2026-05-03)**: 핵심 JSONL/log 파일의 row count, bytes, mtime, lane projection freshness, 최근 24h W/L/net/last-trade summary 를 `reports/sync-health-YYYY-MM-DD.md`로 저장. 데이터 공백과 sync 실패 구분용 — default ON.
- **opt-in shadow-eval (2026-04-26)**: `RUN_SHADOW_EVAL=true` 시 KOL signal raw alpha 측정 (Jupiter forward quote 사용). default OFF — Jupiter quota 영향.
- **환경변수 주의**: smart-v3 evidence/rotation/capitulation/KOL transfer posterior report 추가는 운영 `.env` 변경이 필요 없다. `SKIP_KOL_TRANSFER_REPORT`, `KOL_TRANSFER_REPORT_SINCE`, `KOL_TRANSFER_INPUT`, `SKIP_SMART_V3_EVIDENCE_REPORT`, `SMART_V3_EVIDENCE_ROUND_TRIP_COST_PCT`, `SKIP_CAPITULATION_REPORT`, `CAPITULATION_REPORT_ROUND_TRIP_COST_PCT` 는 sync/report-only shell knob 이며 runtime 전략 환경변수가 아니다. Smart-v3 MAE fast-fail / recovery-hold / MFE floor 와 live strict-quality/pre-entry-sell/combo-decay/KOL-fill-advantage fallback 은 runtime knob 이 추가됐지만 default-on 안전값이 있어 운영 `.env` override 는 필수가 아니다. Combo decay 는 entry-time fresh KOL key 를 기준으로 primary paper+live close 를 함께 보며, shadow arm 은 학습 대상에서 제외한다.
- **로컬 분석 캐시 보호 (2026-05-05)**: 운영 데이터는 VPS → local 로 sync 하지만, `data/research/kol-transfers.jsonl*` 는 로컬 Helius posterior 캐시라 기본 rsync 제외한다. 필요 시 `DATA_RSYNC_EXCLUDES` 로 override 가능.

#### 운영 `.env` 반영 원칙 (2026-05-06)

- `.env`는 `WALLET_PRIVATE_KEY`, RPC/API key, DB URL을 포함할 수 있으므로 Git 추적 금지다. `git pull`만으로 운영 `.env`가 바뀌지 않는 것은 정상 동작이다.
- Git으로 동기화할 수 있는 non-secret 운영 override 는 `ops/env/production.env`에 둔다.
- `scripts/deploy.sh`는 `git pull` 후 `DEPLOY_ENV_PROFILE` (default `ops/env/production.env`)을 원격 `.env`에 병합한다. 기존 secret 값은 `.env`/shell env에 남기고 profile에는 넣지 않는다.
- `scripts/deploy-remote.sh`는 원격 repo를 먼저 `git pull --ff-only`로 갱신한 뒤 원격 `scripts/deploy.sh`를 실행한다. 따라서 profile merge 변경도 첫 배포부터 적용된다.
- `deploy-remote.sh --sync-env`는 로컬 `.env`를 직접 병합하는 예외 경로다. 일반 운영에서는 tracked `ops/env/production.env` + 원격 secret `.env` 조합을 우선한다.
- 병합 스크립트는 `.env.backup-<timestamp>`를 남긴다. 자동 병합을 건너뛰려면 `DEPLOY_ENV_PROFILE=`로 빈 값을 준다.
- 붙여넣기/수동 편집 후에는 `gOL_HUNTER_*` 같은 오타 키가 없는지 확인한다. KOL live canary 키는 반드시 `KOL_HUNTER_LIVE_CANARY_ENABLED`다.
- Rotation canary 운영 의도는 `KOL_HUNTER_ROTATION_V1_LIVE_ENABLED=false` + `KOL_HUNTER_ROTATION_CHASE_TOPUP_LIVE_CANARY_ENABLED=false` + `KOL_HUNTER_ROTATION_UNDERFILL_LIVE_CANARY_ENABLED=true`다. 전체 rotation live를 열지 않고, chase-topup은 paper-only로 둔다. Underfill은 paper trigger 기준과 live trigger 기준을 맞추되 Real Asset Guard/live canary gate는 유지한다.

```bash
# 기본 사용 (파일 sync + file-only reports, DB 미사용)
bash scripts/sync-vps-data.sh

# legacy DB trades snapshot 이 필요할 때만
RUN_TRADES_DUMP=true bash scripts/sync-vps-data.sh

# pm2 app 이름 재정의
VPS_PM2_APP_NAME=my-bot bash scripts/sync-vps-data.sh

# stale DB 강제 허용 (분석용)
ALLOW_STALE_DB_DUMP=true bash scripts/sync-vps-data.sh

# Jupiter shadow eval 까지 실행 (Phase 2 go/no-go 검토 시)
RUN_SHADOW_EVAL=true bash scripts/sync-vps-data.sh

# paper arm report 생략 (rsync 만 필요할 때)
SKIP_PAPER_REPORT=true bash scripts/sync-vps-data.sh

# token quality / dev-candidate report 생략
SKIP_TOKEN_QUALITY_REPORT=true bash scripts/sync-vps-data.sh

# live canary / smart-v3 evidence / trade markout / winner-kill / sync health 생략
SKIP_LIVE_CANARY_REPORT=true bash scripts/sync-vps-data.sh
SKIP_KOL_TRANSFER_REPORT=true bash scripts/sync-vps-data.sh
KOL_TRANSFER_REPORT_SINCE=14d bash scripts/sync-vps-data.sh
KOL_TRANSFER_INPUT=data/research/kol-transfers.jsonl bash scripts/sync-vps-data.sh
SKIP_SMART_V3_EVIDENCE_REPORT=true bash scripts/sync-vps-data.sh
SMART_V3_EVIDENCE_ROUND_TRIP_COST_PCT=0.01 bash scripts/sync-vps-data.sh
SKIP_TRADE_MARKOUT_REPORT=true bash scripts/sync-vps-data.sh
SKIP_PUREWS_TRADE_MARKOUT_REPORT=true bash scripts/sync-vps-data.sh
SKIP_ROTATION_REPORT=true bash scripts/sync-vps-data.sh
SKIP_CAPITULATION_REPORT=true bash scripts/sync-vps-data.sh
CAPITULATION_REPORT_ROUND_TRIP_COST_PCT=0.01 bash scripts/sync-vps-data.sh
SKIP_WINNER_KILL_REPORT=true bash scripts/sync-vps-data.sh
SKIP_SYNC_HEALTH=true bash scripts/sync-vps-data.sh
```

KOL transfer posterior 운영:

```bash
# 권장 자동 배치 엔트리: stale(기본 22h+)일 때만 Helius 호출.
npm run kol:transfer-refresh

# 강제 refresh.
KOL_TRANSFER_REFRESH_FORCE=true npm run kol:transfer-refresh

# API 호출 있음: Helius getTransfersByAddress backfill. 기본 30d / active KOL.
HELIUS_API_KEY=... npm run kol:transfer-backfill -- --since 30d

# 최근 1주 관측 정확도 갱신용: 기존 ledger 백업 후 7d snapshot 으로 원자적 교체.
# backup: data/research/kol-transfers.jsonl.bak-YYYYMMDDTHHMMSSZ
HELIUS_API_KEY=... npm run kol:transfer-backfill -- --since 7d --overwrite

# API 호출 없음: backfill 결과를 posterior report 로 변환.
npm run kol:transfer-report -- --input data/research/kol-transfers.jsonl --since 7d \
  --md reports/kol-transfer-posterior-$(date +%Y-%m-%d).md \
  --json reports/kol-transfer-posterior-$(date +%Y-%m-%d).json
```

주의:

- `kol-transfer-backfill` 은 Helius API를 호출하므로 sync 기본 경로에 넣지 않는다.
- `--overwrite` 는 기존 `kol-transfers.jsonl` 을 백업한 뒤 임시 파일에 쓰고, Helius page 성공이 0건이면 교체하지 않는다.
- `kol-transfer-refresh` 는 sidecar 배치용 wrapper 다. 기본 `KOL_TRANSFER_REFRESH_SINCE=7d`, `KOL_TRANSFER_REFRESH_MAX_AGE_HOURS=22`, stale 이 아니면 API 호출 없이 skip 한다.
- `sync-vps-data.sh` 는 API를 호출하지 않고 `KOL_TRANSFER_STALE_WARN_HOURS=30` 기준으로 stale 경고만 출력한다.
- `sync-vps-data.sh` 는 기본 `DATA_RSYNC_EXCLUDES` 로 `data/research/kol-transfers.jsonl*` 를 VPS sync 대상에서 제외한다. 로컬에서 생성한 posterior 입력을 운영 원본 sync 가 덮어쓰지 않게 하기 위함이다.
- `kol-transfer-report`, `smart-v3-evidence-report`, `rotation-report` 의 posterior 섹션은 모두 진단 전용이다.
- transfer 기반 buy/sell 후보는 precise swap PnL 이 아니다. 정책 보조신호 승격 전에는 상위 signature만 gTFA drill-down 으로 검증한다.

원칙:

- live trading process 내부에는 포함하지 않는다.
- 자동화가 필요하면 cron/pm2 별도 process 로만 등록한다.
- 사용 전 대상 경로와 환경을 직접 확인한다.
- 파일 정리 시 위 2개는 `유지 대상`으로 본다.

권장 cron 예시:

```cron
# KST 03:10 daily. stale 이 아니면 API 호출 없이 종료.
10 18 * * * cd /root/Solana/Solana-Trading/solana-momentum-bot && npm run -s kol:transfer-refresh >> logs/kol-transfer-refresh.cron.log 2>&1
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
- 비핵심 lane (dormant / signal-only) 으로 손실 복구를 시도하지 말 것. (참고: Strategy D 는 2026-04-26 cleanup 시 영구 retire)

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

#### 비용 분해 출력 (Cost Decomposition)

`--hours` 옵션으로 실현 PnL을 조회하면, 각 trade 하단에 비용 서브라인이 추가로 표시된다.

```text
#2 | 14:32 | bootstrap_10s | 0.00001234 → 0.00001180 | -0.000054 SOL | STOP_LOSS | B
   └ decision=0.00001190 exitGap=-0.84% | entry_slip=5bps exit_slip=8bps | rtCost=0.30% effRR=2.1
```

필드 설명:

| 필드 | 의미 |
|------|------|
| `decision` | exit 판정 시점 가격 (TP2/SL/trailing trigger price) |
| `exitGap` | decision price vs 실제 fill price 괴리율 |
| `entry_slip` | 진입 슬리피지 (bps) |
| `exit_slip` | 종료 슬리피지 (bps) |
| `rtCost` | round-trip 총비용 (%) |
| `effRR` | 실효 R:R (slippage/fee 차감 후) |

하단 `COST DECOMPOSITION` 집계 섹션에서 전체 및 토큰별 평균을 볼 수 있다.

**핵심 진단 용도**: "TP2로 종료됐는데 PnL이 음수인 이유"를 `exitGap` + `rtCost`로 즉시 판별 가능.

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
