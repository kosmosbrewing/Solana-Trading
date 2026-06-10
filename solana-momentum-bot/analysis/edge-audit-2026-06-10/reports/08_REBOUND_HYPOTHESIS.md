# 08 — Capitulation-Rebound Hypothesis Test (offline)

**LABEL: `hypothesis_only` / `research_only`** — the conditioning variable (price at T+300 vs entry anchor) is observable ex ante and the rule is implementable in real time, but bucket boundaries were chosen after seeing this sample's aggregate decay stats (audit Phase 1). Chronological-OOS on fresh data is required before any promotion. In-sample chrono split below is a stability check only.

- generated: 2026-06-10T04:48:20.428922Z (seed 20260610, 1000 bootstrap resamples)
- data: `cache/event_master.jsonl`, buy anchors, token-event dedup (600s, precedent `scripts/01_signal_event_study.py`)
- definition: `r = (1+d1800)/(1+d300) − 1` — gross 300s→1800s return for an agent buying at the T+300 Jupiter-quoted price after observing the drawdown

## Universe and guards

- buy anchors (all): **5177** → token-event dedup: **2060**
- missing d300/d1800: 33 (excluded)
- dead bucket (d300 ≤ −0.97, likely rug/zero): **1** excluded — median d1800 = -97.9% (they do NOT come back)
- suspect quotes (|d1800| > 10): 20 excluded
- usable: **2006** events over **21** active days; first-event-per-mint subset: 1714

## Cost bar (audit Phase 2 arithmetic, 0.02 SOL ticket)

- (a) price-level round-trip cost: 1.5%
- (b) fixed execution drag 0.0027 SOL/round-trip = **13.5% of ticket**
- combined bar: **median r must exceed +15.0%** to be net-positive at current ticket size

## Results

### Main table — token-event dedup (600s)

| d300 bucket | N | median r | mean r (cap+10) | CI95 mean | P(r>0) | P(r>=+30%) | P(r>=+100%) | P(r<=-50%) | days | net median (a) 1.5% | net median (a+b) 15% | clears 15% bar |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| <=-0.7 | 192 | -6.9% | -6.5% | [-15.3%, +7.9%] | 14.6% | 5.2% | 2.1% | 8.9% | 19 | -8.3% | -21.8% | no |
| -0.7..-0.5 | 253 | -21.2% | -12.6% | [-21.2%, -1.9%] | 12.3% | 6.3% | 4.0% | 19.0% | 20 | -22.4% | -35.9% | no |
| -0.5..-0.3 | 229 | -39.0% | -21.1% | [-29.0%, -12.1%] | 21.0% | 13.1% | 4.8% | 37.1% | 20 | -40.0% | -53.5% | no |
| -0.3..-0.1 | 329 | -32.2% | -14.7% | [-22.6%, -5.2%] | 24.0% | 14.6% | 5.8% | 35.6% | 19 | -33.2% | -46.7% | no |
| -0.1..0 | 221 | -13.4% | -15.0% | [-22.2%, -7.0%] | 31.2% | 10.9% | 3.2% | 29.0% | 20 | -14.7% | -28.2% | no |
| >0 | 782 | -25.8% | -11.6% | [-17.0%, -5.7%] | 30.1% | 15.9% | 6.6% | 33.8% | 21 | -26.9% | -40.4% | no |

### Robustness — first event per mint only (kills within-token serial correlation)

| d300 bucket | N | median r | mean r (cap+10) | CI95 mean | P(r>0) | P(r>=+30%) | P(r>=+100%) | P(r<=-50%) | days | net median (a) 1.5% | net median (a+b) 15% | clears 15% bar |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| <=-0.7 | 190 | -6.3% | -6.1% | [-14.5%, +7.6%] | 14.7% | 5.3% | 2.1% | 8.9% | 19 | -7.7% | -21.2% | no |
| -0.7..-0.5 | 247 | -20.7% | -11.8% | [-20.6%, -0.5%] | 12.6% | 6.5% | 4.0% | 18.6% | 20 | -21.9% | -35.4% | no |
| -0.5..-0.3 | 210 | -40.7% | -21.3% | [-29.5%, -11.6%] | 20.5% | 13.3% | 4.8% | 38.1% | 20 | -41.6% | -55.1% | no |
| -0.3..-0.1 | 278 | -36.8% | -15.3% | [-24.4%, -4.1%] | 22.3% | 14.7% | 6.1% | 40.3% | 19 | -37.7% | -51.2% | no |
| -0.1..0 | 161 | -29.2% | -19.4% | [-29.4%, -8.7%] | 27.3% | 12.4% | 3.7% | 38.5% | 19 | -30.2% | -43.7% | no |
| >0 | 628 | -32.0% | -12.0% | [-18.4%, -4.9%] | 29.8% | 17.8% | 7.8% | 38.4% | 21 | -33.0% | -46.5% | no |

### Chronological stability (in-sample halves, by active day)

- first half: 2026-05-02..2026-05-11 (10 days) | second half: 2026-05-12..2026-05-22 (11 days)

| d300 bucket | N (1st/2nd) | median r 1st | median r 2nd | sign stable |
|---|---|---:|---:|---|
| <=-0.7 | 109/83 | -5.6% | -10.5% | YES |
| -0.7..-0.5 | 163/90 | -18.4% | -28.7% | YES |
| -0.5..-0.3 | 134/95 | -42.7% | -35.0% | YES |
| -0.3..-0.1 | 166/163 | -33.1% | -31.9% | YES |
| -0.1..0 | 117/104 | -5.6% | -20.2% | YES |
| >0 | 426/356 | -28.6% | -21.2% | YES |

## Verdict

**REJECT**

Findings:

1. **No rebound exists as a central-tendency effect.** Every d300 bucket has negative median 300s→1800s forward return (gross, pre-cost), in the full sample, in the first-event-per-mint subset, and in BOTH chronological halves (all buckets sign-stable negative). Conditioning on observed drawdown does not flip the decay — it only changes how fast the token keeps bleeding.
2. **Best bucket is `<=-0.7`** (median r -6.9%, mean capped -6.5%, CI95 [-15.3%, +7.9%], P(r>0)=14.6%). Even its CI upper bound is below the +15% cost bar; gross median is negative, so net of (a)+(b) it is -21.8% per trade at 0.02 SOL ticket.
3. **A 'deepest drawdown is least-bad' floor effect exists but is not tradeable**: the ≤−0.7 bucket has the least-negative median while the middle buckets (−0.5..−0.1) are the worst — consistent with 'everything decays toward T+1800; tokens already down 70%+ have less room left to fall', i.e. a floor effect, not mean reversion.
4. **Tail lottery does not rescue expectancy**: P(r≥+100%) is 2–7% per bucket, but mean r capped at +10 is negative in every bucket, so the occasional big rebound does not pay for the median bleed even before costs.

Implication for the paper lane (`kol_hunter_capitulation_rebound_v1/_rr_v1`): this offline evidence does NOT support enabling it as-is. The lane's premise (drawdown −35..−65% + bounce confirmation → rebound) sits in buckets whose median forward return is −21% to −39% gross. If the lane is ever revisited, the bounce-confirmation conditioning (which this cache cannot test — it requires intra-window price paths, not 5-point markouts) is the only untested degree of freedom; that would require collecting per-candidate low/bounce/confirmation telemetry plus dense (≤15s) post-low markouts, and fixing the structural hard-veto blocker (EXIT_LIQUIDITY_UNKNOWN / TOKEN_2022 EXT_* on ~100% of candidates) so the lane can produce any rows at all.

