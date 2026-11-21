// Curve-phase signal types — bonding-curve venue (pump.fun pre-migration).
// Timestamp convention: every ts_us field is epoch MICROSECONDS
// (Date.now() * 1000); reserve fields are raw on-chain u64s as Numbers
// (lamports on the SOL side, 6-decimal raw on the token side).

export interface CurveWatchItem {
    mint: string;
    t_listed: number;                  // ts_us of the launch event that introduced the mint
    samples: [number, number][];       // [ts_us, price_sol_per_token], appended unfiltered
    vTok: number;                      // virtual_token_reserves (raw, 6-dec)
    vSol: number;                      // virtual_sol_reserves (lamports)
    rTok: number;                      // real_token_reserves (raw, 6-dec)
    rSol: number;                      // real_sol_reserves (lamports)
    complete: boolean;                 // byte 48 of the curve account
    last_state_ts: number;             // ts_us of the last curve-account read
    std_params: boolean;               // supply==1e15 && K within 5% of 3.219e25
}

export interface CurveSnapshot {
    mint: string;
    ts: number;                        // ts_us sampling time
    price: number;                     // SOL per ui token, marginal vSol/vTok
    mc_usd: number;                    // price * supply_tokens * sol_usd
    progress_pct: number;              // rSol / 85.005 SOL * 100 (std math)
    complete: boolean;
    // state extras populated by snapshotCurves; the age gate requires
    // t_listed_us and the std gate requires std_params (fail-closed without them)
    t_listed_us?: number;
    vTok?: number;
    vSol?: number;
    rTok?: number;
    rSol?: number;
    std_params?: boolean;
}

export interface CurveGateCfg {
    min_age_s: number;                 // CURVE_MIN_AGE_S (skip block-0 chaos)
    max_age_s: number;                 // CURVE_MAX_AGE_S (curve-phase window)
    min_progress_pct: number;          // CURVE_MIN_PROGRESS_PCT (skip brand-empty)
    max_progress_pct: number;         // CURVE_MAX_PROGRESS_PCT (too close to graduation)
    min_mc_usd: number;                // CURVE_MIN_MC_USD
    max_mc_usd: number;                // CURVE_MAX_MC_USD
    watch_cap: number;                 // CURVE_WATCH_CAP
    mom_pct: number;                   // CURVE_MOM_PCT
    mom_lookback_s: number;            // CURVE_MOM_LOOKBACK_S
}

export interface NewMint {
    mint: string;
    ts: number;                        // ts_us of the new_pool event
    mcap_usd: number | null;           // payload market cap when present
    liq_usd: number | null;            // pool liquidity when present
}

export type CurveEventKind = 'gated' | 'evicted' | 'graduated' | 'trigger';

export interface CurveFeedEvent {
    ts: string;                        // ISO wall clock of the event
    kind: CurveEventKind;
    mint: string;
    price?: number;
    mc_usd?: number;
    progress_pct?: number;
    reason?: string;
    [key: string]: unknown;
}

export interface CurveFeedState {
    watchlist: Record<string, CurveWatchItem>;
    saved_at: string;
}
