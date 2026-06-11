#!/usr/bin/env python3
"""H-009 Phase 0 백테스트 — HYPOTHESES.md 사전 등록 룰 (commit e5e5414) 그대로.

룰 (전부 long/flat, 4h bar close 에서 신호 → 다음 bar open 체결):
  A. TSMOM: close > close[N] → long. N in {180, 360, 540}
  B. MA cross: SMA(fast) > SMA(slow) → long. (20,100), (50,200)
  C. RSI pullback: close > EMA200 and RSI14 < 40 → 진입; RSI14 > 60 or close < EMA200 → 청산

비용: 진입/청산 각 side 에 cost/2 (RT 0.6% 주판정 / 0.3% 참고).
판정 구간: 2024-06-11..2026-06-11. Kill criteria 는 HYPOTHESES.md H-009 5개 그대로.
"""
import json
import math
import os
import time

CACHE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "cache"))
REPORTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "reports"))
SYMBOLS = ["SOLUSDT", "BTCUSDT", "ETHUSDT"]
RT_COSTS = {"rt_0.6%": 0.006, "rt_0.3%": 0.003}
VERDICT_START_MS = 1749600000000  # 2026-06-11 - 2y = 2024-06-11 UTC
VERDICT_START_MS = int(time.mktime(time.strptime("2024-06-11", "%Y-%m-%d"))) * 1000


def load(symbol):
    path = os.path.join(CACHE, f"{symbol}_4h.jsonl")
    bars = [json.loads(line) for line in open(path, encoding="utf-8")]
    bars.sort(key=lambda b: b[0])
    return bars  # [ms, open, high, low, close, volume]


def sma_series(closes, n):
    out = [None] * len(closes)
    total = 0.0
    for i, c in enumerate(closes):
        total += c
        if i >= n:
            total -= closes[i - n]
        if i >= n - 1:
            out[i] = total / n
    return out


def ema_series(closes, n):
    out = [None] * len(closes)
    alpha = 2 / (n + 1)
    ema = None
    for i, c in enumerate(closes):
        if i == n - 1:
            ema = sum(closes[:n]) / n
            out[i] = ema
        elif i >= n:
            ema = ema + alpha * (c - ema)
            out[i] = ema
    return out


def rsi_series(closes, n=14):
    out = [None] * len(closes)
    avg_gain = avg_loss = None
    for i in range(1, len(closes)):
        change = closes[i] - closes[i - 1]
        gain, loss = max(change, 0.0), max(-change, 0.0)
        if i == n:
            gains = [max(closes[j] - closes[j - 1], 0.0) for j in range(1, n + 1)]
            losses = [max(closes[j - 1] - closes[j], 0.0) for j in range(1, n + 1)]
            avg_gain, avg_loss = sum(gains) / n, sum(losses) / n
        elif i > n:
            avg_gain = (avg_gain * (n - 1) + gain) / n
            avg_loss = (avg_loss * (n - 1) + loss) / n
        if i >= n:
            out[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return out


def signals_for(rule, bars):
    """bar i close 에서 평가된 목표 포지션 (1=long, 0=flat). warmup 구간은 None."""
    closes = [b[4] for b in bars]
    kind, param = rule
    sig = [None] * len(bars)
    if kind == "tsmom":
        for i in range(param, len(bars)):
            sig[i] = 1 if closes[i] > closes[i - param] else 0
    elif kind == "ma":
        fast, slow = param
        f, s = sma_series(closes, fast), sma_series(closes, slow)
        for i in range(len(bars)):
            if f[i] is not None and s[i] is not None:
                sig[i] = 1 if f[i] > s[i] else 0
    elif kind == "rsi":
        ema200 = ema_series(closes, 200)
        rsi14 = rsi_series(closes, 14)
        holding = 0
        for i in range(len(bars)):
            if ema200[i] is None or rsi14[i] is None:
                continue
            if holding == 0 and closes[i] > ema200[i] and rsi14[i] < 40:
                holding = 1
            elif holding == 1 and (rsi14[i] > 60 or closes[i] < ema200[i]):
                holding = 0
            sig[i] = holding
    return sig


def run(bars, sig, rt_cost):
    """bar 단위 전략 수익률 (체결: 신호 bar 의 다음 bar open, side cost = rt/2).
    반환: (per-bar returns, trade count, per-trade returns)"""
    side = rt_cost / 2
    n = len(bars)
    rets = [0.0] * n
    pos = 0
    entry_price = None
    trades = []
    for i in range(1, n):
        target = sig[i - 1]  # 직전 bar close 신호 → 이번 bar open 체결
        if target is None:
            continue
        o, c = bars[i][1], bars[i][4]
        prev_c = bars[i - 1][4]
        if pos == 0 and target == 1:
            rets[i] = (c / o) * (1 - side) - 1
            pos, entry_price = 1, o * (1 + side)  # 비용 반영 실효 진입가
        elif pos == 1 and target == 0:
            rets[i] = (o / prev_c) * (1 - side) - 1
            trades.append(o * (1 - side) / entry_price - 1)
            pos, entry_price = 0, None
        elif pos == 1:
            rets[i] = c / prev_c - 1
    if pos == 1:  # 마지막 bar 청산 가정
        last_c = bars[-1][4]
        trades.append(last_c * (1 - side) / entry_price - 1)
        rets[-1] = (1 + rets[-1]) * (1 - side) - 1
    return rets, trades


def equity_stats(bars, rets, start_ms=None, end_ms=None):
    eq, peak, max_dd = 1.0, 1.0, 0.0
    first_ms = last_ms = None
    for i in range(len(bars)):
        ts = bars[i][0]
        if start_ms is not None and ts < start_ms:
            continue
        if end_ms is not None and ts > end_ms:
            break
        if first_ms is None:
            first_ms = ts
        last_ms = ts
        eq *= 1 + rets[i]
        peak = max(peak, eq)
        max_dd = max(max_dd, 1 - eq / peak)
    if first_ms is None:
        return None
    years = max((last_ms - first_ms) / 31_557_600_000, 1e-9)
    cagr = eq ** (1 / years) - 1 if eq > 0 else -1.0
    return {"totalReturn": eq - 1, "cagr": cagr, "maxDD": max_dd, "years": years}


def buyhold_rets(bars):
    rets = [0.0] * len(bars)
    for i in range(1, len(bars)):
        rets[i] = bars[i][4] / bars[i - 1][4] - 1
    return rets


RULES = [
    ("A_tsmom_180", ("tsmom", 180)), ("A_tsmom_360", ("tsmom", 360)),
    ("A_tsmom_540", ("tsmom", 540)),
    ("B_ma_20_100", ("ma", (20, 100))), ("B_ma_50_200", ("ma", (50, 200))),
    ("C_rsi_pullback", ("rsi", None)),
]


def main():
    os.makedirs(REPORTS, exist_ok=True)
    results = {}
    for symbol in SYMBOLS:
        bars = load(symbol)
        bh = buyhold_rets(bars)
        bh_full = equity_stats(bars, bh)
        bh_recent = equity_stats(bars, bh, start_ms=VERDICT_START_MS)
        results[symbol] = {"buyhold": {"full": bh_full, "recent2y": bh_recent},
                           "rules": {}}
        for name, rule in RULES:
            sig = signals_for(rule, bars)
            entry = {}
            for cost_label, rt in RT_COSTS.items():
                rets, trades = run(bars, sig, rt)
                full = equity_stats(bars, rets)
                recent = equity_stats(bars, rets, start_ms=VERDICT_START_MS)
                # 연도별 분해
                by_year = {}
                for year in range(2018, 2027):
                    y0 = int(time.mktime(time.strptime(f"{year}-01-01", "%Y-%m-%d"))) * 1000
                    y1 = int(time.mktime(time.strptime(f"{year}-12-31", "%Y-%m-%d"))) * 1000
                    st = equity_stats(bars, rets, start_ms=y0, end_ms=y1)
                    if st:
                        by_year[str(year)] = round(st["totalReturn"], 4)
                wins = sum(1 for t in trades if t > 0)
                entry[cost_label] = {
                    "full": full, "recent2y": recent, "byYear": by_year,
                    "trades": len(trades),
                    "winRate": wins / len(trades) if trades else None,
                    "medianTrade": sorted(trades)[len(trades) // 2] if trades else None,
                }
            results[symbol]["rules"][name] = entry

    # ── kill criteria (HYPOTHESES.md H-009, RT 0.6% 기준) ──
    verdicts = {}
    for name, _ in RULES:
        sol = results["SOLUSDT"]["rules"][name]["rt_0.6%"]
        bh = results["SOLUSDT"]["buyhold"]
        reasons = []
        if not sol["recent2y"] or sol["recent2y"]["totalReturn"] <= 0:
            reasons.append("K1: recent-2y post-cost <= 0")
        if sol["full"]["totalReturn"] <= 0 or sol["full"]["maxDD"] > 0.50:
            reasons.append("K2: full-history <= 0 or maxDD > 50%")
        strat_mar = (sol["full"]["totalReturn"] / sol["full"]["maxDD"]
                     if sol["full"]["maxDD"] > 0 else float("inf"))
        bh_mar = (bh["full"]["totalReturn"] / bh["full"]["maxDD"]
                  if bh["full"]["maxDD"] > 0 else float("inf"))
        if strat_mar <= bh_mar:
            reasons.append("K3: return/maxDD worse than buy&hold")
        status = "PASS" if not reasons else "REJECT"
        if status == "PASS":
            btc = results["BTCUSDT"]["rules"][name]["rt_0.6%"]["recent2y"]
            eth = results["ETHUSDT"]["rules"][name]["rt_0.6%"]["recent2y"]
            if (btc and btc["totalReturn"] <= 0) and (eth and eth["totalReturn"] <= 0):
                status = "HYPOTHESIS_ONLY"
                reasons.append("K4: BTC+ETH both negative — asset-specific overfit risk")
        verdicts[name] = {"status": status, "reasons": reasons}

    out = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "preRegistration": "HYPOTHESES.md H-009 (commit e5e5414)",
           "results": results, "verdicts": verdicts}
    with open(os.path.join(CACHE, "phase0_results.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, default=str)
    overall = ("REJECTED" if all(v["status"] == "REJECT" for v in verdicts.values())
               else "CANDIDATE_FAMILIES_EXIST")
    print(f"overall={overall}")
    for name, v in verdicts.items():
        print(f"  {name}: {v['status']}" + (f" ({'; '.join(v['reasons'])})" if v["reasons"] else ""))


if __name__ == "__main__":
    main()
