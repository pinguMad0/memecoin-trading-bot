// Reads pump.fun curve accounts and new-pool events, maintains a gated
// watchlist, and detects momentum. Only curve-specific state is written.
import * as dotenv from 'dotenv';
dotenv.config();

import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import {
    CurveFeedEvent,
    CurveFeedState,
    CurveGateCfg,
    CurveSnapshot,
    CurveWatchItem,
    NewMint,
} from './curve_types';

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const CURVE_DISC = '17b7f83760d8ac60';
const GRADUATION_LAMPORTS = 85_005_000_000; // 85.005 SOL raised at graduation (verified)
const K_STD = 3.219e25;                     // vTok*vSol invariant on standard curves
const SUPPLY_STD = 1e15;                    // 1e9 ui tokens @ 6 decimals
const RPC_BATCH = 50;
const RPC_PAUSE_MS = 300;
const SOL_USD_TTL_MS = 300_000;             // 5-min CoinGecko cache
const TAIL_CHUNK = 4_000_000;
const TAIL_MAX_SCAN = 64_000_000;

const ROOT = path.resolve(__dirname, '..', '..');
const EVENTS_PATH = path.join(ROOT, 'data', 'signals', 'events_v2.jsonl');
export const CURVE_STATE_PATH = path.join(ROOT, 'data', 'signals', 'curve_state.json');
export const CURVE_FEED_LOG_PATH = path.join(ROOT, 'data', 'signals', 'curve_feed.jsonl');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function curvePda(mint: string): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
        PUMP_PROGRAM,
    )[0];
}

// Curve account: disc @0, u64s vTok@8 vSol@16 rTok@24 rSol@32 supply@40,
// complete u8 @48 (len 166 current program). Std-params gate per
// CURVE_THEORY.md: the 85-SOL graduation math only holds when
// supply==1e15 and K is within 5% of the standard cluster.
function decodeCurveAccount(data: Buffer): {
    vTok: number; vSol: number; rTok: number; rSol: number;
    supply: number; complete: boolean; std_params: boolean;
} | null {
    if (data.length < 49) return null;
    if (data.subarray(0, 8).toString('hex') !== CURVE_DISC) return null;
    const vTok = Number(data.readBigUInt64LE(8));
    const vSol = Number(data.readBigUInt64LE(16));
    const rTok = Number(data.readBigUInt64LE(24));
    const rSol = Number(data.readBigUInt64LE(32));
    const supply = Number(data.readBigUInt64LE(40));
    const complete = data[48] !== 0;
    const k = vTok * vSol;
    const std_params = supply === SUPPLY_STD && Math.abs(k - K_STD) / K_STD <= 0.05;
    return { vTok, vSol, rTok, rSol, supply, complete, std_params };
}

export function loadCurveGateCfg(): CurveGateCfg {
    const env = (name: string, dflt: number): number => {
        const raw = process.env[name];
        if (raw === undefined || raw === '') return dflt;
        const v = Number(raw);
        return Number.isFinite(v) ? v : dflt;
    };
    return {
        min_age_s: env('CURVE_MIN_AGE_S', 90),
        max_age_s: env('CURVE_MAX_AGE_S', 1800),
        min_progress_pct: env('CURVE_MIN_PROGRESS_PCT', 2),
        max_progress_pct: env('CURVE_MAX_PROGRESS_PCT', 92),
        min_mc_usd: env('CURVE_MIN_MC_USD', 3500),
        max_mc_usd: env('CURVE_MAX_MC_USD', 16000),
        watch_cap: env('CURVE_WATCH_CAP', 40),
        mom_pct: env('CURVE_MOM_PCT', 0.15),
        mom_lookback_s: env('CURVE_MOM_LOOKBACK_S', 300),
    };
}

export function passesCurveGate(snap: CurveSnapshot, cfg: CurveGateCfg): boolean {
    if (snap.complete) return false;
    if (snap.std_params !== true) return false;
    if (snap.t_listed_us === undefined) return false; // unknown age — fail closed
    const ageS = (snap.ts - snap.t_listed_us) / 1e6;
    if (ageS < cfg.min_age_s || ageS > cfg.max_age_s) return false;
    if (snap.progress_pct < cfg.min_progress_pct || snap.progress_pct > cfg.max_progress_pct) return false;
    if (snap.mc_usd < cfg.min_mc_usd || snap.mc_usd > cfg.max_mc_usd) return false;
    return true;
}

export class CurveFeed {
    private conn: Connection | null = null;
    private solUsdCache: { usd: number | null; at: number } = { usd: null, at: 0 };

    constructor(rpcUrl?: string) {
        const url = rpcUrl || process.env.HELIUS_RPC_URL || null;
        if (url) this.conn = new Connection(url, 'confirmed');
    }

    get hasRpc(): boolean {
        return this.conn !== null;
    }

    // SOL/USD via CoinGecko, cached 5 min, stale fallback (probe-pricing
    // pattern from the pAMM broker). Returns null when never fetched.
    async getSolUsd(): Promise<number | null> {
        const now = Date.now();
        if (this.solUsdCache.usd !== null && now - this.solUsdCache.at < SOL_USD_TTL_MS) {
            return this.solUsdCache.usd;
        }
        try {
            const r = await (await fetch(
                'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
            )).json();
            const usd = Number(r?.solana?.usd);
            if (usd > 0) {
                this.solUsdCache = { usd, at: now };
                return usd;
            }
        } catch { /* fall through to last-known */ }
        return this.solUsdCache.usd;
    }

    // Fresh pump.fun launches from the live events tail, READ-ONLY: walk
    // backward from end-of-file in bounded chunks until the chunk's oldest
    // event predates the cutoff, extract pool:new_pool events (launch pools,
    // curve-phase tokens in the 2026 landscape), dedupe by mint keeping the
    // newest sighting. Never moves anyone else's offset; never writes.
    tailNewMints(maxAgeS: number, nowUs: number = Date.now() * 1000): NewMint[] {
        if (!fs.existsSync(EVENTS_PATH)) return [];
        const cutoff = nowUs - maxAgeS * 1e6;
        const size = fs.statSync(EVENTS_PATH).size;
        const found: NewMint[] = [];
        let end = size;
        let scanned = 0;
        while (end > 0 && scanned < TAIL_MAX_SCAN) {
            const start = Math.max(0, end - TAIL_CHUNK);
            const fd = fs.openSync(EVENTS_PATH, 'r');
            const buf = Buffer.alloc(end - start);
            fs.readSync(fd, buf, 0, end - start, start);
            fs.closeSync(fd);
            const lines = buf.toString('utf8').split('\n');
            let oldestTs = Infinity;
            for (let i = start > 0 ? 1 : 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim()) continue;
                let e: any;
                try { e = JSON.parse(line); } catch { continue; }
                if (e.feed !== 'pool' || e.event !== 'new_pool' || !e.mint) continue;
                if (!e.dex || !String(e.dex).toLowerCase().includes('pump')) continue;
                const tsUs = e.ts ? Math.floor(Date.parse(e.ts) * 1000) : 0;
                if (!tsUs) continue;
                if (tsUs < oldestTs) oldestTs = tsUs;
                if (tsUs < cutoff) continue;
                const attrs = (e.payload || {}).attributes || {};
                const mcapRaw = attrs.market_cap_usd ?? attrs.fdv_usd ?? (e.payload || {}).market_cap_usd;
                const mcap = mcapRaw === null || mcapRaw === undefined ? NaN : Number(mcapRaw);
                const liq = Number(e.liq_usd);
                found.push({
                    mint: String(e.mint).split('solana_').pop() as string,
                    ts: tsUs,
                    mcap_usd: Number.isFinite(mcap) ? mcap : null,
                    liq_usd: Number.isFinite(liq) ? liq : null,
                });
            }
            scanned += end - start;
            if (oldestTs <= cutoff) break;
            end = start;
        }
        const byMint = new Map<string, NewMint>();
        for (const ev of found) {
            const prev = byMint.get(ev.mint);
            if (!prev || ev.ts > prev.ts) byMint.set(ev.mint, ev);
        }
        return [...byMint.values()].sort((a, b) => b.ts - a.ts);
    }

    // Curve snapshots via batched getMultipleAccountsInfo on the derived
    // curve PDA per mint. Batches of 50, 300ms pacing, 429 backoff. A failed
    // batch is skipped (fail-closed — no synthetic data). MC needs SOL/USD;
    // without it mc_usd reads 0 and the gate rejects everything.
    async snapshotCurves(mints: string[], nowUs: number = Date.now() * 1000): Promise<CurveSnapshot[]> {
        if (!this.conn || !mints.length) return [];
        const uniq = [...new Set(mints)];
        const keys = uniq.map((m) => curvePda(m));
        const solUsd = await this.getSolUsd();
        const out: CurveSnapshot[] = [];
        for (let i = 0; i < keys.length; i += RPC_BATCH) {
            const infos = await this.rpcBatch(keys.slice(i, i + RPC_BATCH));
            if (!infos) continue;
            infos.forEach((info: AccountInfo<Buffer> | null, j: number) => {
                if (!info) return;
                const st = decodeCurveAccount(Buffer.from(info.data));
                if (!st) return;
                const price = st.vTok > 0 ? (st.vSol / 1e9) / (st.vTok / 1e6) : 0;
                const mcUsd = solUsd ? price * (st.supply / 1e6) * solUsd : 0;
                out.push({
                    mint: uniq[i + j],
                    ts: nowUs,
                    price,
                    mc_usd: mcUsd,
                    progress_pct: (st.rSol / GRADUATION_LAMPORTS) * 100,
                    complete: st.complete,
                    t_listed_us: undefined,
                    vTok: st.vTok,
                    vSol: st.vSol,
                    rTok: st.rTok,
                    rSol: st.rSol,
                    std_params: st.std_params,
                });
            });
            if (i + RPC_BATCH < keys.length) await sleep(RPC_PAUSE_MS);
        }
        return out;
    }

    // Gate + evolve the watchlist over one poll's snapshots. Existing items
    // get every price sample appended UNFILTERED (a crash price is data, not
    // a glitch). New items enter only through the gate. Evictions: complete
    // -> 'graduated'; std_params=false, max age, or cap overflow -> 'evicted'
    // (cap overflow drops the OLDEST-listed items first). Returns the events
    // for the caller to log. `now` is ts_us.
    updateWatchlist(
        state: CurveFeedState,
        snapshots: CurveSnapshot[],
        cfg: CurveGateCfg,
        now: number,
    ): CurveFeedEvent[] {
        const events: CurveFeedEvent[] = [];
        const iso = new Date(now / 1000).toISOString();
        for (const snap of snapshots) {
            const ex = state.watchlist[snap.mint];
            if (ex) {
                ex.samples.push([snap.ts, snap.price]);
                ex.last_state_ts = snap.ts;
                ex.complete = snap.complete;
                if (snap.vTok !== undefined) ex.vTok = snap.vTok;
                if (snap.vSol !== undefined) ex.vSol = snap.vSol;
                if (snap.rTok !== undefined) ex.rTok = snap.rTok;
                if (snap.rSol !== undefined) ex.rSol = snap.rSol;
                if (snap.std_params !== undefined) ex.std_params = snap.std_params;
                continue;
            }
            if (!passesCurveGate(snap, cfg)) continue;
            state.watchlist[snap.mint] = {
                mint: snap.mint,
                t_listed: snap.t_listed_us!,
                samples: [[snap.ts, snap.price]],
                vTok: snap.vTok ?? 0,
                vSol: snap.vSol ?? 0,
                rTok: snap.rTok ?? 0,
                rSol: snap.rSol ?? 0,
                complete: snap.complete,
                last_state_ts: snap.ts,
                std_params: snap.std_params ?? false,
            };
            events.push({
                ts: iso, kind: 'gated', mint: snap.mint,
                price: snap.price, mc_usd: snap.mc_usd, progress_pct: snap.progress_pct,
            });
        }
        const lastOf = (w: CurveWatchItem): number | undefined =>
            w.samples.length ? w.samples[w.samples.length - 1][1] : undefined;
        const evictEvt = (kind: 'evicted' | 'graduated', w: CurveWatchItem, reason?: string): CurveFeedEvent => {
            const price = lastOf(w);
            const sol = this.solUsdCache.usd;
            const evt: CurveFeedEvent = {
                ts: iso, kind, mint: w.mint,
                price,
                progress_pct: (w.rSol / GRADUATION_LAMPORTS) * 100,
            };
            if (reason) evt.reason = reason;
            if (sol && price !== undefined && w.std_params) evt.mc_usd = price * 1e9 * sol;
            return evt;
        };
        for (const [mint, w] of Object.entries(state.watchlist)) {
            if (w.complete) {
                delete state.watchlist[mint];
                events.push(evictEvt('graduated', w));
            } else if (!w.std_params) {
                delete state.watchlist[mint];
                events.push(evictEvt('evicted', w, 'std_params'));
            } else if ((now - w.t_listed) / 1e6 > cfg.max_age_s) {
                delete state.watchlist[mint];
                events.push(evictEvt('evicted', w, 'age'));
            }
        }
        const keys = Object.keys(state.watchlist);
        if (keys.length > cfg.watch_cap) {
            keys.sort((a, b) => state.watchlist[a].t_listed - state.watchlist[b].t_listed);
            for (const mint of keys.slice(0, keys.length - cfg.watch_cap)) {
                const w = state.watchlist[mint];
                delete state.watchlist[mint];
                events.push(evictEvt('evicted', w, 'cap'));
            }
        }
        return events;
    }

    // Momentum trigger on curve-native prices: >=5 samples, reference = the
    // newest sample at least mom_lookback_s old (reference-age guard: a
    // reference older than 3x the lookback is a stale carry — never fire),
    // latest/ref - 1 >= mom_pct. Same semantics as the executor's
    // checkTrigger, on ts_us curve samples. Null = no fire.
    checkCurveTrigger(
        samples: [number, number][],
        cfg: CurveGateCfg,
        now: number,
    ): { trigger_price: number; ref_price: number; mom: number } | null {
        const s = samples;
        if (s.length < 5) return null;
        let ref: number | null = null;
        for (let i = s.length - 1; i >= 0; i--) {
            const ageS = (now - s[i][0]) / 1e6;
            if (ageS >= cfg.mom_lookback_s) {
                if (ageS > 3 * cfg.mom_lookback_s) break;
                ref = s[i][1];
                break;
            }
        }
        if (ref === null || !(ref > 0)) return null;
        const latest = s[s.length - 1][1];
        const mom = latest / ref - 1;
        if (mom >= cfg.mom_pct) return { trigger_price: latest, ref_price: ref, mom };
        return null;
    }

    // State persistence: the curve venue's OWN file (never executor_state.json
    // or recorder state — two whole-file rewriters corrupt each other).
    // If curve_state.json exists, resume from it.
    loadState(): CurveFeedState {
        try {
            const saved = JSON.parse(fs.readFileSync(CURVE_STATE_PATH, 'utf8'));
            if (saved && typeof saved.watchlist === 'object') return saved as CurveFeedState;
        } catch { /* fresh start */ }
        return { watchlist: {}, saved_at: new Date().toISOString() };
    }

    saveState(state: CurveFeedState): void {
        state.saved_at = new Date().toISOString();
        fs.writeFileSync(CURVE_STATE_PATH, JSON.stringify(state));
    }

    // Append-only event log (the curve venue's own JSONL; per-line append,
    // same pattern as the executor's paper log).
    logEvents(evts: CurveFeedEvent[]): void {
        for (const e of evts) fs.appendFileSync(CURVE_FEED_LOG_PATH, JSON.stringify(e) + '\n');
    }

    private async rpcBatch(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[] | null> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.conn!.getMultipleAccountsInfo(keys);
            } catch (e: any) {
                const msg = String(e?.message || '');
                if (/429|too many/i.test(msg) && attempt < 2) {
                    await sleep(2500 * (attempt + 1));
                    continue;
                }
                return null;
            }
        }
    }
}
