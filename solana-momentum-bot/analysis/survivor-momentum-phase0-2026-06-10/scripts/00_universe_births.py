#!/usr/bin/env python3
"""Phase 0 pass 1 — pair 별 global first-seen (출생 proxy) 인덱스.

survivor universe 의 'token age >= 30min' 판정 기준점. 세션을 넘나드는 pair 가
있으므로 전 세션을 한 번 훑어 pair 별 최초 관측 시각을 고정한다.

한계 (리포트에 명시): first-seen 은 '풀 생성 시각' 이 아니라 '우리 구독이 시작된 시각'.
scanner/coverage 가 충분히 이른 pair 에서만 출생 proxy 로 유효하다.

Usage:
  python3 00_universe_births.py [--sample N] [--force]
"""
import argparse
import json
import os
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SESSIONS_DIR = os.path.join(REPO, "data", "realtime", "sessions")
CACHE = os.path.join(os.path.dirname(__file__), "..", "cache")


def session_dirs(sample=None):
    names = sorted(
        d for d in os.listdir(SESSIONS_DIR)
        if not d.startswith("legacy") and os.path.isdir(os.path.join(SESSIONS_DIR, d))
    )
    return names[:sample] if sample else names


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int, default=None)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    os.makedirs(CACHE, exist_ok=True)
    out_path = os.path.join(CACHE, "pair_births.json")
    if os.path.exists(out_path) and not args.force and not args.sample:
        print(f"cache exists: {out_path} (--force to rebuild)")
        return

    births = {}   # pairAddress -> [first_seen_iso, last_seen_iso, total_rows]
    started = time.time()
    dirs = session_dirs(args.sample)
    for i, name in enumerate(dirs):
        path = os.path.join(SESSIONS_DIR, name, "micro-candles.jsonl")
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                # 빠른 사전 필터: 10s interval 행만 (5s 행과 이중 계상 방지)
                if '"intervalSec":10,' not in line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                pair = row.get("pairAddress")
                ts = row.get("timestamp")
                if not pair or not ts:
                    continue
                entry = births.get(pair)
                if entry is None:
                    births[pair] = [ts, ts, 1]
                else:
                    if ts < entry[0]:
                        entry[0] = ts
                    if ts > entry[1]:
                        entry[1] = ts
                    entry[2] += 1
        if (i + 1) % 50 == 0:
            print(f"  {i+1}/{len(dirs)} sessions, pairs={len(births)}, "
                  f"{time.time()-started:.0f}s", file=sys.stderr)

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "sessions": len(dirs),
            "sample": args.sample,
            "pairs": births,
        }, fh)
    print(f"pairs={len(births)} sessions={len(dirs)} -> {out_path} "
          f"({time.time()-started:.0f}s)")


if __name__ == "__main__":
    main()
