// Paper-only curve executor. Use --ticks N for a short run or --test-entry
// for one simulated round trip. LIVE=true is always refused.
import * as dotenv from 'dotenv';
dotenv.config();

import { PublicKey } from '@solana/web3.js';
import { CurveFeed, loadCurveGateCfg } from './curve_feed';
import { CurveExecutor } from './curve_executor';
import { CurveSnapshot } from './curve_types';
import { CurveBroker } from '../executor/curve_broker';

const POLL_S = Number(process.env.CURVE_POLL_S || 30);

function argTicks(): number | null {
    const i = process.argv.indexOf('--ticks');
    if (i >= 0 && process.argv[i + 1]) return Math.max(1, Number(process.argv[i + 1]) || 1);
    return null;
}

(async () => {
    if (String(process.env.LIVE || '').toLowerCase() === 'true') {
        console.error('The curve executor is paper-only. Set LIVE=false.');
        process.exit(1);
    }

    const rpc = process.env.HELIUS_RPC_URL;
    const walletPk = process.env.WALLET_PUBKEY;
    if (!rpc) throw new Error('Set HELIUS_RPC_URL in .env');
    if (!walletPk) throw new Error('Set WALLET_PUBKEY in .env for swap simulation');
    new PublicKey(walletPk);

    const feed = new CurveFeed(rpc);
    const broker = new CurveBroker(false, null, rpc);
    const exec = new CurveExecutor(feed, broker);
    const cfg = loadCurveGateCfg();
    const ticks = argTicks();
    console.log(`curve paper executor: poll=${POLL_S}s ticks=${ticks ?? 'inf'}`);

    if (process.argv.includes('--test-entry')) {
        const nowUs = Date.now() * 1000;
        const state = feed.loadState();
        const candidates = feed.tailNewMints(cfg.max_age_s, nowUs);
        const candByMint = new Map(candidates.map(c => [c.mint, c] as const));
        const mints = [...new Set([...Object.keys(state.watchlist), ...candidates.map(c => c.mint)])];
        const snaps = feed.hasRpc ? await feed.snapshotCurves(mints, nowUs) : [];
        for (const s of snaps) {
            if (!state.watchlist[s.mint] && candByMint.has(s.mint)) s.t_listed_us = candByMint.get(s.mint)!.ts;
        }
        const evts = feed.updateWatchlist(state, snaps, cfg, nowUs);
        feed.logEvents(evts);
        feed.saveState(state);
        const keys = Object.keys(state.watchlist);
        if (!keys.length) { console.log('no gated mints to test on — rerun later'); process.exit(0); }
        keys.sort((a, b) => state.watchlist[b].t_listed - state.watchlist[a].t_listed);
        const mint = keys[0];
        console.log('test round trip on', mint.slice(0, 10), `(${keys.length} gated candidates)`);
        const res = await exec.testRoundTrip(mint, walletPk);
        console.log(JSON.stringify(res, null, 1));
        process.exit(0);
    }

    let done = 0;
    for (;;) {
        const nowUs = Date.now() * 1000;
        const state = feed.loadState();
        const candidates = feed.tailNewMints(cfg.max_age_s, nowUs);
        const candByMint = new Map(candidates.map(c => [c.mint, c] as const));
        const mints = [...new Set([...Object.keys(state.watchlist), ...candidates.map(c => c.mint)])];
        const snaps = feed.hasRpc ? await feed.snapshotCurves(mints, nowUs) : [];
        const snapsByMint = new Map<string, CurveSnapshot>(snaps.map(s => [s.mint, s] as const));
        for (const s of snaps) {
            if (!state.watchlist[s.mint] && candByMint.has(s.mint)) {
                s.t_listed_us = candByMint.get(s.mint)!.ts;
            }
        }
        const evts = feed.updateWatchlist(state, snaps, cfg, nowUs);
        feed.logEvents(evts);
        await exec.processTick(state, evts, snapsByMint, walletPk, nowUs);
        feed.saveState(state);

        const watchN = Object.keys(state.watchlist).length;
        const gateEvts = evts.filter(e => e.kind === 'gated' || e.kind === 'graduated').length;
        console.log(`tick ${done}: watch=${watchN} snaps=${snaps.length} feedEvts=${evts.length} gate/grad=${gateEvts} cand=${candidates.length}`);
        done++;
        if (ticks !== null && done >= ticks) { console.log('short test complete — exiting'); process.exit(0); }
        await new Promise(r => setTimeout(r, POLL_S * 1000));
    }
})().catch(e => { console.error(e); process.exit(1); });
