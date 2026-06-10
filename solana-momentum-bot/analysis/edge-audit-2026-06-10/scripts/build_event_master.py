#!/usr/bin/env python3
"""Build event_master cache: buy anchors x forward markouts x ledger closes.

Join method: positionId + anchor epoch-ms (promotion-grade, method 3).
Synthetic test mints (PAIR*, non-base58-length) are excluded.
Output: analysis/edge-audit-2026-06-10/cache/event_master.jsonl
"""
import json
import os
import re
import sys
from collections import defaultdict

ROOT = "/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot"
CACHE = os.path.join(ROOT, "analysis/edge-audit-2026-06-10/cache")
HORIZONS = (15, 30, 60, 300, 1800)

MINT_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")


def stream(path):
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def role_of(row, kind):
    pr = row.get("paperRole")
    if isinstance(pr, str) and pr:
        return pr
    if kind == "live":
        return "live"
    if row.get("isShadowArm") or row.get("isShadowKol"):
        return "shadow"
    return "unknown_role"


def main():
    os.makedirs(CACHE, exist_ok=True)

    # 1) ledger close maps (paper union, aggregate file wins; live aggregate)
    closes = {}
    for path, kind in [
        (f"{ROOT}/data/realtime/rotation-v1-paper-trades.jsonl", "paper"),
        (f"{ROOT}/data/realtime/smart-v3-paper-trades.jsonl", "paper"),
        (f"{ROOT}/data/realtime/pure-ws-paper-trades.jsonl", "paper"),
        (f"{ROOT}/data/realtime/kol-paper-trades.jsonl", "paper"),
        (f"{ROOT}/data/realtime/kol-live-trades.jsonl", "live"),
    ]:
        for r in stream(path):
            pid = r.get("positionId")
            if not pid:
                continue
            closes[pid] = {
                "role": role_of(r, kind),
                "netSol": r.get("netSol"),
                "netSolTokenOnly": r.get("netSolTokenOnly"),
                "netPct": r.get("netPct"),
                "mfePctPeak": r.get("mfePctPeak"),
                "maePct": r.get("maePct"),
                "exitReason": r.get("exitReason"),
                "ticketSol": r.get("ticketSol"),
                "holdSec": r.get("holdSec"),
                "closedAt": r.get("closedAt"),
                "armNameClose": r.get("armName"),
                "strategyClose": r.get("strategy"),
                "isLive": kind == "live",
                "parentPositionId": r.get("parentPositionId"),
                "independentKolCountClose": r.get("independentKolCount"),
            }

    # 2) markouts keyed by (anchorType, positionId, anchorAt)
    fwd = defaultdict(dict)
    for r in stream(f"{ROOT}/data/realtime/trade-markouts.jsonl"):
        if r.get("quoteStatus") != "ok":
            continue
        d = r.get("deltaPct")
        if not isinstance(d, (int, float)):
            continue
        key = (r.get("anchorType"), r.get("positionId"), r.get("anchorAt"))
        fwd[key][int(r.get("horizonSec") or 0)] = d

    # 3) anchors -> event_master rows
    out_path = os.path.join(CACHE, "event_master.jsonl")
    n_out = 0
    n_buy = 0
    n_sell = 0
    n_synth = 0
    with open(out_path, "w", encoding="utf-8") as out:
        for r in stream(f"{ROOT}/data/realtime/trade-markout-anchors.jsonl"):
            mint = str(r.get("tokenMint") or "")
            if not MINT_RE.match(mint):
                n_synth += 1
                continue
            at = r.get("anchorType")
            ex = r.get("extras") or {}
            key = (at, r.get("positionId"), r.get("anchorAt"))
            f = fwd.get(key, {})
            pid = r.get("positionId")
            cl = closes.get(pid, {})
            row = {
                "anchorType": at,
                "positionId": pid,
                "tokenMint": mint,
                "anchorAt": r.get("anchorAt"),
                "anchorPriceKind": r.get("anchorPriceKind"),
                "signalSource": r.get("signalSource"),
                "mode": ex.get("mode") or ex.get("executionMode"),
                "armName": ex.get("armName"),
                "strategy": ex.get("strategy"),
                "isShadowArm": bool(ex.get("isShadowArm")),
                "independentKolCount": ex.get("independentKolCount"),
                "kolScore": ex.get("kolScore"),
                "discoverySource": ex.get("discoverySource"),
                "fwd": {str(h): f.get(h) for h in HORIZONS if f.get(h) is not None},
                "role": cl.get("role"),
                "netSol": cl.get("netSol"),
                "netSolTokenOnly": cl.get("netSolTokenOnly"),
                "netPct": cl.get("netPct"),
                "mfePctPeak": cl.get("mfePctPeak"),
                "maePct": cl.get("maePct"),
                "exitReason": cl.get("exitReason"),
                "ticketSol": cl.get("ticketSol"),
                "holdSec": cl.get("holdSec"),
                "closedAt": cl.get("closedAt"),
                "isLive": cl.get("isLive", ex.get("mode") == "live"),
                "parentPositionId": cl.get("parentPositionId"),
            }
            if at == "buy":
                n_buy += 1
            else:
                n_sell += 1
            out.write(json.dumps(row) + "\n")
            n_out += 1

    print(f"event_master rows={n_out} buy={n_buy} sell={n_sell} synthetic_excluded={n_synth}")
    print(f"closes map size={len(closes)}")
    print(f"written: {out_path}")


if __name__ == "__main__":
    main()
