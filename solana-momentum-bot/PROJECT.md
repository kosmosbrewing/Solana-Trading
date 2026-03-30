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
- Quote 401, executor 401, BUY sizing 단위 버그는 해소됐다.
- live trailing / wick-aware exit / execution viability telemetry 보강 패치가 반영됐다.

### 아직 미증명인 것
- 양의 기대값
- 안정적인 cadence
- TP1/TP2 도달 구조
- `effectiveRR` gate가 실제 거래 가능성을 과도하게 막고 있는지 여부

### 현재 해석
- 2026-03-25~26 baseline에서는 12건 거래가 체결됐지만 성과는 음수였다.
- 2026-03-30 post-patch canary 12.2시간에서는 진입 0건이었고, 주 원인은 `poor_execution_viability`와 pair blacklist였다.
- 이후 telemetry patch를 넣고 `2026-03-30 22:22:46 UTC`에 재시작했지만, 최신 21분 구간에서는 아직 BUY 시그널이 0건이라 새 telemetry를 평가할 표본이 없다.

## 로드맵

| Phase | 목표 | 현재 상태 |
|-------|------|----------|
| Phase 0 | 기존 봇 안정화 | 완료 |
| Phase 1 | Live Bootstrap 해석 가능 상태 확보 | 진행 중 |
| Phase 2 | 첫 공식 Mission / Execution / Edge 판정 | 미도달 |
| Phase 3 | 양의 기대값 반복 확인 후 소규모 복리화 | 미시작 |

### Phase 1의 현재 우선순위
1. 첫 post-patch BUY 시그널에서 `execution.preGate` / `execution.postSize` 비교 확보
2. `poor_execution_viability`가 실제 blocker인지 검증
3. blacklist pair 재유입과 scanner churn 분리
4. Gecko `429`와 unsupported venue 노이즈를 운영 해석과 분리

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
