# Environment Operating Profile — 2026-05-06

## Purpose

The generated env catalog is intentionally large. Runtime `.env` should not copy the catalog.

Use `.env` only for the currently active operating profile:

1. External secrets and infra endpoints
2. Global runtime/safety switches
3. Active lane live/paper toggles
4. Temporary experiment overrides

Everything else should rely on code defaults.

## Current Local Env Audit

Last checked: 2026-05-06 KST.

| Item | Result |
|---|---:|
| Assignments | 84 |
| Unique keys | 42 |
| Duplicate keys | 42 |
| Conflicting duplicate values | 0 observed |
| Malformed lines | 0 |

Interpretation: local `.env` appears to contain the same block twice. Remove the duplicated block first.

## Layer 0 — External Injection

These can live outside repo `.env` if the process manager or shell profile injects them.

Required at runtime:

```dotenv
SOLANA_RPC_URL=...
WALLET_PRIVATE_KEY=...
DATABASE_URL=...
```

Common optional infra:

```dotenv
HELIUS_API_KEY=...
HELIUS_WS_URL=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_ADMIN_USER_ID=...
JUPITER_API_KEY=...
JITO_RPC_URL=...
SANDBOX_WALLET_PRIVATE_KEY=...
```

Do not duplicate these in `.env` if pm2/systemd/shell already provides them.

## Layer 1 — Global Runtime And Safety

Recommended visible block:

```dotenv
TRADING_MODE=live
SCANNER_ENABLED=true
REALTIME_ENABLED=true
REALTIME_SEED_BACKFILL_ENABLED=true
PREFLIGHT_ENFORCE_GATE=true

CANARY_GLOBAL_CONCURRENCY_ENABLED=true
CANARY_GLOBAL_MAX_CONCURRENT=3
WALLET_DELTA_DRIFT_WARN_SOL=0.03
EXECUTION_RR_REJECT=false
```

These safety values match code defaults, but they are worth keeping visible during live operations:

```dotenv
WALLET_STOP_MIN_SOL=0.7
KOL_HUNTER_CANARY_MAX_TRADES=300
KOL_HUNTER_LIVE_MIN_INDEPENDENT_KOL=2
```

## Layer 2 — KOL Hunter Smart-v3 Live Canary

Smart-v3 is the main 5x lane. Minimal operating block:

```dotenv
KOL_TRACKER_ENABLED=true
KOL_HUNTER_ENABLED=true
KOL_HUNTER_PAPER_ONLY=false
KOL_HUNTER_LIVE_CANARY_ENABLED=true
KOL_HUNTER_LIVE_CANARY_ARMS=smart_v3_clean
KOL_HUNTER_CANARY_MAX_BUDGET_SOL=0.35
```

`KOL_HUNTER_LIVE_CANARY_ARMS` is the preferred control. If it is omitted, the
legacy arm flags are still honored for backward compatibility. Add
`smart_v3_quality_unknown_micro` only when intentionally testing unknown-only
quality fallbacks. That arm can route `EXIT_LIQUIDITY_UNKNOWN` /
`TOKEN_QUALITY_UNKNOWN` to live canary, but `NO_ROUTE`, rug, unclean token, and
holder-risk flags remain hard paper fallbacks. The `micro` suffix is a
restricted-arm label only; it uses the same live canary ticket as the rest of
KOL Hunter so paper/live cost ratios remain comparable.

Usually omit because code defaults are current mission defaults:

```dotenv
# default true / 5s / 3% MFE / 6% MAE
KOL_HUNTER_SMART_V3_MAE_FAST_FAIL_ENABLED=true
KOL_HUNTER_SMART_V3_MAE_FAST_FAIL_MIN_ELAPSED_SEC=5
KOL_HUNTER_SMART_V3_MAE_FAST_FAIL_MAX_MFE_PCT=0.03
KOL_HUNTER_SMART_V3_MAE_FAST_FAIL_MAX_MAE_PCT=0.06
KOL_HUNTER_SMART_V3_MAE_FAST_FAIL_FRESH_BUY_GRACE_SEC=15

# default true / MFE +10% recovery window / MAE cap -18% / 12s hold
KOL_HUNTER_SMART_V3_MAE_RECOVERY_HOLD_ENABLED=true
KOL_HUNTER_SMART_V3_MAE_RECOVERY_MIN_MFE_PCT=0.10
KOL_HUNTER_SMART_V3_MAE_RECOVERY_MAX_MAE_PCT=0.18
KOL_HUNTER_SMART_V3_MAE_RECOVERY_HOLD_SEC=12
```

Only keep version labels when comparing reports across a deployed parameter change:

```dotenv
KOL_HUNTER_PARAMETER_VERSION=...
KOL_HUNTER_SMART_V3_PARAMETER_VERSION=...
```

## Layer 3 — Rotation Lane

Rotation is the fast-compound KOL lane. It can run paper while canonical rotation live remains off.

Baseline paper/observe:

```dotenv
KOL_HUNTER_ROTATION_V1_ENABLED=true
KOL_HUNTER_ROTATION_V1_LIVE_ENABLED=false
```

Preferred live canary portfolio form:

```dotenv
KOL_HUNTER_LIVE_CANARY_ARMS=rotation_underfill_v1
```

Legacy equivalent for the single underfill arm:

```dotenv
KOL_HUNTER_ROTATION_CHASE_TOPUP_LIVE_CANARY_ENABLED=false
KOL_HUNTER_ROTATION_CHASE_TOPUP_PARAMETER_VERSION=rotation-chase-topup-v1.0.0
KOL_HUNTER_ROTATION_CHASE_TOPUP_PAPER_ENABLED=true
KOL_HUNTER_ROTATION_CHASE_TOPUP_MIN_BUYS=2
KOL_HUNTER_ROTATION_CHASE_TOPUP_MIN_TOPUP_STRENGTH=0.08
KOL_HUNTER_ROTATION_CHASE_TOPUP_MAX_RECENT_SELL_SEC=60
KOL_HUNTER_ROTATION_UNDERFILL_PAPER_ENABLED=true
KOL_HUNTER_ROTATION_UNDERFILL_LIVE_CANARY_ENABLED=true
KOL_HUNTER_ROTATION_UNDERFILL_LIVE_EXIT_FLOW_ENABLED=true
```

Usually omit because code defaults are active:

```dotenv
# default true / 5s / 1.5% MFE / 3% MAE
KOL_HUNTER_ROTATION_MAE_FAST_FAIL_ENABLED=true
KOL_HUNTER_ROTATION_MAE_FAST_FAIL_MIN_ELAPSED_SEC=5
KOL_HUNTER_ROTATION_MAE_FAST_FAIL_MAX_MFE_PCT=0.015
KOL_HUNTER_ROTATION_MAE_FAST_FAIL_MAX_MAE_PCT=0.03

# default paper validation arms are enabled
KOL_HUNTER_ROTATION_PAPER_ARMS_ENABLED=true
KOL_HUNTER_ROTATION_CHASE_TOPUP_PAPER_ENABLED=true
KOL_HUNTER_ROTATION_UNDERFILL_PAPER_ENABLED=true
KOL_HUNTER_ROTATION_EXIT_FLOW_PAPER_ENABLED=true

# default 1 hour, aligned with smart-v3 paper/hourly digest cadence
KOL_HUNTER_ROTATION_PAPER_DIGEST_INTERVAL_MS=3600000
```

## Layer 4 — Pure WS

Pure WS is currently a new-pair rebuild / paper-observation candidate, not a Mayhem-following live lane.

Recommended paper-first block:

```dotenv
PUREWS_LANE_ENABLED=true
PUREWS_LIVE_CANARY_ENABLED=false
PUREWS_SWING_V2_LIVE_CANARY_ENABLED=false
```

Usually omit because code defaults are active:

```dotenv
PUREWS_PAPER_SHADOW_ENABLED=true
PUREWS_PAPER_NOTIFY_ENABLED=true
PUREWS_PAPER_NOTIFY_INDIVIDUAL_ENABLED=false
PUREWS_PAPER_DIGEST_ENABLED=true
PUREWS_NEW_PAIR_SOURCE_GATE_ENABLED=true

# default 15 minutes
PUREWS_PAPER_DIGEST_INTERVAL_MS=900000
```

## Layer 5 — Historical Or Disabled Lanes

Keep these only when explicitly testing those lanes:

```dotenv
CUPSEY_WALLET_MODE=...
MIGRATION_LANE_ENABLED=...
MIGRATION_WALLET_MODE=...
KOL_HUNTER_SWING_V2_ENABLED=...
KOL_HUNTER_SHADOW_TRACK_INACTIVE=...
KOL_HUNTER_SHADOW_PAPER_TRADE_ENABLED=...
```

If a lane is not being tested, delete the key from runtime `.env` and rely on defaults.

## Minimal Operating Env Shape

For the current desired profile:

```dotenv
# External secrets may be injected outside this file.

TRADING_MODE=live
SCANNER_ENABLED=true
REALTIME_ENABLED=true
REALTIME_SEED_BACKFILL_ENABLED=true
PREFLIGHT_ENFORCE_GATE=true

CANARY_GLOBAL_CONCURRENCY_ENABLED=true
CANARY_GLOBAL_MAX_CONCURRENT=3
WALLET_DELTA_DRIFT_WARN_SOL=0.03
EXECUTION_RR_REJECT=false
WALLET_STOP_MIN_SOL=0.7

KOL_TRACKER_ENABLED=true
KOL_HUNTER_ENABLED=true
KOL_HUNTER_PAPER_ONLY=false
KOL_HUNTER_LIVE_CANARY_ENABLED=true
KOL_HUNTER_CANARY_MAX_BUDGET_SOL=0.35
KOL_HUNTER_CANARY_MAX_TRADES=300
KOL_HUNTER_LIVE_MIN_INDEPENDENT_KOL=2
KOL_HUNTER_LIVE_CANARY_ARMS=smart_v3_clean,rotation_underfill_v1
KOL_HUNTER_SMART_V3_PARAMETER_VERSION=smart-v3.0.1-live-canary-2026-05-09

KOL_HUNTER_ROTATION_V1_ENABLED=true
KOL_HUNTER_ROTATION_V1_LIVE_ENABLED=false
# Promoted rotation live canary is underfill only; chase-topup stays paper.
KOL_HUNTER_ROTATION_CHASE_TOPUP_LIVE_CANARY_ENABLED=false
KOL_HUNTER_ROTATION_CHASE_TOPUP_PARAMETER_VERSION=rotation-chase-topup-v1.0.0
KOL_HUNTER_ROTATION_CHASE_TOPUP_PAPER_ENABLED=true
KOL_HUNTER_ROTATION_CHASE_TOPUP_MIN_BUYS=2
KOL_HUNTER_ROTATION_CHASE_TOPUP_MIN_TOPUP_STRENGTH=0.08
KOL_HUNTER_ROTATION_CHASE_TOPUP_MAX_RECENT_SELL_SEC=60
KOL_HUNTER_ROTATION_UNDERFILL_PAPER_ENABLED=true
KOL_HUNTER_ROTATION_UNDERFILL_LIVE_CANARY_ENABLED=true
KOL_HUNTER_ROTATION_UNDERFILL_LIVE_EXIT_FLOW_ENABLED=true

PUREWS_LANE_ENABLED=true
PUREWS_LIVE_CANARY_ENABLED=false
PUREWS_SWING_V2_LIVE_CANARY_ENABLED=false
```

This should be the default operator-facing `.env` size. Add experiment overrides only for the duration of a measured sprint, then remove them.

## Deployment Note

Runtime `.env` is intentionally gitignored. It may contain private keys and RPC/API credentials, so do not remove `.env` from `.gitignore`.

Non-secret operational overrides are tracked in:

```text
ops/env/production.env
```

Deploy behavior:

1. `scripts/deploy.sh` runs `git pull`.
2. If `DEPLOY_ENV_PROFILE` is unset, it uses `ops/env/production.env`.
3. The profile is merged into runtime `.env` by `scripts/merge-env-profile.js`.
4. Existing secrets remain in runtime `.env` or shell env; do not put them in the profile.
5. A timestamped `.env.backup-*` file is created before writing.

Remote deploy behavior:

1. `scripts/deploy-remote.sh` refreshes the remote repo before invoking remote `scripts/deploy.sh`.
2. This allows profile-merge changes to take effect on the first deployment after `git push`.
3. `deploy-remote.sh --sync-env` still exists for emergency local-env merge, but normal operation should use tracked `ops/env/production.env` plus remote-only secrets.

To skip profile merge for an emergency deploy:

```bash
DEPLOY_ENV_PROFILE= bash scripts/deploy.sh
```

To use another tracked profile:

```bash
DEPLOY_ENV_PROFILE=ops/env/some-other.env bash scripts/deploy.sh
```

After editing, verify exact key spelling. In particular, `gOL_HUNTER_LIVE_CANARY_ENABLED` is invalid; the runtime key is `KOL_HUNTER_LIVE_CANARY_ENABLED`.

## Cleanup Checklist

1. Remove the duplicated `.env` block.
2. Keep external secrets in only one place: `.env`, shell profile, or pm2 ecosystem.
3. Delete keys that match code defaults unless they document an active experiment.
4. Keep live opt-in flags explicit.
5. Keep version labels only when report comparisons require them.
6. Run `npm run env:check` after cleanup.
