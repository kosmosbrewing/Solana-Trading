# Block QA

## Survival Layer Tier B-1 + Tier B-2/3/4 설계 (2026-04-21 2nd)

- Date: 2026-04-21
- Scope: `src/gate/sellQuoteProbe.ts` (신규) + `src/orchestration/pureWsBreakoutHandler.ts` (통합) + `docs/design-docs/survival-layer-tier-b-2026-04-21.md` (follow-up 설계)

### B-1 Active Sell Quote Probe 구현

**Why**:
- `securityGate` 는 static properties (freeze/mint authority, Token-2022 ext) 만 검증
- `entryDriftGuard` 는 buy fill 정합성만 검증
- "honeypot by liquidity" (매도 route 없음 / sell impact 폭증 / AMM 라우팅 실패) 는 **실제 매도 quote** 로만 드러남

**구현**:
- `evaluateSellQuoteProbe({ tokenMint, probeTokenAmountRaw, expectedSolReceive, tokenDecimals }, config)` 공개 함수
- Jupiter `tokenMint → SOL_MINT` 방향 quote 요청
- 검증 기준 3단계:
  1. Route found — Jupiter 가 매도 경로 찾는가 (`no_sell_route` 시 **reject** — honeypot 신호)
  2. `observedImpactPct > maxImpactPct` (default 10%) → reject
  3. (optional) round-trip 복구 비율 `< minRoundTripPct` → reject (default 0 = disabled)
- `entryDriftGuard` 와 동일 패턴: result cache (3s TTL) + 429 회로 차단기 (2s cooldown)
- Quote 실패 / 429 → approved=true + quoteFailed=true (observability only, false positive 비용 ↑)

**pure_ws handler 통합**:
- 위치: `entryDriftGuard` 직후, `nowSec` 계산 전
- live 모드에서만 활성 (`ctx.tradingMode === 'live'`)
- `executor.getMintDecimals` 로 token decimals resolve 후 probeTokenAmountRaw 계산
- reject 시 `[PUREWS_SELL_PROBE_REJECT]` info 로그
- pass 시 `[PUREWS_SELL_PROBE] outSol=... impact=... roundTrip=...` info

### 신규 Config

```
PUREWS_SELL_QUOTE_PROBE_ENABLED=true
PUREWS_SELL_QUOTE_MAX_IMPACT_PCT=0.10        # 10%
PUREWS_SELL_QUOTE_MIN_ROUND_TRIP_PCT=0       # disabled (관측 전 보수적)
```

### 신규 테스트 (`test/sellQuoteProbe.test.ts`, 9 cases)

1. normal quote within threshold → approved
2. no_sell_route → reject (honeypot-by-liquidity)
3. impact > maxImpactPct → reject (slippage bomb)
4. minRoundTripPct 초과 reject
5. minRoundTripPct=0 → skip check
6. Jupiter throws → quoteFailed=true, approved=true
7. invalid input (0 amount) → approved=true + reason=invalid_input
8. result cache hit → 2nd call axios skip
9. 429 circuit breaker → subsequent call rate_limited without axios

### 검증

- `tsc --noEmit` 0 errors
- `jest` 847 pass (이전 838 + 9 신규) / 1 pre-existing riskManager fail 무관

### B-2 / B-3 / B-4 설계 문서 (구현 미실시)

`docs/design-docs/survival-layer-tier-b-2026-04-21.md` 신규. 각 항목별:

- **B-2 LP Lock**: Raydium/Orca LP token supply 중 burn + lock 합산 비율 확인. Threshold 초안 `>= 0.80`. Helius pool registry 또는 Jupiter route metadata 에서 lpMint resolve 필요. Streamflow/GoFundMeme lock program 목록 수집 필요.
- **B-3 Bundler Detection**: 최근 M slot 내 BUY tx 의 signer diversity / funding source clustering. Helius geyser stream infra 필요. Latency vs 정확도 trade-off.
- **B-4 Dev Wallet DB**: 90일 backfill + rug 판정 태깅 + per-wallet reputation. 가장 큰 인프라 투자. Stage 2 통과 후 병렬 구축 권장.

**전제**: B-2/3/4 모두 Real Asset Guard 아님 — Survival Layer 확장. 없어도 Tier A + B-1 으로 Stage 1 Safety Pass 달성 가능.

### Mission Refinement 정합성

- Layer 1 Survival 커버리지: `rug/honeypot/Token-2022/top-holder/exit-quote` 중 **exit-quote 가 이번 B-1 으로 채워짐**
- Stage 1 Safety Pass 통과 기준 `survival filter pass rate >= 90%` 의 "filter pass" 범주가 실제로 exitability 까지 포함
- 향후 B-2/3/4 는 별도 sprint 에서 Stage 2/3 관측 데이터 기반으로 우선순위 조정

### Deployment runbook

```bash
ssh root@104.238.181.61 << 'EOF'
cd ~/Solana/Solana-Trading/solana-momentum-bot
git pull origin main
npm run build
pm2 restart solana-bot
pm2 logs solana-bot --lines 30 --nostream
EOF
```

startup `[REAL_ASSET_GUARD]` + `[PUREWS_SELL_PROBE]` / `[PUREWS_SELL_PROBE_REJECT]` 로그 주시.

### 관측 체크리스트

1. `[PUREWS_SELL_PROBE_REJECT]` reason 분포 — `no_sell_route` (honeypot) vs `sell_impact` (low-liq) 비율
2. Sell probe 추가로 overall survival pass rate 이 내려가면 Stage 1 통과 지연 가능 — 필요 시 `PUREWS_SELL_QUOTE_MAX_IMPACT_PCT` 완화 검토
3. Jupiter API 호출 빈도 — buy drift guard + sell probe 로 signal 당 2 quote. 429 회로 차단기 동작 확인

---

## Survival Layer P0 — pure_ws 에 Security Gate 연결 (2026-04-21)

- Date: 2026-04-21
- Trigger: mission refinement 의 P0 (Survival Layer) 지정. pure_ws lane 이 `evaluateSecurityGate` 를 완전히 우회 중이어서 pump.fun Token-2022 / 80%+ holder concentration token 도 무비판적 진입.
- Scope: `src/gate/securityGate.ts`, `src/orchestration/pureWsBreakoutHandler.ts`, `src/utils/config.ts`, `test/securityGate.test.ts`, `test/pureWsV2Scanner.test.ts`

### Findings & Fix

**Finding 1 — pure_ws 의 security gate 우회**:
- 증상: pure_ws handler (`handlePureWsSignal`) 에 `evaluateSecurityGate` / `onchainSecurityClient` 호출 없음. bootstrap path (`candleHandler.ts`) 에만 연결돼 있음.
- 결과: pump.fun (Token-2022) / 80%+ holder concentration token 도 survival 검사 없이 진입.
- Fix: `checkPureWsSurvival(tokenMint, ctx)` helper 추가 — gateCache 재사용, 필요 시 `onchainSecurityClient.getTokenSecurityDetailed` 직접 조회. viability floor 직전에 호출.

**Finding 2 — 기존 security gate 가 dangerous Token-2022 extension 미검출**:
- 증상: `hasTransferFee` 만 hard reject. `transferHook` / `permanentDelegate` / `nonTransferable` / `defaultAccountState` 는 log flag 만 찍고 통과.
- 각각의 위험:
  - `transferHook`: 외부 program 호출로 매도/전송 임의 차단 가능
  - `permanentDelegate`: authority 가 토큰 강제 회수 가능
  - `nonTransferable`: soul-bound (매도 불가)
  - `defaultAccountState`: 기본 Frozen → 매도 차단 가능
- Fix: `DANGEROUS_TOKEN_2022_EXTENSIONS` 상수 + `findDangerousExtensions` helper. `evaluateSecurityGate` 에서 transferFee reject 직후 hard reject 추가. 유일한 Token-2022 reject 경로에 확장.

**Finding 3 — top10 holder threshold 가 hard-coded (0.80)**:
- Fix: `SecurityGateConfig.maxTop10HolderPct` (default 0.80) 로 추출해 pure_ws 는 별도 threshold 운영 가능.

### 신규 Config

```
PUREWS_SURVIVAL_CHECK_ENABLED=true
PUREWS_SURVIVAL_ALLOW_DATA_MISSING=true        # RPC 간헐 실패 허용 (observability only)
PUREWS_SURVIVAL_MIN_EXIT_LIQUIDITY_USD=5000
PUREWS_SURVIVAL_MAX_TOP10_HOLDER_PCT=0.80
```

`pureWsSurvivalAllowDataMissing=true` default 근거: RPC 간헐 실패로 signal 을 놓치는 쪽이 더 위험. Stage 2 통과 후 엄격화 재검토.

### 신규 테스트

- `test/securityGate.test.ts` (+6): transferHook / permanentDelegate / nonTransferable / defaultAccountState reject + benign Token-2022 (metadataPointer) 허용 + top10 threshold config override
- `test/pureWsV2Scanner.test.ts` (+4): transferHook 진입 차단 / data missing + allow/deny / top-holder 진입 차단

### 검증

- `tsc --noEmit` 0 errors
- `jest` 838 pass (이전 828 + 10 신규) / 1 pre-existing riskManager fail 무관

### 예상 효과

- pure_ws 의 진입 대상 pair 중 rug-prone Token-2022 + high-concentration token 자동 차단
- Mission refinement 의 Stage 1 Safety Pass 기준 (`survival filter pass rate >= 90%`) 이 실제 측정 가능
- pump.fun 의 일부 전송 제한 토큰도 사전 차단 가능

### Deployment Runbook

```bash
ssh root@104.238.181.61 << 'EOF'
cd ~/Solana/Solana-Trading/solana-momentum-bot
git pull origin main
npm run build
pm2 restart solana-bot
pm2 logs solana-bot --lines 30 --nostream
EOF
```

startup `[REAL_ASSET_GUARD]` 로그 + `[PUREWS_SURVIVAL_REJECT]` 로그 주시.

### 관측 체크리스트 (24h)

1. `[PUREWS_SURVIVAL_REJECT]` 빈도 + reason 분포 — transferHook / HIGH_CONCENTRATION / FREEZABLE / NO_SECURITY_DATA 중 어떤 reason 이 dominant 인지
2. 진입 대상 pair 의 `survival filter pass rate` (Daily 4질문 #2) — Stage 1 통과 기준 >= 90% 여부
3. `NO_SECURITY_DATA` 비율이 높으면 `pureWsSurvivalAllowDataMissing=false` 로 엄격화 검토 (다만 signal 손실 이슈 재평가)

### Follow-up (Tier B Survival items)

- LP lock / unlock (Raydium/Orca LP token authority 확인)
- Dev wallet behavior pattern DB
- Bundler analysis (same-slot transaction cluster)
- Honeypot simulation (Jupiter sell quote probe) — 이미 entryDriftGuard 에 부분 구현

---

## V2 Telemetry + V1 Cooldown + Canary Auto-Reset (2026-04-21)

- Date: 2026-04-21
- Trigger: VPS 24h 관측에서 `PUREWS_V2_PASS=0` + BOME 한 pair 에 4 연속 진입 → canary halt 재발 → 21h 관측 중단
- Scope: v2 observability, v1 per-pair cooldown, canary halt auto-reset

### Findings & Fix

**P0 — V2 scanner PASS 0건 (진단 불가)**:
- 증상: 24h 동안 `PUREWS_V2_PASS` 0건. `PUREWS_V2_REJECT` 는 `log.debug` 라 INFO 레벨 운영 로그에 안 찍혀 원인 분석 불가.
- Fix: scan 누적 counter (`v2Telemetry`) 추가 + `logPureWsV2TelemetrySummary()` 를 1분 주기로 호출.
  카운트: scansCalled / pairsEvaluated / candlesInsufficient / detectorRejects(reason별 top3) / noCurrentPrice / cooldownSkipped / haltSkipped / passed
- 관측 시 `[PUREWS_V2_SUMMARY]` 로그로 볼륨/bp/score 어떤 factor 에서 reject 되는지 즉시 진단 가능.

**P1 — V1 (bootstrap) 경로 per-pair cooldown 부재**:
- 증상: BOME (ukHH6c7m) 한 pair 에 `bootstrap_10s` signal 이 close 직후 반복 fire → 4 연속 진입 → canary halt.
- 원인: duplicate guard 는 "이미 holding" 만 차단. close 후 재 signal 은 통과.
- Fix: `v1LastEntrySecByPair` Map 추가 + `PUREWS_V1_PER_PAIR_COOLDOWN_SEC` (default 300s) 체크. v2 signal (`sourceLabel === 'ws_burst_v2'`) 은 scanner 자체 cooldown 사용하므로 v1 check bypass.

**P2 — Canary halt threshold 보수적 + 수동 해제 전용**:
- 증상: `consecutive losers 4 >= 4` 로 조기 halt → 운영자 수동 개입까지 21h 관측 중단
- Fix:
  - `CANARY_MAX_CONSEC_LOSERS` default `4 → 8` 완화 (표본 부족 원칙, budget cap 이 실 자산 guard)
  - `checkAndAutoResetHalt(lane, nowMs)` 추가 — halt 후 `canaryAutoResetMinSec` (default 1800s=30분) 경과 + budget 여유 있으면 자동 reset
  - `canaryAutoResetEnabled` (default true) / `canaryAutoResetMinSec` env 노출
  - budget 초과 halt 는 auto-reset 금지 — 실 자산 guard 유지
  - index.ts 에서 1분 주기 `checkAllLanesAutoResetHalt()` 호출

### 새 Config

```
PUREWS_V1_PER_PAIR_COOLDOWN_SEC=300         # v1 cooldown (v2 와 동일 default)
CANARY_MAX_CONSEC_LOSERS=8                  # 4 → 8 완화
CANARY_AUTO_RESET_ENABLED=true              # default true
CANARY_AUTO_RESET_MIN_SEC=1800              # 30분
```

### 신규 테스트

- `test/canaryAutoHalt.test.ts` — auto-reset after cooldown / budget exhausted skip / disabled flag no-op (3 cases)
- `test/pureWsV2Scanner.test.ts` — v1 cooldown blocks repeated bootstrap / v2 bypass (2 cases)

### 검증

- `tsc --noEmit` 0 errors
- `jest` 828 pass (기존 823 + 5 신규) / 1 pre-existing riskManager fail 무관

### 예상 효과

- V2 scanner 왜 0 PASS 인지 1분 주기로 명확히 보임 (운영 중 threshold 튜닝 가능)
- BOME 류 반복 진입 → pair diversity 확보 → canary halt 조기 발동 방지
- halt 후 30분 시간 경과 + 실 자산 여유 있으면 자동 해제 → 관측 재개

### Deployment Runbook

```bash
ssh root@104.238.181.61 << 'EOF'
cd ~/Solana/Solana-Trading/solana-momentum-bot
git pull origin main
npm run build
pm2 restart solana-bot
pm2 logs solana-bot --lines 30 --nostream
EOF
```

### 관측 체크리스트 (재배포 후 2h)

1. `[PUREWS_V2_SUMMARY]` 로그 — 매 1분 출력. eval/reject/insuf/PASS 빈도 분석
2. `[PUREWS_V1_COOLDOWN]` — 같은 pair 반복 signal 차단 빈도
3. `[CANARY_AUTO_RESET]` — halt 자동 해제 발생 여부 (30분 경과 후)
4. pair diversity — 하루 진입 pair 수 (BOME 만 4건 → 다양화 목표)

### Follow-up

- `[PUREWS_V2_SUMMARY]` 누적 데이터 기반으로 threshold 튜닝 (2-3일 관측 후)
- V1 cooldown 을 환경별 조정 가능하게 (예: meme pair 는 짧게, blue chip 은 길게)
- Budget 자동 리셋도 고려 (일별 UTC day rollover)

---

## Orphan Close Loop + V2 Scanner Halt Gate (2026-04-20)

- Date: 2026-04-20
- Trigger: VPS 24h 관측에서 `purews-ukHH6c7m-1776644353` (BOME) 포지션이 **3,982회/8분** sell 재시도 spam + V2 scanner 가 halt 상태에서도 `GEr3mp` pair 에 대해 567회 PASS 로그 스팸
- Scope: `src/orchestration/pureWsBreakoutHandler.ts`, `src/utils/types.ts`, `src/notifier/messageFormatter.ts`

### Findings & Fix

**P0a — Orphan position 무한 close 루프** (`closePureWsPositionSerialized`):
- 증상: live 모드에서 `getTokenBalance==0n` 시 `throw new Error('no token balance')` → catch 가 `pos.state = previousState` 복원 → 매 tick 마다 재시도 → 초당 ~8회 spam
- 원인: 외부 sell / rug / DB OPEN 상태로 남은 이전 세션 trade 가 recovery 로 인-메모리 로드
- Fix: `tokenBalance==0n` 을 orphan 정상 close 경로로 분기 — `reason='ORPHAN_NO_BALANCE'`, `actualExitPrice=pos.entryPrice` (pnl=0), `sellCompleted=true`, DB close 수행, critical notifier 1회

**P0b — Recovery 시 선제 orphan 검사** (`recoverPureWsOpenPositions`):
- 증상: 재시작 직후 orphan 이 in-memory 로 로드되어 close loop 트리거
- Fix: live 모드에서 recovery 전 `getTokenBalance` 검사 → 0 이면 **DB 직접 close** (reason=ORPHAN_NO_BALANCE, pnl=0) + in-memory load 건너뜀
- Balance check 실패 시 기존 recovery 로 진행 (close loop fix 가 안전망)

**P2 — V2 scanner halt 상태에서도 detector 실행 + V2_PASS 로그 spam** (`scanPureWsV2Burst`):
- 증상: `GEr3mp` pair 에 대해 halt 상태에서도 567회 PASS 로그, Jupiter quote spam
- 원인: halt 시 handler 가 `PUREWS_ENTRY_HALT` 로 return → position 생성 실패 → cooldown 설정 안 됨 → 다음 scan 에서 다시 pass → 무한 loop
- Fix: scan 진입 시점에 `isEntryHaltActive(LANE_STRATEGY)` 체크 → halt 활성화되어 있으면 **scan 자체 no-op**

### 새 타입

```ts
export type CloseReason =
  | ...
  | 'ORPHAN_NO_BALANCE';  // 2026-04-20 신규
```

notifier label: `ORPHAN_NO_BALANCE: '잔고 없음 (고아 포지션 정리)'`

### 신규 테스트

- `test/pureWsBreakoutHandler.test.ts` — **[2026-04-20 P0 fix] orphan close**: live 모드 + tokenBalance=0 → executeSell 미호출 / DB close ORPHAN_NO_BALANCE / state=CLOSED / notifier 1회
- `test/pureWsV2Scanner.test.ts` — **[2026-04-20 P2 fix] entry halt active → scan returns early**: halt 상태에서 scan 호출 시 insertTrade 0회 / 포지션 생성 0건

### 검증

- `tsc --noEmit` 0 errors
- `jest` 823 pass (기존 813 + P0/P2 fix 로 신규 10) / 1 pre-existing riskManager fail 무관

### 배포 효과

- 24h 관측 3,982 sell 재시도 spam 제거 → RPC / Jupiter API 낭비 해소
- V2 scanner halt 시 detector/log no-op → Jupiter rate-limit 부담 경감 (P0-2 방어와 결합)
- Orphan position 이 DB 에 OPEN 유지되는 상태 방지 → 재시작 후 clean state

### Deployment Runbook

```bash
ssh root@104.238.181.61 << 'EOF'
cd ~/Solana/Solana-Trading/solana-momentum-bot
git pull origin main
npm run build
pm2 restart solana-bot
pm2 logs solana-bot --lines 30 --nostream
EOF
```

재시작 직후 관측:
1. `[PUREWS_RECOVERY_ORPHAN]` 로그 — 기존 orphan 이 자동 DB close 되어 in-memory 미로드 확인
2. `[PUREWS_ORPHAN_CLOSE]` 로그 — runtime orphan 감지 시 1회만 발생
3. `[PUREWS_V2_PASS]` 로그 — halt 풀린 상태에서만 찍힘 (spam 종료)
4. `[PUREWS_LIVE_SELL] sell failed` 반복 로그 — 더 이상 없음

### Follow-up

- V1 경로 (`handlePureWsSignal`) 에도 per-pair cooldown 추가 여부 (bootstrap 자체가 10s 주기라 우선순위 낮음)
- `marketReferencePrice` DB 저장 (recovery 정합성 향상)
- 토큰 잔고 이상 감지 주기적 reconciler (외부 sell 감지)

---

## Pure_ws Entry Drift + Dual Price Tracker (2026-04-19)

- Date: 2026-04-19
- Trigger: VPS 2026-04-18 재배포 이후 12h 동안 pure_ws lane 4 trades 전부 `REJECT_HARD_CUT` → `consecutive losers 4 >= 4` → entry halt 재발. 관측 데이터 축적 불가.
- Scope: `src/gate/entryDriftGuard.ts` (신규), `src/orchestration/pureWsBreakoutHandler.ts`, `src/utils/config.ts`

### Root Cause — Signal price vs Jupiter fill price 갭

VPS 관측 4 trades 전부 Jupiter 체결가가 signal price 대비 **+20~51% 높게 fill**:

| Trade (UTC) | signal | Jupiter entry | drift |
|-------------|--------|--------------|-------|
| 15:58 ACtfUWtg | 0.00008701 | 0.00011099 | **+27.6%** |
| 16:10 ACtfUWtg | 0.00008757 | 0.00011177 | **+27.6%** |
| 16:33 ACtfUWtg | 0.00008701 | 0.00013169 | **+51.4%** |
| 16:39 AmPgMs7Y | 0.00002573 | 0.00003104 | **+20.6%** |

기존 `pureWsBreakoutHandler` 는 hard-cut/MAE/MFE 를 **entry price 기준**으로 계산 → 체결 순간 이미 MAE −20~−50% → `pureWsProbeHardCutPct=0.04` 즉시 발동 → 실제 시장 이동 없이 hardcut → 4 연패 → halt.

**공통 조건**: `Token-2022 pump.fun` migration token, Jupiter `impact=0.001~0.003%` 보고 (하지만 실제 fill 은 크게 벗어남, routes=1 의 low-liquidity pool).

### Fix — 3가지 변경

1. **Entry Drift Guard** (신규 `src/gate/entryDriftGuard.ts`)
   - Jupiter 에 probe-sized quote 를 미리 요청 → expected fill price 계산 → signal price 와 비교
   - drift 가 `PUREWS_MAX_ENTRY_DRIFT_PCT` (default 2%) 초과 시 **entry 차단**
   - quote 실패 / decimals 미확인 시 gate 통과 (observability only, trade 차단 금지)
   - 양방향 symmetric check — 과도 유리 fill 도 suspicious 로 판정

2. **Dual Price Tracker** (pureWsBreakoutHandler)
   - `PureWsPosition.marketReferencePrice` 필드 추가 — signal price 저장
   - `peakPrice`, `troughPrice` 초기값 = `marketReferencePrice`
   - `MAE/MFE/currentPct` 계산을 market reference 기준으로 변경
   - `maxPeak`, `t2BreakevenLockPrice` 도 market reference domain 으로 통일
   - `pnl` 계산은 `entryPrice` (Jupiter fill) 기준 유지 — 실제 지출 대비 정확성
   - Recovery 경로: DB 에 marketRef 없음 → `plannedEntryPrice` (signal price) fallback, 없으면 `entryPrice` fallback

3. **V2 scanner default on**
   - `PUREWS_V2_ENABLED` default `false` → **`true`** 로 전환
   - bootstrap_10s 의존 완화 → Phase 1-3 의 wsBurstDetector + quickReject + holdPhase 가 실제 signal 에 대해 동작
   - tuned thresholds (minPassScore=50, floorVol=0.15 등) 이미 2026-04-18 paper replay 로 캘리브레이션 완료

### Config 추가

```
PUREWS_ENTRY_DRIFT_GUARD_ENABLED=true  # default on
PUREWS_MAX_ENTRY_DRIFT_PCT=0.02        # 2%
PUREWS_USE_MARKET_REFERENCE_PRICE=true # default on
PUREWS_V2_ENABLED=true                 # default flipped: false → true
```

### 검증

- `tsc --noEmit` 0 errors
- `jest` 813 pass (기존 803 + entryDriftGuard 8 tests + dual tracker 2 regression tests) / 1 pre-existing riskManager fail 무관
- 신규 regression test: `test/entryDriftGuard.test.ts` — VPS 2026-04-18 16:10 pippin 케이스 재현 (signal=0.0000876, Jupiter out=89M raw/decimals=6 → drift +27.5% → reject)
- 신규 regression test: `test/pureWsBreakoutHandler.test.ts` — market ref 기준 MAE=0% 면 hardcut 발동 안 함 + 실제 시장 -5% 이동 시 여전히 hardcut 정상 작동

### 예상 효과

- 4 trades 모두 **entryDriftGuard 에서 reject 됐을 것** → −0.0122 SOL 회피
- bad fill 이 진입되더라도 market-ref MAE 로 전환 → 시장이 움직이지 않으면 hardcut 안 발동 → sample size 확보 가능
- v2 scanner 로 bootstrap_10s 의존 탈피 → Phase 1-3 관측 목적 달성

### Deployment Runbook

```bash
ssh root@104.238.181.61 << 'EOF'
cd ~/Solana/Solana-Trading/solana-momentum-bot
git pull origin main
npm run build
pm2 restart solana-bot
pm2 logs solana-bot --lines 30 --nostream
EOF
```

### 관측 체크리스트 (재배포 후 24h)

1. `[PUREWS_ENTRY_DRIFT]` 로그 빈도 — signal-fill gap 분포 확인
2. `[PUREWS_ENTRY_DRIFT_REJECT]` 빈도 — 얼마나 많은 bad fill 을 차단했는가
3. `[PUREWS_V2_PASS]` 빈도 — v2 detector signal 생성 빈도
4. `[PUREWS_LOSER_HARDCUT]` 원인 — market ref 기준 real rug 만 카운트
5. `[CANARY_HALT]` lane=pure_ws_breakout 재발 여부 — 발동 안 하면 Phase 1-3 관측 활성

### Follow-up 후보 (이번 scope 외)

- Token-2022 policy: transfer fee 체크 / reject rule 추가 (F5 유사 패턴)
- market reference 값을 DB 에 저장 (recovery 시 정합성 유지)
- v2 scanner 활성화 이후 v1 (bootstrap signal-path) disable 여부 결정 (중복 signal 완화)

### QA Pass (2026-04-19)

구현 직후 self-QA 로 4 개 finding 발견 및 모두 수정:

- **Q1 (HIGH fixed)**: Jupiter `/quote` response 에 `outputDecimals` 없어 hint 없으면 drift guard 가 `decimals_unknown` 으로 항상 pass. Fix: `Executor.getMintDecimals` public 화 + handler 가 사전 resolve 해 hint 전달 (cache 적용, 반복 호출 비용 0).
- **Q2 (MED fixed)**: 진입 직후 봇 자신의 BUY tx 가 low-liquidity pool price 를 띄우면 첫 tick `currentPrice` 가 fill level 로 튐 → `peakPrice` 가 그 수준까지 올라감 → 시장이 signal 로 복귀 시 trail stop hit. Fix: `PUREWS_PEAK_WARMUP_SEC` (3s) + `PUREWS_PEAK_WARMUP_MAX_DEVIATION_PCT` (5%) — warmup 중 peak 업데이트는 marketRef × 1.05 이내만 허용.
- **Q3 (MED fixed)**: symmetric drift check 가 convexity 원칙과 모순 — 유리 fill 도 reject 하면 convex payoff 놓침. Fix: asymmetric — positive drift 만 reject, negative drift 는 `[ENTRY_DRIFT_FAVORABLE]` loud warn 로 logging 하되 entry 허용.
- **Q4 (LOW fixed)**: recovery 시 `troughPrice = trade.entryPrice` (fill) 로 세팅되어 marketRef 와 domain mismatch — 초기 MAE 가 음수로 안 찍힘. Fix: `troughPrice = marketReferencePrice`.

신규 테스트:
- `test/entryDriftGuard.test.ts` — asymmetric favorable fill 허용 검증
- `test/pureWsBreakoutHandler.test.ts` — peak warmup 중 봇 자신의 BUY impact 반영 억제 검증

### 검증 (QA Pass 후)

- `tsc --noEmit` 0 errors
- `jest` 814 pass (기존 803 + Q1~Q4 fix 로 신규 11) / 1 pre-existing riskManager fail 무관

---

## Wallet Delta Drift Root Cause — Live VPS Investigation (2026-04-18 PM)

- Date: 2026-04-18
- Trigger: VPS 에서 WALLET_DELTA_WARN 반복 알림 (drift 0.079851 SOL, warn ≥ 0.03)
- Scope: `src/orchestration/{cupseyLaneHandler,migrationLaneHandler,pureWsBreakoutHandler}.ts` entry metrics 처리 + `src/orchestration/signalProcessor.ts` helper 분리

### Root Cause

`cupsey-Dfh5DzRg-1776511972` (pippin) UTC 11:33:03 BUY:
- Executor 실제 지출 `0.009950 SOL` / 수령 `30,117,963 raw tokens` (≈ 30.12 decimals 적용)
- Jupiter response: `actualOutUiAmount = 30.12` 있음 / **`actualInputUiAmount = undefined`** (SOL 전송량 미보고)
- Handler 코드:
  ```ts
  if (actualOutUiAmount > 0) actualQuantity = 30.12;        // ✅ 업데이트
  if (actualInputUiAmount > 0 && actualQuantity > 0) {       // ❌ 조건 실패
    actualEntryPrice = actualInputUiAmount / actualQuantity; // ❌ signalPrice 그대로 유지
  }
  ```
- 결과: `actualEntryPrice = 0.00302282` (signal price) + `actualQuantity = 30.12` (real received) → `executed-buys.jsonl` 에 `price × qty = 0.0911 SOL` 기록
- 실제 지출 `0.00995 SOL` 과 10x 차이 → `walletDeltaComparator.computeExpectedDelta()` 가 0.08 SOL 더 큰 loss 계상
- `CUPSEY_CLOSED pnl=-0.081129 SOL (-89.11%)` 로 DB 기록 — 같은 오류가 close path 에도 전파
- drift = expected(-0.094217) − observed(-0.014367) = **−0.079851 SOL** (= 0.0811 과대 계상)

### Impact

- wallet_delta_warn 매 5분 반복 (x10+ 누적)
- 실제 자산 손실 아님 (ledger 정합성 문제) — 봇 자체는 safe
- cupsey / migration / pure_ws 모두 동일 코드 패턴 → 향후 동일 조건에서 반복 가능

### Fix

1. `src/orchestration/signalProcessor.ts` — `buildEntryExecutionSummary` 내부의 all-or-nothing guard 를 `resolveActualEntryMetrics(order, buyResult)` 로 추출 (export)
   - 한쪽 필드라도 누락되면 둘 다 planned 로 복원 (P0-A 정합성 guard, signalProcessor 에 이미 검증된 로직 재사용)
2. `cupseyLaneHandler.ts:613-618`, `migrationLaneHandler.ts:424-428`, `pureWsBreakoutHandler.ts:344-348` — 각각 `resolveActualEntryMetrics()` 호출로 교체
3. `test/signalProcessor.test.ts` — 실제 pippin 케이스 regression 테스트 추가 (partial metrics → both forced to planned)

### Related Finding — Entry Integrity Halt (pure_ws lane)

- UTC 09:40:15 에 `[ENTRY_HALT_TRIGGERED] lane=pure_ws_breakout reason=consecutive losers 4 >= 4` 발동
- 원인: `canaryAutoHalt.ts:84` 가 paper/live 구분 없이 close pnl 을 누적 → paper-first 모드의 pure_ws 가 4 loser 로 halt
- 결과: Phase 1-3 기능 (v2 scanner, viability floor, quickReject, holdPhase) 이 관측 데이터 수집하지 못하는 상태
- 해결: 봇 재시작으로 in-memory state reset (open positions=0 상태라 안전)
- **Follow-up 후보** (이번 scope 제외): paper 모드에서 canary halt 를 count 만 하고 trigger 는 생략하는 옵션. 현재는 보수적으로 halt 유지 → 운영자 판단 후 별도 PR.

### Deployment

재시작 한 번으로 모든 issue 해소:
- `baselineBalanceSol` 현재 지갑 값으로 재캡처
- `baselineLedgerOffsets` 현재 파일 line count 로 세팅 → 과거 pippin entry 가 expected 계산에서 제외
- pure_ws `entryHalt` reset → Phase 1-3 관측 재개
- 새 코드가 적용되어 drift 재발 방지

```bash
ssh root@104.238.181.61 << 'EOF'
cd ~/Solana/Solana-Trading/solana-momentum-bot
git pull origin main
npm run build   # 또는 npx tsc
pm2 restart solana-bot
pm2 logs solana-bot --lines 20 --nostream
EOF
```

재시작 후 5분 내 `[WALLET_DELTA] drift` 가 0 근방으로 회귀되는지 확인.

---

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
