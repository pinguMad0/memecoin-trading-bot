#!/usr/bin/env python3
"""Manage configuration batches for the shadow-trading pipeline.

Usage:
  uv run --no-project python scripts/batch_tools.py --list
  uv run --no-project python scripts/batch_tools.py --analyze [--batch N]
  uv run --no-project python scripts/batch_tools.py --new --hypothesis "..." --expect "..."
  uv run --no-project python scripts/batch_tools.py --verdict N --result "..." --verdict-word SUCCESS|FAILURE|PRELIMINARY
"""

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRADES = ROOT / "data" / "signals" / "shadow_trades.jsonl"
BATCH_STATE = ROOT / "data" / "signals" / "batch_state.json"
CHANGE_LOG = ROOT / "data" / "signals" / "config_change_log.json"
CONFIG = ROOT / "data" / "signals" / "strategy_config.json"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def config_hash():
    cfg = load_json(CONFIG, {})
    return hashlib.sha1(json.dumps(cfg, sort_keys=True).encode()).hexdigest()[:12]


def load_exits():
    exits = []
    if not TRADES.exists():
        return exits
    with TRADES.open(encoding="utf-8") as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("event") != "exit":
                continue
            if e.get("invalid"):
                continue  # invalid trades (stale triggers etc.) never touch verdict stats
            if "batch" in e:
                e["batch"] = int(e["batch"])
            else:
                e["batch"] = 1
            exits.append(e)
    return exits


def batch_stats(exits):
    out = {}
    for e in exits:
        b = e["batch"]
        s = out.setdefault(
            b, {"n": 0, "wins": 0, "sum_ret": 0.0, "stops": 0, "reasons": {}}
        )
        r = e.get("return") or 0
        if not (-0.95 < r < 3):
            continue  # glitch outliers excluded from verdict stats
        s["n"] += 1
        s["sum_ret"] += r
        if r > 0:
            s["wins"] += 1
        if e.get("reason") == "sl":
            s["stops"] += 1
        s["reasons"][e.get("reason")] = s["reasons"].get(e.get("reason"), 0) + 1
    for b, s in out.items():
        n = s["n"]
        s["mean_ret"] = s["sum_ret"] / n if n else 0.0
        s["win_rate"] = s["wins"] / n if n else 0.0
        s["stop_rate"] = s["stops"] / n if n else 0.0
    return out


def cmd_list(_):
    state = load_json(BATCH_STATE, {})
    log = load_json(CHANGE_LOG, [])
    exits = load_exits()
    stats = batch_stats(exits)
    print(
        f"active batch: {state.get('batch')} (config_hash={state.get('config_hash')})"
    )
    print(f"{'batch':>5} {'n':>6} {'mean':>8} {'WR':>6} {'stops':>6}  verdict")
    for entry in log:
        b = entry.get("batch")
        s = stats.get(b, {"n": 0, "mean_ret": 0, "win_rate": 0, "stop_rate": 0})
        print(
            f"{b:>5} {s['n']:>6} {100 * s['mean_ret']:>+7.1f}% "
            f"{100 * s['win_rate']:>5.0f}% {100 * s['stop_rate']:>5.1f}%  "
            f"{entry.get('verdict') or '-'}"
        )


def cmd_analyze(args):
    stats = batch_stats(load_exits())
    if args.batch is None:
        for b in sorted(stats):
            print_batch(b, stats[b])
        return
    if args.batch not in stats:
        print(f"no closed trades found for batch {args.batch}")
        return
    print_batch(args.batch, stats[args.batch])
    write_analysis_md(args.batch, stats[args.batch])


def print_batch(b, s):
    print(
        f"batch {b}: n={s['n']} mean={100 * s['mean_ret']:+.1f}% "
        f"WR={100 * s['win_rate']:.0f}% stop-outs={100 * s['stop_rate']:.1f}% "
        f"reasons={s['reasons']}"
    )


def write_analysis_md(b, s):
    log = load_json(CHANGE_LOG, [])
    entry = next((x for x in log if x.get("batch") == b), None)
    path = ROOT / "data" / "signals" / f"BATCH{b}_ANALYSIS.md"
    lines = [
        f"# Batch {b} Analysis",
        "",
        f"- Status: {entry.get('verdict') if entry else 'unknown'} (n={s['n']}, "
        f"{'meets' if s['n'] >= 30 else 'BELOW'} the n>=30 verdict rule)",
        f"- Mean return: {100 * s['mean_ret']:+.1f}%",
        f"- Win rate: {100 * s['win_rate']:.0f}%",
        f"- Stop-out rate: {100 * s['stop_rate']:.1f}%",
        f"- Exit reason mix: {s['reasons']}",
        "",
        f"## Hypothesis",
        "",
        (entry or {}).get("hypothesis") or "-",
        "",
        f"## Expected",
        "",
        (entry or {}).get("expected_outcome") or "-",
        "",
        f"## Actual",
        "",
        (entry or {}).get("actual") or "(pending - fill on verdict)",
        "",
        f"## Verdict",
        "",
        (entry or {}).get("verdict") or "PRELIMINARY",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {path}")


def cmd_new(args):
    if not args.hypothesis:
        sys.exit("--hypothesis is required for --new")
    state = load_json(BATCH_STATE, {"batch": 1})
    log = load_json(CHANGE_LOG, [])
    old = state.get("batch") or 1
    new = old + 1
    h = config_hash()
    state = {
        "batch": new,
        "started_at": now_iso(),
        "config_hash": h,
        "hypothesis": args.hypothesis,
        "expected_outcome": args.expect or "",
        "status": "active",
    }
    save_json(BATCH_STATE, state)
    log.append(
        {
            "ts": now_iso(),
            "batch": new,
            "config_hash": h,
            "supersedes_batch": old,
            "hypothesis": args.hypothesis,
            "expected_outcome": args.expect or "",
            "actual": None,
            "verdict": "PRELIMINARY",
        }
    )
    save_json(CHANGE_LOG, log)
    print(f"batch {new} active (config_hash={h})")
    print("Restart the shadow loop to use the new batch.")


def cmd_verdict(args):
    log = load_json(CHANGE_LOG, [])
    target = args.verdict
    for entry in log:
        if entry.get("batch") == target:
            entry["actual"] = args.result
            entry["verdict"] = args.verdict_word
            break
    else:
        sys.exit(f"batch {target} not found in change log")
    save_json(CHANGE_LOG, log)
    print(f"batch {target} verdict recorded: {args.verdict_word}")


def cmd_activate(args):
    log = load_json(CHANGE_LOG, [])
    entry = next((x for x in log if x.get("batch") == args.activate), None)
    if not entry:
        sys.exit(
            f"batch {args.activate} not found in change log (nothing pre-registered)"
        )
    state = {
        "batch": args.activate,
        "started_at": now_iso(),
        "config_hash": config_hash(),
        "hypothesis": entry.get("hypothesis") or "",
        "expected_outcome": entry.get("expected_outcome") or "",
        "status": "active",
    }
    save_json(BATCH_STATE, state)
    entry["status"] = "active"
    entry["activated_at"] = now_iso()
    save_json(CHANGE_LOG, log)
    print(f"batch {args.activate} ACTIVE — restart the loops to stamp it")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_mutually_exclusive_group(required=True)
    sub.add_argument("--list", action="store_true")
    sub.add_argument("--analyze", action="store_true")
    sub.add_argument("--new", action="store_true")
    sub.add_argument(
        "--activate",
        type=int,
        metavar="N",
        help="activate a pre-registered batch (no new ledger entry)",
    )
    sub.add_argument("--verdict", type=int, metavar="N")
    p.add_argument("--batch", type=int)
    p.add_argument("--hypothesis")
    p.add_argument("--expect")
    p.add_argument("--result")
    p.add_argument(
        "--verdict-word",
        choices=["SUCCESS", "FAILURE", "PRELIMINARY"],
        default="PRELIMINARY",
    )
    args = p.parse_args()
    if args.list:
        cmd_list(args)
    elif args.analyze:
        cmd_analyze(args)
    elif args.new:
        cmd_new(args)
    elif args.activate is not None:
        cmd_activate(args)
    elif args.verdict is not None:
        if not args.result:
            sys.exit("--result is required with --verdict")
        cmd_verdict(args)


if __name__ == "__main__":
    raise SystemExit(main())
