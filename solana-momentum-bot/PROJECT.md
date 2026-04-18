# Project Goals & Persona (post-pivot)

> Updated: 2026-04-18
> Pivot decision: [`docs/design-docs/mission-pivot-2026-04-18.md`](./docs/design-docs/mission-pivot-2026-04-18.md)
> Pre-pivot snapshot: [`docs/historical/pre-pivot-2026-04-18/PROJECT.md`](./docs/historical/pre-pivot-2026-04-18/PROJECT.md)

## Persona

### 운영자
- 1인 개발자, 자동화 수익 파이프라인을 축적하는 CTO
- Solana 트레이딩 봇은 여러 자동화 시스템 중 하나
- 24/7 무인 운영 전제, 수동 개입 최소화
- 리스크 성향: convexity 추구 + wallet 기준 하한선 고정 (hard stop `0.8 SOL`)

### 봇
- 이름: Solana Momentum Bot
- 역할: Solana DEX meme/event 토큰의 **순수 실전형 momentum/sniper** 자동화
- 운영 원칙: 설명 가능성보다 convexity, 그러나 security 절대 타협 없음

## 목표

### 최종 목표

> 수단과 방법을 가리지 않고 `1 SOL -> 100 SOL` 달성 확률을 최대화한다.

### 구체적 목표

1. Pool coverage를 최대한 넓힌다 (DEX / pair eligibility 우선).
2. WS 초봉 / 마이크로캔들에서 거래량 급증 + buy pressure + tx density + 최소 price acceleration 으로 진입 판단한다.
3. Loser는 빠르게 정리, winner는 최대한 길게 보유한다.
4. 평균 수익률보다 5x/10x winner 빈도를 중시한다.
5. Wallet truth 기준으로만 측정하고, DB pnl 단독 판정은 하지 않는다.

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
- Wallet Stop Guard `< 0.8 SOL` halt
- RPC fail-safe halt (연속 RPC 실패 → lane halt)
- Entry integrity (`persistOpenTradeWithIntegrity` 모든 lane 필수)
- Wallet truth accounting (executed-buys/sells.jsonl + FIFO reconcile)

## 현재 상태 스냅샷 (2026-04-18)

### 확인된 것

- **Wallet ground truth**: 시작 `1.30 SOL` → 현재 `1.07 SOL` (`-0.23 SOL`)
- **DB drift**: DB pnl 합계 `+18.11 SOL` vs wallet `-0.23 SOL`, drift `+18.34 SOL`
- **유일한 live-proven lane**: `cupsey_flip_10s` (benchmark 유지)
- **Signal source**: `bootstrap_10s` (signal-only, `executionRrReject=99.0`)
- **Dormant**: `volume_spike`, `fib_pullback` (5m 해상도, 밈코인 비적합)

### 아직 미증명인 것

- Pure WS breakout lane의 실제 wallet expectancy
- Coverage 확장 (DEX eligibility) 후의 signal density
- 5x / 10x winner 빈도 (관측 자체가 부족)
- cupsey primary의 wallet ownership 구조 (main vs sandbox executor)

## 로드맵 (post-pivot)

| Block | 목표 | 현재 상태 |
|---|---|---|
| Block 0 | Mission Pivot 문서화 | **진행 중 (2026-04-18)** |
| Block 1 | Wallet ownership + always-on comparator (P0) | 미시작 |
| Block 2 | Coverage expansion (DEX / pair eligibility 먼저) | 미시작 |
| Block 3 | `pure_ws_breakout` lane 신설 (paper first) | 미시작 |
| Block 4 | Live canary with guardrails | 미시작 |
| Block 5 | Tiered runner tuning | 미시작 (조건부) |

### Hard Guardrails (pivot 불변)

| 가드 | 값 |
|---|---|
| Wallet Stop Guard | `< 0.8 SOL` 전 lane halt |
| Fixed ticket | `0.01 SOL` canary |
| Max concurrent ticket | `3` (canary) |
| RPC fail-safe | 연속 RPC 실패 → lane halt |
| Security hard reject | 불변 |

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
