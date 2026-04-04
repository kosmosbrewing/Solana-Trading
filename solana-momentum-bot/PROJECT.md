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
- internal trending key fallback 버그 수정 완료 (Codex, 2026-03-31).

### 아직 미증명인 것
- 양의 기대값
- 안정적인 cadence
- TP1/TP2 도달 구조

### 2026-04-03 해결한 것
- **Bootstrap trigger 구현**: `VolumeMcapSpikeTrigger` — breakout/confirm 제거, volume+buyRatio 2-gate로 signal 밀도 개선
- **Trigger 모드 전환**: `REALTIME_TRIGGER_MODE=bootstrap|core` env var 기반 즉시 전환/롤백
- **mcap context 연동**: watchlist marketCap → trigger meta.volumeMcapPct 자동 주입

### 2026-04-04 해결한 것
- **Bootstrap replay sweep 도구 추가**: 5개 live 세션에 대해 `vm / buyRatio / lookback / cost / stored gate` 비교 가능
- **토큰 leaderboard 추가**: replay 결과에서 blacklist 후보 / reentry 후보 / profile spread를 추출 가능
- **운영 baseline 정렬**: bootstrap 기본 canary는 `vm=1.8 / buyRatio=0.60 / lookback=20`
- **Operator blacklist runtime 반영**: `OPERATOR_TOKEN_BLACKLIST`가 scanner / realtime / legacy candle path에 직접 적용
- **Live buy cost accounting 보정**: entry 원가를 planned notional이 아니라 actual input amount 기준으로 기록
- **Trade report 현실화**: `created_at ledger`와 `closed_at realized PnL`을 분리해 해석

### 2026-04-01 해결한 것
- **Crash loop 해소**: RuntimeDiagnosticsTracker write storm → 30초 throttle + capacity 이벤트 상한
- **RR gate 구조적 rejection 해소**: rrBasis를 tp1→tp2로 변경 (v5 runner-centric 전략 정렬)
- **Pool discovery 용량 4배 증가**: queueLimit 50→200, concurrency 2→4, capacity emit throttle

### 현재 해석
- legacy canary (113 signals): 13 executed, 45 exec viability rejected (39.8%), 21 quote 401 rejected (18.6%)
- 3/31 canary (1 signal): NoKings Grade A, effectiveRR=0.71로 reject → 실제 5분 후 +17.56% 수익
- 4/1: crash loop 발생 (830 sessions/7h) — RuntimeDiagnosticsTracker persist 폭풍이 원인
- 위 3가지 수정으로 다음 canary에서 signal cadence와 execution rate 복구를 기대
- 4/4 replay sweep 기준 `vm=1.8 / buyRatio=0.60 / lookback=20`은 5/5 keep, fixed-notional 추정 기준 가장 안정적
- `vm=2.2 / buyRatio=0.60 / lookback=20`은 더 공격적인 대안이지만 세션 변동성이 더 큼
- replay blacklist 반영형은 추정 PnL이 더 좋았고, 이 결과를 바탕으로 operator blacklist runtime 반영을 추가함
- DB PnL은 과거 row에 대해 낙관 편향 가능성이 확인됐고, entry actual-cost patch 이후 새 trade부터 다시 검증이 필요함

## 로드맵

| Phase | 목표 | 현재 상태 |
|-------|------|----------|
| Phase 0 | 기존 봇 안정화 | 완료 |
| Phase 1 | Live Bootstrap 해석 가능 상태 확보 | **진행 중 — blocker 3건 해소** |
| Phase 2 | 첫 공식 Mission / Execution / Edge 판정 | 미도달 |
| Phase 3 | 양의 기대값 반복 확인 후 소규모 복리화 | 미시작 |

### Phase 1의 현재 우선순위
1. patched live canary에서 `vm=1.8 / buyRatio=0.60 / lookback=20` cadence와 BUY path 확인
2. operator blacklist hit / watchlist 품질 / actual-cost accounting 반영 여부 확인
3. TP2-basis RR gate 통과율과 실제 wallet-vs-DB PnL 차이 재측정
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
