# KOL Wallet Alias Audit

> Date: 2026-04-26
> Source of truth: `data/kol/wallets.json`
> Scope: 47 wallet addresses in KOL DB

## Rules

- `internal_alias` is the bot identifier used by KOL DB and scoring.
- `display_label` is an operator/research nickname. It is safe for dashboards but not proof of public identity.
- `public_alias_status=confirmed` means a stable public nickname was visible in a public source.
- `public_alias_status=unverified` means the address was found or discussed publicly, but no stable nickname should be assumed.
- `public_alias_status=none` means only an internal/operator label exists.

## Summary

| Metric | Value |
|---|---:|
| Total addresses | 47 |
| Active addresses | 27 |
| Inactive/watch addresses | 20 |
| Stable internal aliases | 47 |
| Stable public aliases confirmed in this pass | 0 |

## Active Addresses

| # | Address | internal_alias | display_label | Tier | public_alias_status | Notes |
|---:|---|---|---|---|---|---|
| 1 | `5rkP7bqEUqwURvqFmKwLSxT5YkoHEyJLehmXUpUiFHQh` | `josim` | 조심 | A | none | Operator-provided label. |
| 2 | `8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd` | `pow` | 포우 본지갑 | A | none | Operator-provided main wallet label. |
| 3 | `98W9eaX28YNW25A2GreFnSZ48avhf7oFyd674M5Q83sY` | `pow` | 포우 부지갑2 | A | none | Operator-provided sub-wallet label. |
| 4 | `H1gJR25VXi5Ape1gAU7fTWzZFWaCpuP3rzRtKun8Dwo2` | `pow` | 포우 부지갑1 | A | none | Operator-provided sub-wallet label. |
| 5 | `DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm` | `dunpa_gake` | 던파/Gake 본지갑 | A | research_label | Public research claims strong PnL, but nickname is operator/research label. |
| 6 | `CNudZYFgpbT26fidsiNrWfHeGTBMMeVWqruZXsEkcUPc` | `dunpa_gake` | 던파/Gake 부지갑 | A | none | Operator-provided sub-wallet label. |
| 7 | `EwTNPYTuwxMzrvL19nzBsSLXdAoEmVBKkisN87csKgtt` | `dunpa_gake` | 던파/Gake 벡터지갑 | A | research_label | Previously labeled `gake_vector`. |
| 8 | `CRVidEDtEUTYZisCxBZkpELzhQc9eauMLR3FWg74tReL` | `frank` | 프랭크 본지갑 | A | none | Operator-provided label. |
| 9 | `HA2KtZGZrNTFpKLTQsV82RwG3DpYUdDLJ5JqCrMHbm7t` | `frank` | 프랭크 부지갑 | A | none | Operator-provided label. |
| 10 | `HUpPyLU8KWisCAr3mzWy2FKT6uuxQ2qGgJQxyTpDoes5` | `oxsun` | OxSun | A | research_label | Public research label, not separately re-confirmed here. |
| 11 | `8yJFWmVTQq69p6VJxGwpzW7ii7c5J9GRAtHCNMMQPydj` | `lexapro` | LexaPro | A | none | Operator-provided label. |
| 12 | `DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj` | `euris` | Euris | A | research_label | Public posts discuss this address; alias kept as research label. |
| 13 | `G1pRtSyKuWSjTqRDcazzKBDzqEF96i1xSURpiXj3yFcc` | `crypto_d` | Crypto D | A | none | Operator-provided label. |
| 14 | `ATmKENkRrL1JQQnoUNAQvkiwgjiHKUkzyncxTGxyzQL1` | `lebron` | 르브론 본지갑 | A | research_label | Public research label, not separately re-confirmed here. |
| 15 | `HAN61KQbgzjDBC4RpZJ1ET8v32S4zdKAjoD7EApJ96q6` | `pain` | Pain | A | none | Operator-provided label. |
| 16 | `6mdNNjGPARKVRUKEQ3DkYtFF1FcY7WrZGsd1kYoTozRm` | `gorapandeok` | gorapandeok | B | none | Secondary-list label. |
| 17 | `A1ECE86o3tz6UWmwMWicrqZmwRZ7RCRzmYYa9okNQRBw` | `him` | him | B | none | Secondary-list label. |
| 18 | `DjAfkjAV7qD6U2qjjU5RdcuzXwdk1gF3CtiWwGZc8pxJ` | `pasternak` | pasternak | B | none | Secondary-list label. |
| 19 | `4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9` | `decu` | decu | S | research_label | Added from KOL research; use as discovery signal. |
| 20 | `G6fUXjMKPJzCY1rveAE6Qm7wy5U3vZgKDJmN1VPAdiZC` | `clukz` | clukz | S | research_label | Added from KOL research; tail-catcher candidate. |
| 21 | `JDd3hy3gQn2V982mi1zqhNqUw1GfV2UL6g76STojCJPN` | `west_ratwizardx` | West @ratwizardx | A | research_label | Research label. |
| 22 | `Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt` | `theo` | theo | A | research_label | Research label. |
| 23 | `4sAUSQFdvWRBxR8UoLBYbw8CcXuwXWxnN8pXa4mtm5nU` | `scharo` | Scharo | A | research_label | Research label. |
| 24 | `Gdaqp3ND6r3HVAWXpawkQU18EuQqwNxpaeeio8ASVAYd` | `gdaqp3` | Gdaqp3 | A | unverified | OKX page exists; stable public nickname not confirmed. |
| 25 | `BfLgBboMdNZLJFMkm3g89RK5sZ6VPGFQg5xUSoM6bJV8` | `bflg` | BfLg | S | unverified | Address-prefix label from research. |
| 26 | `2Ekawy8GtvEcroUMjdhthP18fUi1ZGFRkMdwtQrGzrH2` | `ekawy_2` | 2Ekawy | A | unverified | Address-prefix label from research. |
| 27 | `DzFkEdqJNVQTri6gVJKvGWyaBx8QY4EuALySpsHxXuUL` | `dzfk` | DzFk | A | unverified | Address-prefix label from research. |

## Inactive / Watch Addresses

| # | Address | internal_alias | display_label | Tier | public_alias_status | Notes |
|---:|---|---|---|---|---|---|
| 28 | `2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f` | `cupsey_benchmark` | Cupsey | S | research_label | Benchmark only, not active KOL trigger. |
| 29 | `CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o` | `cented_benchmark` | Cented | S | research_label | Benchmark only. |
| 30 | `3LUfv2u5yzsDtUzPdsSJ7ygPBuqwfycMkjpNreRR2Yww` | `domy_watch` | Domy @domyxbt | B | research_label | Watch until 30d PnL/tail evidence is rebuilt. |
| 31 | `78N177fzNJpp8pG49xDv1efYcTMSzo9tPTKEA9mAVkh2` | `sheep_watch` | Sheep | B | research_label | Watch candidate. |
| 32 | `FTg1gqW7vPm4kdU1LPM7JJnizbgPdRDy2PitKw6mY27j` | `ftg1_watch` | FTg1 | A | unverified | OKX page exists; stable nickname not confirmed. |
| 33 | `GwyG5FQRNtY1faXYWdTLbcDNZTyW5d2Z63o1UiMUDQDT` | `gwyg_watch` | GwyG | A | unverified | Address-prefix research label. |
| 34 | `2btYi2pqVgtgzLqeAXE122FPhN2xBJMQpE1V9CMNv4EH` | `btyi_2_watch` | 2btYi | B | unverified | Address-prefix research label. |
| 35 | `91e6tkWuCikpchersigVKqVtdMCBSfMNMui9LXpdz8qk` | `wallet_91e6_watch` | 91e6 | B | unverified | Address-prefix research label. |
| 36 | `GHXV4xsQjKETxeKFSAQuGLBDni5zZvMyM8EEmRDETWKH` | `believe_buyback` | believe buyback | B | project_label | Project/treasury-like wallet. |
| 37 | `4mC4CWyKDqUdShmUiYS4FvB8gZEKh4GD7SnmdKTpWM1k` | `believe_foundation` | believe foundation | B | project_label | Project/foundation wallet. |
| 38 | `9dHzzDRHmBzuT7hJ3Es9YktAKow4VKGpbvDRKYi3jvnC` | `solhana_old` | 솔하나 | B | none | Old-group label. |
| 39 | `215nhcAHjQQGgwpQSJQ7zR26etbjjtVdW74NLzwEgQjP` | `secondary_unverified_pool` | unknown_01 | B | none | Unverified secondary-list address. |
| 40 | `AnsazR3Rf7LK2P6dKmwdyr6bzknaw8WyaVKzh5s8LXqM` | `secondary_unverified_pool` | unknown_02 | B | none | Unverified secondary-list address. |
| 41 | `9ydzS7dEvpQjzErnXGDbmgSRYGzFDFkWV3bkfrJWDKDE` | `secondary_unverified_pool` | unknown_03 | B | none | Unverified secondary-list address. |
| 42 | `H4JnKMWvzuuF9YR79Y9Yvpe8ATE8mBunxFx8kq3XM3zB` | `secondary_unverified_pool` | unknown_04 | B | none | Unverified secondary-list address. |
| 43 | `4kce1EvUHwHyWxur8ApZDifHS3W17yPXddNxoLatHwnT` | `secondary_unverified_pool` | unknown_05 | B | none | Unverified secondary-list address. |
| 44 | `7jPTpyAtPXZ3uFduPyiHFqrWvq3wcJq3XmHgykidQJUD` | `secondary_unverified_pool` | unknown_06 | B | none | Unverified secondary-list address. |
| 45 | `FVk1Fw2wgBo9S77ydKphGpWnDgsBw5Jkqx2rYSACo737` | `secondary_unverified_pool` | unknown_07 | B | none | Unverified secondary-list address. |
| 46 | `5M8ACGKEXG1ojKDTMH3sMqhTihTgHYMSsZc6W8i7QW3Y` | `secondary_unverified_pool` | unknown_08 | B | none | Unverified secondary-list address. |
| 47 | `AVAZvHLR2PcWpDf8BXY4rVxNHYRBytycHkcB5z5QNXYm` | `secondary_unverified_pool` | AVAZ | B | address_label | Historical address-prefix label; keep inactive. |

## Source Notes

- Operator labels come from the original KOL wallet list provided by the operator.
- Research labels come from prior KOL research notes and should be treated as labels, not identity proof.
- `Gdaqp3` and `FTg1` have OKX analysis pages, but no stable public nickname was confirmed in this audit.
- Unknown secondary pool addresses should not be activated until a nickname, role, and 30d/90d behavior are reconstructed.

## Follow-Up

- Add `role` or `copy_eligible` to KOL DB before using public aliases for copy decisions.
- Re-run this audit monthly after KOL DB refresh.
- If public alias is required for UI, prefer `display_label` and show `public_alias_status`.
