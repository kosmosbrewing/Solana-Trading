# PLAN3.md

> Updated: 2026-03-25
> Purpose: `Developer` 업그레이드 이후 live canary 운영 결과를 바탕으로, 실제 mission blocker를 분리 기록한다.
> Scope: 이번 문서는 "왜 0 trade였는가"를 전략 문제가 아닌 gate/data-plane 문제로 재해석하고, 즉시 복구 순서를 정한다.
> Relationship: `PLAN.md`의 mission roadmap, `PLAN2.md`의 architecture/discovery 보강 이후, 실제 운영에서 드러난 blocker를 후속 실행 계획으로 고정한다.

---

## Verdict

이번 6시간 결과의 핵심은 `시그널 부족`이 아니다.

- `realtime-signals = 128`
- `gate_rejected = 128`
- `trades = 0`
- `signal_audit_log FILTERED = 128`

즉 전략 엔진은 후보와 시그널을 만들었지만, **gate input availability failure** 때문에 전량 차단됐다.

한 줄 요약:

> 현재 0 trade는 alpha failure가 아니라 `security source availability + quote endpoint availability` 실패다.

---

## Confirmed Facts

### F1. 전략은 시그널을 만들고 있다

- 운영 결과 기준 realtime signal은 총 `128건` 발생했다.
- 따라서 "전략이 죽었다" 또는 "트리거가 안 나온다"는 해석은 틀리다.

### F2. 실제 blocker는 gate fail-closed다

- `106/128`: `security_rejected: Token security data unavailable`
- `15/128`: `quote_rejected: Quote error: getaddrinfo ENOTFOUND quote-api.jup.ag`
- `7/128`: `security_rejected: Token is freezable`

해석:

- `freezable 7건`은 정상 hard reject다.
- 문제는 `security unavailable 106건`과 `quote DNS failure 15건`이다.

### F3. 현재 코어 security 경로는 Birdeye가 아니라 onchain RPC다

현행 코드 기준:

- `Strategy D` candidate preparation도 `onchainSecurityClient` 사용
- realtime / candle gate path도 `onchainSecurityClient` 사용

코드 근거:

- [src/index.ts](./src/index.ts)
- [src/orchestration/realtimeHandler.ts](./src/orchestration/realtimeHandler.ts)
- [src/orchestration/candleHandler.ts](./src/orchestration/candleHandler.ts)

따라서 운영 로그에서 Birdeye security failure가 보였다면, 아래 중 하나를 먼저 의심해야 한다.

1. 구 PM2 프로세스 또는 stale build
2. 다른 보조 경로의 로그를 core gate failure로 잘못 해석
3. 현행 runtime과 로그 source mismatch

### F4. Quote gate 기본 endpoint는 오래됐다

현행 기본값:

- `JUPITER_API_URL = https://quote-api.jup.ag/v6`

코드 근거:

- [src/utils/config.ts](./src/utils/config.ts)

운영 결과:

- `getaddrinfo ENOTFOUND quote-api.jup.ag`

해석:

- 이건 전략 품질 문제가 아니라 **endpoint / DNS / env drift 문제**다.

---

## What This Means For Mission

### M1. 현재 미션 blocker는 전략이 아니라 data plane이다

지금 상태에서는:

- AttentionScore가 있어도
- breakout trigger가 떠도
- candidate가 watchlist에 들어와도

`Security Gate`와 `Quote Gate`의 입력 부재가 곧바로 `0 trade`로 연결된다.

즉 현재는:

- `Mission Gate`를 아직 평가할 수 없다.
- 이유는 설명 없는 진입을 해서가 아니라, **설명 가능한 진입이 gate 입력 결함으로 전량 막혔기 때문**이다.

### M2. fail-closed 자체는 철학상 맞지만, 운영 경로는 복구돼야 한다

`security data unavailable -> reject`는 보수적 설계로 이해 가능하다.
하지만 운영적으로 이 경로가 과도하게 자주 발생하면, 전략 엔진은 사실상 비활성화된다.

따라서 지금 우선순위는 gate 완화가 아니라:

1. security source availability 정상화
2. quote source availability 정상화
3. 그 뒤에야 gate policy 조정 여부 판단

---

## Required Actions

### R1. Quote endpoint drift 복구

목표:

- `quote-api.jup.ag` DNS failure를 없앤다.

작업:

1. 현재 운영 `.env`의 `JUPITER_API_URL` 확인
2. 코드 기본값과 운영값을 모두 최신 Jupiter 호스트 기준으로 정리
3. quote gate health log를 남겨서 `ENOTFOUND`가 재발하는지 확인

완료 기준:

- `quote_rejected: Quote error: getaddrinfo ENOTFOUND ...` 발생률 `0%`

### R2. Security source null 원인 추적

목표:

- `Token security data unavailable`의 실제 원인을 분리한다.

우선 의심 순서:

1. stale PM2 process / stale dist
2. onchain RPC fetch failure
3. parsed mint account decode failure
4. token account/holder lookup availability 문제

작업:

1. 운영 로그에서 `Onchain security fetch failed ...` 유무 확인
2. `Security data unavailable` 발생 시 어떤 fetch 단계가 `null`을 만들었는지 log detail 추가
3. legacy process (`momentum`) 잔존 여부 점검

완료 기준:

- `security_rejected: Token security data unavailable` 원인 분해가 가능
- `NO_SECURITY_DATA` 비율을 운영 기준으로 해석 가능

### R3. Security gate policy 재검토는 R2 이후

원칙:

- 지금 단계에서 바로 `null security -> soft pass`로 바꾸지 않는다.
- 먼저 source failure를 복구하고, 그 다음에도 비율이 높으면 정책 완화를 별도 검토한다.

이유:

- 지금은 gate 철학보다 input availability가 먼저 망가져 있다.
- source failure를 policy로 덮으면 mission 해석이 오염된다.

### R4. Gate health telemetry를 별도 집계

목표:

- "왜 0 trade인가"를 실시간으로 바로 볼 수 있게 한다.

최소 집계 항목:

- `security_rejected / quote_rejected / risk_rejected`
- `NO_SECURITY_DATA count`
- `quote DNS failure count`
- `freezable / mintable / transfer fee` hard reject count

완료 기준:

- daily summary 또는 별도 health log에서 gate rejection mix 확인 가능

---

## Priority

1. `JUPITER_API_URL` drift 복구
2. `NO_SECURITY_DATA` 원인 추적
3. stale process / stale build 여부 확인
4. gate rejection telemetry 노출
5. 그 다음에만 security gate policy 완화 여부 검토

---

## Non-Goals

- 지금 단계에서 전략 파라미터 재튜닝
- `Security Gate`를 성급하게 soft-pass로 바꾸는 일
- `0 trade = 전략 무효`로 해석하는 일
- quote/security source failure를 alpha 문제로 오해하는 일

---

## One-Line Summary

> 이번 운영 결과는 `전략이 시그널을 못 만든다`가 아니라, `security source null + quote endpoint failure 때문에 gate가 전량 fail-closed 된다`는 것을 보여준다. 다음 작업은 전략 튜닝이 아니라 gate data-plane 복구다.
