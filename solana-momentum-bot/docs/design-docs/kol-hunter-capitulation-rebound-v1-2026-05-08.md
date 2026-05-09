# KOL Hunter Capitulation Rebound V1

> Date: 2026-05-08  
> Status: paper implementation ready / live prohibited  
> Lane type: fast reaction, mean-reversion scalp  
> Authority: `SESSION_START.md`, `MISSION_CONTROL.md`, `docs/design-docs/lane-operating-refactor-2026-05-03.md`

## Decision

`kol_hunter_capitulation_rebound_v1` can be worth testing, but it must be a separate paper lane, not an extension of `smart-v3`.

The strategy is not "buy every large drop." The intended edge is narrower:

> Buy only a temporary liquidity shock after KOL-driven attention, once executable sell quotes recover after the low, and exit within 15-30 seconds if the rebound does not monetize.

This lane is closer to `rotation-v1` than to `smart-v3`. It targets short, post-cost rebound capture, not 5x runner discovery.

## Why This Is Separate From Smart-v3

`smart-v3` is the main 5x lane. It looks for KOL consensus and trend continuation after controlled entry triggers.

Capitulation rebound is different:

| Dimension | smart-v3 | capitulation rebound |
|---|---|---|
| Primary edge | KOL consensus + continuation | temporary liquidity shock reversal |
| Hold intent | runner optionality | short scalp only |
| Entry style | pullback/velocity after KOL structure | sharp drawdown after prior KOL/volume crowding |
| Exit style | asymmetric trail, preserve winners | 15-30s reaction test, fast cut |
| Failure mode | late entry / distribution | catching rug or information-driven collapse |

Mixing this into `smart-v3` would pollute main-lane evidence and make the 5x lane harder to evaluate.

## External Evidence

The external evidence supports the existence of short-term reversals after extreme drops, but only conditionally.

1. **Extreme intraday drops often partially reverse.**  
   A Nasdaq100 high-frequency study reports that after extreme negative one-minute returns, about 31% of the drop reversed in the following minute, with stronger reversals in larger and more liquid names.  
   Source: [Short-term stock price reversals after extreme downward price movements](https://www.sciencedirect.com/science/article/pii/S1062976921000922)

2. **Short-term reversal is often liquidity provision, not fundamental alpha.**  
   Intraday reversal literature links the effect to price concessions required for liquidity providers to absorb temporary order-flow pressure.  
   Source: [Short-Term Return Reversals and Intraday Transactions](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3174484)

3. **Crypto has both intraday momentum and reversal.**  
   Cryptocurrency studies find that predictability changes with liquidity, jumps, and market regimes. This argues for conditional gates, not a universal rebound rule.  
   Sources: [Intraday return predictability in cryptocurrency markets](https://colab.ws/articles/10.1016%2Fj.najef.2022.101733), [Up or down? Short-term reversal, momentum, and liquidity effects in cryptocurrency markets](https://www.sciencedirect.com/science/article/pii/S1057521921002349)

4. **Some price shocks are information-driven and do not reverse.**  
   Microstructure work on price shocks and order imbalance shows that when shocks are information-driven, subsequent reversal can be weak or absent.  
   Source: [The Propagation of Shocks Across International Equity Markets](https://www.hss.caltech.edu/research/social-sciences-research/working-papers/the-propagation-of-shocks-across-international-equity-markets-a-microstructure-perspective)

5. **DEX/memecoin collapse is often adversarial.**  
   DEX scam/rug literature emphasizes early transaction data, token volume, transaction count, holder/ownership patterns, and scam indices for early detection.  
   Sources: [Scam Token Classification for Decentralized Exchange Using Transaction Data](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4582918), [Scam Alert: Can Cryptocurrency Scams Be Detected Early?](https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID4490180_code2539344.pdf?abstractid=4490180&mirid=1), [SolRPDS: A Dataset for Analyzing Rug Pulls in Solana DeFi](https://arxiv.org/abs/2504.07132)

### Research Quality Check - 2026-05-09

The reviewed research supports the lane shape, not the numeric parameters.

What is valid:

- Extremely short-horizon rebound can exist after abnormal sell pressure.
- The effect is conditional on liquidity, market regime, and whether the shock is temporary or information-driven.
- Solana memecoin collapses are adversarial enough that anti-rug, anti-bundle, anti-distribution, and sell-route filters must be treated as first-class entry conditions.
- For this lane, execution quality is part of the signal. A price bounce without an executable exit quote is not evidence.

What must not be imported directly:

- Equity-market reversal magnitudes such as "31% retracement" are not calibration inputs for Solana microcaps.
- Fixed values such as `-45% drawdown` or `+8% bounce` are only initial grid cells. The actual thresholds must come from paper T+15/T+30 post-cost markouts.
- A visually improving tick sequence is insufficient because it can be spoofed or printed through tiny size in thin pools.

## Strategy Hypothesis

The lane should only enter when all of the following are true:

- A token recently received meaningful KOL attention or KOL buy-volume concentration.
- Price then capitulated sharply from a local peak.
- Sell route and quote quality remain executable.
- Holder/token-quality risk is not severe.
- Participating KOLs are not actively exiting.
- A first price recovery signal appears after the low.
- Executable sell quotes confirm that the recovery can be monetized.

The monetizable edge should come from an oversold liquidity concession, not from taking the other side of a rug or post-distribution collapse.

## Candidate Conditions

Initial candidate gates:

| Gate | Initial proposal | Reason |
|---|---:|---|
| KOL attention window | last 1-3 minutes | rebound must be tied to recent demand, not random falling token |
| KOL quality | S/A preferred, active KOL only | avoid weak or inactive attribution |
| KOL buy-volume | concentrated recent buy flow | verifies attention/flow event |
| Drawdown | local peak to current `-35%` to `-60%` | enough capitulation to create rebound convexity |
| Sell route | route exists, impact below severe threshold | avoid no-exit traps |
| Token quality | no hard-risk holder/security flags | avoid rug/native scam collapse |
| Distribution | no recent KOL sell wave | avoid becoming exit liquidity |
| Candidate recovery | first `+5%` to `+8%` bounce or 2-3 improving ticks | candidate only; not sufficient for entry |
| Quote resilience confirmation | 2+ fresh executable sell quotes after the low with route maintained, outAmount improving, and priceImpact not worsening | proves the rebound is monetizable |
| Regime / breadth | neutral or positive internal breadth, no broad risk-off shock | avoid fading market-wide collapse |
| Posterior no-trade zone | bucket T+15/T+30 expected post-cost markout > 0 | avoid paying costs for weak rebound candidates |

The drawdown range is intentionally a starting grid. It must be measured with T+15/T+30/T+60 paper markouts before live use.

## Hard Veto Layer

These conditions should block paper entry and write an observer/no-trade anchor instead. They are not soft score penalties in the first version.

| Veto | Action | Reason |
|---|---|---|
| no sell route | observer only | no executable exit |
| severe quote impact with no recovery | observer only | rebound cannot be monetized |
| recent KOL sell wave | observer only | likely distribution, not liquidity shock |
| severe holder concentration / bundle / dev risk | observer only | rug/manipulation risk dominates reversal edge |
| token quality unknown plus exit liquidity unknown | observer only | uncertainty is too high for rebound scalp |
| launcher/dev/LP removal or severe liquidity collapse | observer only | structural collapse risk |
| repeated same-mint rebound failures | cooldown | avoid paying spread repeatedly in broken token |

The hard-veto decision must still be logged as a counterfactual anchor so false negatives can be measured.

## Rebound Score

Candidate ranking should be a composite, but entry still requires the hard-veto and quote-confirmation checks above.

```text
rebound_score =
  attention_score
  + shock_abnormality
  + quote_resilience
  + regime_score
  - distribution_pressure
  - toxicity_score
  - execution_cost_score
```

Field definitions:

- `attention_score`: recent S/A KOL buy flow, independent KOL count, and KOL quality.
- `shock_abnormality`: drawdown normalized by recent realized volatility and pre-shock liquidity.
- `quote_resilience`: post-low sell quote route stability, outAmount improvement, and impact recovery.
- `distribution_pressure`: recent same-mint KOL sells, sell volume / buy volume, and first-sell pressure.
- `toxicity_score`: holder concentration, bundle/dev flags, suspicious ownership, and token-quality flags.
- `execution_cost_score`: expected slippage, priority fee, quote drift, and expected landing latency.

## Entry State Machine

```text
KOL attention observed
  -> track local peak and recent KOL buy-volume
  -> if drawdown from peak enters capitulation band:
       evaluate hard veto layer
  -> wait for candidate recovery:
       first bounce +5% to +8%, or 2-3 tick higher-low/higher-price
  -> require quote resilience confirmation:
       2+ fresh executable sell quotes after the low
       outAmount improving or stable
       priceImpact improving or not worsening
       route remains available
  -> require no-trade zone pass:
       bucket expected T+15/T+30 post-cost markout > 0
  -> paper enter rebound probe
```

Hard rule:

> Do not buy the first collapse tick. Entry requires recovery evidence and executable quote recovery after the low.

## Counterfactual Anchors

Every candidate should produce sidecar anchors even when it does not enter. Minimum anchors:

| Anchor | Meaning |
|---|---|
| `collapse_touch` | first moment drawdown enters the capitulation band |
| `first_bounce_tick` | first price/tick recovery after the low |
| `quote_confirmed_rebound` | first moment quote resilience passes |
| `no_trade_reject` | hard veto, weak posterior, or missing quote confirmation |

These anchors are required to answer whether the confirmation rule adds value or simply enters later into a rebound that already existed.

## Exit State Machine

This lane should not become a runner lane.

| Exit trigger | Action |
|---|---|
| no reaction by 15s | close |
| no executable quote improvement by 15s | close |
| no post-cost positive by 30s | close |
| price or executable sell quote falls `-5%` to `-8%` from entry | hard cut |
| KOL sell after entry | close |
| sell route worsens / impact severe | structural close |
| rebound reaches `+10%` to `+20%` | fast trail |

The first paper version should record T+15/T+30/T+60/T+180/T+300 markouts. T+1800 can be retained for winner-kill diagnostics, but it should not drive this lane's primary exit policy.

## Data To Record

Minimum paper ledger fields:

- `armName = kol_hunter_capitulation_rebound_v1`
- `entryReason = capitulation_rebound`
- `localPeakPrice`
- `capitulationLowPrice`
- `drawdownFromPeakPct`
- `bounceFromLowPct`
- `ticksSinceLow`
- `counterfactualAnchorType`
- `hardVetoReason`
- `reboundScore`
- `shockAbnormalityScore`
- `quoteResilienceScore`
- `distributionPressureScore`
- `toxicityScore`
- `executionCostScore`
- `kolBuyVolumeSol_60s`
- `kolBuyVolumeSol_180s`
- `kolSellVolumeSol_60s`
- `participatingKols`
- `sellRouteAvailable`
- `quoteImpactPct`
- `quoteAgeMs`
- `quoteOutAmountRaw`
- `quoteImpactBeforeLowPct`
- `quoteImpactAfterLowPct`
- `quoteOutAmountImprovementPct`
- `quoteConfirmationCount`
- `routeHash`
- `entryDriftBps`
- `exitDriftBps`
- `landingLatencyMs`
- `priorityFeeLamports`
- `requestedComputeUnits`
- `actualComputeUnits`
- `retryCount`
- `tokenQualityFlags`
- `holderRiskFlags`
- `postDistributionFlags`
- `mfePct`, `maePct`, `maeAt5s`, `maeAt15s`, `maeAt30s`
- T+ markout anchors after buy and sell

## Validation Metrics

Do not judge by win rate alone. The lane is only useful if it clears post-cost reaction metrics.

Primary metrics:

- T+15 post-cost positive rate
- T+30 post-cost positive rate
- median T+15 / T+30 post-cost delta
- no-reaction close rate
- hard-cut rate
- same-mint repeat damage
- winner-kill after early close
- route-loss / no-sell-route incidence

## Implementation Mapping - 2026-05-09

Implemented scope is deliberately paper-only.

Runtime wiring:

- Config switch: `KOL_HUNTER_CAPITULATION_REBOUND_ENABLED=false` by default.
- Paper switch: `KOL_HUNTER_CAPITULATION_REBOUND_PAPER_ENABLED=true` by default.
- Parameter version: `capitulation-rebound-v1.0.0`.
- Arm name: `kol_hunter_capitulation_rebound_v1`.
- Entry reason: `capitulation_rebound`.
- Projection ledger: `data/realtime/capitulation-rebound-paper-trades.jsonl`.
- Shared markout offsets: `15,30,60,180,300,1800`.
- Report command: `npm run kol:capitulation-report`.

Implemented entry checks:

- Uses the existing smart-v3 observe price stream as the attention/price source.
- Does not consume smart-v3 or rotation triggers. It only evaluates after those do not trigger.
- Tracks local `peakPrice`, `lowPrice`, `drawdownFromPeakPct`, `bounceFromLowPct`, and recovery confirmations.
- Requires configured drawdown band, rebound confirmation count, KOL score, and no KOL sell wave.
- Applies hard-veto flags such as no sell route, unknown exit liquidity, missing security, unclean token, severe holder risk, and rug-like flags.
- Still uses the existing size-aware sell quote probe at paper entry; if the planned quantity cannot be sold, no paper position is opened.

Implemented exits:

- `capitulation_no_reaction`: no fast reaction by the configured 15s window.
- `capitulation_no_post_cost`: no post-cost positive by the configured 30s timeout.
- `probe_hard_cut`: configured fast hard cut, default 6%.
- `winner_trailing_t1`: fast rebound trail after default +8% MFE.

Implemented observability:

- Buy and sell anchors are written to the shared trade markout observer.
- Close rows include `capitulationTelemetry`, low price, low timestamp, and recovery confirmation count.
- No-trade counterfactuals are written through missed-alpha when hard veto, sell wave, too-deep drawdown, or weak bounce prevents entry.
- The report summarizes closes, T+ after-buy/after-sell markouts, no-trade counterfactuals, and post-cost deltas.

Non-goals for this implementation:

- No live canary path.
- No separate executor path.
- No direct policy mutation of smart-v3 or rotation.
- No use of equity-market reversal magnitudes as production thresholds.

Minimum paper promotion gate:

| Metric | Suggested threshold |
|---|---:|
| paper closes | `>= 100-200` |
| T+15/T+30 ok coverage | `>= 80%` |
| median T+15 post-cost delta | `> 0` |
| median T+30 post-cost delta | `> 0` |
| concentration | not dominated by 1-2 mints or a single hot day |
| no-trade false negatives | acceptable after hard-veto review |
| hard-cut rate | below rotation baseline |
| route-loss incidents | near zero |
| live promotion | canary only, smaller than rotation ticket |

Promotion should use out-of-sample week splits when enough data exists. If the best grid cell only works in one hot period, keep the lane paper-only.

## Initial Parameter Grid

| Parameter | Grid |
|---|---|
| drawdown from local peak | `-35%`, `-45%`, `-55%`, `-65%` |
| candidate recovery | `+5%`, `+8%`, `2 ticks`, `3 ticks` |
| executable quote confirmations | `2 quotes`, `3 quotes` |
| quote confirmation spacing | `2s`, `5s` |
| quote impact recovery | `stable`, `improving`, `improving >= 20% vs low` |
| reaction timeout | `15s`, `30s` |
| hard cut | `-5%`, `-8%` |
| fast trail target | `+10%`, `+15%`, `+20%` |
| KOL window | `60s`, `180s` |
| token age bucket | `very_fresh`, `fresh`, `mature_intraday` |

## Rollout Plan

1. **Paper-only observer**
   - Add candidate detection, hard-veto classification, quote-resilience probes, and missed-alpha style no-trade anchors.
   - Record the four counterfactual anchors.
   - No live trades.

2. **Paper arm**
   - Add actual paper entries and closes only after hard-veto pass and quote-confirmed rebound.
   - Write separate projection ledger if needed.
   - Include T+15/T+30/T+60 in reports.

3. **Report integration**
   - Prefer a separate `capitulation-rebound-report` because the lane has different anchor semantics from rotation and smart-v3.
   - It can be cross-linked from rotation/smart-v3 reports, but its verdict must remain separate from `smart-v3`.
   - Show post-cost edge, not raw rebound only.
   - Compare `collapse_touch`, `first_bounce_tick`, `quote_confirmed_rebound`, and `no_trade_reject`.

4. **Live canary only after evidence**
   - Live ticket should be smaller than rotation underfill.
   - Live exit must use fast full-exit retry path.
   - No live partial reduce in initial version.

## Risks

- This lane can become a rug catcher if sell-route and holder-risk gates are weak.
- A large drop can be information-driven, not temporary liquidity shock.
- Recovery confirmation can be gamed by small bounce ticks in thin liquidity.
- The edge is cost-sensitive. Slippage, priority fee, and quote drift can erase the entire rebound.
- It may increase trade count without improving wallet survival if over-enabled.
- Quote probes can add Helius/Jupiter cost. The observer must use bounded probes and reuse existing markout infrastructure where possible.

## Current Recommendation

Proceed only as paper-first:

- Do not merge into `smart-v3`.
- Do not enter on price bounce alone; require executable quote resilience.
- Do not enable live until T+15/T+30 post-cost evidence is positive across enough independent samples.
- Treat it as a small fast-compound experiment adjacent to rotation.
- Keep `smart-v3` focused on main 5x mission.
