# Completed Issues Archive

> Last updated: 2026-03-15 HB13
> Purpose: solved items, partial progress history, decisions, and archived plans

---

## Completed Work

### Core

- pump_detect 실행 경로 제거
- fib_pullback 동적 스코어링 (`buildFibPullbackScore()`)
- `checkTokenSafety()` -> `checkOrder()` 연결
- lpBurned / ownershipRenounced -> 포지션 사이징 반영
- Daily loss halt -> 실제 trading halt 연결
- HWM 저장 + trailing stop 반영
- TP1 partial exit + 잔여 trailing 유지
- Gate 모듈 추출로 live/backtest 공유 경로 구성
- DrawdownGuard 통합
- EventScore gate 연동
- Risk Tier System 구현
- Risk Tier 승급 품질 게이트 추가
- Execution viability actual-size 재검증 추가
- `minBuyRatio` hard reject 추가
- Backtest `EXHAUSTION` / RSI adaptive trailing parity 추가
- Backtest static + time-series EventScore replay 지원
- Pair-level EdgeTracker stats + 기본 auto blacklist 추가
- Blacklist decay / 재활성화 정책 (`decayWindowTrades` 슬라이딩 윈도우)
- `index.ts` orchestration 분리 시작
- `handleNewCandle()` → `orchestration/candleHandler.ts` 분리 완료
- Execution viability early probe: 예상 포지션 사이즈 기반 probe 구현 (`estimatedPositionSol`)
- Multi-period trend alignment 실제 구현 (`calcMultiPeriodAlignment` — 5/10/20봉 정렬)

### Quality

- ESLint 9 flat config 생성
- Jest config 경로 수정
- 미사용 import/변수 정리
- EventScore → AttentionScore/AttentionGate 전체 재명명 (17 파일, backward-compatible aliases)
- `scripts/backtest.ts` any 타입 제거 + CLI flag rename
- deprecated `getAllActiveScores()` 제거
- `scripts/migrate.ts` `client: any` → `PoolClient` 타입 적용
- `backtest/reporter.ts` 포맷 불일치 수정 (콜론 뒤 공백)

---

## Resolved / Partially Resolved Details

### C-5. Tier 승급 품질 게이트

상태: 해결

적용:
- WR
- R:R
- Sharpe
- max consecutive losses

잔여:
- Kelly cap 하향 검토
- 최근 성과 기반 강등 메커니즘

### C-7. Backtest 청산 규칙 parity

상태: 해결

적용:
- Exhaustion exit
- RSI adaptive trailing
- `runCombined()` 동시성 제약

### C-1. Backtest/Live gate parity

상태: 부분 해결

적용:
- shared gate
- static EventScore input
- time-series EventScore replay

미완료:
- historical EventScore dataset 운영 수집

### C-3. Pair-level controls

상태: 해결

적용:
- pair stats
- auto blacklist
- blacklist decay / 재활성화 (`decayWindowTrades` — 최근 N개 윈도우 평가, 기본 10)

잔여:
- 전략별-페어별 교차 통계 (M-2와 통합 검토)
- 임계값 튜닝 (backtest 데이터 수집 후)

### C-6. Execution viability

상태: 해결

적용:
- actual-size pre-execution validation
- backtest execution viability parity
- early gate probe: `estimatedPositionSol` 파라미터 추가, 스탑 거리 기반 예상 사이즈 계산

### M-3. Multi-TF alignment

상태: 해결

적용:
- `multiTfAlignment: 1` 하드코딩 → `calcMultiPeriodAlignment()` 실측
- 5봉/10봉/20봉 트렌드 정렬 수 (0~3) → 0~20점 기여

### H-2. Spread

상태: 부분 해결

적용:
- 1분봉 high/low spread proxy

미완료:
- quote/bid-ask source

### H-3. AMM fee

상태: 부분 해결

적용:
- configurable fee / mev margin
- conservative defaults

미완료:
- stable pool-specific fee source

### H-4. DrawdownGuard

상태: 해결

적용:
- unrealized PnL 포함 mark-to-market drawdown 반영

### H-5. `index.ts` modularization

상태: 해결

적용:
- `orchestration/signalProcessor.ts`
- `orchestration/tradeExecution.ts`
- `orchestration/reporting.ts`
- `orchestration/types.ts`
- `orchestration/candleHandler.ts` (`handleNewCandle()` 분리)

성과:
- `index.ts` 1061줄 → 271줄

### C-4. EventScore 정체성 불일치

상태: 해결 (재명명)

적용:
- EventScore → AttentionScore, EventScorer → AttentionScorer 전체 재명명 (17 파일)
- Deprecated type aliases 유지로 backward compatibility 보장
- filter reason: `no_event_context` → `not_trending`
- component key: `event_score` → `attention_score`

### L-1. `scripts/backtest.ts` 타입 정리

상태: 해결

적용:
- `any[]` → `Candle[]`, `BacktestResult` 등 구체 타입 적용
- `numArg`/`boolArg` 함수 오버로드로 반환 타입 정밀화
- `cleanUndefined`: `Record<string, unknown>`
- CLI flag rename (--require-attention-score 등, backward compat 유지)

### L-4. deprecated Event API cleanup

상태: 해결

적용:
- `getAllActiveScores()` 제거 (호출처 없음 확인)

---

## Historical Decisions

### Q-1. EventScore -> AttentionGate 재명명

결론:
- 현 구현은 외생 이벤트 스코어라기보다 attention / momentum whitelist에 가깝다
- 문서/코드 네이밍 정리 필요

남은 실행:
- 변수/타입/로그 rename
- PROJECT.md / STRATEGY.md 정리

### Q-2. 10-preset backtest 비교

결론:
- 이론보다 preset 비교로 파라미터 검증

전제:
- backtest parity 확보 후 실행

### Q-3. Combined backtest 정합성

결론:
- C-7 해결과 함께 사실상 해소

---

## Archived Planning Notes

이전 `ISSUES.md`에 섞여 있던 장문 설명, 과거 리뷰 finding, solved reasoning, preset 아이디어는 여기로 이관했다.
운영용 active tracker는 `ISSUES.md`만 본다.
