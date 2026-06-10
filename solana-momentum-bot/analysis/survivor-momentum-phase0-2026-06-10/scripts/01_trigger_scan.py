#!/usr/bin/env python3
"""Phase 0 pass 2 — survivor universe 위에서 trigger 3종 이벤트 스캔 + forward 측정.

설계: docs/design-docs/survivor-momentum-lane-design-2026-06-10.md §2-3, §6 Phase 0.
전부 ex-ante: bar i 에서의 판정은 bar <= i 데이터만 사용. forward 는 평가 전용.

Universe (이벤트 자격, 전부 이벤트 시점 이전 정보):
  - age: ts - global_first_seen >= 30min (pair_births.json)
  - 생존: 누적 running peak 대비 close < 5% 로 떨어진 적 없음 (rug/사망 추정 시 이후 제외)
  - 활동: 누적 bars >= 30, 누적 trades >= 50, 최근 5min trades >= 5
  - 밀도: trigger window 의 bar 들이 wall-clock 으로 촘촘해야 함 (sparse pair 오탐 방지)

Triggers (10s candles):
  T1 burst    — 최근 3 bars: vol >= 4x baseline(직전 30 bars 평균), price chg >= +3%,
                trades >= 3x baseline
  T2 persist  — 최근 6 bars: vol_accel >= 1.2 / buy_ratio >= 0.55 / price chg >= 0 /
                trade_accel >= 1.0 — 3회 연속 평가 (30s) 유지 시 발화 (cupsey gate 유산)
  T3 breakout — 변동성 수축: 최근 18 bars 평균 range <= 직전 36 bars 평균 range 의 50%
                + close > 직전 30 bars 최고 close + bar vol >= 2x baseline

Forward: +5m/15m/30m/60m/120m. forward bar 가 horizon-5min 보다 이전이면 stale 표시.
Dedup: pair x trigger 별 30min cooldown.

Usage:
  python3 01_trigger_scan.py [--sample N] [--out events.jsonl]
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SESSIONS_DIR = os.path.join(REPO, "data", "realtime", "sessions")
CACHE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "cache"))

AGE_MIN_SEC = 30 * 60
RUG_FLOOR = 0.05           # running peak 대비 5% 미만 = 사망 추정
MIN_BARS = 30
MIN_TRADES = 50
RECENT_5MIN_TRADES = 5
COOLDOWN_SEC = 30 * 60
HORIZONS = [300, 900, 1800, 3600, 7200]
STALE_SEC = 300


def parse_ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def session_dirs(sample=None):
    names = sorted(
        d for d in os.listdir(SESSIONS_DIR)
        if not d.startswith("legacy") and os.path.isdir(os.path.join(SESSIONS_DIR, d))
    )
    return names[:sample] if sample else names


def load_births():
    with open(os.path.join(CACHE, "pair_births.json"), "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return {pair: parse_ts(entry[0]) for pair, entry in data["pairs"].items()}


def mean(values):
    return sum(values) / len(values) if values else 0.0


class PairScanner:
    """단일 (session, pair) 시계열의 chronological 스캔 상태."""

    def __init__(self, pair, birth_ts):
        self.pair = pair
        self.birth_ts = birth_ts
        self.bars = []           # (ts, open, high, low, close, vol, buyVol, trades)
        self.running_peak = 0.0
        self.dead = False
        self.cum_trades = 0
        self.persist_streak = 0
        self.last_fire = {}      # trigger -> ts

    def add(self, bar):
        self.bars.append(bar)
        close = bar[4]
        if close > self.running_peak:
            self.running_peak = close
        elif self.running_peak > 0 and close < self.running_peak * RUG_FLOOR:
            self.dead = True
        self.cum_trades += bar[7]

    def eligible(self, ts):
        if self.dead or len(self.bars) < MIN_BARS + 6 or self.cum_trades < MIN_TRADES:
            return False
        if ts - self.birth_ts < AGE_MIN_SEC:
            return False
        recent = [b for b in self.bars[-31:] if ts - b[0] <= 300]
        return sum(b[7] for b in recent) >= RECENT_5MIN_TRADES

    def windows(self):
        """(recent k bars, baseline 30 bars) — 밀도 검사 포함. 부족하면 None."""
        bars = self.bars
        i = len(bars) - 1
        ts = bars[i][0]
        recent6 = bars[-6:]
        baseline = bars[-36:-6]
        if len(baseline) < 30:
            return None
        # 밀도: recent6 가 2min 내, baseline 이 15min 내 (sparse pair 의 가짜 accel 방지)
        if ts - recent6[0][0] > 120 or ts - baseline[0][0] > 900:
            return None
        return recent6, baseline

    def check_triggers(self):
        out = []
        win = self.windows()
        if win is None:
            self.persist_streak = 0
            return out
        recent6, baseline = win
        bar = self.bars[-1]
        ts, close = bar[0], bar[4]
        base_vol = mean([b[5] for b in baseline])
        base_trades = mean([b[7] for b in baseline])
        base_range = mean([(b[2] - b[3]) / b[4] for b in baseline if b[4] > 0])

        # T1 burst: 최근 3 bars
        recent3 = recent6[-3:]
        vol3 = mean([b[5] for b in recent3])
        trades3 = mean([b[7] for b in recent3])
        chg3 = close / recent3[0][1] - 1 if recent3[0][1] > 0 else 0
        if base_vol > 0 and vol3 >= 4 * base_vol and chg3 >= 0.03 and trades3 >= 3 * base_trades:
            out.append(("t1_burst", chg3))

        # T2 persistence: 6-bar 조건 3회 연속
        vol6 = mean([b[5] for b in recent6])
        buy6 = sum(b[6] for b in recent6)
        tot6 = sum(b[5] for b in recent6)
        trades6 = mean([b[7] for b in recent6])
        chg6 = close / recent6[0][1] - 1 if recent6[0][1] > 0 else 0
        cond = (
            base_vol > 0
            and vol6 / base_vol >= 1.2
            and (buy6 / tot6 if tot6 > 0 else 0) >= 0.55
            and chg6 >= 0
            and (trades6 / base_trades if base_trades > 0 else 0) >= 1.0
        )
        self.persist_streak = self.persist_streak + 1 if cond else 0
        if self.persist_streak == 3:
            out.append(("t2_persist", chg6))

        # T3 consolidation breakout
        range18 = mean([(b[2] - b[3]) / b[4] for b in self.bars[-19:-1] if b[4] > 0])
        prior_high = max(b[4] for b in self.bars[-31:-1])
        if (
            base_range > 0
            and range18 <= 0.5 * base_range
            and close > prior_high
            and base_vol > 0
            and bar[5] >= 2 * base_vol
        ):
            out.append(("t3_breakout", close / prior_high - 1))

        # cooldown 적용
        fired = []
        for trig, strength in out:
            last = self.last_fire.get(trig)
            if last is not None and ts - last < COOLDOWN_SEC:
                continue
            self.last_fire[trig] = ts
            fired.append((trig, strength))
        return fired


def forward_returns(bars, idx):
    """이벤트 bar idx 의 close 기준 forward. (horizon -> (ret, stale))"""
    ts0, entry = bars[idx][0], bars[idx][4]
    out = {}
    j = idx
    for horizon in HORIZONS:
        target = ts0 + horizon
        while j + 1 < len(bars) and bars[j + 1][0] <= target:
            j += 1
        bar = bars[j]
        if bar[0] <= ts0:
            out[str(horizon)] = None
            continue
        if j == len(bars) - 1 and bar[0] < target - STALE_SEC:
            # 세션 종료로 인한 절단 — censored
            out[str(horizon)] = {"ret": bar[4] / entry - 1, "censored": True,
                                 "stale": target - bar[0] > STALE_SEC}
        else:
            out[str(horizon)] = {"ret": bar[4] / entry - 1, "censored": False,
                                 "stale": target - bar[0] > STALE_SEC}
    return out


def scan_session(name, births, writer):
    path = os.path.join(SESSIONS_DIR, name, "micro-candles.jsonl")
    if not os.path.exists(path):
        return 0
    by_pair = {}
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if '"intervalSec":10,' not in line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            pair = row.get("pairAddress")
            if not pair:
                continue
            try:
                bar = (parse_ts(row["timestamp"]), float(row["open"]), float(row["high"]),
                       float(row["low"]), float(row["close"]), float(row.get("volume", 0)),
                       float(row.get("buyVolume", 0)), int(row.get("tradeCount", 0)))
            except (KeyError, TypeError, ValueError):
                continue
            if bar[4] <= 0:
                continue
            # 캔들 빌더가 같은 (pair, ts) 를 업데이트마다 재기록 (최대 156회 관측).
            # 파일 순서 = append 순서이므로 마지막 발생분(최종본)만 유지.
            by_pair.setdefault(pair, {})[bar[0]] = bar

    events = 0
    for pair, bars_by_ts in by_pair.items():
        bars = sorted(bars_by_ts.values(), key=lambda b: b[0])
        scanner = PairScanner(pair, births.get(pair, bars[0][0]))
        pending = []  # (idx, trigger, strength, eligible)
        for idx, bar in enumerate(bars):
            scanner.add(bar)
            if not scanner.eligible(bar[0]):
                scanner.persist_streak = 0
                continue
            for trig, strength in scanner.check_triggers():
                pending.append((idx, trig, strength))
        for idx, trig, strength in pending:
            fwd = forward_returns(bars, idx)
            writer.write(json.dumps({
                "pair": pair,
                "session": name,
                "trigger": trig,
                "ts": datetime.fromtimestamp(bars[idx][0], tz=timezone.utc)
                      .isoformat().replace("+00:00", "Z"),
                "ageSec": int(bars[idx][0] - scanner.birth_ts),
                "entryClose": bars[idx][4],
                "strength": strength,
                "forward": fwd,
            }) + "\n")
            events += 1
    return events


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", type=int, default=None)
    parser.add_argument("--out", default=os.path.join(CACHE, "events.jsonl"))
    args = parser.parse_args()

    births = load_births()
    dirs = session_dirs(args.sample)
    started = time.time()
    total = 0
    with open(args.out, "w", encoding="utf-8") as writer:
        for i, name in enumerate(dirs):
            total += scan_session(name, births, writer)
            if (i + 1) % 50 == 0:
                print(f"  {i+1}/{len(dirs)} sessions, events={total}, "
                      f"{time.time()-started:.0f}s", file=sys.stderr)
    meta = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sessions": len(dirs), "sample": args.sample, "events": total,
        "params": {"ageMinSec": AGE_MIN_SEC, "rugFloor": RUG_FLOOR,
                   "cooldownSec": COOLDOWN_SEC, "horizons": HORIZONS},
    }
    with open(os.path.join(CACHE, "scan_meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    print(f"events={total} sessions={len(dirs)} -> {args.out} ({time.time()-started:.0f}s)")


if __name__ == "__main__":
    main()
