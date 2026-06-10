#!/usr/bin/env python3
"""Phase 1 — Raw signal event study.

Forward gross returns (Jupiter-quoted deltaPct, pre-cost) at T+15/30/60/300/1800
for buy anchors, segmented by ex-ante axes. Token-event dedup avoids multi-arm
double counting. Bootstrap CI (1000 resamples) on cited segments.
"""
import json
import math
import os
import random
import statistics
from collections import defaultdict
from datetime import datetime, timezone

ROOT = "/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot"
CACHE = os.path.join(ROOT, "analysis/edge-audit-2026-06-10/cache")
HORIZONS = ("15", "30", "60", "300", "1800")

random.seed(20260610)


def family(row):
    s = (row.get("strategy") or row.get("signalSource") or row.get("armName") or "").lower()
    a = (row.get("armName") or "").lower()
    if "rotation" in s or "rotation" in a:
        return "rotation"
    if "smart_v3" in s or "smart_v3" in a or "smartv3" in a:
        return "smart_v3"
    if "pure_ws" in s or "purews" in s:
        return "pure_ws"
    if "kol" in s:
        return "kol_other"
    return "other"


def kol_bucket(v):
    if not isinstance(v, (int, float)):
        return "unknown"
    if v <= 1:
        return "1"
    if v == 2:
        return "2"
    return "3+"


def score_bucket(v):
    if not isinstance(v, (int, float)):
        return "unknown"
    if v < 2:
        return "score<2"
    if v < 5:
        return "score2-5"
    return "score5+"


def utc4(ts):
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return f"{(dt.hour // 4) * 4:02d}-{(dt.hour // 4) * 4 + 4:02d}"
    except Exception:
        return "unknown"


def day_of(ts):
    return (ts or "")[:10]


CAP = 10.0  # +1000%; quotes above this are near-certain decimal bugs on these horizons


def seg_stats(vals):
    """deltaPct is a FRACTION (-0.5 == -50%). Report pct units, capped mean."""
    if not vals:
        return None
    n = len(vals)
    capped = [min(v, CAP) for v in vals]
    return {
        "n": n,
        "medianPct": statistics.median(vals) * 100,
        "meanCappedPct": statistics.fmean(capped) * 100,
        "posRate": sum(1 for v in vals if v > 0) / n,
        "le_m20pct": sum(1 for v in vals if v <= -0.20) / n,
        "ge_p50pct": sum(1 for v in vals if v >= 0.50) / n,
        "ge_5x": sum(1 for v in vals if v >= 4.0) / n,
        "suspectGt10x": sum(1 for v in vals if v > CAP),
    }


def bootstrap_ci(vals, stat="mean", n_boot=1000):
    if len(vals) < 5:
        return (None, None)
    capped = [min(v, CAP) for v in vals]
    res = []
    for _ in range(n_boot):
        sample = random.choices(capped, k=len(capped))
        res.append(statistics.fmean(sample) if stat == "mean" else statistics.median(sample))
    res.sort()
    return (res[int(0.025 * n_boot)] * 100, res[int(0.975 * n_boot)] * 100)


def main():
    rows = []
    with open(os.path.join(CACHE, "event_master.jsonl")) as f:
        for line in f:
            r = json.loads(line)
            if r.get("anchorType") != "buy":
                continue
            rows.append(r)

    # token-event dedup: same mint within 600s collapses to first anchor
    rows.sort(key=lambda r: r.get("anchorAt") or "")
    last_seen = {}
    for r in rows:
        mint = r["tokenMint"]
        try:
            ts = datetime.fromisoformat(r["anchorAt"].replace("Z", "+00:00")).timestamp()
        except Exception:
            ts = 0
        prev = last_seen.get(mint)
        r["_dedup_primary"] = prev is None or (ts - prev) > 600
        if r["_dedup_primary"]:
            last_seen[mint] = ts

    out = {"generatedAt": datetime.now(timezone.utc).isoformat(), "segments": {}}

    def run_table(name, key_fn, universe):
        table = defaultdict(lambda: defaultdict(list))
        days = defaultdict(set)
        for r in universe:
            seg = key_fn(r)
            days[seg].add(day_of(r.get("anchorAt")))
            for h in HORIZONS:
                v = r["fwd"].get(h)
                if isinstance(v, (int, float)):
                    table[seg][h].append(v)
        res = {}
        for seg, hs in sorted(table.items()):
            res[seg] = {"activeDays": len(days[seg])}
            for h in HORIZONS:
                st = seg_stats(hs.get(h, []))
                if st:
                    res[seg][f"T{h}"] = {k: round(v, 4) for k, v in st.items()}
        out["segments"][name] = res
        return table

    dedup = [r for r in rows if r["_dedup_primary"]]
    all_rows = rows

    out["counts"] = {
        "buyAnchorsAll": len(all_rows),
        "buyAnchorsTokenEventDedup": len(dedup),
    }

    run_table("ALL_anchors", lambda r: "all", all_rows)
    run_table("ALL_token_events", lambda r: "all", dedup)
    run_table("family", family, dedup)
    run_table("independentKolCount", lambda r: kol_bucket(r.get("independentKolCount")), dedup)
    run_table("kolScore", lambda r: score_bucket(r.get("kolScore")), dedup)
    run_table("utc4h", lambda r: utc4(r.get("anchorAt") or ""), dedup)
    run_table("role", lambda r: r.get("role") or "no_close_row", all_rows)
    run_table("mode", lambda r: r.get("mode") or "unknown", all_rows)
    run_table(
        "family_x_kol",
        lambda r: f"{family(r)}|kol{kol_bucket(r.get('independentKolCount'))}",
        dedup,
    )

    # bootstrap CI for headline segments (T+300 / T+1800 mean), token-event dedup
    cited = {}
    for seg_name, pred in [
        ("all", lambda r: True),
        ("family=rotation", lambda r: family(r) == "rotation"),
        ("family=smart_v3", lambda r: family(r) == "smart_v3"),
        ("kol=2", lambda r: kol_bucket(r.get("independentKolCount")) == "2"),
        ("kol=3+", lambda r: kol_bucket(r.get("independentKolCount")) == "3+"),
        ("smart_v3&kol>=2", lambda r: family(r) == "smart_v3"
         and kol_bucket(r.get("independentKolCount")) in ("2", "3+")),
    ]:
        sub = [r for r in dedup if pred(r)]
        entry = {}
        for h in ("60", "300", "1800"):
            vals = [r["fwd"][h] for r in sub if isinstance(r["fwd"].get(h), (int, float))]
            if len(vals) >= 5:
                lo, hi = bootstrap_ci(vals)
                capped = [min(v, CAP) for v in vals]
                entry[f"T{h}"] = {
                    "n": len(vals),
                    "meanCappedPct": round(statistics.fmean(capped) * 100, 2),
                    "medianPct": round(statistics.median(vals) * 100, 2),
                    "ci95_meanCappedPct": [round(lo, 2), round(hi, 2)],
                    "activeDays": len({day_of(r.get("anchorAt")) for r in sub
                                       if isinstance(r["fwd"].get(h), (int, float))}),
                }
        cited[seg_name] = entry
    out["bootstrapCited"] = cited

    # reject side (missed-alpha) T+60 diagnostic
    rej = defaultdict(list)
    rej_days = defaultdict(set)
    with open(f"{ROOT}/data/realtime/missed-alpha.jsonl") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            p = r.get("probe") or {}
            if p.get("quoteStatus") != "ok":
                continue
            d = p.get("deltaPct")
            if not isinstance(d, (int, float)):
                continue
            off = p.get("offsetSec")
            if off not in (60, 300, 1800):
                continue
            cat = r.get("rejectCategory") or "unknown"
            rej[(cat, off)].append(d)
            rej_days[(cat, off)].add((r.get("rejectedAt") or "")[:10])
    out["rejectSideDiagnostic"] = {
        f"{cat}|T{off}": {**{k: round(v, 4) for k, v in seg_stats(vals).items()},
                          "activeDays": len(rej_days[(cat, off)])}
        for (cat, off), vals in sorted(rej.items())
        if len(vals) >= 30
    }

    path = os.path.join(CACHE, "phase1_signal_study.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=1)
    print(f"written: {path}")
    # console summary
    print("\n== ALL token events ==")
    print(json.dumps(out["segments"]["ALL_token_events"], indent=1))
    print("\n== bootstrap cited ==")
    print(json.dumps(cited, indent=1))


if __name__ == "__main__":
    main()
