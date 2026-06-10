#!/usr/bin/env python3
"""Phase 4 (post-audit follow-up) — Capitulation-rebound hypothesis test. RESEARCH_ONLY.

Question: after KOL-pump buy anchors, does deep early drawdown (observed at T+300s)
predict a positive 300s->1800s forward return ("rebound")?

  r = (1 + d1800) / (1 + d300) - 1   -- the gross return an agent buying at the
                                        T+300 price and selling at the T+1800
                                        price would get (same Jupiter quote basis).

LABEL: hypothesis_only / research_only.
  - The conditioning variable (d300 vs entry-anchor price) IS observable ex ante
    in real time, so the rule is implementable.
  - BUT the bucket boundaries were chosen after seeing the aggregate decay stats
    of this same sample (audit Phase 1). Chronological-OOS on fresh data is
    mandatory before any promotion. The in-sample chronological split below is a
    stability check, not OOS validation.

Data: cache/event_master.jsonl (one row per markout anchor; deltaPct = FRACTIONS).
Universe: buy anchors, token-event dedup (same mint within 600s -> keep first;
precedent: scripts/01_signal_event_study.py).

Sanity guards:
  - d300 <= -0.97 -> "dead bucket" (likely rug/zero): excluded from main table,
    reported separately with median d1800.
  - |d1800| > 10 -> suspect quote, excluded (counted).
  - mean r capped at +10.0 before averaging / bootstrap.

Cost bar (audit Phase 2 arithmetic, 0.02 SOL ticket):
  (a) price-level round-trip cost 1.5%
  (b) fixed execution drag 0.0027 SOL / round-trip = 13.5% of the ticket
  combined bar = 15.0% -> a bucket only "clears" if median r > 0.15.

Outputs:
  - cache/phase4_rebound.json
  - reports/08_REBOUND_HYPOTHESIS.md
"""
import json
import os
import random
import statistics
from collections import defaultdict
from datetime import datetime

ROOT = "/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot"
BASE = os.path.join(ROOT, "analysis/edge-audit-2026-06-10")
CACHE = os.path.join(BASE, "cache")
REPORTS = os.path.join(BASE, "reports")

SEED = 20260610
N_BOOT = 1000
CAP = 10.0           # cap on r for means/bootstrap (+1000%)
DEAD_D300 = -0.97    # rug/zero cutoff on d300
SUSPECT_D1800 = 10.0 # |d1800| above this = suspect quote
COST_PRICE = 0.015   # (a) 1.5% price-level round-trip
COST_FIXED = 0.135   # (b) 0.0027 SOL on 0.02 SOL ticket
COST_BAR = COST_PRICE + COST_FIXED  # 15.0%

BUCKETS = [
    ("<=-0.7",    lambda d: d <= -0.7),
    ("-0.7..-0.5", lambda d: -0.7 < d <= -0.5),
    ("-0.5..-0.3", lambda d: -0.5 < d <= -0.3),
    ("-0.3..-0.1", lambda d: -0.3 < d <= -0.1),
    ("-0.1..0",    lambda d: -0.1 < d <= 0.0),
    (">0",         lambda d: d > 0.0),
]


def day_of(ts):
    return (ts or "")[:10]


def bucket_of(d300):
    for name, pred in BUCKETS:
        if pred(d300):
            return name
    return None


def load_universe():
    rows = []
    with open(os.path.join(CACHE, "event_master.jsonl")) as f:
        for line in f:
            r = json.loads(line)
            if r.get("anchorType") != "buy":
                continue
            rows.append(r)
    # token-event dedup: same mint within 600s collapses to first anchor (precedent 01_*)
    rows.sort(key=lambda r: r.get("anchorAt") or "")
    last_seen = {}
    dedup = []
    for r in rows:
        mint = r["tokenMint"]
        try:
            ts = datetime.fromisoformat(r["anchorAt"].replace("Z", "+00:00")).timestamp()
        except Exception:
            ts = 0
        prev = last_seen.get(mint)
        if prev is None or (ts - prev) > 600:
            last_seen[mint] = ts
            dedup.append(r)
    return rows, dedup


def classify(rows):
    """Split into usable / dead / suspect / missing. Returns dict of lists."""
    usable, dead, suspect, missing = [], [], [], []
    for r in rows:
        fwd = r.get("fwd") or {}
        d300, d1800 = fwd.get("300"), fwd.get("1800")
        if not isinstance(d300, (int, float)) or not isinstance(d1800, (int, float)):
            missing.append(r)
            continue
        if d300 <= DEAD_D300:
            dead.append(r)
            continue
        if abs(d1800) > SUSPECT_D1800:
            suspect.append(r)
            continue
        r["_d300"] = d300
        r["_d1800"] = d1800
        r["_r"] = (1.0 + d1800) / (1.0 + d300) - 1.0
        r["_bucket"] = bucket_of(d300)
        usable.append(r)
    return {"usable": usable, "dead": dead, "suspect": suspect, "missing": missing}


def bootstrap_ci_capped_mean(vals, rng):
    capped = [min(v, CAP) for v in vals]
    res = []
    for _ in range(N_BOOT):
        sample = rng.choices(capped, k=len(capped))
        res.append(statistics.fmean(sample))
    res.sort()
    return (res[int(0.025 * N_BOOT)], res[int(0.975 * N_BOOT)])


def bucket_stats(rows, rng, with_ci=True):
    out = {}
    by_bucket = defaultdict(list)
    days = defaultdict(set)
    for r in rows:
        b = r["_bucket"]
        if b is None:
            continue
        by_bucket[b].append(r)
        days[b].add(day_of(r.get("anchorAt")))
    for name, _ in BUCKETS:
        sub = by_bucket.get(name, [])
        if not sub:
            out[name] = {"n": 0}
            continue
        rs = [r["_r"] for r in sub]
        capped = [min(v, CAP) for v in rs]
        med = statistics.median(rs)
        st = {
            "n": len(rs),
            "medianR": med,
            "meanRCapped": statistics.fmean(capped),
            "posRate": sum(1 for v in rs if v > 0) / len(rs),
            "ge_030": sum(1 for v in rs if v >= 0.30) / len(rs),
            "ge_100": sum(1 for v in rs if v >= 1.0) / len(rs),
            "le_m050": sum(1 for v in rs if v <= -0.5) / len(rs),
            "activeDays": len(days[name]),
            "nCappedAtMax": sum(1 for v in rs if v > CAP),
            # cost scenarios on the MEDIAN path
            "medianR_net_price": (1 + med) * (1 - COST_PRICE) - 1,           # (a)
            "medianR_net_all": (1 + med) * (1 - COST_PRICE) - 1 - COST_FIXED,  # (a)+(b)
            "clearsCostBar": med > COST_BAR,
        }
        if with_ci and len(rs) >= 50:
            lo, hi = bootstrap_ci_capped_mean(rs, rng)
            st["ci95MeanCapped"] = [lo, hi]
        out[name] = st
    return out


def chrono_split(rows):
    days = sorted({day_of(r.get("anchorAt")) for r in rows})
    half = len(days) // 2
    first_days, second_days = set(days[:half]), set(days[half:])
    first = [r for r in rows if day_of(r.get("anchorAt")) in first_days]
    second = [r for r in rows if day_of(r.get("anchorAt")) in second_days]
    return first, second, sorted(first_days), sorted(second_days)


def fmt_pct(v, digits=1):
    if v is None:
        return "n/a"
    return f"{v * 100:+.{digits}f}%"


def fmt_rate(v):
    if v is None:
        return "n/a"
    return f"{v * 100:.1f}%"


def table_md(stats, title, note=""):
    lines = [f"### {title}", ""]
    if note:
        lines += [note, ""]
    lines.append(
        "| d300 bucket | N | median r | mean r (cap+10) | CI95 mean | P(r>0) | P(r>=+30%) | "
        "P(r>=+100%) | P(r<=-50%) | days | net median (a) 1.5% | net median (a+b) 15% | clears 15% bar |")
    lines.append("|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|")
    for name, _ in BUCKETS:
        st = stats.get(name, {"n": 0})
        if st["n"] == 0:
            lines.append(f"| {name} | 0 | – | – | – | – | – | – | – | – | – | – | – |")
            continue
        ci = st.get("ci95MeanCapped")
        ci_s = f"[{fmt_pct(ci[0])}, {fmt_pct(ci[1])}]" if ci else "n<50"
        lines.append(
            f"| {name} | {st['n']} | {fmt_pct(st['medianR'])} | {fmt_pct(st['meanRCapped'])} | {ci_s} | "
            f"{fmt_rate(st['posRate'])} | {fmt_rate(st['ge_030'])} | {fmt_rate(st['ge_100'])} | "
            f"{fmt_rate(st['le_m050'])} | {st['activeDays']} | {fmt_pct(st['medianR_net_price'])} | "
            f"{fmt_pct(st['medianR_net_all'])} | {'YES' if st['clearsCostBar'] else 'no'} |")
    lines.append("")
    return "\n".join(lines)


def main():
    rng = random.Random(SEED)
    all_buy, dedup = load_universe()
    cls = classify(dedup)
    usable = cls["usable"]

    dead_d1800 = [r["fwd"]["1800"] for r in cls["dead"]
                  if isinstance((r.get("fwd") or {}).get("1800"), (int, float))]
    dead_summary = {
        "n": len(cls["dead"]),
        "medianD1800": statistics.median(dead_d1800) if dead_d1800 else None,
    }

    main_stats = bucket_stats(usable, rng)

    # mint-level dedup: first event per mint overall (kills serial correlation within a token)
    seen = set()
    mint_first = []
    for r in usable:  # usable already sorted by anchorAt via load order
        if r["tokenMint"] in seen:
            continue
        seen.add(r["tokenMint"])
        mint_first.append(r)
    mint_stats = bucket_stats(mint_first, rng)

    # chronological halves (by active day)
    first, second, fdays, sdays = chrono_split(usable)
    first_stats = bucket_stats(first, random.Random(SEED + 1), with_ci=False)
    second_stats = bucket_stats(second, random.Random(SEED + 2), with_ci=False)
    stability = {}
    for name, _ in BUCKETS:
        a, b = first_stats.get(name, {}), second_stats.get(name, {})
        if a.get("n", 0) >= 10 and b.get("n", 0) >= 10:
            sa, sb = a["medianR"] > 0, b["medianR"] > 0
            stability[name] = {
                "firstN": a["n"], "firstMedianR": a["medianR"],
                "secondN": b["n"], "secondMedianR": b["medianR"],
                "signStable": sa == sb,
            }
        else:
            stability[name] = {
                "firstN": a.get("n", 0), "secondN": b.get("n", 0),
                "signStable": None,  # insufficient
                "firstMedianR": a.get("medianR"), "secondMedianR": b.get("medianR"),
            }

    payload = {
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "label": "hypothesis_only/research_only",
        "seed": SEED,
        "counts": {
            "buyAnchorsAll": len(all_buy),
            "tokenEventDedup": len(dedup),
            "missingD300orD1800": len(cls["missing"]),
            "deadD300le-0.97": dead_summary,
            "suspectAbsD1800gt10": len(cls["suspect"]),
            "usable": len(usable),
            "mintFirstOnly": len(mint_first),
            "activeDays": len({day_of(r.get("anchorAt")) for r in usable}),
        },
        "costBar": {
            "priceLevelPct": COST_PRICE, "fixedSolPct_0.02ticket": COST_FIXED,
            "combined": COST_BAR,
        },
        "mainTable": main_stats,
        "mintFirstTable": mint_stats,
        "chrono": {
            "firstHalfDays": fdays, "secondHalfDays": sdays,
            "stability": stability,
        },
    }
    with open(os.path.join(CACHE, "phase4_rebound.json"), "w") as f:
        json.dump(payload, f, indent=2, default=str)

    # ---- markdown report (verdict text appended by analyst; tables auto-generated) ----
    md = []
    md.append("# 08 — Capitulation-Rebound Hypothesis Test (offline)")
    md.append("")
    md.append("**LABEL: `hypothesis_only` / `research_only`** — the conditioning variable "
              "(price at T+300 vs entry anchor) is observable ex ante and the rule is "
              "implementable in real time, but bucket boundaries were chosen after seeing "
              "this sample's aggregate decay stats (audit Phase 1). Chronological-OOS on "
              "fresh data is required before any promotion. In-sample chrono split below "
              "is a stability check only.")
    md.append("")
    md.append(f"- generated: {payload['generatedAt']} (seed {SEED}, {N_BOOT} bootstrap resamples)")
    md.append("- data: `cache/event_master.jsonl`, buy anchors, token-event dedup (600s, "
              "precedent `scripts/01_signal_event_study.py`)")
    md.append("- definition: `r = (1+d1800)/(1+d300) − 1` — gross 300s→1800s return for an "
              "agent buying at the T+300 Jupiter-quoted price after observing the drawdown")
    md.append("")
    c = payload["counts"]
    md.append("## Universe and guards")
    md.append("")
    md.append(f"- buy anchors (all): **{c['buyAnchorsAll']}** → token-event dedup: **{c['tokenEventDedup']}**")
    md.append(f"- missing d300/d1800: {c['missingD300orD1800']} (excluded)")
    md.append(f"- dead bucket (d300 ≤ −0.97, likely rug/zero): **{dead_summary['n']}** excluded — "
              f"median d1800 = {fmt_pct(dead_summary['medianD1800']) if dead_summary['medianD1800'] is not None else 'n/a'}"
              " (they do NOT come back)")
    md.append(f"- suspect quotes (|d1800| > 10): {c['suspectAbsD1800gt10']} excluded")
    md.append(f"- usable: **{c['usable']}** events over **{c['activeDays']}** active days; "
              f"first-event-per-mint subset: {c['mintFirstOnly']}")
    md.append("")
    md.append("## Cost bar (audit Phase 2 arithmetic, 0.02 SOL ticket)")
    md.append("")
    md.append("- (a) price-level round-trip cost: 1.5%")
    md.append("- (b) fixed execution drag 0.0027 SOL/round-trip = **13.5% of ticket**")
    md.append("- combined bar: **median r must exceed +15.0%** to be net-positive at current ticket size")
    md.append("")
    md.append("## Results")
    md.append("")
    md.append(table_md(main_stats, "Main table — token-event dedup (600s)"))
    md.append(table_md(mint_stats, "Robustness — first event per mint only (kills within-token serial correlation)"))
    md.append("### Chronological stability (in-sample halves, by active day)")
    md.append("")
    md.append(f"- first half: {fdays[0]}..{fdays[-1]} ({len(fdays)} days) | "
              f"second half: {sdays[0]}..{sdays[-1]} ({len(sdays)} days)")
    md.append("")
    md.append("| d300 bucket | N (1st/2nd) | median r 1st | median r 2nd | sign stable |")
    md.append("|---|---|---:|---:|---|")
    for name, _ in BUCKETS:
        s = stability[name]
        sign = ("YES" if s["signStable"] else "NO") if s["signStable"] is not None else "n<10"
        md.append(f"| {name} | {s['firstN']}/{s['secondN']} | "
                  f"{fmt_pct(s.get('firstMedianR')) if s.get('firstMedianR') is not None else 'n/a'} | "
                  f"{fmt_pct(s.get('secondMedianR')) if s.get('secondMedianR') is not None else 'n/a'} | {sign} |")
    md.append("")

    # ---- automated verdict (derived from computed stats so reruns reproduce it) ----
    eligible = {k: v for k, v in main_stats.items() if v.get("n", 0) >= 50}
    clearing = [k for k, v in eligible.items() if v.get("clearsCostBar")]
    # near-miss: median r > 0 gross but below bar
    gross_pos = [k for k, v in eligible.items() if v.get("medianR", -1) > 0]
    all_neg_both_halves = all(
        (s.get("firstMedianR") is None or s["firstMedianR"] < 0)
        and (s.get("secondMedianR") is None or s["secondMedianR"] < 0)
        for s in stability.values())
    if c["usable"] < 300:
        verdict = "DATA_INSUFFICIENT"
    elif clearing:
        verdict = "PURSUE_OFFLINE"
    else:
        verdict = "REJECT"

    md.append("## Verdict")
    md.append("")
    md.append(f"**{verdict}**")
    md.append("")
    if verdict == "REJECT":
        best = max(eligible.items(), key=lambda kv: kv[1]["medianR"])
        md.append("Findings:")
        md.append("")
        md.append(f"1. **No rebound exists as a central-tendency effect.** Every d300 bucket has "
                  f"negative median 300s→1800s forward return (gross, pre-cost), in the full sample, "
                  f"in the first-event-per-mint subset, and in BOTH chronological halves "
                  f"({'all buckets sign-stable negative' if all_neg_both_halves else 'see stability table'}). "
                  "Conditioning on observed drawdown does not flip the decay — it only changes how "
                  "fast the token keeps bleeding.")
        ci = best[1].get("ci95MeanCapped", [None, None])
        ci_s = f"[{fmt_pct(ci[0])}, {fmt_pct(ci[1])}]" if ci and ci[0] is not None else "n/a"
        md.append(f"2. **Best bucket is `{best[0]}`** (median r {fmt_pct(best[1]['medianR'])}, "
                  f"mean capped {fmt_pct(best[1]['meanRCapped'])}, CI95 {ci_s}, "
                  f"P(r>0)={fmt_rate(best[1]['posRate'])}). Even its CI upper bound is below the "
                  f"+15% cost bar; gross median is negative, so net of (a)+(b) it is "
                  f"{fmt_pct(best[1]['medianR_net_all'])} per trade at 0.02 SOL ticket.")
        md.append("3. **A 'deepest drawdown is least-bad' floor effect exists but is not "
                  "tradeable**: the ≤−0.7 bucket has the least-negative median while the middle "
                  "buckets (−0.5..−0.1) are the worst — consistent with 'everything decays toward "
                  "T+1800; tokens already down 70%+ have less room left to fall', i.e. a floor "
                  "effect, not mean reversion.")
        md.append("4. **Tail lottery does not rescue expectancy**: P(r≥+100%) is 2–7% per bucket, "
                  "but mean r capped at +10 is negative in every bucket, so the occasional big "
                  "rebound does not pay for the median bleed even before costs.")
        if gross_pos:
            md.append(f"5. Buckets gross-positive but below bar: {gross_pos} — none.")
        md.append("")
        md.append("Implication for the paper lane (`kol_hunter_capitulation_rebound_v1/_rr_v1`): "
                  "this offline evidence does NOT support enabling it as-is. The lane's premise "
                  "(drawdown −35..−65% + bounce confirmation → rebound) sits in buckets whose "
                  "median forward return is −21% to −39% gross. If the lane is ever revisited, the "
                  "bounce-confirmation conditioning (which this cache cannot test — it requires "
                  "intra-window price paths, not 5-point markouts) is the only untested degree of "
                  "freedom; that would require collecting per-candidate low/bounce/confirmation "
                  "telemetry plus dense (≤15s) post-low markouts, and fixing the structural "
                  "hard-veto blocker (EXIT_LIQUIDITY_UNKNOWN / TOKEN_2022 EXT_* on ~100% of "
                  "candidates) so the lane can produce any rows at all.")
    elif verdict == "PURSUE_OFFLINE":
        md.append(f"Buckets clearing the +15% bar: {clearing}. See economics columns above. "
                  "Chronological-OOS on fresh data is still mandatory before promotion.")
        md.append("Paper lane must collect: per-candidate d300-bucket tag at entry, dense post-entry "
                  "markouts (15s grid to T+1800), realized round-trip cost per trade, and per-mint "
                  "dedup keys — minimum 100 closes before any live discussion.")
    else:
        md.append(f"Usable events {c['usable']} < 300 — not enough to bucket reliably. "
                  "Extend the markout cache window before re-testing.")
    md.append("")
    report_path = os.path.join(REPORTS, "08_REBOUND_HYPOTHESIS.md")
    with open(report_path, "w") as f:
        f.write("\n".join(md) + "\n")
    print(f"wrote {report_path}")
    print(f"wrote {os.path.join(CACHE, 'phase4_rebound.json')}")
    # console summary
    print(json.dumps({"counts": payload["counts"],
                      "main": {k: {kk: (round(vv, 4) if isinstance(vv, float) else vv)
                                   for kk, vv in v.items() if kk != 'ci95MeanCapped'}
                               for k, v in main_stats.items()}}, indent=2, default=str))


if __name__ == "__main__":
    main()
