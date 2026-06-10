# Phase 0 — Data and Measurement Audit

> Generated: 2026-06-10 (UTC). Audit scope: solone-edge-audit-prompt-2026-06-10.md
> All numbers recomputed from local ledgers after `bash scripts/sync-vps-data.sh` (2026-06-10T04:07Z).
> `npm run check:fast`: 206 suites / 2087 tests PASS.

## 0.1 Process Freshness

| Check | Result |
|---|---|
| `pm2 list` (VPS 104.238.181.61) | `momentum-bot` **stopped** (pid 0, uptime 0) / `momentum-ops-bot` online 19d |
| Trading ledger last write | 2026-05-22T00:19:58Z (kol-paper / rotation-paper) |
| Live ledger last write | 2026-05-20T10:11:41Z (kol-live / rotation-live) |
| Fresh 24h live/paper trade rows | **0** |
| `logs/bot.log` tail | TelegramControlBot polling errors only (429/502/timeout), through 2026-06-10T01:11Z |
| Still-appending files | `trade-markout-anchors/markouts` (+10 rows 2026-06-10) — **synthetic test mints (PAIR7 등) written by report self-test into production ledger**, excluded from analysis |

**Conclusion**: 봇은 2026-05-22 이후 거래 0건으로 정지 상태. 어떤 분석도 "current market edge" 를 주장할 수 없다 (stop condition 충족). 분석은 2026-04-30 ~ 2026-05-22 의 historical evidence 판정으로 한정된다.

## 0.2 Core Ledger Inventory

| Ledger | Rows | Unique pids | First closedAt | Last closedAt | Note |
|---|---:|---:|---|---|---|
| kol-live-trades | 328 | 325 | 2026-04-30T02:07Z | 2026-05-20T10:11Z | live aggregate |
| rotation-v1-live-trades | 154 | 151 | — | — | **100% subset of kol-live** |
| smart-v3-live-trades | 114 | 114 | — | — | **100% subset of kol-live** |
| kol-paper-trades | 5,208 | 5,208 | — | 2026-05-22T00:19Z | paper aggregate |
| rotation-v1-paper-trades | 3,761 | 3,761 | — | — | **100% subset of kol-paper** |
| smart-v3-paper-trades | 822 | 822 | — | — | **100% subset of kol-paper** |
| pure-ws-paper-trades | 176 | 176 | — | 2026-05-06T00:29Z | independent |
| executed-buys / executed-sells | 745 / 748 | — | 2026-04-16 → | 2026-05-20 | crash-safe live execution ledger (cupsey era 포함) |
| trade-markout-anchors | 11,300 (10 synthetic 제외) | buy 5,177 / sell 6,113 | 2026-05-02 | 2026-05-22 (실데이터) | |
| trade-markouts | 54,579 | — | — | — | ok rate 96%+ at 30/60/300/1800s |
| missed-alpha | 88,360 (21,293 unique reject events) | — | — | — | ok rate: T+60 34%, T+300 11%, T+1800 11% → **diagnostic only** |
| kol-policy-decisions | 113,654 | — | — | 2026-05-22 | |
| helius-credit-usage | 1,520,689 | — | — | 2026-05-22 | |

### ⚠ MEASUREMENT FINDING M1 — mission-offline-simulator 이중 계산

`mission-offline-simulator` 의 baseline replay 는 aggregate ledger 와 lane projection ledger 를 **함께 합산**한다:

- 보고된 live: 596 rows / **−1.565482 SOL** → 실제 dedup (positionId union): **325 rows / −0.802908 SOL**
- 보고된 paper: 9,967 rows / **+7.878414 SOL** → 실제 dedup: **5,384 rows / +4.239860 SOL**

rotation-v1-live (151) 와 smart-v3-live (114) 의 positionId 는 100% kol-live 에 포함된다 (2026-05-03 lane projection refactor 의 의도된 설계 — simulator 가 이를 dedup 하지 않은 것이 결함).
**판정 방향은 불변** (live 음수, paper 양수의 role 오염) 이지만, 절대값 인용 시 dedup 수치를 사용해야 한다.

### Live wallet-truth 의 세 가지 수치 (정합 확인)

| Source | Closes | Net SOL | 비고 |
|---|---:|---:|---|
| executed-buys/sells (canary report, wallet-entry 기준) | 475 | **−1.127613** | 가장 완전한 live 기록 (2026-04-27+, ledger-only close 포함) |
| kol-live-trades.jsonl dedup | 325 | −0.802908 | close-event ledger (일부 초기/orphan close 누락) |
| offline-sim baseline | 596 | −1.565482 | **이중 계산 — 인용 금지** |

**Live wallet-truth 공식 수치: −1.127613 SOL / 475 closes / win rate 16%** (kol-live-canary-report 2026-06-10, wallet-entry 기준).

## 0.3 Role Audit (dedup 기준)

Paper union 5,384 unique closes, net **+4.2399 SOL**, 그러나 role 분해:

| Role | N | Net SOL | Promotion-comparable? |
|---|---:|---:|---|
| shadow | 2,627 | +2.2930 | ❌ |
| unknown_role | 1,987 | +1.4513 | ❌ |
| fallback_execution_safety | 407 | +0.2894 | △ (execution blockage 설명용) |
| research_arm | 184 | +0.2144 | ❌ |
| probe_policy_shadow | 158 | +0.0645 | ❌ |
| **mirror** (유일한 translation proof) | **21** | **−0.0727** | ✅ — 음수 |
| live (kol-live dedup) | 325 | −0.8029 | ✅ — 음수 |

**판정: paper headline (+4.24 SOL) 은 오염되었다.** 양수 PnL 의 88%+ 가 shadow/unknown_role 에서 나오고, 유일한 promotion-comparable paper role (mirror) 은 음수이며 n=21 < 30. Phase 4 의 contamination 선언 조건 3개 전부 충족.

unknown_role 1,987 rows (37%) 는 paperRole 필드 도입 (2026-05 중순) 이전 행 — 소급 복구 불가, 비승격 처리 유지.

## 0.4 Join Audit

- 분석 전체의 join 은 `positionId` (+ anchor epoch-ms) 기준 = 승격 가능 join method 3.
- markout ok coverage (buy anchors): T+30/60/300/1800 ≈ 96%+, T+15 ≈ 81% (도입 시점 차이), T+180 사실상 없음.
- rotation 승격 후보의 promotion-grade 결격 (offline-sim 재확인): executionPlanHash coverage 0%, comparable role coverage 15.7%, route proof 74.8% — **전부 95% 미달 → 승격 불가**.
- missed-alpha (reject 측): unique 21,293 events 중 T+300 ok 11% → reject-side 장기 forward return 은 **diagnostic only**.

## 0.5 Candle Audit (candle-entry-proof 2026-06-10)

- buy anchors 5,187 중 full (pre60 + T+300) candle coverage: **94 rows = 1.81%**
- 원인: `no_token_candles` 90%+ (세션 후보 token 의 candle 미수집)
- pure_ws family 만 79.75% full coverage (n=63) — 단 pure_ws 는 paper-only lane
- **Stop condition 발동: candle-derived rule 은 전부 diagnostic only. 승격 근거 사용 금지.**

## 0.6 Cost Audit (helius-credit-usage, offline-sim 집계)

총 1,656,941 credits 추정 사용 중:

| Feature | Credits | Share | 판정 |
|---|---:|---:|---|
| helius_ws_fallback_single | 1,048,359 | 63.3% | KILL (promotion-grade 의사결정 기여 0) |
| executor_get_balance | 223,555 | 13.5% | coalesce/cache 필요 |
| token_symbol_resolver | 135,070 | 8.2% | 거래 경로에서 제거 가능 |
| kol_wallet_tracker | 123,510 | 7.5% | bounded research input 으로만 |
| 나머지 (security/pool/decimals 등) | ~126,000 | 7.6% | metered 유지 |

**의사결정 기여 대비 burn**: credits 의 ~77% (fallback + balance polling) 가 승격 evidence 를 생산하지 못했다. 비용 구조 자체가 "수집 ≠ 증명" 상태.

## 0.7 Phase 0 Stop-Condition 판정

| Stop condition | 발동 여부 |
|---|---|
| promotion-grade join coverage < 95% (rotation cohort) | ✅ 발동 — rotation 승격 불가 |
| candle full coverage too low | ✅ 발동 — candle rule diagnostic only |
| fresh 24h rows = 0 | ✅ 발동 — current market edge 주장 금지 |

단, **fatal measurement defect 는 아니다**: 2026-04-30~05-22 구간의 live/paper/markout 데이터는 positionId join 으로 충분히 정합하며, M1 (이중 계산) 은 dedup 재계산으로 교정 가능. Phase 1-7 은 historical evidence 판정으로 진행 가능.
