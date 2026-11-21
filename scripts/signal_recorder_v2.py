#!/usr/bin/env python3
"""Signal recorder v2: fully free signal capture (no SolanaTracker credits).

Sources:
  launch + curve   pump.fun frontend REST API (undocumented, polite polling,
                   self-healing backoff on 429; lossless payloads)
  pool             GeckoTerminal public API (new Solana DEX pools = migrations)
  enrichment       Helius RPC (own key): mint/freeze authority + holder
                   concentration checks on migrated tokens

Feeds emitted to data/signals/events_v2.jsonl:
  launch       first sighting of a new bonding-curve token
  curve        watchlist progress updates (delta >= 5 points)
  graduated    bonding curve completed (complete=true or pumpswap pool seen)
  pool         any new Solana DEX pool (raw, analysis filters by dex later)
  enrichment   on-chain risk snapshot for graduated/migrated mints
  curve_stale  watchlist entry evicted after 72h without graduating

Run: uv run --no-project python scripts/signal_recorder_v2.py
     [--once] [--duration SECONDS] [--watch-cap N] [--quiet]
"""

import argparse
import atexit
import base64
import json
import os
import signal
import struct
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "signals"
EVENTS_PATH = DATA_DIR / "events_v2.jsonl"
STATE_PATH = DATA_DIR / "recorder_v2_state.json"

PF_BASE = "https://frontend-api-v3.pump.fun"
PF_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://pump.fun",
    "Referer": "https://pump.fun/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
}
GT_NEW_POOLS = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools"

LAUNCH_CADENCE_S = 60
POOL_CADENCE_S = 60
CURVE_CYCLE_S = 45
CURVE_POLLS_PER_CYCLE = 6
ENRICH_INTERVAL_S = 5
ENRICH_MIN_LIQ_USD = 10000
WATCH_JOIN_PCT = 70.0
WATCH_EVICT_H = 72
SEEN_PRUNE_H = 48
STATE_SAVE_S = 60

MINT_KEY_CANDIDATES = ("mint", "mint_address", "tokenAddress")

running = True
state = {
    "month": datetime.now(timezone.utc).strftime("%Y-%m"),
    "events_logged": 0,
    "pf_calls": 0,
    "gt_calls": 0,
    "rpc_calls": 0,
    "pf_backoff_until": 0.0,
    "pf_backoff_s": 300,
    "mint_key": None,
    "launches_seen": {},
    "watchlist": {},
    "pools_seen": {},
    "enriched": {},
    "enrich_queue": [],
}
args = None


def load_env():
    url = os.environ.get("HELIUS_RPC_URL", "")
    env_path = ROOT / ".env"
    if not url and env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("HELIUS_RPC_URL="):
                url = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
    if not url:
        raise SystemExit("Set HELIUS_RPC_URL in the environment or .env")
    return url


HELIUS_URL = ""


def save_state():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state), encoding="utf-8")


def load_state():
    if STATE_PATH.exists():
        try:
            loaded = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            state.update(loaded)
        except (ValueError, OSError):
            pass
    q = state.get("enrich_queue") or []
    state["enrich_queue"] = [
        m[len("solana_") :] if m.startswith("solana_") else m for m in q
    ]


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def log_event(evt):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    evt["ts"] = now_iso()
    with EVENTS_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(evt, separators=(",", ":")) + "\n")
    state["events_logged"] += 1


def http_json(url, headers=None, timeout=25):
    req = urllib.request.Request(
        url,
        headers=headers or {"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def pf_get(path):
    global state
    if time.time() < state["pf_backoff_until"]:
        raise Backoff()
    try:
        out = http_json(PF_BASE + path, headers=PF_HEADERS)
        state["pf_calls"] += 1
        state["pf_backoff_s"] = 300
        return out
    except urllib.error.HTTPError as e:
        if e.code in (429, 403):
            state["pf_backoff_until"] = time.time() + state["pf_backoff_s"]
            state["pf_backoff_s"] = min(state["pf_backoff_s"] * 2, 3600)
            raise Backoff()
        raise


class Backoff(Exception):
    pass


def gt_get(url):
    state["gt_calls"] += 1
    try:
        return http_json(url)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            time.sleep(45)
            return http_json(url)
        raise


def rpc(method, params):
    state["rpc_calls"] += 1
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    ).encode()
    req = urllib.request.Request(
        HELIUS_URL, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.loads(r.read().decode("utf-8"))
    if "error" in out:
        raise RuntimeError(out["error"].get("message", str(out["error"])))
    return out["result"]


def mint_of(coin):
    for k in MINT_KEY_CANDIDATES:
        if isinstance(coin.get(k), str) and len(coin[k]) > 30:
            return k, coin[k]
    return None, None


def poll_launches(sort):
    coins = pf_get(f"/coins?sort={sort}&order=DESC&offset=0&limit=50&includeNsfw=false")
    if args and not state["mint_key"]:
        for c in coins:
            k, _ = mint_of(c)
            if k:
                state["mint_key"] = k
                break
    fresh = 0
    for c in coins:
        k, mint = mint_of(c)
        if not mint:
            continue
        if sort == "created_timestamp":
            if mint in state["launches_seen"]:
                update_watch(c, mint)
                continue
            state["launches_seen"][mint] = time.time()
            fresh += 1
            log_event(
                {
                    "feed": "launch",
                    "event": "first_seen",
                    "mint": mint,
                    "symbol": c.get("symbol"),
                    "name": c.get("name"),
                    "payload": c,
                }
            )
            update_watch(c, mint)
        elif not c.get("complete"):
            update_watch(c, mint)
    return fresh, len(coins)


def update_watch(coin, mint):
    if coin.get("complete"):
        graduate(mint, coin, source="launch_feed")
        return
    prog = coin.get("bonding_curve_progress") or 0
    w = state["watchlist"].get(mint)
    if prog >= WATCH_JOIN_PCT:
        if w is None:
            state["watchlist"][mint] = {
                "prog": prog,
                "symbol": coin.get("symbol"),
                "added": time.time(),
                "last": 0.0,
            }
    elif w is not None:
        w["prog"] = prog


def poll_curve():
    if not state["mint_key"]:
        return 0, 0
    items = sorted(state["watchlist"].items(), key=lambda kv: -kv[1]["prog"])
    polls = done = 0
    for mint, w in items[:CURVE_POLLS_PER_CYCLE]:
        try:
            coin = pf_get(f"/coin/{mint}")
        except Backoff:
            break
        except Exception:
            continue
        polls += 1
        w["last"] = time.time()
        prog = coin.get("bonding_curve_progress") or 0
        if coin.get("complete"):
            graduate(mint, coin, source="curve_poll")
            done += 1
            continue
        w["prog"] = prog
        if abs(prog - w.get("last_logged", 0)) >= 5:
            w["last_logged"] = prog
            log_event(
                {
                    "feed": "curve",
                    "event": "progress",
                    "mint": mint,
                    "symbol": w.get("symbol"),
                    "progress": prog,
                    "mcap_usd": coin.get("usd_market_cap"),
                    "payload": coin,
                }
            )
    return polls, done


def graduate(mint, coin, source):
    if mint in state["watchlist"]:
        del state["watchlist"][mint]
    log_event(
        {
            "feed": "graduated",
            "event": "graduated",
            "mint": mint,
            "symbol": coin.get("symbol") if isinstance(coin, dict) else None,
            "source": source,
            "payload": coin,
        }
    )
    queue_enrich(mint)


def queue_enrich(mint):
    if mint in state["enriched"]:
        return
    q = state["enrich_queue"]
    if mint not in q:
        q.append(mint)


def poll_pools():
    fresh = pump = total = 0
    for page in (1, 2):
        data = gt_get(f"{GT_NEW_POOLS}?page={page}")
        pools = data.get("data") or []
        total += len(pools)
        for p in pools:
            a = p.get("attributes") or {}
            addr = a.get("address")
            if not addr or addr in state["pools_seen"]:
                continue
            state["pools_seen"][addr] = time.time()
            fresh += 1
            rel = p.get("relationships") or {}
            dex = ((rel.get("dex") or {}).get("data") or {}).get("id")
            base = ((rel.get("base_token") or {}).get("data") or {}).get("id")
            if base and base.startswith("solana_"):
                base = base[len("solana_") :]
            vol = a.get("volume_usd") or {}
            vol24 = float(vol.get("h24") or 0) if isinstance(vol, dict) else 0
            liq = float(a.get("reserve_in_usd") or 0)
            log_event(
                {
                    "feed": "pool",
                    "event": "new_pool",
                    "pool": addr,
                    "dex": dex,
                    "mint": base,
                    "name": a.get("name"),
                    "liq_usd": liq,
                    "vol24_usd": vol24,
                    "payload": p,
                }
            )
            if dex and "pump" in str(dex).lower() and base:
                pump += 1
                if base in state["watchlist"]:
                    graduate(base, {}, source="pool_feed")
                elif max(liq, vol24) >= ENRICH_MIN_LIQ_USD:
                    queue_enrich(base)
    return fresh, pump, total


def parse_mint_account(b64):
    raw = base64.b64decode(b64)
    mint_auth_opt = struct.unpack_from("<I", raw, 0)[0]
    freeze_auth_opt = struct.unpack_from("<I", raw, 46)[0]
    supply = struct.unpack_from("<Q", raw, 36)[0]
    return {
        "mint_authority_revoked": mint_auth_opt == 0,
        "freeze_authority_revoked": freeze_auth_opt == 0,
        "supply": supply,
        "decimals": raw[44] if len(raw) > 44 else None,
    }


def enrich_next():
    q = state["enrich_queue"]
    while q and q[0] in state["enriched"]:
        q.pop(0)
    if not q:
        return False
    mint = q.pop(0)
    try:
        acct = rpc("getAccountInfo", [mint, {"encoding": "base64"}])
        info = parse_mint_account(acct["value"]["data"][0]) if acct.get("value") else {}
        supply = rpc("getTokenSupply", [mint])
        largest = rpc("getTokenLargestAccounts", [mint])
    except Exception as e:
        fails = state.setdefault("enrich_fails", {})
        fails[mint] = fails.get(mint, 0) + 1
        if fails[mint] >= 3:
            del fails[mint]
            log_event(
                {
                    "feed": "enrichment",
                    "event": "failed",
                    "mint": mint,
                    "error": str(e)[:120],
                }
            )
            return True
        q.append(mint)
        raise RuntimeError(f"enrich rpc failed for {mint[:8]}: {e}")
    state["enriched"][mint] = time.time()
    sup_ui = float((supply.get("value") or {}).get("uiAmount") or 0)
    accts = largest.get("value") or []
    amounts = [float(a.get("uiAmount") or 0) for a in accts]
    top1 = 100 * amounts[0] / sup_ui if sup_ui else None
    top10 = 100 * sum(amounts[:10]) / sup_ui if sup_ui else None
    log_event(
        {
            "feed": "enrichment",
            "event": "onchain_snapshot",
            "mint": mint,
            "top1_pct": top1,
            "top10_pct": top10,
            "supply_ui": sup_ui,
            "accounts": [
                {"address": a.get("address"), "amount": amounts[i]}
                for i, a in enumerate(accts[:10])
            ],
            **info,
        }
    )
    return True


def evict_stale_watch():
    cutoff = time.time() - WATCH_EVICT_H * 3600
    for mint, w in list(state["watchlist"].items()):
        if w["added"] < cutoff:
            del state["watchlist"][mint]
            log_event(
                {
                    "feed": "curve_stale",
                    "event": "evicted",
                    "mint": mint,
                    "symbol": w.get("symbol"),
                    "progress": w.get("prog"),
                    "added": w["added"],
                }
            )


def prune_state():
    cutoff = time.time() - SEEN_PRUNE_H * 3600
    for store in ("launches_seen", "pools_seen", "enriched"):
        for k, t in list(state[store].items()):
            if t < cutoff:
                del state[store][k]


def summarize(last):
    if time.time() - last < STATE_SAVE_S:
        return last
    save_state()
    evict_stale_watch()
    prune_state()
    if not args or not args.quiet:
        bo = max(0, int(state["pf_backoff_until"] - time.time()))
        print(
            f"[{now_iso()}] events={state['events_logged']:,} pf={state['pf_calls']:,} "
            f"gt={state['gt_calls']:,} rpc={state['rpc_calls']:,} "
            f"watch={len(state['watchlist']):,} queue={len(state['enrich_queue']):,} "
            f"pf_backoff={bo}s",
            flush=True,
        )
    return time.time()


def main():
    global HELIUS_URL, args, running
    p = argparse.ArgumentParser()
    p.add_argument(
        "--once", action="store_true", help="one poll of each feed, then exit"
    )
    p.add_argument("--duration", type=int, default=0, help="auto-stop after N seconds")
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args()
    HELIUS_URL = load_env()
    load_state()

    def stop(*_):
        global running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, stop)
    atexit.register(save_state)

    started = time.time()
    next_due = {
        "launch": 0.0,
        "pools": 0.0,
        "curve": time.time() + CURVE_CYCLE_S,
        "enrich": 0.0,
    }
    last_summary = time.time()
    launch_cycle = 0
    print(f"Recorder v2 starting -> {EVENTS_PATH}", flush=True)

    while running:
        now = time.time()
        worked = False
        if now >= next_due["launch"]:
            sort = "created_timestamp" if launch_cycle % 2 == 0 else "market_cap"
            try:
                fresh, total = poll_launches(sort)
                worked = True
                print(
                    f"  launch poll [{sort}]: {fresh} new / {total} returned",
                    flush=True,
                )
            except Backoff:
                pass
            except Exception as e:
                print(f"  launch poll failed: {e}", flush=True)
            launch_cycle += 1
            next_due["launch"] = now + LAUNCH_CADENCE_S
        if now >= next_due["pools"]:
            try:
                fresh, pump, total = poll_pools()
                worked = True
                print(
                    f"  pool poll: {fresh} new / {total} returned ({pump} pump-origin)",
                    flush=True,
                )
            except Exception as e:
                print(f"  pool poll failed: {e}", flush=True)
            next_due["pools"] = now + POOL_CADENCE_S
        if now >= next_due["curve"]:
            try:
                polls, done = poll_curve()
                worked = True
                if polls:
                    print(
                        f"  curve poll: {polls} checked, {done} graduated", flush=True
                    )
            except Exception as e:
                print(f"  curve poll failed: {e}", flush=True)
            next_due["curve"] = now + CURVE_CYCLE_S
        if now >= next_due["enrich"]:
            try:
                enrich_next()
                worked = True
            except Backoff:
                pass
            except Exception as e:
                print(f"  enrich failed: {e}", flush=True)
                next_due["enrich"] = now + 30
                last_summary = summarize(last_summary)
                continue
            next_due["enrich"] = now + ENRICH_INTERVAL_S
        last_summary = summarize(last_summary)
        if args.once:
            pending = [
                k
                for k in ("launch", "pools", "curve")
                if next_due[k] > now
                and next_due[k]
                == now
                + (
                    {
                        "launch": LAUNCH_CADENCE_S,
                        "pools": POOL_CADENCE_S,
                        "curve": CURVE_CYCLE_S,
                    }[k]
                )
            ]
            pending = [
                k for k in ("launch", "pools", "curve") if not (next_due[k] > now)
            ]
            if not pending:
                save_state()
                print("Single pass complete.", flush=True)
                break
        if args.duration and time.time() - started >= args.duration:
            print(f"Duration {args.duration}s reached, stopping.", flush=True)
            break
        if not worked:
            time.sleep(1)

    save_state()
    print(
        f"Stopped. events={state['events_logged']:,} pf={state['pf_calls']:,} "
        f"gt={state['gt_calls']:,} rpc={state['rpc_calls']:,}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
