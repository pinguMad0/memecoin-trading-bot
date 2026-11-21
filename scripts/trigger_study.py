#!/usr/bin/env python3
"""Trigger study v1: what does the ramp before a big leg look like, and does
entering on momentum beat entering at signal time?

Uses candle paths (candles_v2.jsonl) joined to scored rows (scored_v2.jsonl).
Gate = liq>=15K + wash veto + low sell pressure (the validated Stage-1 rule).

For each gated token, scans its minute path for a momentum trigger:
  close[t] / close[t-5] >= TRIG  (price run-up over 5 minutes)
Optional volume confirmation: avg vol of last 3 candles >= MULT x avg vol of
all candles before them.

From the trigger candle, measures the SAME TP/SL sequencing as the scorer
(TP +30%/+50% vs SL -30%, within 15 minutes), so results compare directly
against gate-only entry.

Also measures the exit question: for tokens that run >=+50% from signal,
how much do they give back from peak within 10 minutes.

Run: uv run --no-project python scripts/trigger_study.py [--trig 0.15] [--volmult 0]
"""

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCORED = ROOT / "data" / "signals" / "scored_v2.jsonl"
CANDLES = ROOT / "data" / "signals" / "candles_v2.jsonl"


def med(xs):
    xs = sorted(x for x in xs if x is not None)
    return xs[len(xs) // 2] if xs else None


def pct(xs, cond):
    return 100 * sum(1 for x in xs if cond(x)) / len(xs) if xs else 0.0


def outcome_from(candles, t, tp, sl, window=15, slip=0.0, worst=False):
    if worst:
        entry = candles[t][2]
    else:
        entry = candles[t][4] * (1 + slip)
    res = "timeout"
    for c in candles[t + 1 : t + 1 + window]:
        if c[3] <= entry * (1 + sl):
            res = "sl"
            break
        if c[2] >= entry * (1 + tp):
            res = "tp"
            break
    close = candles[min(t + window, len(candles) - 1)][4]
    return res, close / entry - 1


def main():
    p = argparse.ArgumentParser()
    p.add_argument(
        "--trig", type=float, default=0.15, help="5-min run-up threshold for trigger"
    )
    p.add_argument(
        "--volmult",
        type=float,
        default=0.0,
        help="require last-3-candle vol >= N x prior avg (0=off)",
    )
    p.add_argument(
        "--slip",
        type=float,
        default=0.0,
        help="entry slippage on trigger close (0.03 means +3 percent)",
    )
    p.add_argument(
        "--worst", action="store_true", help="enter at the HIGH of the trigger candle"
    )
    args = p.parse_args()

    rows = {}
    with SCORED.open(encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            m = r["mint"]
            if m.startswith("solana_"):
                m = m[len("solana_") :]
            rows[m] = r

    paths = {}
    with CANDLES.open(encoding="utf-8") as f:
        for line in f:
            try:
                c = json.loads(line)
                paths.setdefault(c["mint"], c)
            except (ValueError, KeyError):
                continue

    gated = []
    for m, r in rows.items():
        if m not in paths:
            continue
        liq = r.get("liq") or 0
        bb = (r.get("buys_h1") or 0) / max(1, r.get("buyers_h1") or 0)
        sp = (r.get("sells_h1") or 0) / max(1, r.get("buys_h1") or 0)
        if liq >= 15_000 and bb <= 3 and sp <= 0.3:
            gated.append((r, paths[m]))

    print(
        f"gate-passing tokens with candle paths: {len(gated):,} (of {len(rows):,} scored, {len(paths):,} paths)"
    )

    base = {"tp": 0, "sl": 0, "timeout": 0}
    for r, _ in gated:
        base[r.get("tp50_sl30", "timeout")] += 1
    n = max(1, len(gated))
    print(
        f"\ngate-only entry at signal time (baseline, same token set): n={len(gated)}"
    )
    print(
        f"  P(tp50 first)={100 * base['tp'] / n:.1f}%  P(sl30 first)={100 * base['sl'] / n:.1f}%  "
        f"P(timeout)={100 * base['timeout'] / n:.1f}%  EV/trade={100 * (0.5 * base['tp'] / n - 0.3 * base['sl'] / n):+.1f}%"
    )

    trig_tokens = 0
    trig_outcomes = {"tp": 0, "sl": 0, "timeout": 0}
    trig_rets = []
    late_triggers = 0
    for r, path in gated:
        candles = [c for c in path["candles"] if len(c) >= 6]
        if len(candles) < 12:
            continue
        fired = False
        for t in range(5, len(candles) - 2):
            mom = candles[t][4] / candles[t - 5][4] - 1
            if mom < args.trig:
                continue
            if args.volmult > 0:
                prior_vols = [c[5] for c in candles[max(0, t - 10) : t - 2]]
                if not prior_vols or med(prior_vols) <= 0:
                    continue
                recent = sum(c[5] for c in candles[t - 2 : t + 1]) / 3
                if recent < args.volmult * med(prior_vols):
                    continue
            fired = True
            break
        if not fired:
            continue
        trig_tokens += 1
        if t > len(candles) - 15:
            late_triggers += 1
        res, ret = outcome_from(candles, t, 0.5, -0.3, slip=args.slip, worst=args.worst)
        trig_outcomes[res] += 1
        trig_rets.append(ret)

    tn = max(1, trig_tokens)
    print(
        f"\nMOMENTUM TRIGGER: +{args.trig * 100:.0f}% over 5 min"
        + (f" + {args.volmult}x volume" if args.volmult else "")
    )
    print(
        f"  fired on {trig_tokens}/{len(gated)} gated tokens ({100 * trig_tokens / max(1, len(gated)):.1f}%), "
        f"{late_triggers} too late in window to fully measure"
    )
    print(
        f"  P(tp50 first)={100 * trig_outcomes['tp'] / tn:.1f}%  P(sl30 first)={100 * trig_outcomes['sl'] / tn:.1f}%  "
        f"P(timeout)={100 * trig_outcomes['timeout'] / tn:.1f}%  EV/trade={100 * (0.5 * trig_outcomes['tp'] / tn - 0.3 * trig_outcomes['sl'] / tn):+.1f}%"
    )
    if trig_rets:
        print(f"  median 15m return from trigger: {100 * med(trig_rets):+.1f}%")

    peak_retraces = []
    for r, path in gated:
        candles = [c for c in path["candles"] if len(c) >= 6]
        if len(candles) < 12:
            continue
        entry = path["entry_price"]
        peak_i = max(range(len(candles)), key=lambda i: candles[i][2])
        if candles[peak_i][2] < 1.5 * entry:
            continue
        after = candles[peak_i : peak_i + 11]
        if after:
            trough = min(c[3] for c in after)
            peak_retraces.append(1 - trough / candles[peak_i][2])
    if peak_retraces:
        print(f"\nEXIT STUDY: tokens that ran >=+50% (n={len(peak_retraces)})")
        print(
            f"  give-back from peak within 10 min: median={100 * med(peak_retraces):.0f}%  "
            f"P(give back >=20%)={pct(peak_retraces, lambda x: x >= 0.2):.0f}%  "
            f"P(give back >=40%)={pct(peak_retraces, lambda x: x >= 0.4):.0f}%"
        )


if __name__ == "__main__":
    raise SystemExit(main())
