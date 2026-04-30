# KOL Big-Loss 차단 4-Track Roadmap (2026-04-29)

> 사용자 직관 — **"큰 손실만 방지해도 사명 §3 달성에 유리"** — 정량 시뮬로 검증된 IDEAL +84% improvement 를 점진적으로 도달하는 단계별 인프라 구축 계획.

## 1. Background — Why this plan

### 1.1 데이터 (paper-only n=438, 2026-04-25 ~ 04-28)

| 지표 | 값 |
|------|-----|
| Cum net | +0.201 SOL |
| Win rate | 28.3% (124/438) |
| 5x+ winner (mfe ≥ +400%) | **1건** (DF7DAPat, mfe 940%, 1KOL_lowS cohort) |
| **Big losers (netPct ≤ -20%)** | **51건 (12%)** / cum **−0.170 SOL** |
| 모든 loser cum 의 big-loser 차지 | **41%** |
| 모든 winner cum 대비 big-loser abs | 28% |

### 1.2 Big-loss 공통 패턴 (51건 / cum −0.170 SOL)

| Pattern | 분포 |
|---------|-----|
| Exit reason | **probe_hard_cut 51/51 (100%)** |
| MFE peak | **mfe<1% 가 65%** (33건) — 한 번도 안 오른 entry |
| Hold time | p25=12s, p50=24s, p75=45s — **88%가 60초 안 cut** |
| MAE 평균 | **−29%** (임계 −10% 도달 시 이미 깊은 dump) |
| Cohort | 1KOL_lowS 57% (29건) |
| Arm | smart_v3 82% (42건) |

### 1.3 IDEAL 시뮬레이션

| 시나리오 | cum_net | Δ vs baseline | 5x 보존 |
|---------|---------|--------------|--------|
| 현재 baseline | +0.201 | — | 1 |
| **IDEAL — 모든 big-loss 51건 차단** | **+0.370** | **+84%** | **1 (보호)** |
| mfe<1% 200건 차단 | +0.461 | +129% | 1 |
| 1KOL_lowS ticket × 0.5 (사용자 직전 제안) | +0.165 | **−18%** | 0.5 |

→ 사용자 직관 **정확** — big-loss 차단 시 cum +84%, 5x winner 보호. 단 1KOL_lowS ticket 축소는 winner 동반 차단으로 역효과.

### 1.4 Live canary 1차 반영 (2026-04-30)

최근 live canary ledger 에서는 single-KOL live cohort 가 손실 대부분을 차지했다. 따라서 ticket 축소가 아니라 **single-KOL live 금지 + paper fallback** 으로 반영한다.

| Guard | 값 | 근거 |
|---|---|---|
| `KOL_HUNTER_LIVE_MIN_INDEPENDENT_KOL` | `2` | single-KOL live cohort net negative |
| Yellow-zone live gate | 0.75~0.85 SOL 조건 강화 / 0.70~0.75 SOL paper fallback | floor 0.7 보호 |
| Canary budget hydration | restart 시 `executed-sells.jsonl` replay | budget reset hole 차단 |
| Daily report | `npm run kol:live-canary-report` | live/paper divergence 추적 |

### 1.5 직관 vs 현 P0/P1/P2 효과 격차

| Sprint | cum 효과 | IDEAL 달성률 |
|--------|--------|---------|
| P0-C high-risk KOL ticket × 0.5 | −2 ~ +3% | <5% |
| P1 same-token cooldown | +13% | 15% |
| P2 hard_cut 임계 변경 | 시뮬 invalid (hold-side 가정 부재) | 미상 |
| **Combined P0+P1+P2** | **+10%** | **12%** |
| **IDEAL** | **+84%** | 100% |

### 1.6 Critical gap — Entry-time predictor 부재

| Entry-time signal | mfe<1% rate (baseline 46%) | 예측력 |
|---|---|---|
| kolScore < 3 | 47% | random |
| score ≥ 3 | 45% | random |
| indep=1 | 45% | random |
| indep≥4 | 43% | random |
| TOKEN_2022 flag | 42% | random |
| EXIT_LIQUIDITY_UNKNOWN | 42% | random |

→ **현재 데이터로는 mfe<1% 200건 (전체 46%) 의 entry 시점 식별 불가**. 이게 12% limit 의 root cause.

---

## 2. 4-Track Roadmap

### 🔴 Track 1 (즉시) — Same-token Re-entry Cooldown

**근거**: 시뮬 +13%, 의존성 0, 5x winner 보호 ✓

| Item | 내용 |
|------|------|
| 코드 | `kolSignalHandler.ts:resolveStalk` 진입 직전 cooldown check |
| Default | `KOL_HUNTER_REENTRY_COOLDOWN_MS=1800000` (30분) |
| 회귀 테스트 | 같은 mint 30분 안 재진입 차단 / 다른 mint 무관 / cooldown 경과 후 재진입 OK |
| 효과 | paper +0.026 SOL (multi-loss mints 5개 차단) |
| LOC | ~80 |
| 일정 | 1-2일 |
| IDEAL 달성률 | 12% → **25%** |

### 🟡 Track 2 (단기, 1-2주) — Token-quality Real-time API

**근거**: mfe<1% 200건 (root cause) entry 시점 식별. 현재 entry-time signal random.

| Sub-task | 내용 |
|---------|------|
| 2A | Birdeye / Helius wash detection API 평가 (uniqueTraderCount, creatorBundle, launch24h liquidity) |
| 2B | `tokenQualityGate.ts` 신규 모듈 (Phase 3 stub 대체) |
| 2C | entry path 에 `if (!tokenQuality.passed) reject` 추가 |
| 2D | 회귀 테스트 (wash mock / bundle mock / unique trader low → reject) |
| 2E | 24h paper 운영 후 mfe<1% rate 변화 측정 (baseline 46% → 25% 목표) |

| 효과 추정 | IDEAL 25% → **45%** |
| LOC | ~250 + tests |
| 일정 | 1-2주 + 외부 API 비용 결정 |

### 🟢 Track 3 (중기) — KOL-pair Cohort 학습

**근거**: 단일 KOL big_rate 표본 작아 (n=5-90) false positive 위험. KOL pair cohort 가 더 정확.

| Sub-task | 내용 |
|---------|------|
| 3A | KOL-pair cohort builder — 같은 token 진입한 2 KOL pair outcome 누적 |
| 3B | Pair big_rate ≥30% (n≥10) 를 high-risk pair 로 분류 |
| 3C | High-risk pair entry 시 ticket × 0.5 |
| 3D | Daily report 에 pair cohort outcome 표시 |

| 효과 추정 | IDEAL 45% → **60%** |
| 진입 조건 | 200+ trades 누적 (충족) + pair n≥10 표본 사전 측정 |
| 일정 | 1-2주 데이터 누적 후 |

### 🔵 Track 4 (장기) — Tick-level Observer + Live mfe Schema

**근거**: P2 hard_cut 시뮬 invalid 해결 + live 5x winner 정확 측정.

| Sub-task | 내용 |
|---------|------|
| 4A | `paperPriceFeed.ts` 매 tick (price, time) 을 trade 별 array stash → close 시 ledger dump |
| 4B | live `executed-buys/sells.jsonl` schema 에 `mfePctPeak`, `peakAt`, `troughPct`, `troughAt` 추가 |
| 4C | hard_cut 임계 simulation valid 화 — tick mae trajectory 로 wide 방향 시뮬 가능 |
| 4D | `kol-paper-arm-report.ts` 에 cohort 별 capture rate 정확 계산 |

| 효과 추정 | IDEAL 60% → **80%** |
| 일정 | Track 1+2 완료 후 (인프라 우선순위 낮음) |

---

## 3. 측정 — 매 Sprint 후 IDEAL 달성률 측정

| 단계 | 현재 | T1 | T2 | T3 | T4 |
|------|-----|-----|-----|-----|-----|
| IDEAL 달성률 (목표) | 12% | 25% | 45% | 60% | 80% |
| Paper cum_net (438 trades 기준) | +0.20 | +0.23 | +0.30 | +0.34 | +0.38 |
| Big-loss 51 → 차단 건수 (목표) | 0 | 12 | 28 | 38 | 45 |
| 5x winner 보존 | 1 | 1 | 1 | 1 | 1 |

→ 매 sprint 후 sim script (`scripts/kol-bigloss-sim.ts` 신규 후보) 자동 측정. 회귀/false positive 차단.

---

## 4. 진행하지 않을 것 (false positive 정정)

| 항목 | 이유 |
|------|------|
| Hard_cut 임계 일률 변경 (−7%/−15%) | 시뮬 invalid (hold-side 가정 부재). Track 4 후 정밀 검토 |
| 1KOL_lowS ticket 일률 축소 | 5x winner DF7DAPat 도 1KOL_lowS — 시뮬 −18% 악화 |
| KOL DB manual 분류 단독 entry filter | mfe<1% 예측력 random — Track 2 (token quality) 와 결합해야 정합 |
| Observer dead 회복 | false positive (이미 정상 작동, 2026-04-29 INCIDENT 정정 §3) |

---

## 5. Roadmap 일정

```
Day 0-2   : Track 1 (same-token cooldown)        IDEAL 12% → 25%
Day 2-3   : Track 2A (외부 API 평가)
Day 3-14  : Track 2 implementation               IDEAL 25% → 45%
Day 14-21 : Track 3 (cohort 학습, 데이터 누적)   IDEAL 45% → 60%
Day 21-35 : Track 4 (tick-level + live mfe)      IDEAL 60% → 80%
```

총 5주 sprint.

---

## 6. 사명 §3 phase gate 정합

| 사명 조건 | Track 영향 |
|---------|---------|
| 0.7 SOL floor 유지 | Track 1+2 가 직접 보호 (big-loss 차단 = floor 사수) |
| 200 paper trades | 이미 438건 충족 — Track 3 의 데이터 기반 |
| 5x winner ≥ 1 | paper 1건 ✓, **live 0건** — Track 4 의 live mfe schema 후 정확 측정 |
| ADR + Telegram critical ack | Track 1+2 완료 + live 5x winner 1건 입증 후 작성 권고 |

→ **Track 1+2 완료 시 사명 §3 floor 보호 critical path 충족**. Track 3+4 는 정확 측정 + 추가 5x winner 누적 인프라.

---

## 7. 운영자 결정 노드

| 결정 | 옵션 | 현 권고 |
|------|------|------|
| 즉시 진입 | (A) Track 1 만 (B) Track 1+2 동시 | **(A)** — Track 2 외부 API 평가 1일 후 결정 |
| Track 2 외부 API | Birdeye Premium vs 자체 산출 | 운영자 cost-benefit |
| 사용자 제안 ticket 차등 | 시뮬 −18% | **reject** (winner 차단) |

---

## 8. 분석 무결성 체크리스트 정합

본 roadmap 의 모든 시뮬 결과는 `SESSION_START.md §6-bis` 의 12 항목 체크리스트 통과:
- UTC 기준 ✓
- paper-only vs live mirror 분리 ✓
- wallet axis ✓
- 5x = mfe ≥ +400% 정의 ✓
- single-winner 의존도 별도 ✓
- 시뮬 hold-side 가정 명시 (P2 invalid) ✓
- 외부 claim 직접 검증 ✓
- INCIDENT 정합 ✓

---

*Last updated: 2026-04-29*
*관련 문서: INCIDENT.md 2026-04-29 §3-§4, SESSION_START.md §6-bis*
