// Paper-only curve executor. Entries require a trigger, rug-audit pass,
// matching Jupiter and curve quotes, and a successful swap simulation.
// Positions and exits are logged locally; nothing is signed or submitted.
import * as dotenv from 'dotenv';
dotenv.config();

import { PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

import { CurveFeed, loadCurveGateCfg } from './curve_feed';
import { CurveFeedEvent, CurveFeedState, CurveWatchItem, CurveSnapshot } from './curve_types';
import { rugAudit } from '../executor/rug_audit';
import { CurveBroker } from '../executor/curve_broker';

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const SOL = 'So11111111111111111111111111111111111111112';
const JUP = process.env.CURVE_JUP_API || 'https://lite-api.jup.ag/swap/v1';

const ROOT = path.resolve(__dirname, '..', '..');
export const CURVE_PAPER_LOG = path.join(ROOT, 'data', 'signals', 'curve_paper.jsonl');
export const CURVE_POSITIONS_PATH = path.join(ROOT, 'data', 'signals', 'curve_positions.json');

const JUP_PACE_MS = 1200;

export interface CurvePosition {
    mint: string;
    t_entry_us: number;
    size_sol: number;
    tokens_raw: string;          // remaining unsold (raw 6-dec)
    entry_eff_price: number;     // size_sol*1e9 / out (SOL per raw token)
    peak_price: number;
    moonbag_done: boolean;
    sol_realized: number;        // from sells so far
    status: 'open' | 'closed';
    exit_reason?: string;
    pnl_sol?: number;
    closed_at?: string;
    shadow?: boolean;           // audit-failed calibration cohort (never a real entry)
    shadow_reasons?: string[];
}

interface PositionsFile {
    positions: Record<string, CurvePosition>;
    closed: CurvePosition[];
    saved_at: string;
}

function envNum(name: string, dflt: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return dflt;
    const v = Number(raw);
    return Number.isFinite(v) ? v : dflt;
}

export class CurveExecutor {
    private feed: CurveFeed;
    private broker: CurveBroker;
    private cfg = loadCurveGateCfg();
    private sizeSol = envNum('CURVE_EXEC_SIZE_SOL', 0.01);
    private maxPositions = envNum('CURVE_MAX_POSITIONS', 3);
    private devMaxPct = envNum('CURVE_QUOTE_DEVIATION_MAX_PCT', 3);
    private slippageBps = envNum('CURVE_SLIPPAGE_BPS', 500);
    private momCap = envNum('CURVE_MOM_CAP_PCT', 150) / 100;
    private moonbagX = envNum('CURVE_MOONBAG_X', 2.0);
    private trailDrop = envNum('CURVE_TRAIL_DROP_PCT', 40) / 100;
    private posMaxAgeS = envNum('CURVE_POSITION_MAX_S', 3600);
    private lastJupCall = 0;

    constructor(feed: CurveFeed, broker: CurveBroker) {
        this.feed = feed;
        this.broker = broker;
    }

    private log(kind: string, fields: Record<string, unknown>): void {
        fs.appendFileSync(CURVE_PAPER_LOG, JSON.stringify({
            ts: new Date().toISOString(), kind, ...fields,
        }) + '\n');
    }

    private async jupPace(): Promise<void> {
        const gap = Date.now() - this.lastJupCall;
        if (gap < JUP_PACE_MS) await new Promise(r => setTimeout(r, JUP_PACE_MS - gap));
        this.lastJupCall = Date.now();
    }

    async quoteBuyJup(mint: string, lamports: number): Promise<any | null> {
        await this.jupPace();
        try {
            const r = await fetch(
                `${JUP}/quote?inputMint=${SOL}&outputMint=${mint}&amount=${lamports}&slippageBps=${this.slippageBps}`,
                { headers: { Accept: 'application/json' } },
            );
            if (!r.ok) { this.log('curve_jup_http', { side: 'buy', status: r.status, mint }); return null; }
            return await r.json();
        } catch (e: any) { this.log('curve_jup_http', { side: 'buy', err: String(e?.message || e), mint }); return null; }
    }

    async quoteSellJup(mint: string, rawAmount: string | number): Promise<any | null> {
        await this.jupPace();
        try {
            const r = await fetch(
                `${JUP}/quote?inputMint=${mint}&outputMint=${SOL}&amount=${rawAmount}&slippageBps=${this.slippageBps}`,
                { headers: { Accept: 'application/json' } },
            );
            if (!r.ok) { this.log('curve_jup_http', { side: 'sell', status: r.status, mint }); return null; }
            return await r.json();
        } catch (e: any) { this.log('curve_jup_http', { side: 'sell', err: String(e?.message || e), mint }); return null; }
    }

    async buildSwap(quote: any, userPk: string): Promise<any | null> {
        await this.jupPace();
        try {
            const r = await fetch(`${JUP}/swap`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quoteResponse: quote, userPublicKey: userPk, wrapAndUnwrapSol: true }),
            });
            if (!r.ok) {
                const body = (await r.text()).slice(0, 160);
                this.log('curve_jup_build_fail', { status: r.status, body, mint: quote?.outMint || quote?.inputMint });
                return null;
            }
            return await r.json();
        } catch (e: any) { this.log('curve_jup_build_fail', { err: String(e?.message || e) }); return null; }
    }

    async simulate(b64Tx: string): Promise<{ err: any; logs: string[] } | null> {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const r = await fetch(process.env.HELIUS_RPC_URL!, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0', id: 1, method: 'simulateTransaction',
                        params: [b64Tx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }],
                    }),
                });
                if (r.status === 429) { await new Promise(x => setTimeout(x, 2500)); continue; }
                const j = await r.json();
                const res = j?.result && (j.result.value ?? j.result);
                if (!res) return null;
                return { err: res.err ?? null, logs: res.logs || [] };
            } catch { await new Promise(x => setTimeout(x, 1500)); }
        }
        return null;
    }

    loadPositions(): PositionsFile {
        try {
            const saved = JSON.parse(fs.readFileSync(CURVE_POSITIONS_PATH, 'utf8'));
            if (saved && typeof saved.positions === 'object') return saved as PositionsFile;
        } catch { /* fresh */ }
        return { positions: {}, closed: [], saved_at: new Date().toISOString() };
    }

    savePositions(pf: PositionsFile): void {
        pf.saved_at = new Date().toISOString();
        fs.writeFileSync(CURVE_POSITIONS_PATH, JSON.stringify(pf));
    }

    // One executor pass over the feed's current tick. `evts` are this tick's
    // feed events (already logged by the feed); `snapsByMint` carries the
    // fresh curve samples for exit pricing.
    async processTick(
        state: CurveFeedState,
        evts: CurveFeedEvent[],
        snapsByMint: Map<string, CurveSnapshot>,
        walletPk: string,
        nowUs: number,
    ): Promise<void> {
        const pf = this.loadPositions();

        // 1) graduation exits first (venue boundary: never hold post-grad)
        const graduated = new Set(evts.filter(e => e.kind === 'graduated').map(e => e.mint));
        for (const mint of Object.keys(pf.positions)) {
            if (graduated.has(mint)) await this.exitPosition(pf, mint, 'graduation', walletPk);
        }

        // 2) exit checks on open positions (price triggers + timeout)
        const openMints = Object.keys(pf.positions);
        for (const mint of openMints) {
            const pos = pf.positions[mint];
            if (!pos) continue;
            const snap = snapsByMint.get(mint);
            const price = snap ? snap.price : undefined;
            if (price !== undefined && price > 0) {
                if (price > pos.peak_price) pos.peak_price = price;
                // entry_eff_price is lamports per RAW token; the feed's curve
                // price is SOL per UI token -> scale by 1e9/1e6 = 1000 to put
                // them in the same unit (without this the 2x threshold is
                // unreachable by 1000x and no profit is ever taken).
                const priceRaw = price * 1000;
                if (!pos.moonbag_done && priceRaw >= pos.entry_eff_price * this.moonbagX) {
                    await this.moonbag(pf, pos, walletPk);
                }
                if (price <= pos.peak_price * (1 - this.trailDrop)) {
                    await this.exitPosition(pf, mint, 'trailing', walletPk);
                    continue;
                }
            }
            const ageS = (nowUs - pos.t_entry_us) / 1e6;
            if (ageS > this.posMaxAgeS) await this.exitPosition(pf, mint, 'timeout', walletPk);
        }

        // 3) entries from fresh momentum triggers (shadow positions never
        // consume entry slots)
        let openCount = Object.values(pf.positions).filter(p => p.status === 'open' && !p.shadow).length;
        for (const [mint, w] of Object.entries(state.watchlist)) {
            if (pf.positions[mint]) continue;
            const trig = this.feed.checkCurveTrigger(w.samples, this.cfg, nowUs);
            if (!trig) continue;
            if (openCount >= this.maxPositions) {
                this.log('curve_skip_max_positions', { mint, open: openCount });
                continue;
            }
            if (trig.mom >= this.momCap) {
                this.log('curve_trigger_blocked_vertical', { mint, mom: trig.mom });
                continue;
            }
            const opened = await this.tryEntry(mint, w, trig, walletPk, pf);
            if (opened) openCount++;
        }

        this.savePositions(pf);
    }

    private async tryEntry(
        mint: string,
        w: CurveWatchItem,
        trig: { trigger_price: number; ref_price: number; mom: number },
        walletPk: string,
        pf: PositionsFile,
    ): Promise<boolean> {
        // rug audit (fail-closed; venue-agnostic, curve PDA + ATA excluded)
        const curve = PublicKey.findProgramAddressSync(
            [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP_PROGRAM)[0].toBase58();
        const audit = await rugAudit(mint, curve);
        if (!audit.pass) {
            this.log('curve_entry_audit_fail', { mint, reasons: audit.reasons, mom: trig.mom });
            await this.bookShadow(mint, trig, audit.reasons, walletPk, pf);
            return false;
        }

        // Jupiter quote + CP cross-check (independent anchor)
        const lamports = Math.floor(this.sizeSol * 1e9);
        const q = await this.quoteBuyJup(mint, lamports);
        if (!q) { this.log('curve_entry_no_quote', { mint, mom: trig.mom }); return false; }
        const jupOut = BigInt(q.outAmount);
        const cp = await this.broker.quoteBuy(mint, this.sizeSol);
        if (!cp) { this.log('curve_entry_no_quote', { mint, reason: 'cp-anchor unavailable', mom: trig.mom }); return false; }
        const devBps = Number(10000n * (jupOut - cp.outRaw) / cp.outRaw);
        const dev = devBps / 100;
        if (Math.abs(dev) > this.devMaxPct) {
            this.log('curve_entry_price_dev', { mint, dev_pct: dev, jup_out: q.outAmount, cp_out: cp.outRaw.toString() });
            return false;
        }

        // build the real swap for our wallet and SIMULATE (paper never signs)
        const built = await this.buildSwap(q, walletPk);
        if (!built) { this.log('curve_entry_build_fail', { mint }); return false; }
        const sim = await this.simulate(built.swapTransaction);
        if (!sim) { this.log('curve_entry_sim_fail', { mint, reason: 'sim unavailable' }); return false; }
        if (sim.err !== null) {
            this.log('curve_entry_sim_fail', { mint, err: JSON.stringify(sim.err) });
            return false;
        }

        // book at the executable quote (honest entry price)
        const pos: CurvePosition = {
            mint,
            t_entry_us: Date.now() * 1000,
            size_sol: this.sizeSol,
            tokens_raw: q.outAmount,
            entry_eff_price: lamports / Number(jupOut),
            peak_price: trig.trigger_price,
            moonbag_done: false,
            sol_realized: 0,
            status: 'open',
        };
        pf.positions[mint] = pos;
        this.log('curve_entry_booked', {
            mint, size_sol: this.sizeSol, out_raw: q.outAmount, dev_pct: dev,
            trigger_price: trig.trigger_price, mom: trig.mom,
            progress_pct: (w.rSol / 85_005_000_000) * 100,
            audit_top10_pct: audit.top10_pct, audit_cluster: audit.uniform_cluster,
        });
        return true;
    }

    // Calibration cohort: when the rug audit rejects a momentum trigger,
    // book a SHADOW position anyway (tagged, never a real entry, does not
    // consume entry slots). Exits run through the same executable-quote
    // machinery, so the gate-vs-outcome join has data on both sides. The
    // entry price is the honest executable quote (same dev band); a missing
    // or out-of-band quote skips the shadow - the trigger will re-fire.
    private async bookShadow(
        mint: string,
        trig: { trigger_price: number; ref_price: number; mom: number },
        reasons: string[],
        walletPk: string,
        pf: PositionsFile,
    ): Promise<void> {
        const lamports = Math.floor(this.sizeSol * 1e9);
        const q = await this.quoteBuyJup(mint, lamports);
        if (!q) { this.log('curve_shadow_skip', { mint, reason: 'no quote' }); return; }
        const jupOut = BigInt(q.outAmount);
        const cp = await this.broker.quoteBuy(mint, this.sizeSol);
        if (!cp) { this.log('curve_shadow_skip', { mint, reason: 'cp anchor unavailable' }); return; }
        const devBps = Number(10000n * (jupOut - cp.outRaw) / cp.outRaw);
        const dev = devBps / 100;
        if (Math.abs(dev) > this.devMaxPct) { this.log('curve_shadow_skip', { mint, reason: 'price dev', dev_pct: dev }); return; }
        const pos: CurvePosition = {
            mint,
            t_entry_us: Date.now() * 1000,
            size_sol: this.sizeSol,
            tokens_raw: q.outAmount,
            entry_eff_price: lamports / Number(jupOut),
            peak_price: trig.trigger_price,
            moonbag_done: false,
            sol_realized: 0,
            status: 'open',
            shadow: true,
            shadow_reasons: reasons,
        };
        pf.positions[mint] = pos;
        this.log('curve_shadow_booked', { mint, out_raw: q.outAmount, dev_pct: dev, mom: trig.mom, reasons });
    }

    // TEST-ONLY (paper, no signing/submission): force one full round trip on
    // an already-gated watchlist mint — entry pipeline, then immediate exit —
    // to prove the machinery without waiting for a natural momentum trigger.
    async testRoundTrip(mint: string, walletPk: string): Promise<Record<string, unknown> | null> {
        const pf = this.loadPositions();
        if (pf.positions[mint]) { this.log('curve_test_skip', { mint, reason: 'already open' }); return null; }
        const trig = { trigger_price: 0, ref_price: 0, mom: 0.16 };
        const opened = await this.tryEntry(mint, { mint, t_listed: 0, samples: [], vTok: 0, vSol: 0, rTok: 0, rSol: 0, complete: false, last_state_ts: 0, std_params: true } as any, trig, walletPk, pf);
        this.savePositions(pf);
        if (!opened) return { entry: 'aborted', lastError: this.broker.lastError };
        const pf2 = this.loadPositions();
        await this.exitPosition(pf2, mint, 'test', walletPk);
        this.savePositions(pf2);
        const closed = pf2.closed[pf2.closed.length - 1];
        return { entry: 'booked', exit: closed };
    }

    // Sell `rawAmount` tokens via Jupiter, return realized SOL (booked from
    // the executable quote). Build failure = 0 (mirrors a live failed build).
    private async sellRaw(mint: string, rawAmount: string | number, walletPk: string): Promise<number> {
        const q = await this.quoteSellJup(mint, rawAmount);
        if (!q) return 0;
        const built = await this.buildSwap(q, walletPk);
        if (!built) return 0;
        return Number(q.outAmount) / 1e9;
    }

    private async moonbag(pf: PositionsFile, pos: CurvePosition, walletPk: string): Promise<void> {
        const half = BigInt(pos.tokens_raw) / 2n;
        if (half <= 0n) return;
        const sol = await this.sellRaw(pos.mint, half.toString(), walletPk);
        if (sol <= 0) { this.log('curve_exit_moonbag_fail', { mint: pos.mint, raw: half.toString() }); return; }
        pos.tokens_raw = (BigInt(pos.tokens_raw) - half).toString();
        pos.sol_realized += sol;
        pos.moonbag_done = true;
        this.log('curve_exit_moonbag', { mint: pos.mint, raw_sold: half.toString(), sol_out: sol });
    }

    private async exitPosition(pf: PositionsFile, mint: string, reason: string, walletPk: string): Promise<void> {
        const pos = pf.positions[mint];
        if (!pos || pos.status === 'closed') return;
        let sol = 0;
        if (BigInt(pos.tokens_raw) > 0n) sol = await this.sellRaw(mint, pos.tokens_raw, walletPk);
        pos.sol_realized += sol;
        pos.status = 'closed';
        pos.exit_reason = reason;
        pos.pnl_sol = pos.sol_realized - pos.size_sol;
        pos.closed_at = new Date().toISOString();
        pos.tokens_raw = '0';
        delete pf.positions[mint];
        pf.closed.push(pos);
        if (pf.closed.length > 500) pf.closed.splice(0, pf.closed.length - 500);
        this.log('curve_exit_booked', {
            mint, reason, sol_out: sol, pnl_sol: pos.pnl_sol,
            size_sol: pos.size_sol, moonbag_done: pos.moonbag_done,
        });
    }
}
