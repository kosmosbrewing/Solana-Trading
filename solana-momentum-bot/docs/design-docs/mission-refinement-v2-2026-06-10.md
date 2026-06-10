# Mission Refinement v2 — 생존 우선 재정의 (2026-06-10)

> Status: **adopted** (운영자 선언, 2026-06-10)
> Supersedes (강조 변경): `mission-refinement-2026-04-21.md` — 원 문서의 gate/guard 는 전부 유지
> Retires: `option5-kol-discovery-adoption-2026-04-23.md` 의 Discovery 가설 (edge audit 판정)
> Evidence base: `analysis/edge-audit-2026-06-10/EDGE_AUDIT_REPORT.md`

## 1. 운영자 선언 (요지)

> 1 SOL → 100 SOL 인생역전 봇이 원래 꿈이었지만, 내가 정말 원하는 건 한 번 크게 먹는 봇이 아니라
> **시장이 바뀌어도 살아남고, 손실을 제한하고, 기회가 올 때만 들어가고, 장기적으로 기대값을 쌓는 봇**이다.
> 현재 예산으로 상위 스나이핑 봇과 같은 무기로 싸우는 건 구조적으로 불가능하다.
> 우리는 빠른 봇이 아니라 **쉽게 죽지 않는 봇**을 만든다.

## 2. 예산 제약 (hard constraints)

| 항목 | 한도 | 비고 |
|---|---|---|
| Helius API | **≤ $50/월** (Developer tier 유지) | 직전 cycle 실사용 13% — 저빈도 설계와 양립 |
| VPS | $8/월 | 유지 |
| 운용 예비금 | **$1,000 (동결)** | `OFFLINE_COHORT_FOUND` + mirror 검증 전 투입 금지. 투입/ticket 상향은 별도 ADR |

## 3. 목표 재정의

**폐기**: "1→100 SOL 을 빠르게" — 100 SOL 은 계속 tail outcome 으로만 관찰 (v1 과 동일), 단 이제 "빠르게" 도 명시 폐기.

**채택 (우선순위 순)**:
1. **손실을 통제하는 봇** — Real Asset Guard + admission veto (실측: veto 가 +0.66 SOL 보존. 손실 통제는 이미 작동했고, 부족했던 것은 edge)
2. **데이터를 쌓는 봇** — 측정 가능한 상태(candle coverage 수리)로 신선 데이터 적립
3. **작은 금액으로 실전 검증되는 봇** — micro-canary protocol (기존 gate 그대로)
4. **반복 가능한 승리 조건을 찾는 봇** — chronological OOS + promotion gate 기계 재사용

## 4. 구조 논거 — 왜 이 방향이 예산과 정합한가

Edge audit 이 실측한 사망 원인은 "속도 부족" 그 자체가 아니라 **고정비 × ticket 크기**였다:

- break-even latency 음수 (0초 체결로도 불가) → latency 군비경쟁 참전 자체가 무의미
- 왕복 고정 실행비 0.0027 SOL — ticket 0.02 에서 **13.5%**, 0.1 에서 2.7%, 0.25 에서 ~1.1%
- token-only 본전 / wallet −1.128 SOL — 손실 전액이 비용 구조

따라서 **저빈도 × 엄격한 ex-ante 필터 × (검증 후) 더 큰 ticket** 은 스타일 선호가 아니라 실측된 사망 원인의 직접 제거다. 저빈도 전략은 Helius Developer tier 로 충분하다.

## 5. 데이터가 주는 경고 — "늦더라도 안전하게"의 함정 3개 (신규 lane 설계 입력)

KOL-trigger universe (21d, n≈2,060) 에서 이미 기각된 "안전한 후행 진입" 형태:

1. 합의 대기 = 후행 장치 (multi-KOL consensus 일수록 악화: 2-KOL −64.5% / 3+ −68.1% @30min)
2. 늦은 진입 = bleed 노출 (T+1800 median −48%)
3. 낙폭 매수 (rebound) 기각 — 전 drawdown 구간 forward median 음수, chrono sign-stable

단서: 위는 전부 **KOL-trigger universe** 측정치다 (audit errata §8-4). quality-filter 통과 + 생존 토큰 universe 는 미측정 — 신규 lane 의 검증 대상이며, "필터 = 안전" 이 아니라 **ex-ante segment 의 양수 기대값을 직접 증명**해야 한다.

## 6. 변하지 않는 것 (재확인)

- wallet floor **0.6 SOL** / drift halt 0.2 / max concurrent 3 / security hard reject — 변경 없음
- promotion gates (N≥100 / active days≥5 / chrono OOS / wallet-stress / paired mirror≥30 / sign agreement≥85%) — **완화 불가**
- wallet delta 만 ground truth / raw paper headline 은 승격 증거 아님
- live 재개는 gate 통과 cohort 발견 + 수동 micro-canary review 만

## 7. 실행 구조

```
Discovery (교체):  KOL-follow → quality-filtered survivor momentum
                   (설계: docs/design-docs/survivor-momentum-lane-design-2026-06-10.md)
Measurement (유지): coverage repair lever 1 + telemetry (observe run 가동 중, D+7 측정)
Promotion (유지):   offline → paper N≥100 → mirror → micro-canary
Guard (유지):       Real Asset Guard 전체
```

## 8. 이 결정을 뒤집을 조건

- 신규 lane 이 offline + paper 에서 연속 기각되고 대체 가설이 없을 때 → 프로젝트 동결/종료 검토 (비용 $58/월의 정당성 소멸)
- 예산 제약 변경은 운영자 명시 선언으로만
