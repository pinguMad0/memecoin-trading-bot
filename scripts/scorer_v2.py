#!/usr/bin/env python3
"""Scorer: forward-path outcome signatures for recorded pool signals.

Reads data/signals/events_v2.jsonl (pool feed), for each signal older than
--min-age-min minutes fetches 1-minute OHLCV candles from GeckoTerminal
(free public API, throttled ~20 calls/min), and writes one scored row per
mint to data/signals/scored_v2.jsonl:

  entry_price        pool payload price at signal time (no lookahead)
  mfe/mae @ 5/10/15/30/60m
  tp_before_sl       for TP +50%/+100% x SL -30%/-50% within 15m:
                     'tp' | 'sl' | 'timeout'  (same-candle touch = SL, conservative)
  timeout_ret_15m    close-based return at 15m when neither level hit
  truncated          candle series ends early (dead/delisted)

Prints base-rate summary: overall and by launch-liquidity bucket.
Resumable: already-scored mints are skipped.

Run: uv run --no-project python scripts/scorer_v2.py [--max N] [--min-age-min 75]
"""

import argparse
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "signals" / "events_v2.jsonl"
SCORED = ROOT / "data" / "signals" / "scored_v2.jsonl"
CANDLES = ROOT / "data" / "signals" / "candles_v2.jsonl"
NO_CANDLES = ROOT / "data" / "signals" / "no_candles.json"


def load_no_candle_mints():
    if NO_CANDLES.exists():
        try:
            return json.loads(NO_CANDLES.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}


def save_no_candle_mints(store):
    NO_CANDLES.parent.mkdir(parents=True, exist_ok=True)
    NO_CANDLES.write_text(json.dumps(store), encoding="utf-8")


GT_OHLCV = (
    "https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/ohlcv/minute"
)
CALL_INTERVAL_S = 12.0
HORIZONS = [300, 600, 900, 1800, 3600]
TPS = [0.5, 1.0]
SLS = [-0.3, -0.5]
TP_WINDOW = 900


def fetch_candles_retry(pool, ts_signal, max_retries=3):
    wait = 90
    for attempt in range(max_retries):
        try:
            return fetch_candles(pool, ts_signal)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(wait)
                wait = min(wait * 2, 300)
                continue
            raise
    return None


def http_json(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8"))


def med(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else None


def pct(xs, cond):
    return 100 * sum(1 for x in xs if cond(x)) / len(xs) if xs else 0.0


def liq_bucket(l):
    if l < 1_000:
        return "<1K"
    if l < 5_000:
        return "1-5K"
    if l < 10_000:
        return "5-10K"
    return ">=10K"


def load_signals(min_age_s, max_age_s=0):
    seen_mints = {}
    with EVENTS.open(encoding="utf-8") as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("feed") != "pool" or not e.get("mint") or not e.get("pool"):
                continue
            if not e.get("dex") or "pump" not in str(e["dex"]).lower():
                continue
            ts = datetime.fromisoformat(e["ts"]).timestamp()
            mint = e["mint"]
            if mint.startswith("solana_"):
                mint = mint[len("solana_") :]
            if mint in seen_mints:
                continue
            a = e["payload"].get("attributes") or {}
            tx = (a.get("transactions") or {}).get("h1") or {}
            seen_mints[mint] = {
                "mint": mint,
                "pool": e["pool"],
                "ts_signal": ts,
                "entry_price": float(a.get("base_token_price_usd") or 0),
                "liq": float(e.get("liq_usd") or 0),
                "vol24": float(e.get("vol24_usd") or 0),
                "buyers_h1": tx.get("buyers") or 0,
                "buys_h1": tx.get("buys") or 0,
                "sells_h1": tx.get("sells") or 0,
            }
    now = time.time()
    ready = [
        s
        for s in seen_mints.values()
        if now - s["ts_signal"] >= min_age_s
        and s["entry_price"] > 0
        and (not max_age_s or now - s["ts_signal"] <= max_age_s)
    ]
    ready.sort(key=lambda s: s["ts_signal"])
    return ready


def load_scored_mints():
    done = set()
    if SCORED.exists():
        with SCORED.open(encoding="utf-8") as f:
            for line in f:
                try:
                    m = json.loads(line)["mint"]
                    if m.startswith("solana_"):
                        m = m[len("solana_") :]
                    done.add(m)
                except (ValueError, KeyError):
                    continue
    return done


def fetch_candles(pool, ts_signal):
    before = int(ts_signal + 9300)
    url = f"{GT_OHLCV.format(pool=pool)}?aggregate=1&limit=150&currency=usd&before_timestamp={before}"
    d = http_json(url)
    rows = ((d.get("data") or {}).get("attributes") or {}).get("ohlcv_list") or []
    rows = [r for r in rows if len(r) >= 6 and r[5] is not None]
    rows = [r for r in rows if r[0] >= ts_signal - 60]
    rows.sort(key=lambda r: r[0])
    return rows


def score_signal(s, candles):
    entry = s["entry_price"]
    out = {
        "mint": s["mint"],
        "pool": s["pool"],
        "ts_signal": s["ts_signal"],
        "entry_price": entry,
        "liq": s["liq"],
        "vol24": s["vol24"],
        "buyers_h1": s["buyers_h1"],
        "buys_h1": s["buys_h1"],
        "sells_h1": s["sells_h1"],
    }
    for h in HORIZONS:
        rows = [c for c in candles if c[0] <= s["ts_signal"] + h]
        if rows:
            out[f"mfe_{h}s"] = max(r[2] for r in rows) / entry - 1
            out[f"mae_{h}s"] = min(r[3] for r in rows) / entry - 1
        else:
            out[f"mfe_{h}s"] = None
            out[f"mae_{h}s"] = None
    for tp in TPS:
        for sl in SLS:
            key = f"tp{int(tp * 100)}_sl{int(-sl * 100)}"
            res = "timeout"
            for c in candles:
                if c[0] > s["ts_signal"] + TP_WINDOW:
                    break
                hit_sl = c[3] <= entry * (1 + sl)
                hit_tp = c[2] >= entry * (1 + tp)
                if hit_sl:
                    res = "sl"
                    break
                if hit_tp:
                    res = "tp"
                    break
            out[key] = res
    close_15m = [c for c in candles if c[0] <= s["ts_signal"] + TP_WINDOW]
    out["timeout_ret_15m"] = close_15m[-1][4] / entry - 1 if close_15m else None
    last_ts = candles[-1][0] if candles else None
    out["truncated"] = bool(last_ts is None or last_ts < s["ts_signal"] + 3300)
    out["n_candles"] = len(candles)
    return out


def summarize(rows):
    n = len(rows)
    print(f"\nscored: {n:,}")
    if not n:
        return
    mfe15 = [r["mfe_900s"] for r in rows if r["mfe_900s"] is not None]
    print(
        f"MFE within 15m:  median={100 * med(mfe15):+.1f}%  P(>=+50%)={pct(mfe15, lambda x: x >= 0.5):.1f}%  P(>=+100%)={pct(mfe15, lambda x: x >= 1.0):.1f}%"
    )
    mae15 = [r["mae_900s"] for r in rows if r["mae_900s"] is not None]
    print(
        f"MAE within 15m:  median={100 * med(mae15):+.1f}%  P(<=-30%)={pct(mae15, lambda x: x <= -0.3):.1f}%"
    )
    print(
        f"truncated series (dead/delisted): {pct(rows, lambda r: r['truncated']):.1f}%"
    )
    print(f"\nTP-before-SL within 15m (base rates):")
    for tp in TPS:
        for sl in SLS:
            key = f"tp{int(tp * 100)}_sl{int(-sl * 100)}"
            tp_ct = sum(1 for r in rows if r[key] == "tp")
            sl_ct = sum(1 for r in rows if r[key] == "sl")
            to_ct = sum(1 for r in rows if r[key] == "timeout")
            ev_tp = tp_ct * tp
            ev_sl = sl_ct * sl
            print(
                f"  {key:14s} P(tp)={100 * tp_ct / n:5.1f}%  P(sl)={100 * sl_ct / n:5.1f}%  P(timeout)={100 * to_ct / n:5.1f}%"
                f"  EV/trade={100 * (ev_tp + ev_sl) / n:+.1f}% (timeout=0)"
            )
    print(f"\nby launch liquidity bucket:")
    for b in ("<1K", "1-5K", "5-10K", ">=10K"):
        br = [r for r in rows if liq_bucket(r["liq"]) == b]
        if not br:
            continue
        bm = [r["mfe_900s"] for r in br if r["mfe_900s"] is not None]
        key = "tp50_sl30"
        tp_ct = sum(1 for r in br if r[key] == "tp")
        sl_ct = sum(1 for r in br if r[key] == "sl")
        print(
            f"  liq {b:6s} n={len(br):4d}  median MFE15={100 * (med(bm) or 0):+6.1f}%  P(>=+50%)={pct(bm, lambda x: x >= 0.5):5.1f}%  "
            f"P(tp50 before sl30)={100 * tp_ct / len(br):5.1f}%  P(sl)={100 * sl_ct / len(br):5.1f}%"
        )


def load_candle_mints():
    have = set()
    if CANDLES.exists():
        with CANDLES.open(encoding="utf-8") as f:
            for line in f:
                try:
                    have.add(json.loads(line)["mint"])
                except (ValueError, KeyError):
                    continue
    return have


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--max", type=int, default=500, help="max signals scored this run")
    p.add_argument("--min-age-min", type=int, default=75)
    p.add_argument(
        "--max-age-min",
        type=int,
        default=0,
        help="only score pools younger than this many minutes (0 = no cap)",
    )
    p.add_argument(
        "--min-liq",
        type=float,
        default=5000,
        help="only score pools with >= this launch liquidity",
    )
    p.add_argument(
        "--backfill",
        action="store_true",
        help="only fetch candle paths for already-scored rows",
    )
    p.add_argument(
        "--interval", type=float, default=12.0, help="seconds between candle fetches"
    )
    args = p.parse_args()
    EVENTS.parent.mkdir(parents=True, exist_ok=True)
    global CALL_INTERVAL_S
    CALL_INTERVAL_S = args.interval
    if args.backfill:
        have = load_candle_mints()
        by_mint = {}
        with SCORED.open(encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                    m = r["mint"]
                    if m.startswith("solana_"):
                        m = m[len("solana_") :]
                    r["mint"] = m
                    by_mint[m] = r
                except (ValueError, KeyError):
                    continue
        bf = [
            r
            for m, r in by_mint.items()
            if m not in have and (r.get("liq") or 0) >= args.min_liq
        ]
        bf.sort(key=lambda r: -(r.get("liq") or 0))
        print(
            f"candle backfill: {len(bf):,} scored rows missing paths (capped at {args.max})"
        )
        got = fails = 0
        t0 = time.time()
        for i, r in enumerate(bf[: args.max]):
            try:
                candles = fetch_candles_retry(r["pool"], r["ts_signal"])
            except Exception as e:
                fails += 1
                if fails <= 5:
                    print(f"  fetch failed {r['mint'][:8]}..: {e}")
                continue
            if candles is None:
                print(f"  rate-limited repeatedly at {i + 1}, stopping early")
                break
            if candles:
                with CANDLES.open("a", encoding="utf-8") as f:
                    f.write(
                        json.dumps(
                            {
                                "mint": r["mint"],
                                "pool": r["pool"],
                                "ts_signal": r["ts_signal"],
                                "entry_price": r["entry_price"],
                                "candles": candles,
                            },
                            separators=(",", ":"),
                        )
                        + "\n"
                    )
                got += 1
            if (i + 1) % 50 == 0:
                print(
                    f"  {i + 1} processed, {got} backfilled, {time.time() - t0:.0f}s",
                    flush=True,
                )
            time.sleep(CALL_INTERVAL_S)
        print(f"backfilled {got} candle paths in {time.time() - t0:.0f}s")
        return 0
    if args.max == 0:
        by_mint = {}
        if SCORED.exists():
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
        rows = list(by_mint.values())
        print(f"summary of all {len(rows):,} scored rows:")
        summarize(rows)
        return 0
    signals = load_signals(args.min_age_min * 60, args.max_age_min * 60)
    done = load_scored_mints()
    zombies = load_no_candle_mints()
    todo = [
        s
        for s in signals
        if s["mint"] not in done
        and s["mint"] not in zombies
        and s["liq"] >= args.min_liq
    ]
    todo.sort(key=lambda s: -s["liq"])
    print(
        f"signals eligible: {len(signals):,}  already scored: {len(done):,}  zombies skipped: {len(zombies):,}  todo: {len(todo):,}  (capped at {args.max})"
    )
    scored_rows = []
    errors = 0
    t0 = time.time()
    for i, s in enumerate(todo[: args.max]):
        try:
            candles = fetch_candles_retry(s["pool"], s["ts_signal"])
        except Exception as e:
            errors += 1
            if errors <= 5:
                print(f"  fetch failed {s['mint'][:8]}..: {e}")
            time.sleep(CALL_INTERVAL_S)
            continue
        if candles is None:
            print(
                f"  rate-limited repeatedly at {i + 1}, stopping early (resume later)"
            )
            break
        if not candles:
            zombies[s["mint"]] = zombies.get(s["mint"], 0) + 1
            save_no_candle_mints(zombies)
            time.sleep(CALL_INTERVAL_S)
            continue
        if candles:
            row = score_signal(s, candles)
            scored_rows.append(row)
            with SCORED.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, separators=(",", ":")) + "\n")
            with CANDLES.open("a", encoding="utf-8") as f:
                f.write(
                    json.dumps(
                        {
                            "mint": s["mint"],
                            "pool": s["pool"],
                            "ts_signal": s["ts_signal"],
                            "entry_price": s["entry_price"],
                            "candles": candles,
                        },
                        separators=(",", ":"),
                    )
                    + "\n"
                )
        if (i + 1) % 50 == 0:
            print(
                f"  {i + 1} processed, {len(scored_rows)} scored, {errors} errors, {time.time() - t0:.0f}s",
                flush=True,
            )
        time.sleep(CALL_INTERVAL_S)
    save_no_candle_mints(zombies)
    summarize(scored_rows)
    print(f"\ndone in {time.time() - t0:.0f}s. results appended to {SCORED}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
