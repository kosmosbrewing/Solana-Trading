# KOL Candidate Candle Coverage

## Mission Context

The candle entry proof report showed that rotation and smart-v3 KOL candidates often had no token
micro-candles at the anchor time, while pure WS candidates had much better coverage. That means the
system could not reliably test pre-entry stability, DOA15, fail30, or survivor trailing rules for the
lanes most relevant to the compounding mission.

## Change

KOL buy candidates now request realtime candle coverage through `BotContext.ensureRealtimeCandleCoverage`.
The hook is implemented in `src/index.ts` and is intentionally side-effect limited to the realtime data
plane:

- use direct `KolTx.poolAddress` when available
- otherwise use the latest `HeliusPoolRegistry` observed pair context
- seed up to 120 seconds of recent swaps when realtime seed backfill is enabled
- map seeded/live swaps back to the token mint so existing KOL candle snapshots can read them
- keep at most 8 short-lived KOL candle targets for 7 minutes
- prioritize these short-lived targets before the regular watchlist when subscription capacity is tight

## Non-Goals

- no live order routing changes
- no admission gate loosening
- no environment variable expansion
- no paper/live promotion decision change

## Expected Effect

The next deployed sample should reduce `coverageReason=no_token_candles` for KOL/rotation anchors in
`kol:candle-entry-proof-report`. If coverage remains low, the remaining root cause is likely upstream
KOL tx parsing missing direct pool evidence, not paper/live strategy logic.
