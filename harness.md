# HARNESS.md — shakilabs 에이전트 하네스 운영 가이드

> **출처:** OpenAI "Harness engineering: leveraging Codex in an agent-first world" (2026-02-11, Ryan Lopopolo)
> **목적:** 100 MVP 전략에서 Claude(전략) + Codex CLI(구현) + OpenClaw Scout(리서치) 워크플로우의 에이전트 품질 상한선을 높이기 위한 레포지토리 수준 운영 규칙
> **최종 수정:** 2026-03-18

---

## 0. 핵심 전제

하네스 엔지니어링의 핵심 통찰은 다음 한 문장이다:

**에이전트 품질의 상한선은 프롬프트가 아니라 레포 환경(구조, 문서, 린터, 피드백 루프)이 결정한다.**

에이전트 관점에서 실행 중 컨텍스트 내에서 접근할 수 없는 것은 존재하지 않는 것과 같다.
Google Docs, 카톡, Slack에서 결정된 사항이라도 레포에 커밋되지 않으면 에이전트는 알 수 없다.

---

## 1. 레포지토리 = 유일한 진실의 원천

### 원칙
- 아키텍처 결정, 컨벤션, 기술 부채 현황은 모두 레포 내 `docs/`에 markdown으로 관리한다.
- 외부 채널(카톡, 노션, 슬랙)에서 결정된 사항은 반드시 `docs/decisions/` ADR로 커밋한다.
- 에이전트가 참조할 수 없는 지식 = 존재하지 않는 지식.

### shakilabs 저장소 Knowledge Base 구조

원문에서 OpenAI 팀은 `AGENTS.md`를 목차로, `docs/` 하위를 시스템 오브 레코드로 운용했다.
아래는 이를 shakilabs 100 MVP 스택에 맞게 구체화한 구조이다.

```
project-root/
│
├── AGENTS.md                          # 에이전트 entry point (목차, 100줄 이내)
├── ARCHITECTURE.md                    # 도메인·패키지 레이어 top-level 맵
│
├── docs/
│   │
│   ├── design-docs/                   # 아키텍처 설계 문서
│   │   ├── index.md                   # 설계 문서 카탈로그 (검증 상태 포함)
│   │   ├── core-beliefs.md            # 에이전트 우선 운영 원칙 정의
│   │   ├── layer-rules.md             # Types→Config→DB→Services→Routes 의존성 규칙
│   │   └── auth-strategy.md           # JWT + httpOnly Cookie 인증 설계
│   │
│   ├── exec-plans/                    # 실행 계획 (first-class artifact)
│   │   ├── active/                    # 현재 진행 중인 계획
│   │   │   └── card-shakilabs-v1.md   # 예: card.shakilabs.com 6탭 구현 계획
│   │   ├── completed/                 # 완료된 계획 (이력 보존)
│   │   └── tech-debt-tracker.md       # 알려진 기술 부채 목록 + 우선순위
│   │
│   ├── product-specs/                 # 제품 명세
│   │   ├── index.md                   # 명세 카탈로그
│   │   ├── subdomain-structure.md     # 서브도메인별 테마/컬러/기능 매핑
│   │   └── monetization.md            # AdSense, 쿠팡 파트너스, 카드고릴라 전략
│   │
│   ├── generated/                     # 코드에서 자동 생성되는 문서
│   │   └── db-schema.md               # Drizzle 스키마 → 자동 생성 ERD/테이블 목록
│   │
│   ├── references/                    # 외부 참조 자료 (에이전트 컨텍스트용)
│   │   ├── drizzle-orm-llms.txt       # Drizzle ORM 핵심 API 레퍼런스
│   │   ├── vue3-composition-llms.txt  # Vue 3 Composition API 패턴 레퍼런스
│   │   └── tailwind-llms.txt          # Tailwind 유틸리티 클래스 레퍼런스
│   │
│   ├── decisions/                     # ADR (Architecture Decision Records)
│   │   ├── 001-vue3-composition-api.md
│   │   ├── 002-drizzle-over-prisma.md
│   │   └── 003-subdomain-per-tool.md
│   │
│   ├── CONVENTIONS.md                 # 네이밍, 파일 구조, 코딩 스타일
│   ├── FRONTEND.md                    # 프론트엔드 컨벤션 (Vue 3 + Tailwind)
│   ├── SECURITY.md                    # 보안 규칙 (OWASP, 입력 검증, CORS)
│   ├── QUALITY_SCORE.md               # 도메인별 품질 등급 (A~F) + 갭 추적
│   └── RELIABILITY.md                 # 헬스체크, 로깅, 에러 핸들링 규칙
│
├── src/                               # 백엔드 (Express + Drizzle)
│   ├── types/                         # 공유 타입 정의 (Zod 스키마 포함)
│   ├── config/                        # 환경 변수, 앱 설정
│   ├── db/                            # Drizzle 스키마, 마이그레이션
│   ├── services/                      # 비즈니스 로직
│   ├── routes/                        # Express 라우트 핸들러
│   ├── middleware/                     # 인증, rate-limit, 에러 핸들링
│   └── utils/                         # 공유 유틸리티
│
└── frontend/                          # 프론트엔드 (Vue 3)
    └── src/
        ├── api/                       # API 클라이언트 (axios/fetch 래퍼)
        ├── composables/               # Vue 3 Composable 함수
        ├── components/                # 재사용 컴포넌트
        └── views/                     # 페이지 뷰
```

### 원문 구조와의 매핑

| OpenAI 원문 | shakilabs 대응 | 역할 |
|---|---|---|
| `AGENTS.md` (~100줄) | `AGENTS.md` | 에이전트 entry point, 목차 |
| `ARCHITECTURE.md` | `ARCHITECTURE.md` | 도메인·레이어 top-level 맵 |
| `docs/design-docs/` | `docs/design-docs/` | 설계 문서 + 검증 상태 카탈로그 |
| `docs/exec-plans/active/` | `docs/exec-plans/active/` | 진행 중 실행 계획 |
| `docs/exec-plans/completed/` | `docs/exec-plans/completed/` | 완료 계획 이력 |
| `docs/exec-plans/tech-debt-tracker.md` | `docs/exec-plans/tech-debt-tracker.md` | 기술 부채 추적 |
| `docs/product-specs/` | `docs/product-specs/` | 제품 명세 |
| `docs/generated/` | `docs/generated/` | 코드에서 자동 생성 문서 |
| `docs/references/*-llms.txt` | `docs/references/*-llms.txt` | 에이전트 컨텍스트용 외부 레퍼런스 |
| `docs/QUALITY_SCORE.md` | `docs/QUALITY_SCORE.md` | 도메인별 품질 등급 |
| `docs/SECURITY.md` | `docs/SECURITY.md` | 보안 규칙 |

### `docs/references/*-llms.txt` 설명

원문에서 `references/` 디렉토리에 `*-llms.txt` 파일을 두는 이유:
에이전트가 외부 라이브러리 API를 정확하게 사용하도록, 핵심 레퍼런스를 레포 내 텍스트 파일로 내재화한다.
에이전트 학습 데이터에 없거나 부정확할 수 있는 API 사용법을 레포 로컬 파일로 보장하는 것이다.

shakilabs에서는 Drizzle ORM, Vue 3 Composition API, Tailwind CSS 등
에이전트가 자주 참조하는 라이브러리의 핵심 패턴을 정리해둔다.

---

## 2. AGENTS.md는 목차다, 백과사전이 아니다

### 문제
거대한 단일 AGENTS.md는 예측 가능한 방식으로 실패한다:
- 컨텍스트는 희소 자원 — 지시 파일이 비대하면 실제 작업과 코드를 밀어낸다.
- 모든 것이 "중요"하면 아무것도 중요하지 않다.
- 단일 파일은 기계적 검증(coverage, freshness, cross-link)이 어렵다.

### 규칙
- AGENTS.md는 **100줄 이내**를 유지한다.
- 역할: 프로젝트 개요 + `docs/` 하위 문서에 대한 포인터.
- 상세 규칙은 각 `docs/*.md`에 분리한다.

### AGENTS.md 템플릿

원문에서 AGENTS.md는 ~100줄의 목차로, `docs/` 하위 문서의 역할·경로·상태를 명시적으로 가리킨다.
에이전트는 이 파일을 읽고 "어디를 더 봐야 하는지"를 판단한다.

```markdown
# AGENTS.md — {project-name}

## 프로젝트 개요
- 한 줄 설명: {description}
- 스택: Vue 3 (Composition API) / Express / Drizzle ORM / PostgreSQL / Tailwind CSS
- 인증: JWT + httpOnly Cookie
- 배포: Docker

## 저장소 Knowledge Base 맵

### 아키텍처
| 문서 | 경로 | 설명 |
|---|---|---|
| 도메인·레이어 맵 | `ARCHITECTURE.md` | 패키지 레이어링, 의존성 방향 규칙 |
| 설계 문서 카탈로그 | `docs/design-docs/index.md` | 전체 설계 문서 목록 + 검증 상태 |
| 핵심 운영 원칙 | `docs/design-docs/core-beliefs.md` | 에이전트 우선 운영 원칙 |
| 레이어 규칙 | `docs/design-docs/layer-rules.md` | Types→Config→DB→Services→Routes 방향 강제 |
| 인증 설계 | `docs/design-docs/auth-strategy.md` | JWT + httpOnly Cookie + CORS 전략 |

### 실행 계획
| 문서 | 경로 | 설명 |
|---|---|---|
| 진행 중 계획 | `docs/exec-plans/active/` | 현재 작업 중인 실행 계획 |
| 완료 계획 | `docs/exec-plans/completed/` | 완료된 계획 이력 |
| 기술 부채 | `docs/exec-plans/tech-debt-tracker.md` | 알려진 부채 + 우선순위 |

### 제품 명세
| 문서 | 경로 | 설명 |
|---|---|---|
| 명세 카탈로그 | `docs/product-specs/index.md` | 전체 제품 명세 목록 |
| 서브도메인 구조 | `docs/product-specs/subdomain-structure.md` | 서브도메인별 테마/기능 매핑 |
| 수익화 전략 | `docs/product-specs/monetization.md` | AdSense, 제휴 마케팅 전략 |

### 컨벤션 & 규칙
| 문서 | 경로 | 설명 |
|---|---|---|
| 코딩 컨벤션 | `docs/CONVENTIONS.md` | 네이밍, 파일 구조, 코딩 스타일 |
| 프론트엔드 | `docs/FRONTEND.md` | Vue 3 + Tailwind 컨벤션 |
| 보안 | `docs/SECURITY.md` | OWASP, Zod 검증, CORS, 인증 규칙 |
| 품질 등급 | `docs/QUALITY_SCORE.md` | 도메인별 품질 A~F + 갭 추적 |
| 안정성 | `docs/RELIABILITY.md` | 헬스체크, 로깅, 에러 핸들링 |

### 자동 생성 & 참조
| 문서 | 경로 | 설명 |
|---|---|---|
| DB 스키마 | `docs/generated/db-schema.md` | Drizzle 스키마에서 자동 생성 |
| Drizzle 레퍼런스 | `docs/references/drizzle-orm-llms.txt` | 에이전트용 Drizzle API 핵심 패턴 |
| Vue 3 레퍼런스 | `docs/references/vue3-composition-llms.txt` | 에이전트용 Composition API 패턴 |
| ADR 목록 | `docs/decisions/` | 주요 아키텍처 결정 이력 |

## 에이전트 작업 규칙 (반드시 준수)

1. **새 파일 생성 전** `ARCHITECTURE.md`와 `docs/design-docs/layer-rules.md`의 의존성 방향을 확인하라.
2. **모든 사용자 입력**은 `src/types/` 내 Zod 스키마로 검증하라.
3. **DB 스키마 변경 시** Drizzle 마이그레이션 명령어를 PR 본문에 포함하라.
4. **파일당 200줄 이내**를 지향하라. 300줄 초과 시 CI 실패.
5. **변수명·함수명·에러 메시지는 영어**, 주석은 한국어로 작성하라.
6. **보안 규칙 변경 시** 반드시 `docs/SECURITY.md`를 먼저 읽고 준수하라.
7. **새 라이브러리 도입 시** `docs/decisions/`에 ADR을 먼저 작성하라.
8. **설계 문서 수정 시** `docs/design-docs/index.md`의 검증 상태를 업데이트하라.
```

### Progressive Disclosure가 작동하는 방식

에이전트는 AGENTS.md만 먼저 읽는다. 그 안의 테이블에서 현재 태스크에 관련된 문서 경로를 찾고,
해당 문서만 추가로 읽는다. 전체 `docs/`를 한꺼번에 컨텍스트에 올리지 않는다.

```
에이전트 태스크: "로그인 API 구현"
  1. AGENTS.md 읽음 → 인증 관련 → docs/design-docs/auth-strategy.md 발견
  2. auth-strategy.md 읽음 → JWT + httpOnly Cookie 전략 파악
  3. docs/SECURITY.md 읽음 → Zod 검증, CORS 설정 규칙 확인
  4. ARCHITECTURE.md 읽음 → routes/ → services/ → db/ 레이어 방향 확인
  5. 구현 시작
```

이렇게 하면 "로그인 API 구현"에 필요한 4개 문서만 컨텍스트에 올라가고,
수익화 전략이나 프론트엔드 컨벤션 같은 무관한 문서는 컨텍스트를 차지하지 않는다.

### 기계적 검증: docs/ 신선도 유지

원문에서 doc-gardening 에이전트가 문서 신선도를 자동 검증한다.
shakilabs에서는 CI 스텝으로 최소한의 검증을 수행한다:

```bash
#!/bin/bash
# scripts/check-docs-freshness.sh
# Why: 문서가 코드와 괴리되면 에이전트가 잘못된 컨텍스트로 작업한다

echo "=== docs/design-docs/index.md 존재 확인 ==="
[ -f docs/design-docs/index.md ] || { echo "❌ design-docs/index.md 누락"; exit 1; }

echo "=== AGENTS.md 100줄 이내 확인 ==="
lines=$(wc -l < AGENTS.md)
[ "$lines" -le 100 ] || { echo "❌ AGENTS.md가 ${lines}줄 (100줄 초과)"; exit 1; }

echo "=== docs/ 내 broken internal link 확인 ==="
grep -roh '\`docs/[^`]*\`' AGENTS.md ARCHITECTURE.md | tr -d '`' | while read path; do
  [ -e "$path" ] || echo "❌ AGENTS.md에서 참조하는 $path 가 존재하지 않음"
done

echo "=== exec-plans/active/ 비어있지 않은지 확인 ==="
[ "$(ls -A docs/exec-plans/active/ 2>/dev/null)" ] || echo "⚠️ 활성 실행 계획 없음"

echo "✅ docs 검증 완료"
```

---

## 3. 아키텍처 경계의 기계적 강제

### 원칙
markdown 파일에 "X 하지 마"라고 적는 건 제안이다. X가 빌드 실패를 트리거하게 만드는 건 규칙이다.

### shakilabs 레이어 규칙

```
의존성 방향 (단방향만 허용):

  Types → Config → DB(Drizzle) → Services → Routes → Middleware

  Frontend:
  api/ → composables/ → components/ → views/

  금지:
  - views/에서 db/ 직접 import
  - components/에서 routes/ import
  - services/에서 middleware/ import
```

### ESLint로 강제하는 방법

```javascript
// .eslintrc.cjs — import 제한 규칙 예시
module.exports = {
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        {
          group: ['../db/*', '../../db/*'],
          // Why: frontend에서 DB 레이어 직접 접근 금지
          message: 'DB 레이어는 services/를 통해서만 접근하세요.'
        }
      ]
    }]
  }
};
```

### CI에서 강제할 구조적 검증 항목
- import 경로 방향 검증 (위 ESLint 규칙)
- 파일 크기 제한: 단일 파일 200줄 초과 시 경고, 300줄 초과 시 실패
- 네이밍 컨벤션: 스키마 파일은 `*.schema.ts`, 서비스 파일은 `*.service.ts`
- 모든 route handler에 Zod 검증 미들웨어 존재 여부 확인

---

## 4. 에이전트를 위한 앱 가독성 (Application Legibility)

### 원칙
코드뿐 아니라 실행 중인 앱 자체를 에이전트가 볼 수 있어야 한다.
OpenAI 팀은 per-worktree 앱 부팅, Chrome DevTools Protocol 연동, 관측성 스택(LogQL/PromQL)을 에이전트에 노출해서 병목을 해소했다.

### shakilabs 적용 (단계적)

**Phase 1 — 즉시 적용:**
- `npm run dev` 한 줄로 로컬 서버 부팅 가능한 상태 유지
- 헬스체크 엔드포인트 (`GET /health`) 필수
- 구조화된 JSON 로깅 (`{ timestamp, level, message, context }`)
- 에이전트가 `curl localhost:3000/health`로 서버 상태 확인 가능

**Phase 2 — 트래픽 확보 후:**
- Docker Compose로 앱 + DB를 원커맨드 부팅
- 에이전트가 로그를 grep/jq로 파싱 가능한 구조 유지

**Phase 3 — 규모 확장 시:**
- Playwright/Puppeteer 기반 UI 검증 스크립트를 에이전트가 실행
- 관측성 스택(Grafana Loki + Prometheus) 도입 검토

---

## 5. "지루한 기술"이 이긴다

### 원칙
에이전트 학습 데이터에 풍부하고, API가 안정적이며, 구성 가능한(composable) 기술이 에이전트에게 유리하다. 니치 라이브러리보다 에이전트가 이미 잘 아는 기술을 우선한다.

### shakilabs 기술 선택 기준

| 기준 | 적용 |
|---|---|
| 에이전트 학습 데이터 풍부 | Vue 3, Express, PostgreSQL, Tailwind CSS ✅ |
| API 안정성 | Drizzle ORM (typed, composable) ✅ |
| 검증 라이브러리 | Zod (에이전트가 자연스럽게 선택하는 경향) ✅ |

**새 라이브러리 도입 판단 체크리스트:**
1. GitHub Stars 1,000+ 이고 npm weekly downloads 10,000+ 인가?
2. 에이전트(Claude/Codex)에게 "이 라이브러리로 X 해줘"라고 했을 때 정확한 코드를 생성하는가?
3. 기존 스택의 서브셋으로 직접 구현하는 것보다 명확한 이점이 있는가?

→ 3개 모두 Yes가 아니면 직접 구현하거나 기존 스택 내에서 해결한다.

---

## 6. 엔트로피 관리 = 가비지 컬렉션

### 문제
에이전트는 레포에 이미 존재하는 패턴을 복제한다 — 비최적 패턴까지 포함해서.
100개 MVP를 빠르게 찍어내면 패턴 불일치가 누적된다.

### Golden Principles (기계적으로 강제할 것)
1. **공유 유틸리티 우선:** 동일 로직의 hand-rolled helper가 2곳 이상 존재하면 `src/utils/`로 통합한다.
2. **Parse, don't validate:** 모든 외부 경계(API 입력, DB 결과, 외부 API 응답)에서 Zod로 파싱한다. 추측 기반 데이터 접근(YOLO-style probing) 금지.
3. **파일 크기 제한:** 200줄 초과 시 분리 검토, 300줄 초과 시 CI 실패.
4. **구조화된 로깅만 허용:** `console.log` 직접 사용 금지, 반드시 로거 유틸리티 경유.
5. **네이밍 일관성:** 스키마(`*.schema.ts`), 서비스(`*.service.ts`), 라우트(`*.route.ts`).

### 주간 정리 프로세스
- 주 1회 린트 + 구조 스캔 실행
- 중복 코드, 네이밍 위반, 미사용 import 탐지
- 교정 PR 생성 → 빠른 리뷰 후 머지

```bash
# 주간 정리 스크립트 예시
#!/bin/bash
# Why: 에이전트가 생성한 코드의 패턴 드리프트를 주기적으로 교정

echo "=== 파일 크기 검사 ==="
find src/ frontend/src/ -name '*.ts' -o -name '*.vue' | while read f; do
  lines=$(wc -l < "$f")
  if [ "$lines" -gt 300 ]; then
    echo "❌ FAIL: $f ($lines lines)"
  elif [ "$lines" -gt 200 ]; then
    echo "⚠️ WARN: $f ($lines lines)"
  fi
done

echo "=== console.log 직접 사용 검사 ==="
grep -rn "console\.log" src/ frontend/src/ --include="*.ts" --include="*.vue" \
  | grep -v "// eslint-disable" \
  | grep -v "logger\." && echo "❌ console.log 직접 사용 발견" || echo "✅ 통과"

echo "=== 미사용 import 검사 ==="
npx eslint src/ frontend/src/ --rule '{"no-unused-vars": "error"}' --quiet
```

---

## 7. 처리량 우선 머지 철학

### 원칙
1인 개발에서도 "완벽한 리뷰 후 머지"보다 "CI 통과 → 빠른 머지 → 문제 시 후속 PR"이 더 효율적이다.

### 규칙
- PR은 가능한 작게 유지한다 (단일 기능 또는 단일 수정).
- CI 통과 = 머지 가능. 테스트 flake는 재실행으로 처리, 머지를 블로킹하지 않는다.
- **수정은 싸고, 대기는 비싸다.**
- 크리티컬 패스(인증, 결제, 개인정보)만 수동 리뷰를 강제한다.

---

## 8. 에이전트 간 피드백 루프

### 현재 워크플로우 (Level 2 자동화)

```
[인간] 의도/태스크 명세
    ↓
[Claude] 전략 수립, 아키텍처 결정, 문서 생성
    ↓
[Codex CLI] 코드 구현 (AGENTS.md 가이드 기반)
    ↓
[자체 검증 루프] lint + test + build
    ↓
[Claude] 코드 리뷰 + 품질 검토
    ↓
[인간] 최종 판단 (필요 시에만)
```

### 에이전트 실패 시 대응 원칙

에이전트가 실패하면:
1. ❌ 프롬프트만 고치지 마라.
2. ❌ 사람이 직접 코드를 수정하지 마라.
3. ✅ "어떤 역량/컨텍스트가 누락됐는가?"를 파악하라.
4. ✅ 누락된 것을 레포에 추가하라 (문서, 린터 규칙, 유틸리티, 테스트).
5. ✅ 그 수정도 에이전트가 작성하게 하라.

→ 이 루프가 하네스를 시간이 갈수록 강화시키는 핵심 메커니즘이다.

---

## 9. 보안 — 타협 불가 (하네스에서도 동일)

에이전트 생성 코드라도 다음은 기계적으로 강제한다:

- [ ] 모든 사용자 입력: Zod 스키마 검증
- [ ] 인증: JWT + httpOnly Cookie + CORS 명시적 설정
- [ ] 민감 데이터: `.env` 환경 변수 전제 (하드코딩 금지)
- [ ] SQL Injection: Drizzle ORM parameterized query만 허용
- [ ] Rate Limiting: express-rate-limit 미들웨어 필수
- [ ] 요청 크기 제한: express.json({ limit: '10kb' }) 기본 적용
- [ ] OWASP Top 10: CI에서 `npm audit` 실행

---

## 10. 즉시 실행 체크리스트

### P0 — 이번 주: Knowledge Base 초기 구축

- [ ] `AGENTS.md`를 위 템플릿 기반 100줄 이내 목차로 재작성
- [ ] `ARCHITECTURE.md` 생성 (도메인·레이어 top-level 맵)
- [ ] `docs/` 하위 구조 생성:
  - [ ] `docs/design-docs/index.md` + `core-beliefs.md` + `layer-rules.md`
  - [ ] `docs/exec-plans/active/` + `completed/` + `tech-debt-tracker.md`
  - [ ] `docs/product-specs/index.md` + `subdomain-structure.md`
  - [ ] `docs/CONVENTIONS.md` + `FRONTEND.md` + `SECURITY.md`
  - [ ] `docs/QUALITY_SCORE.md` + `RELIABILITY.md`
  - [ ] `docs/decisions/` (기존 기술 선택 3건 ADR 소급 작성)
  - [ ] `docs/references/` (drizzle-orm-llms.txt 우선 작성)
- [ ] ESLint에 import 방향 제한 규칙 추가
- [ ] `scripts/check-docs-freshness.sh` CI 스텝 추가

### P1 — 이번 달: 기계적 강제 + 자동화

- [ ] CI에 구조적 검증 스텝 추가 (파일 크기, 네이밍, Zod 존재 여부)
- [ ] 주간 정리 스크립트 작성 및 GitHub Actions 등록
- [ ] `docs/generated/db-schema.md` 자동 생성 스크립트 (Drizzle introspect → markdown)
- [ ] `docs/QUALITY_SCORE.md` 첫 등급 산정 (도메인별 A~F)
- [ ] `GET /health` 엔드포인트 전 프로젝트 공통 적용

### P2 — 다음 분기

- [ ] Playwright 기반 UI 스모크 테스트 자동화
- [ ] 에이전트가 로그를 직접 쿼리할 수 있는 구조화된 관측성 스택
- [ ] 프로젝트 간 공유 가능한 하네스 템플릿 패키지화

---

## 참고 자료

- [OpenAI — Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/) (원문)
- [Martin Fowler — Harness Engineering 분석](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html)
- [Octopus Deploy — Harness Engineering 실전 가이드](https://octopus.com/devops/continuous-delivery/harness-engineering/)
- [HumanLayer — Skill Issue: Harness Engineering for Coding Agents](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents)
