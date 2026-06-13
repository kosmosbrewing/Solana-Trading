#!/usr/bin/env python3
"""레버 1 가동 후 candle coverage 측정 (D+7 측정을 소진 시점에 당겨서 실행).

baseline (edge-audit 05): full coverage 1.81% (pre60 + T+300).
이번: 신선 buy anchor (6/11-13) 기준으로 재측정 + venue(dexId) 별 분해.

전부 로컬 데이터 — API 0. 비교 가능성: pumpfun bonding 은 lever 1 이 추출은 하되
구독을 gate 하므로 candle 0 (설계). 따라서 full coverage 상한 = non-bonding 비중.
"""
import json
import os
import glob
from datetime import datetime

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SESS = os.path.join(REPO, "data", "realtime", "sessions")
ANCHORS = os.path.join(REPO, "data", "realtime", "trade-markout-anchors.jsonl")
KOLTX = os.path.join(REPO, "data", "realtime", "kol-tx.jsonl")


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


# 1) 신선 buy anchors
anchors = []
with open(ANCHORS, encoding="utf-8", errors="replace") as fh:
    for line in fh:
        if '"anchorType":"buy"' not in line:
            continue
        if "2026-06-11" not in line and "2026-06-12" not in line and "2026-06-13" not in line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        rec = r.get("recordedAt", "")
        if not (rec.startswith("2026-06-11") or rec.startswith("2026-06-12") or rec.startswith("2026-06-13")):
            continue
        anchors.append((r["tokenMint"], parse_ts(rec), r.get("signalSource", "")))
print(f"fresh buy anchors: {len(anchors)}")

# 2) 신선 세션 candle 타임스탬프 (tokenMint -> sorted ts list)
fresh_dirs = sorted(d for d in glob.glob(os.path.join(SESS, "2026-06-1*"))
                    if os.path.basename(d) >= "2026-06-11")
cand = {}
for d in fresh_dirs:
    path = os.path.join(d, "micro-candles.jsonl")
    if not os.path.exists(path):
        continue
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if '"intervalSec":10,' not in line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            mint = r.get("tokenMint") or r.get("pairAddress")
            ts = r.get("timestamp")
            if not mint or not ts:
                continue
            cand.setdefault(mint, []).append(parse_ts(ts))
for mint in cand:
    cand[mint].sort()
print(f"sessions: {len(fresh_dirs)} dirs, tokens with candles: {len(cand)}")

# 3) kol-tx dexId join (token -> dexId, 가장 흔한 값)
dexid = {}
with open(KOLTX, encoding="utf-8", errors="replace") as fh:
    for line in fh:
        if "2026-06-1" not in line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("timestamp", 0) < 1781136000000:
            continue
        m, dx = r.get("tokenMint"), r.get("dexId")
        if m and dx and m not in dexid:
            dexid[m] = dx


def has_in(ts_list, lo, hi):
    # 정렬된 ts_list 에 [lo, hi] 구간 원소 존재?
    import bisect
    i = bisect.bisect_left(ts_list, lo)
    return i < len(ts_list) and ts_list[i] <= hi


# 4) coverage 판정
def bucket(mint):
    dx = dexid.get(mint)
    if dx == "pumpfun":
        return "pumpfun_bonding (gated)"
    if dx:
        return dx
    return "unknown_dex"


stats = {"total": 0, "direct": 0, "pre60": 0, "post300": 0, "full": 0}
by_bucket = {}
for mint, t, src in anchors:
    stats["total"] += 1
    b = by_bucket.setdefault(bucket(mint), {"total": 0, "direct": 0, "full": 0})
    b["total"] += 1
    ts_list = cand.get(mint)
    if not ts_list:
        continue
    stats["direct"] += 1
    b["direct"] += 1
    pre = has_in(ts_list, t - 60, t)
    post = has_in(ts_list, t, t + 300)
    if pre:
        stats["pre60"] += 1
    if post:
        stats["post300"] += 1
    if pre and post:
        stats["full"] += 1
        b["full"] += 1


def pct(a, b):
    return f"{a/b*100:.1f}%" if b else "n/a"


print("\n=== Coverage (fresh buy anchors, 6/11-13) ===")
n = stats["total"]
print(f"  N = {n}")
print(f"  direct (any candle):  {stats['direct']:>4} ({pct(stats['direct'], n)})")
print(f"  pre60 window:         {stats['pre60']:>4} ({pct(stats['pre60'], n)})")
print(f"  post300 window:       {stats['post300']:>4} ({pct(stats['post300'], n)})")
print(f"  FULL (pre60+post300): {stats['full']:>4} ({pct(stats['full'], n)})  [baseline 1.81%]")
print("\n=== By venue ===")
for b, s in sorted(by_bucket.items(), key=lambda x: -x[1]["total"]):
    print(f"  {b:<26} N={s['total']:>4}  direct={pct(s['direct'], s['total']):>6}  full={pct(s['full'], s['total']):>6}")
