#!/usr/bin/env python3
"""Pipeline supervisor: keeps scoring current, forever.

Each cycle (default 6h):
  1. backfill candle paths for scored rows missing them
  2. score the gated universe (min-liq 15000): new scores auto-save paths
  3. small mid-tier audit sample (min-liq 5000)
  4. regenerate lift + trigger reports into data/signals/reports/

Single process = single GeckoTerminal consumer, no contention.
Does NOT touch the recorder (that stays under your ownership).

Run: uv run --no-project python scripts/pipeline_loop.py [--cycle-min 120]
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
REPORTS = ROOT / "data" / "signals" / "reports"


def run_scorer(cmd):
    print(f">>> scorer_v2.py {' '.join(cmd)}", flush=True)
    subprocess.run([sys.executable, str(SCRIPTS / "scorer_v2.py")] + cmd, check=False)


def write_report(script, name):
    out = subprocess.run(
        [sys.executable, str(SCRIPTS / script)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    (REPORTS / name).write_text(out.stdout or "", encoding="utf-8")
    print(f"report written: {name} ({len(out.stdout or '')} chars)", flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--cycle-min", type=int, default=360)
    args = p.parse_args()
    print(f"pipeline supervisor starting, cycle={args.cycle_min} min", flush=True)
    while True:
        t0 = time.time()
        REPORTS.mkdir(parents=True, exist_ok=True)
        run_scorer(["--backfill", "--max", "40", "--interval", "30"])
        run_scorer(["--min-liq", "15000", "--max", "40", "--interval", "30"])
        run_scorer(["--min-liq", "5000", "--max", "10", "--interval", "30"])
        write_report("lift_analysis.py", "lift_report.txt")
        write_report("trigger_study.py", "trigger_report.txt")
        wait = max(0, args.cycle_min * 60 - (time.time() - t0))
        print(
            f"cycle done in {(time.time() - t0) / 60:.0f} min, sleeping {wait / 60:.0f} min",
            flush=True,
        )
        time.sleep(wait)


if __name__ == "__main__":
    raise SystemExit(main())
