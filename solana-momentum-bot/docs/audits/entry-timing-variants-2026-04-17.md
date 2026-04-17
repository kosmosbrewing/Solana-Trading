# Entry Timing Variants Audit (2026-04-17)

> Status: config change merged (`cupseyStalkDropPct` 0.001 → 0.005). VPS 배포 대기.
> Source: 9 live sessions (2026-04-15 ~ 2026-04-17), 292 bootstrap_10s signals replayed.
> Parent plan: [`../exec-plans/active/1sol-to-100sol.md`](../exec-plans/active/1sol-to-100sol.md) §Wallet Truth Finding

## One-Line Conclusion

현재 `cupseyStalkDropPct=0.001` (−0.1% pullback) 은 signal 발화 직후 가장 먼저 도달하는 tick에서 즉시 entry → 90% flat drift → avg 720s exit **−0.23%** (음의 기대값). variant simulation 결과 **−0.5% 이상 pullback 요구** 시 avg_exit 양수 전환. 기본값을 **0.005 (−0.5%)** 로 채택하고 `CUPSEY_STALK_DROP_PCT=0.010` env override 로 공격 모드 전환 가능하게 둔다.

## Test Evidence

### (1) 720s horizon outcome by variant

| `cupseyStalkDropPct` | n entries | avg_peak | **avg_exit** | hard_cut reached | reach +2% | 누적 SOL* |
|---|---|---|---|---|---|---|
| 0.001 (−0.1%, 현재) | 145 / 292 | +2.73% | **−0.23%** | 42.8% | 31.0% | **−0.0033** |
| 0.003 (−0.3%) | 125 | +2.74% | −0.18% | 43.2% | 31.2% | −0.0022 |
| 0.005 (−0.5%, **채택**) | 81 | +3.61% | **+0.47%** | 48.1% | 40.7% | **+0.0038** |
| 0.010 (−1.0%) | 21 | +7.83% | **+3.28%** | 66.7% | 57.1% | **+0.0069** |

*누적 SOL = n × avg_exit × 0.01 ticket (72h 기간)

### (2) 30s post-entry fate

| variant | reach +2% | hit −0.8% | **flat (neither)** |
|---|---|---|---|
| 0.001 | 3.4% | 6.2% | **90.3%** |
| 0.003 | 4.0% | 6.4% | 89.6% |
| 0.005 | 4.9% | 8.6% | 86.4% |
| 0.010 | **14.3%** | 9.5% | **76.2%** |

### (3) Entry rate (총 292 signal 중)

```
0.001:  49.7%  → 145 entries
0.003:  42.8%  → 125
0.005:  27.7%  → 81
0.010:   7.2%  → 21
```

## Judgment

### 현재 설정은 signal-chaser, edge 없음

−0.1% pullback은 실제로 signal 직후 첫 tick 수준 미세 변동. 의미 있는 기술적 반락이 아니라 **signal 직후 발화 tick** 을 매수. 결과적으로 bootstrap_10s signal 의 raw quality 를 그대로 따라가며 **90%가 flat drift** 로 끝나고 평균 손실.

### Pullback depth 가 signal 품질 필터 역할

0.010 (−1.0%) 까지 엄격해질수록:
- reach +2% 비율이 3.4% → 14.3% (4.2배 상승)
- avg_peak +2.73% → +7.83% (2.9배)
- 즉 **진짜 기술적 반등 후 재상승하는 setup** 만 선별됨

### Sample variance tradeoff

0.010 variant 는 n=21 로 variance 큼 (72h 기준). 0.005 variant 는 n=81 로 안정적이면서도 avg_exit 양수 전환. 보수-공격 중간점이 0.005.

### Hard cut 비율 상승 주의

더 엄격할수록 hard cut 도달률 상승 (43% → 67%). 이건 단순 bad news 가 아니라 **진짜 방향성 있는 token** 에서 양방향 이동이 많아지는 것. Liquidity Crash Guard (후속 작업) 가 이 비율을 낮춰줄 수 있다.

## Fix (2026-04-17 merged, VPS 배포 대기)

### (1) `tradingParams.ts`
```ts
cupseyStalkDropPct: 0.005,  // 0.001 → 0.005 (2026-04-17 variant analysis)
```

### (2) env override (`config.ts`)
```ts
...(process.env.CUPSEY_STALK_DROP_PCT
  ? { cupseyStalkDropPct: Number(process.env.CUPSEY_STALK_DROP_PCT) }
  : {}),
```

VPS `.env` 에서 rollback 또는 공격 모드 전환:
```
CUPSEY_STALK_DROP_PCT=0.001   # rollback to 현재
CUPSEY_STALK_DROP_PCT=0.010   # 공격 모드 (n≈20/72h, avg +3.28%)
```

### (3) 기존 test 조정

- `test/cupseyStateMachine.test.ts`: `defaultCupseyReplayConfig().stalkDropPct` expectation 0.001 → 0.005
- `test/cupseyLaneHandler.test.ts`: `configPatch.cupseyStalkDropPct: 0.001` 은 **명시적 테스트 override** 이므로 그대로 유지 (테스트가 0.001 기준으로 작동 검증)

## Expected Impact (배포 후 24~48h)

| metric | before (0.001) | after (0.005) 예상 |
|---|---|---|
| signal → STALK entry rate | ~50% | ~28% |
| avg 720s exit | −0.23% | **+0.47%** |
| 30s reach +2% | 3.4% | 4.9% |
| 30s flat | 90% | **86%** |
| 누적 wallet 변화 (72h, 0.01 SOL ticket) | −0.003 SOL | +0.004 SOL |

기존의 음의 기대값 drain (−0.013 SOL/day) 을 **양의 기대값으로 전환** 예상. 다만:
- Sample variance 주의 — 실측 30-50 trades 누적 전 결론 금지
- HWM oxidation fix (`docs/audits/hwm-axis-oxidation-2026-04-17.md`) 와 함께 배포되어야 WINNER 판정/trailing 정확히 작동

## Out of Scope (후속)

1. **Liquidity Crash Guard** — BOME/unc 같은 single swap −10% drop 차단. 본 파라미터 변경으로 hard_cut 비율 상승 예상 (43% → 48%+), 이를 방어하려면 entry gate 에 liquidity 검증 추가.
2. **bootstrap_10s signal quality** — 근본은 signal source 자체. pullback 으로 필터 중이지만, signal trigger 파라미터 (`volumeRatio`, `buyRatio`, `cooldown`) 재튜닝 가능성.
3. **cupseyStalkMaxDropPct (−1.5%)** — 0.010 variant 에서도 crash skip 이 issue 안 됨. 현재는 조정 불필요.

## Follow-up Validation

배포 후 24~48h:
1. `scannerEngine` 로그에서 STALK entry count 감소 확인 (50% → 28% 근처)
2. VPS DB 신규 cupsey CLOSED row 의 pnl 분포 → avg_exit 양수 전환
3. `wallet-reconcile` 결과가 DB pnl 과 drift 축소하는지 (HWM fix 와 동시 확인)
4. n≥30 확보 후 기본값 0.005 유지 vs 0.010 공격 모드 전환 재평가

## Change Summary

- 수정: `tradingParams.ts`, `config.ts`, `test/cupseyStateMachine.test.ts`
- 신규: `docs/audits/entry-timing-variants-2026-04-17.md` (본 문서)
- tsc 0 errors / cupsey tests 35/35 pass (신규 +4 peak guard)
- 실제 content diff 16 lines
