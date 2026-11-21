// Executor types — mirrors the shadow-loop state model exactly.

export interface StrategyCfg {
    gate_min_liq: number;
    gate_max_bb_ratio: number;
    gate_max_sell_pressure: number;
    mom_threshold: number;
    mom_lookback_s: number;
    entry_slip_model: number;
    stop_loss: number;
    trail: number;
    timeout_s: number;
    watch_cap: number;
    watch_evict_s: number;
    poll_s: number;
    // Fill-probe semantics (executor-only; the Python shadow loop ignores
    // unknown keys, so this file stays the single source of truth).
    entry_fill_mode?: 'model' | 'quote';
    probe_stake_sol?: number;
    // Stale-feed guard: reject live entries when the Jupiter quote's implied
    // price diverges from the GT-polled trigger price by more than this.
    guard_max_quote_divergence?: number;
    // Optional ceiling on the momentum reference price. 0 disables it.
    max_ref_price?: number;
    config_hash?: string;
}

export interface BatchInfo {
    batch: number;
    config_hash: string;
}

export interface WatchItem {
    mint: string;
    pool: string;
    liq: number;
    buyers: number;
    buys: number;
    sells: number;
    t_listed: number;
    samples: [number, number][];
}

export interface Position {
    mint: string;
    pool: string;
    entry: number;
    trigger_price: number;
    t_entry: number;
    peak: number;
    liq: number;
    entry_batch?: number;
    invalid_reason?: string;
    sell_pending?: { reason: string; ret: number; held_s: number; exit_price: number; attempts: number };
    samples: [number, number][];
}

export interface ExecutorState {
    offset: number | null;
    watchlist: Record<string, WatchItem>;
    positions: Record<string, Position>;
    closed: number;
    sum_ret: number;
    wins: number;
    entries: number;
}

export type ExitReason = 'sl' | 'trail' | 'timeout';

export interface TradeEvent {
    event: 'gated' | 'entry' | 'entry_live_failed' | 'entry_paper_failed' | 'exit' | 'expired' | 'batch_started' | 'live_paused';
    ts?: string;
    batch?: number;
    config_hash?: string;
    [key: string]: unknown;
}
