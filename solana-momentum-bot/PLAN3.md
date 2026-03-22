# PLAN3: Ralph Loop — PumpSwap Parser + Realtime Coverage 확장

> Created: 2026-03-22
> Mode: `ralph-loop`
> Goal: PumpSwap(Pump.fun AMM) swap 파싱을 추가해 realtime shadow의 풀 커버리지와 signal density를 높인다.
> Mission fit: 설명 가능한 realtime trigger 표본을 더 빠르게 쌓기 위해, 현재 누락된 주요 밈코인 AMM를 parser/runtime에 편입한다.
> Status: parser/eligibility/fallback 구현 완료, runtime smoke 검증 완료

---

## Loop Inputs

- `goal`: PumpSwap parser 지원 + realtime eligibility 확장 + live shadow에서 parse coverage 개선
- `max_iterations`: 6
- `validation_commands`:
  - `npm run build`
  - `npx jest --runInBand test/swapParser.test.ts test/realtimeEligibility.test.ts test/realtimeAdmissionTracker.test.ts`
  - parser smoke:
    - VPS realtime shadow session log / dataset에서 PumpSwap coverage 확인
  - runtime observation:
    - `rg -n "Helius real-time pipeline connected|subscriptions active|parseRate|blocked|pumpswap|PumpSwap" logs tmp data/realtime-sessions`
    - `npx ts-node scripts/realtime-shadow-runner.ts --dataset-dir <session-dir> --json` when session data exists
- `stop_condition`:
  - PumpSwap program/dexId가 realtime 경로에서 허용됨
  - PumpSwap tx/log를 `swapParser`가 재현 가능하게 파싱함
  - realtime shadow에서 PumpSwap 관련 pool이 admission blocked만 반복하지 않음

---

## 한 줄 요약

현재 realtime shadow의 가장 큰 병목 중 하나는 `PumpSwap` 미지원이다. GeckoTerminal/DexScreener 기준 밈코인 풀 다수가 PumpSwap인데, 이 경로가 빠져 있으면 Helius 실시간 수집을 켜도 `parseRate`가 낮고 `signals`가 거의 안 쌓인다.

즉 이 문서의 목적은 `새 전략 추가`가 아니라, **기존 realtime 전략이 실제로 관측할 수 있는 풀 수를 늘리는 것**이다.

---

## Current State

### 확인된 사실

| 항목 | 현재 상태 | 의미 |
|---|---|---|
| `swapParser` PumpSwap 지원 | 없음 | Raydium/Orca 외 AMM는 로그 파싱 미지원 |
| `realtimeEligibility` PumpSwap 허용 | 없음 | dexId/programId 레벨에서 실시간 대상에서 빠질 가능성 높음 |
| `PLAN3.md` 기존 초안 | 있음 | 아이디어와 예상 구현은 있으나 loop/validation 구조가 부족 |
| `PumpSwap` 관련 코드 검색 | 결과 없음 | 현재 저장소에 관련 상수/파서/테스트가 아직 없다 |

### 현재 남은 리스크

- PumpSwap 이벤트 구조를 문서/추정만 보고 구현하면 실제 로그와 어긋날 수 있다.
- DexScreener의 실제 `dexId` 문자열이 `pumpswap`, `pumpfun`, `pump-swap` 등 다를 수 있다.
- PumpSwap이 `Program data:` 이벤트를 항상 남기지 않으면 로그 파싱만으로는 부족할 수 있다.
- fallback 파싱이 이미 일부 동작할 가능성은 있지만, coverage가 얼마나 나오는지는 샘플 검증이 필요하다.

---

## Working Assumptions

이 문서는 아래 가정을 전제로 한다.

1. PumpSwap program id는 `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`다.
2. 우선순위는 `실제 tx/log 샘플 확인 -> 최소 parser 구현 -> runtime 통합`이다.
3. 첫 버전은 `완전한 IDL 지원`보다 `buy/sell event + fallback compatibility`를 목표로 한다.
4. parser 정확성이 coverage보다 우선이다. 잘못된 side/amount 파싱은 표본 수 증가보다 더 위험하다.

---

## Loop Protocol

### Iteration 1: Ground Truth Sampling

- `what_changed`: 코드 수정 없이 실제 PumpSwap tx/log 샘플 수집
- `validation_result`:
  - `meta.logMessages`에 `Program data:`가 있는지 확인
  - discriminator, amount offset, 실제 side 방향을 샘플로 대조
  - DexScreener/Gecko 쪽 dexId 문자열 확인
- `next_step`:
  - 로그 구조가 확인되면 Iteration 2
  - 로그 구조가 약하면 fallback-first 전략으로 Iteration 2

### Iteration 2: Minimal PumpSwap Parser

- `what_changed`:
  - `src/realtime/pumpSwapParser.ts` 추가
  - 로그 기반 `tryParsePumpSwapFromLogs()` 구현
- `validation_result`:
  - unit test로 buy/sell/discriminator mismatch 검증
  - 샘플 tx 기준 amount/side가 기대값과 크게 어긋나지 않는지 확인
- `guardrail`:
  - side 판별이 불확실하면 `null` 반환하고 fallback에 넘긴다

### Iteration 3: swapParser Integration

- `what_changed`:
  - `swapParser.ts`에 PumpSwap parser 연결
  - `SUPPORTED_PROGRAMS`, `FALLBACK_PROGRAM_HINTS` 확장
- `validation_result`:
  - 기존 parser test 회귀 없음
  - PumpSwap 샘플이 log parser 또는 transaction fallback 중 하나로 파싱됨
- `stop_if`:
  - parser coverage는 올랐지만 false parse 의심이 있으면 여기서 멈추고 재검증

### Iteration 4: Realtime Eligibility Expansion

- `what_changed`:
  - `realtimeEligibility.ts`에 PumpSwap dex/program 허용
  - dexId alias 매핑 정리
- `validation_result`:
  - eligibility test 통과
  - 실제 pool metadata 기준으로 PumpSwap 풀이 `unsupported dex/program` 때문에 탈락하지 않음

### Iteration 5: Runtime Shadow Verification

- `what_changed`:
  - 필요 시 admission/telemetry 보강
- `validation_result`:
  - realtime shadow session 또는 기존 session 분석에서 PumpSwap 관련 pool parse rate 개선 확인
  - `realtime-signals` 또는 `raw-swaps`에 PumpSwap pool 데이터가 실제로 남는지 확인
- `guardrail`:
  - signal 수만 늘고 설명 불가능한 rejection만 늘면 parser 품질을 재검토

### Iteration 6: Exit Decision

- `stop_condition_met`:
  - PumpSwap support를 기본 realtime coverage에 편입
- `stop_condition_not_met`:
  - 남은 이슈를 `event format uncertainty`, `dexId ambiguity`, `fallback insufficiency`로 분리해 후속 tech-debt로 남기고 종료

---

## Work Packages

### W1. Sample Acquisition

**목표**
- 실제 PumpSwap tx/log와 dexId ground truth 확보

**예상 변경**
- 코드 변경 없음 또는 샘플 fixture만 추가

**완료 기준**
- 최소 1개 buy, 1개 sell 샘플 확보
- `Program data:` 유무와 실제 이벤트 구조 정리

### W2. PumpSwap Log Parser

**목표**
- PumpSwap log에서 buy/sell와 수량을 직접 디코딩

**대상 파일**
- [pumpSwapParser.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/realtime/pumpSwapParser.ts)
- [swapParser.test.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/test/swapParser.test.ts) 또는 신규 test

**완료 기준**
- known sample에 대해 side/base/quote/price가 재현 가능
- 잘못된 discriminator는 `null`

### W3. swapParser Integration

**목표**
- PumpSwap를 기존 realtime parser 파이프라인에 연결

**대상 파일**
- [swapParser.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/realtime/swapParser.ts)
- [index.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/realtime/index.ts)

**완료 기준**
- PumpSwap program id가 지원 목록에 포함
- fallback path와 충돌 없이 기존 parser 회귀 없음

### W4. Eligibility + Runtime Admission

**목표**
- PumpSwap 풀을 realtime watchlist 대상에 포함

**대상 파일**
- [realtimeEligibility.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/src/realtime/realtimeEligibility.ts)
- [realtimeEligibility.test.ts](/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot/test/realtimeEligibility.test.ts)

**완료 기준**
- alias dexId 허용
- unsupported program/dex 이유로 바로 차단되지 않음

### W5. End-to-End Realtime Check

**목표**
- parser 추가가 실제 shadow coverage 개선으로 이어지는지 확인

**완료 기준**
- PumpSwap 풀에서 `raw-swaps` 또는 `realtime-signals` 생성 확인
- admission blocked 원인이 parser 미지원이 아닌 다른 원인으로 이동했는지 확인

---

## Validation Checklist

### Build / Test

```bash
npm run build
npx jest --runInBand \
  test/swapParser.test.ts \
  test/realtimeEligibility.test.ts \
  test/realtimeAdmissionTracker.test.ts
```

### Parser / Runtime Smoke

```bash
# 기존 또는 신규 realtime session 분석
npx ts-node scripts/realtime-shadow-runner.ts \
  --dataset-dir <session-dir> \
  --json
```

### Observation Queries

```bash
rg -n "PumpSwap|pumpswap|parseRate|blocked|unsupported" logs tmp data/realtime-sessions
```

---

## Risks

| 리스크 | 대응 |
|---|---|
| 이벤트 discriminator/offset 추정이 틀릴 수 있음 | 샘플 tx를 먼저 확보하고 fixture화 |
| DexScreener dexId alias가 예상과 다를 수 있음 | alias set으로 시작하고 실제 응답 기준으로 축소 |
| 로그 이벤트가 없거나 불안정할 수 있음 | transaction fallback을 유지하고 log parser는 best-effort로 설계 |
| parser를 급하게 넣다 false positive parse가 생길 수 있음 | 불확실하면 `null` 반환, coverage보다 정확성 우선 |

---

## Success Criteria

### Functional

- PumpSwap sample tx가 `ParsedSwap`으로 변환된다
- realtime eligibility가 PumpSwap pool을 허용한다
- 기존 Raydium/Orca 경로 회귀가 없다

### Operational

- PumpSwap 관련 pool이 realtime shadow에서 완전히 무시되지 않는다
- parse rate 또는 allowed pool 수가 이전보다 개선된다
- signal density 개선 가능성이 runtime에서 보인다

---

## Validation Snapshot

문서 반영 시점 기준 구현/검증 결과:

- 구현 범위
  - `PumpSwap` 상수/alias 추가
  - realtime eligibility에 `pumpswap/pumpfun/pump-swap` 허용
  - PumpSwap pool은 opaque log여도 tx fallback 강제
  - direct PumpSwap instruction decoder 추가
  - metadata-aware tx fallback 추가
  - tx fallback도 admission success로 집계
  - realtime fallback 설정값 추가 (`concurrency/rps/queue`)
  - paid plan에서는 batch fallback 사용, free plan에서는 single-request mode로 자동 downgrade
- 검증
  - `npm run build`
  - `npx jest --runInBand test/swapParser.test.ts test/realtimeEligibility.test.ts test/realtimeAdmissionTracker.test.ts`
  - `npm run realtime-shadow -- --help`
- live smoke:
    - pool: `HJAqvquMLHxcx7BYwDixukJM4zYBaTDG69uDWbo18zv`
    - tuned fallback (`4 concurrency / 8 rps / queue 1000`):
      - `observed_notifications=342`
      - `total_swaps=5`
      - `fallback_dropped=0`
      - `429` 다수 발생
    - balanced fallback (`2 concurrency / 4 rps / queue 1000`):
      - `observed_notifications=371`
      - `total_swaps=20`
      - `tx_fallback=20`
      - `fallback_skipped=0`
      - `fallback_unparsed=36`
      - `fallback_dropped=0`
    - long-run balanced smoke (`2 concurrency / 4 rps / queue 1000`, 300s):
      - `observed_notifications=22770`
      - `total_swaps=204`
      - `tx_fallback=200`
      - `fallback_dropped=20579`
      - `fallback_unparsed=987`
      - `errors=0`
    - compatibility smoke (`fallback-batch-size=5`, 90s, free plan):
      - batch RPC unsupported 감지 후 single-request mode로 자동 downgrade
      - baseline before backlog filter:
        - `observed_notifications=4363`
        - `total_swaps=31`
        - `tx_fallback=29`
        - `fallback_skipped=0`
        - `fallback_dropped=3001`
        - `fallback_unparsed=329`
      - after PumpSwap noise/backpressure filter:
        - `observed_notifications=1213`
        - `total_swaps=43`
        - `tx_fallback=40`
        - `fallback_skipped=350`
        - `fallback_dropped=0`
        - `fallback_unparsed=320`
      - `errors=0`

해석:

- PumpSwap pool이 더 이상 `not_swap_like` 때문에 전부 건너뛰어지지 않는다.
- 현재 실측 parser 성과는 `logs`가 아니라 `tx fallback` 중심이다.
- 운영 기본값은 `queue 확대 + 보수적 rps`가 더 안정적이다.
- paid batch RPC는 현재 플랜에서 막혀 있으므로, runtime은 자동으로 single-request fallback으로 내려간다.
- PumpSwap noise/backpressure filter 적용 후, 동일 90초 smoke에서 `fallback_dropped`를 `3001 -> 0`으로 줄이면서 `total_swaps`를 `31 -> 43`으로 늘렸다.
- 장시간 고볼륨 PumpSwap 풀에서는 parser 미구현보다 `fallback throughput / queue pressure`가 더 큰 병목이지만, 현재는 backlog-aware gating으로 완화 가능한 상태다.

---

## Exit Rules

- 6회 초과 반복 금지
- 샘플 ground truth 없이 discriminator/offset을 추측으로 확정하지 않는다
- coverage 개선보다 false parse 방지가 우선이다
- 이 문서 범위는 `PumpSwap coverage 확보`까지이며, strategy parameter tuning은 별도 문서에서 다룬다
