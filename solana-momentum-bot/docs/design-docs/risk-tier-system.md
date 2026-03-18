# Risk Tier System — 단계적 리스크 확대

## 개요

EdgeTracker의 edgeState 기반으로 자동 리스크 단계를 조정한다.
트레이드 수가 쌓이고 성과가 검증될수록 리스크 허용 범위가 확대된다.

## Tier 정의

| Tier | 조건 | 트레이드당 리스크 | 일일 손실 한도 | DD 한도 |
|---|---|---|---|---|
| **Bootstrap** | trades < 20 | 1% | 5% | 30% |
| **Calibration** | 20 ≤ trades < 50 | 1% | 5% | 30% |
| **Confirmed** | 50 ≤ trades < 100 | QK ≤3% | 15% | 35% |
| **Proven** | trades ≥ 100 | QK ≤5% | 15% | 40% |

- QK = Quarter Kelly (1/4 Kelly)
- v2 변경: Confirmed kellyCap 6.25%→3%, Proven 1/2→1/4 Kelly + cap 12.5%→5%
- 근거: 마이크로캡 exit-liquidity 부족 시 의도한 리스크 대비 실현 손실이 커질 수 있다. 생존 우선.
- Kelly 활성화 전제: edgeState = Confirmed + kellyEligible = true

## Demotion (강등)

최근 성과가 기준 미달 시 자동 강등:
- Sharpe 급락 또는 win rate 하락 감지
- EdgeTracker가 edgeState를 하향 조정
- 강등 시 리스크 파라미터가 즉시 하위 Tier로 변경

## 관련 코드

- `src/risk/riskTier.ts` — Tier 해석 + 강등 로직
- `src/reporting/edgeTracker.ts` — EdgeState 관리, Kelly 계산
- `src/risk/drawdownGuard.ts` — Peak balance 추적, DD 한도 강제
