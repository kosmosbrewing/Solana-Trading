# Track 2A — Token Quality Flag Retro 분석

> Generated: 2026-04-29T01:27:00.339Z
> Source: paper trades (active arm only, shadow excluded)
> Roadmap: `docs/exec-plans/active/kol-bigloss-roadmap-2026-04-29.md`

## 1. Baseline (전체 active paper trades)

| 지표 | 값 |
|------|-----|
| n (active arm trades) | 372 |
| cum_net_sol | +0.1422 |
| mfe<1% rate | 45.2% |
| big-loss rate (netPct ≤ -20%) | 12.4% |
| 5x winner (mfe ≥ +400%) | 1 |
| avg mfe | 24.1% |
| avg net | 4.3% |

## 2. Per-flag cohort (entry-time predictor 검증)

| Flag | n | mfe<1% rate | Δ baseline | big-loss rate | cum_net | 5x | avg_mfe |
|------|---|-------------|------------|---------------|---------|-----|---------|
| SELL_DECIMALS_6 | 354 | 44.6% | -0.5% | 12.7% | +0.1248 | 1 | 23.7% |
| DECIMALS_SECURITY_CLIENT | 304 | 45.7% | +0.6% | 13.8% | +0.1500 | 1 | 25.8% |
| EXIT_LIQUIDITY_UNKNOWN | 302 | 40.4% | -4.8% | 11.9% | +0.1798 | 1 | 26.1% |
| EXT_metadataPointer | 254 | 39.8% | -5.4% | 11.4% | +0.1722 | 1 | 27.0% |
| EXT_tokenMetadata | 254 | 39.8% | -5.4% | 11.4% | +0.1722 | 1 | 27.0% |
| TOKEN_2022 | 254 | 39.8% | -5.4% | 11.4% | +0.1722 | 1 | 27.0% |
| NO_SECURITY_DATA | 70 | 65.7% | +20.6% | 14.3% | -0.0376 | 0 | 15.7% |
| SELL_DECIMALS_9 | 18 | 55.6% | +10.4% | 5.6% | +0.0174 | 0 | 32.1% |
| UNCLEAN_TOKEN | 3 | 0.0% | -45.2% | 33.3% | +0.0103 | 0 | 27.4% |
| TOKEN_QUALITY_UNKNOWN | 2 | 50.0% | +4.8% | 50.0% | -0.0067 | 0 | 16.3% |
| UNCLEAN_TOKEN:top10_54pct | 1 | 0.0% | -45.2% | 0.0% | +0.0127 | 0 | 64.1% |
| UNCLEAN_TOKEN:top10_61pct | 1 | 0.0% | -45.2% | 0.0% | +0.0024 | 0 | 12.7% |
| UNCLEAN_TOKEN:top10_64pct | 1 | 0.0% | -45.2% | 100.0% | -0.0049 | 0 | 5.5% |

## 3. 판정 기준

- **strong predictor**: |Δ baseline| ≥ 10% 이고 n ≥ 30 — entry filter 도입 가치 있음.
- **weak predictor**: |Δ baseline| 5-10% 또는 n 10-30 — 외부 API 보완 필요.
- **no signal**: |Δ baseline| < 5% — 해당 flag 단독 reject 무의미. 외부 데이터 dimension 필요.

## 4. Action items (분석 결과 따라 결정)

| 결과 | 권고 |
|------|------|
| strong predictor 1+ flag | (B) 즉시 entry-time reject 도입, 외부 API 미필요 |
| weak predictor only | (C) RugCheck (무료) + Solana Tracker (free tier) 평가 후 도입 |
| no signal | (D) Track 2 자체 재설계 — entry-time gate 무력화, hold-time / exit policy 로 회귀 |

## 5. 분석 무결성 체크

- shadow arm 제외: 372 active trades
- mfe<1% threshold: 1.0%
- big-loss threshold: -20.0%
- 5x winner threshold: mfe ≥ 400.0%
