# PLAN2.md

> Updated: 2026-03-30
> Purpose: mission 관점에서 남은 보완 과제를 정리한다.
> Relationship: 상위 원칙은 [`PLAN.md`](./PLAN.md), 현재 운영 판단은 [`PLAN4.md`](./PLAN4.md)를 따른다.

## Verdict

초기 보완 과제 중 다수는 이미 코드에 반영됐다. 현재는 "빠진 기능"보다 "반영된 기능이 실제 live에서 어떤 결과를 만드는지"가 더 중요하다.

### 이미 반영된 항목
- discovery source 다변화
- immediate seed / warmup 단축 경로
- Raydium CPMM coverage
- Security Gate의 Birdeye 의존 제거
- signal audit / gate trace / source attribution 강화

### 아직 남은 항목
- discovery source 품질 튜닝
- skip / blacklist pair의 재유입 관리
- venue-aware cost model의 실측 보정
- Gecko `429`가 cadence 해석을 얼마나 오염시키는지 분리

## What Still Matters

### R1. Discovery quality tuning
- fast discovery 경로는 구현됐지만, 실제 live에서 어떤 source가 retained watchlist와 BUY 시그널을 만드는지 더 봐야 한다.
- focus:
  - source별 retained 비율
  - source별 signal 생성 비율
  - blacklist / unsupported venue 재유입 비율

### R2. Admission churn control
- `unsupported_dex`, `unsupported_pool_program`, `non_sol_quote`는 완전 제거보다 반복 점유 억제가 중요하다.
- 남은 과제:
  - skip된 token/pair cooldown
  - blacklisted pair의 scanner 재점유 분리

### R3. Venue-aware cost realism
- 현재 live blocker 후보는 `poor_execution_viability`다.
- 남은 일:
  - 실거래 기준 round-trip cost 실측
  - `rewardPct` / `riskPct` raw 구조 확인
  - venue별 impact / fee model 보정 필요 여부 판단

### R4. Measurement before tuning
- 최근 패치로 `execution.preGate` / `execution.postSize` telemetry가 저장되도록 보강했다.
- 다음 단계는 threshold 조정이 아니라, 이 telemetry가 실제 BUY 시그널에서 어떻게 찍히는지 보는 것이다.

## What No Longer Needs To Be Reopened

- `PumpSwap excluded`
- `Security Gate` Birdeye hard dependency
- quote endpoint drift
- executor 401
- BUY sizing SOL/token unit mismatch

이 항목들은 historical blocker로 남기고, 현재 active 문제로 다시 올리지 않는다.

## Priority

1. 첫 post-patch BUY 시그널 확보
2. `preGateRR` vs `postSizeRR` 비교
3. blacklist pair 재유입 억제 필요성 확인
4. 실거래 cost 보정
5. 이후에만 RR / TP2 / blacklist 파라미터 조정 검토

## One-Line Summary

> 이제 PLAN2의 남은 일은 기능 추가가 아니라, 이미 넣어둔 discovery / admission / telemetry 보강이 실제 live canary에서 어떤 병목을 남기는지 분리하는 것이다.
