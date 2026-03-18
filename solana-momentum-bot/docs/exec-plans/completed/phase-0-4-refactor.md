# Solana Momentum Bot Refactoring Status

> Updated: 2026-03-18
> Status: core refactor complete
> Remaining blocker: external X Filtered Stream live validation
> Archive: `docs/exec-plans/completed/issues-archive.md`

---

## 1. Outcome

초기 목표였던 "single-pair breakout runner"에서 "event-aware, multi-candidate, multi-strategy runtime"으로의 전환은 완료됐다.

- 단일 `TARGET_PAIR_ADDRESS` 의존 구조에서 동적 watchlist 구조로 전환
- 전략 A/C 중심 코어 실행 경로에 Strategy D sandbox, Strategy E cascade 추가
- security / execution viability / risk tier / demotion / daily loss / wallet isolation 배선 완료
- 백테스트, 통계 유틸, 리포팅, paper validation 경로 정리 완료

현재 남은 작업은 리팩터링이 아니라 외부 서비스 자격증명 기반 검증이다.

---

## 2. Current Runtime Shape

### Discovery / Candidate Layer

- Birdeye WS + DexScreener enrichment 기반 watchlist 갱신
- ScannerEngine이 manual entry, trending, new listing, social mention 추적을 흡수
- AttentionScore/WatchlistScore가 후보 우선순위를 결정

### Strategy / Gate Layer

- Strategy A: Volume Spike Breakout
- Strategy C: Fib Pullback
- Strategy D: New LP Sniper, sandbox wallet 전용
- Strategy E: Momentum Cascade, Strategy A 확장형 add-on
- Gate 순서: security -> context/score -> execution viability -> risk

### Execution / Risk Layer

- Jupiter quote 기반 spread/fee/impact 검증
- WalletManager가 전략별 지갑, 일일 손실, 포지션 한도 책임 통합
- Drawdown guard, cooldown, Kelly, demotion, tiered sizing 활성화
- Jito bundle 경로와 standard RPC fallback 공존

### Reporting / Validation Layer

- EventScore DB 영속화 + backtest replay
- bootstrap CI / permutation test 기반 통계 유틸
- EdgeTracker / PaperValidation 공통 risk metrics 재사용

---

## 3. What Was Removed Or Demoted

- dead `pump_detect` live path 제거
- 문서상만 존재하던 safety / spread / risk 연결을 실제 실행 경로에 반영
- God object 성격이 강했던 `index.ts`, `EdgeTracker`, wallet/risk 책임 일부 분리
- "Phase 진행 중"으로 남아 있던 완료 항목을 active tracker에서 제거

---

## 4. Remaining Work

### Operational blocker

- `C-2`: X Filtered Stream 실연동
  - 코드/테스트: 완료
  - 남은 것: Bearer Token, rule 등록, live smoke test

### Optional optimization backlog

- Birdeye WS -> Helius WS 전환 검토
- `.env.example` / 운영 템플릿의 잔여 legacy 기본값 주기 점검

---

## 5. Metrics That Still Matter

리팩터링 완료 여부보다 운영 품질이 더 중요하다. 계속 볼 지표는 아래다.

- expectancy after fees and slippage
- candidate-to-trade conversion rate
- stale-signal rejection rate
- recent-window win rate / reward-to-risk for demotion
- strategy별 hold time / exit reason distribution
- source attribution completeness

---

## 6. Done Definition

다음 조건을 충족했으므로 리팩터링 목표는 달성된 것으로 본다.

- 더 이상 single-pair runner가 아니다.
- 모든 주요 live trade path가 후보, 게이트, 전략, 리스크 검증으로 추적된다.
- unexplained pump 추격을 기본 경로에서 막는다.
- 주요 파라미터와 안전장치가 실제 런타임에 연결돼 있다.
- 추가 전략과 외부 이벤트 소스를 붙일 구조가 이미 준비돼 있다.
