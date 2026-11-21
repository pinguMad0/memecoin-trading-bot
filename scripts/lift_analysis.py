#!/usr/bin/env python3
"""Lift analysis: which signal-time features push P(TP-first) above base rate?

Splits scored rows into:
  discovery  - the mints frozen in data/signals/discovery_set.json
               (created from the current scored file when --freeze is passed)
  validation - everything scored later (the holdout)

Features (all measured at signal time, no lookahead):
  launch liquidity tier, first-hour buyers, buys/buyers ratio (wash detector),
  sell pressure (sells/buys), launch volume, volume/liquidity churn

Outcome per feature bucket:
  P(TP+50% before SL-30%, 15m), P(SL first), P(timeout), EV/trade,
  median MFE15, P(MFE>=50%), dead rate

Run: uv run --no-project python scripts/lift_analysis.py [--freeze]
"""

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCORED = ROOT / "data" / "signals" / "scored_v2.jsonl"
DISCOVERY = ROOT / "data" / "signals" / "discovery_set.json"


def load_rows():
    by_mint = {}
    with SCORED.open(encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
                m = r["mint"]
                if m.startswith("solana_"):
                    r["mint"] = m = m[len("solana_") :]
                by_mint[m] = r
            except (ValueError, KeyError):
                continue
    return list(by_mint.values())


def med(xs):
    xs = sorted(x for x in xs if x is not None)
    return xs[len(xs) // 2] if xs else None


def bucket_defs(row):
    liq = row.get("liq") or 0
    buyers = row.get("buyers_h1") or 0
    buys = row.get("buys_h1") or 0
    sells = row.get("sells_h1") or 0
    vol = row.get("vol24") or 0
    bb = buys / max(1, buyers)
    sp = sells / max(1, buys)
    vl = vol / max(1, liq)
    return {
        "liq 5-10K": 5_000 <= liq < 10_000,
        "liq 10-15K": 10_000 <= liq < 15_000,
        "liq 15-50K": 15_000 <= liq < 50_000,
        "liq >50K": liq >= 50_000,
        "buyers <=5": buyers <= 5,
        "buyers 6-20": 6 <= buyers <= 20,
        "buyers >20": buyers > 20,
        "bb_ratio <=1.3": bb <= 1.3,
        "bb_ratio 1.3-3": 1.3 < bb <= 3,
        "bb_ratio >3": bb > 3,
        "sell_pres <=0.3": sp <= 0.3,
        "sell_pres 0.3-0.7": 0.3 < sp <= 0.7,
        "sell_pres >0.7": sp > 0.7,
        "vol <=500": 0 <= vol <= 500,
        "vol 500-2K": 500 < vol <= 2_000,
        "vol >2K": vol > 2_000,
        "churn <=0.1": vl <= 0.1,
        "churn 0.1-0.5": 0.1 < vl <= 0.5,
        "churn >0.5": vl > 0.5,
    }


def outcome_stats(rows):
    n = len(rows)
    if not n:
        return None
    ptp = 100 * sum(1 for r in rows if r["tp50_sl30"] == "tp") / n
    psl = 100 * sum(1 for r in rows if r["tp50_sl30"] == "sl") / n
    pto = 100 - ptp - psl
    mfe = [r.get("mfe_900s") for r in rows]
    return {
        "n": n,
        "ptp": ptp,
        "psl": psl,
        "pto": pto,
        "ev": 0.5 * ptp / 100 - 0.3 * psl / 100,
        "mfe_med": med(mfe),
        "pmfe50": 100
        * sum(1 for x in mfe if x is not None and x >= 0.5)
        / max(1, len([x for x in mfe if x is not None])),
        "dead": 100 * sum(1 for r in rows if r.get("truncated")) / n,
    }


def print_section(label, rows):
    s = outcome_stats(rows)
    if not s:
        print(f"\n### {label}: no rows yet")
        return
    print(f"\n### {label} (n={s['n']})")
    print(
        f"  base: P(tp50 first)={s['ptp']:.1f}%  P(sl30 first)={s['psl']:.1f}%  P(timeout)={s['pto']:.1f}%  "
        f"EV/trade={100 * s['ev']:+.1f}%  medMFE15={100 * (s['mfe_med'] or 0):+.0f}%  P(MFE>=50%)={s['pmfe50']:.1f}%  dead={s['dead']:.0f}%"
    )
    feats = {}
    for r in rows:
        for name, on in bucket_defs(r).items():
            if on:
                feats.setdefault(name, []).append(r)
    print(
        f"  {'feature bucket':18s} {'n':>5s} {'P(tp)':>6s} {'P(sl)':>6s} {'EV':>7s} {'medMFE':>7s} {'dead':>5s} {'lift_ev':>8s}"
    )
    for name, frows in feats.items():
        fs = outcome_stats(frows)
        if not fs or fs["n"] < 15:
            continue
        lift = 100 * (fs["ev"] - s["ev"])
        print(
            f"  {name:18s} {fs['n']:>5d} {fs['ptp']:>5.1f}% {fs['psl']:>5.1f}% "
            f"{100 * fs['ev']:>+6.1f}% {100 * (fs['mfe_med'] or 0):>+6.0f}% {fs['dead']:>4.0f}% {lift:>+7.1f}pp"
        )


def main():
    p = argparse.ArgumentParser()
    p.add_argument(
        "--freeze",
        action="store_true",
        help="freeze current scored mints as the discovery set",
    )
    args = p.parse_args()
    rows = load_rows()
    if args.freeze or not DISCOVERY.exists():
        DISCOVERY.parent.mkdir(parents=True, exist_ok=True)
        DISCOVERY.write_text(
            json.dumps(sorted(r["mint"] for r in rows)), encoding="utf-8"
        )
        print(f"discovery set frozen: {len(rows):,} mints -> {DISCOVERY}")
    disc_mints = set(json.loads(DISCOVERY.read_text(encoding="utf-8")))
    disc = [r for r in rows if r["mint"] in disc_mints]
    val = [r for r in rows if r["mint"] not in disc_mints]
    print_section("DISCOVERY SET (train)", disc)
    print_section("VALIDATION SET (holdout)", val)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
