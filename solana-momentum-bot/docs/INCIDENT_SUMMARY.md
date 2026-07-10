# INCIDENT 요약 (세션 시작용)

> 원본: [`../INCIDENT.md`](../INCIDENT.md) — append-only 전체 연표 (2026-04-22 ~ ). 이 문서는 요약본이다.
> 세부 수치·판정 근거·QA 이력·미해결 gap 은 반드시 원본에서 확인하라. 원본은 절대 수정/삭제 금지.
> 요약 갱신: 2026-07-10 (원본 최신 incident: 2026-06-13; 2026-07-08 결정 지원 평가 반영)
> 현재 상태: `RETIRE_CURRENT_LIVE` 유지 / H-007a `PROTOCOL_REQUIRED` / 운영자 최종 결정 대기.
> 결정 트리: [`../20260708.md`](../20260708.md). 원격 runtime 상태는 별도 검증 전 확정하지 않는다.

## 1. 반복 패턴별 교훈

### A. Ground truth — wallet delta 만 믿어라
- DB pnl 단독 판정 금지 (drift +18.34 SOL 허수 전력). 엔진/전략 판정은 wallet delta 가 유일 기준.
- `receivedSol<0` 시 actualExitPrice 미갱신 버그가 PNL_DRIFT 0.0498 SOL root cause (4 lane fix, 04-29).
- ATA rent(~0.002 SOL/entry) = ticket 0.02 기준 20% overhead → token-only 축 분리 없이는 5x winner 를 놓친다 (05-01 Sprint X/Y/Z).
- 집계 전 필수 위생: offline-sim positionId dedup / decimals 버그 row sanity clamp / synthetic test row quarantine (06-10 측정부채 수리).

### B. 분석 무결성 — grep 단독 검증 금지
- agent grep 단독 audit 의 false claim 다수 전력 (observer dead → 실제 8910/8910 정상, "Jupiter 18k/min" → 실측 186/min 등 10건+). critical claim 은 직접 read + cross-check 필수.
- 시간대 함정: 모든 timestamp 는 UTC `Z` 기준. KST cutoff 금지 (246 vs 254 "14배 모순" 소동의 원인).
- 스키마 함정: paper-only vs live mirror positionId 분리 / missed-alpha 는 `probe` 단일 객체 / executed-* 에는 mfe 없음 / 5x 판정은 mfe peak 기준 (close 가격 아님).
- 분석 무결성 체크리스트 12항목: `SESSION_START.md` §6-bis — 보고서 첫 줄에 통과 여부 명시.

### C. 배포·동기화 결함
- pm2 는 `dist/` 를 실행한다 — git pull 만으로 코드 미반영. 배포 체크리스트: ① local push ② VPS `git pull --ff-only` ③ `npm run build` ④ `pm2 restart momentum-bot` ⑤ 기동 로그에서 limits 라인 + mode 확인 (06-11, D+7 측정 창 무효 직전 적발).
- 운영 분석 전 `bash scripts/sync-vps-data.sh` 먼저. sync 후 `logs/bot.log` 30분 이상 stale 이면 결론 보류.
- 재시작 hydrate 가 halt 조건을 복원할 수 있다 (canary trade count 152 복원 → 이중 halt, 05-01).

### D. 외부 API 한도 — Jupiter 429 / Helius quota
- Jupiter 429 cascade 는 entry 3분·close 17분 지연으로 손실을 키운다 (8JH1J6p4 5중 cascade). 429 전용 retry 분리 + backoff [2,5,15,30,60].
- Helius 는 **free tier 1M/월** (Developer 10M 아님 — 06-12 대시보드 확정, reset ~매월 24일). 현 observe run 구성은 일 ~100k = 월 10일 한계.
- 재구독 churn 의 seed backfill 중복 호출 → `KOL_REALTIME_CANDLE_SEED_COOLDOWN_MS` (default 30min). WS notification 과금설은 기각 (실측 27 credits).
- 비용 추정은 attribution ledger 로 검증 후 결제 판단 — "estimatedCredits 이중 곱 + 잘못된 플랜 가정" 이 8배 격차 허상을 만든 전력.

### E. Guard·halt 정책
- Real Asset Guard (floor 0.6 / ticket 0.01, KOL 0.02 / drift halt 0.2 / max concurrent 3) 변경 금지. 모든 완화는 별도 ADR + 운영자 ack 경유.
- 과보수 halt 는 사명(200 trades 누적)과 충돌한 전력: Calibration daily loss 5%→15% (04-29), KOL canary cap 50→200 trades / 0.2→0.3 SOL (05-01).
- ticket scale 은 live 실측 후 후퇴한 전력 (0.03→0.02 — live loss 가 paper 의 2.6x, catastrophic 4.5%). 상향은 100-trade 재평가 분기로만.
- 데이터 없이 threshold 튜닝 금지 — 관측 장비(observer/telemetry)를 먼저 세운다.

### F. 전략 구조 — 현 상태(봇 정지)의 이유
- **Edge Audit 06-10 최종판정 `RETIRE_CURRENT_LIVE`**: live 475 closes / −1.128 SOL, P(net>0)=0.0000. 3중 자기모순 = 신호 수명 ~60s × 왕복 고정비 13.6% × 5x tail 의 92% 가 exit 후 발생 — 단일 수정으로 해소 불가.
- multi-KOL consensus 는 역예측 (T+1800 median: 2-KOL −64.5% / 3+ −68.1%). KOL-follow live 전략 archive, 차기 신호 연구는 offline-only (kill criteria: audit report §7, promotion gate 완화 불가).
- ex-ante 필터 자체는 유효 (NO_SECURITY_DATA reject Δ+20.6% / 생존+나이+활동 필터가 −48% bleed 를 −2% 로) — 진입 edge 가 없었을 뿐.
- paradigm 변경은 데이터 먼저 (Trending Sniper 보류 사례). Mission v2 (06-10): 생존 우선, Helius ≤$50/월 + 예비금 $1,000 동결 (OFFLINE_COHORT_FOUND 전 투입 금지).

## 2. 최근 30일 인시던트 요약 (2026-06-05 ~)

- **06-10 Edge Audit `RETIRE_CURRENT_LIVE`** — §F 참조. 측정부채 3건 수리 + synthetic 18행 격리 + candle TTL 15min/funnel telemetry. 병렬 적대 재계산으로 판정 유지 (Errata 는 `analysis/edge-audit-2026-06-10/EDGE_AUDIT_REPORT.md` §8).
- **06-10 Coverage Lever 1 구현** — KolTx poolAddress 추출 → `kol_tx_pool` 직행 구독 (WS 지원 프로그램만). Lever 2 (pump.fun bonding parser) 는 보류 + 착수 trigger 3개.
- **06-10 Survivor Momentum Phase 0 `REJECT_ALL`** — 3 trigger offline 전부 기각 (post-cost 전부 음수). universe 필터(손실 통제)만 유효. 코드 구현 0, 매몰 0.
- **06-10 Mission v2 채택** — 생존 우선 재정의, "1→100 빠르게" 폐기 (`docs/design-docs/mission-refinement-v2-2026-06-10.md`).
- **06-11 D+1 스모크가 배포 결함 2건 적발** — 로컬 8 commits 미push + VPS dist 미빌드. 배포 체크리스트 5단계 확립, D+7 시계 6/18 재시작.
- **06-11~12 Helius quota 사건** — 일 25% 소모 → seed cooldown fix (`e8a9ab9`) → 대시보드 실측으로 free 1M 플랜 확정, 과금 가설 2개 기각, attribution ledger 검증됨. 추가 결제 보류.
- **06-13 Helius 1M 소진 → 봇 정지** (paper, 자본 위험 0, ~6/24 reset 대기). observe run 조기 분석 (`analysis/coverage-postfix-2026-06-13/FINDINGS.md`): coverage 1.81%→10.7% (Lever 1 기술 성공), pump.fun bonding 65.8% (Lever 2 trigger 충족), 3대 구조 벽 (bonding 관측 불가 / 구독 지연 33% / H-007 holder 시계열 미수집). 결정 프레임: 돈 쓰기 전 H-007a $0 proxy 검정 먼저.
- **07-08 폐기 vs 재개 평가** — 엔지니어링 저력은 증명, edge 저력은 미증명·부정 증거 누적. 최종 판단 전 남은 gate를 H-007a 하나로 고정했다. 이 항목은 incident가 아니라 decision-support 기록이며 결과/운영자 결정은 아직 없다.
- **미결 (운영자 결정 대기)**: H-007a $0 검정 / Helius 유료 전환 (신호 + holder 수집 commit 시에만) / Lever 2 (H-007a 신호 확인 후에만) / seedSwaps=0 root cause (P2) / 다음 observe run 승인 / momentum-ops-bot 잔여 폴링 + VPS 비용 유지 여부.

## 3. 전체 이력

세부 근거·수치·자체 QA 이력·백로그 원장은 [`../INCIDENT.md`](../INCIDENT.md) (append-only, 152KB) 참조.
2026-04~05 구간 sprint 상세는 memory topic 파일 (`project_*`) 에도 병행 기록돼 있다.
