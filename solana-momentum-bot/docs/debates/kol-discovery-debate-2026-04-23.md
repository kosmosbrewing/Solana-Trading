# Debate — KOL Discovery 채택 대담

> Status: **Active** (Phase 2 shadow eval 완료 시 archive 또는 새 Round 추가)
> Related ADR: `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`
> Related docs: `LANE_20260422.md`, `20260423.md`, `KOL Signal Layer v1.0` (운영자 초안)
> Append-only. 기존 내용 삭제 금지. 새 iteration 은 날짜 stamp + Round N 으로 추가.

---

## Round 1 — 2026-04-23 (initial adoption)

### 1.1 발단 — 운영자가 던진 3개 질문

**Q-1 (09:30 대담 초반)**
> "최근 몇 주만 Asteroid, MAGA, Belief, BULL 등 엄청나게 많은 기회가 있었던 것 같은데 우리는 무엇을 쫓고 있는거야?"

**Q-2**
> "친구야 애초에 우리가 죽은 유동성에서 노는건 아니야?"

**Q-3**
> "Helius API 말고 근본적으로 Brave API 나 다른 부가 정보를 붙여야 알파가 발생하지 않나."

### 1.2 AI 진단 요약

세 질문은 동일 root cause 를 지적:
- 현 Discovery layer (Helius pool discovery + V2 detector) 가 구조적으로 dead liquidity 에 편향
- 살아있는 시장 (ASTEROID / MAGA 급) 은 on-chain only 로는 2nd-wave 조차 감지 어려움
- Alpha 의 80% 는 Narrative + Smart Wallet. 우리는 20% (on-chain) 만 보는 중

**근거 인용**:
- `20260423.md §2` — Dead liquidity 4 증거
- 2026-04-22 12h 로그: V2 PASS 3180 / 고유 pair 2 / survival 통과 2%
- Scanner watchlist 에 ASTEROID 등 올라왔으나 V2 PASS 0건
- missed-alpha.jsonl 53 records, `deltaPct p50 = −92%`

### 1.3 AI 제안 Path 4가지 (이전 세션)

| Path | 내용 | AI 판단 |
|------|------|---------|
| A. pure_ws 재설계 (same lane) | PROBE 30s → 2-5min 확장 등 | 리스크 중 |
| B. 별도 long-horizon lane 신설 | trend_hold_30min | **추천** |
| C. LP sniper 복구 | pump.fun graduate snipe | Tier B 완성 전 금지 |
| D. 기다림 (관측 우선) | observer 1-2주 | 현 default |

### 1.4 운영자 반론 (핵심)

> "나는 솔직히 옵션 5 고려하고 있어, 내가 DEX 트레이딩에 대한 경험이 있고 이해도도 있는 입장에서 최근의 전략을 지켜봤지만, 이건 도저히 사명 달성 가능성이 없다고 봐도 무방할 것 같아, 하지만 트레이딩 전략에 대한 부분은 내가 배워야 할 점이야, 그래서 절충하고 싶어, **토큰을 거르고 전략을 선정하는 것에 대한 부분은 KOL 전략을 추종하되 트레이딩 전략은 우리의 것을 준용**하는 것이야."

**운영자 의도 분해**:
- **"도저히 사명 달성 가능성 없다"**: 현 pure_ws paradigm 은 폐기 수준
- **"배워야 할 점"**: Execution 은 본인 약점 영역 → 시스템에 위임
- **"토큰 거르기 = KOL"**: Discovery 는 본인 강점 영역 (KOL DB 수동 정제 경험)
- **"전략은 우리 것 준용"**: 자체 state machine + Real Asset Guard 유지

### 1.5 AI 품평

#### 방향 동의 ✅
- 역할 분업 (Discovery ↔ Execution) 이 사명 §2.1 "실험 시스템" 과 정합
- 운영자의 "죽지 않는다" 본능 + 시스템의 discipline 결합이 가장 건강한 인간-시스템 구조
- KOL DB 가 실제 edge 라면 `20260423.md` Tier 3 (Twitter / Telegram) 도입보다 즉시 ROI 우수

#### 단 한 가지 중요한 보정 ⚠️

> "**우리 트레이딩 전략 준용**" 을 **파라미터까지 그대로** 로 해석하면 반쪽 성공에 그침.

**구분 필요**:
| 항목 | 판단 |
|------|------|
| Real Asset Guard (ticket / floor / canary / drift / survival / sell probe / swap serializer) | ✅ **100% 유지 — 불변** |
| Execution state machine 구조 (PROBE → T1 → T2 → T3) | ✅ **100% 유지 — 구조 불변** |
| Execution 파라미터 (probe window / trail % / threshold) | ⚠ **반드시 재조정** |

**근거**: 현 pure_ws 파라미터는 "Helius dead pool 의 0-30s burst 잡기" 로 tuning 된 것. KOL Discovery 로 바뀌면 Phase 2-3 breakout 포획이 필요하며, 이는 더 긴 probe window + 더 넓은 hardcut + 더 느슨한 quickReject 을 요구함.

**파라미터 유지 시 예측**: KOL signal 이 잡은 winner 를 30s flat timeout 으로 cut 하고, Phase 3 breakout 은 놓침. LANE_20260422 §4.5 의 "설계 convex, 실측 flip-cutter" 가 그대로 재현.

### 1.6 추가 구조 보정 — KOL Layer 의 위치

운영자 초안 문서 (`KOL Signal Layer v1.0`) §4.1 은 KOL 을 "Scanner 뒤의 5번째 Gate" 로 위치시킴.

AI 반론:
- 이 방식은 Scanner 후보 (dead pool) ∩ KOL 진입 토큰 (ASTEROID 등) 의 거의 공집합인 교집합에서만 발동
- **옵션 5 의 올바른 구현**: KOL wallet activity 자체가 **Discovery trigger (1st-class)**. Scanner 우회.
- Scanner → KOL 이 아니라 **KOL → Gate pipeline**

### 1.7 합의 지점 (Round 1 결론)

- [x] **옵션 5 (B형) 채택**: KOL Discovery + 자체 Execution 구조 + 파라미터 재조정
- [x] **Real Asset Guard 전부 불변**
- [x] **Execution state machine 구조 유지**
- [x] **Execution 파라미터는 Lane T (kol_hunter) 에서 재조정**
- [x] **cupsey_flip_10s 동결 유지, pure_ws 는 Lane S 로 격하 가능**
- [x] **KOL 은 1st-class Discovery (Scanner 우회), 5번째 Gate 아님**
- [x] **Phase 2 shadow eval 결과 = first filter (go/no-go)**

### 1.8 열린 질문 (Phase 2 에서 해소 필요)

- **Q-R1**. 한국 KOL DB 의 실제 edge — Phase 1 로깅으로 검증
- **Q-R2**. 한국 KOL 이 ASTEROID / MAGA 의 1st wave 인가 2nd wave 인가?
  - 2nd wave 도 사명 달성 가능 (Phase 2-3 초반 진입 OK)
  - 1st wave 라면 Tier 상위 (S급) 집중 필요
- **Q-R3**. KOL insider exit 문제 재발 가능성 — Phase 2 shadow eval 에서 KOL 평균 hold 분포 확인
  - KOL avg hold < 10분 이면 우리 30min+ hold 전략과 근본 충돌
- **Q-R4**. Multi-KOL 합의가 독립 판단인가 chain forward 인가?
  - Anti-correlation window 10s → 60s-5min 확장 합의
- **Q-R5**. Execution 파라미터 재조정의 구체값 — Phase 3 paper 에서 iterate
  - 초안: probe 30s → stalk 2-5min, hardcut -3% → -10%, T1 +100% → +50%, trail 7% → 15%

### 1.9 문서화 규칙 합의

**3 분리 구조 채택**:
- **ADR** (`docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`) — 영구 결정 근거
- **Debate** (`docs/debates/kol-discovery-debate-2026-04-23.md`, 본 문서) — Q&A append-only
- **Refactoring** (`REFACTORING_v1.0.md`) — Phase 0-5 실행 checkbox
- + INCIDENT.md / MEMORY.md / CLAUDE.md 보조 업데이트

**네이밍**: `REFACTORING_v1.0.md` 유지. paradigm 변경 시 v2.0 신규.

### 1.10 이번 회차 결론

> **옵션 5 (B형) 을 채택한다.**
> **KOL Discovery = 1st-class trigger (Scanner 우회)**, **Execution = 구조 유지 + Lane T 파라미터 재조정**.
> **Phase 0 (KOL DB 정제) 즉시 착수**. Phase 2 shadow eval 결과로 go/no-go 확정.

---

## Round 2 — (미래, Phase 2 shadow eval 결과 리뷰 시)

*Phase 2 완료 후 작성. 아래는 예비 섹션.*

### 2.1 관측 데이터 (Phase 1-2)
- KOL tx 수 / 기간 / active KOL 수
- KOL 진입 후 T+30s, +5min, +30min 가격 분포
- Multi-KOL 합의 케이스 수 vs 결과
- Insider exit (KOL 진입 후 10분 내 sell) 비율

### 2.2 Q-R1 ~ Q-R5 검증 결과
- …

### 2.3 재합의 또는 기각
- Go → Phase 3 착수
- No-go → 옵션 5 기각, 대안 논의 (옵션 4 등)

---

## Round N — 예비

Phase 3 / Phase 4 결과 리뷰 시 추가.

---

## Appendix A — 핵심 근거 수치 (Round 1 기준)

### 2026-04-22 12h 운영 관측
```
Wallet:                0.9972 → 0.9953 SOL (-0.0019, -0.19%)
V2 PASS:               3180 (pair 2개 집중)
Survival gate 통과:    63 / 3180 = 2%
entry_drift_reject:    33 (deltaPct p50 = -92%)
LIVE_BUY:              6
LIVE_SELL:             5 (전부 probe_reject_timeout / flip-cut)
T1 promotion:          0
5x+ winner:            0
missed-alpha records:  53
```

### 7일 누적 ledger (2026-04-16 → 04-22)
```
cupsey 44 trades / net -0.018 SOL / 5x+(net)=1 / 5x+(visit)=?
pure_ws 83 trades / net -0.023 SOL / 5x+(net)=0 / 5x+(visit)=?
누적: 127 trades / net -0.041 SOL / 5x+ = 1 (cupsey only)
```

### 시장 관측 (운영자 report)
- ASTEROID / MAGA / BELIEF / BULL 등 최근 몇 주 내 기회
- 우리 V2 PASS 리스트에 해당 종목 0 건
- Scanner watchlist 에는 올라왔지만 burst 감지 안 됨 (이미 대형 유동성 시장)

---

## Appendix B — 참조 문서 링크

- `docs/design-docs/mission-refinement-2026-04-21.md` — 사명 최상위
- `docs/design-docs/mission-pivot-2026-04-18.md` — convexity pivot
- `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md` — 본 대담의 결론 ADR
- `REFACTORING_v1.0.md` — 실행 계획
- `INCIDENT.md` — 운영 관측 연표
- `LANE_20260422.md` — Lane 구조적 진단
- `20260423.md` — Dead liquidity + trending scalping
- `KOL Signal Layer v1.0` (운영자 초안, 본 대담에서 §4.1 재구성)

---

*2026-04-23 Round 1 — Initial adoption debate, 옵션 5 B형 합의*
