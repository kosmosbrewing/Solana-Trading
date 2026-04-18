# Block QA

## DEX_TRADE Phase 1-3 QA Closure (2026-04-18)

- Date: 2026-04-18
- Scope:
  - Phase 1.1: `src/strategy/wsBurstDetector.ts`
  - Phase 1.2: `scripts/wsBurstPaperReplay.ts`, `docs/audits/ws-burst-detector-calibration-2026-04-18.md`
  - Phase 1.3: `src/orchestration/pureWsBreakoutHandler.ts` (scanPureWsV2Burst) + config entries + `src/index.ts` wiring
  - Phase 2: `src/execution/bleedModel.ts`, `src/gate/probeViabilityFloor.ts`, `src/risk/dailyBleedBudget.ts`
  - Phase 3: `src/risk/quickRejectClassifier.ts`, `src/risk/holdPhaseSentinel.ts`, `scripts/ruinProbability.ts`
  - Handler integration: PROBE state (quickReject), RUNNER T1/T2/T3 (holdPhase), entry (viability + bleed), close (reportBleed)

### Verdict

- **방향 + 기본 구현 정확**
- **2 개 HIGH/MED buy bug fix 적용**: F8 (scanner cooldown premature), F10 (quickReject over-rejection)
- **4 개 LOW/MED finding 문서화**: F2/F4/F5/F6 — 현재 동작은 safe, 문서화로 마감

## Findings

### F1 — PASS: `DEGRADED_EXIT` CloseReason + notifier label 호환

`src/utils/types.ts:179` 에 `DEGRADED_EXIT` 존재, `src/notifier/messageFormatter.ts:35` 에 label 존재. holdPhaseSentinel 이 close reason 으로 사용 가능.

### F2 — MED (문서화): paper mode 에서 viability floor + bleed budget 이 작동

- 현재 구현: `probeViabilityFloorEnabled=true` + `dailyBleedBudgetEnabled=true` 가 paper mode 에서도 활성
- `walletStopGuard` poller 는 live 전용 → paper 에서 `lastBalanceSol=Infinity` → fallback `walletStopMinSol+0.01=0.81 SOL`
- Paper loss 가 virtual bleed budget 소진 → 과다 paper entry 제한 가능
- **판정**: 설계 의도 (시뮬 = 실전 조건 반영) 관점에서는 맞음. 단, wallet baseline 이 0.81 hard-coded 라 실 wallet 과 불일치 → 운영자가 paper 관측 시 "왜 entry 가 적지?" 혼동 가능
- **조치**: 현재 동작 유지 + 문서화 (이 Block_QA 로 기록). 필요 시 paper 전용 `paperBleedBudgetDisabled` env 추가 고려

### F3 — PASS: quickReject / holdPhase 가 paper-first 우회 경로에서 작동하지 않음

paper-first check 는 position 생성 전 `return` → `activePositions` 에 추가 안 됨 → `updatePureWsPositions` 루프가 skip → classifier/sentinel 동작 경로 없음. 정상.

### F4 — LOW (문서화): wallet baseline fallback 0.81 SOL 보수성

- Viability floor + bleed budget 이 `walletStopGuard.lastBalanceSol` 의존
- `lastBalanceSol = Number.POSITIVE_INFINITY` 초기값 → `Number.isFinite()` 체크 → fallback `walletStopMinSol + 0.01 = 0.81 SOL`
- 현재 실 wallet (1.05 SOL) 보다 낮음 → daily cap 실질 0.05 SOL (min floor 작동) 으로 수렴
- **실전 영향**: 첫 30초 + RPC 실패 지속 시 발생. Cap 이 운영자 기대치 보다 **작은 방향** (safer) 이지만 entry 기회 축소
- **조치**: 현재 동작 유지. 향후 `walletDeltaComparator.baselineBalanceSol` 을 우선 사용 옵션 검토 (comparator 는 더 정확한 baseline 유지)

### F5 — LOW (문서화): reverse_quote_stability placeholder 가 minPassScore tuning 에 포함됨

- `wsBurstDetector`: `W_REVERSE=5`, `f_reverse_quote_stability = 1.0` (Phase 1 placeholder) → burst_score 에 항상 `+5` 자동 기여
- Paper replay 기반 `tuned minPassScore=50` 은 이 placeholder 포함 점수 분포 기반
- Phase 2 실 reverse quote 통합 시 placeholder → 실 값 (< 1.0 확률 많음) 로 교체되면 기존 threshold 재튜닝 필요
- **조치**: `docs/audits/ws-burst-detector-calibration-2026-04-18.md` 에 이 dependency 명시 (아래 실행 중)

### F6 — LOW (문서화): replay script 가 `DEFAULT_WS_BURST_CONFIG` 사용

- `scripts/wsBurstPaperReplay.ts` 는 hard-coded `DEFAULT_WS_BURST_CONFIG` 로 돌림
- 현재 live runtime 은 `config.ts::pureWsV2*` tuned values 사용 (이미 Phase 1.3 에서 주입)
- 재 replay 하면 원본 threshold 로 다시 돌아감 → tuned 재검증 불가
- **조치**: 현재 intended (historical baseline calibration 용도). 필요 시 `--config-env` CLI flag 추가 후보

### F7 — PASS: close path invariants 단일 소스

`closePureWsPositionSerialized` 함수 내부에서 `reportCanaryClose(LANE_STRATEGY, pnl)` + `releaseCanarySlot(LANE_STRATEGY)` + `reportBleed(...)` 모두 호출됨 (line 898-911). 모든 close trigger (hardcut, quickReject, timeout, trail, T1/T2/T3 trail, holdPhase) 가 동일 함수 경유 → 일관성.

### F8 — MED (FIXED): v2 scanner cooldown premature

**Before (bug)**:
```ts
log.info(`[PUREWS_V2_PASS] ...`);
v2LastTriggerSecByPair.set(pair, nowSec);  // ← cooldown here
await handlePureWsSignal(syntheticSignal, candleBuilder, ctx);
```

handler 가 viability / paper-first / concurrency reject 해도 cooldown 5분간 작동 → 같은 pair 에서 추가 burst 놓침. 특히 budget 부족 시 cascade.

**Fix (`pureWsBreakoutHandler.ts:1032`)**:
```ts
const activeCountBefore = activePositions.size;
await handlePureWsSignal(syntheticSignal, candleBuilder, ctx);
if (activePositions.size > activeCountBefore) {
  v2LastTriggerSecByPair.set(pair, nowSec);  // ← 성공 시에만
}
```

Test: `test/pureWsV2Scanner.test.ts` "QA F8 fix: viability rejection does NOT set per-pair cooldown" 추가.

### F9 — N/A

(생략 — F8 에 포괄)

### F10 — HIGH (FIXED): quickReject `weak_mfe` auto-counts as degrade factor

**Before (bug)**:
```ts
if (degradeFactors.length >= config.degradeCountForExit) {   // default 2
  action = 'exit';
}
```

`weak_mfe` + 1 microstructure factor → `degradeCountForExit=2` 만족 → **exit**. 그런데 초반 30초 내 MFE < 0.5% 는 healthy pair 에서도 흔함. Microstructure 가 briefly 흔들리면 즉시 exit → over-rejection.

**Fix (`src/risk/quickRejectClassifier.ts`)**:
```ts
const microFactors = degradeFactors.filter((f) => f !== 'weak_mfe');
if (microFactors.length >= config.degradeCountForExit) {
  action = 'exit';
} else if (!mfeOk && microFactors.length >= 1) {
  action = 'reduce';
}
```

- `weak_mfe` 는 **counted in `degradeFactors`** (observability 유지) 하지만 exit count 에는 미포함
- exit 는 **microstructure factors 만**: `buy_ratio_decay` + `tx_density_drop` 2 개 모두 triggered 시
- `reduce` 는 `weak_mfe + 1 microstructure` 시 (future partial exit candidate)

Tests 업데이트 — 3 새 케이스 추가: 2+ micro → exit, weak+1 micro → reduce, weak only → hold.

## Completion Criteria

- ✅ F8 (HIGH/MED): cooldown premature → fixed + test
- ✅ F10 (HIGH): weak_mfe auto-factor → fixed + test  
- ✅ F2/F4/F5/F6: LOW/MED documented
- ✅ F1/F3/F7: PASS verified

## Verification

- `npx tsc --noEmit` (main + scripts) — 0 errors
- `npx jest` — 802 pass + 2 QA-fix tests (test/pureWsV2Scanner.test.ts F8, test/quickRejectClassifier.test.ts F10 revisions) / 1 pre-existing riskManager fail 유지

## Recommended follow-ups (not blocking deploy)

- Paper-mode bleed budget bypass env (F2)
- walletDeltaComparator baseline 을 bleed budget 에서 우선 사용 (F4)
- Replay script `--config-env` CLI (F6)
- Reverse quote placeholder replacement 시 minPassScore 재튜닝 plan (F5)

## Notes

- 이번 QA 는 코드 기반 팩트체크 위주. 실거래 관측 (48h+) 후에야 drift / over-rejection rate 실측 가능.
- Block_QA pattern 유지: integration 검증 + config 일관성 + 문서 drift 체크.

---

## QA Closure Report (2026-04-18)

All Block 0-4 QA findings 대응 완료. 상세 기록은 `project_block_qa_closure_2026_04_18.md` 메모리.

### Summary

| Block | Finding | Priority | Status | 주요 수정 |
|---|---|---|---|---|
| 0 | active plan pre-pivot 설명 | P1 | ✅ | `docs/exec-plans/active/1sol-to-100sol.md` 재작성 (post-pivot, Block 0-4 완료 기록 + 운영 phase O1-O4) |
| 0 | README pre-pivot posture | P3 | ✅ | `README.md` 재작성 (convexity mission, post-pivot lane 상태) |
| 0 | design-docs index old gate chain | P4 | ✅ | `docs/design-docs/index.md` — post-pivot / pre-pivot 분리 + current gate chain 갱신 |
| 1 | comparator wallet-aware 아님 | P1 | ✅ | ledger entry 에 `wallet` 필드 추가 (cupsey/migration/pure_ws) + comparator 가 `cfg.walletName` 기준 필터. backward-compat: unlabeled → `main` |
| 1 | sandbox misconfig runtime-late | P3 | ✅ | `src/index.ts` startup assertion — `mode=sandbox && !sandboxExecutor` 즉시 throw. comparator baseline fail 시 Telegram critical 전송 |
| 2 | generic alias risk (`pump`, `damm`) | P3 | ✅ | `PUMP_SWAP_DEX_IDS` 에서 `pump` 제거, `METEORA_DEX_IDS` 에서 `damm` 제거. canonical set 을 4개 (`raydium/orca/pumpswap/meteora`) 로 정리 |
| 2 | canonical set 주석 drift | P4 | ✅ | `SUPPORTED_REALTIME_DEX_IDS` 에서 `pumpfun`, `pump-swap` 제거 (normalize 결과 canonical 만) + `SUPPORTED_REALTIME_POOL_PROGRAMS` dead key 제거 |
| 2 | `no_pairs` resolver 미확장 | P1 | 🟡 scope 확정: Block 2 완료 범위는 alias+telemetry. resolver 확장은 별도 Block 2.1 후보로 분리 (48h telemetry 수집 후 재검토) |
| 3 | paper-first 코드 미강제 | P1 | ✅ | `PUREWS_LIVE_CANARY_ENABLED` 플래그 추가 — live mode 여도 flag 없으면 live buy suppressed. paper 관측 → operator opt-in 후 canary. |
| 3 | `timeStopAt seconds*60` 단위 버그 | P1 | ✅ | `(nowSec + pureWsProbeWindowSec) * 1000` 로 수정 (3 occurrences). 테스트 추가 |
| 3 | authority 문서 drift | P3 | ✅ | `mission-pivot` 의 lane 테이블 `implemented (Block 3, paper-first)` 로 갱신. `pure-ws-breakout` 문서에 canary flag + global concurrency 설명 추가 |
| 3 | live entry / paper-first 테스트 누락 | P4 | ✅ | `test/pureWsPaperFirst.test.ts` — live suppression, canary enabled path, paper mode, timeStopAt 단위 4 tests |
| 4 | `동시 max 3 ticket` 전역 아님 | P1 | ✅ | `src/risk/canaryConcurrencyGuard.ts` 신규 — wallet-level global cap (opt-in `CANARY_GLOBAL_CONCURRENCY_ENABLED`, default 3). cupsey + pure_ws 모두 acquire/release 배선. 누수 방지 (live buy 실패, STALK_SKIP/CRASH 등) |
| 4 | canary-eval wallet-truth 아님 | P1 | ✅ | `scripts/canary-eval.ts` 에 wallet log growth / max drawdown / recovery count / equity curve 추가. CLI `--start-sol` 지원. `test/canaryEvalWalletTruth.test.ts` |
| 4 | `CANARY_MAX_TRADES 50 vs 100` drift | P3 | ✅ | default 를 **50** 으로 통일 (50 = eval trigger = entry pause trigger). 문서 반영 |
| 4 | auto-halt scope 설명 과함 | P4 | ✅ | 모듈 주석 + OPERATIONS.md 에 현재 배선 `cupsey + pure_ws_breakout` 만 임을 명시 (다른 lane 은 필요 시 별도 wire-in) |

### Verification

- `npx tsc --noEmit` — 0 errors (main + scripts)
- `npx jest` — 727 pass + 1 pre-existing riskManager fail (QA 와 무관, Block 0-4 전부터 존재)
- 신규 테스트 18 개 (paper-first 4, global concurrency 5, wallet-aware 4, wallet-truth 5)

### Notes

- 2026-04-18 QA 대응은 **코드 + 문서 양방향** 이다.
- 2 개 open item: Block 2 `no_pairs` resolver 확장은 empirical telemetry 수집 후 판정 (Block 2.1 후보). riskManager pre-existing test failure 는 별도 추적.

---



## Block 0 — Mission Pivot 문서화 QA

- Date: 2026-04-18
- Reviewer: Codex
- Scope:
  - `PLAN.md`
  - `PROJECT.md`
  - `MEASUREMENT.md`
  - `STRATEGY.md`
  - `docs/design-docs/mission-pivot-2026-04-18.md`
  - `docs/design-docs/index.md`
  - `docs/exec-plans/active/1sol-to-100sol.md`
  - `README.md`
  - `OPERATIONS.md`
  - `docs/historical/pre-pivot-2026-04-18/`

### Verdict

- **Block 0 방향은 맞다**
- **하지만 품질 기준으로는 미완료**
- 이유:
  - 새 mission authority 문서는 생성됐지만
  - active execution plan / 운영 문서 / 인덱스 문서가 아직 구체제를 현재 기준처럼 설명한다

## Findings

### 1. High — active authority chain mismatch

새 mission 기준 문서는 이미 convexity-first로 전환됐다.

- `PLAN.md`
- `PROJECT.md`
- `MEASUREMENT.md`
- `STRATEGY.md`
- `docs/design-docs/mission-pivot-2026-04-18.md`

하지만 아래 문서는 여전히 pre-pivot active authority처럼 읽힌다.

- `docs/exec-plans/active/1sol-to-100sol.md`

문제:

- `cupsey` 중심 active plan과 기존 KPI 문구가 남아 있음
- 기존 explainable / old execution truth가 계속 섞여 있음
- 이 파일이 계속 active execution plan이면, authority chain이 내부적으로 충돌함

판정:

- **Block 0의 최우선 미해결 이슈**

### 2. Medium — design-docs index drift

- `docs/design-docs/index.md`

문제:

- 여전히 `AttentionScore -> Execution Viability -> Strategy Score` 식 old gate chain을 전면에 둠
- 새 mission과 충돌

판정:

- pivot 이후의 설계 문서 entry point로 쓰기 어려움

### 3. Medium — operator docs still pre-pivot

- `README.md`
- `OPERATIONS.md`

문제:

- context / attention / old gate 체계를 runtime authority처럼 설명
- 기존 measurement 용어와 운영 해석을 유지

특히:

- `AGENTS.md` 상 `OPERATIONS.md`는 현재 운영 기준 문서
- 따라서 이 드리프트는 단순 문서 노후화가 아니라 운영 리스크

### 4. Low — historical migration itself is fine

- `docs/historical/pre-pivot-2026-04-18/`

판정:

- 기존 기준 문서를 historical로 내린 방향은 맞음
- 새 pivot 문서 자체의 내부 논리도 대체로 일관적
- 문제는 새 문서 품질보다 authority cleanup 미완료 쪽

## Block 0 completion criteria

아래가 충족돼야 Block 0를 완료로 볼 수 있다.

1. `docs/exec-plans/active/1sol-to-100sol.md`가 새 mission과 충돌하지 않아야 함
2. `OPERATIONS.md`가 현재 운영 authority로서 post-pivot 기준을 반영해야 함
3. `README.md`가 프로젝트의 현재 posture를 old explainable bot처럼 설명하지 않아야 함
4. `docs/design-docs/index.md`가 post-pivot authority를 가리켜야 함

## Recommended next actions

### Priority 1

- `docs/exec-plans/active/1sol-to-100sol.md`
  - 새 mission 기준으로 재작성하거나
  - active authority에서 내리고 새 active execution plan으로 대체

### Priority 2

- `OPERATIONS.md`
  - wallet truth / comparator / new lane transition 기준으로 정리
  - old explainability-first KPI 제거

### Priority 3

- `README.md`
  - 현재 프로젝트 설명을 post-pivot 기준으로 정리

### Priority 4

- `docs/design-docs/index.md`
  - old gate chain 제거
  - `mission-pivot-2026-04-18.md`와 current design authority를 우선 노출

## Notes

- 이번 QA는 문서 품질 점검만 수행했다.
- 코드 테스트는 실행하지 않았다.
- Block 0의 핵심 문제는 새 mission 선언 자체가 아니라, **기존 authority surface와의 불일치**다.

---

## Block 1 — Wallet Ownership + Always-on Comparator QA

- Date: 2026-04-18
- Reviewer: Codex
- Scope:
  - `src/utils/config.ts`
  - `src/index.ts`
  - `src/orchestration/cupseyLaneHandler.ts`
  - `src/orchestration/migrationLaneHandler.ts`
  - `src/risk/walletDeltaComparator.ts`
  - `src/orchestration/entryIntegrity.ts`
  - `test/laneWalletResolution.test.ts`
  - `test/walletDeltaComparator.test.ts`

### Verdict

- **Block 1 방향은 맞다**
- **기본 뼈대와 테스트는 통과**
- **하지만 품질 기준으로는 아직 미완료**

이유:

- wallet ownership 이 여전히 env/default `auto`에 의존한다
- comparator 가 `single wallet` 기준인데 ledger 는 공유 파일 전체를 합산한다
- wallet 분리 운영 시 comparator 해석이 구조적으로 틀어질 수 있다

## Findings

### 1. High — comparator 가 single-wallet / shared-ledger mismatch 구조

현재 comparator 시작 시:

- `walletName: config.walletStopWalletName`

하나만 넘긴다.

하지만 comparator expected delta 는:

- `executed-buys.jsonl`
- `executed-sells.jsonl`

전체를 그대로 합산한다.

문제:

- wallet 는 하나만 본다
- ledger 는 lane / wallet 구분 없이 공유 합산한다
- drift 가 크면 모든 lane 을 halt 한다

즉 `main` / `sandbox` 분리 운영이면 comparator 판단이 구조적으로 흔들릴 수 있다.

판정:

- **Block 1의 최우선 미해결 이슈**

### 2. Medium — wallet ownership closure 가 기본값으로 강제되지 않음

새 설정은 추가됐다.

- `CUPSEY_WALLET_MODE`
- `MIGRATION_WALLET_MODE`

하지만 기본값은 둘 다 `auto`다.

문제:

- 운영 env 에서 명시하지 않으면 기존 `sandboxExecutor ?? executor` 동작 유지
- 즉 ownership closure 가 코드 차원에서 강제되지 않고 운영자 설정에 의존

판정:

- **Block 1 목표의 절반만 달성**

### 3. Medium — sandbox misconfig 가 startup fail-fast 가 아니라 runtime-late failure

현재는 시작 시점에:

- resolved wallet label 로그만 남김

실제 오류는 첫 lane 실행 시:

- `CUPSEY_WALLET_MODE=sandbox but sandboxExecutor not initialized`

형태로 늦게 터진다.

또 comparator baseline capture 실패도:

- warning 후 비활성화

로 끝난다.

문제:

- 보호장치가 들어왔다고 믿기 쉽지만
- misconfig 상태에서 조용히 약해질 수 있음

판정:

- startup validation 강화 필요

## Block 1 completion criteria

아래가 충족돼야 Block 1을 완료로 볼 수 있다.

1. `cupsey` / `migration` wallet mode 가 운영 env 에서 명시적으로 고정되어야 함
2. comparator 가 wallet 단위로 계산되거나, 단일-wallet 운영만 허용하도록 명확히 제한되어야 함
3. `sandbox` 모드인데 sandbox executor 가 없으면 startup 단계에서 명시적으로 실패해야 함
4. comparator 비활성화 / baseline capture 실패가 운영자가 즉시 인지 가능한 수준으로 드러나야 함

## Recommended next actions

### Priority 1

- comparator 를 wallet-aware 로 재설계
  - wallet별 ledger 분리
  - 또는 wallet별 comparator 다중 인스턴스
  - 또는 단일 wallet 운영만 허용

### Priority 2

- `CUPSEY_WALLET_MODE`, `MIGRATION_WALLET_MODE`를 운영 env 에 명시
- `auto`는 backward-compat 용으로만 두고 운영 기본값으로는 쓰지 않기

### Priority 3

- startup validation 추가
  - `mode=sandbox && !sandboxExecutor` 면 즉시 fail
  - comparator baseline capture 실패 시 강한 경고 또는 운영 차단 기준 정의

## Verification

실행한 검증:

- `npx tsc --noEmit`
- `npx jest test/walletDeltaComparator.test.ts test/laneWalletResolution.test.ts --runInBand`

결과:

- 타입체크 통과
- 테스트 12개 전부 통과

## Notes

- 이번 QA는 Block 1 코드 품질 점검이다.
- 핵심 문제는 기능 부재가 아니라, **ownership/comparator closure 가 아직 운영적으로 완결되지 않았다는 점**이다.

---

## Block 2 — Coverage / Eligibility Expansion QA

- Date: 2026-04-18
- Reviewer: Codex
- Scope:
  - `src/realtime/meteoraPrograms.ts`
  - `src/realtime/pumpSwapParser.ts`
  - `src/realtime/realtimeEligibility.ts`
  - `src/realtime/admissionSkipLogger.ts`
  - `src/index.ts`
  - `test/realtimeDexAlias.test.ts`
  - `test/realtimeEligibility.test.ts`
  - `test/admissionSkipLogger.test.ts`

### Verdict

- **방향은 맞다**
- **alias normalization + telemetry는 잘 들어갔다**
- **하지만 Block 2 전체 기준으로는 아직 미완료**

이유:

- `unsupported_dex` 대응은 진전이 있음
- 반면 원래 목표였던 `no_pairs` resolver 확장은 아직 보이지 않음
- generic alias + owner resolve fail-open 조합은 운영 리스크가 남음

## Findings

### 1. Medium — `unsupported_dex` 완화는 됐지만 `no_pairs` 대응은 아직 아님

이번 변경으로 들어간 것:

- Meteora alias 확장
- PumpSwap alias 확장
- Raydium / Orca alias normalization
- admission skip DEX telemetry logger

하지만 여전히 `tokenPairResolver.getTokenPairs()` 결과가 비면:

- `resolver_miss`
- `empty_pairs`

로 기록만 하고 끝난다.

즉:

- Block 2의 일부 목표는 달성
- 하지만 `no_pairs 대응 (resolver 확장)`까지 완료된 것은 아님

판정:

- **Block 2 부분 완료**

### 2. Medium — generic alias + owner resolve fail-open 리스크

새 alias 집합에는 다음처럼 일반성이 큰 태그가 포함된다.

- `pump`
- `damm`

문제:

- alias 자체는 coverage 확대에 유리
- 하지만 pre-watchlist owner resolve 가 실패하면 debug log 후 통과
- 이 경우 unsupported / wrong-program pair 가 watchlist로 들어갈 여지가 생김

즉:

- coverage 는 늘지만
- eligibility-first 안전성은 일부 약해짐

판정:

- 운영 리스크로 관리 필요

### 3. Low — canonical 주석과 실제 set 값이 어긋남

`SUPPORTED_REALTIME_DEX_IDS` 주석은 post-normalize canonical set처럼 쓰여 있지만,
실제 값에는 `pumpfun`, `pump-swap` 같은 비-canonical 값이 남아 있다.

기능상 치명적이지는 않지만:

- 설계 의도
- 후속 유지보수

측면에서 혼란을 줄 수 있다.

## Block 2 completion criteria

아래가 충족돼야 Block 2를 완료로 볼 수 있다.

1. `unsupported_dex` alias 확장이 실제 운영 coverage 개선으로 이어져야 함
2. `no_pairs` 대응이 단순 logging 이 아니라 resolver/pair eligibility 확장까지 포함해야 함
3. owner resolve 실패 시 fail-open 정책을 의도적으로 유지할지, 제한할지 결정돼야 함
4. generic alias 허용 범위가 운영적으로 검증돼야 함

## Recommended next actions

### Priority 1

- Block 2 범위를 명확히 고정
  - `unsupported_dex + telemetry`까지만이면 완료 처리 가능
  - `no_pairs resolver 확장`까지면 아직 추가 구현 필요

### Priority 2

- `no_pairs` 대응 구현
  - resolver fallback 확장
  - pair eligibility 보강

### Priority 3

- generic alias 재검토
  - `pump`
  - `damm`
  같은 태그를 유지할지 결정

### Priority 4

- owner resolve fail-open 정책 재검토
  - 지금 유지
  - 또는 stricter fallback 정책 도입

## Verification

실행한 검증:

- `npx tsc --noEmit`
- `npx jest test/realtimeDexAlias.test.ts test/realtimeEligibility.test.ts test/admissionSkipLogger.test.ts --runInBand`

결과:

- 타입체크 통과
- 테스트 64개 전부 통과

## Notes

- 이번 QA는 Block 2 coverage/eligibility 코드 품질 점검이다.
- 핵심 문제는 구현 품질보다, **coverage 확대와 eligibility 안전성 사이의 tradeoff를 아직 완전히 닫지 못한 점**이다.

---

## Block 3 — Pure WS Breakout Lane QA

- Date: 2026-04-18
- Reviewer: Codex
- Scope:
  - `src/orchestration/pureWsBreakoutHandler.ts`
  - `src/index.ts`
  - `src/utils/tradingParams.ts`
  - `docs/design-docs/pure-ws-breakout-lane-2026-04-18.md`
  - `docs/design-docs/mission-pivot-2026-04-18.md`
  - `docs/design-docs/index.md`
  - `test/pureWsBreakoutHandler.test.ts`
  - `test/entryIntegrity.test.ts`

### Verdict

- **구현 방향은 맞다**
- **타입체크와 핵심 테스트도 통과**
- **하지만 품질 기준으로는 아직 미완료**

이유:

- `paper-first` 계약이 코드에서 강제되지 않는다
- `timeStopAt` 메타데이터가 초/분 단위가 어긋난다
- authority 문서 표면이 즉시 드리프트했다
- signal → live entry 경로에 대한 회귀 방어가 부족하다

## Findings

### 1. High — `paper-first`가 코드에서 실제로 강제되지 않음

설계 문서는 분명히 다음 순서를 요구한다.

- Phase 3.1: `TRADING_MODE=paper`
- Paper trade 관측 후에만 live canary

하지만 실제 구현은:

- `PUREWS_LANE_ENABLED=true`
- `TRADING_MODE=live`

이면 바로 live buy 를 실행한다.

즉:

- 설계 문서상으로는 paper-first
- 코드상으로는 live-ready

상태다.

판정:

- **Block 3의 최우선 미해결 이슈**

### 2. High — `timeStopAt`가 `seconds * 60`으로 기록되는 단위 버그

`pureWsProbeWindowSec`는 이름과 문서상 모두 초 단위다.

하지만 DB/알림용 `timeStopAt`는 다음 형태로 계산된다.

- `(nowSec + pureWsProbeWindowSec * 60) * 1000`

즉 `30초`가 아니라 `30분`이 기록된다.

중요한 점:

- runtime state machine 자체는 `elapsedSec >= pureWsProbeWindowSec`로 비교해서
  실제 close 동작은 정상일 가능성이 높다
- 하지만 persisted metadata, notifier, audit 해석은 틀어진다

판정:

- **운영 분석을 오염시키는 메타데이터 버그**

### 3. Medium — authority 문서가 Block 3 직후 바로 어긋남

현재 문서 표면은 서로 다르게 말한다.

- `mission-pivot-2026-04-18.md`
  - `pure_ws_breakout` = `not designed yet`
  - `paper only`
- `pure-ws-breakout-lane-2026-04-18.md`
  - 구현 완료 + paper-first rollout
- `docs/design-docs/index.md`
  - `✅ 구현 완료 (paper-first)`
  - 동시에 old gate chain (`AttentionScore -> Execution Viability -> Strategy Score`) 유지

즉:

- 새 lane 구현 자체보다
- **authority surface 정리**가 먼저 필요하다

판정:

- post-pivot 문서 정합성 이슈

### 4. Medium — 테스트가 live signal → entry 경로와 `paper-first` 계약을 보장하지 않음

현재 테스트는 주로 다음을 본다.

- PROBE hardcut
- timeout
- tier transition
- wallet label resolution
- entry integrity halt 공용 동작

하지만 직접 보장하지 않는 것:

- `handlePureWsSignal()` live buy path
- pure WS open persist integration
- `TRADING_MODE=live`에서 paper-first 위반이 차단되는지

즉:

- 현재 테스트는 runner state machine 회귀 방어는 있음
- 하지만 **Block 3 rollout contract 회귀 방어는 없음**

## Block 3 completion criteria

아래가 충족돼야 Block 3을 완료로 볼 수 있다.

1. `paper-first`가 코드 레벨에서 강제되어야 함
   - 예: explicit live canary flag 없이는 pure WS live buy 금지
2. `timeStopAt` 기록이 `seconds` 기준으로 바로잡혀야 함
3. `mission-pivot`, `pure-ws-breakout-lane`, `design-docs/index` authority 문구가 일치해야 함
4. `signal -> live entry -> persist` 경로와 rollout contract에 대한 테스트가 추가돼야 함

## Recommended next actions

### Priority 1

- pure WS lane에 explicit rollout guard 추가
  - `paper-only`
  - 또는 `PUREWS_LIVE_CANARY_ENABLED`
  같은 별도 flag 필요

### Priority 2

- `timeStopAt` 계산 수정
  - `pureWsProbeWindowSec * 60` 제거

### Priority 3

- authority 문서 정리
  - `mission-pivot-2026-04-18.md`
  - `docs/design-docs/index.md`
  - `pure-ws-breakout-lane-2026-04-18.md`

### Priority 4

- 테스트 보강
  - live mode signal → buy path
  - open persist integrity
  - paper-first / live-canary guard

## Verification

실행한 검증:

- `npx tsc --noEmit`
- `npx jest test/pureWsBreakoutHandler.test.ts test/entryIntegrity.test.ts --runInBand`

결과:

- 타입체크 통과
- 테스트 24개 전부 통과

## Notes

- 이번 QA는 Block 3 pure WS lane 코드/문서 품질 점검이다.
- 핵심 문제는 새 lane 아이디어가 아니라, **rollout contract와 운영 메타데이터가 아직 완전히 닫히지 않은 점**이다.

---

## Block 4 — Live Canary Guardrails QA

- Date: 2026-04-18
- Reviewer: Codex
- Scope:
  - `src/risk/canaryAutoHalt.ts`
  - `scripts/canary-eval.ts`
  - `src/orchestration/pureWsBreakoutHandler.ts`
  - `src/orchestration/cupseyLaneHandler.ts`
  - `src/utils/config.ts`
  - `src/utils/tradingParams.ts`
  - `docs/design-docs/mission-pivot-2026-04-18.md`
  - `docs/design-docs/pure-ws-breakout-lane-2026-04-18.md`
  - `test/canaryAutoHalt.test.ts`
  - `test/canaryEval.test.ts`

### Verdict

- **방향은 맞다**
- **lane별 auto-halt와 평가 스크립트의 뼈대는 들어갔다**
- **하지만 품질 기준으로는 아직 미완료**

이유:

- `동시 max 3 ticket` guardrail이 전역으로 강제되지 않는다
- canary 평가가 `wallet truth`가 아니라 ledger-derived proxy 에 머문다
- canary 종료 기준이 문서의 `50 trades 평가`와 코드 기본값 `100 trades halt`로 갈라진다
- auto-halt 배선 범위가 문서/모듈 설명보다 좁다

## Findings

### 1. High — `동시 max 3 ticket` guardrail이 전역이 아니라 lane별로 분리돼 있다

문서 기준 Block 4는:

- `0.01 SOL fixed`
- `동시 max 3 ticket`

을 hard guardrail 로 둔다.

하지만 실제 구현은:

- `pure_ws_breakout`: `pureWsMaxConcurrent = 3`
- `cupsey`: `cupseyMaxConcurrent = 5`

를 **각 lane별로 따로** 적용한다.

즉 A/B 병렬 운영 시:

- pure WS 3개
- cupsey 5개

까지 동시에 열릴 수 있다.

판정:

- **Block 4의 최우선 미해결 이슈**
- 현재 guardrail은 “전역 max 3”이 아니라 “lane별 cap”이다

### 2. High — `canary-eval`이 Block 4의 핵심 KPI인 `wallet truth`를 평가하지 않는다

문서 기준 Block 4 평가는:

- wallet log growth
- winner distribution
- drawdown survivability
- ruin probability

중심이다.

하지만 `scripts/canary-eval.ts`는:

- `executed-buys.jsonl`
- `executed-sells.jsonl`

만 읽고,

- `solReceived - (entryPrice × quantity)`

기반의 `totalNetSol` 과 winner count 를 계산한다.

즉:

- wallet delta 직접 측정 없음
- wallet log growth 계산 없음
- max drawdown / ruin probability 계산 없음
- comparator / wallet-reconcile 과도 연결되지 않음

판정:

- **Block 4 평가 도구는 아직 wallet-truth 기준이 아님**

### 3. Medium — canary 종료 기준이 문서와 코드 기본값에서 어긋난다

문서 기준:

- `50 trades` 도달 시 평가

하지만 코드 기본값은:

- `CANARY_MAX_TRADES = 100`

이다.

또 예산 halt 기본값은:

- `CANARY_MAX_BUDGET_SOL = 0.5`

인데, 현재 mission 문서 표면에는 왜 이 수치가 적절한지 설명이 없다.

즉:

- 운영자는 `50 trades review`
- 코드는 `100 trades pause`

를 기본으로 들고 있다.

판정:

- guardrail threshold authority mismatch

### 4. Medium — auto-halt는 generic lane module처럼 보이지만 실제 배선은 `cupsey`와 `pure_ws_breakout`만 되어 있다

모듈 주석과 state 는:

- `cupsey`
- `migration`
- `main`
- `strategy_d`
- `pure_ws_breakout`

를 전부 지원하는 것처럼 적혀 있다.

하지만 실제 `reportCanaryClose()` 호출은 현재:

- `cupsey`
- `pure_ws_breakout`

두 lane 에만 연결돼 있다.

즉:

- 모듈 설명은 generic
- 실제 운영 배선은 A/B canary 일부 lane

상태다.

판정:

- 즉시 치명적이진 않지만, module authority 와 wiring scope 가 어긋남

## Block 4 completion criteria

아래가 충족돼야 Block 4를 완료로 볼 수 있다.

1. `동시 max 3 ticket` guardrail 이 전역 wallet 기준인지, lane별 cap 인지 명확히 결정되고 코드에 일치하게 강제되어야 함
2. canary 승격/중단 평가는 `wallet truth` 기준으로 최소 1개 경로가 있어야 함
   - comparator / wallet-reconcile / wallet snapshot 중 하나와 연결
3. `50 trades evaluation` 과 `auto-halt trade budget` 의 관계가 문서와 코드에서 일치해야 함
4. auto-halt 의 지원 lane 과 실제 배선 범위가 일치해야 함

## Recommended next actions

### Priority 1

- 전역 canary concurrency guard 추가 또는 문서 수정
  - 진짜 의도가 전역 max 3 이면 wallet-level concurrent ticket guard 필요
  - lane별 cap 이 의도면 문서가 그렇게 바뀌어야 함

### Priority 2

- `canary-eval` 를 wallet-truth 경로와 연결
  - 최소 `wallet log growth`
  - lane attribution 된 wallet delta
  - drawdown / loss streak

### Priority 3

- `CANARY_MAX_TRADES`
  - `50 review / 100 hard stop` 이면 문서에 둘 다 명시
  - 아니면 기본값을 50으로 맞춤

### Priority 4

- auto-halt scope 정리
  - 진짜 generic lane guard 로 확대
  - 또는 `cupsey/pure_ws A/B 전용` 으로 문서/코드 주석 축소

## Verification

실행한 검증:

- `npx tsc --noEmit`
- `npx jest test/canaryAutoHalt.test.ts test/canaryEval.test.ts --runInBand`

결과:

- 타입체크 통과
- 테스트 18개 전부 통과

## Notes

- 이번 QA는 Block 4 live canary guardrails 구현 품질 점검이다.
- 핵심 문제는 기능 부재보다, **guardrail 의미(전역 vs lane별)와 평가 기준(wallet truth vs ledger proxy)이 아직 완전히 닫히지 않은 점**이다.
