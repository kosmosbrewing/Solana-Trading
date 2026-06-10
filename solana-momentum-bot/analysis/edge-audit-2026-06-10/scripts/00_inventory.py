#!/usr/bin/env python3
"""Phase 0 — ledger inventory + role audit + field coverage.

Streams core JSONL ledgers, classifies evidence roles per
mission-reassessment-protocol-2026-05-22 §4.2, and writes a JSON cache
used by later audit phases. Read-only over data/; writes only to
analysis/edge-audit-2026-06-10/cache/.
"""
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

ROOT = "/Users/igyubin/Desktop/projects/01_shakishaki/Solana/solana-momentum-bot"
CACHE = os.path.join(ROOT, "analysis/edge-audit-2026-06-10/cache")

CORE_LEDGERS = [
    ("kol_live", "data/realtime/kol-live-trades.jsonl", "live_file"),
    ("rotation_live", "data/realtime/rotation-v1-live-trades.jsonl", "live_file"),
    ("smart_v3_live", "data/realtime/smart-v3-live-trades.jsonl", "live_file"),
    ("kol_paper", "data/realtime/kol-paper-trades.jsonl", "paper_file"),
    ("rotation_paper", "data/realtime/rotation-v1-paper-trades.jsonl", "paper_file"),
    ("smart_v3_paper", "data/realtime/smart-v3-paper-trades.jsonl", "paper_file"),
    ("pure_ws_paper", "data/realtime/pure-ws-paper-trades.jsonl", "paper_file"),
]

KEY_FIELDS = [
    "paperRole", "armName", "positionId", "parentPositionId", "closedAt",
    "netSol", "netPct", "mfePctPeak", "maePct", "holdSec", "ticketSol",
    "entryTxSignature", "exitTxSignature", "independentKolCount", "kolScore",
    "exitReason", "tokenMint", "isLive", "isShadowArm", "isShadowKol",
    "netSolTokenOnly", "tokenOnlyNetSol", "walletDeltaSol", "actualWalletNetSol",
    "decisionId", "candidateId", "executionPlanHash", "routeProof",
    "entryPrice", "exitPrice", "strategy", "lane", "detectorVersion",
]


def classify_role(row, file_kind):
    """Role per protocol §4.2. Missing role is unknown_role, not neutral."""
    pr = row.get("paperRole")
    if isinstance(pr, str) and pr:
        return pr
    if file_kind == "live_file":
        return "live"
    pid = str(row.get("positionId") or "")
    if row.get("isShadowArm") or row.get("isShadowKol"):
        return "shadow"
    if pid.startswith("kolh-live-") or pid.startswith("rot-live-") or pid.startswith("sv3-live-"):
        return "paper_mirror_inferred"
    return "unknown_role"


def parse_ts(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        # epoch ms vs s
        sec = v / 1000.0 if v > 1e11 else float(v)
        try:
            return datetime.fromtimestamp(sec, tz=timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    if isinstance(v, str):
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def main():
    os.makedirs(CACHE, exist_ok=True)
    inventory = {}
    for name, rel, kind in CORE_LEDGERS:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            inventory[name] = {"path": rel, "missing": True}
            continue
        st = os.stat(path)
        rows = 0
        bad = 0
        first_ts = None
        last_ts = None
        roles = Counter()
        role_net = defaultdict(float)
        role_net_n = Counter()
        field_present = Counter()
        exit_reasons = Counter()
        arms = Counter()
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    bad += 1
                    continue
                rows += 1
                ts = parse_ts(row.get("closedAt"))
                if ts is not None:
                    if first_ts is None or ts < first_ts:
                        first_ts = ts
                    if last_ts is None or ts > last_ts:
                        last_ts = ts
                role = classify_role(row, kind)
                roles[role] += 1
                ns = row.get("netSol")
                if isinstance(ns, (int, float)):
                    role_net[role] += ns
                    role_net_n[role] += 1
                for k in KEY_FIELDS:
                    if row.get(k) is not None:
                        field_present[k] += 1
                er = row.get("exitReason")
                if isinstance(er, str):
                    exit_reasons[er] += 1
                arm = row.get("armName")
                if isinstance(arm, str):
                    arms[arm] += 1
        inventory[name] = {
            "path": rel,
            "kind": kind,
            "rows": rows,
            "badLines": bad,
            "bytes": st.st_size,
            "mtimeUtc": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            "firstClosedAt": first_ts.isoformat() if first_ts else None,
            "lastClosedAt": last_ts.isoformat() if last_ts else None,
            "roles": dict(roles),
            "netSolByRole": {k: round(v, 6) for k, v in role_net.items()},
            "netRowsByRole": dict(role_net_n),
            "fieldCoveragePct": {
                k: round(100.0 * field_present[k] / rows, 1) if rows else 0.0
                for k in KEY_FIELDS
            },
            "topExitReasons": exit_reasons.most_common(15),
            "topArms": arms.most_common(20),
        }
        print(f"[inventory] {name}: rows={rows} roles={dict(roles)}", file=sys.stderr)

    out = os.path.join(CACHE, "inventory.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(inventory, f, indent=1, default=str)
    print(f"written: {out}")


if __name__ == "__main__":
    main()
