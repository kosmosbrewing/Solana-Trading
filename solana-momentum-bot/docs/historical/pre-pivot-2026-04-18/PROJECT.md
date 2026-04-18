# Project Goals & Persona

## Persona

### 운영자
- 1인 개발자, 자동화 수익 파이프라인을 축적하는 CTO
- Solana 트레이딩 봇은 여러 자동화 시스템 중 하나
- 24/7 무인 운영 전제, 수동 개입 최소화
- 리스크 성향: 보수적, 자본 보존 우선

### 봇
- 이름: Solana Momentum Bot
- 역할: Solana DEX meme/event 토큰의 모멘텀 진입/청산 자동화
- 운영 원칙: 이유 없이 추격하지 않는다

## 목표

### 최종 목표
이벤트 기반 선행 컨텍스트 + 온체인 트리거 2단계 진입 봇

> 가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다.

### 구체적 목표
1. 설명되지 않은 급등을 추격하지 않는다.
2. 이벤트/내러티브가 확인된 코인만 감시한다.
3. 온체인 확인 후에만 진입한다.
4. 스캠/조작 리스크를 사전 차단한다.
5. 모든 트레이드를 추적 가능하게 기록한다.

### 비목표
- 고빈도 매매
- 마켓 메이킹
- 전 DEX 스나이핑 경쟁
- 실전 괴리를 무시한 백테스트 최적화

## 전략 모델

### 2단계 진입
```text
Stage 1: Context
  Event Catch / AttentionScore / Discovery

Stage 2: Trigger
  Onchain breakout confirmation + sequential gates + risk sizing
```

### 게이트 시스템
- Gate 0: Security
- Gate 1: AttentionScore / Context
- Gate 2: Execution Viability + Quote
- Gate 3: Strategy Score
- Gate 4: Safety
- Exit Gate: Sell-side Impact

## 현재 상태 스냅샷

### 확인된 것
- live 파이프라인은 `signal -> gate -> risk -> execute -> manage exit`까지 end-to-end로 동작한다.
- Bootstrap trigger `bootstrap_10s`가 유일한 유효 trigger (10s candle, volume+buyRatio 2-gate).
- 5m Strategy A/C는 밈코인 모멘텀(10-30s)에 구조적 비적합 → **dormant** (04-05 확인).
- Signal attribution 기록 체계 강화 완료: marketCap context, crash-safe signal-intent, strategy별 분리 집계, zero-volume skip.
- 운영 baseline 안정: `vm=1.8 / buyRatio=0.60 / lookback=20`.

### 아직 미증명인 것
- 양의 기대값 (4/4 세션 1건만 pass, 나머지 reject)
- 안정적인 cadence
- Sparse data insufficient 81% 해소 → edge 재현성

### 2026-04-05 해결한 것
- **Signal attribution 4-feature 구현** (commit 076e1f4):
  1. MarketCap/FDV in signal context
  2. Signal-intent 즉시 기록 (crash-safe persistence)
  3. Strategy별 분리 집계 (summarizeRealtimeSignalsByStrategy)
  4. Zero-volume candle skip (persist 90% 감소)
- **Replay-loop 병렬 백테스팅**: 4 sessions × 2 modes = 8 parallel backtests → 리포트 생성
- **핵심 발견**: sparse data insufficient 81% 차단 → 이것이 edge 측정 자체를 불가능하게 만드는 최대 병목

### 현재 해석
- Bootstrap edge가 **1/4 세션에서만 확인** (04-04 edgeScore 78, +6.89%)
- 나머지 3 세션은 edgeScore 8로 reject — sparse 81% 차단이 평가 모수를 제한
- 5m Strategy A/C는 87 pairs × 3 strategies = 261 combination 중 **3건만 trade** → 사실상 사망
- **Critical Path**: Sparse 해소 → 평가 모수 확대 → edge 재현성 확인 → paper 50-trade → live enablement

## 로드맵

| Phase | 목표 | 현재 상태 |
|-------|------|----------|
| Phase 0 | 기존 봇 안정화 | 완료 |
| Phase 1 | Live Bootstrap 해석 가능 상태 확보 | **진행 중 — sparse 병목 해소 필요** |
| Phase 2 | 첫 공식 Mission / Execution / Edge 판정 | 미도달 |
| Phase 3 | 양의 기대값 반복 확인 후 소규모 복리화 | 미시작 |

### Phase 1의 현재 우선순위
1. **P0: Sparse Insufficient 81% 병목 해소** — edge 측정 자체를 가능하게 만들기
2. 04-04 세션 edge (score 78)의 재현성 검증 — runner outlier vs 구조적 edge 판별
3. Legacy 세션 OOM 해결 후 재검증 (113 stored signals)
4. bootstrap 50 trades 확보 → Gate-Proven Sample 도달

## 인프라

| 구성 | 선택 |
|------|------|
| VPS | Vultr (US East) |
| OS | Ubuntu 22.04 LTS |
| RPC | Helius |
| DB | TimescaleDB |
| DEX execution | Jupiter |
| 알림 | Telegram |
| 프로세스 관리 | pm2 |
