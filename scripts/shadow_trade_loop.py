#!/usr/bin/env python3
"""Shadow-trade loop: runs the full strategy live, log-only, no capital.

Pipeline per candidate:
  pool event (from events_v2.jsonl tail) -> GATE (pump dex, liq>=15K,
  wash veto, low sell pressure) -> watchlist (capped, liq-priority)
  -> price poll every 60s via GT multi-pool (1 call for all pools)
  -> TRIGGER: price >= 1.15x price ~5min ago (requires >=5min of samples)
  -> hypothetical entry at trigger price x1.03 (slippage guard model)
  -> track: SL -30% from entry | trail 25% off rolling peak | 15m timeout
  -> log exit with modeled return

Output: data/signals/shadow_trades.jsonl (entry/exit events)
        data/signals/shadow_state.json (resumable)
Run: uv run --no-project python scripts/shadow_trade_loop.py [--duration N] [--quiet]
"""

import argparse
import atexit
import hashlib
import json
import signal
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "data" / "signals" / "events_v2.jsonl"
TRADES = ROOT / "data" / "signals" / "shadow_trades.jsonl"
STATE = ROOT / "data" / "signals" / "shadow_state.json"
CONFIG_PATH = ROOT / "data" / "signals" / "strategy_config.json"
BATCH_PATH = ROOT / "data" / "signals" / "batch_state.json"

# Defaults used when strategy_config.json is absent.
DEFAULTS = {
    "gate_min_liq": 15000,
    "gate_max_bb_ratio": 3.0,
    "gate_max_sell_pressure": 0.3,
    "mom_threshold": 0.15,
    "mom_lookback_s": 300,
    "entry_slip_model": 0.03,
    "stop_loss": -0.30,
    "trail": 0.25,
    "timeout_s": 900,
    "watch_cap": 20,
    "watch_evict_s": 2700,
    "poll_s": 90,
}
CFG = dict(DEFAULTS)
BATCH = {"batch": 1, "config_hash": ""}


def load_config():
    global CFG, BATCH
    try:
        loaded = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        for k in DEFAULTS:
            if k in loaded:
                CFG[k] = loaded[k]
    except (OSError, ValueError):
        pass
    CFG["config_hash"] = hashlib.sha1(
        json.dumps(CFG, sort_keys=True).encode()
    ).hexdigest()[:12]
    try:
        b = json.loads(BATCH_PATH.read_text(encoding="utf-8"))
        BATCH = {
            "batch": b.get("batch", 1),
            "config_hash": b.get("config_hash") or CFG["config_hash"],
        }
    except (OSError, ValueError):
        BATCH = {"batch": 1, "config_hash": CFG["config_hash"]}


GT_MULTI = "https://api.geckoterminal.com/api/v2/networks/solana/pools/multi/"


running = True
state = {
    "offset": None,
    "watchlist": {},
    "positions": {},
    "closed": 0,
    "sum_ret": 0.0,
    "wins": 0,
    "entries": 0,
}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def save_state():
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state), encoding="utf-8")


def load_state():
    if STATE.exists():
        try:
            state.update(json.loads(STATE.read_text(encoding="utf-8")))
        except (ValueError, OSError):
            pass


def log_evt(evt):
    TRADES.parent.mkdir(parents=True, exist_ok=True)
    evt["ts"] = now_iso()
    if "batch" not in evt:
        evt["batch"] = BATCH["batch"]
        evt["config_hash"] = BATCH["config_hash"]
    with TRADES.open("a", encoding="utf-8") as f:
        f.write(json.dumps(evt, separators=(",", ":")) + "\n")


def http_json(url):
    req = urllib.request.Request(
        url, headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def new_pool_events():
    if not EVENTS.exists():
        return
    if state["offset"] is None:
        state["offset"] = EVENTS.stat().st_size
        return
    with EVENTS.open("r", encoding="utf-8") as f:
        f.seek(state["offset"])
        chunk = f.read()
        state["offset"] += (
            len(chunk.encode("utf-8")) if isinstance(chunk, str) else len(chunk)
        )
    for line in chunk.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("feed") != "pool" or not e.get("mint") or not e.get("pool"):
            continue
        mint = e["mint"].split("solana_")[-1]
        if mint in state["watchlist"] or mint in state["positions"]:
            continue
        if not e.get("dex") or "pump" not in str(e["dex"]).lower():
            continue
        liq = float(e.get("liq_usd") or 0)
        tx = ((e["payload"].get("attributes") or {}).get("transactions") or {}).get(
            "h1"
        ) or {}
        buyers = tx.get("buyers") or 0
        buys = tx.get("buys") or 0
        sells = tx.get("sells") or 0
        bb = buys / max(1, buyers)
        sp = sells / max(1, buys)
        if (
            liq >= CFG["gate_min_liq"]
            and bb <= CFG["gate_max_bb_ratio"]
            and sp <= CFG["gate_max_sell_pressure"]
        ):
            state["watchlist"][mint] = {
                "mint": mint,
                "pool": e["pool"],
                "liq": liq,
                "buyers": buyers,
                "buys": buys,
                "sells": sells,
                "t_listed": time.time(),
                "samples": [],
            }
            log_evt(
                {
                    "event": "gated",
                    "mint": mint,
                    "pool": e["pool"],
                    "liq": liq,
                    "buyers": buyers,
                    "buys": buys,
                    "sells": sells,
                }
            )


def poll_prices():
    pools = {}
    for m, w in state["watchlist"].items():
        pools[w["pool"]] = ("watch", m)
    for m, p in state["positions"].items():
        pools[p["pool"]] = ("pos", m)
    if not pools:
        return
    try:
        d = http_json(GT_MULTI + ",".join(pools.keys()))
    except Exception as ex:
        if not args_quiet:
            print(f"  price poll failed: {ex}", flush=True)
        return
    now = time.time()
    for p in d.get("data", []):
        addr = p.get("attributes", {}).get("address")
        if addr not in pools:
            continue
        kind, mint = pools[addr]
        price = p.get("attributes", {}).get("base_token_price_usd")
        try:
            price = float(price)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        if kind == "watch":
            w = state["watchlist"][mint]
            if w["samples"]:
                last = w["samples"][-1][1]
                if price > last * 20 or price < last / 20:
                    continue
            w["samples"].append([now, price])
        else:
            p = state["positions"][mint]
            if p["samples"]:
                last = p["samples"][-1][1]
                if price > last * 20 or price < last / 20:
                    continue
            p["samples"].append([now, price])


def check_triggers():
    now = time.time()
    for mint, w in list(state["watchlist"].items()):
        s = w["samples"]
        if len(s) < 5:
            continue
        ref = None
        for sample in reversed(s):
            age = now - sample[0]
            if age >= CFG["mom_lookback_s"]:
                # Reference-age guard: a momentum reference older than 3x the
                # lookback is a stale carry (loop downtime), not a 5-minute
                # signal. Invalid - never fire on it.
                if age > 3 * CFG["mom_lookback_s"]:
                    break
                ref = sample[1]
                break
        if ref is None:
            continue
        latest = s[-1][1]
        if latest / ref - 1 >= CFG["mom_threshold"]:
            entry = latest * (1 + CFG["entry_slip_model"])
            pos = {
                "mint": mint,
                "pool": w["pool"],
                "entry": entry,
                "trigger_price": latest,
                "t_entry": now,
                "peak": entry,
                "liq": w["liq"],
                "entry_batch": BATCH["batch"],
                "samples": [[now, latest]],
            }
            state["positions"][mint] = pos
            del state["watchlist"][mint]
            state["entries"] += 1
            log_evt(
                {
                    "event": "entry",
                    "mint": mint,
                    "pool": w["pool"],
                    "trigger_price": latest,
                    "entry_modeled": entry,
                    "liq": w["liq"],
                    "t_listed": w["t_listed"],
                    "mom_ref": ref,
                }
            )


def check_exits():
    now = time.time()
    for mint, p in list(state["positions"].items()):
        s = p["samples"]
        if not s:
            # Stale position: the pool died (no price feed) and the position is
            # beyond timeout — close it as 'stale' with unknown outcome instead
            # of carrying it forever.
            if now - p["t_entry"] >= CFG["timeout_s"]:
                log_evt(
                    {
                        "event": "exit",
                        "batch": p.get("entry_batch") or BATCH["batch"],
                        "mint": mint,
                        "pool": p["pool"],
                        "reason": "stale",
                        "entry_modeled": p["entry"],
                        "exit_price": None,
                        "peak_price": p["peak"],
                        "return": 0.0,
                        "held_s": int(now - p["t_entry"]),
                        "peak_multiple": p["peak"] / p["entry"],
                    }
                )
                state["closed"] += 1
                del state["positions"][mint]
            continue
        price = s[-1][1]
        p["peak"] = max(p["peak"], price)
        reason = ret = None
        if price <= p["entry"] * (1 + CFG["stop_loss"]):
            reason, ret = "sl", CFG["stop_loss"]
        elif price <= p["peak"] * (1 - CFG["trail"]):
            reason, ret = "trail", price / p["entry"] - 1
        elif now - p["t_entry"] >= CFG["timeout_s"]:
            reason, ret = "timeout", price / p["entry"] - 1
        if reason:
            exit_evt = {
                "event": "exit",
                # The exit carries the batch of its ENTRY — a position
                # opened in one batch never exits into another.
                "batch": p.get("entry_batch") or BATCH["batch"],
                "mint": mint,
                "pool": p["pool"],
                "reason": reason,
                "entry_modeled": p["entry"],
                "exit_price": price,
                "peak_price": p["peak"],
                "return": ret,
                "held_s": int(now - p["t_entry"]),
                "peak_multiple": p["peak"] / p["entry"],
            }
            # Invalid trades (stale triggers etc.) are excluded from verdict
            # stats but still logged — the paper P&L is real even when the
            # signal wasn't valid.
            if p.get("invalid_reason"):
                exit_evt["invalid"] = True
                exit_evt["invalid_reason"] = p["invalid_reason"]
            log_evt(exit_evt)
            state["closed"] += 1
            state["sum_ret"] += ret
            if ret > 0:
                state["wins"] += 1
            del state["positions"][mint]


def evict_watch():
    now = time.time()
    for mint, w in list(state["watchlist"].items()):
        if now - w["t_listed"] > CFG["watch_evict_s"]:
            log_evt(
                {
                    "event": "expired",
                    "mint": mint,
                    "pool": w["pool"],
                    "n_samples": len(w["samples"]),
                    "last_price": w["samples"][-1][1] if w["samples"] else None,
                }
            )
            del state["watchlist"][mint]
    if len(state["watchlist"]) > CFG["watch_cap"]:
        worst = sorted(state["watchlist"].items(), key=lambda kv: kv[1]["liq"])[0]
        del state["watchlist"][worst[0]]


def trim_samples():
    cutoff = time.time() - 7200
    for store in ("watchlist", "positions"):
        for x in state[store].values():
            x["samples"] = [s for s in x["samples"] if s[0] >= cutoff]


args_quiet = False


def main():
    global args_quiet, running
    p = argparse.ArgumentParser()
    p.add_argument("--duration", type=int, default=0, help="auto-stop after N seconds")
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args()
    args_quiet = args.quiet
    load_config()
    load_state()

    def stop(*_):
        global running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, stop)
    atexit.register(save_state)

    print(
        f"shadow-trade loop starting -> {TRADES} [batch={BATCH['batch']} "
        f"config_hash={BATCH['config_hash']}]",
        flush=True,
    )
    log_evt(
        {
            "event": "batch_started",
            "batch": BATCH["batch"],
            "config_hash": BATCH["config_hash"],
        }
    )
    t0 = time.time()
    last_poll = 0.0
    while running:
        now = time.time()
        worked = False
        new_pool_events()
        if now >= last_poll + CFG["poll_s"]:
            poll_prices()
            check_triggers()
            check_exits()
            evict_watch()
            trim_samples()
            save_state()
            last_poll = now
            worked = True
            if not args_quiet:
                closed = state["closed"]
                print(
                    f"[{now_iso()[:19]}] watch={len(state['watchlist'])} open={len(state['positions'])} "
                    f"entries={state['entries']} closed={closed} "
                    + (
                        f"mean_ret={100 * state['sum_ret'] / closed:+.1f}% win_rate={100 * state['wins'] / closed:.0f}%"
                        if closed
                        else ""
                    ),
                    flush=True,
                )
        if args.duration and now - t0 >= args.duration:
            print(f"duration reached, stopping. closed={state['closed']}", flush=True)
            break
        if not worked:
            time.sleep(2)
    save_state()
    return 0


if __name__ == "__main__":
    sys.exit(main())
