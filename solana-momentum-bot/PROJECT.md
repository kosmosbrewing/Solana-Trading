# Project Goals & Persona

## Persona

### 운영자
- 1인 개발자, 100개 웹 서비스 런칭을 목표로 하는 CTO
- Solana 트레이딩 봇은 자동화 수익 파이프라인 중 하나
- 24/7 무인 운영이 전제 — 수동 개입 최소화
- 리스크 성향: 보수적 (자본 보존 우선, 공격적 수익 추구 아님)

### 봇
- 이름: Solana Momentum Bot
- 역할: Solana DEX meme/event 토큰의 모멘텀 진입/청산을 자동 수행
- 성격: "이유 없이 추격하지 않는 트레이더"
- 운영 원칙: 이벤트가 설명되지 않으면 진입하지 않음

## 목표

### 최종 목표 (v1.0)
이벤트 기반 선행 컨텍스트 + 온체인 트리거 2단계 진입 봇

> "가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다."

### 구체적 목표
1. **설명되지 않은 급등을 추격하지 않는다** — 가짜 펌프 필터링
2. **이벤트/내러티브가 확인된 코인만 감시한다** — 선행 컨텍스트
3. **온체인 확인 후에만 진입한다** — 브레이크아웃은 트리거일 뿐
4. **스캠/조작 리스크를 사전 차단한다** — 게이트 시스템
5. **모든 트레이드를 추적 가능하게 기록한다** — 후보 → 게이트 → 트리거 → 결과

### 비목표 (하지 않을 것)
- 고빈도 매매 (HFT) — 인프라 열위로 불가능
- 마켓 메이킹 — 자본 규모 부족
- 전 DEX 스캔 스나이핑 — MEV 봇과 경쟁 불가
- 과최적화된 백테스트 성과 추구 — 실전 괴리가 큼

## 전략 모델

### 2단계 진입
```
Stage 1: 왜 이 코인이 움직일 수 있는가? (Context)
  → Event Catch, Spike Explanation, New Coin Tracking

Stage 2: 지금 들어가도 되는가? (Trigger)
  → Onchain Breakout Confirmation + Risk Gate
```

### 게이트 시스템 (점수 합산 X, 단계별 필터)
- Gate 1: ScamRisk > 임계치 → 즉시 제외
- Gate 2: Attention / Context score → 감시 강도 / 사이즈 결정
- Gate 3: OnchainBreakout → 실제 체결 여부
- Gate 4: Execution Viability → 슬리피지, stale, 추격 금지

### 핵심 원칙
- 브레이크아웃은 메인 전략이 아니라 트리거
- 메인 엣지는 이벤트 선별 + 스캠 제거 + 실행 타이밍 조합
- "뉴스 없는 급등 = 조작 가능성" → 추격 금지 기본

## 인프라

| 구성 | 선택 | 이유 |
|------|------|------|
| VPS | Vultr (US East) | Solana RPC 레이턴시, NVMe SSD |
| OS | Ubuntu 22.04 LTS | Docker/Node.js 호환성, 레퍼런스 |
| RPC | Helius | Solana 전용, Jupiter 궁합, Priority Fee API |
| DB | TimescaleDB (PG 16) | 시계열 캔들 데이터, 압축/보존 정책 |
| DEX | Jupiter API (quote/swap) | 최적 경로, 슬리피지/price impact 검증 |
| 알림 | Telegram Bot | 4-Level Alert (Critical/Warning/Trade/Info) |
| 프로세스 관리 | pm2 or systemd | 크래시 자동 재시작 |

## 로드맵

| Phase | 목표 | 상태 |
|-------|------|------|
| Phase 0 | 기존 봇 안정화 (데드코드, safety, 청산) | 완료 |
| Phase 1 | Spike Explanation + scanner/gate 기반 정리 | 완료 |
| Phase 2 | Event Catch (Birdeye 중심 + X stream 코드 경로) | 구현 완료, 외부 검증 대기 |
| Phase 3 | Candidate-Driven Execution (게이트 통합) | 완료 |
| Phase 4 | New Coin Pipeline + sandbox/conditional 전략 | 완료 |

## 판단 기준

### 성공 지표 (REFACTORING.md metrics section)
- Expectancy after fees and slippage > 0
- Explained vs unexplained candidate conversion rate
- Win rate by gate path
- Candidate-to-trade conversion rate
- 모든 트레이드에 source attribution 존재

### 실패 조건
- 설명 없는 급등에 반복 진입
- 백테스트와 실전 성과가 체계적으로 괴리
- 일일 손실 한도를 실제로 강제하지 못함
- 운영자가 수동 개입 없이 봇을 운영할 수 없음
