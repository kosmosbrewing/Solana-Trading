# HARNESS_REFACTORING.md — Solana Momentum Bot 하네스 리팩토링 계획

> **기준:** harness.md (shakilabs 에이전트 하네스 운영 가이드)
> **대상:** solana-momentum-bot/ (~50 파일, ~7K LOC, Phase 0–4 완료)
> **작성일:** 2026-03-18
> **최종 수정:** 2026-03-18 (v2 — 품질 점검 결과 반영)
> **목표:** 에이전트 품질 상한선을 레포 환경(구조, 문서, 린터, 피드백 루프)으로 끌어올린다.

---

## 0. 현황 진단 — 하네스 기준 갭 분석

### 현재 보유 자산
- 16개 모듈, 명확한 관심사 분리 (gate/, risk/, event/, strategy/, executor/ 등)
- 17 test suites, 67 tests 통과 (단, 6개 모듈 미테스트)
- 운영 문서: 루트 .md 10개 (README, PROJECT, STRATEGY, SETUP, PLAN, ISSUES, ISSUES2, ISSUES_CMPL, OPERATIONS, REFACTORING)
- pm2 + deploy.sh 배포 파이프라인
- 구조화된 Winston 로깅
- ESLint flat config 존재 (`eslint.config.js`)

### 현재 코드 건강도

**300줄 초과 파일 13개 (분리 필요):**

| 파일 | 줄 수 | 분리 난이도 |
|---|---|---|
| `backtest/engine.ts` | **1082** | 높음 — 전략 라우팅, 결과 집계, 루프 분리 |
| `index.ts` (루트) | **532** | 중간 — bootstrap 모듈 분리 |
| `strategy/fibPullback.ts` | **409** | 중간 — indicator 계산부 분리 |
| `orchestration/tradeExecution.ts` | **404** | 중간 — 모니터링/청산 분리 |
| `scanner/scannerEngine.ts` | **398** | 중간 — Lane별 분리 |
| `reporting/edgeTracker.ts` | **398** | 중간 — demotion/state 분리 |
| `risk/riskManager.ts` | **394** | 중간 — 검증 로직 분리 |
| `ingester/birdeyeClient.ts` | **361** | 낮음 — 엔드포인트별 분리 |
| `strategy/newLpSniper.ts` | **349** | 중간 |
| `strategy/momentumCascade.ts` | **344** | 중간 |
| `ingester/birdeyeWSClient.ts` | **339** | 낮음 |
| `scanner/socialMentionTracker.ts` | **336** | 낮음 |
| `executor/jitoClient.ts` | **330** | 낮음 |

**기타 위반 사항:**
- `console.log` 직접 사용: 46건 (전부 `src/backtest/reporter.ts`, CLI 출력용)
- `process.env` 직접 접근 (config.ts 외부): 3건
  - `src/index.ts:276` → `process.env.TARGET_PAIR_ADDRESS`
  - `src/gate/executionViability.ts:7` → `process.env.DEFAULT_AMM_FEE_PCT`
  - `src/gate/executionViability.ts:8` → `process.env.DEFAULT_MEV_MARGIN_PCT`
- ESLint `no-console: 'off'` — 전역 허용 상태

**테스트 미보유 모듈 6개:**

| 미테스트 모듈 | 위험도 | 비고 |
|---|---|---|
| **orchestration/** | 🔴 높음 | 핵심 흐름 (tradeExecution, signalProcessor) |
| **ingester/** | 🟡 중간 | 외부 API (mock 필요) |
| **candle/** | 🟡 중간 | DB 연동 (integration test) |
| **notifier/** | 🟢 낮음 | Telegram 발송 |
| **audit/** | 🟢 낮음 | 로깅 전용 |
| **utils/** | 🟢 낮음 | config 파싱 |

### 하네스 기준 부재 항목

| 하네스 원칙 | 현재 상태 | 갭 |
|---|---|---|
| §1 AGENTS.md (100줄 목차) | ❌ 없음 | 에이전트 entry point 부재 |
| §1 ARCHITECTURE.md | ❌ 없음 | 레이어 맵 암묵적 |
| §1 docs/ Knowledge Base | ❌ 없음 | 루트 .md 10개 산재, docs/ 디렉토리 미존재 |
| §2 Progressive Disclosure | ❌ 없음 | 에이전트가 전체 문서를 한번에 읽어야 함 |
| §3 기계적 경계 강제 | ⚠️ 부분 | ESLint config 존재(`eslint.config.js`), import 방향 규칙만 미설정 |
| §4 앱 가독성 | ⚠️ 부분 | HealthMonitor 클래스 존재, HTTP endpoint 미노출 |
| §5 지루한 기술 | ✅ 충족 | solana/web3.js, pg, winston, axios |
| §6 엔트로피 관리 | ⚠️ 부분 | 300줄 초과 13개 파일, console.log 46건, process.env 3건 |
| §7 머지 철학 | ❌ 없음 | PR 규칙, CI 통과=머지 정책 미문서화 |
| §8 피드백 루프 | ❌ 없음 | 에이전트 실패 → 레포 보강 루프 미정립 |
| §9 보안 체크리스트 | ⚠️ 부분 | .env 사용 중이나 SECURITY.md 없음 |
| CI/CD 파이프라인 | ❌ 없음 | GitHub Actions 미설정 |
| ADR | ❌ 없음 | 기술 결정 이력 미기록 |
| docs/references/*-llms.txt | ❌ 없음 | 에이전트용 API 레퍼런스 없음 |

---

## 1. 적응 전략 — 웹 서비스 → 트레이딩 봇

harness.md는 Vue.js/Express 웹 서비스 스택 기준이다. Solana 트레이딩 봇에 맞게 다음을 조정한다.

### 레이어 규칙 재정의

```
웹 서비스 (harness.md 원본):
  Types → Config → DB → Services → Routes → Middleware

트레이딩 봇 (적응):
  Types/Config → Candle/State(DB) → Event/Ingester → Strategy → Gate → Risk → Executor → Orchestration
                                                                                              ↓
                                                                                    Scanner/Universe (독립)
                                                                                    Reporting (독립)
                                                                                    Notifier (독립)
```

**의존성 방향 (단방향만 허용):**
```
utils/ (config, logger, types)     ← 모든 모듈이 참조 가능
candle/, state/                    ← 데이터 레이어
event/, ingester/                  ← 외부 데이터 수집
strategy/                          ← 시그널 생성 (candle, event 참조)
gate/                              ← 시그널 필터링 (strategy, event 참조)
risk/                              ← 포지션 사이징 (state, reporting 참조)
executor/                          ← 주문 실행 (solana, jupiter 참조)
orchestration/                     ← 최상위 조율 (모든 모듈 참조 가능)

독립 모듈 (orchestration에서만 호출):
scanner/, universe/                ← 후보 탐색 (event, ingester 참조 가능)
reporting/                         ← 성과 집계 (state, candle 참조 가능)
notifier/                          ← 알림 (의존성 없음, utils만)
audit/                             ← 감사 로그 (의존성 없음, utils만)
backtest/                          ← 백테스트 (strategy, gate, risk 참조 가능, 런타임과 격리)

금지:
- executor/에서 strategy/ import
- strategy/에서 executor/ import
- candle/에서 gate/ import
- risk/에서 orchestration/ import
- utils/에서 다른 모듈 import

주의: gate/와 risk/ 사이 — sizingGate.ts가 risk 관련 로직을 포함하고 있어
      gate→risk 참조가 존재할 수 있음. P0-2에서 실제 import를 검증 후 방향 확정.
```

### 보안 컨텍스트 재정의

| harness.md (웹 서비스) | 트레이딩 봇 대응 |
|---|---|
| Zod 입력 검증 | config.ts 환경변수 검증 (존재하나 3건 누출) |
| JWT + httpOnly Cookie | 해당 없음 (CLI 봇) |
| CORS 설정 | 해당 없음 |
| SQL Injection 방지 | pg parameterized query (이미 적용) |
| Rate Limiting | API 호출 rate limit (Birdeye, Jupiter) |
| .env 민감 데이터 | WALLET_PRIVATE_KEY, API keys 보호 |
| OWASP Top 10 | 지갑 키 노출 방지, RPC endpoint 보안 |

### 네이밍 컨벤션 적응

웹 서비스 네이밍 (`*.schema.ts`, `*.service.ts`, `*.route.ts`)은 트레이딩 봇에 부적합.
현재 모듈별 파일명이 이미 역할을 명확히 표현하므로 기존 패턴을 공식화:

| 모듈 | 네이밍 패턴 | 예시 |
|---|---|---|
| strategy/ | `{strategyName}.ts` | `volumeSpikeBreakout.ts` |
| gate/ | `{gateName}Gate.ts` | `safetyGate.ts`, `scoreGate.ts` |
| risk/ | `{concern}.ts` | `drawdownGuard.ts`, `riskTier.ts` |
| ingester/ | `{source}Client.ts` | `birdeyeClient.ts` |
| test/ | `{module}.test.ts` | `riskManager.test.ts` |

---

## 2. 실행 계획 — 4단계 (P0 / P1a / P1b / P2)

### P0 — Knowledge Base 초기 구축 (1–2일)

에이전트가 레포만으로 프로젝트를 완전히 이해할 수 있는 상태를 만든다.

#### P0-1. AGENTS.md 생성 (100줄 이내 목차)

```
solana-momentum-bot/AGENTS.md
```

**포함 내용:**
- 프로젝트 한 줄 설명 (Event-aware Solana DEX trading bot)
- 스택: TypeScript, @solana/web3.js, Jupiter v6, TimescaleDB, Winston
- 모듈 맵 → ARCHITECTURE.md 참조
- docs/ 하위 문서 테이블 (경로 + 설명)
- 에이전트 작업 규칙 (7개 이내)

**에이전트 작업 규칙 (초안):**
1. 새 파일 생성 전 ARCHITECTURE.md의 의존성 방향을 확인하라.
2. 외부 API 호출은 반드시 해당 Client 모듈을 경유하라 (직접 axios 금지).
3. 환경변수는 반드시 `src/utils/config.ts`에서 정의·참조하라 (`process.env` 직접 접근 금지).
4. 파일당 200줄 이내를 지향하라. 300줄 초과 시 CI 실패.
5. 변수명·함수명·에러 메시지는 영어, 주석은 한국어.
6. 새 전략 추가 시 docs/design-docs/에 설계 문서를 먼저 작성하라.
7. risk/ 또는 gate/ 로직 변경 시 관련 테스트를 반드시 업데이트하라.

#### P0-2. ARCHITECTURE.md 생성

```
solana-momentum-bot/ARCHITECTURE.md
```

**포함 내용:**
- 2-Stage Entry Model 다이어그램 (Context → Trigger)
- 모듈별 책임 맵 (16개 모듈, 한 줄 설명)
- 의존성 방향 규칙 (위 §1에서 정의한 단방향 흐름)
- 데이터 흐름: Birdeye/DexScreener → Ingester → CandleStore → Strategy → Gate → Executor
- BotContext 구조 설명
- **gate/ ↔ risk/ 실제 import 검증 결과 반영** (sizingGate→risk 방향 확정)

#### P0-3. docs/ 디렉토리 구조 생성

```
solana-momentum-bot/docs/
├── design-docs/
│   ├── index.md                    # 설계 문서 카탈로그 + 검증 상태
│   ├── core-beliefs.md             # "설명 불가 펌프를 쫓지 않는다" 원칙
│   │                               # + 에이전트 피드백 루프 절차 (§8 적용)
│   ├── layer-rules.md              # 모듈 의존성 방향 규칙 상세
│   ├── 2-stage-entry.md            # Context → Trigger 모델 설계
│   └── risk-tier-system.md         # Bootstrap→Calibration→Confirmed→Proven
│
├── exec-plans/
│   ├── active/                     # 현재 진행 중인 계획
│   │   └── vps-deployment.md       # SOL-39 VPS 인프라 셋업
│   ├── completed/                  # 완료된 계획
│   │   ├── phase-0-4-refactor.md   # Phase 0–4 리팩토링 (REFACTORING.md 이전)
│   │   └── risk-tier-impl.md       # SOL-31 Risk Tier 구현
│   └── tech-debt-tracker.md        # 기술 부채 목록 + 우선순위
│
├── product-specs/
│   ├── index.md                    # 명세 카탈로그
│   ├── strategy-catalog.md         # A/C/D/E 전략 명세 (STRATEGY.md 이전)
│   └── paper-validation.md         # 50-trade 검증 기준
│
├── generated/
│   └── db-schema.md                # TimescaleDB 테이블 자동 생성
│
├── references/
│   ├── solana-web3-llms.txt        # @solana/web3.js 핵심 패턴
│   ├── jupiter-api-llms.txt        # Jupiter v6 Quote/Swap API
│   └── birdeye-api-llms.txt        # Birdeye REST + WS API
│
├── decisions/
│   ├── 001-timescaledb.md          # TimescaleDB 선택 이유
│   ├── 002-jupiter-over-raydium.md # Jupiter 라우터 선택
│   ├── 003-event-first-model.md    # Event-aware 2-stage 진입 모델
│   └── 004-risk-tier-progression.md # 단계적 리스크 확대 모델
│
├── CONVENTIONS.md                  # 네이밍, 파일 구조, 코딩 스타일
│                                   # + PR 규칙, 머지 철학 (§7 적용)
├── SECURITY.md                     # 지갑 키 관리, API 키 보호, RPC 보안
├── QUALITY_SCORE.md                # 모듈별 품질 등급 (A~F)
└── RELIABILITY.md                  # 헬스체크, 로깅, 에러 핸들링, 크래시 복구
```

#### P0-4. 기존 루트 문서 정리

현재 루트에 산재한 .md 10개를 docs/로 이전하거나 통합:

| 현재 파일 | 처리 방안 |
|---|---|
| `README.md` | **유지** — Quick start |
| `PROJECT.md` | **유지** — 프로젝트 최상위 개요 (AGENTS.md에서 참조) |
| `OPERATIONS.md` | **유지** — 운영 가이드 (AGENTS.md에서 참조) |
| `SETUP.md` | **유지** — 개발 셋업 (AGENTS.md에서 참조) |
| `REFACTORING.md` | `docs/exec-plans/completed/phase-0-4-refactor.md`로 이전 |
| `STRATEGY.md` | `docs/product-specs/strategy-catalog.md`로 이전 |
| `ISSUES.md` | `docs/exec-plans/tech-debt-tracker.md`에 통합 |
| `ISSUES2.md` | tech-debt-tracker.md에 통합 후 삭제 |
| `ISSUES_CMPL.md` | `docs/exec-plans/completed/issues-archive.md`로 이전 |
| `PLAN.md` | `docs/exec-plans/active/`에 해당 내용 이전 후 삭제 |

**P0 완료 후 루트 .md:** README, PROJECT, OPERATIONS, SETUP, AGENTS, ARCHITECTURE = **6개**

---

### P1a — 기계적 강제 + CI (3–5일)

코드로 규칙을 강제해서 에이전트가 패턴을 이탈하지 못하게 한다.

#### P1a-1. ESLint 규칙 보강 (기존 `eslint.config.js` flat config에 추가)

```javascript
// eslint.config.js — 추가할 규칙
{
  files: ['src/**/*.ts'],
  rules: {
    // import 방향 강제
    'no-restricted-imports': ['error', {
      patterns: [
        {
          group: ['../orchestration/*', '../../orchestration/*'],
          message: 'orchestration/은 최상위 조율 레이어입니다. 하위 모듈에서 import 금지.'
        },
        {
          group: ['../executor/*', '../../executor/*'],
          message: 'executor/는 orchestration/을 통해서만 호출하세요.'
        }
      ]
    }],
    // console.log 제한 (reporter.ts만 eslint-disable로 예외)
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
},
```

#### P1a-2. process.env 중앙화 (3건 수정)

config.ts에 아래 환경변수를 추가하고, 직접 접근을 제거:
- `src/index.ts:276` → `config.targetPairAddress` 로 교체
- `src/gate/executionViability.ts:7-8` → `config.defaultAmmFeePct`, `config.defaultMevMarginPct` 로 교체

#### P1a-3. scripts/check-structure.sh 작성

검증 항목:
- 파일 크기: 200줄 초과 경고, 300줄 초과 실패
- `process.env.` 직접 접근 탐지 (config.ts, logger.ts 제외)
- 미사용 import 검사

#### P1a-4. scripts/check-docs-freshness.sh 작성

검증 항목:
- AGENTS.md 존재 + 100줄 이내
- ARCHITECTURE.md 존재
- docs/design-docs/index.md 존재
- AGENTS.md 내 경로 참조가 실제 파일과 일치
- docs/exec-plans/active/ 비어있지 않은지 확인

#### P1a-5. CI 구조적 검증 (GitHub Actions)

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npx eslint src/
      - run: bash scripts/check-structure.sh
      - run: bash scripts/check-docs-freshness.sh
```

#### P1a-6. docs/QUALITY_SCORE.md 첫 등급 산정

전 16개 모듈 품질 평가 (A~F):

| 모듈 | 테스트 | 문서 | 네이밍 | 크기 (최대 줄) | 예상 등급 |
|---|---|---|---|---|---|
| **backtest/** | ✅ 2 suites | ❌ | ✅ | ❌ 1082줄 | **D** |
| gate/ | ✅ 2 suites | ❌ | ✅ | ⚠️ 243줄 | B- |
| risk/ | ✅ 3 suites | ❌ | ✅ | ❌ 394줄 | C+ |
| strategy/ | ✅ 2 suites | ⚠️ | ✅ | ❌ 409줄 | C+ |
| event/ | ✅ 2 suites | ❌ | ✅ | ⚠️ 226줄 | B |
| executor/ | ⚠️ 1 suite | ❌ | ✅ | ❌ 330줄 | C |
| orchestration/ | ❌ 0 suite | ❌ | ✅ | ❌ 404줄 | **D** |
| scanner/ | ✅ 2 suites | ❌ | ✅ | ❌ 398줄 | C+ |
| ingester/ | ❌ 0 suite | ❌ | ✅ | ❌ 361줄 | C- |
| reporting/ | ✅ 3 suites | ❌ | ✅ | ❌ 398줄 | C+ |
| candle/ | ❌ 0 suite | ❌ | ✅ | ⚠️ 205줄 | C |
| state/ | ⚠️ 간접 | ❌ | ✅ | ✅ | C+ |
| universe/ | ✅ 1 suite | ❌ | ✅ | ⚠️ 202줄 | B- |
| notifier/ | ❌ 0 suite | ❌ | ✅ | ⚠️ 268줄 | C- |
| audit/ | ❌ 0 suite | ❌ | ✅ | ✅ | C |
| utils/ | ❌ 0 suite | ❌ | ✅ | ⚠️ 272줄 | C |

**전체 평균:** C+ (목표: 전 모듈 B 이상)
**핵심 갭:** 문서 전 모듈 ❌, 파일 크기 13개 모듈 초과, 테스트 6개 모듈 부재

#### P1a-7. docs/references/ LLM 레퍼런스 작성

우선순위:
1. `jupiter-api-llms.txt` — Quote/Swap API 핵심 패턴 (에이전트가 가장 자주 틀리는 부분)
2. `birdeye-api-llms.txt` — REST + WS 엔드포인트, 인증, rate limit
3. `solana-web3-llms.txt` — Transaction 빌딩, 서명, 전송 패턴

---

### P1b — 파일 분리 + 테스트 보강 (1–2주)

P1a와 병행 또는 직후 실행. SOL-39 VPS 배포와 병행 가능.

#### P1b-1. 300줄 초과 파일 분리 (13개)

**Tier 1 — 최우선 (500줄 이상, 즉시 분리):**

| 파일 | 줄 수 | 분리 계획 |
|---|---|---|
| `backtest/engine.ts` | 1082 | → `engine.ts` (루프) + `strategyRouter.ts` (전략 라우팅) + `resultAggregator.ts` (결과 집계) |
| `index.ts` | 532 | → `index.ts` (진입점) + `bootstrap.ts` (모듈 초기화) + `lifecycle.ts` (시그널 핸들러, 셧다운) |

**Tier 2 — 고우선 (350줄 이상):**

| 파일 | 줄 수 | 분리 계획 |
|---|---|---|
| `strategy/fibPullback.ts` | 409 | → indicator 계산부를 `fibIndicators.ts`로 분리 |
| `orchestration/tradeExecution.ts` | 404 | → 포지션 모니터링을 `positionMonitor.ts`로 분리 |
| `scanner/scannerEngine.ts` | 398 | → Lane A/B 로직을 별도 파일로 |
| `reporting/edgeTracker.ts` | 398 | → demotion 로직을 `edgeDemotion.ts`로 분리 |
| `risk/riskManager.ts` | 394 | → 검증 로직을 `riskValidation.ts`로 분리 |
| `ingester/birdeyeClient.ts` | 361 | → 엔드포인트별 분리 (OHLCV, trending, security) |

**Tier 3 — 일반 (300–350줄):**

| 파일 | 줄 수 | 분리 계획 |
|---|---|---|
| `strategy/newLpSniper.ts` | 349 | 200줄 목표 축소 검토 |
| `strategy/momentumCascade.ts` | 344 | 200줄 목표 축소 검토 |
| `ingester/birdeyeWSClient.ts` | 339 | 이벤트 핸들러 분리 |
| `scanner/socialMentionTracker.ts` | 336 | 파싱 로직 분리 |
| `executor/jitoClient.ts` | 330 | 번들 빌딩 로직 분리 |

#### P1b-2. 크리티컬 패스 테스트 추가

최소한 orchestration/ 테스트를 이 단계에서 작성:

| 대상 | 테스트 범위 | 우선순위 |
|---|---|---|
| `orchestration/signalProcessor.ts` | gate 통과/거부 시나리오 | 🔴 필수 |
| `orchestration/tradeExecution.ts` | 포지션 오픈/클로즈 흐름 | 🔴 필수 |
| `orchestration/candleHandler.ts` | 캔들 수신 → 전략 호출 | 🟡 권장 |
| `ingester/birdeyeClient.ts` | API 응답 파싱 (mock) | 🟡 권장 |

#### P1b-3. console.log 정리

- `src/backtest/reporter.ts`: 46건 → eslint-disable 주석 추가 (CLI 출력이므로 허용)
- ESLint `no-console: 'warn'` 활성화로 신규 console.log 방지

---

### P2 — 자동화 + 관측성 (다음 분기)

> SOL-39 (VPS 배포) + SOL-27 (Paper 50-trade 검증) 완료 후 시작

#### P2-1. docs/generated/db-schema.md 자동 생성
- TimescaleDB 테이블 스키마 → markdown 변환 스크립트
- CI에서 빌드 시 자동 업데이트

#### P2-2. 주간 정리 GitHub Actions
- 주 1회 (월요일) 자동 실행
- 파일 크기, console.log, 미사용 import 스캔
- 결과를 이슈로 자동 생성

#### P2-3. 에이전트 관측성
- pm2 로그 → JSON 파싱 가능 상태 확인
- HealthMonitor를 HTTP endpoint로 노출 (에이전트가 curl로 확인 가능)
- 거래 성과 대시보드 (Telegram daily summary 강화)

#### P2-4. 프로젝트 간 하네스 템플릿화
- 이 봇에서 검증된 구조를 다른 프로젝트에 재사용
- AGENTS.md 템플릿, CI 스크립트, docs/ 구조를 패키지화

---

## 3. 구현 순서 — 의존성 그래프

```
P0-2 ARCHITECTURE.md ──┐
                        ├──→ P0-1 AGENTS.md
P0-3 docs/ 구조 ────────┤
                        └──→ P0-4 루트 문서 정리
                                    │
                    ┌───────────────┤
                    ↓               ↓
              ┌─── P1a ───┐  ┌─── P1b ───────────┐
              │            │  │                    │
        P1a-1 ESLint      │  │  P1b-1 파일 분리    │
        P1a-2 env 중앙화   │  │  (Tier1 → 2 → 3)  │
        P1a-3 check-struct │  │                    │
        P1a-4 check-docs   │  │  P1b-2 테스트 추가  │
              │            │  │  (orchestration/)  │
              ↓            │  │                    │
        P1a-5 GitHub CI    │  │  P1b-3 console.log │
        P1a-6 QUALITY_SCORE│  │  정리              │
        P1a-7 references/  │  │                    │
              └────────────┘  └────────────────────┘
                    │               │
                    └───────┬───────┘
                            ↓
                      P2 (VPS 배포 후)
```

**권장 실행 순서:**
1. `P0-2` → ARCHITECTURE.md (모든 문서의 기반, gate↔risk 검증 포함)
2. `P0-3` → docs/ 디렉토리 생성 + 핵심 문서 초안
3. `P0-4` → 루트 문서 정리 (이전/통합)
4. `P0-1` → AGENTS.md (위 문서 완성 후 목차 작성)
5. `P1a-1` → ESLint import 규칙 + no-console (flat config)
6. `P1a-2` → process.env 3건 config.ts 중앙화
7. `P1a-3~4` → CI 스크립트 2개
8. `P1a-5` → GitHub Actions CI
9. `P1b-1 Tier1` → backtest/engine.ts + index.ts 분리 (가장 큰 2개 먼저)
10. `P1b-1 Tier2` → 350줄+ 파일 6개 분리
11. `P1b-2` → orchestration/ 테스트 작성
12. `P1b-1 Tier3` + `P1b-3` → 나머지 분리 + console.log 정리
13. `P1a-6~7` → QUALITY_SCORE + references/ (마지막 — 분리 완료 후 등급 확정)

---

## 4. 성공 기준

### P0 완료 조건
- [ ] AGENTS.md 존재, 100줄 이내, docs/ 경로 참조 유효
- [ ] ARCHITECTURE.md 존재, 레이어 방향 규칙 명시, gate↔risk 방향 확정
- [ ] docs/ 하위 최소 10개 문서 존재
- [ ] 루트 .md 파일 6개 이하 (README, PROJECT, OPERATIONS, SETUP, AGENTS, ARCHITECTURE)

### P1a 완료 조건
- [ ] `npx eslint src/` 통과 (import 방향 위반 0건)
- [ ] `process.env` 직접 접근 0건 (config.ts, logger.ts 제외)
- [ ] `bash scripts/check-structure.sh` 통과
- [ ] `bash scripts/check-docs-freshness.sh` 통과
- [ ] GitHub Actions CI 그린
- [ ] QUALITY_SCORE.md 전 16개 모듈 등급 기록

### P1b 완료 조건
- [ ] 300줄 초과 파일 0개
- [ ] orchestration/ 테스트 최소 2개 suite 추가
- [ ] `no-console: 'warn'` 활성화, reporter.ts만 eslint-disable 예외

### P2 완료 조건
- [ ] db-schema.md 자동 생성 CI 스텝 동작
- [ ] 주간 정리 Actions 첫 실행 완료
- [ ] 에이전트가 `curl`로 봇 상태 확인 가능

---

## 5. 리스크 & 트레이드오프

| 리스크 | 영향 | 완화 |
|---|---|---|
| P1b 파일 분리 작업량 | VPS 배포(SOL-39) 지연 | Tier1(2개) 먼저, Tier2/3은 배포와 병행 |
| 파일 분리 시 테스트 깨짐 | 기존 67 테스트 실패 | 분리 후 즉시 `npm test` 확인, 작은 단위 커밋 |
| 문서 작성에 시간 소모 | 개발 속도 저하 | P0 문서는 초안 수준으로 빠르게 작성, 점진 보강 |
| 과도한 구조화 | 1인 개발 속도 저하 | 300줄 제한만 hard fail, 200줄은 경고 |
| 문서-코드 괴리 | 에이전트 오작동 | check-docs-freshness.sh CI 강제 |
| ESLint 규칙 과다 | DX 저하 | import 방향만 error, no-console은 warn |
| references/ 유지 부담 | 라이브러리 업데이트 시 괴리 | 분기 1회 갱신, 버전 명시 |

---

## 6. harness.md §7, §8 적용 계획

### §7 처리량 우선 머지 철학 → docs/CONVENTIONS.md에 포함

```markdown
## PR & 머지 규칙
- PR은 단일 기능 또는 단일 수정 단위로 작게 유지한다.
- CI 통과 = 머지 가능. 테스트 flake는 재실행으로 처리.
- 수정은 싸고, 대기는 비싸다.
- 크리티컬 패스(risk/, gate/, executor/)만 수동 리뷰를 강제한다.
- 파일 분리 PR은 동작 변경 없이 구조만 변경하므로 CI 통과 시 즉시 머지.
```

### §8 피드백 루프 → docs/design-docs/core-beliefs.md에 포함

```markdown
## 에이전트 실패 시 대응 절차
에이전트가 잘못된 코드를 생성했을 때:
1. ❌ 프롬프트만 고치지 마라.
2. ❌ 사람이 직접 코드를 수정하지 마라.
3. ✅ "어떤 컨텍스트가 누락됐는가?"를 파악하라.
4. ✅ 누락된 것을 레포에 추가하라:
   - API 패턴이 틀렸다면 → docs/references/*-llms.txt 보강
   - 의존성 방향을 위반했다면 → ESLint 규칙 추가
   - 비즈니스 로직을 오해했다면 → docs/design-docs/ 문서 보강
   - 컨벤션을 어겼다면 → docs/CONVENTIONS.md 규칙 추가
5. ✅ 그 수정도 에이전트가 작성하게 하라.
```

---

## 7. 품질 점검 이력

### v1 → v2 변경사항 (2026-03-18)

실제 프로젝트 검증 결과 반영:

| 변경 | 내용 |
|---|---|
| 갭 분석 수치 | 루트 .md 7→10개, ESLint "없음"→"존재(flat config)", console.log "미확인"→46건 |
| P1 분할 | P1 (3–5일) → P1a (기계적 강제, 3–5일) + P1b (파일 분리+테스트, 1–2주) |
| 파일 분리 | 300줄 초과 13개 파일 목록 + Tier별 분리 계획 추가 |
| QUALITY_SCORE | 12개→16개 모듈, 크기 평가 전면 재산정 |
| ESLint 예시 | `.eslintrc.cjs` → `eslint.config.js` flat config 형식 |
| 테스트 갭 | 6개 미테스트 모듈 명시, orchestration/ 테스트를 P1b에 포함 |
| process.env | 위반 3건 파일/라인 특정, P1a-2에서 수정 |
| 성공 기준 | 루트 .md 5개→6개 (ARCHITECTURE.md 포함) |
| §7, §8 | 구체적 적용 계획 §6으로 추가 |

---

## 8. 참고

- 기준 문서: `/Users/igyubin/Desktop/projects/01_shakishaki/Solana/harness.md`
- 현재 리팩토링 상태: `solana-momentum-bot/REFACTORING.md`
- Paperclip 태스크: SOL-39 (VPS), SOL-27 (Paper 50-trade)
- 관련 이슈: SOL-40 (Board TODO 정리)
