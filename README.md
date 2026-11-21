# Solana Memecoin Trading Bot

A TypeScript and Python bot that watches new Solana memecoin pools, scores momentum, and can execute trades through Jupiter or directly through PumpSwap. It also includes a paper-only pump.fun curve runner and a local read-only dashboard.

Paper mode is the default. Research, historical results, wallet lists, private keys, and runtime data are not included in this repository.

## Requirements

- Node.js and npm
- Python 3 and [uv](https://docs.astral.sh/uv/)
- A Solana RPC URL, normally Helius
- A public wallet address for swap simulation and the dashboard wallet card

The operational Python scripts use only the standard library. No Python packages need to be installed.

## Setup

Install the Node dependencies:

```bash
npm install
npm install --prefix dashboard
cp .env.example .env
```

Edit `.env` and set at least:

```text
HELIUS_RPC_URL=your_rpc_url
WALLET_PUBKEY=your_public_wallet_address
LIVE=false
```

`PRIVATE_KEY` is not needed for paper mode. `EXEC_BROKER` can be `pumpswap` for direct PumpSwap execution or `jupiter` for the Jupiter and Jito path.

The executor uses built-in strategy defaults. To change them, create `data/signals/strategy_config.json` from the example:

```bash
mkdir -p data/signals
cp strategy_config.example.json data/signals/strategy_config.json
```

That file, the batch state, and all generated data are ignored by Git.

## Run

### Main executor

```bash
npm start
```

This starts in paper mode. The runner reads new-pool events, maintains a watchlist, checks momentum and audits, and logs hypothetical entries and exits.

A read-only broker check is also available:

```bash
npm start -- --selftest
```

The selftest requests a quote but does not submit a transaction. `SELFTEST_MINT` can override the token used for that check.

### Curve paper executor

```bash
npm run start:curve -- --ticks 4
```

The curve runner is always paper-only and refuses `LIVE=true`. It requires `HELIUS_RPC_URL` and `WALLET_PUBKEY`, but not `PRIVATE_KEY`. Quotes and swap simulations do not sign or submit transactions.

### Dashboard

```bash
npm run start:dashboard
```

Open `http://localhost:5300`. The dashboard only binds to `127.0.0.1` by default. Set `DASHBOARD_HOST=0.0.0.0` only if you deliberately need remote access on a trusted network.

With no runtime files, the dashboard shows empty and zero states.

### Python pipeline

Run these in separate terminals when you want continuous signal collection and paper scoring:

```bash
npm run start:recorder  # Collect launches, pools, and enrichment
npm run start:shadow    # Run the log-only shadow strategy
npm run start:pipeline  # Score outcomes and refresh reports periodically
```

The pipeline defaults to a six-hour scoring cycle. The individual scripts can also be run directly with `uv run --no-project python scripts/<name>.py`.

Batch utilities are available with:

```bash
uv run --no-project python scripts/batch_tools.py --list
```

## Code walkthrough

### 1. Signal recording

`scripts/signal_recorder_v2.py` combines pump.fun launch data, GeckoTerminal pool discovery, and optional RPC enrichment.

It appends launch, curve, graduation, pool, and enrichment events to `data/signals/events_v2.jsonl`. Its resumable state is stored in `recorder_v2_state.json`.

### 2. Scoring and reports

`scripts/pipeline_loop.py` runs the scoring jobs on a schedule:

- Backfill missing candle paths
- Score the gated pool universe
- Score a smaller mid-tier sample
- Refresh lift and trigger reports

`scripts/scorer_v2.py` fetches historical OHLCV data and records forward outcomes without changing live positions. `scripts/lift_analysis.py` and `scripts/trigger_study.py` generate the report text used by the dashboard.

### 3. Shadow strategy

`scripts/shadow_trade_loop.py` is the Python log-only strategy. It follows the same basic path as the TypeScript executor:

1. Filter new pools by liquidity and trading activity.
2. Add accepted pools to a capped watchlist.
3. Poll prices and look for momentum over the configured lookback.
4. Model an entry and track stop-loss, trailing, and timeout exits.
5. Append entries and exits to `shadow_trades.jsonl`.

No orders are submitted by this script.

### 4. TypeScript executor

`src/executor_entry.ts` loads strategy and live-gate settings, selects a broker, and starts `ExecutorRunner`.

`src/executor/runner.ts` performs the main cycle:

1. Read new pool events.
2. Apply liquidity and activity gates.
3. Update watchlist and position prices.
4. Check the momentum trigger.
5. Run holder and drain audits.
6. Compare the trigger with an executable quote.
7. Book a paper entry or use the live broker.
8. Track exits and retry live sells when needed.

`src/executor/state_machine.ts` contains the trigger and exit decisions. `src/executor/feeds.ts` handles event-tail reading and multi-pool price requests.

### 5. Brokers

`src/executor/live_broker.ts` uses Jupiter for quotes and swap construction, with Jito bundle submission and a plain-RPC fallback.

`src/executor/pumpswap_broker.ts` talks directly to PumpSwap v2 pools. It estimates output from current reserves, builds the swap instructions, wraps SOL only for the swap, and waits for on-chain confirmation.

`src/executor/curve_broker.ts` handles pump.fun bonding-curve accounts and recent-trade account templates. Missing or inconsistent templates fail closed.

The protocol schema used by the PumpSwap implementation is included as `src/executor/pump_amm_idl.json`.

### 6. Holder and drain checks

`src/executor/rug_audit.ts` checks top-holder and top-10 concentration, similar-share clusters, and identical wallet balances. Pool and bonding-curve vaults are excluded so their unsold supply is not counted as a private holder.

`src/executor/drain_audit.ts` logs pool-drain features without blocking entries. It records reference price, momentum, liquidity, holder clusters, and the real SOL share of the pool.

These checks are heuristics, not a guarantee that a token is safe.

### 7. Curve paper runner

`src/curve/curve_feed.ts` reads bonding-curve accounts, applies age, progress, market-cap, and parameter gates, and detects momentum.

`src/curve/curve_executor.ts` requires a successful holder audit, matching Jupiter and curve quotes, and a green swap simulation before booking a paper position. Exits use executable sell quotes.

`src/curve/curve_executor_entry.ts` wires the runner and refuses live mode.

### 8. Dashboard

`dashboard/server.js` reads local runtime files and exposes a small JSON API. It does not place trades.

The main API groups are:

- `/api/stats`: active batch and summary
- `/api/shadow/live` and `/api/shadow/trades`: shadow positions and exits
- `/api/batches` and `/api/batches/perf`: batch summaries and paper equity
- `/api/executor/stats` and `/api/executor/live`: executor statistics and positions
- `/api/curve`: curve positions, exits, and feed health
- `/api/pipeline` and `/api/health`: recorder and pipeline health
- `/api/wallet`: configured wallet balance, when RPC and public key are present
- `/api/research`: trigger and outcome summaries derived from local reports

`dashboard/public/index.html` renders the data. Short-lived caches and ETags avoid repeatedly reading unchanged files.

### 9. Configuration batches

`scripts/batch_tools.py` manages the active batch and its configuration hash. New batches can be created, activated, analyzed, and given a verdict.

Batch state and the configuration change log are local data. They are not included as historical results in the public project.

## Runtime files

All runtime data lives under `data/` and is ignored by Git.

| File | Purpose |
| --- | --- |
| `data/signals/events_v2.jsonl` | Recorded launches, pools, and enrichment |
| `data/signals/recorder_v2_state.json` | Recorder offsets, watchlist, and queues |
| `data/signals/scored_v2.jsonl` | Forward outcome scores |
| `data/signals/candles_v2.jsonl` | Candle paths used by scoring |
| `data/signals/shadow_trades.jsonl` | Python shadow entries and exits |
| `data/signals/shadow_state.json` | Resumable shadow state |
| `data/signals/executor_paper.jsonl` | TypeScript executor events |
| `data/signals/executor_state.json` | Executor watchlist and positions |
| `data/signals/curve_feed.jsonl` | Curve feed events |
| `data/signals/curve_state.json` | Curve watchlist state |
| `data/signals/curve_paper.jsonl` | Curve paper entries and exits |
| `data/signals/curve_positions.json` | Open and closed curve positions |
| `data/signals/curve_templates.json` | Cached curve account templates |
| `data/signals/strategy_config.json` | Local strategy overrides |
| `data/signals/batch_state.json` | Active configuration batch |
| `data/signals/config_change_log.json` | Local batch decisions |
| `data/signals/reports/` | Generated lift and trigger reports |

## Main files

- `src/executor_entry.ts`: main executor entrypoint
- `src/executor/config.ts`: paths, endpoints, defaults, and live gates
- `src/executor/runner.ts`: executor cycle and position management
- `src/executor/state_machine.ts`: trigger and exit decisions
- `src/executor/live_broker.ts`: Jupiter and Jito broker
- `src/executor/pumpswap_broker.ts`: direct PumpSwap broker
- `src/executor/curve_broker.ts`: pump.fun curve broker
- `src/executor/rug_audit.ts`: holder checks
- `src/executor/drain_audit.ts`: pool-drain features
- `src/curve/`: curve feed, types, and paper executor
- `scripts/`: operational Python recorder, scorer, shadow loop, reports, and batch tools
- `dashboard/`: read-only dashboard server and UI

## Live trading

Live mode has three gates:

1. `LIVE=true` in `.env`
2. `PRIVATE_KEY` set in `.env`
3. `--confirm-live` passed explicitly

```bash
LIVE=true PRIVATE_KEY=your_private_key npm start -- --confirm-live
```

Live execution uses real funds and real fees. Test with paper mode and small amounts first. The runner includes balance checks, quote-divergence rejection, failed-buy pausing, and sell retries, but those safeguards cannot remove market or smart-contract risk.

## Verification

```bash
npm run typecheck
npm run build
uv run python -m compileall -q scripts
node --check dashboard/server.js
```

All runtime JSON, JSONL, logs, credentials, research, historical documents, and private configuration are ignored by Git.
