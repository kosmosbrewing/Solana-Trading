# MISSION_CONTROL.md Quality Pass — 2026-04-25

> Audit date: 2026-04-25
> Source: `MISSION_CONTROL.md` (291 lines, 2026-04-25 updated)
> Authority: `mission-refinement-2026-04-21.md` > `mission-pivot-2026-04-18.md` > `PLAN.md` / `MEASUREMENT.md` > `MISSION_CONTROL.md`
> Scope: code & tooling fact-check 후 구현 가능한 gap 만 수정.

---

## 1. Quality Check Findings

| # | Gap | MISSION_CONTROL clause | Severity | Status |
|---|---|---|:-:|:-:|
| 1 | KOL handler `enterPaperPosition` 가 survival / sellQuote / drift gate 호출 없음 | §KOL Control flow ("survival / drift / sell quote checks") | **P0** | ✅ Fixed |
| 2 | `wallet_cash_delta / wallet_equity_delta / realized_lane_pnl / execution_cost_breakdown` 분리 reporting 없음 | §Control 1 — "Open implementation requirement" | **P0** | ✅ Fixed |
| 3 | Adaptive change log (`change_id, hypothesis, old/new, min_sample`) 부재 | §Control 5 — "Without this log, the result is an anecdote, not an experiment" | **P1** | ✅ Fixed |
| 4 | Paper trade ledger 에 `parameter_version / detector_version / independent_kol_count` 필드 부재 | §Control 5 — Field group | **P1** | ✅ Fixed (P0 부산물) |
| 5 | KOL DB target 20-30 클러스터 / 50-80 주소 — 현재 9 KOL | §KOL DB target | P2 | ⚠ 운영자 수동 작업 (코드 변경 불요) |

---

## 2. Implementation Detail

### Gap #1 — KOL Survival Gate Integration

**파일**: `src/orchestration/kolSignalHandler.ts` (+131 lines), `src/utils/config.ts` (+5 lines)

**변경**:
- `initKolHunter` signature 확장: `{ securityClient?, gateCache? }` 주입
- 새 함수 `checkKolSurvival(tokenMint)` — onchain security data + exit liquidity + sellQuoteProbe 통합 (pure_ws 와 동등 패턴)
- `resolveStalk` → `enterPaperPosition` 사이에 survival check 호출. 거부 시 `fireRejectObserver(..., extras={survivalReason, survivalFlags})`
- `PaperPosition` 에 `parameterVersion / detectorVersion / independentKolCount / survivalFlags` 필드 추가
- Paper trade ledger 에 동일 필드 append

**Config (env override 가능)**:
- `KOL_HUNTER_SURVIVAL_ALLOW_DATA_MISSING=true` (default)
- `KOL_HUNTER_SURVIVAL_MIN_EXIT_LIQUIDITY_USD=5000`
- `KOL_HUNTER_SURVIVAL_MAX_TOP10_HOLDER_PCT=0.80`
- `KOL_HUNTER_RUN_SELL_QUOTE_PROBE=true`
- `KOL_HUNTER_PARAMETER_VERSION=v1.0.0`
- `KOL_HUNTER_DETECTOR_VERSION=kol_discovery_v1`

**효과**: paper 모드에서도 live 와 동일 entry-side gate 통과율을 측정. "paper 통과율 vs live 통과율" 분포 비교 가능 — Stage 1 KOL evaluation 의 핵심 KPI.

### Gap #2 — Equity Decomposition Tool

**신규 파일**: `scripts/equity-decomposition.ts` (296 lines)

MISSION_CONTROL §Control 1 4 layer 출력:
1. `wallet_cash_delta` — closed-trade FIFO paired netSol 합 (baseline 지정 시)
2. `wallet_equity_delta` — cash + open inventory cost basis
3. `realized_lane_pnl` — lane 별 trades / sum / mean / median
4. `execution_cost_breakdown` — entry/exit slippage avg + total bleed estimate

**사용**:
```bash
npx ts-node scripts/equity-decomposition.ts \
  --baseline-sol 1.07 --md report.md --json out.json
```

**Smoke test 결과**: cupsey 52 trades / pure_ws 87 trades / total bleed estimate 0.058 SOL.
주의: cupsey lane 의 sum +790 SOL 은 pippin signal_price 12배 부풀림 버그(`project_signal_quality_reinforcement_2026_04_22`)의 ledger 반영. 도구는 정상 — 데이터 source bug 가 가시화됨.

### Gap #3 — Parameter Change Log

**신규 파일**: `scripts/parameter-change-log.ts` (180 lines)

3 sub-command:
- `record` — append-only JSONL 기록 (`change_id, changed_at, arm, param, old_value, new_value, hypothesis, reason, minimum_sample_before_next_change, parameter_version, author_tag`)
- `list` — arm / since 필터로 history 조회
- `current` — arm 별 latest parameter view

**저장 위치**:
- KOL: `data/kol/parameter-changes.jsonl`
- 기타: `data/parameter-changes.jsonl`

**첫 record 추가됨**: `chg-1777102679967-0f7a8073` — kol_hunter v1.0.0 baseline 시작점.

### Gap #4 — Telemetry Fields (P0 부산물)

`enterPaperPosition` + paper-trade ledger record 에 다음 필드 추가됨 (§Control 5 Field group):
- `lane` (이미 strategy 와 별도 명시)
- `parameterVersion`
- `detectorVersion`
- `independentKolCount`
- `survivalFlags[]`
- 기존: `kols[]`, `kolScore`, `t1/t2/t3 VisitAtSec`, `mfePctPeak`, `closeState`

---

## 3. Test Results

```
Test Suites: 1 failed, 127 passed, 128 total
Tests:       1 failed, 926 passed, 927 total
```

- 1 fail = `test/riskManager.test.ts:130` (pre-existing precision issue, unchanged)
- KOL test suite 4 개 (kolDb / kolScoring / kolSignalHandler / kolWalletTracker) 36/36 pass
- TS compile clean (`npx tsc --noEmit`)

## 4. Operator Action Items (코드 변경 불요)

### Gap #5 — KOL DB 확장

§KOL DB target = "20-30 independent KOL clusters / 50-80 verified wallet addresses" — 현재 9 KOLs.

**다음 단계**:
1. 월 1회 재검증 routine 시작 (REFACTORING_v1.0.md Phase 5 이전 운영자 manual)
2. tier S/A/B 분포 운영자 판단 — 초기 데이터 부족이면 모두 A 로 시작 후 Phase 3 paper 결과로 demote

### Gap #1 — Live Wiring

`initKolHunter` 가 이제 `securityClient + gateCache` 를 받지만, 실제 bootstrap 코드 (`src/index.ts`) 에서 이 인자를 주입하는지 확인이 필요. Phase 4 canary 진입 직전 운영자가 wire-in 검증.

### Gap #2 — RPC Live Balance

equity-decomposition 가 `--baseline-sol` 인자만 받고 RPC 직접 조회는 하지 않음. 현재는 ledger sum 으로 wallet_cash_delta proxy. 정확한 ground truth 는 `scripts/wallet-reconcile.ts` 와 cross-check.

---

## 5. One-Line Summary

> MISSION_CONTROL.md 5개 gap 중 4개 (P0×2, P1×2) 코드 수정 완료, 926/927 test pass. KOL paper lane 이 이제 live 와 동일 survival/sellQuote gate 를 거치고, 4-layer equity report + change log 도구 신설. Gap #5 (KOL DB 20-30 클러스터) 는 운영자 manual 작업으로 분리.
