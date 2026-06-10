#!/usr/bin/env python3
"""Phase 0 판정 리포트 — trigger 별 forward 분포 + post-cost bar 대조 + chrono 안정성.

기각 조건 (lane design §6): 전 trigger 의 post-cost median 이
ticket 0.05 / 0.1 두 시나리오 모두에서 음수.

Usage:
  python3 02_phase0_report.py [--events ../cache/events.jsonl]
"""
import argparse
import json
import os
import random
import statistics
import time

CACHE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "cache"))
REPORTS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "reports"))

# 비용 bar (lane design §4): 고정비 0.0027 SOL/RT + price-level RT ~1.5%
COST_BARS = {"ticket_0.05": 0.0027 / 0.05 + 0.015, "ticket_0.1": 0.0027 / 0.1 + 0.015}
HORIZONS = ["300", "900", "1800", "3600", "7200"]
PRIMARY = "1800"
CHRONO_SPLIT = "2026-04-26"  # 52일 구간의 중앙 부근 고정 분할
SEED = 20260610


def capped_mean(values, cap=10.0):
    return statistics.fmean(min(v, cap) for v in values) if values else None


def bootstrap_median_ci(values, resamples=1000):
    if len(values) < 10:
        return None
    rng = random.Random(SEED)
    medians = []
    for _ in range(resamples):
        sample = [values[rng.randrange(len(values))] for _ in range(len(values))]
        medians.append(statistics.median(sample))
    medians.sort()
    return [medians[int(0.025 * resamples)], medians[int(0.975 * resamples)]]


def returns_at(events, horizon, include_censored=False):
    out = []
    for event in events:
        fwd = event["forward"].get(horizon)
        if fwd is None:
            continue
        if fwd["censored"] and not include_censored:
            continue
        out.append(fwd["ret"])
    return out


def summarize(events, horizon):
    rets = returns_at(events, horizon)
    if not rets:
        return {"n": 0}
    all_fwd = [e["forward"].get(horizon) for e in events]
    stale = sum(1 for f in all_fwd if f and f.get("stale"))
    censored = sum(1 for f in all_fwd if f and f["censored"])
    return {
        "n": len(rets),
        "median": statistics.median(rets),
        "meanCapped10": capped_mean(rets),
        "positiveRate": sum(1 for r in rets if r > 0) / len(rets),
        "pLe20": sum(1 for r in rets if r <= -0.20) / len(rets),
        "pGe50": sum(1 for r in rets if r >= 0.50) / len(rets),
        "staleShare": stale / len(all_fwd) if all_fwd else 0,
        "censoredShare": censored / len(all_fwd) if all_fwd else 0,
    }


def fmt_pct(value):
    return "n/a" if value is None else f"{value*100:+.1f}%"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", default=os.path.join(CACHE, "events.jsonl"))
    args = parser.parse_args()
    os.makedirs(REPORTS, exist_ok=True)

    events = [json.loads(line) for line in open(args.events, encoding="utf-8")]
    triggers = sorted({e["trigger"] for e in events})
    by_trigger = {t: [e for e in events if e["trigger"] == t] for t in triggers}

    summary = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "totalEvents": len(events),
               "uniquePairs": len({e["pair"] for e in events}),
               "costBars": COST_BARS, "primaryHorizon": PRIMARY, "triggers": {}}
    lines = ["# Phase 0 — Survivor Momentum Trigger 판정", "",
             f"- generated: {summary['generatedAt']} (seed {SEED}, bootstrap 1000)",
             f"- events: {len(events)} / unique pairs: {summary['uniquePairs']}",
             f"- cost bars: ticket 0.05 → {COST_BARS['ticket_0.05']*100:.1f}% / "
             f"ticket 0.1 → {COST_BARS['ticket_0.1']*100:.1f}%",
             f"- primary horizon: T+{int(PRIMARY)//60}min (median 기준 판정)", ""]

    reject_all = True
    for trig in triggers:
        evs = by_trigger[trig]
        days = sorted({e["ts"][:10] for e in evs})
        first_half = [e for e in evs if e["ts"][:10] < CHRONO_SPLIT]
        second_half = [e for e in evs if e["ts"][:10] >= CHRONO_SPLIT]
        # first-event-per-pair robustness (within-pair serial correlation 제거)
        first_per_pair = {}
        for e in sorted(evs, key=lambda x: x["ts"]):
            first_per_pair.setdefault(e["pair"], e)
        fpp = list(first_per_pair.values())

        horizon_rows = {h: summarize(evs, h) for h in HORIZONS}
        primary_rets = returns_at(evs, PRIMARY)
        ci = bootstrap_median_ci(primary_rets)
        primary_median = horizon_rows[PRIMARY].get("median")

        post_cost = {}
        for label, bar in COST_BARS.items():
            post_cost[label] = None if primary_median is None else primary_median - bar
        if any(v is not None and v > 0 for v in post_cost.values()):
            reject_all = False

        summary["triggers"][trig] = {
            "events": len(evs), "pairs": len({e["pair"] for e in evs}),
            "activeDays": len(days), "horizons": horizon_rows,
            "primaryMedianCI95": ci, "postCostMedian": post_cost,
            "chrono": {"firstHalf": summarize(first_half, PRIMARY),
                       "secondHalf": summarize(second_half, PRIMARY)},
            "firstPerPair": summarize(fpp, PRIMARY),
        }

        lines += [f"## {trig}", "",
                  f"- events {len(evs)} / pairs {len({e['pair'] for e in evs})} / "
                  f"active days {len(days)}", "",
                  "| horizon | N | median | mean(cap10) | P(>0) | P(<=-20%) | P(>=+50%) | stale | censored |",
                  "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
        for h in HORIZONS:
            s = horizon_rows[h]
            if s["n"] == 0:
                lines.append(f"| T+{int(h)//60}m | 0 | — | — | — | — | — | — | — |")
                continue
            lines.append(
                f"| T+{int(h)//60}m | {s['n']} | {fmt_pct(s['median'])} | "
                f"{fmt_pct(s['meanCapped10'])} | {s['positiveRate']*100:.0f}% | "
                f"{s['pLe20']*100:.0f}% | {s['pGe50']*100:.0f}% | "
                f"{s['staleShare']*100:.0f}% | {s['censoredShare']*100:.0f}% |")
        ci_text = "n/a" if ci is None else f"[{ci[0]*100:+.1f}%, {ci[1]*100:+.1f}%]"
        lines += ["",
                  f"- primary (T+30m) median CI95: {ci_text}",
                  f"- **post-cost median**: ticket 0.05 → {fmt_pct(post_cost['ticket_0.05'])} / "
                  f"ticket 0.1 → {fmt_pct(post_cost['ticket_0.1'])}",
                  f"- chrono: 전반 {fmt_pct(summary['triggers'][trig]['chrono']['firstHalf'].get('median'))} "
                  f"(n={summary['triggers'][trig]['chrono']['firstHalf']['n']}) / "
                  f"후반 {fmt_pct(summary['triggers'][trig]['chrono']['secondHalf'].get('median'))} "
                  f"(n={summary['triggers'][trig]['chrono']['secondHalf']['n']})",
                  f"- first-event-per-pair: {fmt_pct(summary['triggers'][trig]['firstPerPair'].get('median'))} "
                  f"(n={summary['triggers'][trig]['firstPerPair']['n']})", ""]

    verdict = "REJECT_ALL" if reject_all else "CANDIDATE_FOUND_NEEDS_SCRUTINY"
    summary["verdict"] = verdict
    lines += ["## 판정", "",
              f"**{verdict}** — 기각 조건: 전 trigger 의 T+30m post-cost median 이 "
              "두 ticket 시나리오 모두 음수.", "",
              "주의: Phase 0 은 기각 필터다. CANDIDATE 가 나와도 N/active days/chrono/"
              "first-per-pair 를 통과해야 Phase 1 paper 설계 자격이 생긴다 (통과 ≠ 증명).", ""]

    with open(os.path.join(REPORTS, "PHASE0_REPORT.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    with open(os.path.join(CACHE, "phase0_summary.json"), "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
    print(f"verdict={verdict} events={len(events)} -> reports/PHASE0_REPORT.md")


if __name__ == "__main__":
    main()
