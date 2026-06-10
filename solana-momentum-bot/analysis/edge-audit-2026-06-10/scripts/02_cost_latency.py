#!/usr/bin/env python3
"""Phase 2 — cost, latency, wallet drag from live execution ledgers."""
import json
import os
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone

ROOT = "/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot"
CACHE = os.path.join(ROOT, "analysis/edge-audit-2026-06-10/cache")


def stream(path):
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    return s[min(len(s) - 1, int(q * (len(s) - 1)))]


def main():
    # --- buy latency (KOL live era) ---
    lags = []
    exec_ms = []
    drift = []
    kol_buys = {}
    for r in stream(f"{ROOT}/data/realtime/executed-buys.jsonl"):
        pid = str(r.get("positionId") or "")
        if not pid.startswith("kolh-"):
            continue
        kol_buys[pid] = r
        st = r.get("signalTimeSec")
        rec = r.get("recordedAt")
        if isinstance(st, (int, float)) and rec:
            try:
                rec_ts = datetime.fromisoformat(rec.replace("Z", "+00:00")).timestamp()
                lag = rec_ts - st
                if 0 <= lag < 3600:
                    lags.append(lag)
            except ValueError:
                pass
        bm = r.get("buyExecutionMs")
        if isinstance(bm, (int, float)) and bm > 0:
            exec_ms.append(bm / 1000.0)
        pe = r.get("plannedEntryPrice") or r.get("signalPrice")
        ae = r.get("actualEntryPrice")
        if isinstance(pe, (int, float)) and isinstance(ae, (int, float)) and pe > 0:
            d = (ae - pe) / pe
            if abs(d) < 5:
                drift.append(d)

    # --- live close cost decomposition (kol-live-trades) ---
    tok_minus_wallet = []   # per-trade drag SOL (tokenOnly - wallet)
    net_tok = 0.0
    net_wal = 0.0
    n_both = 0
    tickets = []
    holds = []
    for r in stream(f"{ROOT}/data/realtime/kol-live-trades.jsonl"):
        ns = r.get("netSol")
        nt = r.get("netSolTokenOnly")
        if isinstance(r.get("ticketSol"), (int, float)):
            tickets.append(r["ticketSol"])
        if isinstance(r.get("holdSec"), (int, float)):
            holds.append(r["holdSec"])
        if isinstance(ns, (int, float)) and isinstance(nt, (int, float)):
            n_both += 1
            net_tok += nt
            net_wal += ns
            tok_minus_wallet.append(nt - ns)

    # --- sell-side: receivedSol vs expected (failed/partial fills) ---
    sell_reasons = Counter()
    zero_received = 0
    n_sells = 0
    for r in stream(f"{ROOT}/data/realtime/executed-sells.jsonl"):
        pid = str(r.get("positionId") or "")
        if not pid.startswith("kolh-"):
            continue
        n_sells += 1
        sell_reasons[r.get("exitReason")] += 1
        rs = r.get("receivedSol")
        if isinstance(rs, (int, float)) and rs <= 0:
            zero_received += 1

    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "buyLatency": {
            "n": len(lags),
            "p50": pct(lags, 0.5),
            "p90": pct(lags, 0.9),
            "p99": pct(lags, 0.99),
            "mean": statistics.fmean(lags) if lags else None,
        },
        "buyExecutionSec": {
            "n": len(exec_ms),
            "p50": pct(exec_ms, 0.5),
            "p90": pct(exec_ms, 0.9),
        },
        "entryDriftFraction": {
            "n": len(drift),
            "p50": pct(drift, 0.5),
            "p90": pct(drift, 0.9),
            "mean": statistics.fmean(drift) if drift else None,
        },
        "liveCostDecomp": {
            "nBoth": n_both,
            "netTokenOnlySol": round(net_tok, 6),
            "netWalletSol": round(net_wal, 6),
            "totalDragSol": round(net_tok - net_wal, 6),
            "dragPerTradeSol_p50": pct(tok_minus_wallet, 0.5),
            "dragPerTradeSol_p90": pct(tok_minus_wallet, 0.9),
            "dragPerTradeSol_mean": statistics.fmean(tok_minus_wallet) if tok_minus_wallet else None,
            "ticketSol_p50": pct(tickets, 0.5),
            "holdSec_p50": pct(holds, 0.5),
            "holdSec_p90": pct(holds, 0.9),
        },
        "sells": {
            "nKolSells": n_sells,
            "zeroOrNegativeReceived": zero_received,
            "topExitReasons": sell_reasons.most_common(12),
        },
    }
    path = os.path.join(CACHE, "phase2_cost_latency.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
