// State machine for gate -> watchlist -> momentum entry -> position exit.
// Stop-loss, trailing, and timeout checks run in that order.
import { StrategyCfg, WatchItem, Position, ExecutorState, ExitReason } from './types';

export interface EntryDecision {
    mint: string;
    triggerPrice: number;
    momRef: number;
    entryModeled: number;
}

export interface ExitDecision {
    mint: string;
    reason: ExitReason;
    exitPrice: number;
    ret: number;
    heldS: number;
    peakMultiple: number;
    peakPrice: number;
    entryModeled: number;
}

export function passesGate(
    cfg: StrategyCfg,
    liq: number,
    buyers: number,
    buys: number,
    sells: number
): boolean {
    const bb = buys / Math.max(1, buyers);
    const sp = sells / Math.max(1, buys);
    return liq >= cfg.gate_min_liq && bb <= cfg.gate_max_bb_ratio && sp <= cfg.gate_max_sell_pressure;
}

// Price is accepted unless it's a >20x jump vs the last sample (glitch guard).
export function acceptSample(samples: [number, number][], price: number): boolean {
    if (!samples.length) return true;
    const last = samples[samples.length - 1][1];
    return !(price > last * 20 || price < last / 20);
}

// Price ceiling on the momentum reference price (0 = off). The reference
// price is the token's price one lookback ago, so this rejects tokens that
// were already expensive before the momentum window started.
export function priceCapOk(cfg: StrategyCfg, refPrice: number): boolean {
    const cap = cfg.max_ref_price ?? 0;
    if (cap <= 0) return true;
    return refPrice <= cap;
}

export function checkTrigger(cfg: StrategyCfg, now: number, w: WatchItem): EntryDecision | null {
    const s = w.samples;
    if (s.length < 5) return null;
    let ref: number | null = null;
    for (let i = s.length - 1; i >= 0; i--) {
        const age = now - s[i][0];
        if (age >= cfg.mom_lookback_s) {
            // Reference-age guard: a momentum reference older than 3x the
            // lookback is a stale carry (loop downtime), not a 5-minute
            // signal. Invalid — never fire on it.
            if (age > 3 * cfg.mom_lookback_s) break;
            ref = s[i][1];
            break;
        }
    }
    if (ref === null) return null;
    const latest = s[s.length - 1][1];
    if (latest / ref - 1 >= cfg.mom_threshold) {
        return {
            mint: w.mint,
            triggerPrice: latest,
            momRef: ref,
            entryModeled: latest * (1 + cfg.entry_slip_model),
        };
    }
    return null;
}

export function checkExit(cfg: StrategyCfg, now: number, p: Position): ExitDecision | null {
    if (!p.samples.length) return null;
    const price = p.samples[p.samples.length - 1][1];
    p.peak = Math.max(p.peak, price);
    let reason: ExitReason | null = null;
    let ret = 0;
    if (price <= p.entry * (1 + cfg.stop_loss)) {
        reason = 'sl';
        // Use the actual sampled price for the return.
        ret = price / p.entry - 1;
    } else if (price <= p.peak * (1 - cfg.trail)) {
        reason = 'trail';
        ret = price / p.entry - 1;
    } else if (now - p.t_entry >= cfg.timeout_s) {
        reason = 'timeout';
        ret = price / p.entry - 1;
    }
    if (!reason) return null;
    return {
        mint: p.mint,
        reason,
        exitPrice: price,
        ret,
        heldS: Math.round(now - p.t_entry),
        peakMultiple: p.peak / p.entry,
        peakPrice: p.peak,
        entryModeled: p.entry,
    };
}

export function evictWatchlist(cfg: StrategyCfg, now: number, state: ExecutorState): string[] {
    const expired: string[] = [];
    for (const [mint, w] of Object.entries(state.watchlist)) {
        if (now - w.t_listed > cfg.watch_evict_s) expired.push(mint);
    }
    for (const mint of expired) delete state.watchlist[mint];
    const keys = Object.keys(state.watchlist);
    if (keys.length > cfg.watch_cap) {
        let worst: string | null = null;
        let worstLiq = Infinity;
        for (const [mint, w] of Object.entries(state.watchlist)) {
            if (w.liq < worstLiq) {
                worstLiq = w.liq;
                worst = mint;
            }
        }
        if (worst) {
            delete state.watchlist[worst];
            expired.push(worst);
        }
    }
    return expired;
}

export function trimSamples(state: ExecutorState, cutoff: number): void {
    for (const store of [state.watchlist, state.positions] as Record<string, WatchItem | Position>[]) {
        for (const item of Object.values(store)) {
            item.samples = item.samples.filter((s) => s[0] >= cutoff);
        }
    }
}
