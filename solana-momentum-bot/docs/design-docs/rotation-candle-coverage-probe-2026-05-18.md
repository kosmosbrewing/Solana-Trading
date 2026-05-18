# Rotation Candle Coverage Probe (2026-05-18)

## Purpose

Mission reports found that historical candle-to-trade coverage is too low to promote candle-derived filters.
`rotation_candle_confirm_shadow_v1` should remain a strict paper-only confirmation arm, so coverage gaps need a
separate paper-only lane instead of weakening the confirmation rule.

## Arm

- `rotation_candle_coverage_probe_v1`
- parameter version: `rotation-candle-coverage-probe-v1.0.0`
- mode: paper-only / shadow only
- enabled by the existing `KOL_HUNTER_ROTATION_CANDLE_CONFIRM_SHADOW_PAPER_ENABLED` flag
- live order routing: none

## Admission

The arm uses the same pre-entry candle snapshot as `rotation_candle_confirm_shadow_v1`.

It opens only when the strict candle-confirm arm rejects due to:

- `insufficient_rows`
- `insufficient_trades`

It does not open when the snapshot is a quality failure:

- `source_unavailable`
- `buy_ratio_low`
- `pre_return_falling`
- `pre_volatile`

## Exit

It reuses the candle-confirm paper fail-cut:

- after the configured confirm horizon, default 30s
- if MFE is below the configured minimum and current return is negative
- closes as `rotation_candle_confirm_fail_cut`

## Reporting

`rotation_candle_coverage_probe_v1` is included in mission shadow-arm summaries. It is not promotion evidence by
itself. Its job is to show whether coverage-gap candidates are actually harmful, neutral, or recoverable in forward
paper data.

## Promotion Rule

No live promotion is allowed from this arm. A future candle filter may only use this data after:

- enough forward rows are collected,
- the same cohort has decision/plan linkage,
- wallet-cost stress remains positive,
- and the strict confirm arm still passes independently.
