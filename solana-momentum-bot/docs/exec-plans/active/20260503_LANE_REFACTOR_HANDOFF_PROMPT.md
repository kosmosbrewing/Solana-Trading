# 2026-05-03 Lane Refactor Handoff Prompt

Use this prompt when opening another AI/dev session for this repo.

```text
You are working in `/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot`.

Before making changes, read these current authority/context docs in order:

1. `SESSION_START.md`
2. `MISSION_CONTROL.md`
3. `STRATEGY.md`
4. `docs/design-docs/lane-operating-refactor-2026-05-03.md`
5. `docs/exec-plans/active/20260503_BACKLOG.md`
6. `docs/design-docs/kol-hunter-rotation-v1-2026-05-02.md`
7. `docs/design-docs/pure-ws-botflow-rebuild-2026-05-02.md`

Important current state:

- The project has three strategy surfaces:
  - `kol_hunter_smart_v3`: main 5x lane.
  - `kol_hunter_rotation_v1`: fast-compound auxiliary lane, live disabled until post-cost evidence improves.
  - `pure_ws botflow`: paper/observe-only new-pair botflow rebuild candidate.
- Current Real Asset Guard:
  - wallet floor `0.7 SOL`;
  - default lane canary cap `-0.3 SOL`;
  - KOL canary cap `-0.2 SOL`;
  - pure_ws/cupsey/migration ticket `0.01 SOL`;
  - KOL ticket `0.02 SOL`;
  - max concurrent `3`;
  - wallet drift halt `0.2 SOL`;
  - security hard reject must not be bypassed.
- `smart-v3` live entry should use fresh active KOL context, not stale 24h aggregate count.
- `rotation-v1` should be judged by T+15/T+30 post-cost behavior, not runner metrics.
- `pure_ws botflow` must not be treated as Mayhem-copy or live-ready. It is paper/observe-only unless a future ADR says otherwise.

Ledger/refactor state implemented on 2026-05-03:

- KOL aggregate ledgers remain compatibility sources:
  - `data/realtime/kol-paper-trades.jsonl`
  - `data/realtime/kol-live-trades.jsonl`
- Lane-level projection ledgers were added:
  - `data/realtime/smart-v3-paper-trades.jsonl`
  - `data/realtime/smart-v3-live-trades.jsonl`
  - `data/realtime/rotation-v1-paper-trades.jsonl`
  - `data/realtime/rotation-v1-live-trades.jsonl`
  - `data/realtime/pure-ws-paper-trades.jsonl`
  - `data/realtime/pure-ws-live-trades.jsonl`
- Projection writes are fail-open dual-writes and must not replace aggregate ledger writes.
- Shared markout files stay unsplit:
  - `data/realtime/trade-markout-anchors.jsonl`
  - `data/realtime/trade-markouts.jsonl`
- Rotation digest/report should prefer `rotation-v1-paper-trades.jsonl` and fall back to `kol-paper-trades.jsonl` if projection is empty.
- `scripts/sync-vps-data.sh` sync health now includes lane projection freshness/row counts.

Recently changed files include:

- `src/orchestration/kolSignalHandler.ts`
- `src/orchestration/rotationPaperDigest.ts`
- `scripts/rotation-lane-report.ts`
- `scripts/sync-vps-data.sh`
- `docs/design-docs/lane-operating-refactor-2026-05-03.md`
- `docs/exec-plans/active/20260503_BACKLOG.md`
- `STRATEGY.md`
- `SESSION_START.md`
- `MISSION_CONTROL.md`
- `docs/design-docs/index.md`
- `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md`
- `docs/design-docs/kol-hunter-rotation-v1-2026-05-02.md`
- `docs/design-docs/pure-ws-botflow-rebuild-2026-05-02.md`

Verification already run:

- `git diff --check`: pass
- `npm run check:fast`: pass
- Jest: `174/174` test suites, `1735/1735` tests pass
- There is a Jest worker force-exit warning likely from existing timer teardown; it is not a test failure.

Known doc consistency note:

- `docs/design-docs/option5-kol-discovery-adoption-2026-04-23.md` still quotes the original `0.8 SOL` mission sentence as historical text, but immediately states the current operating floor is `0.7 SOL`.

Do not:

- Relax Real Asset Guard.
- Merge rotation behavior into smart-v3.
- Turn pure_ws botflow live from Mayhem/botflow context alone.
- Treat dev allowlist as a gate bypass.
- Split shared markout ledgers unless dedupe/retry/coverage semantics are redesigned.
- Make large threshold changes and large refactors in the same step.

If asked to analyze current operations, run:

`bash scripts/sync-vps-data.sh`

Then inspect:

1. `reports/sync-health-YYYY-MM-DD.md`
2. `reports/kol-live-canary-YYYY-MM-DD.md`
3. `reports/trade-markout-YYYY-MM-DD.md`
4. `reports/rotation-lane-YYYY-MM-DD.md`
5. `reports/pure-ws-trade-markout-YYYY-MM-DD.md`
6. `reports/token-quality-YYYY-MM-DD.md`

Use wallet truth over DB PnL. End operating verdicts with `OK`, `WATCH`, `PAUSE_REVIEW`, or `INVESTIGATE`.
```
