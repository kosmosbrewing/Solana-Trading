# Recent + Organic Discovery Upgrade — Design Note

> Status: Phase 2 shared discovery input, 2026-04-17
> Parent: [`docs/exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md) Surrounding Priority #3
> Not a lane — **shared input** that feeds cupsey + migration_reclaim (+ future Tier 2 lanes)

## Thesis

현재 scanner는 Gecko trending + Dex boosts + Helius pool registry 기반이지만, 두 가지 signal dimension에서 약하다:

1. **Recent** — pool 생성 < 30분 된 pair가 priority에서 밀린다. 사명(convexity) 관점에서 가장 큰 winner는 "갓 졸업한 fresh" 구간에 몰려 있다 (Cupsey 프로필: p50 hold 25s, winner는 첫 몇 분 안에 찍힘).
2. **Organic** — manufactured pump (whale-only buy, concentrated liquidity)와 자연 매수세를 구분하지 않는다. `buy_ratio`가 높아도 whale 1-2명이 만든 flash면 winner로 가지 못한다.

## Scope

이 문서는 **설계 note**이며 구현은 후속 PR. 현재 작업(Phase 2 migration lane live)에 blocking 아니다.

## Design

### Recent Score

pool 생성 시점(`poolCreatedAtSec`)을 기준으로 decay score 산출:

```
recentScore = max(0, 1 - age_min / 60)
// 0min → 1.0,  30min → 0.5,  60min → 0.0
```

이 값을 기존 scanner의 priority queue 정렬에 **가중**으로 추가. Replace 아니라 boost.

### Organic Score

3개 서브 지표의 조합:

| 지표 | 목적 | 계산 |
|---|---|---|
| `whaleConcentration` | 상위 5 tx가 전체 buy volume의 > 70%면 manufactured | 최근 1분 내 swap의 sorted buy volume top 5 / total |
| `buyerDiversity` | distinct buyer count가 low면 concentrated | unique buyer address count (최근 3분) |
| `sellBuyBalance` | 극단적 buy-only (sell 0)면 honeypot 의심 | `min(buyVolume, sellVolume) / max(...)` |

```
organicScore = 1.0
             * (1.0 - whaleConcentration)
             * min(1.0, buyerDiversity / 10)
             * sellBuyBalance^0.5
// 0 ~ 1, 1이 가장 organic
```

### Integration Point

- `scannerEngine.ts` — trending/boosts candidate enrichment 단계에 `recentScore`, `organicScore`를 계산 후 metadata에 붙임
- `realtimeEligibility.ts` — gate 평가 시 `organicScore < threshold` 면 reject
- `cupseySignalGate.ts` / `migrationHandoffReclaim.ts` — 두 lane의 signal gate에서 shared input으로 참조

### Config

```
DISCOVERY_RECENT_BOOST_ENABLED=true
DISCOVERY_RECENT_DECAY_MIN=60
DISCOVERY_ORGANIC_MIN_SCORE=0.30
DISCOVERY_ORGANIC_WHALE_CAP_PCT=0.70
DISCOVERY_ORGANIC_MIN_BUYERS=5
```

## Implementation Phases

1. **Phase A**: score 산출 (read-only, 기록만). 1주일 누적해 분포 확인
2. **Phase B**: gate 편입 (organicScore < 0.3 = reject). cupsey/migration 모두 적용
3. **Phase C**: ranking boost (recentScore × organicScore를 scanner priority로)

Phase A는 저위험 (gate 영향 없음), Phase B는 false-negative 리스크 검증 필요 (7일 paper 관측 후 결정).

## Out of Scope (명시)

- KOL wallet tracking 통합 (이미 별도 track)
- Social signal (Twitter/X) 통합 (W4 optional backlog)
- LaunchLab 졸업 구분 (migration_reclaim detector 후속 작업)
- Phase A 이전의 실시간 live gating

## Dependencies / Blockers

- Patch A/B1 VPS 배포 완료 (Phase 0 closure)
- migration_reclaim lane paper 검증 (Phase 2 완주)
- Discovery score는 **cupsey/migration 양쪽 gate에 동시 주입**되므로, 잘못된 score 계산이 두 lane 모두 동시에 영향. Phase A read-only 관측이 필수 선행.
