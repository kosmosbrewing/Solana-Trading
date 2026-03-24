# Execution Plan: 1 SOL → 100 SOL

> Created: 2026-03-17
> Updated: 2026-03-25
> Mission: Paper Trading → Live Bootstrap → 복리 성장
> 원칙: "코드를 더 만들 시간이 아니라, 만든 걸 돌릴 시간"

---

## 현재 위치

```
코드/인프라:  ████████████████████░  95%  (핵심 경로 완성, 운영 버스트 보정 중)
실전 검증:   ░░░░░░░░░░░░░░░░░░░░   0%  (paper trade 0건)
라이브:      ░░░░░░░░░░░░░░░░░░░░   0%
```

### 완료된 것
- 전략 A/C 코어 + D sandbox + E cascade 배선
- 5단 게이트 시스템 (Security → Context → Score → Execution → Safety)
- Risk Tier (Bootstrap → Proven), Kelly, Demotion, DD Guard, Daily Loss Halt
- GeckoTerminal + DexScreener 동적 watchlist + ScannerEngine
- Security Gate Birdeye 의존 제거 (Helius RPC 온체인 조회)
- Jupiter quote gate, Jito bundle, WalletManager 격리
- 백테스트 엔진, 통계 유틸, EdgeTracker, PaperValidation
- CRITICAL 24 / HIGH 33 / MEDIUM 20+ 이슈 전부 해결

### 남은 외부 작업
- X Filtered Stream: Bearer Token + rule 등록 (급하지 않음, socialScore 없어도 운영 가능)

---

## 즉시 작업: VPS Paper 배포 준비

### 완료된 사전 작업 (2026-03-18)

- ✅ Strategy A mcap/volume ratio 6번째 팩터 추가 (`calcVolumeMcapRatio`)
- ✅ RegimeFilter 데이터소스 수정 (SOL_USDC_PAIR → getTokenOHLCV)
- ✅ Exit Gate 구현 (SpreadMeasurer.measureSellImpact + gate 배선)
- ✅ SOL_MINT 상수 중앙화 (`utils/constants.ts`)
- ✅ Jupiter Ultra 포지셔닝 ADR-005 확정
- ✅ REST-only 운영 가능 (WS/Strategy D 기본 비활성)

### 남은 배포 준비 항목

**.env.example 확인:**
```
TRADING_MODE=paper
SCANNER_ENABLED=true
SCANNER_DEX_DISCOVERY_MS=60000
# BIRDEYE_WS_ENABLED=false  (기본값)
# STRATEGY_D_ENABLED=false   (기본값)
```

**결과**: paper trading 핵심 경로는 Birdeye 없이도 운영 가능. Birdeye는 Strategy D event provider/legacy tooling에서만 optional로 남아 있다.

---

## Phase 1: Paper Trading 배포 (Week 1)

### 목표
VPS에 paper mode로 배포하고, 시스템이 실시간 데이터를 먹고 가상 트레이드를 기록하는지 확인한다.

### 체크리스트

- [ ] `.env` 설정 확인
  - `SOLANA_RPC_URL` (Helius)
  - `DATABASE_URL` (TimescaleDB)
  - `TRADING_MODE=paper`
  - `SCANNER_ENABLED=true`
  - `BIRDEYE_WS_ENABLED` 미설정 (기본 false)
  - `STRATEGY_D_ENABLED` 미설정 (기본 false)
  - `BIRDEYE_API_KEY`는 optional (Strategy D event source / legacy tooling에서만 사용)
- [ ] TimescaleDB 스키마 마이그레이션 (`scripts/migrate.ts`)
- [ ] VPS 배포 (Vultr US East)
  - pm2 또는 systemd로 프로세스 관리
  - Telegram alert 연결
- [ ] Paper mode 가동 확인
  - REST polling으로 ScannerEngine watchlist 갱신
  - Gate 평가 로그 출력
  - `trades` 테이블에 `tx_signature='PAPER_TRADE'` 레코드 생성
- [ ] 24시간 안정성 모니터링
  - 메모리/CPU 안정
  - 에러 로그 없음

### 예상 비용
- VPS: ~$12/월
- Helius RPC: Developer tier
- Birdeye: optional
- SOL: 0 (paper mode)

### 현재 운영 메모 (2026-03-25)

- Helius `Developer` 업그레이드 후에도 startup `seed backfill` burst는 남아 있어
  `REALTIME_SEED_BACKFILL_ENABLED=false`로 보는 bootstrap 운영이 현재 기본값이다.
- `REALTIME_DISABLE_SINGLE_TX_FALLBACK_ON_BATCH_UNSUPPORTED=true`는 플랜과 무관하게 유지한다.
- GeckoTerminal `429`는 아직 남은 data-plane 리스크이며, watchlist/churn을 먼저 통제한다.

---

## Phase 2: Paper 검증 (Week 2–3)

### 목표
50 trades 이상 축적하여 전략의 실전 기대값을 측정한다.

### 관찰 지표

| 지표 | 기준 | 의미 |
|------|------|------|
| Expectancy (after fees/slippage) | > 0 | 핵심 — 양수여야 라이브 가치 있음 |
| Win Rate | 참고 (전략별 다름) | A는 30~40%, C는 40~50% 예상 |
| Candidate → Trade 전환율 | 참고 | 게이트가 너무 빡빡하거나 느슨한지 |
| Gate Rejection 분포 | 참고 | 어느 게이트에서 주로 걸리는지 |
| Quote Decay (quote vs fill 차이) | < 1% | 실행 품질 |
| Hold Time 분포 | 참고 | Time stop 비율이 높으면 전략 재검토 |
| Exit Reason 분포 | 참고 | SL vs TP1 vs TP2 vs Trailing |
| **mcap/volume ratio별 승률** | 참고 (신규) | 새 팩터의 실효성 검증 |

### PaperValidation 리포트
```bash
npx ts-node scripts/paper-report.ts
```

### 판단 기준

| 결과 | 행동 |
|------|------|
| Expectancy > 0, 시스템 안정 | → Phase 3 (Live) |
| Expectancy ≈ 0, 특정 게이트/파라미터 이슈 | → 파라미터 조정 후 재검증 |
| Expectancy < 0 | → 전략 재검토, 백테스트 엔진으로 파라미터 민감도 분석 |

---

## Phase 3: Live Bootstrap (Week 4+)

### 목표
실제 SOL로 극소 사이징 트레이딩 시작. 실전 슬리피지와 fill rate 측정.

### 조건
- Paper 50 trades에서 expectancy > 0 확인됨
- 시스템 24시간+ 무중단 운영 확인됨

### 설정
- `TRADING_MODE=live`
- Risk Tier: **Bootstrap** (1% risk/trade, 5% daily limit, 30% max DD)
- 시작 자본: **1 SOL**
- 최대 1 포지션, 3연패 시 30분 쿨다운

### 모니터링
- 실전 슬리피지 vs paper 추정치 비교
- 실제 fill rate
- Telegram 알림 정상 수신
- Daily PnL 추적

---

## Phase 4: 성장 (Month 2+)

### 자동 승급 경로

```
Bootstrap (<20 trades)
  │  1% risk, Kelly 비활성
  │
Calibration (20–50 trades)
  │  1% risk, Kelly 비활성
  │
Confirmed (50–100 trades)
  │  Kelly 1/4 활성 (≤6.25%)
  │  Strategy E 조건부 활성화 검토
  │
Proven (100+ trades)
     Kelly 1/2 활성 (≤12.5%)
     복리 성장 본격화
```

### 복리 시뮬레이션 (참고용, 보장 아님)

| 시나리오 | 월 수익률 | 1 SOL → 100 SOL |
|---------|----------|-----------------|
| 보수적 | 15% | ~33개월 |
| 중립 | 30% | ~18개월 |
| 공격적 | 50% | ~12개월 |

> 현실적으로 월 수익률은 시장 상태에 따라 극단적으로 변동한다.
> 중요한 건 "기대값 양수 유지 + 파산 방지"이다.

### 조건부 활성화

| 항목 | 활성화 조건 |
|------|-----------|
| Strategy E (Cascade) | A의 live expectancy > 0 + 50 trades |
| Strategy D (New LP) | Jito 정상 + sandbox 지갑 별도 충전 + listing source 확인 |
| Kelly Sizing | edgeState = Confirmed + kellyFraction > 0 |
| X Social Score | Bearer Token 설정 후 |
| Optional listing feed | Strategy D event source가 준비된 경우 |

---

## 병행 작업 (급하지 않음)

| 항목 | 시점 | 이유 |
|------|------|------|
| X Filtered Stream 실연동 | Paper 안정화 후 | socialScore는 보조 피처 |
| 백테스트 파라미터 스윕 | 필요 시 | TP1 배수, 볼륨 배수 민감도 확인용 |
| Strategy D listing source 연결 | Strategy D 활성화 시 | 현재는 Birdeye WS adapter + scanner lane-B adapter (fast Gecko new_pools + slower open-slot Gecko trending fallback + Dex boosts + Dex latest token profiles/community takeovers/ads + fast Dex discovery cadence + discovery source attribution persistence to signal/trade/report + AttentionScore/gate trace snapshot to audit/position + daily source outcome reporting), provider 교체 가능 구조 유지 |

---

## 금지 사항 (변함없음)

- Jito 없이 Strategy D 라이브 금지
- 라이브 표본 < 50에서 Kelly 활성화 금지
- Strategy A 기대값 미검증 상태에서 Strategy E 공격적 활성화 금지
- DexScreener/X 데이터를 매수 트리거로 사용 금지
- 설명 없는 급등 추격 금지

---

## 한 줄 요약

> **지금 할 일: .env 정비 → VPS paper 배포 → 50 trades 축적 → Phase 2 검증.**
