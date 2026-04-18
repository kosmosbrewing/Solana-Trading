# Top-Down Mission Bottleneck Analysis — Foundation

> Status: active analysis frame for the current mission review
> Date: 2026-04-18
> Purpose: 이번 라운드에서 `1 SOL -> 100 SOL` 사명 병목을 **위에서 아래로** 분석하기 위한 공통 틀
> Parent plan: [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md)
> Use with: [`PLAN.md`](../../PLAN.md), [`MEASUREMENT.md`](../../MEASUREMENT.md), [`STRATEGY.md`](../../STRATEGY.md)

## 0. Why This Doc

현재 프로젝트는 로컬 최적화에 빠질 위험이 크다.

- gate 하나를 풀면 signal 은 늘어날 수 있다
- 하지만 wallet 기준 손익이 나빠질 수 있다
- 새 lane 을 붙이면 기회는 늘어날 수 있다
- 하지만 source-of-truth 가 닫히지 않으면 해석 전체가 오염된다

따라서 이번 분석은 아래 순서를 강제한다.

```text
Mission
  -> Truth / Measurement
  -> Lane
  -> Funnel
  -> Strategy / Gate / Exit
  -> Infra / Tooling
```

이 문서는 재사용 가능한 범용 템플릿이 아니라, **현재 코드와 active plan 상태를 반영한 1차 분석 프레임**이다.

## 1. Authority Order

이번 Top-Down 분석에서 문서 권한은 아래 순서로 읽는다.

1. [`PLAN.md`](../../PLAN.md)
   - 상위 사명과 운영 원칙
2. [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md)
   - 현재 active execution truth, lane stack, P0 우선순위
3. [`STRATEGY.md`](../../STRATEGY.md)
   - 현재 runtime quick reference
4. [`MEASUREMENT.md`](../../MEASUREMENT.md)
   - Mission / Execution / Edge 판단 기준
5. [`PROJECT.md`](../../PROJECT.md)
   - persona / 초기 설계 참고용

중요:
- `PROJECT.md`는 폐기 문서가 아니다
- 다만 **현재 runtime 병목 판정의 authority 문서도 아니다**

## 2. Layer 0 — Mission

### Fixed Mission

상위 사명은 여전히 [`PLAN.md`](../../PLAN.md) 의 문장으로 고정한다.

> 가격이 움직여서 사는 게 아니라, 움직일 이유가 있고, 실제로 움직이기 시작할 때 산다.

그리고 mission horizon 은 `1 SOL -> 100 SOL` 자체보다:

- 설명 가능한 진입
- 보수적 리스크 관리
- 반복 가능한 기대값

을 가진 자동화 경로를 만드는 것이다.

### Mission Questions

이 레이어에서 먼저 묻는 질문:

1. 지금 최적화해야 하는 것은 `trade count` 인가, `wallet expectancy` 인가?
2. 지금 필요한 것은 `새 lane 추가` 인가, `기존 primary lane 증명` 인가?
3. 현재 단계에서 사명 위배 없이 열 수 있는 것은 무엇인가?

### Current Mission Constraint

현재 mission 레벨에서 유지할 제약은 아래다.

- 설명 없는 급등 추격 금지
- hard safety / integrity 위반 상태에서 trade 확대 금지
- 측정 없이 lane 승격 금지

출처:
- [`PLAN.md`](../../PLAN.md)
- [`MEASUREMENT.md`](../../MEASUREMENT.md)

## 3. Layer 1 — Truth / Measurement

이 레이어가 닫히지 않으면 아래 레이어의 결론은 모두 잠정치다.

### Core Rule

운영 판단의 ground truth 는 active plan 기준 **`wallet delta` 하나**다.

아래는 ground truth 자체가 아니라, wallet delta 를 설명하기 위한 **reconciliation evidence**다.

- executed ledger
- tx signature
- DB row
- notifier / Telegram

즉 이 레이어의 핵심 질문은:

> `wallet delta`를 다른 artifact가 같은 사실로 설명할 수 있는가?

### Truth Questions

1. 지금 보는 손익이 실제 wallet 변화와 일치하는가?
2. `executed-buys/sells.jsonl`, `trades`, Telegram, wallet delta 가 같은 거래를 말하는가?
3. 특정 lane 의 성과가 DB 착시인지 실거래인지 구분 가능한가?

### Mandatory Evidence

아래 증거가 없이 전략/게이트 결론을 내리지 않는다.

- `npm run ops:reconcile:wallet`
- `npm run ops:check:ledger`
- `executed-buys.jsonl`
- `executed-sells.jsonl`
- `trades`
- notifier / Telegram message
- VPS env / executor wallet 설정

### Current Known Bottleneck

active plan 기준 현재 최우선은:

- **P0-0 Source-of-truth / wallet attribution closure**

즉 현재 Top-Down 분석의 첫 병목 후보는 기본값으로 이 레이어에 둔다.

## 4. Layer 2 — Lane Map

이 레이어는 "무슨 전략이 있나"가 아니라, **실제로 어느 lane 이 돈을 벌고 잃는가**를 본다.

### Current Lane Stack

현재 기준 lane map:

| Tier | Lane | 역할 | 상태 |
|---|---|---|---|
| 0 | `cupsey_flip_10s` | current primary execution lane | conditional current primary |
| signal | `bootstrap_10s` | signal source only | signal-only |
| 1 | `Migration Handoff Reclaim` | 다음 확장 후보 | design candidate |
| 2 | `Liquidity Shock Reclaim` | 이후 후보 | backlog |

출처:
- [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md)
- [`STRATEGY.md`](../../STRATEGY.md)

### Lane Questions

1. 지금 실제 wallet 손익을 만드는 lane 은 무엇인가?
2. bootstrap 은 signal source 인가, direct execution 인가?
3. cupsey 는 실제로 어느 wallet / executor 를 사용하는가?
4. lane attribution 이 notifier / DB / ledger 에 일관되게 남는가?

### Lane Decision Rule

- primary lane 증명이 끝나기 전에는 live lane 을 여러 개 동시에 열지 않는다
- 다음 lane 추가는 **현재 lane 의 wallet 기준 기대값 측정 이후**에만 검토한다

## 5. Layer 3 — Funnel

lane 이 정해지면, 그 lane 이 **어느 단계에서 죽는지**를 본다.

### Shared Funnel

```text
discovery
  -> admission
  -> watchlist / realtime subscription
  -> signal
  -> gate pass
  -> risk pass
  -> order submit
  -> tx success
  -> DB persist
  -> notifier
  -> close
  -> wallet delta
```

### Cupsey Funnel

현재 primary lane 기준 funnel 은 아래를 우선 본다.

```text
bootstrap signal
  -> cupsey gate pass
  -> STALK created
  -> PROBE entry
  -> tx success
  -> DB persisted
  -> notifier open
  -> closed
```

### Existing Data Sources

이미 있는 계측을 재사용한다.

- `ops:check`
- `ops:check:sparse`
- `cupsey funnel`
- `fresh-funnel-audit.ts`
- runtime diagnostics

즉 이 문서는 새 funnel 을 만드는 문서가 아니라, **기존 funnel 을 병목 분석 층으로 배치하는 문서**다.

### Truth Closure Checkpoint

`wallet delta verified`는 현재 cupsey runtime funnel counter의 단계가 아니다.

이 값은 funnel 마지막 단계가 아니라, **Layer 1 Truth / Measurement**에서 별도로 확인하는 checkpoint 로 둔다.

즉 해석 순서는 아래다.

```text
funnel closed
  -> Layer 1 reconciliation
  -> wallet delta explained / unexplained 판정
```

### Funnel Questions

1. signal 부족인가, conversion 부족인가?
2. discovery/admission 단계에서 이미 막히는가?
3. entry 는 되는데 DB/notifier/wallet 단계에서 truth 가 끊기는가?
4. close 는 되는데 wallet 기준으로 손익이 설명되지 않는가?

## 6. Layer 4 — Strategy / Gate / Exit

이 레이어는 funnel 병목이 확인된 뒤에만 본다.

### Strategy Questions

1. entry thesis 가 늦는가?
2. gate 가 너무 엄격한가, 아니면 잘못된 soft fail-open 인가?
3. quick reject / winner hold 가 실제 분포와 맞는가?
4. exit 구조가 winner 를 너무 일찍 자르는가?

### Current Strategy Context

현재 runtime 핵심 사실:

- `bootstrap_10s` = signal-only
- `cupsey_flip_10s` = active primary
- A/C = dormant

따라서 당장 전략 분석의 중심은:

- bootstrap direct buy 여부가 아니라
- **cupsey conversion / cupsey post-entry / cupsey close 품질**

이다.

## 7. Layer 5 — Infra / Tooling

이 레이어는 하위가 아니다. 위 결론이 **믿을 만한지**를 보정하는 레이어다.

### Infra Questions

1. sync 가 stale dump 를 가져오고 있지 않은가?
2. notifier 와 DB 가 같은 거래를 말하는가?
3. runtime diagnostics 가 실제 병목을 숨기지 않는가?
4. replay / audit / reconcile 도구가 current truth 와 맞는가?

### Current Infra Focus

현재 우선순위는 low-latency infra split 이 아니라:

- wallet reconcile
- executed ledger
- sync hardening
- telemetry completeness

이다.

## 8. Decision Rules

Top-Down 분석 시 아래 규칙을 강제한다.

### Rule 1

`Truth / Measurement`가 닫히지 않았으면,
`Lane`, `Funnel`, `Strategy` 결론은 모두 **잠정치**로 표기한다.

### Rule 2

`Lane`이 안 고정됐으면,
개별 `Strategy` 파라미터 튜닝을 먼저 하지 않는다.

### Rule 3

`Funnel` 병목이 안 보이면,
`signal 부족`과 `entry conversion 부족`을 구분하지 않은 채 완화하지 않는다.

### Rule 4

`Strategy` 결론을 낼 때는 반드시:

- Mission
- Truth
- Funnel

3층의 근거를 함께 적는다.

### Rule 5

`Infra`는 마지막에 손대는 것이 아니라,
위 레이어의 결론 신뢰도를 보증하는 조건으로 병행 점검한다.

## 9. Current First-Pass Hypothesis (2026-04-18)

이 문서 작성 시점의 1차 가설은 아래다.

### Primary Bottleneck

- **Source-of-truth / wallet attribution closure**

### Secondary Bottleneck

- `cupsey primary`의 wallet-verified expectancy 미확정

### Tertiary Bottleneck

- live freshness / admission / conversion 중 어디가 실제 최상위 병목인지 추가 분해 필요

중요:
- 이 1차 가설은 verdict 가 아니다
- 다음 분석에서 evidence 로 갱신한다

## 10. Next Step

이 문서 다음 단계는 아래 순서다.

1. Layer 1 evidence 수집
2. current lane attribution 확인
3. funnel 단계별 count 정리
4. 그 다음에야 strategy/gate 병목 판정

즉,

> 먼저 "무엇이 진짜 사실인가"를 닫고,
> 그 다음 "어디서 죽는가"를 보고,
> 마지막에 "무엇을 고칠 것인가"를 정한다.

---

## 11. Layer 1 — First-Pass Analysis (2026-04-18)

이번 1차 실분석은 `Truth / Measurement` 레이어만 다룬다.

### 11.1 Evidence Collected

#### A. Synced runtime artifacts are fresh enough

- `current-session.json`
  - `startedAt = 2026-04-17T17:16:08.792Z`
- latest VPS trade snapshot:
  - `data/vps-trades-20260418-101305.jsonl`
  - `rows = 282`
  - `maxCreated = 2026-04-18T00:25:18.556715+00:00`
  - `maxClosed = 2026-04-18T00:37:18.602914+00:00`

판정:
- synced artifact 자체는 current session window를 설명할 만큼 충분히 최신이다

#### B. `vps-trades-latest.jsonl` is stale and must not be used

- `data/vps-trades-latest.jsonl`
  - `rows = 245`
  - `maxCreated = 2026-04-14T11:35:52.035372+00:00`
  - `maxClosed = 2026-04-14T11:35:52.039035+00:00`

판정:
- 현재 `latest` alias 파일은 stale 하다
- Layer 1 truth 분석에서 이 파일을 source-of-truth 로 쓰면 안 된다

#### C. Local `wallet-reconcile` is not bound to the live trading wallet

실행:

```bash
npm run ops:reconcile:wallet -- --days 14
```

결과:

- pubkey source: `WALLET_PRIVATE_KEY derivation`
- wallet: `NEF1wxuAt4DRTW67M8ndtGwdY2uohDtmMxQYNCCJdww`
- on-chain tx signatures: `0`

동시에 로컬 `.env`는 아래 상태였다.

- `WALLET_PUBLIC_KEY`: missing
- `CUPSEY_LANE_ENABLED`: missing
- `STRATEGY_D_LIVE_ENABLED`: missing
- `SANDBOX_WALLET_PRIVATE_KEY`: missing

판정:
- 로컬 `.env`는 현재 VPS live runtime env 와 같지 않다
- 따라서 지금 로컬에서 실행한 `wallet-reconcile` 결과 `0 tx`는
  - "실거래가 없었다"는 뜻이 아니라
  - **로컬 분석 환경이 실제 live wallet 에 연결되지 않았다**는 뜻이다

#### D. Local `ledger-audit` is blocked by local DB schema drift

실행:

```bash
npm run ops:check:ledger -- --hours 336
```

결과:

- 실패: `column "exit_anomaly_reason" does not exist`

판정:
- 로컬 DB schema 가 현재 운영 DB schema 와 다르다
- 즉 `ledger-audit`도 지금 상태에선 live truth 분석기로 바로 쓸 수 없다

#### E. Executed ledgers and fresh VPS trade snapshot are partially aligned

집계:

- `executed-buys.jsonl = 37 rows`
- `executed-sells.jsonl = 24 rows`
- fresh VPS trade snapshot = `282 rows`

교차 검증:

- executed buys ↔ `trades.tx_signature`
  - `37 / 37` match
- executed sells ↔ `trades.tx_signature`
  - `0 / 24` match
- executed sells ↔ `trades.dbTradeId`
  - `24 / 24` match
- executed sells ↔ `trades.entryTxSignature`
  - `24 / 24` match

판정:
- buy side 는 `tx_signature`로 직접 매칭 가능
- sell side 는 `trades.tx_signature`가 아니라
  - `dbTradeId`
  - `entryTxSignature`
  로 이어진다

즉 Layer 1 reconciliation key 는 아래처럼 분리해야 한다.

```text
BUY  = txSignature
SELL = dbTradeId or entryTxSignature
```

### 11.2 First-Pass Verdict

Layer 1의 1차 결론은 아래다.

#### What is trustworthy right now

- `wallet delta` 원칙 자체
- synced `current-session.json`
- fresh VPS snapshot `vps-trades-20260418-101305.jsonl`
- `executed-buys.jsonl`
- `executed-sells.jsonl`

#### What is not trustworthy right now

- `vps-trades-latest.jsonl`
- 로컬 `.env` 기반 `wallet-reconcile`
- 로컬 DB 기반 `ledger-audit`

#### Primary Layer 1 bottleneck

현재 Layer 1의 최상위 병목은:

> **로컬 분석 환경이 실제 live wallet / live DB 와 연결되지 않아 자동 truth 검증 경로가 끊겨 있다**

즉 병목은 단순히 "데이터가 없다"가 아니라:

- wrong wallet binding
- stale latest alias
- local DB schema drift

의 조합이다.

### 11.3 Immediate Actions Before Layer 2

Layer 2 (Lane)로 내려가기 전에 아래를 먼저 닫는 것이 맞다.

1. `wallet-reconcile` 대상 wallet 을 명시적으로 live wallet public key 로 고정
2. `ledger-audit`를 fresh VPS dump 또는 운영 DB schema 와 맞는 환경에서 실행
3. `vps-trades-latest.jsonl` 사용 금지 또는 alias 갱신 로직 수정
4. sell-side reconciliation key 를 `dbTradeId / entryTxSignature` 기준으로 문서화

### 11.4 What This Means For The Next Layer

Layer 2로 내려갈 수는 있다. 다만 아래 단서가 붙는다.

- lane attribution 분석은 **fresh VPS snapshot + executed ledgers** 기준으로만 본다
- 로컬 `wallet-reconcile` 숫자는 아직 lane truth 로 쓰지 않는다
- 즉 Layer 2/3 결론은 **잠정치**로 표시한다

---

## 12. Layer 2 — First-Pass Analysis (2026-04-18)

이번 1차 실분석은 `Lane Map` 레이어를 다룬다.

전제:

- Layer 1이 완전히 닫힌 상태는 아니다
- 따라서 아래 결론은 **fresh VPS snapshot + executed ledgers 기준 잠정치**다

### 12.1 Evidence Collected

#### A. Fresh VPS trade snapshot shows 3 historical lanes, but only one current lane

최신 VPS snapshot `data/vps-trades-20260418-101305.jsonl` 기준:

| strategy | total | closed | open | failed | first created | last created |
|---|---:|---:|---:|---:|---|---|
| `volume_spike` | 117 | 117 | 0 | 0 | 2026-03-25 | 2026-04-04 |
| `bootstrap_10s` | 101 | 96 | 0 | 5 | 2026-04-06 | 2026-04-12 |
| `cupsey_flip_10s` | 64 | 50 | 14 | 0 | 2026-04-11 | 2026-04-18 |

판정:

- historical 전체로 보면 3개 전략 row 가 존재한다
- 하지만 **현재까지 이어지는 lane 은 `cupsey_flip_10s` 하나뿐**이다

#### B. Current session window contains only cupsey rows

`current-session startedAt = 2026-04-17T17:16:08.792Z`

이 시점 이후 fresh VPS snapshot 기준:

- rows = `2`
- breakdown = `cupsey_flip_10s:CLOSED = 2`

즉 current session 기준 최근 실거래 row 는 **전부 cupsey**다.

#### C. Executed ledgers are exclusively cupsey

`executed-buys.jsonl`:

- total = `37`
- strategy breakdown = `cupsey_flip_10s = 37`
- first recorded = `2026-04-16T07:29:03.498Z`
- last recorded = `2026-04-18T00:25:18.555Z`

`executed-sells.jsonl`:

- total = `24`
- strategy breakdown = `cupsey_flip_10s = 24`
- first recorded = `2026-04-16T08:13:41.165Z`
- last recorded = `2026-04-18T00:37:18.602Z`

판정:

- fallback executed ledger 관점에서도 **실제 체결 lane 은 cupsey 하나**다

#### D. Cupsey attribution across artifacts is internally consistent

fresh VPS snapshot ↔ executed ledger 교차 검증:

- buy side:
  - `executed-buys.txSignature` ↔ `trades.tx_signature`
  - `37 / 37` match
- sell side:
  - `executed-sells.txSignature` ↔ `trades.tx_signature`
  - `0 / 24` match
  - 대신
    - `executed-sells.dbTradeId` ↔ `trades.id`
    - `24 / 24` match
    - `executed-sells.entryTxSignature` ↔ `trades.tx_signature`
    - `24 / 24` match

판정:

- cupsey lane 의 artifact chain 은 **내부 정합성 자체는 상당히 좋다**
- 다만 reconciliation key 는 BUY 와 SELL 이 다르다

```text
BUY  = txSignature
SELL = dbTradeId or entryTxSignature
```

#### E. Bootstrap rows are historical, not current

fresh VPS snapshot 기준 `bootstrap_10s` row:

- first created = `2026-04-06T05:44:14Z`
- last created = `2026-04-12T04:13:33Z`
- total = `101` (`96 CLOSED`, `5 FAILED`)

판정:

- bootstrap trade rows 는 현재 session의 live execution lane 이 아니다
- 다만 `STRATEGY.md` 의 signal-only 서술과 충돌하는 historical row 가 남아 있으므로,
  **W1.2 감사 대상**이라는 active plan의 판단은 그대로 유효하다

#### F. Open cupsey rows are not current throughput; they are legacy residue

fresh VPS snapshot 기준 `cupsey_flip_10s:OPEN = 14`

이 OPEN row 들의 범위:

- first created = `2026-04-17T00:11:13Z`
- last created = `2026-04-17T02:53:26Z`
- symbols = `SOYJAK`, `Pnut`, `BOME`
- 3 pair 에 집중

판정:

- 이 14개 OPEN row 는 current session의 신규 lane throughput 이 아니다
- historical duplicate / stuck residue 로 보는 편이 맞다
- 따라서 lane 분석에서 "cupsey 현재 동시 보유가 14개"처럼 읽으면 안 된다

#### G. Wallet ownership of cupsey remains unresolved

코드상 cupsey executor 선택:

```ts
return ctx.sandboxExecutor ?? ctx.executor;
```

또한 `sandboxExecutor`는 현재 초기화 조건이:

- `config.sandboxWalletKey`
- `config.strategyDLiveEnabled`

둘 다 만족할 때뿐이다.

로컬 `.env`에서는:

- `SANDBOX_WALLET_PRIVATE_KEY`: missing
- `STRATEGY_D_LIVE_ENABLED`: missing

판정:

- local analysis environment 기준으론 cupsey가 **main executor fallback**을 탈 가능성이 높다
- 하지만 실제 VPS runtime env 는 별도 확인이 필요하므로
  **cupsey가 main wallet 인지 sandbox wallet 인지 최종 확정할 수는 없다**

### 12.2 First-Pass Verdict

Layer 2의 1차 결론은 아래다.

#### What is strongly supported

- **현재 실거래 primary lane 은 `cupsey_flip_10s`다**
- `bootstrap_10s`는 적어도 current session 기준 실거래 lane 이 아니다
- `volume_spike`는 완전히 historical residue 다
- current artifact 정합성이 가장 좋은 lane 도 cupsey 다

#### What remains unresolved

- cupsey가 실제로 main wallet 을 쓰는지 sandbox wallet 을 쓰는지
- bootstrap historical live rows 가 어떤 운영 상태에서 생성되었는지

#### Primary Layer 2 bottleneck

현재 Layer 2의 최상위 병목은:

> **lane 선택 자체가 아니라, `cupsey primary`의 실제 wallet ownership / attribution 이 아직 닫히지 않은 것**

즉 lane map 은 거의 정리됐지만,
아직 `cupsey primary = main wallet? sandbox wallet?` 이 불명확해
wallet 기준 expectancy 판정이 잠정치로 남는다.

### 12.3 Immediate Actions Before Layer 3

Layer 3 (Funnel)로 내려가기 전에 병행 확인할 것:

1. VPS runtime env 에서 cupsey executor wallet path 확인
2. `bootstrap_10s` historical 16+ live rows 감사 계속 유지
3. `cupsey OPEN 14 rows`는 lane throughput 이 아니라 cleanup / reconciliation 대상으로 분리

### 12.4 What This Means For The Next Layer

Layer 3로는 내려갈 수 있다.

다만 해석 원칙은 아래다.

- funnel 분석의 대상 lane 은 **cupsey 하나**로 좁힌다
- bootstrap funnel 은 current live throughput 병목이 아니라 historical audit 대상으로 둔다
- cupsey funnel 결론은 여전히 **wallet ownership unresolved** 꼬리표를 단다

---

## 13. Layer 3 — First-Pass Analysis (2026-04-18)

이번 1차 실분석은 `Funnel` 레이어를 다룬다.

전제:

- Layer 1 truth closure 는 아직 미완료다
- Layer 2 기준 현재 실거래 lane 은 `cupsey_flip_10s` 하나로 좁혀졌다
- 따라서 아래 결론은 **current session runtime diagnostics + fresh VPS snapshot + executed ledgers 기준 잠정치**다

### 13.1 Evidence Collected

#### A. Current session has signal flow; this is not a raw signal drought

실행:

```bash
npm run ops:check -- --hours 12
npm run ops:check:sparse -- --hours 12
```

결과:

- latest data = `2026-04-18T01:12:50.424Z`
- current session = `2026-04-17T17:16:08.792Z`
- `cupsey funnel: signals=43 gate_pass=15 stalk=15 entry=1 tx_ok=1 db_ok=1 notif_ok=1 closed=2`
- realtime signal scope:
  - `signals in window = 62`
  - `62 gate_rejected`
- current session `signal-intents.jsonl`:
  - `43 rows`
  - strategy = `bootstrap_10s` only
  - token distribution = `pippin 35`, `XChat 4`, `KENJS... 4`

판정:

- current live lane 관점에서 raw signal input 은 존재한다
- 따라서 현재 병목을 `signal drought`로 보면 안 된다
- 다만 `ops:check`의 `62`와 current session `signal-intents`의 `43`은 scope 가 다르다
  - `62` = `realtime-signals.jsonl` 기준 12h signal scope
  - `43` = current session에서 cupsey가 실제로 본 bootstrap signal intents

#### B. Gate is not fully closed, but conversion collapses after STALK

12h cupsey funnel:

```text
signals=43
gate_pass=15
stalk=15
entry=1
tx_ok=1
db_ok=1
notif_ok=1
closed=2
```

전환율:

- `43 -> 15` : gate pass 약 `34.9%`
- `15 -> 15` : gate pass 된 것은 전부 STALK 생성
- `15 -> 1` : STALK -> PROBE entry 약 `6.7%`
- `1 -> 1 -> 1 -> 1` : entry 이후 `tx / DB / notifier`는 current session 기준 전부 성공

판정:

- 현재 cupsey funnel의 최급소는 `STALK -> PROBE entry`
- `gate`는 엄격하지만 완전히 막혀 있지는 않다
- 진짜 병목은 **entry conversion**이지 `tx/db/notifier` failure 가 아니다

#### C. Current session closes include one carried position and one newly entered position

fresh VPS snapshot + current session window 기준:

- current session 이후 trade rows = `2`
- 둘 다 `cupsey_flip_10s:CLOSED`

12h broader window 기준:

- `cupsey_flip_10s:CLOSED = 5`
- 이 중 current session 이전에 진입해서 session 중 닫힌 row 가 포함된다

예:

- `85454970-...`
  - created `2026-04-17T15:25:39Z`
  - closed `2026-04-17T19:13:33Z`
- `ddaf92c9-...`
  - created `2026-04-18T00:25:18Z`
  - closed `2026-04-18T00:37:18Z`

판정:

- `closed=2`는 "session 중 새 entry 2건"을 뜻하지 않는다
- current session funnel 해석은 아래가 정확하다

```text
1) carried position 1건이 session 중 close
2) session 내 new entry 1건이 tx/db/notifier 성공 후 close
```

즉 downstream close path 도 현재 session 기준 작동은 한다.

#### D. Shared funnel pressure remains high outside the cupsey lane

`ops:check:sparse -- --hours 12` 결과:

- `평가 3616회`
- `signals 43건`
- `idleSkip 537243회`
- `candidate turnover: seen=550 evicted=488 idle_evicted=488`
- `admission_skip=234`
- admission skip 사유:
  - `unsupported_dex=182`
  - `no_pairs=52`

추가 freshness 지표:

- `idleSkip delta = -69,461`
- `unique signaled tickers = 3`

판정:

- cupsey lane 내부 병목과 별개로, shared discovery/admission/freshness pressure 는 계속 크다
- 다만 current session의 즉시적인 entry 병목은 `shared funnel`보다도 `STALK -> ENTRY`가 더 직접적이다

#### E. Bootstrap gate rejects are dominated by execution viability, especially on pippin

current session `realtime-signals.jsonl` 직접 집계:

- rows = `41`
- top pair:
  - `pippin = 34`
  - `XChat = 4`
  - `KENJS... = 3`
- top reject reasons:
  - `poor_execution_viability: effectiveRR=2.45 roundTripCost=0.45%` = `20`
  - `poor_execution_viability: effectiveRR=2.44 roundTripCost=0.45%` = `7`
  - `poor_execution_viability: effectiveRR=2.43 roundTripCost=0.46%` = `5`
  - 소수 `security_rejected: Top 10 holders own 93.x%`

판정:

- bootstrap direct path 에선 `poor_execution_viability`가 여전히 상위 차단 사유다
- 하지만 Layer 2에서 확인했듯, current throughput lane 은 bootstrap direct execution 이 아니라 cupsey 다
- 따라서 Layer 3의 주 해석은:
  - `bootstrap gate_rejected` 자체보다
  - **cupsey가 같은 signal pool에서 얼마나 STALK -> ENTRY 전환을 하느냐**로 두는 것이 맞다

### 13.2 First-Pass Verdict

Layer 3의 1차 결론은 아래다.

#### What is strongly supported

- 현재 current session은 `signal drought`가 아니다
- cupsey gate 는 일부 열려 있다 (`43 -> 15`)
- entry 이후 path 는 현재 session 기준 정상 동작한다
  - `entry=1 -> tx_ok=1 -> db_ok=1 -> notif_ok=1`
- `closed=2`는
  - carried position close 1건
  - new entry close 1건
  으로 읽는 것이 맞다

#### Primary Layer 3 bottleneck

현재 Layer 3의 최상위 병목은:

> **`cupsey gate_pass / STALK -> PROBE entry` conversion collapse**

즉 현재 current session 기준 핵심 문제는:

- signal 부족도 아니고
- tx/db/notifier failure 도 아니며
- **STALK created 15건 중 실제 entry가 1건뿐인 것**

이다.

#### Secondary Layer 3 bottleneck

보조 병목은:

> **shared discovery / admission / freshness pressure**

근거:

- `admission_skip=234`
- `idleSkip=537243`
- `seen=550 / evicted=488 / idle_evicted=488`

즉 entry conversion만 풀어도 universe pressure가 남아 있으므로,
Funnel 레이어의 secondary bottleneck 으로 함께 유지해야 한다.

### 13.3 Immediate Actions Before Layer 4

Layer 4 (Strategy / Gate / Exit)로 내려가기 전에 정리할 것:

1. cupsey `STALK -> ENTRY` 미진입 사유를 샘플링
   - price reclaim 실패인지
   - timeout 인지
   - pullback 조건 미충족인지
2. current session과 broader 12h signal scope 를 문서상 계속 구분
   - `62 realtime signals`
   - `43 cupsey-handled signal intents`
3. shared funnel 압박은 lane 병목과 분리해서 유지
   - `freshness/admission`
   - `cupsey entry conversion`

### 13.4 What This Means For The Next Layer

Layer 4로 내려갈 때의 해석 원칙은 아래다.

- 전략 레이어의 1순위 질문은 `gate를 더 풀까?`가 아니다
- 먼저 **왜 STALK 15건이 entry 1건으로 줄었는가**를 해석해야 한다
- 동시에 shared funnel pressure 가 커서, lane 내부 완화만으로는 throughput 이 충분히 늘지 않을 수 있다

즉 Layer 4의 초점은:

1. `cupsey entry conversion rule`
2. `shared freshness/admission pressure`

두 축을 함께 보는 것이다.

---

## 14. Layer 4 — First-Pass Analysis (2026-04-18)

이번 1차 실분석은 `Strategy / Gate / Exit` 레이어를 다룬다.

전제:

- Layer 3 primary bottleneck 은 `STALK -> ENTRY conversion collapse`
- 따라서 Layer 4의 목적은 "어느 규칙이 이 collapse를 만들고, entry 후 어떤 exit 구조가 expectancy를 깎는지"를 코드와 최근 실거래 기준으로 확인하는 것이다

### 14.1 Evidence Collected

#### A. Current cupsey strategy is a two-stage filter: strict pullback entry + loose winner hold

현재 핵심 파라미터:

- `cupseyStalkDropPct = 0.005`
- `cupseyStalkMaxDropPct = 0.015`
- `cupseyStalKWindowSec = 60`
- `cupseyProbeWindowSec = 45`
- `cupseyProbeMfeThreshold = 0.020`
- `cupseyProbeHardCutPct = 0.008`
- `cupseyWinnerTrailingPct = 0.040`
- `cupseyWinnerBreakevenPct = 0.005`
- `cupseyWinnerMaxHoldSec = 720`

근거:

- [tradingParams.ts](../../src/utils/tradingParams.ts)
- [cupseyLaneHandler.ts](../../src/orchestration/cupseyLaneHandler.ts)

판정:

- entry 는 `-0.5% pullback`이 실제로 와야만 한다
- entry 후에는 `+2.0% MFE`만 찍으면 WINNER 로 승격된다
- 그런데 WINNER 보호 장치는 `4.0% trailing`, `+0.5% breakeven`, `12min time stop`으로 상대적으로 느슨하다

즉 전략 구조는:

```text
entry는 꽤 엄격
winner 이후 보호는 꽤 느슨
```

으로 요약된다.

#### B. `STALK -> ENTRY` 저전환은 현재 코드 의도와 일치한다

entry 조건은 `updateCupseyPositions()`의 STALK 상태에서:

- `60s` 안에
- signal price 대비 `-0.5%` 이상 pullback
- 단 `-1.5%` 초과 급락이면 skip

일 때만 실제 매수한다.

근거:

- [cupseyLaneHandler.ts](../../src/orchestration/cupseyLaneHandler.ts)
  - STALK timeout
  - STALK crash skip
  - STALK entry on pullback
- [entry-timing-variants-2026-04-17.md](../../docs/audits/entry-timing-variants-2026-04-17.md)

variant audit 근거:

- `0.001` pullback: entry rate 높지만 avg_exit 음수
- `0.005` pullback: entry rate 낮아지지만 avg_exit 양수 전환

판정:

- Layer 3의 `15 stalk -> 1 entry`는 버그라기보다 **현재 전략이 의도한 throughput sacrifice** 와 맞다
- 다만 이게 현재 시장 레짐에서도 여전히 유효한지는 아직 live wallet 기준으로 재검증되지 않았다

즉 현재 Layer 4에서 이 규칙은:

- "고장"이라기보다
- **의도된 저전환 필터**

다.

#### C. 문서와 실제 전략 파라미터가 어긋나 있다

[STRATEGY.md](../../STRATEGY.md) 는 아직:

- `STALK window = 60s (pullback -0.1% 대기)`

라고 적고 있다.

하지만 실제 코드 기본값은:

- `cupseyStalkDropPct = 0.005` (`-0.5%`)

이다.

또 [entry-timing-variants-2026-04-17.md](../../docs/audits/entry-timing-variants-2026-04-17.md) 는

- `0.001 -> 0.005` 변경이 merge 되었고
- VPS 배포 대기라고 적고 있다

판정:

- 현재 전략 문서는 **entry threshold authority로 바로 쓰면 안 된다**
- Layer 4 분석은 문서보다 코드 기준으로 읽어야 한다

#### D. WINNER state는 승격 직후에도 손실로 되돌릴 수 있다

PROBE → WINNER 조건:

- `mfePct >= +2.0%`

WINNER 보호 조건:

- trailing stop = `peak * (1 - 4%)`
- breakeven stop = `entry + 0.5%`
- 단 breakeven 은 `mfePct > +4.0%`일 때만 활성

근거:

- [cupseyLaneHandler.ts#L729](../../src/orchestration/cupseyLaneHandler.ts#L729)
- [cupseyLaneHandler.ts#L750](../../src/orchestration/cupseyLaneHandler.ts#L750)
- [cupseyLaneHandler.ts#L779](../../src/orchestration/cupseyLaneHandler.ts#L779)

수학적으로:

- WINNER 승격 최소 상태는 peak = `entry * 1.02`
- 이때 trailing stop = `1.02 * 0.96 = 0.9792`
- 즉 **entry 대비 -2.08%까지 되돌림 허용**

판정:

- PROBE hard cut 은 `-0.8%`인데
- WINNER 승격 후에는 오히려 보호가 느슨해져, 승격된 포지션이 손실권으로 되돌아갈 수 있다

즉 현재 WINNER 상태는:

- "winner 보호"
보다
- **"winner를 매우 느슨하게 방치"**

에 더 가깝다.

#### E. 최근 실거래는 `WINNER_TIME_STOP` 지배이며, 최근 12h는 대부분 음수 close다

fresh VPS snapshot 기준 `2026-04-16T00:00:00Z` 이후 `cupsey_flip_10s:CLOSED`:

- total = `23`
- exit reason
  - `WINNER_TIME_STOP = 18`
  - `REJECT_HARD_CUT = 3`
  - `REJECT_TIMEOUT = 2`

최근 12h (`2026-04-17T13:12:50Z` 이후):

- total = `5`
- `WINNER_TIME_STOP = 4`
- `REJECT_TIMEOUT = 1`

최근 12h 상세:

- `WINNER_TIME_STOP` 4건 중 `3건` 손실
- `REJECT_TIMEOUT` 1건은 거의 flat

판정:

- 현재 exit 구조의 실질적 종료 엔진은 trailing/breakeven 이 아니라 **time stop**
- 특히 최근 12h는 `WINNER_TIME_STOP`이 수익 실현보다 **늦은 손절**처럼 작동한 흔적이 강하다

즉 최근 실거래는:

```text
quick reject는 일부 작동
winner hold는 실제로는 time-boxed drift holding으로 변질
```

로 읽는 것이 더 정확하다.

#### F. Gate score는 현재 해석용 지표로는 다소 오염돼 있다

현재 `cupseyGate` 기본값은:

- `cupseyGateMinPriceChangePct = 0`

그런데 score 계산은:

- `priceScore = min(priceChangePct / minPriceChangePct, 2) * WEIGHT_PRICE`

로 되어 있다.

근거:

- [cupseySignalGate.ts#L116](../../src/strategy/cupseySignalGate.ts#L116)

판정:

- `minPriceChangePct = 0`이면 score 상의 price factor는 포화되기 쉽다
- pass/fail threshold 자체는 지금 의도대로 동작하더라도,
- gate score/log 해석은 실제보다 낙관적으로 보일 수 있다

즉 이것은 전략 엔진의 직접 병목이라기보다:

- **Layer 4 measurement distortion**

에 가깝다.

### 14.2 First-Pass Verdict

Layer 4의 1차 결론은 아래다.

#### Primary Layer 4 bottleneck

현재 Strategy 레이어의 최상위 병목은:

> **STALK entry rule 이 의도적으로 throughput 을 강하게 줄이고 있는데, 그 희생이 현재 live 레짐에서도 아직 증명되지 않았다**

즉 `15 stalk -> 1 entry`는 현재 규칙의 자연스러운 결과다.

핵심 규칙:

- `-0.5% pullback required`
- `60s window`
- `-1.5% crash skip`

이 조합이 현재 throughput 을 강하게 억제한다.

#### Secondary Layer 4 bottleneck

보조 병목은:

> **WINNER 승격 후 보호가 너무 느슨해서, WINNER가 time-stop 손실로 되돌아간다**

근거:

- WINNER 승격 = `+2%`
- trailing = `4%`
- breakeven 활성 = `> +4%`
- 최근 close `18/23 = WINNER_TIME_STOP`
- 최근 12h `WINNER_TIME_STOP 4건 중 3건 손실`

즉 현재 전략은:

- entry 는 매우 까다롭게 고르고
- 일단 WINNER가 되면 보호 없이 오래 들고 있다가
- `12min time stop`에서 닫히는 경향이 강하다

#### Tertiary Layer 4 issue

추가 이슈는:

> **전략 문서와 실제 코드 파라미터가 어긋나 있고, gate score도 현재 설정에서 해석력이 떨어진다**

이건 바로 손익 병목은 아니지만,
전략 해석과 후속 튜닝 정확도를 낮춘다.

### 14.3 Immediate Actions Before Layer 5

Layer 5 (Infra / Tooling)로 내려가기 전에 전략 측면에서 고정해야 할 질문:

1. `STALK 15 -> ENTRY 1`이 현재 시장에서 너무 보수적인지
   - 또는 audit이 말한 양의 기대값 유지에 필요한 희생인지
2. WINNER 보호를 아래 중 어느 방식으로 바꿀지
   - trailing 축소
   - breakeven activation 완화
   - WINNER 진입 직후 minimum protected stop 추가
3. `WINNER_TIME_STOP`이 실제 runner hold인지, 늦은 손절인지
   - recent wallet 기준으로 재검증

### 14.4 What This Means For The Next Layer

Layer 5로 내려갈 때의 해석 원칙은 아래다.

- 이제 남은 문제를 전부 전략 탓으로 돌리면 안 된다
- Layer 4는 이미
  - entry throughput 억제
  - winner 보호 부족
  를 보여줬다
- 하지만 wallet ownership / reconcile closure 가 안 닫혀 있으므로,
  이 전략 병목도 아직 **wallet-verified verdict**는 아니다

즉 Layer 5의 초점은:

1. 전략 결론을 신뢰할 수 있을 만큼 운영 truth 가 닫혀 있는가
2. strategy / wallet / executor / ledger 가 같은 현실을 말하는가

두 질문이다.

---

## 15. Layer 5 — First-Pass Analysis (2026-04-18)

이번 1차 실분석은 `Infra / Tooling` 레이어를 다룬다.

전제:

- Layer 1에서 source-of-truth closure 미완료가 이미 확인됐다
- Layer 2에서 `cupsey primary`의 wallet ownership 이 unresolved 로 남았다
- 따라서 Layer 5는 "도구가 있는가"보다 **그 도구가 현재 현실을 제대로 가리키는가**를 본다

### 15.1 Evidence Collected

#### A. Cupsey wallet ownership is structurally ambiguous in code

executor 초기화:

- main executor: 항상 생성
- sandbox executor: `sandboxWalletKey && strategyDLiveEnabled` 일 때만 생성

관련 코드:

- [config.ts](../../src/utils/config.ts)
  - `sandboxWalletKey`
  - `strategyDLiveEnabled`
  - `cupseyLaneEnabled`
- [index.ts](../../src/index.ts)
  - `if (config.sandboxWalletKey && config.strategyDLiveEnabled) { sandboxExecutor = ... }`
- [cupseyLaneHandler.ts](../../src/orchestration/cupseyLaneHandler.ts)
  - `ctx.sandboxExecutor ?? ctx.executor`

판정:

- `CUPSEY_LANE_ENABLED=true` 만으로는 sandbox executor 가 보장되지 않는다
- 현재 구조에선 **cupsey lane 이 strategyD sandbox wiring 을 간접 재사용**하고 있다
- 따라서 VPS env 에서 `STRATEGY_D_LIVE_ENABLED`가 꺼져 있으면, cupsey는 main executor 로 fallback 할 수 있다

즉 Layer 5의 가장 큰 infra bottleneck 은:

> **cupsey primary lane 의 wallet ownership 이 코드 구조상 명시적으로 닫혀 있지 않다**

#### B. `wallet-reconcile` 도구 자체보다 env binding 이 문제다

[wallet-reconcile.ts](../../scripts/wallet-reconcile.ts) 는:

- `WALLET_PUBLIC_KEY` 우선
- 없으면 `WALLET_PRIVATE_KEY` derivation fallback

을 쓴다.

판정:

- 도구 설계 자체는 합리적이다
- 하지만 현재 로컬 `.env`에는 `WALLET_PUBLIC_KEY`가 없고,
- `WALLET_PRIVATE_KEY`도 실제 live runtime 과 다르므로
- 로컬 실행 결과는 `0 tx`가 나와도 아무 의미가 없다

즉 bottleneck 은:

- tool 부재가 아니라
- **tool binding 부재**

다.

#### C. `ledger-audit` 실패는 스크립트 결함보다 local DB schema drift 문제다

[ledger-audit.ts](../../scripts/ledger-audit.ts) 는 `exit_anomaly_reason` 등 최신 컬럼을 기대한다.

관련 코드:

- [ledger-audit.ts](../../scripts/ledger-audit.ts)
- [tradeStore.ts](../../src/candle/tradeStore.ts)
  - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS exit_anomaly_reason`

판정:

- 코드베이스 기준으론 migration path 가 이미 있다
- local DB 가 이 컬럼을 모른다는 것은
  - local DB 가 최신 initialize/migration 을 못 탔거나
  - local analysis DB 가 운영 DB 와 다른 상태라는 뜻이다

즉 bottleneck 은:

- audit script 부재가 아니라
- **analysis DB schema drift**

다.

#### D. `sync-vps-data.sh`는 하드닝됐지만, truth alias 운영은 아직 취약하다

[sync-vps-data.sh](../../scripts/sync-vps-data.sh) 현재 상태:

- pm2 app 이름으로 `DATABASE_URL` resolve 가능
- stale DB dump 감지
- dump `max_created` 교차 검증
- 마지막에 `vps-trades-latest.jsonl` 갱신

판정:

- 스크립트 설계는 이전보다 훨씬 좋아졌다
- 그런데 실제 로컬엔 stale `vps-trades-latest.jsonl`가 남아 있었다
- 즉 현재 병목은 "스크립트 기능 부족"보다는
  - rerun 누락
  - old artifact 오독
  - alias freshness 검증 미관행

같은 **운영 workflow drift**에 가깝다

#### E. Executed ledger reconciliation key 가 BUY/SELL 에서 다르다

현재 artifact chain:

```text
BUY  = txSignature
SELL = dbTradeId or entryTxSignature
```

관련 관찰:

- `executed-buys.txSignature` ↔ `trades.tx_signature` = 직접 매칭
- `executed-sells.txSignature` ↔ `trades.tx_signature` = 직접 매칭 안 됨
- sell 은 `dbTradeId` 또는 `entryTxSignature`로 이어짐

판정:

- 이건 현재 설계상 허용된 체인이다
- 하지만 generic reconcilers 나 사람 눈으로는 매우 쉽게 오해된다

즉 bottleneck 은:

- 데이터가 없어서가 아니라
- **artifact key semantics 가 BUY/SELL 비대칭**이라는 점이다

#### F. Runtime에는 자동 wallet comparator 가 아직 없다

현재 확인된 것은:

- `wallet-reconcile.ts`
- `ledger-audit.ts`
- `trade-report.ts`
- `sync-vps-data.sh`

즉 사후 분석 도구는 있다.

하지만 runtime 에서:

- wallet delta drift 를 자동 탐지하고
- 일정 threshold 이상이면 알림/차단하는

항상 켜진 comparator 는 없다.

판정:

- 현재 tooling 은 **수동 분석에는 강하고**
- **상시 truth closure 에는 약하다**

### 15.2 First-Pass Verdict

Layer 5의 1차 결론은 아래다.

#### Primary Layer 5 bottleneck

현재 Infra 레이어의 최상위 병목은:

> **cupsey primary lane 의 executor / wallet ownership 이 구조적으로 명시되지 않아, lane 성과를 어느 wallet 기준으로 봐야 하는지 흔들린다**

즉 Layer 2의 unresolved ownership 문제는 운영 미확인 수준이 아니라,
현재 코드 wiring 자체가 ambiguity 를 허용한다.

#### Secondary Layer 5 bottleneck

보조 병목은:

> **analysis toolchain 이 local env / local DB 에 너무 강하게 묶여 있어, 운영 truth 와 쉽게 분리된다**

근거:

- `wallet-reconcile` = local env binding 없으면 무의미
- `ledger-audit` = local DB schema drift 시 실패
- stale `vps-trades-latest.jsonl` 오독 가능

즉 지금 도구들은 있어도, **항상 live truth 를 가리키는 구조는 아니다**

#### Tertiary Layer 5 issue

추가 이슈는:

> **artifact semantics 와 runtime truth closure 가 아직 operator-friendly 하지 않다**

예:

- BUY/SELL reconciliation key 불일치
- no always-on wallet comparator
- stale alias 오독 가능

### 15.3 Immediate Actions After Layer 5

Top-Down 분석 이후 바로 이어져야 할 infra 질문:

1. cupsey executor ownership 을 명시적으로 분리할 것인가
   - `cupsey sandbox wallet`
   - `cupsey main wallet`
   둘 중 하나를 코드/문서/운영값으로 고정
2. `wallet-reconcile`를 live wallet public key 에 고정하는 운영 경로를 만들 것인가
3. local DB 기반 audit 대신
   - fresh VPS dump
   - 또는 remote DB schema-consistent audit
   중 하나로 표준화할 것인가
4. runtime wallet comparator 를 상시 도입할 것인가

### 15.4 What This Means For The Overall Mission

Layer 5까지 내려온 현재의 종합 해석은 이렇다.

- Mission 레벨에선 `wallet delta`가 유일한 truth 다
- 하지만 Layer 5 기준 지금 infrastructure 는
  - 그 truth 를 상시 가리키지 못하고
  - cupsey primary 의 ownership 도 구조적으로 모호하다

따라서 현재 사명 달성의 직접 저해 요인은 단순히 전략 품질만이 아니다.

> **전략을 측정하는 인프라가 아직 "이 전략이 어느 wallet에서 얼마를 벌었는가"를 단단히 고정하지 못한다**

즉 지금 단계에서의 최상위 mission blocker 는:

1. `cupsey primary` wallet ownership ambiguity
2. local analysis env / DB drift
3. no always-on wallet delta comparator

의 조합이다.
