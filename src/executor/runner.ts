// Runs the executor's gate, trigger, entry, and exit cycle. Paper mode logs
// decisions without submitting transactions; live mode uses the gated broker.
import * as fs from 'fs';
import { ExecutorConfig, PAPER_TRADES_PATH, EXECUTOR_STATE_PATH } from './config';
import { EventTailer, pollMultiPool, PoolEvent } from './feeds';
import { WatchItem, Position, ExecutorState, TradeEvent } from './types';
import { passesGate, acceptSample, checkTrigger, checkExit, evictWatchlist, trimSamples, priceCapOk } from './state_machine';
import { rugAudit, RugAuditResult } from './rug_audit';
import { drainAudit } from './drain_audit';
import { QuoteResult } from './live_broker';

// The broker surface the runner depends on — LiveBroker (Jupiter+Jito) and
// PumpSwapBroker (direct pAMM) both satisfy it.
export interface Broker {
    readonly isEnabled: boolean;
    readonly walletPubkey: string | null;
    lastError: string | null;
    getWalletBalance(): Promise<number>;
    getMintDecimals(mint: string): Promise<number | null>;
    getSolUsd(): Promise<number | null>;
    getTokenBalance(mint: string): Promise<number | null>;
    quoteBuy(mint: string, amountSol: number, slippageBps: number): Promise<QuoteResult | null>;
    buy(mint: string, amountSol: number, slippageBps: number, tipLamports: number): Promise<string | null>;
    sell(mint: string, tokenRawAmount: string, slippageBps: number, tipLamports: number): Promise<string | null>;
    // Honest exit sampler (direct brokers): marginal sell price from the
    // pool's own reserves. Optional — the Jupiter path falls back to GT.
    poolPrice?(mint: string): Promise<number | null>;
}

export class ExecutorRunner {
    private state: ExecutorState = {
        offset: null,
        watchlist: {},
        positions: {},
        closed: 0,
        sum_ret: 0,
        wins: 0,
        entries: 0,
    };
    private tailer: EventTailer;
    private liveFillCount = 0;
    // LIVE SAFETY STATE: balance guard + automated K5 (3 consecutive failed
    // live buys self-park the executor; manual rearm = restart).
    private livePaused = false;
    private consecutiveLiveFails = 0;

    constructor(private ecfg: ExecutorConfig, private broker: Broker, private quiet: boolean) {
        this.loadState();
        this.tailer = new EventTailer(this.state.offset);
    }

    private loadState(): void {
        try {
            const saved = JSON.parse(fs.readFileSync(EXECUTOR_STATE_PATH, 'utf8'));
            Object.assign(this.state, saved);
        } catch { /* fresh start */ }
    }

    private saveState(): void {
        this.state.offset = this.tailer.currentOffset;
        fs.writeFileSync(EXECUTOR_STATE_PATH, JSON.stringify(this.state));
    }

    private logEvt(evt: TradeEvent): void {
        if (!('ts' in evt)) {
            evt.ts = new Date().toISOString();
            if (!('batch' in evt)) {
                evt.batch = this.ecfg.batch.batch;
                evt.config_hash = this.ecfg.batch.config_hash;
            }
        }
        fs.appendFileSync(PAPER_TRADES_PATH, JSON.stringify(evt) + '\n');
    }

    private console(line: string): void {
        if (!this.quiet) console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    }

    private applyGate(e: PoolEvent): void {
        if (this.state.watchlist[e.mint] || this.state.positions[e.mint]) return;
        if (!passesGate(this.ecfg.cfg, e.liq, e.buyers, e.buys, e.sells)) return;
        this.state.watchlist[e.mint] = {
            mint: e.mint,
            pool: e.pool,
            liq: e.liq,
            buyers: e.buyers,
            buys: e.buys,
            sells: e.sells,
            t_listed: Date.now() / 1000,
            samples: [],
        };
        this.logEvt({
            event: 'gated', mint: e.mint, pool: e.pool, liq: e.liq,
            buyers: e.buyers, buys: e.buys, sells: e.sells,
        });
    }

    // Estimates the actual fill and slippage with a read-only quote.
    private async probeFill(mint: string, triggerPrice: number): Promise<Record<string, unknown> | null> {
        const stake = this.ecfg.cfg.probe_stake_sol ?? 0.01;
        try {
            const q = await this.broker.quoteBuy(mint, stake, 300);
            if (!q) {
                return { status: 'no-quote', reason: this.broker.lastError };
            }
            const decimals = await this.broker.getMintDecimals(mint);
            if (decimals === null) {
                return { status: 'no-decimals', out_raw: q.outAmountRaw };
            }
            const outTokens = Number(q.outAmountRaw) / 10 ** decimals;
            if (!(outTokens > 0)) {
                return { status: 'zero-out', out_raw: q.outAmountRaw };
            }
            const solUsd = await this.broker.getSolUsd();
            if (!solUsd) {
                return { status: 'no-sol-usd', out_raw: q.outAmountRaw };
            }
            const stakeUsd = stake * solUsd;
            const effectivePrice = stakeUsd / outTokens;
            return {
                status: 'ok',
                stake_sol: stake,
                sol_usd: Math.round(solUsd * 100) / 100,
                out_raw: q.outAmountRaw,
                out_tokens: outTokens,
                price_impact_pct: q.priceImpactPct,
                effective_price: effectivePrice,
                // positive = we pay MORE than the polled trigger price
                slip_vs_trigger: effectivePrice / triggerPrice - 1,
                route_venues: (q.quote.routePlan || []).map((r: any) => r?.swapInfo?.label || 'unknown'),
            };
        } catch (e: any) {
            return { status: 'probe-error', reason: e.message };
        }
    }

    private async onTrigger(w: WatchItem, now: number): Promise<void> {
        const d = checkTrigger(this.ecfg.cfg, now, w);
        if (!d) return;
        const pos: Position = {
            mint: w.mint,
            pool: w.pool,
            entry: d.entryModeled,
            trigger_price: d.triggerPrice,
            t_entry: now,
            peak: d.entryModeled,
            liq: w.liq,
            entry_batch: this.ecfg.batch.batch,
            samples: [[now, d.triggerPrice]],
        };
        delete this.state.watchlist[w.mint];
        this.state.positions[w.mint] = pos;
        this.state.entries += 1;

        const evt: TradeEvent = {
            event: 'entry',
            mint: w.mint,
            pool: w.pool,
            trigger_price: d.triggerPrice,
            entry_modeled: d.entryModeled,
            liq: w.liq,
            t_listed: w.t_listed,
            mom_ref: d.momRef,
        };
        evt.entry_source = 'model';

        // Rug checks are logged and a failure aborts before quoting.
        let audit: RugAuditResult | null = null;
        if ((process.env.RUG_AUDIT || 'on') !== 'off') {
            audit = await rugAudit(w.mint, w.pool);
            evt.rug_audit = audit;
        }

        // Drain features are logged only and never block a trade.
        if ((process.env.DRAIN_AUDIT || 'on') !== 'off') {
            try {
                const drain = await drainAudit(w.mint, w.pool, {
                    ref_price: d.momRef,
                    trigger_price: d.triggerPrice,
                    liq_usd: w.liq,
                    audit,
                });
                evt.drain_audit = drain;
            } catch (e: any) {
                evt.drain_audit = { status: 'unavailable', risk: 'elevated', score: 0, flags: [], features: {}, error: e?.message };
            }
        }

        if (audit && !audit.pass) {
            // Paper and live both reject failed audits.
            delete this.state.positions[w.mint];
            this.logEvt({
                ...evt,
                event: this.ecfg.live ? 'entry_live_failed' : 'entry_paper_failed',
                reason: 'rug-audit',
            });
            this.console(`entry ${w.mint.slice(0, 8)} REJECTED by rug-audit: ` +
                `${audit.reasons.join(', ')}`);
            return;
        }

        // Optional ceiling on the reference price before momentum began.
        const maxRefPrice = this.ecfg.cfg.max_ref_price ?? 0;
        if (!priceCapOk(this.ecfg.cfg, d.momRef)) {
            delete this.state.positions[w.mint];
            this.logEvt({
                ...evt,
                event: this.ecfg.live ? 'entry_live_failed' : 'entry_paper_failed',
                reason: 'price-cap',
            });
            this.console(`entry ${w.mint.slice(0, 8)} REJECTED by price-cap: ` +
                `ref ${d.momRef.toExponential(2)} > ${maxRefPrice.toExponential(2)}`);
            return;
        }

        // Batch 2 semantics: fill-conditional paper entries.
        if (!this.ecfg.live && this.ecfg.cfg.entry_fill_mode === 'quote') {
            const probe = await this.probeFill(w.mint, d.triggerPrice);
            evt.fill_probe = probe;
            if (probe && probe.status === 'ok') {
                // Reject quotes that disagree too much with the trigger.
                const slip = probe.slip_vs_trigger as number;
                const guard = this.ecfg.cfg.guard_max_quote_divergence ?? 0.20;
                if (Math.abs(slip) > guard) {
                    delete this.state.positions[w.mint];
                    this.logEvt({ ...evt, event: 'entry_paper_failed', reason: 'stale-feed-guard', fill_probe: probe });
                    this.console(`entry ${w.mint.slice(0, 8)} REJECTED by stale-feed guard ` +
                        `(paper mirrors live): quote ${(100 * slip).toFixed(1)}% off trigger (limit ±${(100 * guard).toFixed(0)}%)`);
                    return;
                }
                pos.entry = probe.effective_price as number;
                pos.peak = pos.entry;
                evt.entry_source = 'quote';
                evt.entry_fill_price = pos.entry;
                const slipPct = 100 * (probe.slip_vs_trigger as number);
                this.console(`entry ${w.mint.slice(0, 8)} QUOTE fill slip=${slipPct.toFixed(1)}% ` +
                    `impact=${probe.price_impact_pct}%`);
            } else {
                // No quote means no executable entry, including in paper.
                delete this.state.positions[w.mint];
                this.logEvt({ ...evt, event: 'entry_paper_failed', reason: 'no-quote', fill_probe: probe });
                this.console(`entry ${w.mint.slice(0, 8)} REJECTED: no quote (paper mirrors live)`);
                return;
            }
        }

        if (this.ecfg.live) {
            const STAKE_SOL = Number(process.env.DUST_STAKE_SOL || 0.01);
            const slippageBps = Number(process.env.LIVE_SLIPPAGE_BPS || 1000);
            // Keep enough SOL for the stake plus fees and rent.
            if (this.livePaused) {
                delete this.state.positions[w.mint];
                this.logEvt({ ...evt, event: 'entry_live_failed', reason: 'live-paused' });
                return;
            }
            const minWallet = STAKE_SOL + 0.003; // stake + fees/rent buffer
            const bal = await this.broker.getWalletBalance();
            if (bal < minWallet) {
                this.livePaused = true;
                this.logEvt({ event: 'live_paused', reason: 'wallet-below-minimum',
                    balance: bal, minimum: minWallet });
                this.console(`*** LIVE PAUSED: wallet ${bal.toFixed(4)} SOL below minimum ` +
                    `${minWallet.toFixed(4)} — self-parking to protect the remainder ***`);
                delete this.state.positions[w.mint];
                this.logEvt({ ...evt, event: 'entry_live_failed', reason: 'wallet-below-minimum' });
                return;
            }
            // Reject entries when the quote is too far from the trigger.
            const guard = this.ecfg.cfg.guard_max_quote_divergence ?? 0.20;
            const probe = await this.probeFill(w.mint, d.triggerPrice);
            evt.fill_probe = probe as any;
            if (!probe || probe.status !== 'ok') {
                delete this.state.positions[w.mint];
                this.logEvt({ ...evt, event: 'entry_live_failed', reason: 'no-quote', fill_probe: probe });
                this.console(`entry ${w.mint.slice(0, 8)} REJECTED: no route/quote`);
                return;
            }
            const slip = probe.slip_vs_trigger as number;
            if (Math.abs(slip) > guard) {
                delete this.state.positions[w.mint];
                this.logEvt({ ...evt, event: 'entry_live_failed', reason: 'stale-feed-guard', fill_probe: probe });
                this.console(`entry ${w.mint.slice(0, 8)} REJECTED by stale-feed guard: ` +
                    `quote ${(100 * slip).toFixed(1)}% off trigger (limit ±${(100 * guard).toFixed(0)}%)`);
                return;
            }
            const sig = await this.broker.buy(w.mint, STAKE_SOL, slippageBps, 0);
            evt.live = sig ? 'filled' : 'failed';
            evt.live_sig = sig || null;
            if (!sig) {
                // Fail-closed: no fill, no position. Log the would-be trade.
                delete this.state.positions[w.mint];
                // AUTOMATED K5: 3 consecutive failed live buys -> self-park.
                this.consecutiveLiveFails += 1;
                if (this.consecutiveLiveFails >= 3 && !this.livePaused) {
                    this.livePaused = true;
                    this.logEvt({ event: 'live_paused', reason: 'k5-three-consecutive-live-failures' });
                    this.console(`*** LIVE PAUSED (K5): 3 consecutive failed live buys — ` +
                        `manual rearm required (restart the executor) ***`);
                }
                this.logEvt({ ...evt, event: 'entry_live_failed' });
                this.console(`LIVE buy FAILED for ${w.mint.slice(0, 8)} (${this.broker.lastError})`);
                return;
            }
            this.consecutiveLiveFails = 0;
            this.liveFillCount += 1;
            (pos as any).bal_at_buy = bal; // for real-P&L accounting at exit
            evt.stake_sol = STAKE_SOL;
            this.console(`LIVE buy filled ${w.mint.slice(0, 8)} sig=${sig.slice(0, 12)}…`);
        }
        this.logEvt(evt);
        this.console(`entry ${w.mint.slice(0, 8)} trigger=${d.triggerPrice.toExponential(3)}`);
    }

    private async onExit(p: Position, now: number): Promise<void> {
        // Stale position: dead pool (no price feed), beyond timeout — close
        // as 'stale' with unknown outcome instead of carrying it forever.
        if (!p.samples.length && now - p.t_entry >= this.ecfg.cfg.timeout_s) {
            delete this.state.positions[p.mint];
            this.state.closed += 1;
            this.logEvt({
                event: 'exit',
                batch: p.entry_batch ?? this.ecfg.batch.batch,
                mint: p.mint,
                pool: p.pool,
                reason: 'stale',
                entry_modeled: p.entry,
                exit_price: null,
                peak_price: p.peak,
                return: 0,
                held_s: Math.round(now - p.t_entry),
                peak_multiple: p.peak / p.entry,
            });
            this.console(`exit ${p.mint.slice(0, 8)} reason=stale (dead pool, unknown outcome)`);
            return;
        }
        const d = checkExit(this.ecfg.cfg, now, p);
        if (!d) return;
        delete this.state.positions[p.mint];
        // NOTE: closed/sum_ret are incremented only when the exit actually
        // completes (sell lands or paper mode) — a retried sell defers them
        // to retryPendingSells to avoid double counting.

        const evt: TradeEvent = {
            event: 'exit',
            mint: p.mint,
            pool: p.pool,
            // The exit carries the batch of its ENTRY — a position opened in
            // one batch never exits into another (the restart-seam fix).
            batch: p.entry_batch ?? this.ecfg.batch.batch,
            reason: d.reason,
            entry_modeled: d.entryModeled,
            exit_price: d.exitPrice,
            peak_price: d.peakPrice,
            return: d.ret,
            held_s: d.heldS,
            peak_multiple: d.peakMultiple,
        };
        // Invalid trades (stale triggers etc.) are excluded from verdict stats
        // but still logged — the wallet P&L is real even when the signal wasn't.
        if (p.invalid_reason) {
            evt.invalid = true;
            evt.invalid_reason = p.invalid_reason;
        }

        if (this.ecfg.live && this.liveFillCount > 0) {
            // Keep the position and retry when a sell does not land.
            try {
                const rawBal = await this.broker.getTokenBalance(p.mint);
                if (rawBal && rawBal > 0) {
                    const slippageBps = Number(process.env.LIVE_SLIPPAGE_BPS || 1000);
                    const sig = await this.broker.sell(p.mint, String(rawBal), slippageBps, 0);
                    if (!sig) {
                        // SELL RETRY: keep the position, retry next cycle
                        p.sell_pending = {
                            reason: d.reason, ret: d.ret, held_s: d.heldS,
                            exit_price: d.exitPrice, attempts: 1,
                        };
                        this.state.positions[p.mint] = p;
                        this.console(`exit ${p.mint.slice(0, 8)} sell did NOT land — will retry (attempt 1)`);
                        return;
                    }
                    evt.live = 'filled';
                    evt.live_sig = sig;
                    // Live PnL comes from wallet balances, not polled prices.
                    const balAfter = await this.broker.getWalletBalance();
                    const balBefore = (p as any).bal_at_buy;
                    if (typeof balBefore === 'number') {
                        evt.real_pnl_sol = Math.round((balAfter - balBefore) * 1e6) / 1e6;
                    }
                }
            } catch (e: any) {
                p.sell_pending = {
                    reason: d.reason, ret: d.ret, held_s: d.heldS,
                    exit_price: d.exitPrice, attempts: 1,
                };
                this.state.positions[p.mint] = p;
                this.console(`exit ${p.mint.slice(0, 8)} sell error (${e.message}) — will retry`);
                return;
            }
        }
        // Exit completed (sell landed or paper mode) — count it now
        this.state.closed += 1;
        this.state.sum_ret += d.ret;
        if (d.ret > 0) this.state.wins += 1;
        this.logEvt(evt);
        this.console(`exit ${p.mint.slice(0, 8)} reason=${d.reason} ret=${(100 * d.ret).toFixed(1)}%`);
    }

    private async retryPendingSells(now: number): Promise<void> {
        for (const p of Object.values(this.state.positions)) {
            const pend = (p as any).sell_pending;
            if (!pend || this.ecfg.live === false) continue;
            pend.attempts = (pend.attempts || 0) + 1;
            try {
                const rawBal = await this.broker.getTokenBalance(p.mint);
                if (!rawBal || rawBal <= 0) {
                    // tokens gone (sold manually or transferred) — close cleanly
                    delete (p as any).sell_pending;
                    delete this.state.positions[p.mint];
                    this.state.closed += 1;
                    this.state.sum_ret += pend.ret || 0;
                    if ((pend.ret || 0) > 0) this.state.wins += 1;
                    this.logEvt({
                        event: 'exit', batch: p.entry_batch ?? this.ecfg.batch.batch,
                        mint: p.mint, pool: p.pool, reason: pend.reason,
                        entry_modeled: p.entry, exit_price: pend.exit_price,
                        peak_price: p.peak, return: pend.ret, held_s: pend.held_s,
                        peak_multiple: p.peak / p.entry, live: 'closed-external',
                    });
                    continue;
                }
                const slippageBps = Number(process.env.LIVE_SLIPPAGE_BPS || 1000);
                const sig = await this.broker.sell(p.mint, String(rawBal), slippageBps, 0);
                if (sig) {
                    delete (p as any).sell_pending;
                    delete this.state.positions[p.mint];
                    this.state.closed += 1;
                    this.state.sum_ret += pend.ret || 0;
                    if ((pend.ret || 0) > 0) this.state.wins += 1;
                    this.logEvt({
                        event: 'exit', batch: p.entry_batch ?? this.ecfg.batch.batch,
                        mint: p.mint, pool: p.pool, reason: pend.reason,
                        entry_modeled: p.entry, exit_price: pend.exit_price,
                        peak_price: p.peak, return: pend.ret, held_s: pend.held_s,
                        peak_multiple: p.peak / p.entry,
                        live: 'filled', live_sig: sig, sell_retries: pend.attempts,
                    });
                    this.console(`exit ${p.mint.slice(0, 8)} sell LANDED on retry ${pend.attempts}`);
                    continue;
                }
                if (pend.attempts >= 20) {
                    delete (p as any).sell_pending;
                    delete this.state.positions[p.mint];
                    this.state.closed += 1;
                    this.logEvt({
                        event: 'exit', batch: p.entry_batch ?? this.ecfg.batch.batch,
                        mint: p.mint, pool: p.pool, reason: pend.reason,
                        entry_modeled: p.entry, exit_price: pend.exit_price,
                        peak_price: p.peak, return: pend.ret, held_s: pend.held_s,
                        peak_multiple: p.peak / p.entry, live: 'sell-abandoned',
                    });
                    this.console(`exit ${p.mint.slice(0, 8)} sell ABANDONED after 20 attempts — manual intervention needed`);
                } else {
                    this.console(`exit ${p.mint.slice(0, 8)} sell retry ${pend.attempts} failed — will retry`);
                }
            } catch (e: any) {
                this.console(`sell retry error for ${p.mint.slice(0, 8)}: ${e.message}`);
            }
        }
    }

    async cycle(): Promise<void> {
        const now = Date.now() / 1000;
        for (const e of this.tailer.readNewPoolEvents()) this.applyGate(e);

        const pools: Record<string, 'watch' | 'pos'> = {};
        for (const w of Object.values(this.state.watchlist)) pools[w.pool] = 'watch';
        for (const p of Object.values(this.state.positions)) pools[p.pool] = 'pos';
        // Prefer reserve-backed prices for open positions. A dead pool
        // produces no samples and eventually follows the stale-exit path.
        if ((process.env.EXIT_SAMPLER || 'pool') === 'pool'
            && typeof this.broker.poolPrice === 'function') {
            for (const p of Object.values(this.state.positions)) {
                const pp = await this.broker.poolPrice(p.mint);
                if (pp !== null && pp > 0) p.samples.push([now, pp]);
            }
            const watchPools = Object.values(this.state.watchlist).map((w) => w.pool);
            if (watchPools.length) {
                try {
                    const prices = await pollMultiPool(watchPools);
                    for (const [addr, price] of prices) {
                        for (const w of Object.values(this.state.watchlist)) {
                            if (w.pool === addr && acceptSample(w.samples, price)) {
                                w.samples.push([now, price]);
                            }
                        }
                    }
                } catch (e: any) {
                    this.console(`price poll failed: ${e.message}`);
                }
            }
        } else if (Object.keys(pools).length) {
            try {
                const prices = await pollMultiPool(Object.keys(pools));
                for (const [addr, price] of prices) {
                    const kind = pools[addr];
                    if (kind === 'watch') {
                        for (const w of Object.values(this.state.watchlist)) {
                            if (w.pool === addr && acceptSample(w.samples, price)) {
                                w.samples.push([now, price]);
                            }
                        }
                    } else {
                        for (const p of Object.values(this.state.positions)) {
                            if (p.pool === addr && acceptSample(p.samples, price)) {
                                p.samples.push([now, price]);
                            }
                        }
                    }
                }
            } catch (e: any) {
                this.console(`price poll failed: ${e.message}`);
            }
        }

        for (const w of Object.values({ ...this.state.watchlist })) {
            await this.onTrigger(w, now);
        }
        for (const p of Object.values({ ...this.state.positions })) {
            await this.onExit(p, now);
        }
        await this.retryPendingSells(now);
        for (const mint of evictWatchlist(this.ecfg.cfg, now, this.state)) {
            this.logEvt({ event: 'expired', mint, reason: 'evicted' });
        }
        trimSamples(this.state, now - 7200);
        this.saveState();
    }

    statsLine(): string {
        const c = this.state.closed;
        const mean = c ? (100 * this.state.sum_ret) / c : 0;
        return `watch=${Object.keys(this.state.watchlist).length} ` +
            `open=${Object.keys(this.state.positions).length} ` +
            `entries=${this.state.entries} closed=${c} ` +
            (c ? `mean_ret=${mean >= 0 ? '+' : ''}${mean.toFixed(1)}%` : '');
    }

    async run(durationS: number): Promise<void> {
        this.logEvt({
            event: 'batch_started',
            batch: this.ecfg.batch.batch,
            config_hash: this.ecfg.batch.config_hash,
        });
        this.console(`executor starting [batch=${this.ecfg.batch.batch} hash=${this.ecfg.batch.config_hash}] ` +
            `${this.ecfg.live ? '*** LIVE MODE ***' : `paper mode (${this.ecfg.liveReasonIfOff})`}`);
        const t0 = Date.now();
        let lastPoll = 0;
        // Graceful stop on Ctrl+C; state is resumable.
        let running = true;
        process.on('SIGINT', () => { running = false; });
        process.on('SIGTERM', () => { running = false; });
        while (running) {
            const now = Date.now() / 1000;
            if (now >= lastPoll + this.ecfg.cfg.poll_s) {
                await this.cycle();
                lastPoll = now;
                this.console(this.statsLine());
            }
            if (durationS && (Date.now() - t0) / 1000 >= durationS) {
                this.console(`duration reached, stopping. closed=${this.state.closed}`);
                break;
            }
            await new Promise((r) => setTimeout(r, 2000));
        }
        this.saveState();
    }
}
