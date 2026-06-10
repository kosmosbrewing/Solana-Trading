# Phase 2 — Cost, Latency, Wallet Drag

> Data: executed-buys/sells.jsonl (KOL live era, `kolh-*` 443-493 rows), kol-live-trades.jsonl (close 325, cost-decomp 양축 보유 316).
> Token-only 깨진 row 2건 (−20.8 / −17.0 SOL, decimals bug) 제외 — clean n=314.

## 2.1 Live 실행 지연

| Metric | p50 | p90 | p99 | N |
|---|---:|---:|---:|---:|
| signal → buy fill 기록 (lag) | 2.2s | 11.5s | 118.5s | 448 |
| executeBuy 실행 시간 | 1.5s | 5.6s | — | 290 |

## 2.2 Entry drift (signal/planned 가격 → 실제 fill)

| Metric | 값 |
|---|---|
| 진입 drift p50 | **+10.4%** (adverse) |
| 진입 drift p90 | +20.7% |
| 진입 drift mean | +9.8% |

신호 시점 가격 대비 **median +10.4% 비싸게 체결**된다. Phase 1 의 post-fill 미세 pop (+1.3% @T+15) 의 8배가 fill 전에 이미 사라진다. 이는 2.2s latency 동안의 pump 연속 + thin pool price impact 의 합성이다. fill 기준 forward 가 그나마 +1.3% 인 것이지, 신호 기준 경제성은 진입 순간 이미 약 −9% 다.

## 2.3 비용 분해 — **live 손실의 정체**

Clean live rows (n=314):

| Axis | 합계 |
|---|---:|
| Token-only PnL (가격 레벨 왕복) | **−0.0030 SOL ≈ 본전** |
| Wallet-truth PnL | **−0.8534 SOL** |
| **Execution drag (차액 = rent+fee+tip+잔여)** | **−0.8504 SOL** |

| 거래당 drag | 값 | ticket 0.02 대비 |
|---|---:|---:|
| p50 | 0.00256 SOL | **12.8%** |
| mean | 0.00271 SOL | **13.6%** |
| p90 | 0.00607 SOL | 30.4% |

구성: ATA rent ~0.00204 (token당, 대부분 미회수) + base/priority fee + tip + 실패 tx 비용. 이는 Sprint X+Y+Z (2026-05-01) 에서 측정 분리한 "ATA rent 20% overhead" 관측의 전수 확정판이다.

**결론: live −1.13 SOL 손실은 "나쁜 토큰을 골라서" 가 아니라 "고정 왕복 비용 13.6% 를 이길 수 없는 구조로 빈번히 회전해서" 발생했다.** Token 선택은 (방어적 exit 덕에) 가격 레벨에서 본전이었다. 475 round trips × ~0.0027 ≈ −1.28 SOL ≈ 관측 손실과 정합.

## 2.4 Alpha decay & break-even latency

Fill-anchor 기준 median forward: +1.30% (T+15) → +0.95% (T+30) → +0.25% (T+60) → −9.6% (T+300).
즉 진입이 늦을수록 (또는 보유가 길수록) median 은 단조 악화 — 신호의 수명은 ~60초.

Break-even 계산 (median path):

```
필요 수익  = 거래당 drag 13.6% (+ sell slippage)
가용 수익  = 최대 +1.3% (T+15, 지연 0s 가정)
→ break-even latency 가 존재하지 않음 (지연 0s 에서도 median 경제성 음수)
```

관측 p50 lag 2.2s 와 비교할 break-even delay 자체가 음수다. **이것은 "더 빨리 체결하면 풀리는" EXECUTION_ALPHA_DECAY 가 아니다** — ticket 0.02 SOL 에서 고정비 구조가 신호의 최대 median 수익을 10배 초과한다.

## 2.5 Hold 시간과 tail 의 충돌

| Metric | 값 |
|---|---:|
| live hold p50 | **16s** |
| live hold p90 | 105s |
| exit 사유 상위 | probe_hard_cut 133 / insider_exit_full 104 / entry_advantage_emergency_exit 73 |

방어 exit 가 16초 만에 끊으니 token-only 가 본전으로 방어된 것이지만, 같은 이유로 Phase 1.3 의 "5x tail 의 92% 는 exit 후 발생" 이 필연이 된다. **고정비 13.6% 를 tail 로 회수하는 convexity 설계인데, tail 보유 시간이 구조적으로 0 에 수렴** — 설계의 자기모순.

## 2.6 Phase 2 판정

Core question — *"Does any gross-positive segment remain positive after realistic p90 cost and observed latency?"*

**NO.** gross-positive 구간 (≤T+60, median +0.25~1.3%) 은 p50 비용 (12.8%) 의 1/10 수준. 비용 구조를 바꾸지 않는 한 (ticket 상향은 Real Asset Guard 위반, rent 회수/fee 절감은 ~0.002 SOL 한계) 어떤 latency 개선도 음수를 양수로 만들 수 없다.

수정 가능성의 산술적 한계: drag 를 0.0027 → 0.0008 (rent 전액 회수 + fee 최적화 극한) 으로 줄여도 4% 왕복 비용 — 여전히 median pop +1.3% 의 3배. **비용 엔지니어링만으로는 부족하고, median 양수가 아닌 신호 (tail 의존) 에서 tail 을 버리는 exit 구조가 함께 바뀌어야 하는데, 그 조합 (장기 보유) 은 T+1800 median −48% 의 universe 에서 다른 방향의 bleed 를 연다.**
