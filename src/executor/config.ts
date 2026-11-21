// Executor config: strategy params from data/signals/strategy_config.json
// (single source of truth, shared with the Python shadow loop), batch info
// from batch_state.json, LIVE gating from env (fail-closed to paper mode).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { StrategyCfg, BatchInfo } from './types';

const ROOT = path.resolve(__dirname, '..', '..');
export const SIGNALS_DIR = path.join(ROOT, 'data', 'signals');
export const EVENTS_PATH = path.join(SIGNALS_DIR, 'events_v2.jsonl');
export const PAPER_TRADES_PATH = path.join(SIGNALS_DIR, 'executor_paper.jsonl');
export const EXECUTOR_STATE_PATH = path.join(SIGNALS_DIR, 'executor_state.json');
export const STRATEGY_CONFIG_PATH = path.join(SIGNALS_DIR, 'strategy_config.json');
export const BATCH_STATE_PATH = path.join(SIGNALS_DIR, 'batch_state.json');

// Runtime files are ignored by Git and created locally when needed.
fs.mkdirSync(SIGNALS_DIR, { recursive: true });

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const GT_MULTI = 'https://api.geckoterminal.com/api/v2/networks/solana/pools/multi/';
export const JUPITER_API_BASE = process.env.JUPITER_API_BASE || 'https://lite-api.jup.ag/swap/v1';
export const JITO_BLOCK_ENGINE = process.env.JITO_BLOCK_ENGINE || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
export const JITO_TIP_ACCOUNTS_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_accounts';

// Defaults used when strategy_config.json is absent.
export const DEFAULTS: StrategyCfg = {
    gate_min_liq: 15000,
    gate_max_bb_ratio: 3.0,
    gate_max_sell_pressure: 0.3,
    mom_threshold: 0.15,
    mom_lookback_s: 300,
    entry_slip_model: 0.03,
    stop_loss: -0.30,
    trail: 0.25,
    timeout_s: 900,
    watch_cap: 20,
    watch_evict_s: 2700,
    poll_s: 90,
    // 'model' applies entry_slip_model; 'quote' uses a real fill quote.
    entry_fill_mode: 'model',
    probe_stake_sol: 0.01,
    guard_max_quote_divergence: 0.20,
    // Price ceiling on the momentum reference price (0 = off).
    max_ref_price: 0,
};

export interface ExecutorConfig {
    cfg: StrategyCfg;
    batch: BatchInfo;
    live: boolean;
    liveReasonIfOff: string;
    privateKey: string | null;
}

export function loadExecutorConfig(confirmLiveFlag: boolean): ExecutorConfig {
    const cfg: StrategyCfg = { ...DEFAULTS };
    try {
        const loaded = JSON.parse(fs.readFileSync(STRATEGY_CONFIG_PATH, 'utf8'));
        for (const k of Object.keys(DEFAULTS) as (keyof StrategyCfg)[]) {
            if (k in loaded) (cfg as unknown as Record<string, unknown>)[k] = loaded[k];
        }
    } catch { /* fail-open to validated defaults */ }
    cfg.config_hash = crypto.createHash('sha1')
        .update(JSON.stringify(cfg))
        .digest('hex')
        .slice(0, 12);

    let batch: BatchInfo = { batch: 1, config_hash: cfg.config_hash! };
    try {
        const b = JSON.parse(fs.readFileSync(BATCH_STATE_PATH, 'utf8'));
        batch = { batch: b.batch ?? 1, config_hash: b.config_hash || cfg.config_hash! };
    } catch { /* fail-open */ }

    const privateKey = process.env.PRIVATE_KEY || null;
    const wantLive = (process.env.LIVE || 'false').toLowerCase() === 'true';
    let live = false;
    let liveReasonIfOff = '';
    if (!wantLive) liveReasonIfOff = 'LIVE env is not "true" (paper mode)';
    else if (!privateKey) { liveReasonIfOff = 'LIVE=true but PRIVATE_KEY is not set'; }
    else if (!confirmLiveFlag) { liveReasonIfOff = 'LIVE=true but --confirm-live flag missing (triple gate)'; }
    else live = true;
    if (live) {
        // Final fail-closed check: never live unless RPC endpoint is configured.
        if (!process.env.HELIUS_RPC_URL) {
            live = false;
            liveReasonIfOff = 'LIVE requested but HELIUS_RPC_URL missing';
        }
    }

    return { cfg, batch, live, liveReasonIfOff, privateKey };
}
