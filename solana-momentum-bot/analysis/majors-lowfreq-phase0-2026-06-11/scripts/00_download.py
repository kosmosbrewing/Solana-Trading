#!/usr/bin/env python3
"""H-009 Phase 0 — Binance 공개 klines 4h 전 이력 다운로드 (무료, key 불요).

산출: cache/{SYMBOL}_4h.jsonl — [openTime, open, high, low, close, volume]
재실행 시 기존 캐시 있으면 skip (--force 로 갱신).
"""
import json
import os
import sys
import time
import urllib.request

CACHE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "cache"))
SYMBOLS = ["SOLUSDT", "BTCUSDT", "ETHUSDT"]
BASE = "https://api.binance.com/api/v3/klines"
START_MS = 1500000000000  # 2017-07 — 심볼 상장 전이면 첫 응답이 상장 시점부터 옴


def fetch(symbol, start_ms):
    url = f"{BASE}?symbol={symbol}&interval=4h&limit=1000&startTime={start_ms}"
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.loads(response.read())


def main():
    force = "--force" in sys.argv
    os.makedirs(CACHE, exist_ok=True)
    for symbol in SYMBOLS:
        out_path = os.path.join(CACHE, f"{symbol}_4h.jsonl")
        if os.path.exists(out_path) and not force:
            print(f"skip (cached): {out_path}")
            continue
        rows = []
        cursor = START_MS
        while True:
            batch = fetch(symbol, cursor)
            if not batch:
                break
            for k in batch:
                rows.append([k[0], float(k[1]), float(k[2]), float(k[3]),
                             float(k[4]), float(k[5])])
            if len(batch) < 1000:
                break
            cursor = batch[-1][0] + 1
            time.sleep(0.25)  # public rate limit 예의
        with open(out_path, "w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row) + "\n")
        first = time.strftime("%Y-%m-%d", time.gmtime(rows[0][0] / 1000))
        last = time.strftime("%Y-%m-%d", time.gmtime(rows[-1][0] / 1000))
        print(f"{symbol}: {len(rows)} bars ({first}..{last}) -> {out_path}")


if __name__ == "__main__":
    main()
