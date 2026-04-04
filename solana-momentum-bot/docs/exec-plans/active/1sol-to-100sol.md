# Execution Plan: 1 SOL → 100 SOL

> Status: current active execution plan
> Updated: 2026-04-04
> Scope: 구현 완료 이후의 운영 검증, 배포, 표본 축적, live enablement gate
> Archive: 완료된 root plan과 dated canary history는 [`PLAN_CMPL.md`](../../../PLAN_CMPL.md)에 보관한다.

## Role

이 문서는 현재 active execution plan이다.

- 구현 완료 여부를 기록하는 문서가 아니다
- historical canary를 해석하는 문서도 아니다
- 지금 남아 있는 운영 검증과 배포 우선순위를 정하는 문서다

## Current Position

### 이미 완료된 것

- 전략 A/C 코어 + D sandbox + E cascade 배선
- Security / Quote / Execution Viability / Safety / Exit Impact gate 배선
- Risk Tier / Kelly / Demotion / DD Guard / Daily Loss Halt
- realtime persistence / replay / measurement path
- pre-gate / post-size execution telemetry
- v5 RR basis 및 exit 구조 정렬
- scanner blacklist preload / reentry control 보강
- bootstrap trigger (VolumeMcapSpikeTrigger) — breakout/confirm 제거, volume+buyRatio 2-gate
- trigger mode 전환 (REALTIME_TRIGGER_MODE env var)

구현 완료 이력과 canary history는 [`PLAN_CMPL.md`](../../../PLAN_CMPL.md)를 본다.

### 현재 남은 것

- 배포 환경을 안정적으로 유지한다
- paper 표본을 운영 가능한 방식으로 쌓는다
- live enablement 기준을 명확히 통과시킨다
- optional 외부 작업은 운영 핵심과 분리한다

## Workstreams

### W1. Deployment Baseline

목표:
- VPS / pm2 / DB / env가 재현 가능하게 유지된다

체크:
- [ ] `.env` 운영값 점검
- [ ] `deploy:vps` 경로 확인
- [ ] `pm2 status`, `pm2 logs`, Telegram alert 동작 확인
- [ ] TimescaleDB migration / persistence sanity 확인

완료 기준:
- paper runtime을 재기동해도 운영 경로를 다시 설명할 수 있다

### W2. Paper Validation Loop

목표:
- paper에서 충분한 표본과 운영 품질을 확보한다

집중 지표:
- expectancy after fees/slippage
- quote decay
- gate rejection mix
- hold time / exit reason distribution
- explained entry ratio
- bootstrap replay sweep 결과와 live canary가 같은 방향을 가리키는지
- actual-cost accounting 이후 DB PnL과 wallet PnL 차이

완료 기준:
- [ ] `paper-report`로 해석 가능한 표본 확보
- [ ] 운영 노이즈와 전략 문제를 분리할 수 있음
- [ ] live 전환 판단을 문서로 설명 가능

### W3. Live Enablement Gate

목표:
- live를 "기능 확인"이 아니라 "운영 기준 충족 후 전환"으로 다룬다

전환 전 확인:
- [ ] paper 기대값 재확인
- [ ] bootstrap stable baseline (`1.8 / 0.60 / 20`)의 live cadence 확인
- [ ] operator blacklist runtime hit / false block 여부 확인
- [ ] live buy actual-cost accounting이 wallet delta와 크게 어긋나지 않음
- [ ] risk guard / halt / wallet limit 정상
- [ ] quote / sell impact / execution telemetry 해석 가능
- [ ] 운영 개입 없이 일정 시간 유지 가능

완료 기준:
- live enablement를 yes/no로 판정할 근거가 준비됨

### W4. Optional External Backlog

이 항목들은 active 핵심이 아니다.

- X Filtered Stream 실연동
- Strategy D listing source 확대
- 추가 social/discovery source 실험

원칙:
- core validation을 밀어내지 않는다

## Operational Rules

### Do

- active 판단은 이 문서와 [`OPERATIONS.md`](../../../OPERATIONS.md)를 기준으로 본다
- historical 근거가 필요하면 [`PLAN_CMPL.md`](../../../PLAN_CMPL.md)를 참고한다
- 파라미터 튜닝보다 운영 관측성과 표본 품질을 먼저 본다
- replay sweep 결과는 live canary 후보 압축용으로 쓰고, 실운영 증거와 혼동하지 않는다

### Do Not

- archive 문서를 current plan처럼 읽지 않는다
- 과거 canary 메모를 현재 상태 요약에 다시 복붙하지 않는다
- optional backlog를 core validation보다 앞세우지 않는다

## Exit Criteria

현재 active plan은 아래 중 하나가 되면 종료한다.

1. paper / live enablement 기준이 명확히 충족된다
2. 운영 검증 결과를 바탕으로 새 active plan이 필요해진다
3. 현재 문서의 체크리스트가 모두 archive 가능한 상태가 된다

## One-Line Summary

> 구현은 대부분 끝났고, 지금 active work는 bootstrap stable baseline과 operator blacklist를 포함한 운영 검증, 그리고 live enablement 기준을 정리하는 것이다.
