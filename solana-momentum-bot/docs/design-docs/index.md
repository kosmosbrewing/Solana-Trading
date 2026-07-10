# Design Docs Catalog

> Status: current index
> Updated: 2026-07-10
> Rule: dated design documents are immutable decision snapshots; this index assigns current authority.
> Current allowlist: `mission-refinement-v2-2026-06-10.md` only. Every other design document is
> historical/implementation reference even if its original header says `current` or `active`.

## Current Authority Chain

| Priority | Artifact | Meaning |
|---|---|---|
| 1 | [`../../20260708.md`](../../20260708.md) | Current go/no-go state: operator decision pending after H-007a |
| 2 | [`../../HYPOTHESES.md`](../../HYPOTHESES.md) | Hypothesis ledger; H-007a requires a frozen protocol before it becomes the open $0 gate |
| 3 | [`mission-refinement-v2-2026-06-10.md`](./mission-refinement-v2-2026-06-10.md) | Adopted survival-first mission and budget/promotion constraints |
| 4 | [`../INCIDENT_SUMMARY.md`](../INCIDENT_SUMMARY.md) | Last verified operating context and recurring failure patterns |
| 5 | [`../../SESSION_START.md`](../../SESSION_START.md) / [`../../MEMORY.md`](../../MEMORY.md) | Current hand-off, blockers, verification state |
| 6 | Source, `package.json`, tests | Runtime capability and defaults; capability is not live approval |

Current operational verdict is `RETIRE_CURRENT_LIVE`. No dated design doc can authorize live
execution, deployment, ticket expansion, or guard relaxation.

## Adopted Current Policy

| Document | Status now | Notes |
|---|---|---|
| [`mission-refinement-v2-2026-06-10.md`](./mission-refinement-v2-2026-06-10.md) | **adopted** | Survival-first; reserve frozen until qualified cohort |
| [`kol-candle-coverage-repair-2026-06-10.md`](./kol-candle-coverage-repair-2026-06-10.md) | implemented measurement work | Lever 1 worked; resulting coverage remained diagnostic-only |
| [`survivor-momentum-lane-design-2026-06-10.md`](./survivor-momentum-lane-design-2026-06-10.md) | hypothesis history | Phase 0 rejected; do not implement as active lane |

## Superseded Operating Paradigms

These documents remain valuable evidence and implementation history, but are not current strategy
authority.

Non-dated legacy docs (`2-stage-entry.md`, `buy-entry-flow.md`, `core-beliefs.md`,
`helius-data-plane-transition.md`, `layer-rules.md`, `risk-tier-system.md`,
`session-replay-parameter-sweep.md`) are also historical/reference. Their internal status text is
preserved as an audit snapshot and is overridden by this allowlist.

| Era | Documents | Current classification |
|---|---|---|
| 2026-04-18 convexity pivot | [`mission-pivot-2026-04-18.md`](./mission-pivot-2026-04-18.md), pure-ws docs | historical mission v1 |
| 2026-04-21 refinement | [`mission-refinement-2026-04-21.md`](./mission-refinement-2026-04-21.md) | superseded by Mission v2 |
| 2026-04-23 Option 5 | [`option5-kol-discovery-adoption-2026-04-23.md`](./option5-kol-discovery-adoption-2026-04-23.md) | retired discovery thesis after Edge Audit |
| 2026-04~05 lane expansion | lane/KOL/Helius/new-pair design docs | implementation and experiment history |
| pre-2026-04-18 | [`../historical/pre-pivot-2026-04-18/`](../historical/pre-pivot-2026-04-18/) | archive; current decisions must not cite as authority |

## Evidence That Superseded Option 5

- [`../../analysis/edge-audit-2026-06-10/EDGE_AUDIT_REPORT.md`](../../analysis/edge-audit-2026-06-10/EDGE_AUDIT_REPORT.md)
- [`../../analysis/survivor-momentum-phase0-2026-06-10/FINDINGS.md`](../../analysis/survivor-momentum-phase0-2026-06-10/FINDINGS.md)
- [`../../analysis/majors-lowfreq-phase0-2026-06-11/reports/PHASE0_REPORT.md`](../../analysis/majors-lowfreq-phase0-2026-06-11/reports/PHASE0_REPORT.md)
- [`../../analysis/coverage-postfix-2026-06-13/FINDINGS.md`](../../analysis/coverage-postfix-2026-06-13/FINDINGS.md)

## Reading Rules

- A date-stamped document's `current`, `active`, or live wording means current **at that date**.
- Dated docs, reports, debates, and ops history keep original values for auditability.
- Current status corrections belong in README, SESSION_START, MEMORY, HYPOTHESES, and this index.
- Runtime lane inventories in ARCHITECTURE/STRATEGY describe code retained in the repository, not
  an enabled or approved trading strategy.
- Rejected hypotheses may only return through the explicit re-test condition in HYPOTHESES.
