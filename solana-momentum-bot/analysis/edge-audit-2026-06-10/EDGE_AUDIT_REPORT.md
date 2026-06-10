# Solone Edge Audit — Final Report (2026-06-10)

```text
Verdict: RETIRE_CURRENT_LIVE
One-line reason: live wallet-truth is negative with P(>0)=0.0000 (475 closes, −1.128 SOL), no cohort
                 passed any promotion gate, and the loss is structural (fixed cost 13.6%/round-trip vs
                 signal whose median edge dies in 60s) — not a tuning problem.
Action: keep bot stopped; archive KOL-follow live strategy (smart-v3 / rotation / broad canary);
        preserve data + simulator; fix the 3 measurement defects found; research a new signal source
        offline-only under the existing promotion protocol.
```

> Authority: `MISSION_CONTROL.md`, `SESSION_START.md`, `mission-reassessment-protocol-2026-05-22.md`
> Phase reports: `analysis/edge-audit-2026-06-10/reports/00..06_*.md`
> 검증: `npm run check:fast` 206 suites / 2087 tests PASS. 신규 live 거래 0, paid API 호출 0.

---

## 1. Executive Summary (3줄)

1. **Live 는 확실하게 음수다**: 475 closes / −1.128 SOL (wallet-entry 기준), bootstrap P(net>0)=0.0000. 손실의 사실상 전액 (−0.85 of −0.85 SOL, clean rows) 이 **거래당 고정 실행비용 0.0027 SOL (ticket 의 13.6%)** 이고, 토큰 가격 레벨 (token-only) 은 본전이었다 — "나쁜 토큰" 이 아니라 "이길 수 없는 비용 구조 위의 고빈도 회전" 이 사인이다.
2. **신호 자체가 실행 가능 horizon 에서 죽어 있다**: 진입 후 median forward +1.3% (15s) → −9.6% (5min) → **−47.9% (30min)**. Multi-KOL consensus 는 오히려 역예측 (2-KOL −64.5%, 3+ −68.1% @30min median). 진입군과 reject 군의 forward 분포가 동일 — gate 의 분리력 0.
3. **5x tail 은 universe 에 실존하나 (≈2.2%/30min) 그 92% 는 시스템 exit (median hold 16s) 이후에 발생** — convexity 설계 (작은 손실 다수 + 큰 승자 보존) 의 후자가 한 번도 작동하지 않았다 (325 live closes 중 T2 1회, T3 0회).

## 2. Evidence Table

| # | 증거 | 값 | 출처 |
|---|---|---|---|
| E1 | live wallet-truth net | −1.128 SOL / 475 closes / WR 16% | kol-live-canary-report (executed ledger) |
| E2 | live dedup ledger net + CI | −0.803 SOL, CI95 [−0.98, −0.62], P(>0)=0.0000 | Phase 6 |
| E3 | 거래당 execution drag | p50 0.00256 / mean 0.00271 SOL = ticket 의 13.6% | Phase 2 |
| E4 | token-only PnL (clean n=314) | **−0.003 SOL ≈ 본전** → 손실 전액이 drag | Phase 2 |
| E5 | entry drift (signal→fill) | median **+10.4%** adverse, p90 +20.7% | Phase 2 |
| E6 | gross forward (token-event dedup, n≈2,046, 21d) | med +0.25% @60s / −9.6% @300s / −47.9% @1800s; T+1800 capped-mean CI **[−12.7, −0.5]** | Phase 1 |
| E7 | multi-KOL consensus | 1-KOL −43% vs 2-KOL −64.5% vs 3+ −68.1% (T+1800 med) — **Option 5 핵심 가설 반증** | Phase 1 |
| E8 | gate 분리력 | 진입 vs viability-reject forward delta ≈ 0 | Phase 3 |
| E9 | admission veto 4종 동시 적용 | saved +1.22 SOL, after-veto live 여전히 음수 | Phase 3 / offline-sim |
| E10 | 5x tail 위치 | T+1800 ≥5x 113건 중 ledger MFE ≥+100% 는 9건 — 92% 가 exit 후 발생 | Phase 1 |
| E11 | payoff 구조 실측 | T1 winner 22 / **T2 1 / T3 0** (325 closes); 승자 +0.037 vs 패자 −0.840 SOL | Phase 3 |
| E12 | paper headline | +4.24 SOL 중 92% 가 shadow/unknown/research (비승격 role); **mirror n=21 은 −0.073, live 와 sign agreement 100%** | Phase 4 |
| E13 | chronological OOS | rotation v2: 4/4 slice FAIL; OOS 통과 cohort 0/탐색 23 arms + 470 cohort labels | Phase 6 |
| E14 | baselines | SOL hold 대비 열위 (P≈1), same-universe random 대비 무차별 | Phase 6 |
| E15 | candle coverage | full 1.81% (no_token_candles 90%) → candle rule 전부 diagnostic only | Phase 5 |
| E16 | Helius credits | 1.66M 중 63% 가 ws_fallback_single, ~77% 가 승격 evidence 미생산 | Phase 0 |
| E17 | live 5x | 1/475 (actual5x=1) — 사명 §3 의 "5x 분포 실측" 은 완료, 답은 "포착 불가" | canary report |

## 3. What Failed (원인 특정 — audit prompt 의 4 분류 기준)

| 분류 | 판정 | 비중 |
|---|---|---|
| ① 신호 자체 무효 | **부분 성립** — 실행 가능 horizon (≥60s 보유) 에서 gross median 음수, consensus 역예측. 단 ≤30s 미세 pop (+1.0~1.3%) 은 실존 | 주원인 A |
| ② gross alpha 있으나 비용으로 소멸 | **부분 성립** — 미세 pop 과 tail-mean 은 양수였으나 fixed cost 13.6%/RT + entry drift +10.4% 가 10배 규모로 압도. break-even latency 자체가 음수 (0s 체결로도 불가) | 주원인 B |
| ③ 측정/승격 방법 오염 | **성립하나 결론 무관** — paper headline 오염 (role 혼합), offline-sim 이중 계산 (M1), token-only 깨진 row 2건, synthetic test row 의 production ledger 오염. 단 이를 전부 교정해도 판정 부호 불변 | 부차 |
| ④ 부분 cohort 생존 | **불성립** — 23 arms × 470 labels 탐색에서 OOS+wallet-stress 통과 0. mirror 는 정확했고 "진다" 를 예측 | — |

근본 구조: **A(신호 수명 60s) × B(왕복 비용 13.6%) × C(tail 의 92%가 exit 후 발생)** 의 3중 자기모순.
빠른 exit 는 B 때문에 필수였고, 빠른 exit 는 C 를 필연으로 만들었고, C 때문에 B 를 회수할 tail 이 없었다.
이 중 하나만 고쳐서는 안 풀린다 — ticket 상향 (B 완화) 은 Real Asset Guard 위반 + 파산 리스크, 장기 보유 (C 완화) 는 T+1800 median −48% 의 bleed 를 연다.

## 4. What Remains Usable (보존 자산)

1. **측정/승격 인프라 전체** — markout 장치 (96% ok coverage), role contract, mirror (sign agreement 100% 입증), offline simulator, gatekeeper, 이 audit 의 event_master. **이 인프라가 0.6 SOL 이 남아있는 이유다.**
2. **데이터 자산**: kol-tx 202k rows / markouts 54k / sessions 47.6M candle rows / missed-alpha 88k — 차기 신호 가설의 무료 백테스트 연료.
3. **Real Asset Guard + 정지 결정 자체** — wallet floor 무위반으로 실험 종료. 자본 보존 성공.
4. **음의 지식 (확정)**: KOL-follow 는 이 비용 구조·ticket 크기에서 불가 / consensus 대기는 후행 진입 장치 / 0.02 ticket 에서 fixed cost 가 모든 미세 edge 를 지배.
5. pure_ws botflow 의 candle coverage 79.75% — 차기 후보 검증 경로의 유일한 정상 측정 lane.

## 5. What Must Be Retired

- `broad_live_canary` (이미 KILL) — **영구 archive**
- `kol_hunter_smart_v3` live 경로 — archive (paper 관측 재개도 권장 안 함: 23 arms 의 snooping 표면적만 증가)
- `kol_hunter_rotation_v1` 전 arm + micro-canary 후보 — QUARANTINE 에서 **archive 로 격하** (OOS 4/4 FAIL, ruin 13.5%)
- KOL consensus (independent KOL ≥ 2) 를 진입 트리거로 쓰는 모든 설계
- `helius_ws_fallback_single` 현 형태 — 재가동 전 hard-cap/재설계 필수
- 승격 근거로서의 raw paper headline (이미 정책화, 재확인)

## 6. Exact No-Cost Next Steps (계속할 경우)

진단 종료. 아래는 구현 권고이며 본 audit 에서는 미실행:

1. **[측정 부채, 코드 수리]** offline-simulator 의 projection ledger dedup (M1) / token-only 깨진 row 2건 (`kolh-live-7vLkpoGr`, `kolh-live-vA8xka9x`) quarantine / report self-test 의 production ledger 오염 차단 (synthetic mint 분리 파일로).
2. **[차기 검증 인프라, API 비용 0]** subscribe-on-candidate: KOL/신호 후보 detect 시 해당 pair 를 WS candle 구독에 동적 추가 → full candle coverage 1.81% → 80%+ (Phase 5). 어떤 차기 가설이든 이것 없이는 또 "측정 불가" 로 끝난다.
3. **[오프라인 신호 연구, 기존 데이터만]** 이 데이터가 지지하는 유일한 미검증 방향: (a) consensus 가 아니라 **최초 KOL 진입 후 15-60s 안에 끝나는 초단기 구조** 는 비용 구조상 불가로 확정됐으므로, (b) **신호를 따라가는 쪽이 아니라 bleed 의 반대편** — T+1800 median −48% 라는 강한 단방향 drift 자체가 정보다 (예: KOL pump 후 decay 를 이용하는 receive-side / capitulation-rebound 계열, 이미 paper lane 존재). kol-tx + markout + sessions 데이터로 **오프라인 검증만** 수행.
4. **[운영]** `momentum-ops-bot` 의 잔여 폴링 점검 (Telegram 429 스팸), VPS 비용 자체의 유지 여부 운영자 결정.

## 7. Kill Criteria (이 결정을 뒤집을 조건)

차기 cohort 가 live 검토 자격을 얻으려면 (기존 protocol 동일, 완화 불가):

```text
오프라인: N >= 100, active days >= 5, chronological OOS pass, wallet-stress net > 0,
          post-cost positive >= 52%, top5 share <= 35%, max loss streak <= 10,
          promotion-grade join >= 95%, leakage PASS
번역:     paired mirror >= 30, sign agreement >= 85%
복귀:     수동 micro-canary review only, 자동 enable 금지, 0.6 SOL floor 불변
```

그리고 **본 audit 의 판정 자체를 뒤집을 조건**: 위 gate 를 통과하는 ex-ante cohort 가 기존 로컬 데이터 또는 무료 forward shadow 에서 발견될 것. 그 전까지 live 재개 금지.

---

## 8. Errata — 2차 적대적 검증 (2026-06-10, 재개 세션)

독립 검증 (전 evidence 재계산 + cache 대조) 결과 **판정 유지: YES_WITH_CAVEATS**. 두 핵심 조건 (live wallet-truth 음수 / 승격 가능 cohort 부재) 은 raw 로컬 데이터에서 정확히 재현됨 (E1, E2 — 독립 bootstrap 2,000 resample 로 CI [−0.99, −0.62], P(>0)=0.0000 재확인). 아래는 정정 사항이며 **어느 것도 판정 부호를 바꾸지 않는다**:

1. **E9 / §5 ruin 수치는 stale run 인용** — 06-07 simulator run (M1 이중 계상 결함 보유, 본 보고서 §3-③ 이 스스로 인용 금지 판정한 그 결함) 기준이었다. 교정된 06-10 run 기준: veto saved **+0.660 SOL** (기존 표기 1.22 의 ~54%), after-veto live **−0.185 SOL** (기존 −0.394), rotation ruin **5.98%** (기존 13.5%). 방향·게이트 결론 (after-veto 여전히 음수, ruin > 0%) 불변.
2. **Phase 1 본문 dedup count "2,114" → cache 기준 2,060.** 또한 kol=2 / smart_v3 의 T+1800 CI 는 본문과 달리 cache 상 **0 을 제외하며 더 음수** ([−33.4, −1.4] 등) — 본문이 자기 증거보다 보수적으로 적혀 있었다 (판정 강화 방향).
3. **E8 (gate 분리력 0) 과 Phase 6 baseline 1 (random entry) 은 diagnostic-grade** — missed-alpha forward 데이터 (ok-coverage 11-34%, Phase 0 이 diagnostic-only 판정) 기반. promotion-grade 인용 금지.
4. **Phase 1 universe 는 post-admission anchors** — "KOL buy 일반" (136,373 events) 이 아니라 시스템 funnel 통과 신호에 대한 판정. "이 시스템으로 KOL 추종 불가" 는 확정이나, KOL 을 신호원 일반으로 폐기하는 주장으로는 본문 표현보다 약한 증거다.
5. **§6 "본 audit 에서는 미실행" 은 이후 사실과 불일치** — verdict (13:28) 이후 같은 날 재개 세션에서 §6-1/2 가 실행됨: M1 dedup fix / token-only sanity clamp / synthetic markout 18 rows quarantine (.bak 백업) / candle TTL 15min + funnel telemetry. 전부 observe-only, 본 판정 산출에 미사용. 연표: `INCIDENT.md` 2026-06-10.
6. 기타: footer 의 산출물 수는 scripts 5 / cache 5 / **phase reports 9** (07, 08 포함) 가 정확. E10 의 113 은 all-anchor 기준 118 (92% 결론 동일). E3 p90 은 dedup 재계산 기준 0.00587 (본문 0.00607).
7. Phase 1 의 요구 segment 축 중 token age / route proof / sell-route proof / token-quality 는 미산출 (데이터 제약) — 본 판정의 load-bearing 증거가 아니므로 gap 으로만 기록.

---

*분석 아티팩트: `analysis/edge-audit-2026-06-10/` (scripts 5, cache 5, phase reports 9). 본 보고서의 모든 수치는 dedup·clean 기준으로 재계산되었으며 출처 phase 를 명기함. §8 errata 는 2차 검증 세션이 추가.*
