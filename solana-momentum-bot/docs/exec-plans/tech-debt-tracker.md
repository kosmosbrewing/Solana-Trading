# Tech Debt Tracker

> Last updated: 2026-04-08
> Scope: 현재 운영과 직접 맞닿은 기술 부채만 남긴다.
> Related: [`active/exit-execution-mechanism-2026-04-08.md`](./active/exit-execution-mechanism-2026-04-08.md) (TD-15 참조)

## Current Mission Readiness

- 인프라 블로커: 해소
- 운영 해석 부채: 남아 있음
- 핵심 문제: 기능 부재보다 live canary 해석 품질

## High Priority

| ID | 항목 | 현재 상태 | 다음 조치 |
|---|---|---|---|
| TD-1 | `effectiveRR` 해석 표본 부족 | telemetry patch는 완료, BUY 표본 없음 | 첫 BUY 시그널에서 pre/post-size 비교 확인 |
| TD-2 | blacklist pair 재유입 통제 부족 | 동일 loser pair 재점유 가능성 남음 | scanner cooldown 보강 필요 여부 판단 |
| TD-3 | Gecko `429` data-plane noise | 지속 발생 | cadence 해석과 분리 추적 |
| TD-4 | oversized file debt | 일부 핵심 문서/모듈 여전히 큼 | 기능 작업과 분리해 점진 정리 |
| TD-14 | ~~TP1 partial 30% / TP2 10×ATR / SL 1.5×ATR~~ **Option β 2026-04-10 으로 해소 시도** | Phase X1 gate (≥20 clean trades) 통과 후 Phase X3 Scenario A+B 결합 + TP1 partial 제거 + ATR floor 로 재설계. [`docs/design-docs/strategy-redesign-2026-04-10.md`](../design-docs/strategy-redesign-2026-04-10.md) 참조. 48h live expectancy -0.00108 SOL/trade 확정 후 사용자 결정으로 핫 배포. **검증 미완** — post-deploy ≥ 15 clean trades 누적 후 expectancy / TP2 actual reach / rollback 조건 재평가 필요 |
| TD-15 | Exit execution mechanism mismatch — TP2 intent → actual fill 0/10 | Phase X2 v2 audit (n=18, 2026-04-08): monitor loop 5s polling → Jupiter swap 수초 지연 → 메모코인 price reverse → actual fill 이 SL 근처. `exit_reason=TP2, exit_price=SL_level` 기록. runner-centric 전략의 핵심 가정이 측정상 무효화됨. stamping bug 아니라 mechanism issue | **active plan**: [`active/exit-execution-mechanism-2026-04-08.md`](./active/exit-execution-mechanism-2026-04-08.md). Phase E0 complete → E1 (measurement infra + C5 hybrid paper prototype) 코드 구현 완료 (2026-04-08, paper validation pending). 본 plan 종결 전 exit parameter 결정 금지 (TD-14 선행 조건) |
| TD-16 | PRICE_ANOMALY_BLOCK per-token 80% 차단율 (signal 의 30%+) | 2026-04-08 24h trade-report: 95/308 signals = `[PRICE_ANOMALY_BLOCK]`, per-token 차단율 68~86%. ratio 분포 bimodal (<0.1: 57건, >1.3: 10건, [0.5, 0.7]: 0건) → market slippage 가 아니라 structural unit/decimals bug. pump.fun 특정 아님 (VDOR 68%, SWARMS 86%). 원인 후보: Ultra balance delta fee inclusion, decimals cache miss, partial fill 분기. Phase A3 clamp 는 정상 작동 (자금 보호 중) | **진단 단계**: `signalProcessor.buildEntryExecutionSummary` 에 enhanced diagnostic log (2026-04-09, P1-D2 iter) 추가 완료 — 다음 배포 후 VPS pm2 log 에서 `[PRICE_ANOMALY] Entry price ratio ... expectedIn= actualIn= actualInUi= inputDec= expectedOut= actualOut= actualOutUi= outputDec=` 라인 수집. ratio bucket 별로 실제 입력 값 분류 → decimals mismatch vs wallet delta fee vs API/wallet mismatch 중 확정. root fix 는 수집 후 별도 iter |
| TD-17 | VDOR Raydium CLMM multi-swap-per-tx bad tick | 2026-04-08 24h: VDOR 2969 raw swap 중 149건 (5%) 연속 tick >2x 점프 (0.001 ↔ 0.012 ↔ 0.04). 원인 가설: Raydium CLMM log parser 가 `.reverse().find()` 로 마지막 `Program data:` 만 읽어 aggregator / arbitrage 왕복 시 작은 cleanup leg 의 amounts 를 pool 대표 가격으로 사용. VDOR row 1 (`decision=0.0398`, 3.37x) 등 decision_fill_gap 자릿수 오염의 root cause | **Defense-in-depth 완료 (2026-04-08)**: (1) P0-M2 `MicroCandleBuilder` tick sanity bound ±50% reject, (2) P0-M3 `closeTrade` decision_price sanity clamp, (3) P0-M5 `raydiumSwapLogParser.parseClmmSwapFromLogs` 가 모든 Program data line 을 decode → `amount0 + amount1` 최대 magnitude event 선택. 3 layer 모두 배포 후 VDOR bad tick rate 측정 필요 |
| TD-18 | Option β 재설계 검증 미완 | 2026-04-10: backtest 2026-04-01 sweep 수렴값 (tp2=5.0, tp1=1.5) 복원 + TP1 partial 제거 + ATR floor 0.8% 도입. 이유: 48h live clean expectancy -0.00108 SOL/trade + TP2 actual reach 0%. 전체 근거: [`docs/design-docs/strategy-redesign-2026-04-10.md`](../design-docs/strategy-redesign-2026-04-10.md) | **재평가 조건**: post-deploy clean trades ≥ 15 누적 후 (1) expectancy 재계산 (2) TP2 actual reach (3) rollback 조건 (drawdown > 5%, expectancy < -1.0R, 10연속 loss, new anomaly 등) 점검. rollback 시 이전 orderShape 값 복원 |

## Medium Priority

| ID | 항목 | 현재 상태 | 다음 조치 |
|---|---|---|---|
| TD-5 | `risk/` ↔ `reporting/` 순환 의존 | 구조적 위험 잔존 | 공유 타입/계산 경계 재정리 |
| TD-6 | venue-aware cost model | 가정값 비중 큼 | 실거래 cost 실측 후 보정 |
| TD-7 | realtime/watchlist churn 관측성 | 로그는 있으나 요약이 약함 | source별 retained/reject 집계 강화 |
| TD-9 | `round_trip_cost_pct` 값이 entry-time snapshot (라벨만 정정됨) | 2026-04-07 PR 로 라벨만 `(entry-time gate snapshot)` 표기 | `realized_round_trip_cost_pct` 컬럼 신설 + closeTrade 시 실측값 기록 — `live-ops-integrity-2026-04-07.md` Phase S-2 |
| TD-10 | paper mode `decision == fill` 가정 → fake-fill path 미시뮬 | canary 신뢰도 저하 | paper 실행 시 가짜 slippage 분포 주입 — Phase S-3 |

## Low Priority

| ID | 항목 | 현재 상태 | 다음 조치 |
|---|---|---|---|
| TD-11 | Sanitizer drop 81%+ 상태가 운영자 실시간 가시성 없음 | log 로만 확인 가능 | 일간 drop summary 를 Telegram `OpsDigest` 채널에 push — Phase S-4 |
| TD-13 | `runtime_signal_rows` (realtime-signals.jsonl row 수) vs `trigger_signals` (`trigger_stats:*` 이벤트 수) drift 자동 감지 부재 | Entry 02에서 `8 vs 9` 1건 gap 관측. 두 카운터 정의가 다르고 정상 분포 표본이 없어 임계값 정의 불가. 매뉴얼 분리 기록 룰만 `docs/runbooks/live-ops-loop.md:266`에 존재. 두 카운터 자체는 `ops:check:helius` (`trigger_stats:*`) + `ops:check:sparse` (jsonl row 수)로 이미 노출됨 | **재진입 조건**: ops-history entry가 5건 이상 누적되어 `(trigger_signals - runtime_signal_rows)` 분포의 mean/p95를 정의할 수 있게 된 시점. 그 전에는 임계값 추측 = over-engineering이므로 코드 변경 금지. 재진입 시 `scripts/ops-helius-check.ts:printVerdict` 다음에 두 값과 diff를 한 줄로 출력하는 enhancement만 우선 검토 |

## Resolved Recently

| ID | 항목 | 해결 시점 |
|---|---|---|
| TD-R1 | quote endpoint / executor 401 | 2026-03-25 |
| TD-R2 | BUY sizing SOL/token unit mismatch | 2026-03-25 |
| TD-R3 | Security Gate Birdeye hard dependency | 2026-03-24 |
| TD-R4 | execution viability probe 단위 정합성 | 2026-03-30 |
| TD-R5 | pre-gate / post-size execution telemetry persistence | 2026-03-30 |
| TD-R6 | decision_price + cost decomposition DB/report/Telegram 계측 | 2026-04-06 |
| TD-R7 | fake-fill fallback 4경로 중복 + `currentPrice` 가장 (Phase E P0~P3) | 2026-04-07 |
| TD-R8 | `tradeStore.closeTrade()` positional 11개 → `CloseTradeOptions` 객체 (Phase S-1) | 2026-04-07 |
| TD-R9 | bps ↔ decimal 변환 매직넘버 → `src/utils/units.ts` (Phase S-5) | 2026-04-07 |
