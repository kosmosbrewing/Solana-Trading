# Project Goals & Persona (post-pivot, refined 2026-04-21)

> Updated: 2026-05-06
> Authority chain: [`SESSION_START.md`](./SESSION_START.md) / [`MISSION_CONTROL.md`](./MISSION_CONTROL.md) (current operating override) → [`mission-refinement-2026-04-21.md`](./docs/design-docs/mission-refinement-2026-04-21.md) (historical refinement) → [`mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md) → 본 문서
> Pre-pivot snapshot: [`docs/historical/pre-pivot-2026-04-18/PROJECT.md`](./docs/historical/pre-pivot-2026-04-18/PROJECT.md)

## Persona

### 운영자
- 1인 개발자, 자동화 수익 파이프라인을 축적하는 CTO
- Solana 트레이딩 봇은 여러 자동화 시스템 중 하나
- 24/7 무인 운영 전제, 수동 개입 최소화
- 리스크 성향: convexity 추구 + wallet 기준 하한선 고정 (current operating floor `0.6 SOL`)

### 봇
- 이름: Solana Momentum Bot
- 역할: Solana DEX meme/event 토큰의 **순수 실전형 momentum/sniper** 자동화
- 운영 원칙: 설명 가능성보다 convexity, 그러나 security 절대 타협 없음

## 목표

### 최종 성공 기준 (2026-04-21 refined)

> **현재 운영 floor 0.6 SOL 을 깨지 않고 200 live trades 를 통과하며, 5x+ winner 분포를 실측했다.**

100 SOL 도달은 **tail outcome — 관찰 변수이지 KPI 가 아님**. 100 SOL 을 달성 못해도 Stage 4 통과하면 프로젝트는 **기술적 성공**.

원 사명 정제 문서는 0.8 SOL floor 로 작성됐고 2026-04-28에는 0.7 SOL로 낮췄지만, 2026-05-14 이후 실제 운영 기준은 `SESSION_START.md`의 0.6 SOL floor 를 따른다.

### 4단계 Maturity Gate

| Stage | 통과 기준 |
|-------|----------|
| 1. Safety Pass | 48h drift < 0.01 / survival filter pass >= 90% / 0.6 floor 무위반 |
| 2. Sample Accumulation | 100 live trades / max DD < 30% / wallet stop 0회 |
| 3. Winner Distribution | 5x+ winner >= 1건 실측 |
| 4. Scale Decision | 200+ trades / lane log growth > 0 / ruin probability < 5% |

### 구체적 목표 (Stage 진행 중 행동 원칙)

1. Pool coverage를 최대한 넓힌다 (DEX / pair eligibility 우선).
2. WS 초봉 / 마이크로캔들에서 거래량 급증 + buy pressure + tx density + 최소 price acceleration 으로 진입 판단한다.
3. Loser는 빠르게 정리, winner는 최대한 길게 보유한다.
4. 평균 수익률보다 5x/10x winner 빈도를 중시한다.
5. Wallet truth 기준으로만 측정하고, DB pnl 단독 판정은 하지 않는다.
6. **Survival Layer (rug / honeypot / Token-2022 / top-holder) 가 모든 다른 edge 보다 선행** (2026-04-21).

### 비목표 (post-pivot)

- 설명 가능한 진입 비율 최대화
- attention / context score 정교화
- 5분봉 확인형 전략 (`volume_spike`, `fib_pullback`)
- backtest edge score 최적화
- 마켓 메이킹
- 실전 괴리를 무시한 백테스트 최적화

## 전략 모델 (post-pivot)

### 진입 철학

```text
pool coverage 확장
  -> WS 초봉 / 마이크로캔들 burst 감지
     (volume accel + buy ratio + tx density + price accel)
  -> hard safety check (security / liquidity / exitability)
  -> immediate PROBE entry
```

"왜 오르는가"보다 "지금 실제로 폭발하는가"를 본다.
Attention / context score는 hard reject로 **사용하지 않는다**.

### 보유 / 청산 철학

```text
loser   : quick cut (fast hard-stop + short time-boxed expiration)
winner  : tiered runner (2x / 5x / 10x 별 trailing 완화 + long hold)
baseline: cupsey_flip_10s는 기존 구조 그대로 유지 (benchmark)
```

## 유지 항목 (hard safety — 사명 변경 불가)

- Security hard reject (top-holder %, mint/freeze authority, honeypot sim)
- 최소 liquidity / quote sanity
- Exitability 확인
- Duplicate / race 방지 (Patch A: STALK→PROBE reentrancy guard, Patch B1: close mutex)
- HWM / price sanity bound (Patch B2: cupseyMaxPeakMultiplier = 15x)
- Wallet Stop Guard `< 0.6 SOL` halt
- RPC fail-safe halt (연속 RPC 실패 → lane halt)
- Entry integrity (`persistOpenTradeWithIntegrity` 모든 lane 필수)
- Wallet truth accounting (executed-buys/sells.jsonl + FIFO reconcile)

## 현재 상태 스냅샷 (2026-05-06)

### 확인된 것

- **유일한 truth**: wallet delta. DB pnl 단독 판정 금지.
- **Active main lane**: `kol_hunter_smart_v3` live canary + paper arms.
- **Auxiliary lanes**: `kol_hunter_rotation_v1` paper-first fast-compound with promoted `rotation_chase_topup_v1` live canary only, `pure_ws` new-pair paper/observer.
- **Frozen benchmark**: `cupsey_flip_10s` disabled, 개조 금지.

### 아직 미증명인 것

- smart-v3 live canary의 200-trade survival/tail distribution.
- rotation-v1 arm별 post-cost expectancy 및 sell-follow/partial-exit edge.
- pure_ws new-pair paper lane의 신호 밀도와 T+ continuation.

## 로드맵 (post-pivot, 2026-04-21 현재 상태)

| Block | 목표 | 현재 상태 |
|---|---|---|
| Block 0 | Mission Pivot 문서화 | **완료 (2026-04-18)** + refinement 반영 (2026-04-21) |
| Block 1 | Wallet ownership + always-on comparator (P0) | **완료 (2026-04-18)** |
| Block 2 | Coverage expansion (DEX / pair eligibility) | **완료 (2026-04-18)** |
| Block 3 | `pure_ws` new-pair paper/observer lane | **진행 중 — evidence 수집** |
| Block 4 | Live canary with guardrails | **완료 (2026-04-18)** |
| DEX_TRADE Phase 1-3 | v2 burst detector + viability floor + quickReject / holdPhase sentinel | **완료 (2026-04-18)** |
| Post-deploy fix 1 | wallet delta drift (cupsey/migration/pureWs entry metrics), orphan close loop | **완료 (2026-04-18~20)** |
| Post-deploy fix 2 | entry drift guard / dual price tracker / V2 telemetry / v1 cooldown / canary auto-reset | **완료 (2026-04-19~21)** |
| Block 5 — Survival Layer (P0 다음) | rug / honeypot / Token-2022 / top-holder / LP lock gate | **다음 P0 (2026-04-21 refinement 지정)** |
| Block 6 | Tiered runner tuning | 미시작 (Stage 3 의 5x+ winner 실측 이후 조건부) |

### 4단계 Maturity Gate 현황

| Stage | 통과 기준 | 현 상태 |
|-------|---------|--------|
| 1. Safety Pass | 48h 운영 / drift 정상 / survival filter pass / 0.6 floor 무위반 | **진행 중** — lane별 evidence report 기준 |
| 2. Sample Accumulation | 100 live trades / max DD < 30% / wallet stop 0회 | 미진입 — Stage 1 통과 후 |
| 3. Winner Distribution | 5x+ winner >= 1건 실측 | 미진입 |
| 4. Scale Decision | 200+ live trades / lane log growth > 0 / ruin probability < 5% | 미진입 |

### Hard Guardrails (pivot 불변 — Real Asset Guard)

| 가드 | 값 |
|---|---|
| Wallet Stop Guard | `wallet_sol < 0.6` 전 lane halt |
| Canary cumulative loss cap | `-0.3 SOL` (lane별) |
| Fixed ticket | default `0.01 SOL`, KOL `0.02 SOL` canary |
| Max concurrent ticket | `3` 전역 |
| RPC fail-safe | 연속 RPC 실패 → lane halt |
| Security hard reject | mint/freeze authority, honeypot sim (Survival Layer 구현 시 확장) |

`50 trades` 는 가드가 아니라 **safety checkpoint (관측 전용)**. `100 trades` = preliminary check, `200 trades` = scale/retire decision gate. 상세: [`MEASUREMENT.md`](./MEASUREMENT.md).

## 인프라

| 구성 | 선택 |
|------|------|
| VPS | Vultr (US East) |
| OS | Ubuntu 22.04 LTS |
| RPC | Helius (Developer tier — sniper 경쟁 시 재검토 필요) |
| DB | TimescaleDB |
| DEX execution | Jupiter |
| 알림 | Telegram |
| 프로세스 관리 | pm2 |

## 측정 프레임

[`MEASUREMENT.md`](./MEASUREMENT.md) 참조.
기존 `Mission / Execution / Edge Score`는 retire 되었고, wallet log growth + winner distribution + ruin probability 로 교체되었다.
