# Paper Validation — 50-Trade 검증 기준

## 개요

Live 전환 전 Paper 모드에서 최소 50 트레이드를 완료하고 아래 기준을 충족해야 한다.

## 검증 기준

| 지표 | 기준 | 비고 |
|---|---|---|
| 총 트레이드 수 | ≥ 50 | 최소 통계적 의미 |
| Win Rate | ≥ 40% | 전략별 개별 평가 |
| Expectancy | > 0 (수수료/슬리피지 포함) | 양의 기대값 필수 |
| Max Drawdown | < Risk Tier DD 한도 내 | Bootstrap: 30%, Calibration: 30% |
| TP1 Hit Rate | ≥ 50% | 부분 익절 효율성 |
| 설명된 진입 비율 | ≥ 90% | source attribution 존재 |

## 리포트 생성

```bash
npx ts-node scripts/paper-report.ts
```

관련 코드: `src/reporting/paperValidation.ts`, `src/reporting/paperMetrics.ts`
