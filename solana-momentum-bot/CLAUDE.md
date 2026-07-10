# Solana Momentum Bot — Agent Entry

This file is a compatibility entry point. The authoritative agent rules are
[`AGENTS.md`](./AGENTS.md).

## Required Read Order

1. [`SESSION_START.md`](./SESSION_START.md)
2. [`MEMORY.md`](./MEMORY.md)
3. [`20260708.md`](./20260708.md)
4. [`HYPOTHESES.md`](./HYPOTHESES.md)
5. [`docs/design-docs/mission-refinement-v2-2026-06-10.md`](./docs/design-docs/mission-refinement-v2-2026-06-10.md)
6. [`AGENTS.md`](./AGENTS.md)

## Current Guard

- Verdict: `RETIRE_CURRENT_LIVE`.
- Decision: operator pending after H-007a.
- H-007a is registered but has no dedicated runner/result yet.
- Do not deploy, restart PM2, enable live, sync a real env, or relax a guard.
- Do not read or print actual secret env files.
- Treat Option 5, old lane plans, and dated live instructions as history.

## Validation

```bash
npm run check:fast
npm run docs:lint
npm run build
```

See [`docs/design-docs/index.md`](./docs/design-docs/index.md) for the current/historical boundary.
